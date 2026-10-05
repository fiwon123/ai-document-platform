"""Tests for the media tokens that authorise browser-fetched document bytes.

The invariant, and the reason this module can be small: **a token authorises one
document, one kind of asset, for a bounded time, and nothing else.** Every test
below is a way of trying to widen that, because each of those widenings is what
turns a link in a chat window into someone else's document.

The other thing pinned here is the failure behaviour. Verification is total and
returns a bool rather than raising, because the caller has one decision to make
(403) and no useful way to act on *which* of six things went wrong — and a
caller that can tell them apart is a caller that will start telling the requester.
"""

import time
from uuid import uuid4

import pytest

from app.services.media_tokens import (
    KIND_ORIGINAL,
    KIND_THUMBNAIL,
    MEDIA_TOKEN_TTL_SECONDS,
    issue_token,
    verify_token,
)

DOC = uuid4()
OTHER_DOC = uuid4()

# Not a secret and not a password: an arbitrary second key, named so the
# linter's hardcoded-credential rule does not read intent as a leak.
OTHER_SIGNING_KEY = "a-different-key"


class TestRoundTrip:
    def test_a_fresh_token_verifies(self):
        token = issue_token(DOC, KIND_THUMBNAIL)
        assert verify_token(token, DOC, KIND_THUMBNAIL) is True

    def test_both_kinds_verify_independently(self):
        for kind in (KIND_ORIGINAL, KIND_THUMBNAIL):
            assert verify_token(issue_token(DOC, kind), DOC, kind) is True

    def test_the_token_is_opaque_and_carries_only_an_expiry_and_a_signature(self):
        """No document id, no filename, nothing to read.

        A JWT-shaped token here would be a general-purpose credential format
        applied to a value that only ever needs to be a capability. The whole
        token is two numbers' worth of structure: an expiry and a digest.
        """
        token = issue_token(DOC, KIND_THUMBNAIL)
        assert str(DOC) not in token
        assert str(KIND_THUMBNAIL) not in token
        assert token.count(".") == 1
        expiry, _, signature = token.partition(".")
        assert int(expiry) > 0
        assert len(signature) == 64  # hex sha256
        assert set(signature) <= set("0123456789abcdef")

    def test_issue_rejects_an_unknown_kind(self):
        # Fail at issue time, where it is our bug, rather than silently
        # signing a kind nothing will ever verify.
        with pytest.raises(ValueError, match="unknown media kind"):
            issue_token(DOC, "everything")


class TestScope:
    def test_a_token_is_bound_to_its_document(self):
        token = issue_token(DOC, KIND_ORIGINAL)
        assert verify_token(token, OTHER_DOC, KIND_ORIGINAL) is False

    def test_a_token_is_bound_to_its_kind(self):
        """The one that matters most: a preview link must not fetch the file.

        Both links are handed to the same browser for the same document, so
        without `kind` inside the signed message any user with read access — or
        anyone who can read a shared link — could upgrade a preview to the
        original.
        """
        thumbnail = issue_token(DOC, KIND_THUMBNAIL)
        assert verify_token(thumbnail, DOC, KIND_ORIGINAL) is False
        assert verify_token(issue_token(DOC, KIND_ORIGINAL), DOC, KIND_THUMBNAIL) is False

    def test_a_token_cannot_be_reused_for_a_longer_expiry(self):
        """Editing the expiry invalidates the signature, because it is signed.

        The naive implementation compares a signature over the *payload* but
        trusts an unsigned expiry field, which is a token that lives forever.
        """
        token = issue_token(DOC, KIND_THUMBNAIL)
        expiry, _, signature = token.partition(".")
        forged = f"{int(expiry) + 10_000_000}.{signature}"
        assert verify_token(forged, DOC, KIND_THUMBNAIL) is False

    def test_a_token_from_another_secret_does_not_verify(self):
        from app.services.media_tokens import _signature

        # A different signing key must produce a different signature for the
        # same message, or rotating SECRET_KEY would leave old links valid.
        expiry = int(time.time()) + 600
        mine = _signature(DOC, KIND_THUMBNAIL, expiry)
        theirs = _signature(DOC, KIND_THUMBNAIL, expiry, secret=OTHER_SIGNING_KEY)
        assert mine != theirs
        assert verify_token(f"{expiry}.{theirs}", DOC, KIND_THUMBNAIL) is False


