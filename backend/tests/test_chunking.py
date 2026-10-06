"""ChunkingService chunk-window behaviour.

The regression these guard is #688: a break point landing inside the overlap
window made the window slide *backwards*, reach a fixed point, and append an
identical chunk forever. The worker was OOM-killed while chunking a perfectly
ordinary 6-page PDF (20 KB, six A4 pages, no images), and the document stayed in
`processing` forever.

Two things are asserted here, and they are different claims:

  * the pathological input **terminates** (this is the fix)
  * well-behaved input produces **byte-identical** chunks to the original
    implementation (this is the fix's cost — which is zero)

The second matters as much as the first. A fix that makes the loop terminate by
changing how the window advances would also change every existing document's
chunking, silently.

Both claims are checked against an **unbounded** oracle, which is why every
helper here is bounded. An unbounded loop does not fail a test — it consumes the
whole memory budget and SIGKILLs the runner, so the suite dies with exit 137 and
no failure message. That is exactly what the first version of this file did: it
listed a pathological input among the "well-behaved" cases, the oracle looped on
it, and the entire run was killed. See `_reference_chunks` and `_deadline`.
"""

import multiprocessing
import os
import resource

import pytest

from app.services.chunking import ChunkingService, TextChunk

# The smallest input that reproduced #688: one "\n\n" at offset 300. It
# resolves to 302, so with chunk_size=1000/overlap=200 the next window starts at
# 102, finds the same break again, and pins there for ever.
TRIGGER = "A" * 300 + "\n\n" + "B" * 2000

# A second trigger shape, and the one this file initially got wrong. The break is
# *near the start* of the window rather than 300 chars in: from start=0 it
# resolves to 702, so the next window starts at 502, and from 502 the very same
# break is found again. Pinned at 502, exactly like TRIGGER pins at 102.
#
# It is listed here, not among the well-behaved inputs, because it is not one.
TRIGGER_LATE_BREAK = "x" * 700 + "\n\n" + "y" * 2000

requires_posix_rlimits = pytest.mark.skipif(
    not hasattr(resource, "RLIMIT_AS"),
    reason="a child-process address-space cap needs POSIX resource limits",
)

# Headroom granted *on top of* whatever the parent already occupies. Relative
# rather than absolute for two reasons: the fork's copy-on-write mappings count
# against `RLIMIT_AS`, so a fixed cap would break legitimate runs once the suite
# has loaded enough to exceed it; and the runaway is what the headroom bounds, so
# a smaller headroom means a faster, cleaner failure. 512 MiB is many times what
# any real chunking run allocates, so it cannot produce a false positive.
_CHILD_HEADROOM_BYTES = 512 * 1024 * 1024
_CHILD_FALLBACK_LIMIT_BYTES = 1024 * 1024 * 1024
# Backstop for a runaway that does *not* allocate: with `chunk_overlap >
# chunk_size` the pre-fix window walks `start` into negative indices, where every
# slice is empty, so nothing grows and only the clock can stop it. 15s is still
# ~7 orders of magnitude more than the fixed implementation needs (microseconds),
# so it cannot produce a false pass.
_CHILD_DEADLINE_SECONDS = 15.0


