"""No tracked file may be committed with unresolved conflict markers (#678).

`AGENTS.md` and `.opencode/instructions/workflow.md` reached `main` carrying
`<<<<<<<`/`=======`/`>>>>>>>` lines. `git status` was clean throughout — the
damage was in the history, not in anyone's working tree, so nothing reported it.

## How it got there

The branch commit was clean; the *merge* carried the markers. It then happened
twice more, because once the base file is marked up the next merge conflicts
inside the conflict, producing a nested block:

    feee139  4 markers   squash-merged a conflicted tree into dev
    de9d118 10 markers   merged again, nesting the markers, committed unresolved
    9c449b2 10 markers   released to main

That is the shape to expect. A single occurrence is usually an in-progress
merge; a *nested* one means an unresolved merge was committed, and the next one
made it worse.

## Why this test has to exist

Nothing else read those files. `ci.yml` triggers on `backend/**`,
`frontend/**`, `.github/workflows/**` and four lockfiles — **no markdown and no
docs paths** — so a docs-only change runs no job at all, and an unresolved
conflict in one is indistinguishable from a clean file in every other check.

This test lives under `backend/tests/` on purpose: that is the one directory
whose modification both runs `backend-test` and is inside the trigger filter, so
editing the guard re-runs the guard.

This is the same class of defect as the gates that never gated: `Scan images`
skipped rather than passed while `build-images` was red (#638), and
`rollout status` had no viewer for `batch/Job` so its check could not report
success on any run (#673). A guard nobody runs is indistinguishable from a
guard that passes.

## What is detected, and the two things deliberately not detected

Only the opening (`<` x7) and closing (`>` x7) markers at the **start of a
line**, which is the only position git writes them in.

* **The `=======` separator is not matched on its own.** A bare run of `=` at
  column 0 is ordinary content — Markdown setext headings (`===` under a
  title), and `=====` underlines used as comment banners all over this repo.
  Matching it would fail the suite on legitimate text. A separator with no
  markers around it is not a conflict; every real conflict has the two markers
  this does match.
* **Indented markers are not matched.** Nothing in git's merge output indents
  them, and allowing leading whitespace would make every fenced example of a
  conflict in a doc or a test fixture fail the suite. Column 0 is precise and
  catches every marker git can actually produce.

Both exclusions are trade-offs, not oversights. They hold because the opening
marker alone is a reliable signal: git emits one whenever it merges, whether
or not a human resolved it.
"""

import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

#: Written with character classes so this file contains no marker of its own —
#: otherwise the scan below would report the guard that implements it.
MARKER_START = re.compile(r"^<{7}(?: |$)")
MARKER_END = re.compile(r"^>{7}(?: |$)")

#: The two files that actually broke. Named so a future ignore rule cannot
#: quietly stop covering them.
KNOWN_AFFECTED = ["AGENTS.md", ".opencode/instructions/workflow.md"]

#: Anything with a NUL in its first 8 KiB is binary (PNG, ICO, woff, .pyc).
_BINARY_SNIFF_BYTES = 8192


def markers_in(text: str) -> list[tuple[int, str]]:
    """Return ``(line number, line)`` for every conflict marker in ``text``."""
    found = []
    for number, line in enumerate(text.splitlines(), start=1):
        if MARKER_START.match(line) or MARKER_END.match(line):
            found.append((number, line))
    return found


def _git() -> str:
    """Absolute path to ``git``.

    Resolved rather than spelled as a bare ``"git"``: an absolute path is what
    `ruff` rule S607 wants, and it keeps the call independent of the caller's
    PATH. A missing git is reported, never treated as "nothing to scan".
    """
    path = shutil.which("git")
    if path is None:
        pytest.fail(
            "git is not on PATH, so the tracked-file list is unavailable and the "
            "conflict-marker scan would silently cover nothing and pass (#678)."
        )
    return path


