"""A CRLF entrypoint must fail with a repair command, not `set: pipefail` (#762).

`docker-compose.yaml` runs the dev entrypoint through bash **from the bind
mount**, so bash parses the host working-tree bytes:

    command: ["/bin/bash", "/sandbox/ai-document-platform/dev-entrypoint.sh"]

`.gitattributes` declares `* text=auto eol=lf` for exactly this hazard, but it
only applies when git *writes* a file: a working tree materialised before that
rule keeps its stale CRLF bytes, and nothing reports it, because `git status`
compares normalized content. Bash then reads `set -euo pipefail\\r` and the
sandbox dies with

    dev-entrypoint.sh: line 2: set: pipefail: invalid option name

which names neither the cause nor a repair, and costs a bisect through the image
build, the compose file and the entrypoint to explain. It is invisible in an
editor, and the file looks fine in every diff.

Two properties are pinned here, and together they are the whole guard:

1. **It runs before the line it protects.** A guard placed below
   `set -euo pipefail` never executes on the failure it exists to report.
2. **It survives the CRLF it detects.** Bash parses a whole compound command
   before executing it, so a plain multi-line `if` fails to *parse* on a CRLF
   copy and the user gets a syntax error instead of the message. Every line of
   the guard therefore ends with the `# crlf-guard` tag — the trailing `\\r`
   lands inside a comment — and the tests below *run* the real block as LF and as
   CRLF rather than asserting that shape by eye.

The LF case runs the **extracted block**, not the whole file: past the guard the
real script applies migrations and starts uvicorn and vite, which a test must not
do. The CRLF case runs the whole file, because that is exactly the production
order of events — the guard exits before anything else is parsed.

`.gitattributes` is what prevents a Windows checkout from carrying CRLF at all,
and #761 pinned that static rule in `test_dev_sandbox_crossplatform.py`
(`test_gitattributes_forces_lf_everywhere`). **This** file covers the tree that
rule cannot reach: one materialised before it existed, where `git status` reports
nothing and the container is the only thing that can notice. The two are
complements, not duplicates — the static rule stops new checkouts from going
stale, and this guard turns the stale ones into an instruction.

Assertions about the cryptic failure deliberately do not search stderr for the
bare phrase: the guard's own message quotes it (that is what makes the message
findable by whoever hit it), so `"invalid option name" in stderr` is true in both
the fixed and the broken case. The signal used instead is the shape bash prints
(:data:`BASH_SET_FAILURE`) and the exit code, which is 2 on the old path and 1
from the guard.
"""

import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
ENTRYPOINT = REPO_ROOT / "dev-entrypoint.sh"

#: Marks every line of the guard block. It is the CRLF-absorption mechanism (the
#: trailing `\r` lands in the comment) *and* the delimiter this test extracts by.
GUARD_TAG = "# crlf-guard"

#: The line the guard must precede, or the guard protects nothing.
PROTECTED_LINE = "set -euo pipefail"

#: What bash prints when it meets `set -euo pipefail\r` — the message #762 is
#: about, and the one the guard must preempt.
BASH_SET_FAILURE = re.compile(r"line \d+: set: pipefail")

#: The remedy `README.md` → *Troubleshooting* documents for a stale CRLF
#: checkout, and therefore the one the guard must print. A second, narrower
#: remedy in the script would drift from the doc.
REMEDY = "git reset --hard"

#: The guard must say where the full remedy (and the `git ls-files --eol` confirm
#: step) lives, so nobody has to reconstruct it from the message.
REMEDY_DOC = "README.md"


def _bash() -> str:
    """Absolute path to ``bash``, or fail.

    Resolved rather than spelled as a bare ``"bash"`` (ruff S607), and reported
    rather than skipped: a missing bash means this guard is unverified, not that
    it is fine.
    """
    path = shutil.which("bash")
    if path is None:
        pytest.fail(
            "bash is not on PATH, so the CRLF guard in dev-entrypoint.sh cannot be "
            "exercised and this test would pass without checking anything (#762)."
        )
    return path


@pytest.fixture(scope="module")
def source() -> str:
    return ENTRYPOINT.read_text()


def _tagged(source: str) -> list[int]:
    """1-indexed lines that **end** with the tag — the guard's lines, and only them.

    Deliberately ``endswith`` and not a substring test: the comment above the
    guard quotes the tag while explaining itself, so a ``GUARD_TAG in line``
    scan pulls prose into the block and reports it as a line whose carriage
    return is unprotected.
    """
    return [
        n
        for n, line in enumerate(source.splitlines(), start=1)
        if line.rstrip().endswith(GUARD_TAG)
    ]


