"""Per-provider request and token budgets for LLM calls (#489).

Why this exists
---------------
Groq's free tier allows 30 requests per minute and roughly 200K tokens per day,
and those limits are **per organization** — not per key, not per user, not per
IP. The app's own limiter allowed 100 req/min per client IP, so a user well
inside the app's limit could still be rejected by the provider. That rejection
reached the client as an HTTP **200** whose body said "Could not generate an
answer with the AI provider. Please try again." — the same string a dead
provider produced, so a quota problem was indistinguishable from a
misconfiguration.

Two ceilings, because for one person the daily one binds long before the
per-minute one
------------------------------------------------------------------------
At ``QA_MAX_TOKENS``=1000 a 200K-token allowance is ~50 questions per day,
while 30/min is never reached by anyone typing. Enforcing only requests per
minute would therefore enforce the limit that does not bite and ignore the one
that does.

How admission works
-------------------
The per-minute ceiling is enforced by **atomic reservation**: ``INCR`` first,
and a caller whose increment lands past the limit hands the slot straight back
with ``DECR``. Reading the counter and then deciding would admit an entire
concurrent burst, since every caller in the burst reads the same "29 of 30".

The daily token ceiling is a **soft check plus hard accounting**: the real
``usage.total_tokens`` is not knowable until the call returns, so the budget is
checked before the call against ``used + QA_MAX_TOKENS`` and reconciled with
actual usage afterwards.

The pre-check reserves room for what the call could cost *at most*, and that
choice is a trade, not a free win:

- It **can refuse a question whose actual usage would have fitted** — a 5-token
  question is turned away when 1000 tokens of headroom are needed to admit it.
  An earlier draft of this file claimed the opposite, which was simply false.
- It **overshoots the daily ceiling** by at most (in-flight requests x
  max_tokens) when several calls are admitted together.

Over-refusing is the worse of the two here, so it is the one that is traded
away. The ceiling is the operator's real allowance, and a day that ends a little
over budget is recoverable while a user who is permanently refused is not. The
effect is confined to the last call or two before the cap: with a cap many
times ``QA_MAX_TOKENS`` (200K against 1000 by default) almost everything is
admitted, and because real usage is charged back after each call, the reserved
headroom shrinks as answers come in rather than staying pessimistic forever.

Scope, and why it is org-wide
-----------------------------
The budget is tracked per *provider*, org-wide, because that is the granularity
the provider actually enforces. A per-user budget would be fairer between users
but would not prevent the provider's own 429 — it would only spread it out
while still letting the ceiling be hit. The consequence is deliberate and
documented rather than hidden: **one user can exhaust the daily allowance for
everyone else.**

Bring-your-own-key requests are exempt (``account=False``). The caller supplies
a key whose quota is their own, so charging it to the operator's shared budget
would deny service for usage the operator does not pay for.

Failure policy
--------------
Fails **open**. If Redis is unreachable the counters are skipped and the call
proceeds, because a counter that cannot be read must not take question answering
offline — the app's own limiter already degrades the same way. The condition is
logged, so it is visible that the ceiling is currently unenforced rather than
silently absent.
"""

import logging
import os
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from app.cache.redis import redis_client

logger = logging.getLogger(__name__)

_KEY_PREFIX = "provider_quota"
_MINUTE_WINDOW_SECONDS = 60
# A minute key is written when a window opens and read only while that window is
# current, so one window of grace past the boundary is enough to never serve a
# stale count to a caller in the next window.
_MINUTE_TTL_SECONDS = _MINUTE_WINDOW_SECONDS * 2
# The day key is TTL'd past the UTC day boundary (plus an hour) so a write that
# lands just after midnight still lands on the *previous* day's key, which is
# then still addressable, rather than resurrecting yesterday's budget.
_DAY_TTL_SECONDS = 86_400 + 3_600


