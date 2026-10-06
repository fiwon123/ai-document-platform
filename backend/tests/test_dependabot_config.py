"""Dependabot must open its PRs against `dev`, not the default branch (#693).

`.github/dependabot.yml` set no `target-branch`, so all three ecosystems fell
back to the repository default — `main`. The consequences were not theoretical:
15 Dependabot PRs (#143, #145–#154, #170, #490, #665–#668) targeted `main`, sat
288 commits behind `dev`, and four were already conflicting.

Merging one into `main` would put a dependency bump into production without it
ever passing through the integration branch, and would leave `main` **ahead** of
`dev` — so the next release PR would look to revert it. Dependabot also labels
its PRs `dependencies`/`python`/`javascript` and never `ci`, so against `main`
such a PR is a run whose jobs all come back `skipped` (#680): green-looking,
verifying nothing.

This file reads the config rather than trusting the comment beside it, and it
iterates over **every** entry in `updates:` rather than naming the three that
exist today — so an ecosystem added later is covered without editing here, and
one that omits `target-branch` fails loudly.

Deliberately not asserted: that the open PRs have been retargeted. GitHub does
not move an existing PR when `target-branch` changes, so that is a one-off
operational step tracked separately; asserting it here would make the test fail
for a reason that has nothing to do with the config file it reads.
"""

from functools import cache
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
DEPENDABOT_PATH = REPO_ROOT / ".github" / "dependabot.yml"

#: The branch every update must open against — the integration branch that all
#: feature work lands on before release.
TARGET = "dev"


@cache
def _config() -> dict:
    return yaml.safe_load(DEPENDABOT_PATH.read_text())


@cache
def _updates() -> list[dict]:
    updates = _config().get("updates")
    assert isinstance(updates, list) and updates, (
        f"{DEPENDABOT_PATH} has no `updates:` list — nothing would be checked"
    )
    return updates


def _ecosystem(entry: dict) -> str:
    return f"{entry.get('package-ecosystem')}:{entry.get('directory')}"


class TestDependabotTargetsDev:

    def test_every_update_sets_target_branch_to_dev(self):
        for entry in _updates():
            branch = entry.get("target-branch")
            assert branch == TARGET, (
                f"{_ecosystem(entry)} has target-branch={branch!r}, not {TARGET!r}. "
                "Without it Dependabot falls back to the repository default branch "
                "(main), so its PRs bypass the integration branch entirely and land "
                "green-looking with every job skipped (#693, #680)"
            )

    def test_the_expected_ecosystems_are_present(self):
        """A rename or removal would otherwise leave the loop above vacuous."""
        ecosystems = {entry.get("package-ecosystem") for entry in _updates()}
        assert ecosystems == {"pip", "npm", "github-actions"}, (
            f"expected pip, npm and github-actions; found {sorted(ecosystems)}. "
            "If an ecosystem was added, the loop over `updates:` already covers it "
            "— but a rename or removal should be a deliberate, visible edit here"
        )

    def test_no_entry_falls_back_to_the_default_branch(self):
        """Same as the loop above, but failing on the *absence* of the key —
        which is the state the file was actually in before #693."""
        missing = [
            _ecosystem(entry) for entry in _updates() if "target-branch" not in entry
        ]
        assert not missing, (
            f"these updates omit `target-branch` and would open PRs against `main`: "
            f"{missing}"
        )
