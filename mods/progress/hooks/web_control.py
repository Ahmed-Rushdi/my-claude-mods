"""Local refresh and separately opted-in owner control for an opened Progress session.

No model, command execution or Progress store access. The native controller reads
stdout notifications and writes one result file after native state publishes.
Owner requests require --owner; the native callback alone validates and acts.
"""

import argparse
import contextlib
import fcntl
import hmac
import json
import os
import re
import secrets
import shutil
import signal
import socket
import socketserver
import stat
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path

SESSION = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
OUTCOMES = {"refreshed": 200, "gone": 410, "failed": 502, "busy": 503}
OWNER_OUTCOMES = {
    "prepared": 200,
    "started": 200,
    "cancelled": 200,
    "rejected": 409,
    "disabled": 403,
    "gone": 410,
    "failed": 502,
    "busy": 503,
}
MAX_BODY = 2048
MAX_RESULT = 256
READ_S = 5
WAIT_S = 15


def strict_json(raw):
    """`raw` as UTF-8 JSON with no repeated key and no NaN or Infinity; else ValueError.
    Keep in sync with dashboard/server.py strict_json: tests/test_owner_request_cases.py."""

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result

    def constant(name):
        raise ValueError("not JSON")

    try:
        return json.loads(
            raw.decode("utf-8"), object_pairs_hook=unique, parse_constant=constant
        )
    except RecursionError:
        raise ValueError("nested too deep") from None


# Keep in sync with dashboard/server.py owner_request and hooks/web-control.ts isOwnerRequest:
# one shared accept/refuse table, tests/owner-request-cases.ts.
def owner_request(request):
    return (
        set(request)
        == {
            "session_id",
            "request_id",
            "action",
            "repo",
            "pull",
            "head",
            "base",
            "confirmation_id",
        }
        and isinstance(request["session_id"], str)
        and SESSION.fullmatch(request["session_id"]) is not None
        and isinstance(request["request_id"], str)
        and re.fullmatch(r"[0-9a-f]{32}", request["request_id"]) is not None
        and request["action"] in ("prepare", "confirm", "cancel")
        and isinstance(request["repo"], str)
        and re.fullmatch(
            r"[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}", request["repo"]
        )
        is not None
        and type(request["pull"]) is int
        and 0 < request["pull"] <= 9007199254740991
        and isinstance(request["head"], str)
        and re.fullmatch(r"[a-fA-F0-9]{40,64}", request["head"]) is not None
        and isinstance(request["base"], str)
        and 0 < len(request["base"]) <= 256
        and not re.search(r"[\x00-\x20\x7f]", request["base"])
        and isinstance(request["confirmation_id"], str)
        and len(request["confirmation_id"]) <= 200
        and (
            request["confirmation_id"] == ""
            if request["action"] == "prepare"
            else bool(request["confirmation_id"])
        )
    )