def _parent_address_space_bytes() -> int:
    """The parent's current virtual size, so the child's cap can be relative."""
    try:
        with open("/proc/self/status", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("VmSize:"):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    return _CHILD_FALLBACK_LIMIT_BYTES - _CHILD_HEADROOM_BYTES


def _chunk_in_capped_child(text, chunk_size, chunk_overlap, conn) -> None:
    """Chunk ``text`` under a hard address-space cap. Runs in the forked child."""
    verdict, payload = "error", None
    limit = _parent_address_space_bytes() + _CHILD_HEADROOM_BYTES
    try:
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
        payload = ChunkingService(chunk_size, chunk_overlap).chunk_text(text)
        verdict = "ok"
    except MemoryError:
        verdict = "memory"
    except BaseException as exc:  # noqa: BLE001 - reported as a test failure
        verdict = "error"
        payload = repr(exc)
    try:
        conn.send((verdict, payload))
    finally:
        conn.close()
        # Skip interpreter teardown: after a MemoryError it can itself raise and
        # print noise that looks like a second, unrelated failure.
        os._exit(0)


def _chunk_within_cap(text: str, *, chunk_size: int = 1000, chunk_overlap: int = 200):
    """Run ``chunk_text`` in a child that cannot exhaust memory; assert it ends.

    An unbounded loop does not fail a test — it allocates until the OOM killer
    SIGKILLs the whole pytest process, so the suite dies with exit 137 and no
    message naming the test. That is exactly what the first version of this file
    did, twice.

    A time-based deadline does **not** fix that. The #688 loop appends ~1 KB per
    iteration, so it exhausts memory in seconds — a 5-second signal fires long
    after the process is already gone. ``RLIMIT_AS`` bounds it deterministically
    instead: the runaway dies as ``MemoryError`` inside the child, which is
    catchable, so the regression surfaces as the ordinary test failure it should
    be.
    """
    ctx = multiprocessing.get_context("fork")
    receiver, sender = ctx.Pipe(duplex=False)
    process = ctx.Process(
        target=_chunk_in_capped_child,
        args=(text, chunk_size, chunk_overlap, sender),
    )
    process.start()
    sender.close()
    try:
        if not receiver.poll(_CHILD_DEADLINE_SECONDS):
            raise AssertionError(
                f"chunk_text did not terminate within {_CHILD_DEADLINE_SECONDS}s "
                f"— the #688 infinite loop"
            )
        verdict, payload = receiver.recv()
    finally:
        receiver.close()
        if process.is_alive():
            process.kill()
        process.join(timeout=5)

    if verdict == "memory":
        raise AssertionError(
            f"chunk_text exhausted its {_CHILD_HEADROOM_BYTES // (1024 * 1024)} MiB "
            f"budget on {len(text)} chars without terminating — the #688 infinite loop"
        )
    if verdict == "error":
        raise AssertionError(f"chunk_text raised in the child: {payload}")
    return payload


def _reference_chunks(text: str, chunk_size: int, chunk_overlap: int) -> list[TextChunk]:
    """The pre-#688 implementation, verbatim, under a hard iteration cap.

    Used as the oracle for "did anything change?". Without the cap this is a
    trap: on a pathological input it appends chunks until the OOM killer takes
    the whole pytest process, which reads as a crashed suite rather than a
    failed test. `max_iterations` is a strict upper bound on a *terminating*
    run, because every iteration that does not pin advances `start` by at least
    one, so no terminating run can exceed `len(text)` of them. The cap
    therefore never fires on a valid comparison, and fires immediately —
    before allocating anything meaningful — on the inputs it exists to catch.
    """
    max_iterations = len(text) + 2

    class _Reference:
        _find_break_point = ChunkingService._find_break_point

        def __init__(self) -> None:
            self.chunk_size = chunk_size
            self.chunk_overlap = chunk_overlap

        def chunk_text(self, body: str) -> list[TextChunk]:
            if not body.strip():
                return []
            chunks: list[TextChunk] = []
            start = 0
            chunk_index = 0
            iterations = 0
            while start < len(body):
                iterations += 1
                if iterations > max_iterations:
                    raise AssertionError(
                        f"the pre-#688 implementation did not terminate on "
                        f"{len(body)} chars (pinned at start={start}) — this "
                        f"input is pathological, so it cannot be used as an "
                        f"oracle"
                    )
                end = start + self.chunk_size
                if end < len(body):
                    break_point = self._find_break_point(body, start, end)
                    if break_point > start:
                        end = break_point
                chunk_content = body[start:end].strip()
                if chunk_content:
                    chunks.append(
                        TextChunk(
                            content=chunk_content,
                            chunk_index=chunk_index,
                            metadata={
                                "start_char": start,
                                "end_char": end,
                                "char_count": len(chunk_content),
                            },
                        )
                    )
                    chunk_index += 1
                start = end - self.chunk_overlap
                if start >= len(body):
                    break
            return chunks

    return _Reference().chunk_text(text)


@requires_posix_rlimits
class TestTerminatesOnPathologicalInput:
    """The regression itself.

    Every call goes through `_chunk_within_cap`, so a reintroduced #688 fails
    these tests instead of OOM-killing the runner.
    """

    def test_break_inside_overlap_window_terminates(self):
        chunks = _chunk_within_cap(TRIGGER)

        assert 0 < len(chunks) < 50, "chunk count must stay bounded"

    def test_late_break_inside_overlap_window_terminates(self):
        # The second trigger shape. Listed explicitly because it is easy to
        # mistake for well-behaved input — a paragraph break roughly 700 chars
        # into a 2702-char document looks unremarkable — and that mistake is
        # what made the first version of this file OOM-kill the suite.
        chunks = _chunk_within_cap(TRIGGER_LATE_BREAK)

        assert 0 < len(chunks) < 50, "chunk count must stay bounded"

    @pytest.mark.parametrize(
        "label,text",
        [
            ("break 300 chars in", TRIGGER),
            ("break 700 chars in", TRIGGER_LATE_BREAK),
        ],
    )
    def test_the_oracle_refuses_to_run_on_pathological_input(self, label, text):
        """The bounded oracle reports these as unpinnable instead of hanging.

        Asserted directly so the cap is a tested guard rather than untested
        scaffolding — the cap is the only thing standing between a misclassified
        input and a SIGKILLed runner.
        """
        with pytest.raises(AssertionError, match="did not terminate"):
            _reference_chunks(text, chunk_size=1000, chunk_overlap=200)

    def test_the_trigger_arithmetic_is_what_the_comment_claims(self):
        service = ChunkingService()

        break_point = service._find_break_point(TRIGGER, 0, 1000)

        assert break_point == 302
        # 302 - 200 == 102, which is *behind* the window that produced it, and
        # from 102 the same break is found again — that fixed point is #688.
        assert break_point - service.chunk_overlap == 102
        assert service._find_break_point(TRIGGER, 102, 1102) == break_point

    def test_the_late_trigger_arithmetic_is_what_the_comment_claims(self):
        service = ChunkingService()

        break_point = service._find_break_point(TRIGGER_LATE_BREAK, 0, 1000)

        assert break_point == 702
        assert break_point - service.chunk_overlap == 502
        assert service._find_break_point(TRIGGER_LATE_BREAK, 502, 1502) == break_point

    def test_page_joined_text_terminates(self):
        # PDF pages are joined with "\n\n", so break points cluster at page
        # boundaries and land inside the overlap window often enough that a
        # real 6-page PDF triggered this.
        pages = [
            f"Section {i}\n" + " ".join(f"w{i}_{j}" for j in range(60))
            for i in range(24)
        ]
        chunks = _chunk_within_cap("\n\n".join(pages))

        assert 0 < len(chunks) < 100

    def test_only_blank_lines_terminates(self):
        chunks = _chunk_within_cap("\n\n" * 5000)

        assert isinstance(chunks, list)

    @pytest.mark.parametrize("overlap,size", [(200, 1000), (1000, 1000), (2000, 1000)])
    def test_advance_holds_when_overlap_reaches_or_exceeds_chunk_size(
        self, overlap, size
    ):
        # A misconfigured overlap made *every* window non-advancing. It is not
        # the bug that shipped, but it is the same invariant.
        text = "sentence one. sentence two. sentence three. " * 200

        chunks = _chunk_within_cap(text, chunk_size=size, chunk_overlap=overlap)

        assert isinstance(chunks, list)


@requires_posix_rlimits
class TestOutputIsUnchangedForWellBehavedInput:
    """The fix must cost nothing where the window already advanced.

    Every input here is one the pre-#688 implementation handles without
    pinning — that is what makes it usable as an oracle, and it is asserted
    rather than assumed (see `test_the_oracle_refuses_to_run_on_pathological_input`).
    """

    @pytest.mark.parametrize(
        "label,text",
        [
            ("continuous prose", " ".join(f"word{i}" for i in range(3000))),
            (
                "blank line every ~40 chars",
                "\n\n".join(f"Paragraph {i} with some words in it." for i in range(400)),
            ),
            ("exact multiple of chunk size", "x" * 2000),
            ("shorter than one chunk", "hello world"),
            ("sentences with periods", " ".join(f"Sentence number {i}." for i in range(900))),
            ("tabs and mixed whitespace", "\t".join(f"col{j}" for j in range(2000))),
        ],
    )
    def test_identical_to_the_pre_fix_implementation(self, label, text):
        expected = _reference_chunks(text, chunk_size=1000, chunk_overlap=200)
        actual = _chunk_within_cap(text)

        assert actual == expected, f"chunking changed for {label!r}"

    @pytest.mark.parametrize(
        "label,text",
        [
            ("continuous prose", " ".join(f"word{i}" for i in range(3000))),
            ("exact multiple of chunk size", "x" * 2000),
        ],
    )
    def test_the_oracle_terminates_on_the_well_behaved_inputs(self, label, text):
        """The oracle's cap must not fire where the window does advance."""
        assert _reference_chunks(text, chunk_size=1000, chunk_overlap=200) != []


@requires_posix_rlimits
class TestExistingBehaviour:
    """Invariants that held before #688 and must still hold.

    Routed through `_chunk_within_cap` like everything else. This file is meant
    to be run against the *pre-fix* implementation to prove the guards fire, and
    two of the inputs here (`TRIGGER`, `TRIGGER_LATE_BREAK`) do not terminate
    under it — so an in-process call does not fail the test, it OOM-kills the
    runner and takes the remaining tests with it.
    """

    def test_empty_and_whitespace_only_text_yields_no_chunks(self):
        assert _chunk_within_cap("") == []
        assert _chunk_within_cap("   \n\n  \t ") == []

    def test_chunk_indices_are_contiguous_and_ordered(self):
        chunks = _chunk_within_cap(TRIGGER + "B" * 2000)

        assert [c.chunk_index for c in chunks] == list(range(len(chunks)))

    def test_metadata_offsets_address_the_chunks_own_content(self):
        pages = [
            f"Section {i}\n" + " ".join(f"w{i}_{j}" for j in range(60))
            for i in range(24)
        ]
        text = "\n\n".join(pages)

        for chunk in _chunk_within_cap(text):
            meta = chunk.metadata
            assert meta["start_char"] < meta["end_char"]
            assert meta["char_count"] == len(chunk.content)
            assert text[meta["start_char"] : meta["end_char"]].strip() == (
                chunk.content
            )

    def test_consecutive_windows_keep_the_full_overlap(self):
        """Criterion 4 of #688: where the window already advanced, it still does.

        Stated on *source offsets*, not on chunk text. The obvious formulation —
        "the tail of chunk N appears in chunk N+1" — is false for almost every
        real input, because `chunk_text` strips each chunk and the break point
        sits on the whitespace that gets stripped off the end of chunk N while
        chunk N+1 still starts before it. On `page joined` prose that
        formulation fails for all 18 pairs even though every window overlaps by
        the full 200 characters. The offsets are what the overlap actually is.
        """
        pages = [
            f"Section {i}\n" + " ".join(f"w{i}_{j}" for j in range(60))
            for i in range(24)
        ]
        chunks = _chunk_within_cap("\n\n".join(pages))

        assert len(chunks) > 1
        for current, following in zip(chunks, chunks[1:], strict=False):
            backstep = (
                current.metadata["end_char"] - following.metadata["start_char"]
            )
            assert backstep == ChunkingService().chunk_overlap

    def test_the_overlap_is_sacrificed_only_where_it_must_be(self):
        """The fix's actual cost, stated rather than left implicit.

        When a break resolves inside the overlap window, honouring the overlap
        would mean not advancing at all — which is #688. So exactly one window
        drops its overlap, and every other window keeps it. Pinning this means a
        later change that starts dropping overlap everywhere fails here instead
        of quietly producing shorter, less redundant chunks for every document.
        """
        overlap = ChunkingService().chunk_overlap
        chunks = _chunk_within_cap(TRIGGER_LATE_BREAK)

        backsteps = [
            current.metadata["end_char"] - following.metadata["start_char"]
            for current, following in zip(chunks, chunks[1:], strict=False)
        ]

        assert backsteps.count(0) == 1, f"expected one sacrificed overlap: {backsteps}"
        assert all(b in (0, overlap) for b in backsteps)
        assert backsteps.count(overlap) == len(backsteps) - 1

    def test_custom_chunk_size_is_honoured(self):
        text = " ".join(f"word{i}" for i in range(300))

        chunks = _chunk_within_cap(text, chunk_size=100, chunk_overlap=20)

        assert len(chunks) > 1
        assert all(len(c.content) <= 100 for c in chunks)