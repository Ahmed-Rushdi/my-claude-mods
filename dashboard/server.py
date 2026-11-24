"""The dashboard (#104): open human-in-the-loop tasks and the progress mod's stored state.
Default: a Unix socket for `tailscale serve`. With --local: direct authenticated HTTP
on 127.0.0.1 for a local browser or T3 pane, without Tailscale.

It reads the plugins' store files and never writes one. Read README.md (next to this file) for
how to run it and what it guards against. Standard library only.
"""

import argparse
import contextlib
import fcntl
import hashlib
import hmac
import html
import http.client
import importlib.util
import json
import math
import os
import queue
import re
import secrets
import select
import signal
import socket
import socketserver
import stat
import subprocess
import sys
import threading
import time
import tomllib
import urllib.parse
from http.server import BaseHTTPRequestHandler
from pathlib import Path

NAME = "dashboard"
PORT = 6767
"""The tailnet port `tailscale serve` exposes the socket on (owner, 2026-11-17)."""
SOCKET_NAME = "dashboard.sock"
LOCK_NAME = "dashboard.lock"
"""Held (flock) by the server for its whole life, before it touches the socket's path."""
MAX_SOCKET_PATH = 103
"""The longest socket path, in bytes, every POSIX system binds."""
DEFAULT_PIN = "1337"
"""The PIN when the config names none (owner decision, issue #104, 2026-11-18)."""
CONFIG_KEYS = ("pin", "hosts", "profiles")
TAILSCALE_STATUS = ("tailscale", "status", "--json")
"""The one Tailscale command the server runs, once, at start: found on PATH, run with no shell,
holding nothing anyone sent. It names the user this machine is logged in as (owner decision,
2026-11-19: the login is not kept in the config)."""
TAILSCALE_TIMEOUT_S = 5.0
"""How long that command may take before the server gives up starting."""
TERMINATING = (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)
"""The signals that stop the server (`main`'s handlers, installed before anything runs)."""
MAX_STATUS_BYTES = 8 << 20
"""The most of the status the server reads: some 2 KB a device, so a tailnet of about 4,000
devices (one of 3 devices prints 6.4 KB). Past it the server does not start."""
STOP_CHECK_S = 0.05
"""While the Tailscale command runs, how often a held-back stop signal is looked for."""
TAILSCALE_STATES = (
    "NoState",
    "InUseOtherUser",
    "NeedsLogin",
    "NeedsMachineAuth",
    "Stopped",
    "Starting",
    "Running",
)
"""The states Tailscale defines (ipn/backend.go, stateStrings, 1.104.5): the only status
values a refusal names. Any other value is shown as `unknown`, since the status is not ours
to print (a login or a secret could sit where the state should be)."""
SERVE_HOST = "localhost"
"""The Host Tailscale Serve sends to a `unix:` target (ipn/ipnlocal/serve.go, 1.104.5): the
browser's own host comes in X-Forwarded-Host, which Serve sets, replacing what was sent."""
READ_DEADLINE_S = 5.0
"""From the connection's start: a request not read whole by then is cut off (408)."""
MAX_CONNECTIONS = 16
"""Connections handled at once; one more is told to come back (503) and closed."""
DRAIN_S = 0.25
"""After the answer, how long what the caller still sends is read away before the close."""
MAX_BODY = 65536
"""The largest body read, in bytes; a longer one is refused before it is read."""
MAX_HEADERS = 48
"""Headers a request may carry (a phone's browser sends about 15, Tailscale Serve adds 8)."""
MAX_HEAD_BYTES = 16384
"""The request line and headers together, in bytes."""

MAX_STORE_BYTES = 2 * 1024 * 1024
"""A store file larger than this is skipped, not read."""
MAX_STORE_FILES = 32
"""Store files one read of the tasks (or of the progress) takes; the rest are skipped."""
MAX_READ_BYTES = 8 * 1024 * 1024
"""Bytes of store files one read takes, by their sizes when listed; the rest are skipped."""
STALE_MS = 3 * 60_000
"""A session not seen for this long is quiet (the fork's `STALE_MS`)."""
MAX_SAFE = 2**53 - 1
"""The largest whole number JSON carries exactly between the mod and the endpoint."""
SESSION_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
"""A session id as the answer endpoint takes it; anything else is never put in a path."""
KINDS = ("do", "answer", "choose")
HITL_STORE = "human-in-the-loop_"
"""The task store's name starts so: `human-in-the-loop_<marketplace>-<hash>.json`, the
marketplace being `human-in-the-loop` for the upstream plugin and `local` for the fork."""
PROGRESS_STORE = "progress_"
"""The progress mod's store: `progress_<marketplace>-<hash>.json` (`local`, once `inline`)."""


def is_number(value) -> bool:
    """A JSON number that JSON can carry back out: not a bool, not NaN or an infinity."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return isinstance(value, int) or math.isfinite(value)


def is_whole(value, low: int = 0) -> bool:
    """A JSON whole number from `low` to 2^53-1 (not a bool, not a float)."""
    return type(value) is int and low <= value <= MAX_SAFE


def is_numbers(value) -> bool:
    return isinstance(value, list) and all(type(one) is int for one in value)


def read_store(path: Path):
    """The JSON object in the store file at `path`, or None when it is not a regular file of
    at most MAX_STORE_BYTES holding one object in UTF-8. Never follows a link at the last
    step, never waits on a FIFO, never raises."""
    return load_store(path)[0]


def load_store(path: Path):
    """`read_store`'s object or None, and how many bytes of the file were read for it."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return None, 0
    raw = b""
    try:
        held = os.fstat(fd)
        if not stat.S_ISREG(held.st_mode) or held.st_size > MAX_STORE_BYTES:
            return None, 0
        with os.fdopen(fd, "rb", closefd=False) as file:
            raw = file.read(MAX_STORE_BYTES + 1)
        if len(raw) > MAX_STORE_BYTES:
            return None, len(raw)
        data = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError, RecursionError):
        return None, len(raw)
    finally:
        os.close(fd)
    return (data if isinstance(data, dict) else None), len(raw)


def store_dirs(profiles) -> list[tuple[list[str], Path]]:
    """The profiles' `plugins/store/` directories, each once however many profiles reach it
    (the logins may share one through a link), with the label of the profile it belongs to:
    [label] where it is one profile's alone, [] where several share it (such a store cannot
    say which login wrote what)."""
    dirs: dict[tuple[int, int], tuple[list[str], Path]] = {}
    for label, profile in profiles:
        store = Path(profile) / "plugins" / "store"
        try:
            held = os.stat(store)
        except OSError:
            continue
        if stat.S_ISDIR(held.st_mode):
            dirs.setdefault((held.st_dev, held.st_ino), ([], store))[0].append(label)
    return [
        (labels if len(labels) == 1 else [], store) for labels, store in dirs.values()
    ]


def store_files(profiles, prefix: str):
    """Each store file named `<prefix>*.json` in the profiles' store directories (each read
    once, labelled as `store_dirs` says): [(profile labels, its JSON object or None when it
    cannot be read)], and how many names were skipped unread (a link, a FIFO, a directory, a
    file listed over MAX_STORE_BYTES, or past MAX_STORE_FILES or MAX_READ_BYTES). Only bytes
    actually read count towards MAX_READ_BYTES: a file refused unread costs nothing."""
    found: dict[tuple[int, int], tuple[list[str], Path, int]] = {}
    skipped = 0
    for labels, store in store_dirs(profiles):
        try:
            entries = sorted(os.scandir(store), key=str)
        except OSError:
            continue
        for entry in entries:
            if not (entry.name.startswith(prefix) and entry.name.endswith(".json")):
                continue
            try:
                held = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            if not stat.S_ISREG(held.st_mode):
                skipped += 1
                continue
            found.setdefault(
                (held.st_dev, held.st_ino), (labels, Path(entry.path), held.st_size)
            )
    out, total = [], 0
    for labels, path, size in found.values():
        if (
            size > MAX_STORE_BYTES
            or len(out) >= MAX_STORE_FILES
            or total + size > MAX_READ_BYTES
        ):
            skipped += 1
            continue
        data, read = load_store(path)
        total += read
        out.append((labels, data))
    return out, skipped


def task_of(value):
    """A stored task as the fork's `isTask` reads one, with a kind the pane knows and the
    numbers the endpoint takes; None for anything else."""
    if not isinstance(value, dict):
        return None
    if not (
        is_whole(value.get("id"), 1)
        and is_whole(value.get("createdMs"))
        and is_whole(value.get("updatedMs"))
    ):
        return None
    if not all(
        isinstance(value.get(key), str)
        for key in ("title", "why", "kind", "state", "update", "sessionId")
    ):
        return None
    if not all(
        key not in value or isinstance(value[key], str)
        for key in ("doneWhen", "detail", "answer", "reason")
    ):
        return None
    options = value.get("options", [])
    if not (isinstance(options, list) and all(isinstance(o, str) for o in options)):
        return None
    if value["kind"] not in KINDS:
        return None
    # The fork reads a task whose `archivedMs` is not a number as not archived (#187).
    if "archivedMs" in value and not is_whole(value["archivedMs"]):
        value = {key: field for key, field in value.items() if key != "archivedMs"}
    return value


def refs_of(note) -> set[tuple[int, int]]:
    """The tasks a `took` note names, as (id, createdMs)."""
    tasks = note.get("tasks") if isinstance(note, dict) else None
    return {
        (ref["id"], ref["createdMs"])
        for ref in (tasks if isinstance(tasks, list) else [])
        if isinstance(ref, dict)
        and type(ref.get("id")) is int
        and type(ref.get("createdMs")) is int
    }


def is_took(note) -> bool:
    """Whether a stored takeover note is one the fork reads (`tookIn`): an object with a list
    under `tasks` and a number under `atMs`."""
    return (
        isinstance(note, dict)
        and isinstance(note.get("tasks"), list)
        and is_number(note.get("atMs"))
    )


def taken_from(slots: dict) -> tuple[dict[str, set[tuple[int, int]]], int]:
    """By session id, the tasks of that session another session took on and still holds
    (the fork's `gathered` and `stillTaken`): those show under the taker only. And how many
    notes (or `took` values) were not of the fork's shape: those hide nothing."""
    notes: dict[tuple[str, str], dict] = {}
    skipped = 0
    for taker, held in slots.items():
        if "took" not in held:
            continue
        took = held["took"]
        if not isinstance(took, dict):
            skipped += 1
            continue
        for source, note in took.items():
            if is_took(note):
                notes[(taker, source)] = note
            else:
                skipped += 1
    taken: dict[str, set[tuple[int, int]]] = {}
    for (taker, source), note in notes.items():
        if source == taker:
            continue
        refs = refs_of(note)
        back = notes.get((source, taker))
        if back is not None and back["atMs"] > note["atMs"]:
            refs -= refs_of(back)
        taken.setdefault(source, set()).update(refs)
    return taken, skipped


def has_entry(profiles, session_id: str) -> bool:
    """Whether a profile holds an answer endpoint entry for the session (not proof that its
    listener runs: a listener killed outright leaves its entry)."""
    for _, profile in profiles:
        try:
            held = os.lstat(Path(profile) / "hitl-endpoint" / f"{session_id}.json")
        except OSError:
            continue
        if stat.S_ISREG(held.st_mode):
            return True
    return False


def session_state(held: dict, now_ms: int) -> str:
    if is_number(held.get("endedMs")):
        return "ended"
    return "quiet" if now_ms - held["seenMs"] > STALE_MS else "live"


ARCHIVE_KEEP_MS = 7 * 24 * 60 * 60_000
"""How long an archived task stays restorable (the fork's `ARCHIVE_KEEP_MS`, #187)."""


def archived_of(one: dict) -> dict:
    """An archived task's `archived_ms` and `deletes_ms` (when the fork deletes it), or {}
    for a task that is not archived: the page lists those apart, under Archived."""
    if "archivedMs" not in one:
        return {}
    return {
        "archived_ms": one["archivedMs"],
        "deletes_ms": one["archivedMs"] + ARCHIVE_KEEP_MS,
    }


def live_sessions(profiles, slots, now_ms: int) -> dict[str, str]:
    """For each project root of one store, the live session there that has an answer endpoint
    entry, the one seen last (then the lowest id): the session an Archive or Restore of an
    ended session's task there is sent to (#187)."""
    best: dict[str, tuple[int, str]] = {}
    for root, session_id, held in slots:
        if session_state(held, now_ms) != "live" or not has_entry(profiles, session_id):
            continue
        rank = (-held["seenMs"], session_id)
        if root not in best or rank < best[root]:
            best[root] = rank
    return {root: rank[1] for root, rank in best.items()}


def task_slot(key: str, value):
    """`(root, session_id)` of a task-store `tasks:<root>#session:<id>` slot of the fork's
    shape, else None. The one rule for what a slot is, shared by the Tasks tab and the
    progress sessions' state, so a slot the Tasks tab skips never decides a state."""
    root, mark, session_id = key.removeprefix("tasks:").rpartition("#session:")
    if (
        key.startswith("tasks:")
        and mark
        and SESSION_ID.fullmatch(session_id)
        and isinstance(value, dict)
        and isinstance(value.get("tasks"), list)
        and is_number(value.get("seenMs"))
    ):
        return root, session_id
    return None