def _tracked_files() -> list[Path]:
    """Every file git tracks, relative to the repo root.

    Fails loudly rather than returning empty: an empty scan passes trivially,
    which is the failure mode this whole change exists to remove.
    """
    try:
        result = subprocess.run(  # noqa: S603
            [_git(), "-C", str(REPO_ROOT), "ls-files", "-z"],
            capture_output=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        pytest.fail(
            "could not enumerate tracked files via `git ls-files`, so the conflict-marker "
            f"scan would silently cover nothing and pass ({exc}). Run the suite from a "
            "checkout, or fix this guard before trusting it."
        )

    names = [n for n in result.stdout.decode().split("\0") if n]
    if not names:
        pytest.fail(
            "`git ls-files` reported no tracked files. The scan would pass over an empty "
            "set, which is indistinguishable from a clean repository (#678)."
        )
    return [REPO_ROOT / name for name in names]


def _read_text(path: Path) -> str | None:
    """File contents, or ``None`` for anything that is not decodable text."""
    try:
        with path.open("rb") as handle:
            head = handle.read(_BINARY_SNIFF_BYTES)
            if b"\0" in head:
                return None
            rest = handle.read()
    except OSError:
        return None
    try:
        return (head + rest).decode("utf-8")
    except UnicodeDecodeError:
        return None


class TestDetector:
    """The matcher itself, on samples — no tracked file is needed to test it.

    Exercising the detector here is what lets this file prove it *would* have
    caught the regression without a fixture containing markers, which the
    repository-wide scan below would then fail on.
    """

    def test_detects_an_open_marker(self):
        assert markers_in("<<<<<<< HEAD\n") == [(1, "<<<<<<< HEAD")]

    def test_detects_a_close_marker_carrying_its_branch_name(self):
        branch = ">>>>>>> f91498b (refactor: adopt two-tier branch model)"
        assert markers_in(f"kept\n{branch}\n") == [(2, branch)]

    def test_detects_a_whole_conflict_block(self):
        block = "before\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\nafter\n"
        numbers = [n for n, _ in markers_in(block)]
        assert numbers == [2, 6], "both the opening and the closing marker are the signal"

    def test_detects_the_nested_block_that_means_a_merge_was_committed(self):
        """The shape seen on `main`: a merge conflicted inside an earlier conflict."""
        block = (
            "<<<<<<< HEAD\n=======\n"
            "<<<<<<< HEAD\nkept\n=======\n"
            ">>>>>>> branch\n>>>>>>> origin/main\n"
        )
        assert [n for n, _ in markers_in(block)] == [1, 3, 6, 7]

    def test_reports_the_real_line_number_not_the_marker_index(self):
        text = "\n".join(["filler"] * 40 + ["<<<<<<< HEAD"])
        assert markers_in(text) == [(41, "<<<<<<< HEAD")]

    @pytest.mark.parametrize(
        "text",
        [
            pytest.param("", id="empty file"),
            pytest.param("no markers at all\n", id="ordinary prose"),
            # A `=======` run at column 0 is legitimate content, not a conflict.
            pytest.param("A Title\n=======\n\nbody\n", id="markdown setext heading"),
            pytest.param("# Section\n# =======\n", id="comment banner"),
            # The separator alone, with no markers bracketing it.
            pytest.param("a\n=======\nb\n", id="separator without markers"),
            # Six or eight is not seven, and a run of eight starts with seven.
            pytest.param("a\n<<<<<< b\n", id="six angle brackets"),
            pytest.param(">>>>>>>> origin/main\n", id="eight angle brackets"),
            # Only column 0 counts; git never indents a marker.
            pytest.param("text <<<<<<< HEAD inline\n", id="marker mid-line"),
            pytest.param("  <<<<<<< HEAD\n", id="marker indented"),
            # The guard must not report its own source.
            pytest.param('MARKER_START = re.compile(r"^<{7}(?: |$)")\n', id="its own source"),
        ],
    )
    def test_ignores_text_that_is_not_a_marker(self, text):
        assert markers_in(text) == []

    def test_crlf_line_endings_do_not_hide_a_marker(self):
        assert markers_in("kept\r\n<<<<<<< HEAD\r\n")[0][0] == 2


@pytest.fixture(scope="module")
def scanned() -> dict[Path, str | None]:
    """Every tracked file paired with its text, or ``None`` if it is not text."""
    return {path: _read_text(path) for path in _tracked_files()}


class TestRepository:
    """The real invariant: the working tree carries no committed conflict."""

    def test_git_is_resolved_to_an_absolute_path(self):
        """A bare ``"git"`` fails ruff S607; resolving it must stay resolved."""
        resolved = _git()
        assert Path(resolved).is_absolute(), f"git resolved to a relative path: {resolved}"

    def test_tracked_files_are_actually_scanned(self, scanned):
        """Guard against a scan that quietly covers nothing."""
        relative = {str(p.relative_to(REPO_ROOT)) for p in scanned}
        for name in KNOWN_AFFECTED:
            assert name in relative, f"{name} is not being scanned by the conflict-marker guard"

    def test_no_tracked_file_contains_a_conflict_marker(self, scanned):
        offenders: dict[str, list[tuple[int, str]]] = {}
        for path, text in scanned.items():
            if text is None:
                continue
            found = markers_in(text)
            if found:
                offenders[str(path.relative_to(REPO_ROOT))] = found

        assert not offenders, (
            "committed conflict markers, which means an unresolved merge was committed "
            "rather than resolved (#678):\n"
            + "\n".join(
                f"  {name}: {len(found)} marker line(s), first at line {found[0][0]}"
                for name, found in sorted(offenders.items())
            )
            + "\n\nIf a marker is deliberate — a doc *showing* a conflict — it must not sit at "
            "column 0, and that doc should say why."
        )

    def test_the_two_files_that_broke_are_clean(self, scanned):
        """Named individually so a regression is unmistakably the known one."""
        for name in KNOWN_AFFECTED:
            text = scanned[REPO_ROOT / name]
            assert text is not None, f"{name} could not be read as text"
            assert markers_in(text) == [], f"{name} still carries conflict markers"
