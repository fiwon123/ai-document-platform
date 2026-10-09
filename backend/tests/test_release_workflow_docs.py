"""The release merge must never be able to delete `dev` (#708, #709).

`gh pr merge --squash --delete-branch` on the release PR deletes its *head*
branch — and a release PR's head is `dev` itself. That is what removed the
integration branch from the remote after #701: Dependabot (`target-branch:
dev`) and the uv-lock-upgrade workflow (`git fetch origin dev`) both broke
until #708 restored it.

The workflow document is the control point: the command an agent copies is
the one it runs. So this file pins the *shape* of the release instructions:

1. Step 7 (release merge) carries no `--delete-branch`.
2. Step 6 (feature merge) still carries it — feature branches *should* be
   deleted, and a test that would pass if the flag were purged from the
   whole document pins nothing.
3. Step 7 verifies `origin/dev` afterwards (`git ls-remote --heads origin
   dev`) and merges `main` back into `dev`, so the next release PR's
   merge-base is current.
4. The github-workflow skill states the same rule, because it is the other
   place an agent reads the merge command from.

Assertions run on whole substrings within their section, and every section
lookup fails loudly if the heading was renamed — a guard that cannot find
its target must not pass on an empty string.
"""

from functools import cache
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPO_ROOT / ".opencode" / "instructions" / "workflow.md"
SKILL_PATH = REPO_ROOT / ".opencode" / "skills" / "github-workflow" / "SKILL.md"

FEATURE_MERGE_COMMAND = "gh pr merge <number> --squash --delete-branch"
LS_REMOTE_CHECK = "git ls-remote --heads origin dev"
MERGE_MAIN_BACK = "git merge origin/main"


@cache
def _sections() -> dict[str, str]:
    """workflow.md split into ``{heading: text until the next heading}``."""
    sections: dict[str, str] = {}
    heading = None
    for line in WORKFLOW_PATH.read_text().splitlines():
        if line.startswith("### "):
            heading = line[4:].strip()
            sections[heading] = ""
        elif heading is not None:
            sections[heading] += line + "\n"
    return sections


def _section(*fragments: str) -> str:
    """The one section whose heading contains every fragment.

    Fails loudly when the heading is gone: a renamed step must move this
    test with it, never leave it asserting against a stale (or empty) slice.
    """
    matches = [
        text
        for heading, text in _sections().items()
        if all(fragment in heading for fragment in fragments)
    ]
    assert len(matches) == 1, (
        f"expected exactly one workflow section headed by {fragments!r}, "
        f"found {len(matches)} — headings present: {list(_sections())}"
    )
    return matches[0]


@cache
def _release_section() -> str:
    return _section("7.", "Release merge")


@cache
def _feature_section() -> str:
    return _section("6.", "Review & Merge")


def _normalized(text: str) -> str:
    """Collapse whitespace so an assertion survives prose re-wrapping."""
    return " ".join(text.split())


def _code_blocks(text: str) -> list[str]:
    """The fenced ``` blocks of a section — the commands an agent copies."""
    blocks: list[str] = []
    current: list[str] = []
    in_block = False
    for line in text.splitlines():
        if line.strip().startswith("```"):
            if in_block:
                blocks.append("\n".join(current))
                current = []
            in_block = not in_block
        elif in_block:
            current.append(line)
    return blocks


class TestReleaseMergeCannotDeleteDev:
    def test_no_release_command_carries_delete_branch(self):
        offenders = [
            block for block in _code_blocks(_release_section())
            if "--delete-branch" in block
        ]
        assert not offenders, (
            f"step 7 shows a command with `--delete-branch` ({offenders!r}) — "
            "the release PR's head is `dev`, so this deletes the integration "
            "branch (#708)"
        )

    def test_release_merge_command_is_present(self):
        """A merge command must still be shown — otherwise the assertion
        above passes on a section that lost its command entirely."""
        blocks = _code_blocks(_release_section())
        assert any(
            "gh pr merge <number> --squash" in block for block in blocks
        ), (
            f"step 7's code blocks ({blocks!r}) contain no release merge "
            "command — the `--delete-branch` assertion has nothing to guard"
        )

    def test_release_section_warns_about_dev(self):
        text = _normalized(_release_section())
        assert "deletes the integration branch" in text, (
            "step 7 does not say why `--delete-branch` is forbidden there — "
            "an unexplained prohibition is the first thing a future edit "
            "removes"
        )


class TestFeatureMergeStillDeletesItsBranch:
    def test_feature_merge_keeps_delete_branch(self):
        assert FEATURE_MERGE_COMMAND in _feature_section(), (
            "step 6 no longer deletes merged feature branches — the release "
            "guard above would pass even if the flag were purged from the "
            "whole document, which pins nothing"
        )


class TestPostReleaseDevVerification:
    def test_release_section_verifies_dev_on_the_remote(self):
        assert LS_REMOTE_CHECK in _release_section(), (
            "step 7 never verifies that `dev` still exists on the remote — "
            "the step-8 prose check is what never fired after #701 (#708)"
        )

    def test_release_section_merges_main_back_into_dev(self):
        assert MERGE_MAIN_BACK in _release_section(), (
            "step 7 does not merge `main` back into `dev` — without it the "
            "next release PR's merge-base is stale and re-lists every file "
            "from this release"
        )


class TestTheSkillSaysTheSameThing:
    def test_skill_never_deletes_dev(self):
        text = SKILL_PATH.read_text()
        assert "Never delete `dev`" in text, (
            f"{SKILL_PATH.name} carries no rule against deleting `dev` — it "
            "is the other place an agent reads the merge command from"
        )

    def test_skill_scopes_delete_branch_to_feature_branches(self):
        text = SKILL_PATH.read_text()
        assert "feature branches only" in text, (
            f"{SKILL_PATH.name} does not scope `--delete-branch` to feature "
            "branches"
        )
