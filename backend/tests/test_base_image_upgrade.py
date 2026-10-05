"""Every published image must upgrade its base's packages (#670).

The Trivy gate reads a floating base tag, and a floating tag is only as current as
the day it was last rebuilt. ``nginxinc/nginx-unprivileged:1.27-alpine`` was two
OpenSSL patch releases behind, so the frontend image failed the gate on **42
findings — 40 HIGH and 2 CRITICAL** — in four packages that no change to our own
code can reach: ``c-ares``, ``libcrypto3``/``libssl3``, ``libexpat`` and
``libpng``. ``apk upgrade`` in the Dockerfile clears all of them.

The backend and worker images were the same argument for Debian and were fixed in
#661, so the rule now exists twice and is spelled two different ways. That is the
part worth pinning, because the two package managers are not interchangeable and
nothing catches a copy of one landing in the other:

- ``apt-get upgrade`` against an Alpine base fails, because there is no apt.
- ``apk upgrade`` against a Debian base fails for the same reason in reverse.

Both failures are loud, at build time. The failure this file is really about is
silent: **dropping the ``USER`` line that restores non-root.** The unprivileged
nginx base runs as uid 101, and ``apk upgrade`` cannot write the package database
as uid 101 — so root has to be entered for that one instruction. Forgetting to
come back produces an image that builds, passes every other check, and runs as
root in staging and production, defeating ``runAsNonRoot`` (#650).

``trivy`` is not available in the backend test environment, so the CVE count
itself cannot be asserted here. These tests pin the *rule* — the property that
makes the count go to zero — and the honest gate for the count is the release
PR's Trivy job.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

DOCKER_DIR = Path(__file__).resolve().parents[2] / "infra/docker"

#: Images the Trivy gate has actually reported a verdict on, so the rule below
#: has a measured defect behind it. ``minio`` is deliberately absent: the four
#: ``Scan *_image`` steps are sequential and the job aborts on the first non-zero
#: exit, so the frontend's failure meant minio was never scanned. Its base
#: (``alpine:3.20``) is a pinned *minor* tag and it deliberately runs as root for
#: volume ownership — a genuinely different case, but "different" is not
#: "checked". Its status is unknown, not clean, and ``test_minio_is_awaiting_its``
#: records that rather than leaving it silently exempt.
SCANNED = ("backend", "worker", "frontend")

_AWAITING_FIRST_SCAN = ("minio",)

_UPGRADE = re.compile(r"\b(apk|apt-get)\s+(?:-\S+\s+)*upgrade\b")


def _instructions(name: str) -> list[tuple[str, str]]:
    """Every instruction in a Dockerfile as ``(VERB, arguments)``.

    Comment-only lines are dropped; anything after a verb is left alone, because
    a ``#`` inside a ``RUN`` is a shell comment and not a Dockerfile one.
    Continuations are joined, since the upgrade is deliberately written across
    several lines and a line-by-line read would not see it.
    """
    text = (DOCKER_DIR / f"Dockerfile.{name}").read_text()
    lines = [ln for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]

    joined, buf = [], ""
    for line in lines:
        buf = f"{buf} {line.strip()}" if buf else line.strip()
        if buf.endswith("\\"):
            buf = buf[:-1].rstrip()
            continue
        joined.append(buf)
        buf = ""
    if buf:  # a trailing continuation with nothing after it
        joined.append(buf)

    out = []
    for stmt in joined:
        verb, _, args = stmt.partition(" ")
        out.append((verb.upper(), args.strip()))
    return out


def _shipped_stage(name: str) -> list[tuple[str, str]]:
    """The last ``FROM`` onwards — the stage that ends up in the published image.

    Only the final stage is in scope. A build stage's packages never reach the
    published image, so demanding an upgrade there would be a rule with no defect
    behind it, and ``node:22-alpine`` would fail it for no reason.
    """
    instrs = _instructions(name)
    starts = [i for i, (verb, _) in enumerate(instrs) if verb == "FROM"]
    assert starts, f"Dockerfile.{name} declares no FROM, so it publishes nothing to scan"
    return instrs[starts[-1] :]


def _base_image(stage: list[tuple[str, str]]) -> str:
    args = [a for a in stage[0][1].split() if not a.startswith("--")]
    assert args, "FROM with no image"
    return args[0]


def _manager_for(base: str) -> str:
    """The package manager the base image actually has.

    Keyed on the image name rather than on anything the Dockerfile says, so
    choosing the wrong manager is a failure here rather than a build error.
    """
    return "apk" if "alpine" in base else "apt-get"


def _upgrade_index(stage: list[tuple[str, str]]) -> int:
    for i, (verb, args) in enumerate(stage):
        if verb == "RUN" and _UPGRADE.search(args):
            return i
    raise AssertionError("no package upgrade instruction")


def test_every_image_is_classified():
    """Guard against the rule passing by matching nothing.

    A new Dockerfile is a new published image, and the failure mode of a
    name-keyed rule is that the new file is simply not in the list — so it ships
    unupgraded and nothing says so. This fails until the image is deliberately
    added to ``SCANNED`` or to ``_AWAITING_FIRST_SCAN``.
    """
    on_disk = {
        p.name.removeprefix("Dockerfile.")
        for p in DOCKER_DIR.glob("Dockerfile.*")
        if p.is_file()
    }
    unclassified = on_disk - set(SCANNED) - set(_AWAITING_FIRST_SCAN)
    assert not unclassified, (
        f"Dockerfile(s) {sorted(unclassified)} are neither in SCANNED nor in "
        "_AWAITING_FIRST_SCAN; classify them so the upgrade rule covers them"
    )


@pytest.mark.parametrize("image", SCANNED)
def test_base_packages_are_upgraded(image: str) -> None:
    """The invariant: a floating base tag is upgraded before it is published."""
    stage = _shipped_stage(image)
    _upgrade_index(stage)  # raises with a readable message if absent


@pytest.mark.parametrize("image", SCANNED)
def test_the_upgrade_uses_the_base_image_s_own_package_manager(image: str) -> None:
    """The two spellings are not interchangeable, and nothing else catches it.

    This is the assertion that makes the rule worth having. #661 added
    ``apt-get upgrade`` to two Debian images; the frontend needed ``apk``. Reading
    a fix from a neighbouring Dockerfile is the obvious way to get this wrong,
    and a wrong package manager fails the build rather than producing a silently
    vulnerable image — which is the good case, but it is still a red build.
    """
    stage = _shipped_stage(image)
    base = _base_image(stage)
    expected = _manager_for(base)
    used = _UPGRADE.search(stage[_upgrade_index(stage)][1]).group(1)
    assert used == expected, (
        f"Dockerfile.{image} is based on {base}, so it needs {expected} upgrade, "
        f"but it runs {used} — the other package manager is not present in that base"
    )


@pytest.mark.parametrize("image", SCANNED)
def test_the_upgrade_precedes_the_first_copy(image: str) -> None:
    """Placement is the point, not tidiness.

    After a ``COPY``, the upgrade layer is invalidated by every source change, so
    each rebuild re-downloads the index and the fix silently stops being applied
    promptly. Before any ``COPY``, the layer is cached independently of the app
    source — which is why #661 put it there and why the frontend copies follow it.
    """
    stage = _shipped_stage(image)
    upgrade_at = _upgrade_index(stage)
    copies = [i for i, (verb, _) in enumerate(stage) if verb == "COPY"]
    assert copies, f"Dockerfile.{image} copies nothing, so this rule is vacuous"
    first_copy = min(copies)
    assert upgrade_at < first_copy, (
        f"Dockerfile.{image} upgrades at instruction {upgrade_at} but first copies "
        f"at {first_copy}, so the layer is rebuilt on every source change"
    )


@pytest.mark.parametrize("image", SCANNED)
def test_the_image_still_runs_as_a_numeric_non_root_user(image: str) -> None:
    """The silent failure this file is about.

    The unprivileged nginx base runs as uid 101 and cannot write the apk database,
    so the upgrade has to run as root. Nothing forces the image to come back: an
    image left on ``USER root`` builds, scans and starts, and simply runs as root
    everywhere — which is what ``runAsNonRoot`` exists to prevent (#650).

    Numeric rather than a name for the same reason as #650: ``runAsNonRoot`` is a
    runtime admission check on the resolved uid, and a name leaves the image's own
    metadata un-verifiable.
    """
    stage = _shipped_stage(image)
    users = [args for verb, args in stage if verb == "USER"]
    assert users, f"Dockerfile.{image} declares no USER, so it inherits the base's"
    final = users[-1]
    uid = final.split(":")[0]
    assert uid.isdigit(), (
        f"Dockerfile.{image} ends with USER {final!r}, which is a name; runAsNonRoot "
        "cannot be verified from a name (#650)"
    )
    assert int(uid) != 0, (
        f"Dockerfile.{image} ends as root (USER {final!r}) — if the upgrade needed "
        "root, add the USER instruction that comes back to the unprivileged uid"
    )


@pytest.mark.parametrize("image", SCANNED)
def test_no_upgrade_leaves_a_package_index_behind(image: str) -> None:
    """Index files are not needed at runtime and are not free.

    ``apt-get`` needs an explicit ``rm -rf /var/lib/apt/lists/*``; ``apk``'s
    ``--no-cache`` covers the same ground. Either form is fine — what is not fine
    is a downloaded index left in the published layers.
    """
    stage = _shipped_stage(image)
    args = stage[_upgrade_index(stage)][1]
    base = _base_image(stage)
    if _manager_for(base) == "apk":
        assert "--no-cache" in args, (
            f"Dockerfile.{image} runs apk without --no-cache, so the package index "
            "is downloaded and kept in the published image"
        )
    else:
        assert "/var/lib/apt/lists" in args, (
            f"Dockerfile.{image} upgrades apt without clearing "
            "/var/lib/apt/lists, so the index stays in the published image"
        )


@pytest.mark.parametrize("image", _AWAITING_FIRST_SCAN)
def test_minio_is_awaiting_its(image: str) -> None:
    """Records the one deliberate exemption, so it cannot rot into an excuse.

    minio's final stage has no upgrade and runs as root on purpose, so both rules
    above would fail it. It is exempt because it has never been scanned, not
    because it has been cleared: the Trivy job exits on the first failing image
    and the frontend was third. When minio does get scanned, this test is the
    place to find out — and it must be replaced by an entry in ``SCANNED`` with a
    measured result, not deleted.
    """
    stage = _shipped_stage(image)
    assert not any(_UPGRADE.search(a) for verb, a in stage if verb == "RUN"), (
        f"Dockerfile.{image} now upgrades its base. If it has been scanned and "
        "cleared, move it to SCANNED with the measured result; if it upgrades but "
        "still has findings, this exemption is hiding a defect."
    )
    assert not [a for verb, a in stage if verb == "USER"], (
        f"Dockerfile.{image} now declares a USER. Its root-by-design arrangement is "
        "tied to PVC ownership, so changing it needs the volume ownership fixed too."
    )