def private(path, directory=False):
    held = os.lstat(path)
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    return (
        kind(held.st_mode)
        and held.st_uid == os.getuid()
        and stat.S_IMODE(held.st_mode) == (0o700 if directory else 0o600)
        and (directory or held.st_nlink == 1)
    )


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def one(self, name):
        values = self.headers.get_all(name) or []
        return values[0] if len(values) == 1 else None

    def setup(self):
        self.request.settimeout(READ_S)
        super().setup()
        self.deadline = threading.Timer(READ_S, self.expire)
        self.deadline.daemon = True
        self.deadline.start()

    def expire(self):
        with contextlib.suppress(OSError):
            self.request.shutdown(socket.SHUT_RD)

    def finish(self):
        self.deadline.cancel()
        super().finish()

    def send_error(self, code, message=None, explain=None):
        self.reply(code, "bad_request")

    def reply(self, status, outcome):
        body = json.dumps({"outcome": outcome}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def do_POST(self):
        owner = self.path == "/v1/owner"
        if self.path not in ("/v1/refresh", "/v1/owner"):
            return self.reply(404, "not_found")
        auth = self.one("Authorization")
        if not isinstance(auth, str) or not hmac.compare_digest(
            auth.encode(), f"Bearer {self.server.token}".encode()
        ):
            return self.reply(401, "unauthorized")
        if self.one("Content-Type") != "application/json":
            return self.reply(415, "unsupported_media_type")
        length = self.one("Content-Length")
        if self.headers.get_all("Transfer-Encoding") or not length:
            return self.reply(411, "length_required")
        if not re.fullmatch(r"[0-9]{1,6}", length):
            return self.reply(400, "bad_request")
        if int(length) > (MAX_BODY if owner else 128):
            return self.reply(413, "too_large")
        try:
            raw = self.rfile.read(int(length))
            if len(raw) != int(length):
                return self.reply(408, "timeout")
            request = strict_json(raw)
        except (ValueError, OSError):
            return self.reply(400, "bad_request")
        finally:
            self.deadline.cancel()
        if (
            not isinstance(request, dict)
            or (not owner and set(request) != {"session_id"})
            or (owner and not owner_request(request))
        ):
            return self.reply(400, "bad_request")
        if owner and not self.server.owner:
            return self.reply(403, "disabled")
        if request["session_id"] != self.server.session:
            return self.reply(410, "gone")
        if not self.server.refresh.acquire(blocking=False):
            return self.reply(503, "busy")
        request_id = request["request_id"] if owner else secrets.token_hex(16)
        outcomes = OWNER_OUTCOMES if owner else OUTCOMES
        result = self.server.results / f"{request_id}.json"
        try:
            fd = os.open(
                result, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
            )
            os.close(fd)
            print(
                json.dumps(
                    {**request, "type": "owner"}
                    if owner
                    else {
                        "type": "refresh",
                        "session_id": self.server.session,
                        "request_id": request_id,
                    }
                ),
                flush=True,
            )
            deadline = time.monotonic() + WAIT_S
            while not self.server.stopped.is_set() and time.monotonic() < deadline:
                try:
                    fd = os.open(result, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                    try:
                        held = os.fstat(fd)
                        raw = os.read(fd, MAX_RESULT + 1)
                    finally:
                        os.close(fd)
                    if (
                        stat.S_ISREG(held.st_mode)
                        and held.st_uid == os.getuid()
                        and held.st_nlink == 1
                        and len(raw) <= MAX_RESULT
                    ):
                        reply = strict_json(raw)
                        if (
                            isinstance(reply, dict)
                            and set(reply) == {"request_id", "outcome"}
                            and reply["request_id"] == request_id
                            and isinstance(reply["outcome"], str)
                            and reply["outcome"] in outcomes
                        ):
                            return self.reply(
                                outcomes[reply["outcome"]], reply["outcome"]
                            )
                except (OSError, ValueError):
                    pass
                self.server.stopped.wait(0.02)
            self.reply(
                410 if self.server.stopped.is_set() else 504,
                "gone"
                if self.server.stopped.is_set()
                else "owner_timeout"
                if owner
                else "refresh_timeout",
            )
        finally:
            result.unlink(missing_ok=True)
            self.server.refresh.release()


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = 4

    def process_request(self, request, client_address):
        if not self.connections.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.connections.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connections.release()

    def handle_error(self, *_):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", required=True)
    parser.add_argument("--owner", action="store_true")
    args = parser.parse_args()
    session = args.session
    if not SESSION.fullmatch(session):
        raise SystemExit("progress control: expected a canonical UUID session")
    configured = os.environ.get("CLAUDE_CONFIG_DIR")
    profile = (Path(configured) if configured else Path.home() / ".claude").resolve(
        strict=True
    )
    if not stat.S_ISDIR(profile.stat().st_mode) or profile.stat().st_uid != os.getuid():
        raise SystemExit("progress control: profile is not an owned directory")
    base = profile / "progress-endpoint"
    with contextlib.suppress(FileExistsError):
        base.mkdir(mode=0o700)
    if not private(base, directory=True):
        raise SystemExit("progress control: endpoint directory must be private (0700)")
    lock = base / f"{session}.lock"
    lock_fd = os.open(
        lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600
    )
    if not private(lock):
        raise SystemExit("progress control: lock must be a private owned file")
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit(
            "progress control: this session already has a listener"
        ) from None
    token = secrets.token_urlsafe(32)
    path = base / f"{os.getpid()}.sock"
    if len(os.fsencode(path)) > 103:
        raise SystemExit("progress control: profile socket path is too long")
    results = base / f"{os.getpid()}-{secrets.token_hex(8)}.results"
    results.mkdir(mode=0o700)
    entry = base / f"{session}.json"
    temporary = base / f".{session}.{os.getpid()}.tmp"
    parent = os.getppid()
    server = None
    try:
        server = Server(str(path), Handler)
        os.chmod(path, 0o600)
        server.session, server.token, server.results = session, token, results
        server.owner = args.owner
        server.refresh = threading.Lock()
        server.connections = threading.BoundedSemaphore(4)
        server.stopped = threading.Event()
        server.timeout = 0.2
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, lambda *_: server.stopped.set())
        fd = os.open(
            temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
        )
        try:
            os.write(
                fd,
                json.dumps(
                    {
                        "format": 1,
                        "session_id": session,
                        "socket": str(path),
                        "token": token,
                    }
                ).encode(),
            )
        finally:
            os.close(fd)
        os.replace(temporary, entry)
        print(
            json.dumps(
                {"type": "ready", "session_id": session, "results": str(results)}
            ),
            flush=True,
        )
        while (
            not server.stopped.is_set()
            and os.getppid() == parent
            and not (results / "stop").exists()
        ):
            server.handle_request()
    finally:
        if server is not None:
            server.stopped.set()
            server.server_close()
        temporary.unlink(missing_ok=True)
        entry.unlink(missing_ok=True)
        path.unlink(missing_ok=True)
        shutil.rmtree(results)
        os.close(lock_fd)
        # Keep the lock inode: removing it would allow two independent holders.


if __name__ == "__main__":
    try:
        main()
    except OSError:
        raise SystemExit("progress control: local listener could not start") from None
