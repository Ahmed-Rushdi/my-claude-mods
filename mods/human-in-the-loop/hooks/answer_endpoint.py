"""The answer endpoint of the human-in-the-loop fork: one per session, on a Unix socket.

The session's mod starts it (`python3 -I answer_endpoint.py --session=<id>`) and reads
what it prints: a `ready` line, then one JSON line per request that passed every check
here. The mod applies each as a press in the My tasks pane would and writes the outcome
to `<results>/<request_id>.json`, which this process reads, deletes and sends back to
the caller. The caller's contract is in README.md, "Answer endpoint".

The socket (0600) and the entry naming it lie in a 0700 directory of the profile, so
only this user reaches either: no other user can connect, or bind the name of a
listener that died. Standard library only. Nothing is logged: not the token, not a
request, not an answer.
"""

import argparse
import contextlib
import hashlib
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
import sys
import threading
import time
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler
from pathlib import Path

DIR_NAME = "hitl-endpoint"
"""Under the profile: one `<session_id>.json` entry per running listener, naming its
socket `<pid>.sock`, and its results directory."""
ENTRY_FORMAT = 2
"""2: the entry names a Unix socket (`socket`); 1 named a TCP port on 127.0.0.1."""
ANSWER_PATH = "/v1/answer"

MAX_BODY = 131072
"""The largest body read, in bytes; a longer one is refused before it is read."""
READ_DEADLINE_S = 5.0
"""From the connection's start: a request not read whole by then is cut off (408)."""
MAX_CONNECTIONS = 8
"""Connections handled at once; one more is told to come back (503) and closed."""
DRAIN_S = 0.25
"""After the answer, how long what the caller still sends is read away before the close."""
RESULT_WAIT_S = 15.0
"""How long a request waits for the session's answer before it is told to retry."""
REMEMBERED = 1024
"""Requests remembered by request_id, so a duplicate gets the first result."""
PENDING_KEEP_S = 120.0
"""A request the session never answered is handed to it again after this long."""
POLL_S = 0.02
"""How often the results directory, the stop file and the parent are looked at."""
MAX_RESULT_BYTES = 65536
MAX_SOCKET_PATH = 103
"""The longest socket path, in bytes, every POSIX system binds (macOS: 104 with its NUL)."""

REQUIRED = ("request_id", "session_id", "task_id", "created_ms", "version", "action")
TEXTS = ("option", "text", "reason")
ACTIONS = {
    "done": ((), ()),
    "choose": (("option",), ()),
    "answer": (("text",), ()),
    "reject": ((), ("reason",)),
    "archive": ((), ()),
    "restore": ((), ()),
}
"""Each action's text fields: those it needs, and those it may carry."""
SOURCES = ("endpoint", "phone")
REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{16,64}")
SESSION_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
MAX_SAFE = 2**53 - 1
"""The largest whole number JSON carries exactly to the mod."""
LENGTH = re.compile(r"[0-9]{1,9}")

OUTCOME_STATUS = {
    "accepted": 200,
    "unknown": 404,
    "stale": 409,
    "closed": 409,
    "gone": 410,
    "refused": 422,
    "busy": 503,
    "reused": 409,
}
"""The outcomes the mod writes, and the status each is sent with. The mod remembers
request_ids across listener restarts, so it can say `reused` too."""
TASK_FIELDS = {
    "session_id": str,
    "id": int,
    "created_ms": int,
    "version": int,
    "state": str,
}
STATES = ("open", "done", "rejected", "withdrawn")


def answer(status: int, outcome: str, message: str = "") -> tuple[int, dict]:
    return status, {"outcome": outcome, **({"message": message} if message else {})}


UNAUTHORIZED = answer(401, "unauthorized")
LATE = answer(408, "timeout", "The request was not received in time.")
GONE = answer(410, "gone", "The session has ended.")
OTHER_SESSION = answer(410, "gone", "This endpoint is another session's.")
REUSED = answer(409, "reused", "This request_id was used for another request.")
SECRET = answer(
    422,
    "refused",
    "text looks like a secret, so it was not sent: put it where it belongs, then send done.",
)
"""The session's own words for it (endpoint.ts `patchOf`)."""
PENDING = answer(
    503,
    "pending",
    "The session has not answered yet: send the same request (same request_id) again.",
)
_busy = b'{"outcome":"busy","message":"Too many requests at once."}'
BUSY = (
    b"HTTP/1.0 503 Service Unavailable\r\nContent-Type: application/json\r\n"
    b"Cache-Control: no-store\r\nConnection: close\r\n"
    b"Content-Length: %d\r\n\r\n%s" % (len(_busy), _busy)
)


