"""Tests for the per-provider request and token budgets (#489).

Two ceilings are under test, and the asymmetry between them is the point:
the per-minute one is enforced by atomic reservation, while the daily token one
is a soft check plus hard accounting, because the real usage is not knowable
until the provider has answered.

Redis is real here (the suite forces ``REDIS_DB=15`` and flushes it per test),
so the counters under test are the production ones — an in-memory double would
not exercise the INCR/DECR interleaving that the reservation logic depends on.
"""

import threading
import uuid
from datetime import UTC, datetime

import pytest

from app.services import provider_quota
from app.services.provider_quota import (
    ProviderLimits,
    ProviderRateLimited,
    QuotaDecision,
    check_token_budget,
    limits_for,
    record_tokens,
    reserve,
    snapshot,
)

GROQ = "groq"


def _limits(monkeypatch, rpm=None, tokens=None) -> None:
    """Point the groq entry at small, round numbers for a readable test."""
    monkeypatch.setitem(
        provider_quota.PROVIDER_LIMITS,
        GROQ,
        ProviderLimits(requests_per_minute=rpm, tokens_per_day=tokens),
    )


class TestRequestBudget:
    def test_allows_up_to_the_limit_then_refuses(self, monkeypatch):
        _limits(monkeypatch, rpm=3)
        decisions = [reserve(GROQ) for _ in range(4)]

        assert [d.allowed for d in decisions] == [True, True, True, False]
        assert decisions[-1].scope == provider_quota.SCOPE_MINUTE
        assert decisions[-1].limit == 3
        assert 1 <= decisions[-1].retry_after <= 60

    def test_a_refused_caller_hands_its_slot_back(self, monkeypatch):
        # Without the DECR, every rejected request pushes the counter further
        # past the ceiling and holds it there for the rest of the window, so the
        # budget would stay spent by callers that were never served.
        #
        # Asserting that later attempts are still refused cannot detect this: at
        # capacity they are refused either way. The counter itself is the only
        # observable difference — it must track *served* requests, not attempts.
        _limits(monkeypatch, rpm=2)
        reserve(GROQ)
        reserve(GROQ)
        assert reserve(GROQ).allowed is False
        for _ in range(3):
            assert reserve(GROQ).allowed is False

        from app.cache.redis import redis_client

        key = provider_quota._minute_key(GROQ, provider_quota.time.time())
        assert int(redis_client.get(key) or 0) == 2, (
            "the counter tracked attempts rather than served requests, so a "
            "burst of refusals would keep the window exhausted for callers that "
            "never reached the provider"
        )

    def test_a_zero_ceiling_still_reports_itself_as_uncapped(self, monkeypatch):
        # `is_capped` must agree with the enforcement code, or `/qa/models` would
        # report `capped: true, requests_per_minute: 0` for a deployment that
        # serves every question.
        _limits(monkeypatch, rpm=0, tokens=0)
        assert limits_for(GROQ).is_capped is False
        assert snapshot(GROQ)["capped"] is False

    def test_bring_your_own_key_is_not_charged(self, monkeypatch):
        _limits(monkeypatch, rpm=1)
        assert reserve(GROQ, account=True).allowed is True
        # A user's own key has its own quota, so the operator's budget must not
        # decide whether their request is served.
        assert all(reserve(GROQ, account=False).allowed is _ for _ in [True] * 5)

    def test_uncapped_providers_are_never_refused(self, monkeypatch):
        # A paid key has no free-tier ceiling and a local model runs on the
        # operator's own hardware; holding either to Groq's numbers would be
        # wrong rather than merely redundant.
        _limits(monkeypatch, rpm=1)
        for provider in ("openai", "local"):
            assert limits_for(provider).is_capped is False
            assert all(reserve(provider).allowed is True for _ in range(50))

    def test_an_unknown_provider_is_uncapped_not_refused(self):
        # A provider added to the registry before it is added here must work,
        # not fail closed on a missing dictionary entry.
        assert limits_for("brand_new_provider").is_capped is False
        assert reserve("brand_new_provider").allowed is True

    def test_the_kill_switch_uncaps_everything(self, monkeypatch):
        _limits(monkeypatch, rpm=1)
        monkeypatch.setattr(provider_quota, "QUOTA_ENABLED", False)
        assert all(reserve(GROQ).allowed is True for _ in range(10))

    def test_concurrent_callers_cannot_overrun_the_ceiling(self, monkeypatch):
        # The reason admission is INCR-then-refund rather than read-then-decide:
        # every thread in a burst would otherwise read the same "29 of 30" and
        # all proceed.
        _limits(monkeypatch, rpm=10)
        allowed: list[bool] = []
        lock = threading.Lock()
        barrier = threading.Barrier(20)

        def attempt() -> None:
            barrier.wait()
            outcome = reserve(GROQ).allowed
            with lock:
                allowed.append(outcome)

        threads = [threading.Thread(target=attempt) for _ in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert sum(allowed) == 10, f"admitted {sum(allowed)} of 20, expected 10"

    def test_a_zero_or_negative_ceiling_means_uncapped(self, monkeypatch):
        # Pinned deliberately. A literal 0 would otherwise read as "serve
        # nothing", which is indistinguishable from a typo in an env var and
        # takes Q&A offline entirely; treating it as "no ceiling" makes a
        # misconfiguration degrade to unthrottled rather than to broken.
        _limits(monkeypatch, rpm=0, tokens=0)
        assert all(reserve(GROQ).allowed is True for _ in range(5))
        assert check_token_budget(GROQ, expected_tokens=10**9).allowed is True
        assert limits_for(GROQ).is_capped is False

    def test_a_new_minute_gets_a_fresh_budget(self, monkeypatch):
        _limits(monkeypatch, rpm=1)
        assert reserve(GROQ).allowed is True
        assert reserve(GROQ).allowed is False
        # Move the clock past the window boundary. The key embeds the window id
        # so that every process shares one window without coordinating.
        real_time = provider_quota.time.time
        monkeypatch.setattr(
            provider_quota.time, "time", lambda: real_time() + 61
        )
        assert reserve(GROQ).allowed is True


class _FrozenClock:
    """A stand-in for the ``datetime`` class whose ``now()`` is a fixed instant.

    Not a subclass on purpose: the quota module only ever calls
    ``datetime.now(UTC)`` and then does arithmetic on the *result*, so the
    stand-in has to hand back a real ``datetime`` and nothing more. A subclass
    would also have to satisfy ``__new__`` for every internal reconstruction
    (a ``+`` on a datetime subclass rebuilds one), which is more machinery than
    the module's use of the clock deserves.
    """

    def __init__(self, instant: datetime):
        self._instant = instant

    def now(self, tz=None) -> datetime:
        return self._instant if tz is None else self._instant.astimezone(tz)


def _freeze_clock(monkeypatch, instant: datetime) -> None:
    """Pin every ``datetime.now()`` in the quota module to one instant.

    The module reads the clock through ``datetime.now(UTC)`` at three call sites
    (the day key it reads, the day key it writes, and the reset time it
    reports), so freezing ``provider_quota.datetime`` fixes all three together —
    which is what makes a recorded token land in the same day as the check that
    reads it back.

    The alternative to freezing is to assert only that the answer is "within a
    day". That stops the failure and loses the property the assertion is there
    to pin: that the allowance resets at the next UTC *midnight* rather than on
    a rolling window, which is what the operator is promised.
    """
    monkeypatch.setattr(provider_quota, "datetime", _FrozenClock(instant))


class TestTokenBudget:
    def test_allows_while_the_allowance_covers_the_expected_cost(self, monkeypatch):
        _limits(monkeypatch, tokens=1_000)
        record_tokens(GROQ, 500)
        assert check_token_budget(GROQ, expected_tokens=400).allowed is True

    def test_refuses_when_the_remaining_allowance_is_short(self, monkeypatch):
        _limits(monkeypatch, tokens=1_000)
        _freeze_clock(monkeypatch, datetime(2026, 1, 1, 12, 0, tzinfo=UTC))
        record_tokens(GROQ, 700)
        decision = check_token_budget(GROQ, expected_tokens=400)

        assert decision.allowed is False
        assert decision.scope == provider_quota.SCOPE_TOKENS
        assert decision.limit == 1_000
        assert decision.used == 700
        # Until the next UTC day, when the allowance resets. Frozen at noon,
        # that is exactly twelve hours away.
        assert decision.retry_after == 12 * 3_600

    @pytest.mark.parametrize(
        ("hour", "minute", "second", "expected"),
        [
            (0, 0, 0, 86_400),  # a whole day remains just after midnight
            (9, 30, 0, 52_200),
            (12, 0, 0, 43_200),
            (23, 0, 0, 3_600),  # the exact hour the suite used to start failing
            (23, 30, 0, 1_800),  # the window in which it failed, nightly
            (23, 59, 59, 1),  # one second before the reset
        ],
    )
    def test_the_allowance_resets_at_the_next_utc_midnight(
        self, monkeypatch, hour, minute, second, expected
    ):
        """Every hour of the day, not just the comfortable ones.

        A single "more than an hour remains" assertion is true for 23 hours and
        false for the last one, so the suite was green except between 23:00 and
        24:00 UTC, where it reported a defect in the quota service that was not
        there (#534). Pinning the instant across the whole day is what makes the
        reset time a fact about the code rather than about when it was run.
        """
        _limits(monkeypatch, tokens=1_000)
        _freeze_clock(
            monkeypatch, datetime(2026, 1, 1, hour, minute, second, tzinfo=UTC)
        )
        record_tokens(GROQ, 700)
        decision = check_token_budget(GROQ, expected_tokens=400)

        assert decision.allowed is False
        assert decision.retry_after == expected

    def test_exactly_enough_remaining_is_allowed(self, monkeypatch):
        # Checking against `used + expected` rather than `used` is what stops a
        # question being refused when the remaining allowance covers it exactly.
        _limits(monkeypatch, tokens=1_000)
        record_tokens(GROQ, 600)
        assert check_token_budget(GROQ, expected_tokens=400).allowed is True
        assert check_token_budget(GROQ, expected_tokens=401).allowed is False

    def test_usage_accumulates_across_calls(self, monkeypatch):
        _limits(monkeypatch, tokens=1_000)
        for _ in range(4):
            record_tokens(GROQ, 250)
        # An allowed decision reports no `used` — only a refusal carries the
        # numbers, because that is the case an operator needs them for. The
        # accumulated total is therefore read the way an operator would.
        assert snapshot(GROQ)["tokens_used_today"] == 1_000
        assert check_token_budget(GROQ, expected_tokens=1).allowed is False

    def test_zero_and_negative_usage_is_ignored(self, monkeypatch):
        # A response without a usage block contributes nothing rather than
        # raising; the ceiling weakens, the request does not break.
        _limits(monkeypatch, tokens=100)
        record_tokens(GROQ, 0)
        record_tokens(GROQ, -5)
        assert check_token_budget(GROQ, expected_tokens=50).allowed is True

    def test_bring_your_own_key_is_not_charged(self, monkeypatch):
        _limits(monkeypatch, tokens=1_000)
        record_tokens(GROQ, 1_000)
        assert check_token_budget(GROQ, account=False).allowed is True
        record_tokens(GROQ, 0, account=False)

    def test_uncapped_providers_are_never_refused(self, monkeypatch):
        _limits(monkeypatch, tokens=10)
        record_tokens("openai", 10_000_000)
        assert check_token_budget("openai", expected_tokens=1_000_000).allowed is True


class TestFailsOpen:
    """An unreadable counter must not take question answering offline."""

    @pytest.fixture()
    def broken_redis(self, monkeypatch):
        def boom(*_args, **_kwargs):
            raise ConnectionError("redis is gone")

        monkeypatch.setattr(provider_quota.redis_client, "increment", boom)
        monkeypatch.setattr(provider_quota.redis_client, "get", boom)
        monkeypatch.setattr(provider_quota.redis_client, "increment_by", boom)
        return boom

    def test_request_budget_fails_open(self, monkeypatch, broken_redis, caplog):
        _limits(monkeypatch, rpm=1)
        with caplog.at_level("WARNING"):
            assert reserve(GROQ).allowed is True
        # Visible, so an unenforced ceiling is diagnosable rather than silent.
        assert any("ceiling" in r.message for r in caplog.records)

    def test_token_budget_fails_open(self, monkeypatch, broken_redis):
        _limits(monkeypatch, tokens=1)
        assert check_token_budget(GROQ, expected_tokens=10_000).allowed is True

    def test_recording_failure_does_not_raise(self, monkeypatch, broken_redis):
        # Under-counting weakens the ceiling; raising here would fail a question
        # that the provider already answered successfully.
        _limits(monkeypatch, tokens=1_000)
        record_tokens(GROQ, 500)  # must not raise

    def test_snapshot_still_reports_the_cap(self, monkeypatch, broken_redis):
        _limits(monkeypatch, rpm=30, tokens=200_000)
        out = snapshot(GROQ)
        # The endpoint degrades to "here is the ceiling" rather than failing.
        assert out["capped"] is True
        assert out["requests_per_minute"] == 30
        assert out["tokens_per_day"] == 200_000
        assert "requests_remaining" not in out


class TestSnapshot:
    def test_reports_caps_and_remaining(self, monkeypatch):
        _limits(monkeypatch, rpm=30, tokens=200_000)
        reserve(GROQ)
        reserve(GROQ)
        record_tokens(GROQ, 1_234)

        out = snapshot(GROQ)
        assert out["capped"] is True
        assert out["requests_remaining"] == 28
        assert out["tokens_used_today"] == 1_234

    def test_uncapped_providers_report_themselves_as_uncapped(self):
        out = snapshot("openai")
        assert out["capped"] is False
        assert out["requests_per_minute"] is None


class TestTheCeilingIsOnByDefault:
    """The whole feature is worthless if it is silently off.

    Flipping ``QUOTA_ENABLED`` (or the defaults) to "off" disables every ceiling
    in the module, and the tests that use it to *drive* the behaviour still pass
    — they set the limits themselves. Without the tests below, a deployment
    could enforce nothing and report 485 green tests.
    """

    def test_the_kill_switch_is_off_by_default(self):
        # Not monkeypatched: this asserts what a fresh process actually loads.
        assert provider_quota.QUOTA_ENABLED is True

    def test_the_defaults_match_groqs_published_free_tier(self):
        # Pins the numbers in the issue. Groq's free tier is 30 requests/minute
        # and 200K tokens/day for the default free model, org-wide.
        groq = provider_quota.PROVIDER_LIMITS[GROQ]
        assert groq.requests_per_minute == 30
        assert groq.tokens_per_day == 200_000

    def test_the_default_groq_ceiling_actually_refuses(self):
        # The end-to-end version: 30 calls are served, the 31st is not, using
        # the shipped defaults rather than values injected by the test.
        assert limits_for(GROQ).requests_per_minute == 30
        assert all(reserve(GROQ).allowed is True for _ in range(30))
        assert reserve(GROQ).allowed is False

    def test_paid_and_local_providers_stay_uncapped_by_default(self):
        assert limits_for("openai").is_capped is False
        assert limits_for("local").is_capped is False


class TestSharedIdentity:
    """AC4: the budget must not be something shared traffic can multiply."""

    def test_one_ip_and_many_ips_share_a_single_budget(self, monkeypatch):
        # The provider's ceiling is org-wide, so the budget is keyed by provider
        # alone. A per-IP or per-user key would let a caller escape the ceiling
        # by changing address — the exact behaviour the middleware's IP keying
        # correctly trades fairness for (see its docstring).
        _limits(monkeypatch, rpm=2)
        assert [reserve(GROQ).allowed for _ in range(3)] == [True, True, False]
        # A different "client" is irrelevant: there is no such dimension.
        assert reserve(GROQ).allowed is False
        assert reserve(uuid.uuid4().hex).allowed is True  # uncapped provider

    def test_the_app_limiter_and_the_provider_budget_are_independent(
        self, monkeypatch, client, auth_headers
    ):
        # Lowering the app's IP limit to satisfy Groq's 30 RPM would throttle
        # document listing, search and login to pay for one endpoint's upstream
        # budget. The two are separate, and this is the behavioural version of
        # that claim: with the provider budget completely spent, an unrelated
        # route keeps working.
        _limits(monkeypatch, rpm=1)
        reserve(GROQ)
        assert reserve(GROQ).allowed is False

        assert client.get("/v1/documents/", headers=auth_headers).status_code == 200
        assert client.get("/v1/statistics/me", headers=auth_headers).status_code == 200


class TestRateLimitedException:
    def test_carries_enough_for_the_response_and_logs(self):
        exc = ProviderRateLimited(
            provider="groq",
            scope=provider_quota.SCOPE_MINUTE,
            limit=30,
            used=30,
            retry_after=17,
            source=provider_quota.SOURCE_APP,
            detail="budget spent",
        )
        assert exc.provider == "groq"
        assert exc.limit == 30
        assert exc.retry_after == 17
        assert "30" in str(exc)

    @pytest.mark.parametrize("given,expected", [(0, 1), (None, 1), (-5, 1), (30, 30)])
    def test_retry_after_is_always_a_usable_positive_integer(
        self, given, expected
    ):
        # A zero or negative Retry-After tells a client to retry immediately,
        # which is worse than useless: it turns a quota pause into a hot loop
        # against a provider that is already refusing.
        exc = ProviderRateLimited(provider="groq", retry_after=given)
        assert exc.retry_after == expected

    def test_a_missing_decision_is_allowed(self):
        assert QuotaDecision(allowed=True).allowed is True
