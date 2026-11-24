"""The dashboard's state, and its start and stop, for this session's task pane (#158).

    python3 -I dashboard_control.py status|start|stop

Prints one JSON object on one line and exits 0 (contract: the fork's README, "Dashboard").
Standard library only, run by the system interpreter, as answer_endpoint.py is.

Every command it runs (`systemctl`, `tailscale`) is a fixed argument list, run without a shell
in a process group of its own, within a time bound; however the call ends (its exit, the bound,
too much output, a failure, a stop signal), the group is killed with everything the command
started that is still in it, before the command is reaped, while its pid still names the group.
This is the shape of dashboard/server.py's `tailscale status` call.

Nothing a command prints is ever passed on: a failure is told by a fixed summary (which
command, its exit status), and systemd's values are mapped to fixed words. Its own children
are killed with their group; if the helper itself is killed with SIGKILL meanwhile, a hung
child and what it started outlive it (its bounds, 48 s at most, sit below the fork's).
"""

import contextlib
import json
import os
import re
import select
import shutil
import signal
import socket
import stat
import sys
import time
import tomllib
from pathlib import Path

UNIT = "claude-tweaks-dashboard.service"
PORT = 6767

# The bound on each command, in seconds.
SHOW_S = 5.0
SERVE_STATUS_S = 5.0
START_S = 10.0
SERVE_S = 10.0
STOP_S = 15.0
# How long a start waits for the server to answer on its socket.
WAIT_S = 5.0
# The bound on each step of the socket probe (connect, send, the first bytes of the answer).
PROBE_S = 1.0

# The most a command may print that is read: more is a failure.
MAX_OUTPUT = 1 << 20
# The most of the config that is read for its hosts.
MAX_CONFIG = 1 << 16
STOP_CHECK_S = 0.05
TERMINATING = {signal.SIGINT, signal.SIGTERM, signal.SIGHUP}


class Failed(Exception):
    """A command that could not run, or did not end within its bound: why, in a few words."""


class Missing(Failed):
    """A command that is not on the PATH."""


class TimedOut(Failed):
    """A command that did not end within its bound."""


TAILSCALE_FIX = "Install Tailscale (dashboard/README.md, Install, step 4)."


def run(argv: list[str], seconds: float) -> tuple[int, str]:
    """Runs `argv`: (its exit status, what it printed on stdout; stderr goes nowhere).
    Raises Failed when the command is missing or cannot run, takes longer than
    `seconds`, prints more than MAX_OUTPUT, or the system fails a step of the call. The stop
    signals (TERMINATING) are held back for the call, so none ends the helper between the
    spawn and the group's kill; one that comes ends the call at once and is let through once
    it is cleaned up."""
    held = signal.pthread_sigmask(signal.SIG_BLOCK, TERMINATING)
    try:
        return run_held(argv, time.monotonic() + seconds)
    except OSError:
        raise Failed(f"{argv[0]} could not run") from None
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, held)


def run_held(argv: list[str], deadline: float) -> tuple[int, str]:
    read_end, write_end = os.pipe()
    try:
        try:
            pid = os.posix_spawnp(
                argv[0],
                argv,
                os.environ,
                file_actions=[
                    (os.POSIX_SPAWN_OPEN, 0, os.devnull, os.O_RDONLY, 0),
                    (os.POSIX_SPAWN_DUP2, write_end, 1),
                    (os.POSIX_SPAWN_OPEN, 2, os.devnull, os.O_WRONLY, 0),
                ],
                setpgroup=0,
                setsigmask=(),
                setsigdef=(signal.SIGPIPE, signal.SIGXFSZ),
            )
        except FileNotFoundError:
            raise Missing(f"{argv[0]} not found") from None
        finally:
            os.close(write_end)
        try:
            printed = read_until_exit(pid, read_end, deadline, argv[0])
        finally:
            with contextlib.suppress(OSError):
                os.killpg(pid, signal.SIGKILL)
            _, status = os.waitpid(pid, 0)
        return os.waitstatus_to_exitcode(status), printed.decode("utf-8", "replace")
    finally:
        os.close(read_end)


def read_until_exit(pid: int, fd: int, deadline: float, name: str) -> bytearray:
    """What command `pid` prints on `fd`, to its end, once the command has exited; the
    command is left for its caller to reap. Ends the call when `deadline` passes, a stop
    signal waits, or the output passes MAX_OUTPUT."""
    printed = bytearray()
    poller = select.poll()
    poller.register(fd, select.POLLIN)
    ended = False
    while not (
        ended and os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    ):
        if not signal.sigpending().isdisjoint(TERMINATING):
            raise SystemExit(1)
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimedOut(f"{name} did not answer")
        if ended:
            time.sleep(min(left, STOP_CHECK_S))
        elif poller.poll(min(left, STOP_CHECK_S) * 1000):
            chunk = os.read(fd, 65536)
            ended = not chunk
            printed += chunk
            if len(printed) > MAX_OUTPUT:
                raise Failed(f"{name} printed too much")
    return printed