def _exact(source: str, text: str) -> list[int]:
    """1-indexed lines equal to ``text``, ignoring indentation.

    Also exact on purpose: the guard's comment quotes ``set -euo pipefail`` when
    explaining what it protects, and a substring match would call that comment
    the protected line and invert the ordering check.
    """
    return [n for n, line in enumerate(source.splitlines(), start=1) if line.strip() == text]


def _guard_block(source: str) -> str:
    """The guard block, extracted by its own tag.

    Extraction is what lets the LF case run without the rest of the entrypoint.
    """
    tagged = _tagged(source)
    lines = source.splitlines()
    assert tagged, (
        f"no {GUARD_TAG!r} lines in dev-entrypoint.sh — the block that absorbs its own "
        "carriage return is gone, so a CRLF checkout would fail with a syntax error "
        "instead of an actionable message (#762)"
    )
    return "\n".join(lines[tagged[0] - 1 : tagged[-1]])


def _as_crlf(text: str) -> bytes:
    return text.replace("\n", "\r\n").encode()


def _run(script: Path) -> subprocess.CompletedProcess:
    return subprocess.run(  # noqa: S603
        [_bash(), str(script)],
        capture_output=True,
        text=True,
        check=False,
    )


def _write(tmp_path: Path, name: str, text: str, *, crlf: bool = False) -> Path:
    script = tmp_path / name
    if crlf:
        script.write_bytes(_as_crlf(text))
    else:
        script.write_text(text)
    return script


class TestTheGuardIsWiredIntoTheRealFile:
    """The ordering and shape facts the two behaviour tests below rely on."""

    def test_the_protected_line_is_still_there(self, source: str):
        """An unfound needle must fail, not let the ordering test pass vacuously."""
        assert _exact(source, PROTECTED_LINE), (
            f"dev-entrypoint.sh no longer contains {PROTECTED_LINE!r}; the ordering "
            "guarantee below is now checking nothing (#762)"
        )

    def test_the_guard_precedes_the_line_it_protects(self, source: str):
        guard = _tagged(source)
        protected = _exact(source, PROTECTED_LINE)

        assert guard, "the CRLF guard is missing from dev-entrypoint.sh (#762)"
        assert guard[0] < protected[0], (
            f"the CRLF guard sits at line {guard[0]}, below {PROTECTED_LINE!r} at line "
            f"{protected[0]} — bash dies on that line before the guard can report why "
            "(#762)"
        )

    def test_nothing_but_comments_precede_the_guard(self, source: str):
        """No blank line and no command may sit above it.

        A blank line is a bare ``\\r`` command in a CRLF copy, so bash would print
        `$'\\r': command not found` *before* the guard's message and bury it under
        noise. Comment lines absorb the carriage return; this asserts the only
        thing above the guard is comments.
        """
        before = source.splitlines()[: _tagged(source)[0] - 1]
        offenders = [line for line in before if line.strip() and not line.lstrip().startswith("#")]

        assert not offenders, (
            "these lines precede the CRLF guard and are neither comments nor the "
            f"shebang: {offenders!r}. Anything executable here runs first, and a blank "
            "line turns into a `$'\\r': command not found` on a CRLF copy (#762)"
        )

    def test_no_untagged_line_splits_the_guard_block(self, source: str):
        """The tag on *every* line, with no gap, is what makes the block parse.

        Bash parses the whole compound command before running it, so one untagged
        line between the tags — a continuation, a second statement — puts a raw
        ``\\r`` back into the parse and the guard reports a syntax error instead of
        the fix.
        """
        lines = source.splitlines()
        tagged = _tagged(source)
        block = lines[tagged[0] - 1 : tagged[-1]]

        untagged = [line for line in block if not line.rstrip().endswith(GUARD_TAG)]
        assert not untagged, (
            "these lines sit inside the guard block without carrying the tag, so a "
            "trailing carriage return lands outside a comment and breaks the parse: "
            f"{untagged!r} (#762)"
        )