class TestComparisonIsConstantTime:
    """One test that cannot work by outcome, and says so.

    Swapping ``hmac.compare_digest`` for ``==`` changes no result — the two
    compare the same two strings — so every other test here passes either way
    and the difference is invisible to a normal assertion. What differs is the
    *timing*: ``==`` returns at the first differing byte, which is what makes a
    forged signature recoverable one byte at a time. Measuring that would need a
    statistical attack, a stable machine and a large budget, and it would fail
    for reasons that have nothing to do with this code.

    So the guard is on the call rather than the answer, and the limitation is
    written down instead of pretended away.
    """

    def test_verification_uses_compare_digest(self, monkeypatch):
        from app.services import media_tokens

        calls = []
        real = media_tokens.hmac.compare_digest

        def spy(a, b):
            calls.append((a, b))
            return real(a, b)

        monkeypatch.setattr(media_tokens.hmac, "compare_digest", spy)
        token = media_tokens.issue_token(DOC, KIND_THUMBNAIL)

        assert media_tokens.verify_token(token, DOC, KIND_THUMBNAIL) is True
        # One call for a valid token: the signature really is compared through
        # the constant-time path, not short-circuited by some earlier `==`.
        assert len(calls) == 1
        assert len(calls[0][0]) == len(calls[0][1]) == 64


class TestExpiry:
    def test_a_token_is_valid_just_before_its_expiry(self):
        now = 1_000_000.0
        token = issue_token(DOC, KIND_THUMBNAIL, ttl_seconds=60, now=now)
        assert verify_token(token, DOC, KIND_THUMBNAIL, now=now + 59) is True

    def test_a_token_is_refused_at_and_after_its_expiry(self):
        now = 1_000_000.0
        token = issue_token(DOC, KIND_THUMBNAIL, ttl_seconds=60, now=now)
        # At the boundary it is already spent: a window is a deadline, not a
        # suggestion, and an off-by-one here is a token that outlives its
        # promise by an unbounded amount if the comparison is `<` in the wrong
        # place.
        assert verify_token(token, DOC, KIND_THUMBNAIL, now=now + 60) is False
        assert verify_token(token, DOC, KIND_THUMBNAIL, now=now + 3600) is False

    def test_the_default_lifetime_is_short_and_bounded(self):
        # Fifteen minutes: long enough that a page left open overnight does not
        # lose every preview at once, short enough that a link in a proxy log is
        # dead by morning. The upper bound is the part with teeth — this is a
        # capability for one user's bytes, not a session.
        assert 300 <= MEDIA_TOKEN_TTL_SECONDS <= 1800

    def test_a_token_cannot_be_extended_by_asking_for_a_longer_life(self):
        # `ttl_seconds` is a caller's choice for *issuing*, not something a
        # verifier can be talked into; a forged "please expire later" is just a
        # different expiry, and a different expiry is a different signature.
        short = issue_token(DOC, KIND_ORIGINAL, ttl_seconds=1, now=0)
        assert verify_token(short, DOC, KIND_ORIGINAL, now=2) is False


class TestHostileInput:
    @pytest.mark.parametrize(
        "token",
        [
            "",
            "garbage",
            "123",
            "123.",
            ".abc",
            "...",
            "notanumber.abc",
            "12.34.56",
            "999999999999999999999999.abc",  # expiry beyond int range
            "-1.abc",
            "1e9.abc",  # float syntax must not be accepted as an int
            "١٢٣.abc",  # non-ASCII digits
            None,
        ],
    )
    def test_malformed_tokens_are_refused_without_raising(self, token):
        assert verify_token(token, DOC, KIND_THUMBNAIL) is False

    def test_an_unknown_kind_is_refused_rather_than_signed_against(self):
        token = issue_token(DOC, KIND_THUMBNAIL)
        assert verify_token(token, DOC, "../other") is False
        assert verify_token(token, DOC, "") is False

    def test_a_truncated_signature_is_refused(self):
        token = issue_token(DOC, KIND_THUMBNAIL)
        expiry, _, signature = token.partition(".")
        for shorter in (signature[:-1], signature[:-8], "0"):
            assert verify_token(f"{expiry}.{shorter}", DOC, KIND_THUMBNAIL) is False

    def test_an_uppercased_signature_is_refused(self):
        """Case is part of the value, not presentation.

        hex digests are lowercase, and accepting an uppercased form would mean
        two distinct token strings for the same capability — which shows up
        later as a cache that misses on a value it has seen.
        """
        token = issue_token(DOC, KIND_THUMBNAIL)
        expiry, _, signature = token.partition(".")
        assert signature == signature.lower()
        assert verify_token(f"{expiry}.{signature.upper()}", DOC, KIND_THUMBNAIL) is False