def read_tasks(profiles, now_ms: int) -> dict:
    """The open tasks of every session in the profiles' task stores, newest first, and how
    many files and entries (slots, tasks, keys of another layout) were skipped. A store is
    untrusted input: what is not of the fork's shape is skipped, never raised."""
    files, skipped_files = store_files(profiles, HITL_STORE)
    skipped_entries = 0
    out = []
    for labels, data in files:
        if data is None:
            skipped_files += 1
            continue
        slots: dict[str, tuple[str, str, dict]] = {}
        for key, value in data.items():
            if not key.startswith("tasks:"):
                continue
            held = task_slot(key, value)
            if held is None:
                skipped_entries += 1
                continue
            slots[key] = (*held, value)
        taken, skipped_notes = taken_from(
            {sid: held for _, sid, held in slots.values()}
        )
        skipped_entries += skipped_notes
        via = live_sessions(profiles, slots.values(), now_ms)
        for root, session_id, held in slots.values():
            state = session_state(held, now_ms)
            for value in held["tasks"]:
                one = task_of(value)
                if one is None:
                    skipped_entries += 1
                    continue
                if one["state"] != "open" or (
                    (one["id"], one["createdMs"]) in taken.get(session_id, ())
                ):
                    continue
                archived = archived_of(one)
                # Archived more than 7 days ago: the session's next store write or load
                # deletes it (the fork's `isExpired`); it is gone from the page already.
                if archived and now_ms > archived["deletes_ms"]:
                    continue
                out.append(
                    {
                        "session_id": session_id,
                        "root": root,
                        "profiles": labels,
                        "session_state": state,
                        "endpoint": has_entry(profiles, session_id),
                        "id": one["id"],
                        "created_ms": one["createdMs"],
                        "version": one["updatedMs"],
                        "title": one["title"],
                        "why": one["why"],
                        "detail": one.get("detail"),
                        "done_when": one.get("doneWhen"),
                        "kind": one["kind"],
                        "options": one.get("options", []),
                        "age_s": max(0, (now_ms - one["createdMs"]) // 1000),
                        **archived,
                        # An ended session's task is archived or restored through a live
                        # session in its project, which takes the ended slot on (#187).
                        **(
                            {"via": via[root]}
                            if state == "ended" and root in via
                            else {}
                        ),
                    }
                )
    out.sort(key=lambda one: (-one["created_ms"], one["session_id"], one["id"]))
    return {
        "tasks": out,
        "skipped": {"files": skipped_files, "entries": skipped_entries},
    }


def goal_of(value):
    """A stored goal (`goal:<session>`) as the progress mod's `keptGoal` reads one."""
    if not (
        isinstance(value, dict)
        and isinstance(value.get("repo"), str)
        and is_numbers(value.get("numbers"))
    ):
        return None
    listed = {
        key: value[key] if is_numbers(value.get(key)) else []
        for key in ("added", "removed")
    }
    return {"repo": value["repo"], "numbers": value["numbers"], **listed}


def review_of(value):
    """A stored review record (`review:<session>`) as `keptReview` reads one: the rounds
    counted per PR as the mod's `roundsOf` counts them, every stored round."""
    if not isinstance(value, dict):
        return None
    rounds, tasked = value.get("rounds"), value.get("tasked")
    if not (
        isinstance(rounds, list)
        and all(
            isinstance(one, dict)
            and type(one.get("pr")) is int
            and isinstance(one.get("key"), str)
            and is_number(one.get("at"))
            for one in rounds
        )
        and is_numbers(tasked)
    ):
        return None
    counts: dict[str, int] = {}
    for one in rounds:
        counts[str(one["pr"])] = counts.get(str(one["pr"]), 0) + 1
    return {
        "repo": value["repo"] if isinstance(value.get("repo"), str) else "",
        "at": value["at"] if is_number(value.get("at")) else None,
        "rounds": counts,
        "tasked": tasked,
    }


def cancelled_of(value):
    """The stored note of a "merge when green" a change of session cancelled."""
    if not (
        isinstance(value, dict)
        and type(value.get("pull")) is int
        and all(
            isinstance(value.get(key), str)
            for key in ("step", "note", "repo", "session")
        )
        and SESSION_ID.fullmatch(value["session"])
    ):
        return None
    return {
        "session_id": value["session"],
        "pull": value["pull"],
        "repo": value["repo"],
        "step": value["step"],
        "note": value["note"],
    }


def is_stamp(value) -> bool:
    return is_number(value) and 0 <= value <= MAX_SAFE


def has_fields(value, *, text=(), counts=(), stamps=(), flags=()) -> bool:
    """Required scalar fields of a published native record, without coercion."""
    return (
        isinstance(value, dict)
        and all(isinstance(value.get(key), str) for key in text)
        and all(is_whole(value.get(key)) for key in counts)
        and all(is_stamp(value.get(key)) for key in stamps)
        and all(type(value.get(key)) is bool for key in flags)
    )


def issue_numbers(value) -> bool:
    return (
        isinstance(value, list)
        and all(is_whole(one, 1) for one in value)
        and len(set(value)) == len(value)
    )


def is_pull(value) -> bool:
    return (
        has_fields(
            value,
            text=("review", "checks", "branch", "head", "base", "repo"),
            flags=("isDraft", "hasConflicts"),
        )
        and is_whole(value.get("number"), 1)
        and value.get("state") in ("OPEN", "MERGED", "CLOSED")
        and all(
            isinstance(value.get(key, ""), str) for key in ("mergedAt", "updatedAt")
        )
    )


def is_ticket(value) -> bool:
    return (
        has_fields(value, text=("title", "url"), flags=("isOpen",))
        and is_whole(value.get("number"), 1)
        and (value.get("parent") is None or is_whole(value["parent"], 1))
        and issue_numbers(value.get("blockedBy"))
        and issue_numbers(value.get("declared"))
        and isinstance(value.get("labels", []), list)
        and all(isinstance(one, str) for one in value.get("labels", []))
        and type(value.get("isNotPlanned", False)) is bool
        and isinstance(value.get("pulls"), list)
        and all(is_pull(one) for one in value["pulls"])
    )


def is_goal(value) -> bool:
    if not (
        has_fields(value, text=("repo", "title", "error"), stamps=("fetchedAt",))
        and issue_numbers(value.get("numbers"))
        and all(issue_numbers(value.get(key, [])) for key in ("added", "removed"))
        and isinstance(value.get("trunk", ""), str)
    ):
        return False
    for key in ("tickets", "heads"):
        listed = value.get(key)
        if not (
            isinstance(listed, list)
            and all(is_ticket(one) for one in listed)
            and len({one["number"] for one in listed}) == len(listed)
        ):
            return False
    if not {one["number"] for one in value["tickets"]} <= set(value["numbers"]):
        return False
    sections = value.get("sections", {})
    landed = value.get("landedAt", {})
    closers = value.get("closers", {})
    return (
        isinstance(sections, dict)
        and all(fold in ("all", "open", "closed") for fold in sections.values())
        and isinstance(landed, dict)
        and all(is_stamp(at) for at in landed.values())
        and isinstance(closers, dict)
        and all(
            has_fields(one, text=("at",)) and issue_numbers(one.get("closes"))
            for one in closers.values()
        )
    )


def is_activity(value) -> bool:
    if not (
        has_fields(
            value,
            text=("goal", "now"),
            counts=("calls",),
            stamps=("turnStartedAt", "turnMs", "nowAt", "at"),
            flags=("isWorking",),
        )
        and ("reportedAt" not in value or is_stamp(value["reportedAt"]))
        and issue_numbers(value.get("tasked"))
    ):
        return False
    for key, limit in (("steps", 100), ("agents", 40), ("marks", 60), ("rounds", 300)):
        if not isinstance(value.get(key), list) or len(value[key]) > limit:
            return False
    return (
        all(
            has_fields(one, text=("id", "text", "doing"))
            and one.get("status") in ("pending", "in_progress", "completed")
            and ("reportedAt" not in one or is_stamp(one["reportedAt"]))
            for one in value["steps"]
        )
        and all(
            has_fields(
                one,
                text=("id", "type", "what", "lane", "last", "outcome", "sha"),
                counts=("calls", "pr", "ticket"),
                stamps=("startedAt", "activeAt"),
                flags=("isStale", "isVerdict"),
            )
            and (one.get("endedAt") is None or is_stamp(one["endedAt"]))
            and ("reportedAt" not in one or is_stamp(one["reportedAt"]))
            for one in value["agents"]
        )
        and all(
            has_fields(
                one, text=("key", "text", "lane"), stamps=("at",), flags=("isBad",)
            )
            and one.get("kind") in ("commit", "push", "pr", "check")
            for one in value["marks"]
        )
        and all(
            has_fields(one, text=("key",), stamps=("at",))
            and is_whole(one.get("pr"), 1)
            for one in value["rounds"]
        )
    )


def is_owner_publication(owner, goal):
    if (
        not isinstance(owner, dict)
        or set(owner) != {"enabled", "targets", "ship"}
        or type(owner["enabled"]) is not bool
        or not isinstance(owner["targets"], list)
        or len(owner["targets"]) > 400
    ):
        return False
    tickets = [*(goal or {}).get("heads", []), *(goal or {}).get("tickets", [])]
    seen = set()
    for target in owner["targets"]:
        if not (
            isinstance(target, dict)
            and set(target) == {"ticket", "repo", "pull", "head", "base", "isDraft"}
            and type(target["ticket"]) is int
            and target["ticket"] > 0
            and type(target["pull"]) is int
            and 0 < target["pull"] <= 9007199254740991
            and isinstance(target["repo"], str)
            and re.fullmatch(
                r"[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}", target["repo"]
            )
            and isinstance(target["head"], str)
            and len(target["head"]) <= 64
            and isinstance(target["base"], str)
            and 0 < len(target["base"]) <= 256
            and type(target["isDraft"]) is bool
        ):
            return False
        identity = (target["ticket"], target["pull"])
        if identity in seen:
            return False
        seen.add(identity)
        if (
            not goal
            or target["repo"].lower() != goal["repo"].lower()
            or not any(
                ticket["number"] == target["ticket"]
                and any(
                    pull["number"] == target["pull"]
                    and pull["state"] == "OPEN"
                    and pull["repo"].lower() == target["repo"].lower()
                    and all(
                        pull[key] == target[key] for key in ("head", "base", "isDraft")
                    )
                    for pull in ticket["pulls"]
                )
                for ticket in tickets
            )
        ):
            return False
    ship = owner["ship"]
    return ship is None or (
        isinstance(ship, dict)
        and set(ship)
        in (
            {"pull", "repo", "head", "base", "step", "note"},
            {"pull", "repo", "head", "base", "step", "note", "confirmation_id"},
        )
        and type(ship["pull"]) is int
        and ship["pull"] > 0
        and all(
            isinstance(ship[key], str) and len(ship[key]) <= limit
            for key, limit in (
                ("repo", 201),
                ("head", 64),
                ("base", 256),
                ("note", 2048),
            )
        )
        and ship["step"] in ("confirm", "working", "armed", "failed")
        and (
            "confirmation_id" not in ship
            or isinstance(ship["confirmation_id"], str)
            and 0 < len(ship["confirmation_id"]) <= 200
        )
    )


def snapshot_of(value, session_id: str):
    """The native mod's versioned Overview publication, bound to its store key."""
    if not (
        isinstance(value, dict)
        and type(value.get("version")) is int
        and value["version"] == 1
        and value.get("session_id") == session_id
        and is_stamp(value.get("at"))
        and is_activity(value.get("activity"))
        and "goal" in value
        and (value.get("goal") is None or is_goal(value["goal"]))
    ):
        return None
    if "owner" in value and not is_owner_publication(value["owner"], value["goal"]):
        return None
    # Unknown extension fields must also remain valid JSON: Python's decoder accepts
    # NaN/Infinity, but a browser would reject the entire HTTP response containing one.
    try:
        json.dumps(value, allow_nan=False)
    except (TypeError, ValueError, RecursionError):
        return None
    view = value.get("view")
    if not has_fields(view, counts=("total", "completed")) or not isinstance(
        view.get("sections"), list
    ):
        return None
    tickets = (value.get("goal") or {}).get("tickets", [])
    expected = {one["number"]: one for one in tickets}
    if view["total"] != len(tickets) or view["completed"] != sum(
        not one["isOpen"] for one in tickets
    ):
        return None
    sections, seen = set(), set()
    for section in view["sections"]:
        if not (
            has_fields(section, text=("id", "label"))
            and section["id"] not in sections
            and section.get("fold") in ("all", "open", "closed")
            and isinstance(section.get("tickets"), list)
        ):
            return None
        sections.add(section["id"])
        for one in section["tickets"]:
            if not is_ticket(one):
                return None
            number = one["number"]
            if number in seen or one != expected.get(number):
                return None
            seen.add(number)
    if seen != set(expected):
        return None
    return value


def read_progress(profiles) -> dict:
    """Legacy goal/review records and the native mod's authoritative Overview snapshot.
    Published groups, counts, activity and freshness are relayed, never reconstructed.
    Older stores keep their original response shape until the mod publishes a snapshot.
    """
    files, skipped_files = store_files(profiles, PROGRESS_STORE)
    skipped_entries = 0
    sessions, cancelled = [], []
    for labels, data in files:
        if data is None:
            skipped_files += 1
            continue
        found: dict[str, dict] = {}
        for key, value in data.items():
            kind, _, session_id = key.partition(":")
            if key == "ship-cancelled":
                note = cancelled_of(value)
                if note is None:
                    skipped_entries += 1
                else:
                    cancelled.append({**note, "profiles": labels})
                continue
            if kind not in ("goal", "review", "overview"):
                continue
            read = (
                snapshot_of(value, session_id)
                if kind == "overview"
                else (goal_of if kind == "goal" else review_of)(value)
            )
            if read is None or not SESSION_ID.fullmatch(session_id):
                skipped_entries += 1
                continue
            entry = found.setdefault(
                session_id,
                {
                    "session_id": session_id,
                    "profiles": labels,
                    "goal": None,
                    "review": None,
                },
            )
            entry["snapshot" if kind == "overview" else kind] = read
        sessions.extend(found.values())

    def order(entry):
        at = (entry["review"] or {}).get("at")
        return (at is None, -(at or 0), entry["session_id"])

    sessions.sort(key=order)
    return {
        "sessions": sessions,
        "cancelled": cancelled,
        "skipped": {"files": skipped_files, "entries": skipped_entries},
    }


def read_progress_states(profiles, now_ms: int) -> dict:
    """`read_progress`, each session with the state its task-store slots record: `live`,
    `quiet` or `ended` as for tasks, `unknown` when no task store holds the session, and
    `seen_ms`, its latest `seenMs` (None when unknown). A session ended only when every slot
    holding it has `endedMs`; the progress store carries no such fact of its own."""
    files, _ = store_files(profiles, HITL_STORE)
    slots: dict[str, list[dict]] = {}
    for _, data in files:
        for key, value in (data or {}).items():
            held = task_slot(key, value)
            if held is not None:
                slots.setdefault(held[1], []).append(value)
    progress = read_progress(profiles)
    for entry in progress["sessions"]:
        held = slots.get(entry["session_id"], [])
        if not held:
            entry["session_state"], entry["seen_ms"] = "unknown", None
            continue
        latest = max(held, key=lambda one: one["seenMs"])
        alive = [one for one in held if not is_number(one.get("endedMs"))]
        entry["session_state"] = session_state(
            max(alive, key=lambda one: one["seenMs"]) if alive else latest, now_ms
        )
        entry["seen_ms"] = latest["seenMs"]
    return progress


# --- usage (the wrap-up collector's readings, read-only) -------------------------------------

USAGE_ENGINE = Path(__file__).resolve().parent.parent / "hooks" / "wrap_up_usage.py"
"""The wrap-up engine of this checkout. The page takes the policy, the latch and the weekly
warning from its functions, so the page and wrap-up follow one rule set (#181)."""


def load_usage_engine(path: Path):
    """The engine at `path` as a module (standard library only, like this server), or None when
    it is missing, broken or lacks what the page uses: then usage is unavailable."""
    try:
        spec = importlib.util.spec_from_file_location("wrap_up_usage_engine", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    except Exception:  # noqa: BLE001 - an engine that does not load means no usage view
        return None
    needed = ("profile_view", "label_of", "listed_profiles")
    has_all = all(callable(getattr(module, one, None)) for one in needed)
    stale = getattr(module, "STALE_S", None)
    is_stale_limit = type(stale) in (int, float) and math.isfinite(stale) and stale > 0
    return module if has_all and is_stale_limit else None


usage_engine = load_usage_engine(USAGE_ENGINE)


def short_path(path: Path) -> str:
    home = str(Path.home())
    text = str(path)
    return (
        "~" + text[len(home) :] if text == home or text.startswith(home + "/") else text
    )


def read_usage_profile(label: str, profile: Path, now: float) -> dict:
    """One profile's row: the engine's own view of it (profile_view: its policy, latch, weekly
    warning and reading states), under this profile's label and `~` path."""
    return {
        "label": label,
        "path": short_path(profile),
        **usage_engine.profile_view(profile, now),
    }


def read_usage(profiles, now: float) -> dict:
    """Every profile's usage readings (never written), in the profiles' order. `available`
    is false when the engine did not load or no profile has a wrap-up directory (the
    collector is not installed)."""
    if usage_engine is None:
        rows = []
    else:
        rows = [read_usage_profile(label, Path(path), now) for label, path in profiles]
    return {
        "available": any(row["reader"] for row in rows),
        "generated_at": now,
        "stale_after_s": usage_engine.STALE_S if usage_engine else None,
        "attention": sum(1 for row in rows if row["attention"]),
        "profiles": rows,
    }


DOC_TIMEOUT_S = 20.0
MAX_DOC_BYTES = 2 * 1024 * 1024
DOCUMENT_REPO = re.compile(
    r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}"
)
DOCUMENT_QUERY = (
    "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { "
    "issue: issueOrPullRequest(number: $number) { "
    "... on Issue { title body author { login } comments(last: 20) { totalCount nodes { author { login } createdAt body } } } "
    "... on PullRequest { title body author { login } comments(last: 20) { totalCount nodes { author { login } createdAt body } } } "
    "} } }"
)


class DocumentFailure(Exception):
    def __init__(self, status: int, outcome: str, message: str):
        self.status, self.outcome, self.message = status, outcome, message


def document_target(
    profiles, session_id: str, labels: list[str], number: int, repo: str
):
    """Authorize a read only from one current, validated session/profile publication."""
    sessions = [
        one
        for one in read_progress(profiles)["sessions"]
        if one["session_id"] == session_id
        and one["profiles"] == labels
        and "snapshot" in one
    ]
    if len(sessions) > 1:
        raise DocumentFailure(
            409,
            "ambiguous",
            "This session/profile has multiple published snapshots. Refresh Progress in Claude.",
        )
    if not sessions or sessions[0]["snapshot"]["goal"] is None:
        raise DocumentFailure(
            403,
            "forbidden",
            "This document is not in the selected session's published goal.",
        )
    goal = sessions[0]["snapshot"]["goal"]
    candidates = set()
    if number in goal["numbers"]:
        candidates.add(("issue", goal["repo"], number))
    for ticket in [*goal["tickets"], *goal["heads"]]:
        if ticket["number"] not in goal["numbers"]:
            continue
        for pull in ticket["pulls"]:
            if pull["number"] == number:
                candidates.add(("pull", pull["repo"] or goal["repo"], number))
    candidates = {one for one in candidates if one[1] == repo}
    if len(candidates) > 1:
        raise DocumentFailure(
            409,
            "ambiguous",
            "This document number identifies multiple enrolled documents.",
        )
    if not candidates:
        raise DocumentFailure(
            403,
            "forbidden",
            "This document is not in the selected session's published goal.",
        )
    target = next(iter(candidates))
    if not DOCUMENT_REPO.fullmatch(target[1]):
        raise DocumentFailure(
            403, "forbidden", "The published repository identity is invalid."
        )
    return target


def document_text(raw: bytes):
    """Match Progress parseDoc: body, comment count, then the last 20 comments."""
    try:
        payload = json.loads(raw)
        if not isinstance(payload, dict) or payload.get("errors"):
            raise ValueError
        repository = payload["data"]["repository"]
        issue = repository["issue"] if isinstance(repository, dict) else None
        if issue is None:
            raise DocumentFailure(
                404, "not_found", "GitHub did not return this document."
            )
        if not isinstance(issue, dict) or not isinstance(issue.get("title"), str):
            raise TypeError
        body = issue.get("body", "")
        comments = issue.get("comments", {})
        if not isinstance(body, str) or not isinstance(comments, dict):
            raise TypeError
        nodes = comments.get("nodes", [])
        total = comments.get("totalCount", len(nodes))
        if (
            not isinstance(nodes, list)
            or len(nodes) > 20
            or not is_whole(total)
            or total < len(nodes)
        ):
            raise ValueError
        parts = [body.strip() or "_No description._"]
        if nodes:
            suffix = f" (last {len(nodes)})" if total > len(nodes) else ""
            parts.append(
                f"---\n\n**{total} comment{'' if total == 1 else 's'}**{suffix}"
            )
        for one in nodes:
            if not isinstance(one, dict):
                raise TypeError
            author = one.get("author")
            if author is not None and not isinstance(author, dict):
                raise ValueError
            login = (author or {}).get("login") or "ghost"
            created = one.get("createdAt", "")
            text = one.get("body", "")
            if not all(isinstance(value, str) for value in (login, created, text)):
                raise ValueError
            parts.append(f"**@{login}** · {created[:10]}\n\n{text.strip()}")
        return issue["title"], "\n\n".join(parts)
    except (ValueError, TypeError, KeyError, RecursionError):
        raise DocumentFailure(
            502, "upstream_error", "GitHub returned an incomplete or invalid document."
        ) from None


class DocumentReader:
    """Bounded gh calls; no shell, shared document cache, or model involvement."""

    def __init__(self):
        self.lock = threading.Lock()
        self.running = set()
        self.stopped = False

    def fetch(self, repo: str, number: int):
        owner, name = repo.split("/")
        argv = [
            "gh",
            "api",
            "graphql",
            "-f",
            f"owner={owner}",
            "-f",
            f"name={name}",
            "-F",
            f"number={number}",
            "-f",
            f"query={DOCUMENT_QUERY}",
        ]
        with self.lock:
            if self.stopped:
                raise DocumentFailure(
                    503, "unavailable", "The document reader is stopping."
                )
            try:
                proc = subprocess.Popen(
                    argv,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                    env={**os.environ, "GH_PROMPT_DISABLED": "1"},
                )
            except OSError:
                raise DocumentFailure(
                    503, "unavailable", "GitHub CLI is unavailable on this server."
                ) from None
            self.running.add(proc)
        try:
            try:
                raw = self.read(proc)
            finally:
                with self.lock:
                    with contextlib.suppress(OSError):
                        os.killpg(proc.pid, signal.SIGKILL)
                    self.running.discard(proc)
                code = proc.wait()
        except OSError:
            raise DocumentFailure(
                503, "unavailable", "The GitHub document could not be read."
            ) from None
        if code != 0:
            raise DocumentFailure(
                502,
                "upstream_error",
                "GitHub could not load this document. Check gh authentication and repository access on the server.",
            )
        return document_text(raw)

    @staticmethod
    def read(proc):
        fd = proc.stdout.fileno()
        poller = select.poll()
        poller.register(fd, select.POLLIN)
        deadline = time.monotonic() + DOC_TIMEOUT_S
        printed, ended = bytearray(), False
        # WNOWAIT leaves the PID reserved until the final process-group cleanup.
        while not (
            ended
            and os.waitid(os.P_PID, proc.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        ):
            left = deadline - time.monotonic()
            if left <= 0:
                raise DocumentFailure(
                    504,
                    "timeout",
                    "GitHub did not return this document within 20 seconds.",
                )
            if ended:
                time.sleep(min(left, STOP_CHECK_S))
            elif poller.poll(min(left, STOP_CHECK_S) * 1000):
                chunk = os.read(fd, 65536)
                ended = not chunk
                printed += chunk
                if len(printed) > MAX_DOC_BYTES:
                    raise DocumentFailure(
                        502,
                        "too_large",
                        "The GitHub document exceeds the 2 MiB read limit.",
                    )
        return printed

    def stop(self):
        with self.lock:
            self.stopped = True
            for proc in self.running:
                with contextlib.suppress(OSError):
                    os.killpg(proc.pid, signal.SIGKILL)


class SharedRead:
    """A read of the stores (`read`, giving the reply's JSON bytes), shared: one runs at a
    time, and a request that arrives while one runs takes its result instead of starting its
    own, so polls that come together hold one reply in memory, not one each."""

    # TODO(deferred): #154 staggered clients that never read each hold a full reply

    def __init__(self, read):
        self.read = read
        self.lock = threading.Lock()
        self.done_at = -math.inf
        self.result = b""

    def __call__(self) -> bytes:
        asked = time.monotonic()
        with self.lock:
            if self.done_at < asked:
                self.result = self.read()
                self.done_at = time.monotonic()
            return self.result


def json_bytes(payload) -> bytes:
    return json.dumps(payload, separators=(",", ":")).encode()


# --- configuration and files -----------------------------------------------------------------


class Config:
    """The local config: the PIN, the hosts the page is opened at (`<machine>:6767` when it
    names none), and the profiles to read ([(label, directory)], None when it names none).
    The owner's login is not in it: `tailscale_login` reads it at start."""

    def __init__(self, pin: str, hosts: list[str], profiles=None) -> None:
        self.pin = pin
        self.hosts = hosts
        self.profiles = profiles


def label_of(profile: Path) -> str:
    """A profile's label, from its directory's name: `.claude-work` is work, `.claude`
    default, `agents` agents. The engine's own label_of when it loaded (one owner, #181); this
    copy only where it did not."""
    if usage_engine is not None:
        return usage_engine.label_of(profile)
    name = profile.name.lstrip(".")
    if name == "claude":
        return "default"
    return name.removeprefix("claude-") or name


def default_config_path() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "claude-tweaks" / "dashboard.toml"


def default_state_dir() -> Path:
    # TODO(deferred): #164 ignore a relative XDG_STATE_HOME as the dashboard-control helper does
    base = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    return Path(base) / "claude-tweaks" / "dashboard"


OLD_NAME = "phone"
"""The name this server had until #167 (the phone view): its config was `phone.toml` and its
state folder `phone`, beside the dashboard's own, which take their place (`config_or_old`)."""


def notice(text: str) -> None:
    print(f"{NAME}: {text}", file=sys.stderr, flush=True)


def config_or_old(path: Path) -> Path:
    """The default config `path`, or the phone view's beside it when `path` is missing and
    that one is there; either way, one notice on stderr whenever the old one is there."""
    old = path.with_name(f"{OLD_NAME}.toml")
    if not os.path.lexists(old):
        return path
    if os.path.lexists(path):
        notice(f"{old} (the phone view's config) is ignored: {path} is read")
        return path
    notice(f"reading {old} (the phone view's config): move it to {path}")
    return old


def state_or_old(path: Path) -> Path:
    """The default state folder `path`, first moved there from the phone view's beside it
    when `path` is missing and that one is there: one rename within the same folder, so the
    secret and the lockout carry over (a session signed before still holds, under the new
    cookie name only). Stops the server, having moved nothing, when the old folder is not a
    private directory of this user's or the phone view still runs on it (holds its lock).
    After the move the old socket, refusing connects, and the old lock file are taken away."""
    old = path.with_name(OLD_NAME)
    if os.path.lexists(path):
        return path
    try:
        held = os.lstat(old)
    except FileNotFoundError:
        return path
    if not stat.S_ISDIR(held.st_mode) or held.st_uid != os.getuid():
        raise SystemExit(
            f"{NAME}: {old} (the phone view's state) is not a private directory of yours:"
            f" remove it, {AGAIN}"
        )
    lock = old / f"{OLD_NAME}.lock"
    try:
        fd = os.open(lock, os.O_RDWR | os.O_NOFOLLOW)
    except FileNotFoundError:
        fd = None
    except OSError as error:
        raise SystemExit(
            f"{NAME}: cannot open {lock} ({error.strerror or error}): remove it if it is"
            " not a file of yours"
        ) from None
    try:
        if fd is not None:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                raise SystemExit(
                    f"{NAME}: the phone view still runs on {old}, or another dashboard"
                    f" start is moving its state: stop claude-tweaks-phone (systemctl --user"
                    f" stop claude-tweaks-phone) and start once more"
                ) from None
        try:
            os.rename(old, path)
        except OSError as error:
            raise SystemExit(
                f"{NAME}: cannot move {old} to {path} ({error.strerror or error}): move"
                f" it yourself, {AGAIN}"
            ) from None
    finally:
        if fd is not None:
            os.close(fd)
    stale = path / f"{OLD_NAME}.sock"
    if os.path.lexists(stale) and is_refused(stale):
        stale.unlink()
    with contextlib.suppress(FileNotFoundError):
        if stat.S_ISREG(os.lstat(path / lock.name).st_mode):
            (path / lock.name).unlink()
    notice(f"moved {old} (the phone view's state) to {path}")
    return path


def is_plain(text) -> bool:
    """Text of visible ASCII with no space: a login, a host, a PIN."""
    return (
        isinstance(text, str) and bool(text) and all(33 <= ord(c) <= 126 for c in text)
    )


def is_login(text) -> bool:
    """A login the server admits: plain (`is_plain`) and at most 256 characters."""
    return is_plain(text) and len(text) <= 256


def load_config(path: Path, *, local: bool = False) -> Config:
    """The config at `path`; stops the server, saying what to fix, when it is missing, others
    can read or write it, or a key is unknown or of the wrong shape."""
    pin_example = 'pin = "<your-own-PIN>"' if local else 'pin = "1337"'
    try:
        held = os.stat(path)
    except FileNotFoundError:
        raise SystemExit(
            f"{NAME}: no config at {path}. Create it, readable by you alone (chmod 600),"
            f" with the PIN the page asks for: {pin_example}."
        ) from None
    if held.st_uid != os.getuid() or held.st_mode & 0o077:
        raise SystemExit(
            f"{NAME}: {path} holds the PIN, so it must be yours and readable by you"
            f" alone: chmod 600 {path}"
        )
    try:
        values = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise SystemExit(f"{NAME}: {path} is not a TOML file: {error}") from None
    if "owner_login" in values:
        raise SystemExit(
            f"{NAME}: {path}: owner_login is no longer used (the server reads the owner's"
            " login from `tailscale status` when it starts): delete that line"
        )
    unknown = sorted(set(values) - set(CONFIG_KEYS))
    if unknown:
        raise SystemExit(
            f"{NAME}: {path} has keys this server does not know: {', '.join(unknown)}"
            f" (it takes {', '.join(CONFIG_KEYS)})"
        )
    if local and "pin" not in values:
        raise SystemExit(
            f"{NAME}: {path}: local mode requires an explicit pin in the private config"
        )
    pin = values.get("pin", DEFAULT_PIN)
    if local and pin == DEFAULT_PIN:
        raise SystemExit(
            f"{NAME}: {path}: choose a PIN other than the legacy default for local mode"
        )
    if not is_plain(pin) or not 4 <= len(pin) <= 64:
        raise SystemExit(
            f"{NAME}: {path}: pin must be quoted text of 4 to 64 characters ({pin_example})"
        )
    hosts = values.get("hosts", [f"{socket.gethostname()}:{PORT}"])
    if not (isinstance(hosts, list) and hosts and all(is_plain(h) for h in hosts)):
        raise SystemExit(
            f"{NAME}: {path}: hosts must be a list of host:port names"
            f' (hosts = ["<machine>:{PORT}"])'
        )
    return Config(pin, hosts, config_profiles(path, values.get("profiles")))


AGAIN = "then start the dashboard again"


def tailscale_status() -> tuple[int, bytearray]:
    """Runs TAILSCALE_STATUS: (its exit status, what it printed). Stops the server in one
    line when the command is missing or cannot run, takes longer than TAILSCALE_TIMEOUT_S,
    prints more than MAX_STATUS_BYTES, or the system fails any step of the call (the pipe,
    a poll, a read, a wait: out of file descriptors, say).

    The command runs in a process group of its own; however the call ends (the command's
    exit, the time bound, a failure, or a stop signal), the group is killed with all the
    command started that is still in it, before the command is reaped, while its pid still
    names the group. A process that leaves the group (setsid) is not killed here; the unit's
    control group ends it when the unit stops (owner decision, AskUserQuestion 2026-11-19).
    The stop signals (TERMINATING) are held back for the whole call, so none can end the
    server between the spawn and that cleanup; one that comes ends the call at once, and is
    let through once the call is cleaned up, stopping the server as it would have. The
    command starts with no signal held back or ignored."""
    held = signal.pthread_sigmask(signal.SIG_BLOCK, TERMINATING)
    try:
        return run_held(time.monotonic() + TAILSCALE_TIMEOUT_S)
    except OSError as error:
        raise SystemExit(
            f"{NAME}: cannot read tailscale status ({error.strerror or error}): {AGAIN}"
        ) from None
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, held)


def run_held(deadline: float) -> tuple[int, bytearray]:
    read_end, write_end = os.pipe()
    try:
        try:
            pid = os.posix_spawnp(
                TAILSCALE_STATUS[0],
                TAILSCALE_STATUS,
                os.environ,
                file_actions=[
                    (os.POSIX_SPAWN_OPEN, 0, os.devnull, os.O_RDONLY, 0),
                    (os.POSIX_SPAWN_DUP2, write_end, 1),
                    (os.POSIX_SPAWN_OPEN, 2, os.devnull, os.O_WRONLY, 0),
                ],
                # A process group of its own (setsid is missing from some Python builds).
                setpgroup=0,
                setsigmask=(),
                # As subprocess's restore_signals: Python ignores these; the command not.
                setsigdef=(signal.SIGPIPE, signal.SIGXFSZ),
            )
        except FileNotFoundError:
            raise SystemExit(
                f"{NAME}: no tailscale command on PATH: install Tailscale (or run the dashboard"
                f" with tailscale on its PATH), {AGAIN}"
            ) from None
        except OSError as error:
            raise SystemExit(
                f"{NAME}: cannot run tailscale ({error.strerror or error}): check the"
                f" tailscale command on PATH, {AGAIN}"
            ) from None
        finally:
            os.close(write_end)
        try:
            printed = read_until_exit(pid, read_end, deadline)
        finally:
            with contextlib.suppress(OSError):
                os.killpg(pid, signal.SIGKILL)
            _, status = os.waitpid(pid, 0)
        return os.waitstatus_to_exitcode(status), printed
    finally:
        os.close(read_end)


def read_until_exit(pid: int, fd: int, deadline: float) -> bytearray:
    """What command `pid` prints on `fd`, to its end, once the command has exited; the
    command is left for its caller to reap. Ends the call when `deadline` passes, a stop
    signal waits, or the output passes MAX_STATUS_BYTES."""
    printed = bytearray()
    poller = select.poll()
    poller.register(fd, select.POLLIN)
    ended = False
    while not (
        ended and os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    ):
        if not signal.sigpending().isdisjoint(TERMINATING):
            raise SystemExit(0)
        left = deadline - time.monotonic()
        if left <= 0:
            raise SystemExit(
                f"{NAME}: tailscale status did not answer within {TAILSCALE_TIMEOUT_S:g}"
                f" s: check that Tailscale is running (tailscale status), {AGAIN}"
            )
        if ended:
            time.sleep(min(left, STOP_CHECK_S))
        elif poller.poll(min(left, STOP_CHECK_S) * 1000):
            chunk = os.read(fd, 65536)
            ended = not chunk
            printed += chunk
            if len(printed) > MAX_STATUS_BYTES:
                raise SystemExit(
                    f"{NAME}: tailscale status --json printed more than"
                    f" {MAX_STATUS_BYTES >> 20} MiB, more than the dashboard reads: check"
                    f" tailscale status, {AGAIN}"
                )
    return printed


def tailscale_login() -> str:
    """The login of the Tailscale user this machine is logged in as: `Self.UserID`, looked up
    in `User`, its `LoginName`, from `tailscale status --json` (`tailscale_status`). Stops
    the server in one line, saying what to fix, when the command cannot run or does not
    answer in time, fails (tailscaled not running), prints no JSON, reports Tailscale logged
    out or not connected, or names no plain login. Only those fields are read; the reply is
    never printed or stored."""
    code, printed = tailscale_status()
    if code != 0:
        raise SystemExit(
            f"{NAME}: tailscale status failed (exit status {code}): start"
            f" Tailscale (sudo systemctl start tailscaled) and log in (tailscale up), {AGAIN}"
        )
    try:
        status = json.loads(printed)
    except (ValueError, RecursionError):
        raise SystemExit(
            f"{NAME}: tailscale status --json printed no JSON: check tailscale status, {AGAIN}"
        ) from None
    except MemoryError:
        raise SystemExit(
            f"{NAME}: tailscale status --json printed more than the dashboard has memory to"
            f" read: check tailscale status, {AGAIN}"
        ) from None
    shape = (
        f"{NAME}: tailscale status --json names no login for the user this machine is"
        " logged in as (Self.UserID, and that user's LoginName in User, as visible ASCII):"
        f" check tailscale status, {AGAIN}"
    )
    if not isinstance(status, dict):
        raise SystemExit(shape)
    state = status.get("BackendState")
    if state == "NeedsLogin":
        raise SystemExit(
            f"{NAME}: Tailscale on this machine is logged out: log in (tailscale up), {AGAIN}"
        )
    if state != "Running":
        shown = state if state in TAILSCALE_STATES else "unknown"
        raise SystemExit(
            f"{NAME}: Tailscale on this machine is not connected (its state is"
            f" {shown}, not Running): connect it (tailscale up), {AGAIN}"
        )
    me, users = status.get("Self"), status.get("User")
    if isinstance(me, dict) and me.get("Tags"):
        # Its user is Tailscale's tagged-devices user, whose login no phone ever sends.
        raise SystemExit(
            f"{NAME}: this machine is tagged in Tailscale, so it has no owner login to"
            " admit: run the dashboard on a machine your Tailscale user owns, untagged,"
            f" {AGAIN}"
        )
    uid = me.get("UserID") if isinstance(me, dict) else None
    user = users.get(str(uid)) if type(uid) is int and isinstance(users, dict) else None
    login = user.get("LoginName") if isinstance(user, dict) else None
    if not is_login(login):
        raise SystemExit(shape)
    return login


def config_profiles(path: Path, listed) -> list[tuple[str, Path]] | None:
    """The config's `profiles`: [(label, directory)], None when it names none; stops the
    server when it is not a list of absolute (or `~`) directories with distinct labels."""
    if listed is None:
        return None
    shape = (
        f"{NAME}: {path}: profiles must be a list of profile directories, each absolute or"
        ' starting with ~ (profiles = ["~/.claude"])'
    )
    try:
        dirs = listed_dirs(listed)
    except ValueError as refused:
        if str(refused) != "labels":
            raise SystemExit(shape) from None
        labels = [label_of(Path(one).expanduser()) for one in listed]
        raise SystemExit(
            f"{NAME}: {path}: two profiles get the same label from their directory names"
            f" ({', '.join(labels)}): name each directory differently"
        ) from None
    return [(label_of(one), one) for one in dirs]


def listed_dirs(listed) -> list[Path]:
    """The config's `profiles` as directories: the engine's listed_profiles when it loaded (one
    owner, #181), else this copy of its rule. ValueError("shape") or ValueError("labels")."""
    if usage_engine is not None:
        return [Path(one) for one in usage_engine.listed_profiles(listed)]
    if not (
        isinstance(listed, list)
        and listed
        and all(isinstance(one, str) and one for one in listed)
    ):
        raise ValueError("shape")
    try:
        dirs = [Path(one).expanduser() for one in listed]
    except RuntimeError:  # `~user` naming no user
        raise ValueError("shape") from None
    if not all(one.is_absolute() for one in dirs):
        raise ValueError("shape")
    dirs = [Path(os.path.normcase(os.path.abspath(one))) for one in dirs]
    if len({label_of(one) for one in dirs}) != len(dirs):
        raise ValueError("labels")
    return dirs


def private_dir(path: Path) -> Path:
    """`path` as a directory only this user reaches (0700), made with its parents if missing;
    refuses a link or a directory another user owns."""
    os.makedirs(path.parent, mode=0o700, exist_ok=True)
    with contextlib.suppress(FileExistsError):
        os.mkdir(path, 0o700)
    held = os.lstat(path)
    if not stat.S_ISDIR(held.st_mode) or held.st_uid != os.getuid():
        raise SystemExit(f"{NAME}: {path} is not a private directory of yours")
    if stat.S_IMODE(held.st_mode) != 0o700:
        os.chmod(path, 0o700)
    return path


def is_refused(path: Path) -> bool:
    """Whether a connect to the socket at `path` is refused, so no process listens on it."""
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


def write_private(path: Path, data: bytes) -> None:
    """Writes `data` to `path` as a 0600 file, in one rename: a reader sees old or new. A
    write that fails leaves no temporary file behind."""
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.unlink(missing_ok=True)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        try:
            os.fchmod(fd, 0o600)
            os.write(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            tmp.unlink()
        raise


# --- the PIN gate ----------------------------------------------------------------------------

MAX_TRIES = 5
"""Wrong PINs in a row before the gate locks."""
LOCKOUT_S = 15 * 60
"""The first lockout; each further run of MAX_TRIES wrong PINs doubles it."""
MAX_LOCKOUT_S = 24 * 3600
UNSAVED_WAIT_S = 60
"""The wait a PIN attempt is told while the lockout cannot be saved (the save is tried again
at each attempt)."""
SESSION_S = 30 * 24 * 3600
"""How long a browser stays unlocked."""
COOKIE = "ctdash"
"""The session cookie's name (`ctphone` until #167: a browser holding that one logs in again)."""
ISSUED = re.compile(r"[0-9]{1,12}")
"""ASCII digits only: `str.isdigit` takes others (`²`) that `int` then refuses."""
SECRET_BYTES = 32


def digest(text: str) -> bytes:
    return hashlib.sha256(text.encode()).digest()


class Gate:
    """The PIN gate, on the server's private state directory: the PIN and its lockout, the
    sessions it issues (signed cookies), and the CSRF token of each.

    A session is `v1.<issued>.<nonce>.<mac>`, signed with a key drawn from the secret file,
    the login Tailscale reported at start, and the PIN: a cookie is void once any of them
    changes, or the secret file is removed, and holds for SESSION_S. The secret, the config
    and the login are read when the server starts, so such a change takes effect at the next
    start. The lockout (failures in a row, locked until) is kept in `lockout.json`, so a
    restart does not reset it; the wall clock is used for the same reason, and a lockout is
    never held past MAX_LOCKOUT_S from now. While the lockout cannot be saved (from the
    start, or since an attempt), no PIN is judged: the gate answers locked until a save
    succeeds, so a restart cannot reopen what an unsaved count would have closed."""

    def __init__(self, state: Path, pin: str, owner: str, clock=time.time):
        self.clock = clock
        self.pin = digest(pin)
        secret = self.secret(state / "secret")
        self.key = hmac.new(
            secret, f"session\0{owner}\0{pin}".encode(), hashlib.sha256
        ).digest()
        self.lockout = state / "lockout.json"
        self.lock = threading.Lock()
        self.failures, self.locked_until = self.load()
        self.is_saved = True
        self.keep()

    @staticmethod
    def secret(path: Path) -> bytes:
        """The server's secret, drawn the first time: SECRET_BYTES in a 0600 file. Stops the
        server, saying what to do, when it is anything else or cannot be read or made."""
        try:
            with contextlib.suppress(FileExistsError):
                fd = os.open(
                    path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
                )
                try:
                    os.write(fd, secrets.token_bytes(SECRET_BYTES))
                    os.fsync(fd)
                finally:
                    os.close(fd)
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                held = os.fstat(fd)
                data = os.read(fd, SECRET_BYTES + 1)
            finally:
                os.close(fd)
        except OSError as error:
            raise SystemExit(
                f"{NAME}: cannot read or make the server's secret {path}"
                f" ({error.strerror or error}): it must be a file of yours in a directory"
                " you can write; remove it if it is anything else (browsers then ask for"
                " the PIN again)"
            ) from None
        if (
            not stat.S_ISREG(held.st_mode)
            or held.st_uid != os.getuid()
            or stat.S_IMODE(held.st_mode) != 0o600
            or len(data) != SECRET_BYTES
        ):
            raise SystemExit(
                f"{NAME}: {path} is not the server's secret: remove it (browsers then"
                " ask for the PIN again)"
            )
        return data

    def load(self) -> tuple[int, float]:
        """The lockout as kept; one that cannot be read locks the gate for LOCKOUT_S (a
        missing file is a gate never locked)."""
        try:
            fd = os.open(self.lockout, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            return 0, 0.0
        except OSError:
            return MAX_TRIES, self.clock() + LOCKOUT_S
        try:
            kept = json.loads(os.read(fd, 4096))
            failures, until = kept["failures"], kept["locked_until"]
            if type(failures) is int and failures >= 0 and is_number(until):
                return failures, float(until)
        except (OSError, ValueError, TypeError, KeyError, OverflowError):
            pass
        finally:
            os.close(fd)
        return MAX_TRIES, self.clock() + LOCKOUT_S

    def keep(self) -> bool:
        """Saves the lockout; whether it was saved. The first failure of a run says why on
        stderr, once."""
        kept = {"failures": self.failures, "locked_until": self.locked_until}
        try:
            write_private(self.lockout, json.dumps(kept).encode())
        except OSError as error:
            if self.is_saved:
                print(
                    f"{NAME}: cannot save the PIN lockout to {self.lockout}"
                    f" ({error.strerror or error}): the PIN page stays locked until it"
                    " can be saved",
                    file=sys.stderr,
                    flush=True,
                )
            self.is_saved = False
            return False
        self.is_saved = True
        return True

    def unlock(self, given: str):
        """("ok", cookie value), ("wrong", tries left before the lockout) or ("locked",
        seconds to wait). One attempt at a time, so a burst cannot outrun the count; none
        while the lockout cannot be saved."""
        with self.lock:
            now = self.clock()
            if not self.is_saved and not self.keep():
                return "locked", UNSAVED_WAIT_S
            self.locked_until = min(self.locked_until, now + MAX_LOCKOUT_S)
            if self.locked_until > now:
                return "locked", math.ceil(self.locked_until - now)
            if hmac.compare_digest(digest(given), self.pin):
                self.failures, self.locked_until = 0, 0.0
                self.keep()
                return "ok", self.issue(now)
            self.failures += 1
            if self.failures % MAX_TRIES:
                self.keep()
                return "wrong", MAX_TRIES - self.failures % MAX_TRIES
            runs = self.failures // MAX_TRIES
            wait = min(LOCKOUT_S * 2 ** min(runs - 1, 16), MAX_LOCKOUT_S)
            self.locked_until = now + wait
            self.keep()
            return "locked", wait

    def mac(self, text: str) -> str:
        return hmac.new(self.key, text.encode(), hashlib.sha256).hexdigest()

    def issue(self, now: float) -> str:
        issued, nonce = int(now), secrets.token_urlsafe(18)
        return f"v1.{issued}.{nonce}.{self.mac(f'session|{issued}|{nonce}')}"

    def session(self, cookie) -> str | None:
        """The session (its nonce) a cookie value names, when the gate issued it unchanged
        and it has not expired; else None."""
        parts = cookie.split(".") if isinstance(cookie, str) else []
        if len(parts) != 4 or parts[0] != "v1" or not ISSUED.fullmatch(parts[1]):
            return None
        _, issued, nonce, mac = parts
        if not 0 <= self.clock() - int(issued) < SESSION_S:
            return None
        expected = self.mac(f"session|{issued}|{nonce}")
        if not hmac.compare_digest(mac.encode(), expected.encode()):
            return None
        return nonce

    def csrf_token(self, session: str) -> str:
        return self.mac(f"csrf|{session}")

    def is_csrf(self, session: str, token) -> bool:
        return isinstance(token, str) and hmac.compare_digest(
            token.encode(), self.csrf_token(session).encode()
        )


# --- answering through the session's answer endpoint ----------------------------------------

REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{16,64}")
OUTCOME = re.compile(r"[a-z_]{1,32}")
TOKEN = re.compile(r"[A-Za-z0-9_-]{16,256}")
"""An endpoint token as the listener draws it (`token_urlsafe`)."""
ACTIONS = {
    "done": ((), ()),
    "choose": (("option",), ()),
    "answer": (("text",), ()),
    "reject": ((), ("reason",)),
    "archive": ((), ()),
    "restore": ((), ()),
}
"""Each action's text fields: those it needs, and those it may carry (the fork's README)."""
TEXTS = ("option", "text", "reason")
REQUIRED = ("request_id", "session_id", "task_id", "created_ms", "version", "action")
MAX_ENTRY_BYTES = 4096
MAX_REPLY_BYTES = 65536
RELAY_TIMEOUT_S = 20.0
"""The endpoint waits up to 15 s for its session; past this the answer is unreachable."""
# TODO(deferred): #172 answers still send source "phone"; rename in two steps
ANSWER_SOURCE = "phone"
"""This server's `source` in the answer endpoint's contract (the fork's README, Answer
endpoint), kept from before the #167 rename: a session started before an upgrade takes only
`endpoint` or `phone`, and would refuse any other value."""
LOG_TIMEOUT_S = 5.0
"""How long the decision-log writer may run before it is killed (the mods' bound)."""
MAX_WRITERS = 2
"""Decision-log writers running at once."""
WRITER_QUEUE = 64
"""Lines waiting for a writer; one more is dropped."""
TASK_FIELDS = {
    "session_id": str,
    "id": int,
    "created_ms": int,
    "version": int,
    "state": str,
}
NO_ENDPOINT = {
    "outcome": "no_endpoint",
    "status": None,
    "message": "This session has no answer endpoint running: answer it in the session's"
    " My tasks pane (the fork's answer endpoint is off unless turned on).",
}
UNREACHABLE = {
    "outcome": "unreachable",
    "status": None,
    "message": "The session's answer endpoint did not answer: send the same answer again.",
}


def strict_json(raw: bytes):
    """`raw` as UTF-8 JSON with no repeated key and no NaN or Infinity; else ValueError.
    Keep in sync with mods/progress/hooks/web_control.py strict_json:
    tests/test_owner_request_cases.py."""

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
    """What is wrong with an answer from the page, naming the field and never what it held;
    None when it is one. The endpoint judges it again."""
    if not isinstance(request, dict):
        return "The body must be a JSON object."
    if any(key not in (*REQUIRED, *TEXTS) for key in request):
        return "The body has a field this server does not take."
    for key in REQUIRED:
        if key not in request:
            return f"{key} is missing."
    if not isinstance(request["request_id"], str) or not REQUEST_ID.fullmatch(
        request["request_id"]
    ):
        return "request_id must be 16 to 64 letters, digits, - or _."
    if not isinstance(request["session_id"], str) or not SESSION_ID.fullmatch(
        request["session_id"]
    ):
        return "session_id must be 1 to 64 letters, digits, - or _."
    for key, low in (("task_id", 1), ("created_ms", 0), ("version", 0)):
        if not is_whole(request[key], low):
            return f"{key} must be a whole number from {low} to 2^53-1."
    action = request["action"]
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
    return None


def unique_profiles(profiles):
    """The profiles, each directory once (by where it resolves)."""
    seen, out = set(), []
    for label, profile in profiles:
        real = os.path.realpath(profile)
        if real not in seen:
            seen.add(real)
            out.append((label, Path(profile)))
    return out


PROGRESS_SESSION = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
)


def progress_endpoints(profiles, session_id: str) -> list[tuple[str, str]]:
    """Private refresh descriptors in the selected profiles only, without aliases."""
    found = []
    if not PROGRESS_SESSION.fullmatch(session_id):
        return found
    for _, profile in unique_profiles(profiles):
        base = profile.resolve() / "progress-endpoint"
        try:
            directory = os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        except OSError:
            continue
        try:
            held = os.fstat(directory)
            if held.st_uid != os.getuid() or stat.S_IMODE(held.st_mode) != 0o700:
                continue
            fd = os.open(
                f"{session_id}.json",
                os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                dir_fd=directory,
            )
            try:
                held = os.fstat(fd)
                if (
                    not stat.S_ISREG(held.st_mode)
                    or held.st_uid != os.getuid()
                    or held.st_nlink != 1
                    or stat.S_IMODE(held.st_mode) != 0o600
                ):
                    continue
                raw = os.read(fd, MAX_ENTRY_BYTES + 1)
            finally:
                os.close(fd)
            if len(raw) > MAX_ENTRY_BYTES:
                continue
            entry = strict_json(raw)
            if not isinstance(entry, dict) or set(entry) != {
                "format",
                "session_id",
                "socket",
                "token",
            }:
                continue
            path, token = entry["socket"], entry["token"]
            if not (
                type(entry["format"]) is int
                and entry["format"] == 1
                and entry["session_id"] == session_id
                and isinstance(path, str)
                and isinstance(token, str)
                and re.fullmatch(r"[A-Za-z0-9_-]{43}", token)
                and re.fullmatch(r"[1-9][0-9]{0,9}\.sock", Path(path).name)
                and str(base / Path(path).name) == path
            ):
                continue
            held = os.stat(Path(path).name, dir_fd=directory, follow_symlinks=False)
            if (
                stat.S_ISSOCK(held.st_mode)
                and held.st_uid == os.getuid()
                and stat.S_IMODE(held.st_mode) == 0o600
            ):
                found.append((path, token))
        except (OSError, ValueError, RecursionError):
            continue
        finally:
            os.close(directory)
    return found


# Keep in sync with mods/progress/hooks/web_control.py owner_request and web-control.ts
# isOwnerRequest: one shared accept/refuse table, mods/progress/tests/owner-request-cases.ts.
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
        and PROGRESS_SESSION.fullmatch(request["session_id"]) is not None
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


OWNER_OUTCOMES = {
    "prepared": 200,
    "started": 200,
    "cancelled": 200,
    "rejected": 409,
    "disabled": 403,
    "gone": 410,
    "failed": 502,
    "busy": 503,
    "owner_timeout": 504,
}
REFRESH_OUTCOMES = {
    "refreshed": 200,
    "gone": 410,
    "failed": 502,
    "busy": 503,
    "refresh_timeout": 504,
}


def relay_progress(
    path: str, token: str, route: str, body: dict, outcomes: dict
) -> tuple[int, dict]:
    """Sends `body` exactly once to a Progress session's private `/v1/<route>` listener,
    never retried after a token or request may have been sent. Only one of `outcomes`
    with its own status is relayed; anything else is `<route>_unreachable`, unconfirmed."""
    conn = UnixHTTPConnection(path)
    try:
        conn.request(
            "POST",
            f"/v1/{route}",
            body=json.dumps(body).encode(),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )
        response = conn.getresponse()
        raw = response.read(1025)
        if len(raw) <= 1024:
            reply = strict_json(raw)
            if (
                isinstance(reply, dict)
                and set(reply) == {"outcome"}
                and isinstance(reply["outcome"], str)
                and outcomes.get(reply["outcome"]) == response.status
            ):
                return response.status, reply
    except (OSError, ValueError, RecursionError, http.client.HTTPException):
        pass
    finally:
        conn.close()
    return 502, {"outcome": f"{route}_unreachable"}


def profiles_ok(profiles) -> bool:
    """The page's profile selection: 1 to 32 distinct labels, sorted."""
    return (
        isinstance(profiles, list)
        and 0 < len(profiles) <= 32
        and all(isinstance(label, str) and 0 < len(label) <= 256 for label in profiles)
        and len(set(profiles)) == len(profiles)
        and profiles == sorted(profiles)
    )


def find_endpoints(profiles, session_id: str) -> list[tuple[Path, str, str]]:
    """[(profile, socket path, token)] from each well-formed answer endpoint entry of the
    session (format 2), in profile order. The entry must be a regular file of this user's;
    the socket it names must be, by lstat (no link followed at the last step), a socket of
    this user's, `<pid>.sock` directly in the entry's own directory. An entry whose path
    cannot even be looked at (a NUL, a lone surrogate, too long) is skipped like any other
    malformed one."""
    found = []
    for _, profile in unique_profiles(profiles):
        base = profile / "hitl-endpoint"
        try:
            fd = os.open(
                base / f"{session_id}.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            )
        except OSError:
            continue
        try:
            held = os.fstat(fd)
            if not stat.S_ISREG(held.st_mode) or held.st_uid != os.getuid():
                continue
            entry = json.loads(os.read(fd, MAX_ENTRY_BYTES + 1))
        except (OSError, ValueError, RecursionError):
            continue
        finally:
            os.close(fd)
        if not isinstance(entry, dict):
            continue
        path, token = entry.get("socket"), entry.get("token")
        if not (
            entry.get("format") == 2
            and entry.get("session_id") == session_id
            and isinstance(path, str)
            and isinstance(token, str)
            and TOKEN.fullmatch(token)
            and re.fullmatch(r"[0-9]{1,10}\.sock", Path(path).name)
        ):
            continue
        try:
            if os.path.realpath(Path(path).parent) != os.path.realpath(base):
                continue
            held = os.lstat(path)
        except (OSError, ValueError):
            continue
        if stat.S_ISSOCK(held.st_mode) and held.st_uid == os.getuid():
            found.append((profile, path, token))
    return found


class DeadlineSocket(socket.socket):
    """A Unix stream socket each of whose waits (connect, send, receive) is cut to what is
    left before one deadline, so a peer that drips bytes cannot stretch the exchange."""

    def __init__(self, deadline: float):
        super().__init__(socket.AF_UNIX, socket.SOCK_STREAM)
        self.deadline = deadline

    def left(self) -> None:
        left = self.deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError("past the relay's deadline")
        self.settimeout(left)

    def connect(self, address):
        self.left()
        super().connect(address)

    def sendall(self, data, flags=0):
        self.left()
        return super().sendall(data, flags)

    def recv_into(self, buffer, nbytes=0, flags=0):
        self.left()
        return super().recv_into(buffer, nbytes, flags)


class UnixHTTPConnection(http.client.HTTPConnection):
    """http.client over a Unix socket, the whole exchange held to RELAY_TIMEOUT_S."""

    def __init__(self, path: str):
        super().__init__("localhost", timeout=RELAY_TIMEOUT_S)
        self.socket_path = path
        self.deadline = time.monotonic() + RELAY_TIMEOUT_S

    def connect(self):
        self.sock = DeadlineSocket(self.deadline)
        self.sock.connect(self.socket_path)


def relayed_of(status: int, raw: bytes) -> dict:
    """What the endpoint answered, as the page is told it: its outcome and status, and its
    message, task and duplicate mark where it gave them in their contract shapes."""
    try:
        reply = json.loads(raw)
    except (ValueError, RecursionError):
        return UNREACHABLE
    outcome = reply.get("outcome") if isinstance(reply, dict) else None
    if not isinstance(outcome, str) or not OUTCOME.fullmatch(outcome):
        return UNREACHABLE
    out = {"outcome": outcome, "status": status}
    if isinstance(reply.get("message"), str):
        out["message"] = reply["message"][:500]
    task = reply.get("task")
    if isinstance(task, dict) and all(
        type(task.get(key)) is kind for key, kind in TASK_FIELDS.items()
    ):
        out["task"] = {key: task[key] for key in TASK_FIELDS}
    if reply.get("duplicate") is True:
        out["duplicate"] = True
    return out


def relay(socket_path: str, token: str, request: dict) -> dict | None:
    """Sends the answer to the session's endpoint as this server's (ANSWER_SOURCE), and
    says what came back, all within RELAY_TIMEOUT_S. None when the connect fails, so nothing
    was sent: a listener killed outright leaves its entry behind, and another entry may be
    tried. Once anything may have been sent, what goes wrong is `unreachable`."""
    body = json.dumps({**request, "source": ANSWER_SOURCE}, ensure_ascii=True).encode()
    conn = UnixHTTPConnection(socket_path)
    try:
        try:
            conn.connect()
        except OSError:
            return None
        conn.request(
            "POST",
            "/v1/answer",
            body=body,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )
        response = conn.getresponse()
        raw = response.read(MAX_REPLY_BYTES + 1)
        if len(raw) > MAX_REPLY_BYTES:
            return UNREACHABLE
        return relayed_of(response.status, raw)
    except (OSError, http.client.HTTPException):
        return UNREACHABLE
    finally:
        conn.close()


class Writers:
    """Runs the decision-log writer for each line given: at most MAX_WRITERS at once, each in
    a process group of its own, killed with everything it started (by group) at
    LOG_TIMEOUT_S. Up to WRITER_QUEUE lines wait for a writer; a line past that is dropped,
    so an answer never waits for its line. `stop` kills the writers running and drops what
    waits."""

    def __init__(self):
        self.waiting: queue.Queue = queue.Queue(WRITER_QUEUE)
        self.running: set[subprocess.Popen] = set()
        self.lock = threading.Lock()
        self.is_stopped = False
        for _ in range(MAX_WRITERS):
            threading.Thread(target=self.work, daemon=True).start()

    def submit(self, writer: Path, profile: Path, line: dict) -> None:
        with contextlib.suppress(queue.Full):
            self.waiting.put_nowait((writer, profile, line))

    def work(self) -> None:
        while True:
            self.run(*self.waiting.get())

    def run(self, writer: Path, profile: Path, line: dict) -> None:
        with self.lock:
            if self.is_stopped:
                return
            try:
                proc = subprocess.Popen(
                    [sys.executable, "-I", str(writer)],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    env={**os.environ, "CLAUDE_CONFIG_DIR": str(profile)},
                    start_new_session=True,
                )
            except OSError:
                return
            self.running.add(proc)
        try:
            proc.communicate(json.dumps(line).encode(), timeout=LOG_TIMEOUT_S)
        except (subprocess.TimeoutExpired, OSError):
            with self.lock:
                self.kill(proc)
            proc.wait()
        finally:
            with self.lock:
                self.running.discard(proc)

    @staticmethod
    def kill(proc: subprocess.Popen) -> None:
        """Kills the writer's process group while the writer is not yet reaped, so its pid,
        which names the group, is still its own."""
        if proc.returncode is None:
            with contextlib.suppress(OSError):
                os.killpg(proc.pid, signal.SIGKILL)

    def stop(self) -> None:
        with self.lock:
            self.is_stopped = True
            for proc in self.running:
                self.kill(proc)


def log_answer(writers: Writers, profile: Path, request: dict, relayed: dict) -> None:
    """One decision-log line for an answer from the dashboard, through the profile's writer
    (`<profile>/hooks/decision_log.py`, docs/decision-log.md): ids and the outcome, never the
    answer, option or reason. Handed to `writers` after the reply was tried: a writer
    missing, failing or hung changes and delays nothing."""
    writer = profile / "hooks" / "decision_log.py"
    if not writer.is_file():
        return
    line = {
        "hook": "dashboard",
        "decision": "answer",
        "reason": f"{request['action']} on task #{request['task_id']} from the dashboard:"
        f" {relayed['outcome']}",
        "session": request["session_id"],
        "inputs": {
            "id": request["task_id"],
            "created_ms": request["created_ms"],
            "action": request["action"],
            "outcome": relayed["outcome"],
            "status": relayed["status"],
            "source": ANSWER_SOURCE,
        },
    }
    writers.submit(writer, profile, line)


# --- HTTP ------------------------------------------------------------------------------------

SECURITY_HEADERS = (
    ("Cache-Control", "no-store"),
    ("X-Content-Type-Options", "nosniff"),
    # Not no-referrer: under it a browser sends `Origin: null` with the PIN form, which
    # /unlock refuses. same-origin keeps the origin on the page's own requests and sends no
    # referrer anywhere else.
    ("Referrer-Policy", "same-origin"),
    ("X-Frame-Options", "DENY"),
    (
        "Content-Security-Policy",
        (
            "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self';"
            " style-src 'self'; form-action 'self'; base-uri 'none';"
            " frame-ancestors 'none'"
        ),
    ),
    ("Connection", "close"),
)
_busy = b'{"outcome":"busy","message":"Too many requests at once."}'
BUSY = (
    b"HTTP/1.0 503 Service Unavailable\r\nContent-Type: application/json\r\n"
    + b"".join(f"{name}: {value}\r\n".encode() for name, value in SECURITY_HEADERS)
    + b"Content-Length: %d\r\n\r\n%s" % (len(_busy), _busy)
)
"""Sent whole, before anything is read, to a connection past MAX_CONNECTIONS."""
FORBIDDEN = (403, {"outcome": "forbidden"})
LENGTH = re.compile(r"[0-9]{1,9}")
MAX_PIN_FORM = 1024
LOCKED = (401, {"outcome": "locked"})

PAGES: dict[str, str] = {}
STATIC = Path(__file__).resolve().parent / "static"
"""The page's files: pin.html, main.html (with `{{message}}` and `{{csrf}}` filled in,
escaped), app.js, favicon.svg and app.css. Read once, at the start; without app.css (the page before its
design) /app.css is 404."""


def page_of(name: str, **values: str) -> str:
    text = PAGES[name]
    for key, value in values.items():
        text = text.replace("{{" + key + "}}", html.escape(value))
    return text


_TOKEN = rb"[!#$%&'*+\-.^_`|~0-9A-Za-z]+"
REQUEST_LINE = re.compile(_TOKEN + rb" [\x21-\x7e]+ HTTP/1\.[01]\r\n")
"""method SP target SP version CRLF (RFC 9112), one space each, nothing else."""
HEADER_LINE = re.compile(_TOKEN + rb":[\t\x20-\x7e\x80-\xff]*\r\n")
"""name ":" value CRLF: a token name with nothing before the colon, a value of visible
characters, spaces, tabs and obs-text (RFC 9110), and no other control byte: no bare CR or LF,
no NUL, no leading whitespace (an obsolete folded line)."""


class HeadReader:
    """A connection's reader, strict about the request's head: the request line and every
    header line must be of the shapes above, ended by CRLF, and the head by an empty line.
    A line that is not, or a head cut off before its end, marks the head refused (answered
    400, never parsed leniently: the identity check rests on reading the head as Tailscale
    Serve wrote it, and http.server with the email package reads a bare CR, a colon-less
    line or a folded one in ways that differ from Serve's Go parser and between Python
    versions). The head is held to MAX_HEAD_BYTES and MAX_HEADERS too: past either,
    http.server answers 431 (its own refusal of a head too large). The body is read past
    it, by its Content-Length."""

    def __init__(self, raw):
        self.raw = raw
        self.lines = 0
        self.size = 0
        self.refused = False
        self.target = None

    def readline(self, limit=-1):
        if self.refused:
            return b"\r\n"  # nothing more of a refused head is read
        line = self.raw.readline(limit)
        self.lines += 1
        self.size += len(line)
        # The request line is checked by http.server itself (414); from the first header on,
        # what this raises is answered 431.
        if self.lines > 1 and self.size > MAX_HEAD_BYTES:
            raise http.client.LineTooLong("the request head")
        if self.lines > MAX_HEADERS + 2:
            raise http.client.HTTPException("too many headers")
        if self.lines == 1:
            # A connection closed before it sent anything is let go by http.server itself.
            self.refused = bool(line) and not REQUEST_LINE.fullmatch(line)
            if not self.refused and line:
                # The target as sent: http.server's own `path` folds a leading `//` to `/`.
                self.target = line.split(b" ")[1].decode("ascii")
            return line
        if line == b"\r\n" or HEADER_LINE.fullmatch(line):
            return line
        self.refused = True
        return b"\r\n"

    def __getattr__(self, name):
        return getattr(self.raw, name)


ICON_COUNT = re.compile(r"/favicon\.svg\?n=([1-9][0-9]?)")
"""The page icon with a count badge: `?n=` and 1 to 99, nothing else (#188)."""


def page_icon(target: str):
    """The page icon for `/favicon.svg`, `/favicon.ico` (T3 asks a page for that one when
    it names none) and `/favicon.svg?n=<1..99>`, which draws the count of things waiting
    on the owner into an amber badge. Served before the PIN, as app.js is: it holds no
    data, and a browser tab asks for it without the session cookie."""
    icon = PAGES["favicon.svg"]
    if "?" not in target:
        return 200, icon, (("Content-Type", "image/svg+xml"),)
    found = ICON_COUNT.fullmatch(target)
    if found is None:
        return 404, {"outcome": "not_found"}
    count = found.group(1)
    badge = (
        '<circle cx="11.5" cy="4.5" r="4.5" fill="#ffb224" stroke="#000" stroke-width="1"/>'
        f'<text x="11.5" y="7.1" text-anchor="middle" font-family="Arial,sans-serif" '
        f'font-weight="700" font-size="{7.5 if len(count) == 1 else 5.6}" fill="#000">'
        f"{count}</text>"
    )
    return (
        200,
        icon.replace("</svg>", badge + "</svg>", 1),
        (("Content-Type", "image/svg+xml"),),
    )


class Handler(BaseHTTPRequestHandler):
    server: "Server"
    server_version = "dashboard"
    timeout = READ_DEADLINE_S

    def version_string(self):
        return self.server_version

    def log_message(self, format, *args):
        """Nothing is logged: no path, no header, no answer."""

    def setup(self):
        super().setup()
        self.rfile = HeadReader(self.rfile)
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

    def parse_request(self):
        """http.server's reading of the head, then: a head still arriving at the deadline is
        408, and one HeadReader refused is 400."""
        if not super().parse_request():
            return False
        if self.is_late:
            self.reply(408, {"outcome": "timeout"})
            return False
        if self.rfile.refused:
            self.reply(400, {"outcome": "bad_request"})
            return False
        return True

    def send_error(self, code, message=None, explain=None):
        """http.server's own refusals (a malformed request line, headers too long or too
        many), as JSON that repeats nothing of the request."""
        outcome = {408: "timeout", 414: "too_large", 431: "too_large"}.get(
            code, "bad_request"
        )
        self.reply(code, {"outcome": outcome})

    def __getattr__(self, name):
        # Every method reaches the same checks; http.server would answer one it has no
        # `do_` for with a page of its own.
        if name.startswith("do_"):
            return self.dispatch
        raise AttributeError(name)

    def dispatch(self):
        self.after = None
        try:
            result = self.judge()
        except Exception:  # noqa: BLE001 (a request that failed gets a plain 500, no trace)
            result = (500, {"outcome": "error"})
        try:
            self.reply(*result)
        finally:
            # The answer may have reached the session though the browser left: its line is
            # handed on whether or not the reply could be written.
            if self.after is not None:
                self.after()

    def one(self, name: str) -> str | None:
        """The header's value when it was sent exactly once, else None."""
        values = self.headers.get_all(name) or []
        return values[0] if len(values) == 1 else None

    def is_through_serve(self) -> bool:
        """Whether the request came as Tailscale Serve forwards one from the owner: Host is
        Serve's own for a socket, X-Forwarded-Host one of the configured hosts (a page that
        rebinds a name of its own to the tailnet address is refused), no Funnel mark, and one
        Tailscale-User-Login holding exactly the login Tailscale named at start."""
        config = self.server.config
        return (
            self.one("Host") == SERVE_HOST
            and self.one("X-Forwarded-Host") in config.hosts
            and not self.headers.get_all("Tailscale-Funnel-Request")
            and self.one("Tailscale-User-Login") == self.server.owner
        )

    def is_admitted(self) -> bool:
        if self.server.local_host is None:
            return self.is_through_serve()
        # Direct HTTP has no trusted identity proxy. Only the exact bound authority
        # is accepted; a later PIN session is still required for reads and actions.
        return self.one("Host") == self.server.local_host and not any(
            name.lower().startswith(("tailscale-", "x-forwarded-"))
            or name.lower() == "forwarded"
            for name in self.headers
        )

    def judge(self):
        """What a request gets: (status, payload) or (status, payload, headers), the
        payload JSON or, as text, a page."""
        if not self.is_admitted():
            return FORBIDDEN
        route = (self.command, self.rfile.target)
        session = self.server.gate.session(self.cookie())
        if route == ("GET", "/"):
            if session is None:
                return self.page(page_of("pin.html", message=""))
            token = self.server.gate.csrf_token(session)
            return self.page(page_of("main.html", csrf=token))
        if route == ("GET", "/app.js"):
            return (
                200,
                PAGES["app.js"],
                (("Content-Type", "text/javascript; charset=utf-8"),),
            )
        if self.command == "GET" and self.rfile.target.partition("?")[0] in (
            "/favicon.svg",
            "/favicon.ico",
        ):
            return page_icon(self.rfile.target)
        if route == ("GET", "/app.css") and "app.css" in PAGES:
            return 200, PAGES["app.css"], (("Content-Type", "text/css; charset=utf-8"),)
        if route == ("POST", "/unlock"):
            return self.unlock()
        if route == ("POST", "/api/progress/owner"):
            return LOCKED if session is None else self.owner_progress(session)
        if route == ("POST", "/api/progress/refresh"):
            return LOCKED if session is None else self.refresh_progress(session)
        if route == ("POST", "/api/answer"):
            return LOCKED if session is None else self.answer(session)
        if (
            self.command == "GET"
            and self.rfile.target.partition("?")[0] == "/api/document"
        ):
            return LOCKED if session is None else self.document()
        if route in (
            ("GET", "/api/tasks"),
            ("GET", "/api/progress"),
            ("GET", "/api/usage"),
        ):
            if session is None:
                return LOCKED
            return 200, self.server.reads[route[1]]()
        return 404, {"outcome": "not_found"}

    def document(self):
        try:
            query = urllib.parse.parse_qs(
                self.rfile.target.partition("?")[2],
                keep_blank_values=True,
                strict_parsing=True,
                max_num_fields=8,
            )
            if set(query) != {"session_id", "profiles", "number", "repo"} or any(
                len(one) != 1 for one in query.values()
            ):
                raise ValueError
            session_id = query["session_id"][0]
            raw_number = query["number"][0]
            repo = query["repo"][0]
            labels = json.loads(query["profiles"][0])
            if (
                not SESSION_ID.fullmatch(session_id)
                or not re.fullmatch(r"[1-9][0-9]{0,9}", raw_number)
                or not DOCUMENT_REPO.fullmatch(repo)
            ):
                raise ValueError
            number = int(raw_number)
            if (
                number > 2**31 - 1
                or not isinstance(labels, list)
                or not all(isinstance(one, str) and one for one in labels)
            ):
                raise ValueError
            if labels != sorted(set(labels)):
                raise ValueError
        except (ValueError, TypeError, RecursionError):
            return 400, {"outcome": "bad_request"}
        try:
            target = document_target(
                self.server.profiles, session_id, labels, number, repo
            )
            kind, repo, _ = target
            title, text = self.server.documents.fetch(repo, number)
            if (
                document_target(self.server.profiles, session_id, labels, number, repo)
                != target
            ):
                raise DocumentFailure(
                    409,
                    "changed",
                    "The published document selection changed. Refresh Progress.",
                )
            return 200, {
                "outcome": "ok",
                "kind": kind,
                "repo": repo,
                "number": number,
                "title": title,
                "text": text,
                "fetched_at": int(time.time() * 1000),
            }
        except DocumentFailure as error:
            return error.status, {"outcome": error.outcome, "message": error.message}

    def answer(self, session: str):
        """An answer from the page, sent to the session's answer endpoint; what it said is
        relayed, and one decision-log line written after the reply."""
        if not self.is_same_origin():
            return FORBIDDEN
        if not self.server.gate.is_csrf(session, self.one("X-CSRF-Token")):
            return 403, {"outcome": "csrf"}
        if not self.is_media("application/json"):
            return 415, {"outcome": "unsupported_media_type"}
        raw, refusal = self.read_body(MAX_BODY)
        if refusal is not None:
            return refusal
        try:
            request = strict_json(raw)
        except ValueError:
            return 400, {"outcome": "bad_request"}
        error = shape_error(request)
        if error is not None:
            return 400, {"outcome": "bad_request", "message": error}
        profiles = self.server.profiles
        relayed, profile = None, None
        # Entries in profile order; one whose socket refuses the connect (nothing was sent)
        # gives way to the next, and the first that took the answer is the last tried.
        for found, path, token in find_endpoints(profiles, request["session_id"]):
            profile = profile or found
            relayed = relay(path, token, request)
            if relayed is not None:
                profile = found
                break
        if relayed is None:
            # The line goes to the first entry's profile, or with no entry the first one's.
            relayed = NO_ENDPOINT
            if profile is None and profiles:
                profile = unique_profiles(profiles)[0][1]
        if profile is not None:
            writers = self.server.writers
            self.after = lambda: log_answer(writers, profile, request, relayed)
        return 200, relayed

    def owner_progress(self, session: str):
        """An explicitly opted-in owner action on current native metadata."""
        if not self.is_same_origin():
            return FORBIDDEN
        if not self.server.gate.is_csrf(session, self.one("X-CSRF-Token")):
            return 403, {"outcome": "csrf"}
        if not self.is_media("application/json"):
            return 415, {"outcome": "unsupported_media_type"}
        raw, refusal = self.read_body(4096)
        if refusal is not None:
            return refusal
        try:
            request = strict_json(raw)
        except ValueError:
            return 400, {"outcome": "bad_request"}
        if not (
            isinstance(request, dict)
            and "profiles" in request
            and owner_request(
                {key: value for key, value in request.items() if key != "profiles"}
            )
            and profiles_ok(request["profiles"])
        ):
            return 400, {"outcome": "bad_request"}
        selected = self.selected(request)
        if len(selected) != 1:
            return 409, {"outcome": "selection_changed"}
        snapshot = selected[0]["snapshot"]
        owner = snapshot.get("owner")
        if not owner or not owner["enabled"]:
            return 403, {"outcome": "disabled"}
        target = next(
            (
                one
                for one in owner["targets"]
                if one["repo"].lower() == request["repo"].lower()
                and all(one[key] == request[key] for key in ("pull", "head", "base"))
            ),
            None,
        )
        if target is None:
            return 409, {"outcome": "rejected"}
        if request["action"] != "prepare":
            ship = owner["ship"]
            if (
                not ship
                or ship["step"] != "confirm"
                or ship.get("confirmation_id") != request["confirmation_id"]
                or ship["repo"].lower() != request["repo"].lower()
                or any(ship[key] != request[key] for key in ("pull", "head", "base"))
            ):
                return 409, {"outcome": "rejected"}
        endpoints = progress_endpoints(
            [
                (label, path)
                for label, path in self.server.profiles
                if label in request["profiles"]
            ],
            request["session_id"],
        )
        if len(endpoints) > 1:
            return 409, {"outcome": "ambiguous_endpoint"}
        if endpoints:
            status, reply = relay_progress(
                *endpoints[0],
                "owner",
                {key: value for key, value in request.items() if key != "profiles"},
                OWNER_OUTCOMES,
            )
            # Selection can change while the native callback is awaiting GitHub. The
            # action was already sent (a confirm may have started a merge): report what
            # the native session said, flagged, never a refusal in its place.
            current = self.selected(request)
            if (
                len(current) != 1
                or current[0]["snapshot"]["goal"] is None
                or current[0]["snapshot"]["goal"]["repo"] != snapshot["goal"]["repo"]
                or current[0]["snapshot"]["goal"]["numbers"]
                != snapshot["goal"]["numbers"]
            ):
                return status, {**reply, "selection_changed": True}
            return status, reply
        return 409, {
            "outcome": "no_endpoint",
            "message": "Open Progress in this session with web_controls enabled and web_owner_workflow enabled before using owner actions.",
        }

    def refresh_progress(self, session: str):
        """Explicit metadata refresh of one already-published native session."""
        if not self.is_same_origin():
            return FORBIDDEN
        if not self.server.gate.is_csrf(session, self.one("X-CSRF-Token")):
            return 403, {"outcome": "csrf"}
        if not self.is_media("application/json"):
            return 415, {"outcome": "unsupported_media_type"}
        raw, refusal = self.read_body(4096)
        if refusal is not None:
            return refusal
        try:
            request = strict_json(raw)
        except ValueError:
            return 400, {"outcome": "bad_request"}
        if not (
            isinstance(request, dict)
            and set(request) == {"session_id", "profiles"}
            and isinstance(request["session_id"], str)
            and PROGRESS_SESSION.fullmatch(request["session_id"])
            and profiles_ok(request["profiles"])
        ):
            return 400, {"outcome": "bad_request"}
        if len(self.selected(request)) != 1:
            return 409, {"outcome": "selection_changed"}
        endpoints = progress_endpoints(
            [
                (label, path)
                for label, path in self.server.profiles
                if label in request["profiles"]
            ],
            request["session_id"],
        )
        if len(endpoints) > 1:
            return 409, {"outcome": "ambiguous_endpoint"}
        if endpoints:
            return relay_progress(
                *endpoints[0],
                "refresh",
                {"session_id": request["session_id"]},
                REFRESH_OUTCOMES,
            )
        return 409, {
            "outcome": "no_endpoint",
            "message": "Open Progress in this session with web_controls enabled before refreshing from the web.",
        }

    def selected(self, request) -> list:
        """The published sessions of the request's exact session and profile selection."""
        return [
            item
            for item in read_progress(self.server.profiles)["sessions"]
            if item["session_id"] == request["session_id"]
            and sorted(item["profiles"]) == request["profiles"]
            and "snapshot" in item
        ]

    def cookie(self) -> str | None:
        """The session cookie's value when the request carries it exactly once."""
        found = []
        for header in self.headers.get_all("Cookie") or []:
            for part in header.split(";"):
                name, mark, value = part.strip().partition("=")
                if mark and name == self.server.cookie_name:
                    found.append(value)
        return found[0] if len(found) == 1 else None

    def is_same_origin(self) -> bool:
        """One Origin header naming the host the page was opened at, over plain HTTP."""
        host = self.server.local_host or self.one("X-Forwarded-Host")
        return self.one("Origin") == f"http://{host}"

    def is_media(self, media: str) -> bool:
        """One Content-Type header of `media`, with no parameter but charset=utf-8."""
        value = self.one("Content-Type")
        if value is None:
            return False
        kind, _, params = value.partition(";")
        charset = params.replace(" ", "").lower()
        return kind.strip().lower() == media and charset in ("", "charset=utf-8")

    def read_body(self, cap: int) -> tuple[bytes, tuple | None]:
        """The body, by one plain Content-Length up to `cap`, read before the deadline; or
        the refusal."""
        lengths = self.headers.get_all("Content-Length") or []
        if self.headers.get_all("Transfer-Encoding"):
            return b"", (411, {"outcome": "length_required"})
        if not lengths:
            return b"", (411, {"outcome": "length_required"})
        if len(lengths) != 1 or not LENGTH.fullmatch(lengths[0].strip()):
            return b"", (400, {"outcome": "bad_request"})
        length = int(lengths[0])
        if length > cap:
            return b"", (413, {"outcome": "too_large"})
        data = bytearray()
        with contextlib.suppress(OSError):
            while len(data) < length and (
                chunk := self.rfile.read1(length - len(data))
            ):
                data += chunk
        self.deadline.cancel()
        if len(data) < length or self.is_late:
            return b"", (408, {"outcome": "timeout"})
        return bytes(data), None

    def unlock(self):
        """The PIN form: a cookie for the right PIN, the tries left for a wrong one, the wait
        while locked. A form from another origin, or not one PIN, is not counted."""
        if not self.is_same_origin():
            return FORBIDDEN
        if not self.is_media("application/x-www-form-urlencoded"):
            return 415, {"outcome": "unsupported_media_type"}
        raw, refusal = self.read_body(MAX_PIN_FORM)
        if refusal is not None:
            return refusal
        try:
            form = urllib.parse.parse_qs(
                raw.decode("ascii"),
                keep_blank_values=True,
                strict_parsing=True,
                errors="strict",
                max_num_fields=4,
            )
        except ValueError:
            form = {}
        given = form.get("pin", [])
        if set(form) != {"pin"} or len(given) != 1 or not given[0]:
            return self.page(page_of("pin.html", message="Send one PIN."), 400)
        verdict, value = self.server.gate.unlock(given[0])
        if verdict == "ok":
            name = self.server.cookie_name
            cookie = f"{name}={value}; Path=/; Max-Age={SESSION_S}; HttpOnly; SameSite=Strict"
            return 303, "", (("Location", "/"), ("Set-Cookie", cookie))
        if verdict == "wrong":
            tries = "1 try" if value == 1 else f"{value} tries"
            message = f"Wrong PIN: {tries} left before a lockout."
            return self.page(page_of("pin.html", message=message), 401)
        message = f"Too many wrong PINs: try again in {math.ceil(value / 60)} min."
        return self.page(
            page_of("pin.html", message=message), 429, (("Retry-After", str(value)),)
        )

    def page(self, html: str, status: int = 200, headers: tuple = ()):
        return status, html, (("Content-Type", "text/html; charset=utf-8"), *headers)

    def reply(self, status: int, payload, headers: tuple = ()) -> None:
        """Sends the reply: a page as text, JSON as bytes already encoded or as a value."""
        if isinstance(payload, str):
            data = payload.encode()
        else:
            data = payload if isinstance(payload, bytes) else json_bytes(payload)
            headers = (("Content-Type", "application/json"), *headers)
        self.close_connection = True
        self.send_response(status)
        for name, value in (
            ("Content-Length", str(len(data))),
            *SECURITY_HEADERS,
            *headers,
        ):
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    """The default Unix-socket server; `local_port` is given only by LocalServer."""

    daemon_threads = True
    request_queue_size = 64

    def __init__(
        self,
        path: Path,
        config: Config,
        profiles,
        state: Path,
        owner: str,
        *,
        local_port: int | None = None,
    ):
        # Never a server that admits a request with no login, or any login, by mistake.
        if not is_login(owner):
            raise ValueError("owner must be a login (is_login)")
        self.path = path
        self.config = config
        self.owner = owner
        self.local_port = local_port
        self.local_host = None
        self.profiles = profiles
        self.state = state
        self.lock_fd: int | None = None
        self.is_bound = False
        # The state directory's lock comes first: a server that cannot take it has read and
        # written none of the state files (the secret, the lockout, the socket), so it can
        # never put back an older lockout over the running server's.
        self.take_lock()
        try:
            # A local cookie cannot be reused on the Tailscale transport, even when
            # both modes deliberately share state. NUL cannot occur in a login.
            gate_owner = owner if local_port is None else f"loopback\0{os.getuid()}"
            self.gate = Gate(state, config.pin, gate_owner)
            self.slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
            self.writers = Writers()
            self.documents = DocumentReader()
            self.reads = {
                "/api/tasks": SharedRead(
                    lambda: json_bytes(read_tasks(profiles, int(time.time() * 1000)))
                ),
                "/api/progress": SharedRead(
                    lambda: json_bytes(
                        read_progress_states(profiles, int(time.time() * 1000))
                    )
                ),
                "/api/usage": SharedRead(
                    lambda: json_bytes(read_usage(profiles, time.time()))
                ),
            }
            self.cookie_name = COOKIE
            if local_port is None:
                super().__init__(str(path), Handler)
            else:
                super().__init__(("127.0.0.1", local_port), Handler)
                self.local_host = f"127.0.0.1:{self.server_address[1]}"
                # A browser sends a 127.0.0.1 cookie to every port; the port in the
                # name keeps local servers on other ports from overwriting this one's.
                self.cookie_name = f"{COOKIE}-{self.server_address[1]}"
        except BaseException:
            self.let_go()
            raise

    def take_lock(self):
        """Holds the state directory's lock (`dashboard.lock`) for the server's life, or stops
        it in one line, having touched nothing else in the directory."""
        if self.local_port is None and len(os.fsencode(self.path)) > MAX_SOCKET_PATH:
            raise SystemExit(
                f"{NAME}: the socket path {self.path} is too long (at most"
                f" {MAX_SOCKET_PATH} bytes): use a shorter --state-dir"
            )
        lock = self.state / LOCK_NAME
        try:
            self.lock_fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        except OSError as error:
            raise SystemExit(
                f"{NAME}: cannot open {lock} ({error.strerror or error}): remove it if it"
                " is not a file of yours"
            ) from None
        try:
            fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.let_go()
            raise SystemExit(
                f"{NAME}: {self.path} is already served by another process"
            ) from None

    def let_go(self):
        if self.lock_fd is not None:
            os.close(self.lock_fd)
            self.lock_fd = None

    def server_bind(self):
        """Binds the socket 0600 from its first moment (the umask), under the state
        directory's lock (taken in __init__), so two servers starting together cannot take
        away each other's socket. A socket left at the name that refuses a connect is a dead
        server's and is taken away; one that answers stops this server, and so does anything
        at the name that is not a socket."""
        if self.local_port is not None:
            return super().server_bind()
        if os.path.lexists(self.path):
            if not stat.S_ISSOCK(os.lstat(self.path).st_mode):
                raise SystemExit(
                    f"{NAME}: {self.path} is there and is not a socket: remove it"
                )
            if not is_refused(self.path):
                raise SystemExit(
                    f"{NAME}: {self.path} is already served by another process"
                )
            self.path.unlink()
        mask = os.umask(0o177)
        try:
            super().server_bind()
        finally:
            os.umask(mask)
        self.is_bound = True
        os.chmod(self.path, 0o600)

    def server_close(self):
        """Closes the socket and, when this server bound it, takes its name away while it
        still holds the lock (so the name is its own); then lets the lock go. socketserver
        calls this too when binding failed: nothing at the name is touched then."""
        self.documents.stop()
        super().server_close()
        if self.is_bound:
            self.path.unlink(missing_ok=True)
            self.is_bound = False
        self.let_go()

    def process_request(self, request, client_address):
        # On the accepting thread: a connection turned away is told so and closed, never
        # read from or waited on, so no client can hold this thread.
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
        read is read away first, for DRAIN_S at most, so the close resets nothing."""
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
        """A request that failed is dropped; nothing is printed."""


class LocalServer(Server):
    """Explicit `--local` mode: the same server on literal IPv4 loopback TCP (no Unix
    socket), restartable at once on its port."""

    address_family = socket.AF_INET
    allow_reuse_address = True

    def __init__(self, path, config, profiles, state, owner, *, port: int):
        super().__init__(path, config, profiles, state, owner, local_port=port)


def profile_arg(text: str):
    label, mark, path = text.partition("=")
    if not mark or not label or not path:
        raise argparse.ArgumentTypeError("--profile takes LABEL=DIR")
    return label, Path(path)


def default_profiles():
    """The effective profile alone, in both modes: CLAUDE_CONFIG_DIR, else ~/.claude.
    Several profiles are named explicitly (the config's `profiles`, or --profile)."""
    profile = Path(
        os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude"
    ).expanduser()
    return [(label_of(profile), profile)]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="dashboard/server.py", description=__doc__)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument(
        "--local",
        action="store_true",
        help="serve direct HTTP on 127.0.0.1 only, without Tailscale (PIN required)",
    )
    parser.add_argument(
        "--port",
        type=int,
        help=f"local HTTP port (default: {PORT}; 0 chooses a free port)",
    )
    parser.add_argument(
        "--profile",
        type=profile_arg,
        action="append",
        help="LABEL=DIR, repeatable; replaces the config's profiles (default: the config's,"
        " else CLAUDE_CONFIG_DIR or ~/.claude)",
    )
    args = parser.parse_args(argv)
    if args.port is not None:
        if not args.local:
            parser.error("--port requires --local")
        if not 0 <= args.port <= 65535:
            parser.error("--port must be between 0 and 65535")

    def leave(signum, frame):
        raise SystemExit(0)

    # Before anything runs, so a stop at any point unwinds through the cleanups set up so
    # far (the Tailscale command's process group, then the writers' and the socket's; a stop
    # while the server is built can leave the socket file, which the next start replaces).
    # SIGCHLD back to its default: a parent that ignores it leaves it ignored across exec,
    # and then the kernel reaps the Tailscale command before its exit status is read.
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    for signum in TERMINATING:
        signal.signal(signum, leave)
    # Only the default paths fall back to the phone view's: a path given is used as it is.
    config_path = args.config or config_or_old(default_config_path())
    config = load_config(config_path, local=args.local)
    # Read once, kept in memory only; a new login takes effect when the server restarts.
    owner = "local" if args.local else tailscale_login()
    for name in ("pin.html", "main.html", "app.js", "favicon.svg"):
        PAGES[name] = (STATIC / name).read_text(encoding="utf-8")
    with contextlib.suppress(FileNotFoundError):
        PAGES["app.css"] = (STATIC / "app.css").read_text(encoding="utf-8")
    state = private_dir(args.state_dir or state_or_old(default_state_dir()))
    profiles = args.profile or config.profiles or default_profiles()
    if args.local:
        port = PORT if args.port is None else args.port
        server = LocalServer(
            state / SOCKET_NAME, config, profiles, state, owner, port=port
        )
    else:
        server = Server(state / SOCKET_NAME, config, profiles, state, owner)
    try:
        address = f"http://{server.local_host}" if args.local else server.path
        print(f"{NAME}: listening on {address}", flush=True)
        if args.local:
            print(f"{NAME}: local access requires the configured PIN", flush=True)
        else:
            print(
                f"{NAME}: admitting only the Tailscale user this machine is logged in as"
                " (read at start: restart the server after logging in as someone else)",
                flush=True,
            )
        server.serve_forever(poll_interval=0.2)
    finally:
        server.writers.stop()
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