def profile_dir() -> Path:
    configured = os.environ.get("CLAUDE_CONFIG_DIR", "")
    return Path(configured) if configured else Path.home() / ".claude"


def private_dir(path: Path) -> Path:
    """`path` as a directory only this user reaches (0700), made if missing; refuses a
    link or a directory another user owns."""
    with contextlib.suppress(FileExistsError):
        os.mkdir(path, 0o700)
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
        raise SystemExit(f"{DIR_NAME}: not a private directory")
    if stat.S_IMODE(st.st_mode) != 0o700:
        os.chmod(path, 0o700)
    return path


def write_private(path: Path, text: str) -> None:
    """Writes `text` to `path` as a 0600 file, in one rename: a reader sees old or new."""
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.unlink(missing_ok=True)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, text.encode())
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, path)


def is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def is_refused(path: Path) -> bool:
    """Whether a connect to the socket at `path` is refused, so no process listens on it.
    Anything else (it answers, it is slow, it is no socket) counts as held."""
    if not stat.S_ISSOCK(os.lstat(path).st_mode):
        return False
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.5)
        try:
            probe.connect(str(path))
        except ConnectionRefusedError:
            return True
        except OSError:
            return False
    return False


def sweep(base: Path) -> None:
    """Takes away what listeners that died without cleaning up left (killed outright, a
    power cut): entries, results directories and half-written entries whose pid is dead,
    entries that do not parse, and sockets whose pid is dead and that refuse a connect (a
    socket some process still listens on stays). A stale entry's token was that
    listener's alone, and its socket leads nowhere."""
    for path in base.iterdir():
        name = path.name
        try:
            if name.endswith(".sock"):
                pid = int(name.removesuffix(".sock"))
                if not is_alive(pid) and is_refused(path):
                    path.unlink(missing_ok=True)
            elif name.endswith(".results") and path.is_dir() and not path.is_symlink():
                pid = int(name.removesuffix(".results").rsplit(".", 1)[1])
                if not is_alive(pid):
                    shutil.rmtree(path, ignore_errors=True)
            elif name.startswith(".") and name.endswith(".tmp"):
                pid = int(name.removesuffix(".tmp").rsplit(".", 1)[1])
                if not is_alive(pid):
                    path.unlink(missing_ok=True)
            elif name.endswith(".json"):
                try:
                    pid = json.loads(path.read_text()).get("pid")
                except (OSError, ValueError, AttributeError):
                    pid = None
                if type(pid) is not int or not is_alive(pid):
                    path.unlink(missing_ok=True)
        except (ValueError, IndexError, OSError, OverflowError):
            # OverflowError: a pid too large for the system (os.kill) is passed over.
            continue


def strict_json(raw: bytes):
    """`raw` as UTF-8 JSON with no repeated key and no NaN or Infinity; else ValueError."""

    def pairs(items):
        if len({key for key, _ in items}) != len(items):
            raise ValueError("repeated key")
        return dict(items)

    def constant(name):
        raise ValueError("not JSON")

    try:
        return json.loads(
            raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant
        )
    except RecursionError:
        raise ValueError("nested too deep") from None


def is_text(value) -> bool:
    """A string with no lone surrogate (which no UTF-8 holds)."""
    return isinstance(value, str) and not any(0xD800 <= ord(c) <= 0xDFFF for c in value)