def _blank_safe_int(name: str, default: int) -> int:
    """Read an integer env var, tolerating blank and malformed values.

    Blank-safe for the same reason as every other read in this project: compose
    passes "" for an unset variable, and ``os.getenv(name, default)`` would
    return that blank rather than the default, so a "set but empty" value would
    silently become a limit of zero — refusing every question.
    """
    raw = (os.getenv(name, "") or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning(
            "%s=%r is not a whole number; using %d", name, raw, default
        )
        return default


@dataclass(frozen=True)
class ProviderLimits:
    """Ceilings for one provider. ``None`` means the provider is not capped.

    Capping a paid or self-hosted provider would be wrong rather than merely
    redundant: an OpenAI key has no such free-tier ceiling, and a local model
    runs on the operator's own hardware, so neither should be held to Groq's
    free-tier numbers.
    """

    requests_per_minute: int | None = None
    tokens_per_day: int | None = None

    @property
    def is_capped(self) -> bool:
        """Whether any ceiling is actually enforced.

        Tests for a *positive* limit, not merely a present one, so it agrees
        with ``reserve`` and ``check_token_budget``: both treat a ceiling of 0
        or less as "no ceiling", and a snapshot that claimed ``capped: true``
        with ``requests_per_minute: 0`` would tell an operator the deployment
        refuses every question when it in fact serves them all.
        """
        return any(
            limit is not None and limit > 0
            for limit in (self.requests_per_minute, self.tokens_per_day)
        )


# Only the free, org-capped provider is limited by default. Groq's published
# free-tier ceilings for the models in the registry: 30 requests/minute and
# 200K tokens/day for `openai/gpt-oss-120b`, the default free model.
#
# Named so the Compose/Kubernetes defaults can be compared against the
# application's own fallback instead of being restated in three places and
# drifting apart.
DEFAULT_RPM = 30
DEFAULT_TOKENS_PER_DAY = 200_000

PROVIDER_LIMITS: dict[str, ProviderLimits] = {
    "groq": ProviderLimits(
        requests_per_minute=_blank_safe_int("GROQ_REQUESTS_PER_MINUTE", DEFAULT_RPM),
        tokens_per_day=_blank_safe_int(
            "GROQ_TOKENS_PER_DAY", DEFAULT_TOKENS_PER_DAY
        ),
    ),
    # Paid and self-hosted: no local ceiling. Overridable for an operator who
    # has agreed a rate limit with their own provider.
    "openai": ProviderLimits(requests_per_minute=None, tokens_per_day=None),
    "local": ProviderLimits(requests_per_minute=None, tokens_per_day=None),
}

# Kill switch. Off means every provider is uncapped, without deleting the limits
# above, so the setting is recoverable and the default stays documented.
QUOTA_ENABLED = (os.getenv("PROVIDER_QUOTA_ENABLED", "") or "").strip().lower() not in {
    "0",
    "false",
    "no",
    "off",
}

# Why a request was refused, or the reasons it is acceptable. "minute" and
# "tokens" are the two ceilings; "" means nothing objected.
SCOPE_MINUTE = "minute"
SCOPE_TOKENS = "tokens"
# Where the 429 came from. These are different operator problems: "app" means we
# predicted this from our own counters, "provider" means the provider rejected a
# call we let through, which means the configured ceiling is wrong or traffic
# exceeds what the counters account for.
SOURCE_APP = "app"
SOURCE_PROVIDER = "provider"


class ProviderRateLimited(Exception):
    """A provider's ceiling stopped the call.

    Raised for both our own refusal and an upstream 429, because both are the
    same thing to a client — retry later — and both deserve a real status code
    instead of a 200 carrying a failure string. ``source`` distinguishes them
    for whoever is reading the logs.
    """

    def __init__(
        self,
        provider: str,
        scope: str = "",
        limit: int | None = None,
        used: int | None = None,
        retry_after: int = 60,
        source: str = SOURCE_APP,
        detail: str = "",
    ):
        self.provider = provider
        self.scope = scope
        self.limit = limit
        self.used = used
        self.retry_after = max(1, int(retry_after or 0) or 1)
        self.source = source
        self.detail = detail
        super().__init__(
            f"{provider} rate limit reached"
            + (f" ({scope}: {used}/{limit})" if limit is not None else "")
        )


@dataclass(frozen=True)
class QuotaDecision:
    """Whether a provider call may proceed."""

    allowed: bool
    scope: str = ""
    limit: int | None = None
    used: int | None = None
    retry_after: int = 0
    reason: str = ""


def limits_for(provider: str) -> ProviderLimits:
    """Ceilings for a provider, with the kill switch applied.

    An unknown provider is uncapped rather than refused: a new provider added to
    the registry before it is added here should work, not fail closed on a
    missing dictionary entry.
    """
    if not QUOTA_ENABLED:
        return ProviderLimits()
    return PROVIDER_LIMITS.get(provider, ProviderLimits())


def _minute_key(provider: str, now: float) -> str:
    # Window id derived from the clock, so every process shares one window
    # without coordinating — unlike a "TTL from first hit" scheme, where two
    # instances would each keep their own drifting window.
    window = int(now // _MINUTE_WINDOW_SECONDS)
    return f"{_KEY_PREFIX}:{provider}:minute:{window}"


def _day_key(provider: str, now: datetime) -> str:
    return f"{_KEY_PREFIX}:{provider}:day:{now.strftime('%Y-%m-%d')}"


def seconds_until_next_minute(now: float) -> int:
    """Whole seconds until the current minute window closes (1..60)."""
    return int(_MINUTE_WINDOW_SECONDS - (now % _MINUTE_WINDOW_SECONDS)) or (
        _MINUTE_WINDOW_SECONDS
    )


def _seconds_until_next_utc_day(now: datetime) -> int:
    tomorrow = (now + timedelta(days=1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return max(1, int((tomorrow - now).total_seconds()))


def reserve(provider: str, *, account: bool = True) -> QuotaDecision:
    """Atomically claim one request slot, or explain why none is available.

    ``account=False`` skips the budget entirely for a caller-supplied key.
    """
    limits = limits_for(provider)
    rpm = limits.requests_per_minute
    if not account or rpm is None or rpm <= 0:
        return QuotaDecision(allowed=True)

    now = time.time()
    key = _minute_key(provider, now)
    try:
        count = redis_client.increment(key)
        if count == 1:
            redis_client.expire(key, _MINUTE_TTL_SECONDS)
        if count > rpm:
            # Hand the slot back. Without this, every rejected request would
            # push the counter further past the ceiling and keep it there for
            # the rest of the window, so the budget would stay exhausted by
            # callers that were never served.
            redis_client.decrement(key)
            return QuotaDecision(
                allowed=False,
                scope=SCOPE_MINUTE,
                limit=rpm,
                used=rpm,
                retry_after=seconds_until_next_minute(now),
                reason=(
                    f"{provider} allows {rpm} requests/minute and the budget "
                    f"for this minute is spent"
                ),
            )
    except Exception as e:  # noqa: BLE001 - fail open, never take QA offline
        logger.warning(
            "Provider request budget unavailable for %s (%s); proceeding "
            "without a per-minute ceiling",
            provider,
            e,
        )
        return QuotaDecision(allowed=True)

    return QuotaDecision(allowed=True)


def check_token_budget(
    provider: str, *, expected_tokens: int = 0, account: bool = True
) -> QuotaDecision:
    """Refuse if the day's remaining tokens cannot cover the call's worst case.

    ``expected_tokens`` is what the call is about to cost at most
    (``QA_MAX_TOKENS``), not what it will actually cost — the real figure is
    unknown until the response arrives, and is charged by ``record_tokens``
    afterwards.

    So this deliberately trades the opposite way from the overshoot it causes: it
    refuses a question whose real cost *would* have fitted, in exchange for not
    blowing past the operator's allowance. See the module docstring for why that
    is the better of the two failures.
    """
    limits = limits_for(provider)
    cap = limits.tokens_per_day
    if not account or cap is None or cap <= 0:
        return QuotaDecision(allowed=True)

    now = datetime.now(UTC)
    try:
        used = int(redis_client.get(_day_key(provider, now)) or 0)
    except Exception as e:  # noqa: BLE001 - fail open
        logger.warning(
            "Provider token budget unavailable for %s (%s); proceeding without "
            "a daily token ceiling",
            provider,
            e,
        )
        return QuotaDecision(allowed=True)

    if used + max(0, expected_tokens) <= cap:
        return QuotaDecision(allowed=True)
    return QuotaDecision(
        allowed=False,
        scope=SCOPE_TOKENS,
        limit=cap,
        used=used,
        retry_after=_seconds_until_next_utc_day(now),
        reason=(
            f"{provider} allows {cap} tokens/day and {used} are already spent"
        ),
    )


def record_tokens(provider: str, tokens: int, *, account: bool = True) -> None:
    """Add the real token usage to the day's total.

    Called after the call, when ``usage.total_tokens`` is finally known. Best
    effort: a failure here under-counts the day's usage, which weakens the
    ceiling, so it is logged rather than raised.
    """
    limits = limits_for(provider)
    if not account or limits.tokens_per_day is None or tokens <= 0:
        return
    now = datetime.now(UTC)
    key = _day_key(provider, now)
    try:
        if redis_client.increment_by(key, int(tokens)) == int(tokens):
            # First write of the day: give the key a life. The TTL is set after
            # the increment, because setting it first and then failing to
            # increment would leave a zero-valued key holding a ceiling shut
            # for the rest of the day.
            redis_client.expire(key, _seconds_until_next_utc_day(now) + 3_600)
    except Exception as e:  # noqa: BLE001 - accounting must not fail a request
        logger.warning(
            "Could not record %d token(s) against the %s daily budget: %s",
            tokens,
            provider,
            e,
        )


def snapshot(provider: str) -> dict:
    """Current budget state, for ``/v1/qa/models`` so the ceiling is visible.

    An operator reading the API can then see the limits rather than having to
    infer them from a 429.
    """
    limits = limits_for(provider)
    if not limits.is_capped:
        return {"capped": False, "requests_per_minute": None, "tokens_per_day": None}
    out: dict = {
        "capped": True,
        "requests_per_minute": limits.requests_per_minute,
        "tokens_per_day": limits.tokens_per_day,
    }
    try:
        now = datetime.now(UTC)
        out["requests_remaining"] = max(
            0,
            (limits.requests_per_minute or 0)
            - int(redis_client.get(_minute_key(provider, time.time())) or 0),
        )
        out["tokens_used_today"] = int(
            redis_client.get(_day_key(provider, now)) or 0
        )
    except Exception as e:  # noqa: BLE001 - reporting must never fail the request
        # The caps are still reported; only the live counters are missing, so
        # the endpoint degrades to "here is the ceiling" rather than failing.
        logger.warning("Could not read the %s budget snapshot: %s", provider, e)
    return out
