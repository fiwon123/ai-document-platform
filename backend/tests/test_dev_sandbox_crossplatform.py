"""The dev sandbox must be usable on every OS, and `docker compose up` alone (#760).

Two separate contracts are pinned here, because breaking either is silent:

1. **Line endings.** The host shell scripts are executed *inside* the Linux
   container through a bind mount. With Git for Windows' default
   ``core.autocrlf=true`` they are checked out with CRLF, and the kernel then
   fails with ``/bin/bash^M: bad interpreter``. ``.gitattributes`` is the only
   thing that prevents that, and a Windows checkout is exactly where it is
   hardest to notice from maintenance happening on Linux.

2. **No host-only mounts in the base compose file.** A portfolio/demo user runs
   ``docker compose up`` with nothing installed. If the agent mounts
   (``~/.opencode``, ``~/.config/gh``, ``~/.gitconfig``, the Docker socket)
   stay in ``docker-compose.yaml``, Compose fails on Windows for paths the user
   does not have — or creates root-owned directories on Linux. They live in the
   agent override, which only developer entry points merge in.

The tests are static reads plus one subprocess (the launcher's ``help``), so
they run anywhere without Docker.
"""

import subprocess
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
COMPOSE_PATH = REPO_ROOT / "docker-compose.yaml"
AGENT_COMPOSE_PATH = REPO_ROOT / "docker-compose.agent.yaml"
GITATTRIBUTES_PATH = REPO_ROOT / ".gitattributes"
MAKEFILE_PATH = REPO_ROOT / "Makefile"
DEV_UP_PY = REPO_ROOT / "scripts" / "dev-up.py"
DEV_UP_PS1 = REPO_ROOT / "scripts" / "dev-up.ps1"
OPEN_IN_SANDBOX = REPO_ROOT / "scripts" / "open-in-sandbox.sh"

# Every mount that depends on something a demo user does not have on the host.
AGENT_MOUNT_MARKERS = (
    "docker.sock",
    ".opencode",
    ".config/gh",
    ".gitconfig",
)


def _load(path: Path) -> dict:
    return yaml.safe_load(path.read_text())


def _volumes(path: Path, service: str = "dev") -> list[str]:
    return [str(v) for v in (_load(path)["services"][service].get("volumes") or [])]


def _target_lines() -> dict[str, list[str]]:
    """Map each Makefile target to the recipe lines that follow it."""
    targets: dict[str, list[str]] = {}
    current: str | None = None
    for line in MAKEFILE_PATH.read_text().splitlines():
        if line and not line.startswith(("\t", "#")) and ":" in line:
            name = line.split(":", 1)[0].strip()
            # Skip variable assignments such as `COMPOSE := ...`.
            if "=" not in name and " " not in name:
                current = name
                targets.setdefault(current, [])
                continue
        if current is not None:
            if line.startswith("\t"):
                targets[current].append(line)
            elif line.strip() and not line.lstrip().startswith("#"):
                current = None
    return targets


# --- 1. line endings -------------------------------------------------------


def test_gitattributes_forces_lf_everywhere():
    """Without this a Windows clone cannot run the sandbox entrypoint."""
    assert GITATTRIBUTES_PATH.is_file(), (
        ".gitattributes is missing; a Windows checkout would keep CRLF in the "
        "container's entrypoint scripts"
    )
    text = GITATTRIBUTES_PATH.read_text()
    assert "text=auto eol=lf" in text, (
        ".gitattributes must normalise text to LF so the Linux container can "
        "execute the bind-mounted shell scripts on a Windows host"
    )


def test_the_container_entrypoint_is_invoked_through_bash():
    """The exec bit is not preserved on a Windows bind mount."""
    command = _load(COMPOSE_PATH)["services"]["dev"]["command"]
    assert command[:1] == ["/bin/bash"], (
        "dev must run the entrypoint as `/bin/bash <script>`; executing the "
        f"bind-mounted path directly fails on Windows. Got: {command!r}"
    )
    assert command[1].endswith("dev-entrypoint.sh")


# --- 2. base compose is standalone; agent mounts are opt-in ----------------