def shape_error(request) -> str | None:
    """What is wrong with an answer request's shape, naming the field and never what it
    held; None when it is one."""
    if not isinstance(request, dict):
        return "The body must be a JSON object."
    if any(key not in (*REQUIRED, *TEXTS, "source") for key in request):
        return "The body has a field this endpoint does not take."
    for key in REQUIRED:
        if key not in request:
            return f"{key} is missing."
    for key, pattern, rule in (
        ("request_id", REQUEST_ID, "16 to 64"),
        ("session_id", SESSION_ID, "1 to 64"),
    ):
        if not isinstance(request[key], str) or not pattern.fullmatch(request[key]):
            return f"{key} must be {rule} letters, digits, - or _."
    for key, low in (("task_id", 1), ("created_ms", 0), ("version", 0)):
        if type(request[key]) is not int or not low <= request[key] <= MAX_SAFE:
            return f"{key} must be a whole number from {low} to 2^53-1."
    action = request["action"]
    # A list or an object is no key of ACTIONS (and cannot be looked up in it).
    if not isinstance(action, str) or action not in ACTIONS:
        return "action must be done, choose, answer, reject, archive or restore."
    needed, optional = ACTIONS[action]
    for key in TEXTS:
        if key in needed and key not in request:
            return f"{key} is required for {action}."
        if key in request and key not in needed and key not in optional:
            return f"{key} does not go with {action}."
        if key in request and not is_text(request[key]):
            return f"{key} must be text."
    if "source" in request and request["source"] not in SOURCES:
        return "source must be endpoint or phone."
    return None


SECRET_SHAPES = tuple(
    re.compile(shape, re.ASCII)
    for shape in (
        r"\bsk_(live|test)_[0-9A-Za-z]{10,}",
        r"\bsk-ant-[\w-]{10,}",
        r"\bsk-[A-Za-z0-9_-]{20,}",
        r"\bA(KIA|SIA)[0-9A-Z]{16}\b",
        r"\bgh[pousr]_[A-Za-z0-9]{30,}",
        r"\bgithub_pat_[A-Za-z0-9_]{30,}",
        r"\bxox[abprs]-[\w-]{10,}",
        r"\bAIza[\w-]{30,}",
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
        r"\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}",
    )
)
LONG_TOKEN = re.compile(r"[A-Za-z0-9+/_=-]{32,}")


def looks_secret(text: str) -> bool:
    """tasks.ts `looksSecret`, which the session applies again: a known key shape, or a
    long token mixing upper case, lower case and digits (a git hash, all lower case hex,
    is not one). Here, such an answer is refused before it is printed to the session; a
    test keeps the two lists alike. ASCII classes, as in JavaScript without the u flag."""
    if any(shape.search(text) for shape in SECRET_SHAPES):
        return True
    return any(
        re.search("[a-z]", token)
        and re.search("[A-Z]", token)
        and re.search("[0-9]", token)
        for token in LONG_TOKEN.findall(text)
    )


def payload_of(result, request_id: str):
    """(status, body) from a result file the mod wrote for `request_id`, keeping only the
    fields the contract names; None for anything else."""
    if not isinstance(result, dict) or result.get("request_id") != request_id:
        return None
    outcome = result.get("outcome")
    if outcome not in OUTCOME_STATUS:
        return None
    payload = {"outcome": outcome}
    if isinstance(result.get("message"), str):
        payload["message"] = result["message"][:500]
    task = result.get("task")
    if (
        isinstance(task, dict)
        and all(type(task.get(key)) is kind for key, kind in TASK_FIELDS.items())
        and task["state"] in STATES
    ):
        payload["task"] = {key: task[key] for key in TASK_FIELDS}
    return OUTCOME_STATUS[outcome], payload


class Pending:
    """A request handed to the mod, known by its digest: its result once the mod wrote it."""

    def __init__(self, digest: str):
        self.digest = digest
        self.started = time.monotonic()
        self.done = threading.Event()
        self.status = 0
        self.payload: dict = {}

    def is_abandoned(self) -> bool:
        return (
            not self.done.is_set() and time.monotonic() - self.started > PENDING_KEEP_S
        )