def config_home() -> Path:
    return Path(os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config"))


def config_path() -> Path:
    """Where the dashboard's config is, as dashboard/server.py finds it (`config_or_old`):
    `dashboard.toml`, else the phone view's `phone.toml` beside it when only that is there."""
    path = config_home() / "claude-tweaks" / "dashboard.toml"
    old = path.with_name("phone.toml")
    return old if not os.path.lexists(path) and os.path.lexists(old) else path


def unit_state() -> tuple[str, str]:
    """The unit's LoadState (`loaded`, `not-found`, ...) and ActiveState, as systemd says."""
    code, printed = run(
        [
            "systemctl",
            "--user",
            "show",
            "--property=LoadState",
            "--property=ActiveState",
            UNIT,
        ],
        SHOW_S,
    )
    values = dict(line.split("=", 1) for line in printed.splitlines() if "=" in line)
    if code != 0 or not values.get("LoadState"):
        raise Failed("systemctl failed")
    return values["LoadState"], values.get("ActiveState", "")


def state_dir() -> Path:
    # XDG: a relative value is invalid and is ignored.
    base = os.environ.get("XDG_STATE_HOME", "")
    if not os.path.isabs(base):
        base = str(Path.home() / ".local" / "state")
    return Path(base) / "claude-tweaks" / "dashboard"


def socket_path() -> Path:
    """The dashboard's socket, where dashboard/server.py listens by default."""
    return state_dir() / "dashboard.sock"


def answers(path: Path) -> bool:
    """Whether the dashboard's server answers a request on its socket, within PROBE_S for
    each step. Without the headers Tailscale Serve adds, the server answers `403` and logs
    nothing: an answer of any status is enough."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
            probe.settimeout(PROBE_S)
            probe.connect(str(path))
            probe.sendall(
                b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
            )
            return probe.recv(16).startswith(b"HTTP/1.")
    except OSError:
        return False


def mapping(sock: Path) -> tuple[str, str]:
    """How port 6767 stands in `tailscale serve status --json`: (`ours` when it serves plain
    HTTP to the dashboard's socket alone, `none` when nothing is on it, `other` otherwise;
    what serves it, as `what_serves` says, when `other`)."""
    code, printed = run(["tailscale", "serve", "status", "--json"], SERVE_STATUS_S)
    try:
        config = json.loads(printed) if printed.strip() else {}
    except (ValueError, RecursionError):
        config = None
    if code != 0 or not isinstance(config, dict):
        raise Failed("tailscale serve status failed")
    tcp = config.get("TCP") if isinstance(config.get("TCP"), dict) else {}
    web = config.get("Web") if isinstance(config.get("Web"), dict) else {}
    sites = [
        site for key, site in web.items() if str(key).rpartition(":")[2] == str(PORT)
    ]
    if str(PORT) not in tcp and not sites:
        return "none", ""
    entry = tcp.get(str(PORT))
    plain = isinstance(entry, dict) and set(entry) == {"HTTP"} and entry["HTTP"] is True
    if (
        plain
        and sites
        and all(
            proxy_of(site) is not None and is_ours(proxy_of(site), sock)
            for site in sites
        )
    ):
        return "ours", ""
    return "other", what_serves(sites)


def proxy_of(site: object) -> str | None:
    """The Proxy of a site that has the one handler, at `/`, and nothing else; else None."""
    handlers = (
        site.get("Handlers")
        if isinstance(site, dict) and set(site) == {"Handlers"}
        else None
    )
    root = (
        handlers.get("/")
        if isinstance(handlers, dict) and set(handlers) == {"/"}
        else None
    )
    proxy = (
        root.get("Proxy") if isinstance(root, dict) and set(root) == {"Proxy"} else None
    )
    return proxy if isinstance(proxy, str) else None


def is_ours(proxy: str, sock: Path) -> bool:
    """Whether `proxy` is a `unix:` target naming the dashboard's socket, whatever slashes
    Tailscale keeps after `unix:` (the stored form is checked once by hand: README) and
    whatever slashes either side repeats (an XDG_STATE_HOME of `//tmp/state` is absolute,
    and Path keeps its two leading slashes)."""

    def collapsed(path: str) -> str:
        return re.sub("/+", "/", path)

    return (
        sock.is_absolute()
        and proxy.startswith("unix:")
        and collapsed("/" + proxy[5:]) == collapsed(str(sock))
    )


# A web address's host and port, as one is named back: a name, IPv4 or bracketed IPv6.
HOST_PORT = re.compile(
    r"(?:[A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])(?::[0-9]{1,5})?"
)


def what_serves(sites: list) -> str:
    """What port 6767 serves, as far as it can be named safely: the first site's proxy as
    `scheme://host:port` (no user, password or path), `a Unix socket`, else `something else`."""
    proxy = next((p for p in map(proxy_of, sites) if p is not None), "")
    scheme, sep, rest = proxy.partition("://")
    host = re.split(r"[/?#]", rest, maxsplit=1)[0].rpartition("@")[2]
    if (
        sep
        and scheme in ("http", "https", "https+insecure")
        and HOST_PORT.fullmatch(host)
    ):
        return f"{scheme}://{host}"
    return "a Unix socket" if proxy.startswith("unix:") else "something else"


def address_of(config: Path) -> str:
    """Where the page is opened: the first of the config's `hosts`, else this machine's name
    on PORT, as dashboard/server.py defaults it. Only `hosts` is read; the PIN never leaves."""
    hosts = None
    # ValueError holds UnicodeDecodeError and tomllib.TOMLDecodeError.
    with contextlib.suppress(OSError, ValueError, RecursionError):
        fd = os.open(config, os.O_RDONLY | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as file:
            if stat.S_ISREG(os.fstat(file.fileno()).st_mode):
                hosts = tomllib.loads(file.read(MAX_CONFIG).decode("utf-8")).get(
                    "hosts"
                )
    first = hosts[0] if isinstance(hosts, list) and hosts else None
    plain = (
        isinstance(first, str)
        and 0 < len(first) <= 255
        and all(33 <= ord(c) <= 126 for c in first)
    )
    return f"http://{first if plain else f'{socket.gethostname()}:{PORT}'}"


def state(dashboard: str, why: str, set_up: bool, fix: str = "") -> dict:
    return {
        "dashboard": dashboard,
        "why": why,
        "set_up": set_up,
        "address": None,
        "fix": fix,
    }


def with_address(found: dict) -> dict:
    if found["why"] != "no config":
        found["address"] = address_of(config_path())
    return found


def status() -> dict:
    """The dashboard's state (`on`, `off` or `unknown`), why when not on, whether it is set
    up (its config and its unit), where it is opened, and the next step when not on."""
    return with_address(state_of())


def setup() -> tuple[dict | None, str]:
    """Whether the dashboard is set up: (None, the unit's ActiveState) when its config and
    its unit are there, else (the state saying which is missing, and its next step, "")."""
    config = config_path()
    if not config.is_file():
        return state(
            "off",
            "no config",
            False,
            f"Create {config}, readable by you alone, with the PIN"
            " (dashboard/README.md, Install, step 1).",
        ), ""
    try:
        load, active = unit_state()
    except Failed as failed:
        return state("unknown", str(failed), False), ""
    if load == "not-found":
        return state(
            "off",
            "unit not installed",
            False,
            f"Copy dashboard/{UNIT} to {config_home() / 'systemd' / 'user'}/, then run"
            " systemctl --user daemon-reload (dashboard/README.md, Install, step 3).",
        ), ""
    if load == "masked":
        return state(
            "off",
            "unit masked",
            False,
            f"systemctl --user unmask {UNIT}, then /overview start.",
        ), ""
    if load != "loaded":
        return state(
            "off",
            "unit file has errors"
            if load in ("bad-setting", "error")
            else "unit not loaded",
            False,
            f"systemctl --user status {UNIT} says what is wrong with the unit.",
        ), ""
    return None, active


def free_step(what: str) -> str:
    """The step that frees port 6767 when it serves something else."""
    return (
        f"Port {PORT} already serves {what} (tailscale serve status shows it). Free it with"
        f" tailscale serve --http={PORT} off, then /overview start."
    )


def state_of() -> dict:
    missing, active = setup()
    if missing is not None:
        return missing
    sock = socket_path()
    if not answers(sock):
        why = {
            "inactive": "stopped",
            "failed": "server failed",
            "active": "server not answering",
        }.get(active, "server not running")
        return state(
            "off",
            why,
            True,
            f"/overview start; journalctl --user -u {UNIT} says why it stopped.",
        )
    try:
        mapped, what = mapping(sock)
    except Missing:
        return state("off", "tailscale not found", True, TAILSCALE_FIX)
    except Failed as failed:
        return state(
            "unknown", str(failed), True, "Check that Tailscale runs: tailscale status."
        )
    if mapped == "none":
        return state("off", f"not served on {PORT}", True, "/overview start.")
    if mapped == "other":
        return state("off", f"{PORT} serves something else", True, free_step(what))
    return state("on", "", True)


def answer(outcome: str, message: str, found: dict) -> dict:
    return {"outcome": outcome, "message": message, **found}


def start() -> dict:
    """Starts the unit, then maps port 6767 on the tailnet to its socket (plain HTTP, never
    Funnel, never another port), and says how the dashboard stands then. Refuses, with the
    step that is missing, when the config, the unit or tailscale is not there, or 6767
    serves something else: then nothing is started. Never enables the unit."""
    missing, _ = setup()
    if missing is not None:
        outcome = "refused" if missing["dashboard"] == "off" else "failed"
        return answer(outcome, missing["fix"] or missing["why"], with_address(missing))
    if shutil.which("tailscale") is None:
        missing = state("off", "tailscale not found", True, TAILSCALE_FIX)
        return answer("refused", TAILSCALE_FIX, with_address(missing))
    sock = socket_path()
    try:
        mapped, what = mapping(sock)
    except Failed as failed:
        found = state(
            "unknown", str(failed), True, "Check that Tailscale runs: tailscale status."
        )
        return answer("failed", f"{failed}; nothing was started.", with_address(found))
    if mapped == "other":
        found = state("off", f"{PORT} serves something else", True, free_step(what))
        return answer("refused", free_step(what), with_address(found))
    started = attempt(
        "systemctl --user start", ["systemctl", "--user", "start", UNIT], START_S
    )
    if started:
        return answer(
            "failed", f"{started} journalctl --user -u {UNIT} says why.", status()
        )
    served = attempt(
        "tailscale serve",
        ["tailscale", "serve", "--bg", f"--http={PORT}", f"unix:{sock}"],
        SERVE_S,
    )
    if served:
        return answer(
            "failed",
            f"{served} Without operator rights, run once: sudo tailscale set"
            " --operator=$USER (dashboard/README.md, Install, step 4).",
            status(),
        )
    wait_for(sock)
    return answer("done", "Started the dashboard.", status())


def stop() -> dict:
    """Takes port 6767 off the tailnet when it serves the dashboard's socket (anything else
    there is left as it is), then stops the unit when it runs, and says how the dashboard
    stands then. Needs no config. Never disables the unit."""
    said, problems = [], []
    if shutil.which("tailscale") is not None:
        try:
            mapped, _ = mapping(socket_path())
        except Failed as failed:
            mapped = ""
            problems.append(f"{failed}.")
        if mapped == "ours":
            off = attempt(
                "tailscale serve off",
                ["tailscale", "serve", f"--http={PORT}", "off"],
                SERVE_S,
            )
            (problems if off else said).append(off or f"Took {PORT} off the tailnet.")
        elif mapped == "other":
            said.append(f"Left {PORT} as it is: {PORT} serves something else.")
    try:
        load, active = unit_state()
    except Failed as failed:
        load, active = "", ""
        problems.append(f"{failed}; the unit was not checked.")
    if load == "loaded" and active not in ("inactive", "failed", ""):
        stopped = attempt(
            "systemctl --user stop", ["systemctl", "--user", "stop", UNIT], STOP_S
        )
        (problems if stopped else said).append(stopped or f"Stopped {UNIT}.")
    if problems:
        return answer("failed", " ".join(said + problems), status())
    if not any(line.startswith(("Took", "Stopped")) for line in said):
        said.insert(0, "The dashboard is already off.")
    return answer("done", " ".join(said), status())


def attempt(name: str, argv: list[str], seconds: float) -> str:
    """Runs `argv`; "" when it ended well, else what went wrong, in a fixed sentence that
    says `name` and its exit status, never what it printed."""
    try:
        code, _ = run(argv, seconds)
    except TimedOut as failed:
        return f"{name}: {failed} within {seconds:g} s."
    except Failed as failed:
        return f"{name}: {failed}."
    return "" if code == 0 else f"{name} failed (exit status {code})."


def wait_for(sock: Path) -> None:
    """Gives the server WAIT_S to answer on its socket, as it reads Tailscale's state first."""
    deadline = time.monotonic() + WAIT_S
    while not answers(sock) and time.monotonic() < deadline:
        time.sleep(0.1)


def main(argv: list[str]) -> int:
    actions = {"status": status, "start": start, "stop": stop}
    if len(argv) != 1 or argv[0] not in actions:
        print("usage: dashboard_control.py status|start|stop", file=sys.stderr)
        return 2
    print(json.dumps(actions[argv[0]]()))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