class TestTheGuardSurvivesTheCrlfItReports:
    """The behaviour, exercised on the real guard text."""

    def test_an_lf_block_does_not_trip(self, source: str, tmp_path: Path):
        script = _write(
            tmp_path,
            "guard-lf.sh",
            f"#!/bin/bash\n{_guard_block(source)}\necho SURVIVED\n",
        )
        result = _run(script)

        assert result.returncode == 0, (
            f"the guard fired on an LF file: {result.stderr!r} — it would refuse to "
            "start a correct checkout"
        )
        assert "SURVIVED" in result.stdout

    def test_a_crlf_block_trips_with_the_repair(self, source: str, tmp_path: Path):
        script = _write(
            tmp_path,
            "guard-crlf.sh",
            f"#!/bin/bash\n{_guard_block(source)}\necho SURVIVED\n",
            crlf=True,
        )
        result = _run(script)

        assert result.returncode == 1, (
            f"expected the guard to exit 1 on a CRLF copy, got {result.returncode} "
            f"(stderr: {result.stderr!r})"
        )
        assert "SURVIVED" not in result.stdout, "the guard let execution continue"
        assert "crlf" in result.stderr.lower()
        assert REMEDY in result.stderr, (
            "the message must print the remedy README.md documents for a stale CRLF "
            f"checkout: {result.stderr!r}"
        )
        assert REMEDY_DOC in result.stderr, (
            f"the message must point at {REMEDY_DOC} for the full remedy and the "
            f"`git ls-files --eol` confirm step: {result.stderr!r}"
        )

    def test_the_whole_crlf_entrypoint_exits_at_the_guard(self, source: str, tmp_path: Path):
        """The production shape: the real file, CRLF, run as bash run it.

        This is the regression test for #762. Nothing past the guard may be
        parsed — the rest of the file is CRLF too, and its `if [[ ... ]]; then\\r`
        lines are parse errors waiting to happen.
        """
        script = _write(tmp_path, "dev-entrypoint.sh", source, crlf=True)
        result = _run(script)

        assert result.returncode == 1, (
            f"a CRLF copy of dev-entrypoint.sh exited {result.returncode}, expected the "
            f"guard's 1 (stderr: {result.stderr!r})"
        )
        assert not BASH_SET_FAILURE.search(result.stderr), (
            f"the old cryptic failure is still reachable through the guard: {result.stderr!r}"
        )
        assert result.stdout == "", (
            "the guard exited before starting anything, so nothing it governs may have "
            f"written to stdout: {result.stdout!r}"
        )
        assert result.stderr.splitlines()[0].startswith("[dev] "), (
            "the guard's message must be the first thing printed — a leading "
            f"`$'\\r': command not found` is noise above the fix (#762): {result.stderr!r}"
        )
        assert "dev-entrypoint.sh" in result.stderr
        assert REMEDY in result.stderr
        assert REMEDY_DOC in result.stderr

    def test_the_old_failure_is_what_the_guard_replaces(self, tmp_path: Path):
        """Characterise the failure being fixed, so the fix cannot silently regress.

        Prefixed with a non-`set -o` option name on the first line for the same
        reason the real file has one: this pins that the *second* line is where
        bash dies, which is why the guard has to sit above it.
        """
        script = _write(
            tmp_path,
            "no-guard.sh",
            "#!/bin/bash\nset -euo pipefail\necho never reached\n",
            crlf=True,
        )
        result = _run(script)

        assert result.returncode == 2, (
            "without the guard a CRLF file must fail the way #762 describes, or these "
            f"tests are pinning the wrong failure (got {result.returncode})"
        )
        assert BASH_SET_FAILURE.search(result.stderr)
        assert "never reached" not in result.stdout

    def test_the_guard_is_silent_when_the_script_is_piped_in(self, source: str):
        """``bash < dev-entrypoint.sh`` cannot be checked, and must not say so.

        Piped in, ``BASH_SOURCE`` is empty: there is no file to read, so the guard
        skips. Without the ``-f`` test in its condition, the ``grep`` still ran,
        and reported `grep: : No such file or directory` before skipping — noise
        above the very failure this guard exists to explain. Compose always passes
        a path, so this pins the quiet behaviour rather than a supported
        invocation.
        """
        script = f"#!/bin/bash\n{_guard_block(source)}\necho BODY-REACHED\n"
        result = subprocess.run(  # noqa: S603
            [_bash(), "-s"],
            input=script,
            capture_output=True,
            text=True,
            check=False,
        )

        assert result.returncode == 0
        assert "BODY-REACHED" in result.stdout
        assert result.stderr == "", (
            "piping the entrypoint in is unverifiable, but it must be silent about "
            f"that: {result.stderr!r}"
        )