def digest_of(request: dict) -> str:
    text = json.dumps(request, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(text.encode()).hexdigest()


class Endpoint:
    """One session's endpoint: its token, its entry, its results directory, and the lines
    it hands the mod."""

    def __init__(self, session_id: str, base: Path):
        self.session_id = session_id
        self.base = base
        self.pid = os.getpid()
        self.parent = os.getppid()
        self.token = secrets.token_urlsafe(32)
        self.entry = base / f"{session_id}.json"
        # Named by the pid, not the session: short (a socket's path runs to about 100
        # bytes), and a second listener of one session never needs the first one's name.
        self.socket = base / f"{self.pid}.sock"
        self.results = private_dir(base / f"{session_id}.{self.pid}.results")
        self.stopping = threading.Event()
        self.out_lock = threading.Lock()
        self.lock = threading.Lock()
        self.known: OrderedDict[str, Pending] = OrderedDict()
        self.server: Server | None = None

    def publish(self) -> None:
        entry = {
            "format": ENTRY_FORMAT,
            "session_id": self.session_id,
            "pid": self.pid,
            "socket": str(self.socket),
            "token": self.token,
            "started_ms": int(time.time() * 1000),
        }
        write_private(self.entry, json.dumps(entry))

    def emit(self, line: dict) -> bool:
        """Hands the mod one line; False once nothing reads them any more."""
        text = json.dumps(line, ensure_ascii=True, separators=(",", ":")) + "\n"
        try:
            with self.out_lock:
                sys.stdout.write(text)
                sys.stdout.flush()
        except (OSError, ValueError):
            # What could not be written goes nowhere, so the exit's own flush succeeds.
            with contextlib.suppress(OSError, ValueError):
                null = os.open(os.devnull, os.O_WRONLY)
                os.dup2(null, sys.stdout.fileno())
                os.close(null)
            self.stop()
            return False
        return True

    def submit(self, request: dict) -> tuple[int, dict]:
        """Hands the mod `request` once, and waits for its result. A duplicate (the same
        request_id and request) waits for or replays the first result and is never handed
        on; the same request_id with another request is refused."""
        request_id, digest = request["request_id"], digest_of(request)
        with self.lock:
            entry = self.known.get(request_id)
            is_first = entry is None or entry.is_abandoned()
            if is_first:
                entry = self.known[request_id] = Pending(digest)
                while len(self.known) > REMEMBERED:
                    self.known.popitem(last=False)
            else:
                self.known.move_to_end(request_id)
        if entry.digest != digest:
            return REUSED
        if is_first and not self.emit({"type": "answer", **request}):
            return GONE
        if not entry.done.wait(RESULT_WAIT_S):
            return PENDING
        return entry.status, entry.payload if is_first else {
            **entry.payload,
            "duplicate": True,
        }

    def watch(self) -> None:
        """Collects the mod's results; ends the endpoint when the mod writes `stop`, the
        session's process is gone, or its results directory or entry was taken away (a
        session in another pid namespace takes this pid for dead and sweeps them): the
        session's heartbeat then starts another listener."""
        while not self.stopping.is_set():
            try:
                names = os.listdir(self.results)
            except (FileNotFoundError, NotADirectoryError):
                names = None
            except OSError:
                names = []  # failed this once (out of descriptors, say): the next look reads it
            if (
                names is None
                or "stop" in names
                or os.getppid() != self.parent
                or not os.path.lexists(self.entry)
            ):
                self.stop()
                return
            for name in names:
                if name.endswith(".json"):
                    self.collect(name.removesuffix(".json"))
            time.sleep(POLL_S)

    # TODO(deferred): #138 the listener remembers a gone answer (R3-4); see also #141
    def collect(self, request_id: str) -> None:
        path = self.results / f"{request_id}.json"
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, "rb") as file:
                result = json.loads(file.read(MAX_RESULT_BYTES))
        except (OSError, ValueError):
            return  # half written: the next look reads it whole
        path.unlink(missing_ok=True)
        answered = payload_of(result, request_id)
        with self.lock:
            entry = self.known.get(request_id)
            # A session too busy for it now takes the same request when it comes again.
            if entry is not None and answered is not None and answered[0] == 503:
                del self.known[request_id]
        if entry is not None and answered is not None:
            entry.status, entry.payload = answered
            entry.done.set()

    def stop(self) -> None:
        if self.stopping.is_set():
            return
        self.stopping.set()
        if self.server is not None:
            threading.Thread(target=self.server.shutdown, daemon=True).start()

    def cleanup(self, is_listening: bool) -> None:
        """Takes the entry out (unless a later listener of the same session wrote its
        own), the results directory, and the socket when this process bound it."""
        try:
            if json.loads(self.entry.read_text()).get("pid") == self.pid:
                self.entry.unlink(missing_ok=True)
        except (OSError, ValueError):
            pass
        if is_listening:
            self.socket.unlink(missing_ok=True)
        shutil.rmtree(self.results, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    server: "Server"
    server_version = "hitl-endpoint"
    timeout = READ_DEADLINE_S

    def version_string(self):
        return self.server_version

    def log_message(self, format, *args):
        """Nothing is logged."""

    def setup(self):
        super().setup()
        self.is_late = False
        self.deadline = threading.Timer(READ_DEADLINE_S, self.cut)
        self.deadline.daemon = True
        self.deadline.start()

    def cut(self):
        """The request was not read in time: what is left of it reads as its end."""
        self.is_late = True
        with contextlib.suppress(OSError):
            self.connection.shutdown(socket.SHUT_RD)

    def finish(self):
        self.deadline.cancel()
        super().finish()

    def send_error(self, code, message=None, explain=None):
        """http.server's own refusals (a malformed request line, headers too long or too
        many), as JSON that repeats nothing of the request."""
        outcome = {408: "timeout", 414: "too_large", 431: "too_large"}.get(
            code, "bad_request"
        )
        self.reply(code, {"outcome": outcome})

    def __getattr__(self, name):
        # Every method but POST (OPTIONS, a preflight, among them) is refused alike;
        # http.server would answer one it has no `do_` for with a 501 page.
        if name.startswith("do_"):
            return self.refuse_method
        raise AttributeError(name)

    def refuse_method(self):
        status, payload = answer(405, "method_not_allowed", "Only POST is answered.")
        self.reply(status, payload, (("Allow", "POST"),))

    def do_POST(self):
        self.reply(*self.judge())

    def judge(self) -> tuple[int, dict]:
        """What a POST gets: a refusal, or the session's answer."""
        endpoint = self.server.endpoint
        if self.is_late:
            return LATE
        # No browser reaches a Unix socket; a request a proxy forwards from a web page
        # carries an Origin, and is refused. (Any Host is taken: there is no name here
        # for a page to rebind.)
        if self.headers.get_all("Origin"):
            return answer(403, "forbidden", "A request from a web page is refused.")
        if not self.is_authorized(endpoint.token):
            return UNAUTHORIZED
        if self.path != ANSWER_PATH:
            return answer(404, "not_found", f"POST {ANSWER_PATH} is the only path.")
        if not self.is_json():
            return answer(
                415, "unsupported_media_type", "Content-Type must be application/json."
            )
        raw, refusal = self.read_body()
        if refusal is not None:
            return refusal
        try:
            request = strict_json(raw)
        except ValueError:
            return answer(
                400, "bad_request", "The body is not one JSON object in UTF-8."
            )
        error = shape_error(request)
        if error is not None:
            return answer(400, "bad_request", error)
        if request["session_id"] != endpoint.session_id:
            return OTHER_SESSION
        if request["action"] == "answer" and looks_secret(request["text"]):
            return SECRET
        return endpoint.submit(request)

    def is_json(self) -> bool:
        """One Content-Type header: application/json, with no parameter but charset=utf-8.
        A form or text/plain body, which a page may send without asking first, is not one."""
        values = self.headers.get_all("Content-Type") or []
        if len(values) != 1:
            return False
        media, _, params = values[0].partition(";")
        charset = params.replace(" ", "").lower()
        return media.strip().lower() == "application/json" and charset in (
            "",
            "charset=utf-8",
        )

    def is_authorized(self, token: str) -> bool:
        """One `Authorization: Bearer <token>` header holding this endpoint's token,
        compared in constant time."""
        values = self.headers.get_all("Authorization") or []
        if len(values) != 1:
            return False
        scheme, _, given = values[0].strip().partition(" ")
        is_same = hmac.compare_digest(given.strip().encode(), token.encode())
        return scheme.lower() == "bearer" and is_same

    def read_body(self) -> tuple[bytes, tuple | None]:
        """The body, by one plain Content-Length up to MAX_BODY, read before the deadline;
        or the refusal (status, payload)."""
        lengths = self.headers.get_all("Content-Length") or []
        if self.headers.get_all("Transfer-Encoding"):
            if lengths:
                return b"", answer(400, "bad_request", "Send Content-Length alone.")
            return b"", answer(411, "length_required", "Content-Length is required.")
        if not lengths:
            return b"", answer(411, "length_required", "Content-Length is required.")
        if len(lengths) != 1 or not LENGTH.fullmatch(lengths[0].strip()):
            return b"", answer(
                400, "bad_request", "Content-Length must be one plain number."
            )
        length = int(lengths[0])
        if length > MAX_BODY:
            return b"", answer(413, "too_large", f"The body may hold {MAX_BODY} bytes.")
        data = bytearray()
        with contextlib.suppress(OSError):
            while len(data) < length and (
                chunk := self.rfile.read1(length - len(data))
            ):
                data += chunk
        self.deadline.cancel()
        if len(data) < length or self.is_late:
            return b"", LATE
        return bytes(data), None

    def reply(self, status: int, payload: dict, headers: tuple = ()) -> None:
        data = json.dumps(payload, separators=(",", ":")).encode()
        self.close_connection = True
        self.send_response(status)
        for name, value in (
            ("Content-Type", "application/json"),
            ("Content-Length", str(len(data))),
            ("Cache-Control", "no-store"),
            ("X-Content-Type-Options", "nosniff"),
            ("Connection", "close"),
            *headers,
        ):
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    # A Unix socket whose queue of connections not yet accepted is full refuses a
    # non-blocking connect at once (curl's), where TCP would wait: room for a burst.
    request_queue_size = 64

    def __init__(self, endpoint: Endpoint):
        self.endpoint = endpoint
        self.slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
        super().__init__(str(endpoint.socket), Handler)

    def server_bind(self):
        """Binds the socket 0600 from its first moment (the umask), at a name only a dead
        listener can have left: one that refuses a connect is taken away, one that answers
        stops this listener."""
        path = self.endpoint.socket
        if len(os.fsencode(path)) > MAX_SOCKET_PATH:
            raise SystemExit(
                f"{DIR_NAME}: the socket path is too long ({len(os.fsencode(path))} bytes,"
                f" at most {MAX_SOCKET_PATH}): use a shorter CLAUDE_CONFIG_DIR"
            )
        if os.path.lexists(path):
            if not is_refused(path):
                raise SystemExit(f"{DIR_NAME}: {path.name} is held by another process")
            path.unlink()
        mask = os.umask(0o177)
        try:
            super().server_bind()
        finally:
            os.umask(mask)
        os.chmod(path, 0o600)

    def process_request(self, request, client_address):
        # This runs on the accepting thread: a connection turned away is told so and
        # closed, never read from or waited on, so no client can hold this thread.
        if not self.slots.acquire(blocking=False):
            with contextlib.suppress(OSError):
                request.setblocking(False)
                request.send(BUSY)
            self.close_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def shutdown_request(self, request):
        """Closes a connection once the caller has the answer: what it sent and was never
        read (a body refused unread) is read away first, so the close resets nothing, for
        DRAIN_S at most in all: a client that keeps sending gets its connection closed."""
        with contextlib.suppress(OSError):
            request.shutdown(socket.SHUT_WR)
            end = time.monotonic() + DRAIN_S
            left = 2 * MAX_BODY
            while left > 0 and (wait := end - time.monotonic()) > 0:
                request.settimeout(wait)
                if not (chunk := request.recv(65536)):
                    break
                left -= len(chunk)
        self.close_request(request)

    def handle_error(self, request, client_address):
        """A request that failed is dropped; nothing is printed (no traceback, no path)."""


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--session", required=True)
    args = parser.parse_args(argv)
    if not SESSION_ID.fullmatch(args.session):
        print(f"{DIR_NAME}: --session takes letters, digits, - and _", file=sys.stderr)
        return 2

    profile = profile_dir()
    profile.mkdir(mode=0o700, parents=True, exist_ok=True)
    base = private_dir(profile / DIR_NAME)
    sweep(base)
    endpoint = Endpoint(args.session, base)
    try:
        server = Server(endpoint)
    except OSError as error:
        endpoint.cleanup(is_listening=False)
        raise SystemExit(f"{DIR_NAME}: cannot listen: {error.strerror}") from None
    except BaseException:
        endpoint.cleanup(is_listening=False)
        raise
    endpoint.server = server

    def leave(signum, frame):
        raise SystemExit(0)

    for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(signum, leave)

    try:
        endpoint.publish()
        endpoint.emit({"type": "ready", "results": str(endpoint.results)})
        threading.Thread(target=endpoint.watch, daemon=True).start()
        server.serve_forever(poll_interval=0.2)
    finally:
        endpoint.cleanup(is_listening=True)
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