def test_base_compose_has_no_host_only_agent_mounts():
    volumes = _volumes(COMPOSE_PATH)
    offenders = [volume for volume in volumes for marker in AGENT_MOUNT_MARKERS if marker in volume]
    assert not offenders, (
        "docker-compose.yaml must stay runnable with a bare `docker compose up` "
        "on any OS. Move these host-only mounts to docker-compose.agent.yaml: "
        f"{offenders}"
    )


def test_base_compose_keeps_the_workspace_bind_mount():
    volumes = _volumes(COMPOSE_PATH)
    assert any("/sandbox/ai-document-platform" in volume for volume in volumes), (
        "the workspace bind mount is what makes source edits visible in the "
        f"container; found volumes={volumes!r}"
    )


def test_agent_override_supplies_every_host_only_mount():
    assert AGENT_COMPOSE_PATH.is_file(), "docker-compose.agent.yaml is missing"
    volumes = _volumes(AGENT_COMPOSE_PATH)
    for marker in AGENT_MOUNT_MARKERS:
        assert any(marker in volume for volume in volumes), (
            f"the agent override does not mount {marker!r}; the sandboxed agent "
            f"would start without it. volumes={volumes!r}"
        )


def test_base_compose_defaults_host_identity():
    """A demo user runs `docker compose up` without exporting UID/GID."""
    user = _load(COMPOSE_PATH)["services"]["dev"]["user"]
    assert user == "${HOST_UID:-1000}:${HOST_GID:-1000}", (
        "the dev service must default its identity so a bare `docker compose "
        f"up` works; got {user!r}"
    )


# --- 3. developer entry points ---------------------------------------------


def test_dev_up_does_not_require_the_agent():
    """The regression: `make dev-up` used to hard-fail without opencode."""
    targets = _target_lines()
    dev_up_line = next(
        line for line in MAKEFILE_PATH.read_text().splitlines() if line.startswith("dev-up:")
    )
    assert "require-agent" not in dev_up_line, (
        "`make dev-up` must start the application whether or not the host has "
        "an opencode binary; only opencode/shell need one"
    )
    assert "test -x" not in "\n".join(targets.get("preflight", [])), (
        "preflight must not require the opencode binary; a missing host agent "
        "is a warning, not a startup failure"
    )


def test_agent_targets_require_the_linux_binary():
    text = MAKEFILE_PATH.read_text()
    for target in ("opencode", "shell"):
        line = next(line for line in text.splitlines() if line.startswith(f"{target}:"))
        assert "require-agent" in line, (
            f"`make {target}` runs the agent inside the container and must "
            f"verify a Linux opencode binary is available; got {line!r}"
        )


def test_python_launcher_detects_linux_binaries_by_elf_magic():
    """A macOS/Windows binary cannot execute in the Linux container."""
    script = DEV_UP_PY.read_text()
    assert "\\x7fELF" in script, (
        "dev-up.py must check the ELF magic before mounting/announcing the "
        "agent; existence alone is not proof the binary can run in Linux"
    )
    assert "exec format error" in script.lower(), (
        "the launcher should explain why a non-Linux opencode binary is skipped"
    )


def test_python_launcher_help_runs_without_docker():
    result = subprocess.run(  # noqa: S603 - fixed argv, no shell
        [sys.executable, str(DEV_UP_PY), "help"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "docker compose up" in result.stdout
    for command in ("dev-up", "dev-down", "opencode", "infra-up"):
        assert command in result.stdout


def test_powershell_wrapper_exists_for_native_windows():
    assert DEV_UP_PS1.is_file(), (
        "native Windows users need a PowerShell entry point; cmd.exe cannot run the Makefile"
    )
    assert "dev-up.py" in DEV_UP_PS1.read_text()


def test_open_in_sandbox_uses_the_agent_config():
    """A plain `compose up -d` here would recreate the container without mounts."""
    script = OPEN_IN_SANDBOX.read_text()
    assert "docker-compose.agent.yaml" in script, (
        "open-in-sandbox.sh must reconcile the container with the agent "
        "override, otherwise it drops the mounts from a running session"
    )
