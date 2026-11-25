# Human in the loop (fork)

A local fork of [human-in-the-loop](https://github.com/tzafrir/human-in-the-loop) 0.1.10 by Tzafrir Rehan (MIT, see `LICENSE` and `UPSTREAM.md`). The upstream text below is kept; this section says what differs. The launch media (`media/`, `docs/assets/`) is left out.

## What differs from upstream

| | Upstream 0.1.10 | This fork |
|---|---|---|
| `why`, `done_when` over 300 characters | silently cut to 300 | refused: `why is 412 characters; the limit is 300. Shorten it and put the rest in detail.` |
| `detail` (new, optional) | none | up to 4000 characters, line breaks kept; over it is refused (`detail is 4001 characters; the limit is 4000.`) |
| Option length | 60 | 120 |
| Options per `choose` task | 2 to 4 | 2 to 6 |
| Decision log | none | one line per refusal, per accepted task and per answer through the endpoint |
| Answer endpoint | none | off unless turned on: answers from another program on this machine, over a Unix socket in the profile (see Answer endpoint) |
| Archive and Restore | none | **Archive** takes an open task out of the open lists unanswered, and sends Claude nothing; **Restore** brings it back; 7 days after it was archived it is deleted (see Archive) |
| Dashboard status, start and stop | none | a line in the status line, the My tasks pane (with a button) and the progress pane, `/overview web\|start\|stop` (the Progress mod's command, through this plugin's `dashboard` tool), and a copy-address row in the desktop menu (see Dashboard) |

Unchanged: at most 5 open tasks (`MAX_OPEN`), titles up to 80 characters (`MAX_TITLE`).

Text is measured after whitespace is collapsed to single spaces (for `detail`, after stray control characters are removed and runs of blank lines cut to one), which is the text the task keeps.

### Where each thing goes (the tool description tells Claude the same)

- `title`: the ask, an imperative.
- `why`: one sentence. The card shows title and why only.
- `detail`: the full picture. A task that has one shows a **Full picture** button (key `f`) on its card; pressed, the pane shows the whole detail under the card, and **Back** (also `f`) hides it. A long detail makes the pane as tall as its row cap (18 rows); the pane scrolls the rest.

### Archive

Answering, marking done or rejecting a task is sent to the session that asked, and a live session reads it as a message and goes back to work. **Archive** clears a task without that (issue #187):

- **Where:** the selected task's **Archive** button in the My tasks pane (key `a`), `/my-tasks archive <n>`, and the dashboard's **Archive** (through the answer endpoint, below). It applies to an open task only.
- **Nothing is sent.** The task stays `open` with an `archivedMs` time; no update is marked for Claude, so no message, digest or turn follows, and the status line and the open lists leave it out. A toast (or `/my-tasks`'s reply) says it was archived and until when it can be restored.
- **Archived (n):** a collapsed section at the foot of the pane, also shown with no open task when `/my-tasks` opens the pane, lists each archived task with the day it is deleted (UTC) and **Restore**. `/my-tasks` without a pane lists them as text, and `/my-tasks restore <n>` restores one. The dashboard lists them in a closed "Archived (n)" group, with **Restore** where the session takes web answers.
- **Restore** puts the task back in the open list as it was (only its `updatedMs`, the endpoint's version, changes), and sends Claude nothing either.
- **An ended session's task:** an Archive or Restore of a task an ended session holds goes to a live session in the same project (the dashboard sends it there; `/my-tasks archive <n>` or `restore <n>` in a live session finds it there when the session holds no task #n itself). That session takes the ended session's slot on, as a session starting in the project would (only that slot; the task may be numbered anew, and the reply says so), then archives or restores the task. Nothing is sent to Claude in either session. A slot holding an answer Claude has not heard yet is not taken on (that answer would reach the live session's Claude): it waits for the next session in the project. With no live session there, start one: it takes the ended session's tasks on as it starts (#191). With the answer endpoint on, a session writes its store slot from its start even while it holds no task, so the dashboard can find it.
  - **Side effect:** the live session takes on the whole ended slot, not just that task. Its other open tasks move there too: they show in that session's pane and status line, the note Claude gets after a compaction lists them as "from an earlier session", and answers to them go to that session's Claude. The next session to start in the project would take them on too, but into a fresh conversation; here a running one, perhaps on unrelated work, gets them in the middle of it.
  - **Race:** a session starting in the project at the same moment can take the same ended slot on too (both read it before either writes). The whole ended slot is then in both sessions (neither lets go), the task archived in one and open in the other; once both end, the next session takes both copies on and numbers one anew, so the task shows twice. Nothing is lost.
  - **Store growth:** a session with the endpoint on that ends holding nothing leaves an empty ended slot, removed only by the next session in that project (#194).
  - **Numbers:** `/my-tasks archive <n>` looks in ended sessions only when this session holds no task #n at all (open or closed).
- **Deleted after 7 days:** a task archived more than 7 days ago is removed at the session's next store write (each heartbeat writes the slot) or at the next session's load of the project; no timer runs for it. Between the 7-day mark and that write it is listed nowhere and cannot be restored. Only an archived open task is ever removed this way, and only with a well-formed `archivedMs` (a whole number from 0 to 2^53-1; any other value is dropped and the task kept as open). Until then it travels with its slot like any other task: when its session ends, the next session in the project takes it on, still archived.
- **Claude's side:** `list_tasks` (the default view, `all`, or by `id`) shows it as `#n archived by the owner`, saying it was not answered and the day it is deleted; `show: open` leaves it out, and the open-task note added at a conversation's start or after a compaction does not list it. Claude learns of it only by calling `list_tasks`. `withdraw_task` on it is refused with the same words. `assign_task` with the same title (as the duplicate check compares titles) is refused: `#n was archived by the owner on <day>; not re-assigned.` An archived task does not count toward the 5 open tasks.
- **Mixed versions:** a session still on 0.1.12 or older ignores `archivedMs`, so a task it takes on from an ended session shows there as open.

### Decision log

Each `assign_task` call writes one line through `hooks/decision-log.ts` (a copy of `mods/_shared/decision-log.ts`) to `<profile>/decision-logs/<UTC day>.jsonl`, in the format of `docs/decision-log.md`. Hook name `human-in-the-loop`.

- `refuse`: `reason` is the message, `inputs` is `{field, length, limit}` where they apply (`field` is `title`, `why`, `done_when`, `detail`, `kind`, `options`, `option 2`, `open` for the five-task cap, `caller` when a subagent called `assign_task` (only the main agent assigns tasks), or `moving` when the session is still joining its project). No task text is logged, only lengths.
- `accept`: `reason` is `task #n assigned`, `inputs` is `{id, kind, why, done_when, detail, options}` (lengths and the option count).
- `answer`: one line per request the session judged through the answer endpoint. `reason` is `<action> on task #n from the <source>: <outcome>`, `inputs` is `{id, created_ms, action, outcome, source}`, `source` being `endpoint` or `phone` (the type also allows `pane`; `phone` is the value the dashboard sends, kept from the phone view so that sessions started before the rename still accept its answers, #172). Never the answer, the reason or the option text. Requests the listener refuses itself (401, 403, 400 and the like), and a secret-shaped answer it refuses with 422, never reach the session and write no line. `hooks/decision-log.ts` is the shared `mods/_shared/decision-log.ts` byte for byte; the check that the writer exists is in `hooks/audit.ts`.

Logging is best effort. A writer that fails is ignored; one that is slow is left behind after 500 ms, so a task waits half a second at most. Needs `<profile>/hooks/decision_log.py` (`hooks/decision_log.py` of the repository this fork lives in) deployed; where it is missing, nothing is run, written or raised. `<profile>` is `$CLAUDE_CONFIG_DIR`, or `~/.claude` when that is unset.

### Answer endpoint

Answers a task from outside the My tasks pane, from another program on this machine (the dashboard, say), and takes the same path as a press in the pane: Claude hears it in the same words, at the same moment (at once while Claude is idle, when its turn ends while it works), and the pane and status line update.

**Off unless turned on.** With it off the fork starts nothing, listens nowhere and writes no file for it. Turn it on with the plugin's `answer_endpoint` setting: the **Answer endpoint** row in `/config`, or `pluginConfigs.<plugin>.options.answer_endpoint: true` in `settings.json`. It takes effect at the next session start or `/clear`: a setting change reloads the plugin, and a reloaded plugin starts no listener until then (the same holds after `/reload-plugins`).

Needs `python3` (standard library only) and a POSIX system (Linux, macOS).

#### Where the socket and the token are

Each session with the setting on runs its own listener, `hooks/answer_endpoint.py`, as its child. The listener serves HTTP on a Unix domain socket, `<profile>/hitl-endpoint/<pid>.sock` (mode 0600), draws a fresh 256-bit token, and writes where both are to

    <profile>/hitl-endpoint/<session_id>.json

a file only this user can read (mode 0600, in a 0700 directory):

```json
{"format": 2, "session_id": "…", "pid": 12345, "socket": "/home/you/.claude/hitl-endpoint/12345.sock", "token": "…", "started_ms": 1731900000000}
```

`format` is 2 (format 1 named a TCP port; there is none now). The listener opens no TCP port. The token is never printed, put in an argument or an environment variable, or logged. The socket and the entry go when the listener ends (the session ends or runs `/clear`, the listener is signalled, or the Claude Code process is gone). A session's heartbeat starts its listener again within a minute if it ended; the new one has a new socket and token, so read the entry again after a refused connection or a 401.

**Socket path limit.** A Unix socket path may be at most 103 bytes. A longer `<profile>/hitl-endpoint/<pid>.sock` (a long `CLAUDE_CONFIG_DIR`) makes the listener exit with `the socket path is too long`; no endpoint then exists for that session. Use a shorter profile path.

**Stale sockets.** A listener killed outright leaves its entry and socket behind. A connect to that socket is refused (`curl` exits 7): read the entry again, which names the new listener once the heartbeat has restarted it. The next listener to start sweeps a socket whose pid is dead and that refuses a connect, and the entries of dead pids; a socket some process still listens on is kept, and a listener refuses to start at a name something answers on.

**One pid namespace per profile.** Liveness is judged by pid. Sessions that share a profile but not a pid namespace (a container and the host, a sandbox with the profile mounted) see each other's listeners as dead: the next listener to start in one sweeps the other's entry and results directory, and two listeners can draw the same pid, so the second cannot bind its socket. A listener whose results directory or entry is taken away ends, and its session's heartbeat starts a new one within a minute, so such a session can be without an endpoint for up to a minute at a time. Keep the sessions of one profile in one pid namespace.

#### Request

    POST /v1/answer          over the socket named in the entry

```sh
# the token goes in a 0600 file, never on the command line
umask 077
headers=$(mktemp)
echo "Authorization: Bearer $token" > "$headers"
curl --unix-socket "$socket" \
  -H @"$headers" -H 'Content-Type: application/json' \
  --data-binary @body.json http://localhost/v1/answer
```

| Header | Value |
|---|---|
| `Host` | anything: there is no name on a Unix socket for a page to rebind (`localhost` in the example) |
| `Authorization` | `Bearer <token>`, exactly one |
| `Content-Type` | `application/json`, optionally `; charset=utf-8` |
| `Content-Length` | the body's length; chunked bodies are refused |
| `Origin` | must be absent: a request a proxy forwards from a web page is refused |

The body is one JSON object in UTF-8, at most 131072 bytes, read whole within 5 seconds, with no repeated key and no field but these:

| Field | | |
|---|---|---|
| `request_id` | required | 16 to 64 letters, digits, `-` or `_`; new for each answer, the same when the same answer is sent again |
| `session_id` | required | the session the file is named for |
| `task_id` | required | the task's `id` |
| `created_ms` | required | the task's `createdMs`: two sessions can draw one task number, and this tells them apart |
| `version` | required | the task's `updatedMs` as the caller saw it |
| `action` | required | `done`, `choose`, `answer`, `reject`, `archive` or `restore` |
| `option` | `choose` only, required | one of the task's options, exactly |
| `text` | `answer` only, required | the answer, trimmed; at most 10000 characters (Unicode code points) |
| `reason` | `reject` only, optional | why; collapsed to one line, at most 1000 characters |
| `source` | optional | `endpoint` (the default) or `phone`, for the decision log (the dashboard sends `phone`, kept from before the rename, #172) |

The numbers are whole, from 0 (`task_id` from 1) to 2^53-1. See "Reading a session's tasks" below for where `task_id`, `created_ms` and `version` come from. `session_id` is the session whose key holds the task: after `/clear` that is the new session, though the task's own `sessionId` field still names the one that assigned it.

Each action is a button of the pane, and only where the pane offers it: `done` is **Done** (a `do` or `answer` task), `choose` an option's button (a `choose` task), `answer` the **Answer…** or **Other…** field (any task), `reject` **Reject…** with its reason (any task), `archive` **Archive** (any open task), `restore` **Restore** under Archived (an archived task). `archive` and `restore` carry no `option`, `text` or `reason` (a request that does is 400), and neither is sent to Claude (see Archive). An answer to an archived task is 409 `closed` (`Task #n is archived: restore it first.`); so is `archive` on a task that is not open, and `restore` on one that is not archived or was archived over 7 days ago. `archive` or `restore` of a task the session does not hold looks for it in the project's ended sessions (`task_id`, `created_ms` and `version` as that slot holds them): the session takes that slot on and applies it, and the response names the task as it holds it now (its `id` may be new); a slot holding an answer Claude has not heard is left alone (`refused`).

#### Response

Always a JSON object, `Content-Type: application/json`, `Cache-Control: no-store`:

- `outcome`: what happened (below);
- `message`: a sentence on why, when there is one; it never repeats what was sent;
- `task`: `{session_id, id, created_ms, version, state}` where the session found the task: after `accepted` its new `version` and `state`, after `stale` or `closed` the ones it has now;
- `duplicate: true` when the listener gives back the first result of a `request_id` it has already answered.

| Status | `outcome` | When |
|---|---|---|
| 200 | `accepted` | applied, as the matching press in the pane |
| 400 | `bad_request` | not one strict JSON object, a field missing, extra or of the wrong shape (a list or object where text or a name is wanted included; the message names the field), `Content-Length` not one plain number, or sent with `Transfer-Encoding` |
| 401 | `unauthorized` | the token is missing or wrong |
| 403 | `forbidden` | an `Origin` header (the only cause) |
| 404 | `not_found` | a path other than `/v1/answer` |
| 404 | `unknown` | the session holds no task with that `task_id` and `created_ms` |
| 405 | `method_not_allowed` | a method other than POST |
| 408 | `timeout` | the request was not read whole within 5 seconds |
| 409 | `stale` | the task is no longer at that `version` (answered elsewhere, withdrawn): nothing changed |
| 409 | `closed` | the task, at that version, is no longer open |
| 409 | `reused` | the `request_id` was used for another request |
| 410 | `gone` | the session has ended (or ended while the request waited, by `/clear`, an exit or a resume: nothing of it was applied), or the entry is another session's |
| 411 | `length_required` | no `Content-Length` |
| 413, 414, 431 | `too_large` | the body, the request line or the headers are too long |
| 415 | `unsupported_media_type` | `Content-Type` is not `application/json` |
| 422 | `refused` | the action does not fit the task (Done on a `choose` task, an option on a task without options or not among them), the answer is empty, `text` or `reason` is over its cap, or the answer looks like a secret (below) |
| 503 | `busy` | eight requests are already being handled (a ninth connection is told so at once and closed), or the session is moving to another folder or has not read its project yet (at a start, after `/clear` or at a resume of another conversation, with the store slow; a resume in place judges the request at once, against the tasks it holds) |
| 503 | `pending` | the session did not answer within 15 seconds |

**A secret-shaped answer** is refused by the listener itself, with 422 `refused` and the message `text looks like a secret, so it was not sent: put it where it belongs, then send done.` It is checked before anything is printed to the session, so it never reaches the session, a result file or the decision log, and that refusal writes no decision-log line. The session applies the same check again to what reaches it. The check is on `text` only: a `reject` `reason` has no secret check and passes through the listener to the session (as in the pane).

**Retry rule.** After a 503, a timeout or a lost connection, send the same request again with the same `request_id`. It is applied at most once: a request that was applied gives back its first result (with `duplicate: true` from the listener that answered it; the session also remembers the last 256 `request_id`s across listener restarts). A `request_id` sent with another body is `reused`. A `busy`, and a `gone` for a request that was under way as its session ended, are not remembered: after a resume in place, the same request is judged afresh.

#### Reading a session's tasks (the dashboard)

The endpoint has no list route. A caller reads the tasks from the plugin's store, a JSON file:

    <profile>/plugins/store/human-in-the-loop_<marketplace>-<hash>.json

The name carries the marketplace the plugin was installed from, so it changes when the plugin moves from one marketplace to another (see Deploy). Each session has its own key, `tasks:<project root>#session:<session_id>` (a root too long for a key is hashed; see `keysOf` in `hooks/project.ts`), holding that session's slot:

```json
{"tasks": [{"id": 3, "title": "…", "why": "…", "kind": "choose", "options": ["…", "…"], "state": "open",
            "update": "none", "sessionId": "…", "createdMs": 1731900000000, "updatedMs": 1731900060000}],
 "seenMs": 1731900120000, "nextId": 4, "took": {}, "endedMs": 1731900500000}
```

A task's `id`, `createdMs` and `updatedMs` are the request's `task_id`, `created_ms` and `version`; `kind`, `options` and `state` say which action fits and whether it is still open (`doneWhen`, `detail`, `answer` and `reason` appear when set). An archived task is still `open` and carries `archivedMs` (when it was archived; it is deleted 7 days on). `took` (what the session took on from sessions that ended) and `nextId` are optional. The `<session_id>` of a request is the part after `#session:` in the key holding the task.

- **Live or ended.** A slot with `endedMs` is an ended session's: its tasks wait in the store for the next session in that project, and an answer to it gets 410. A live session rewrites `seenMs` every minute; one not seen for 3 minutes is treated as gone. A session can be answered while its entry file exists and a connect to its socket succeeds; the entry alone is not proof, since a killed listener leaves its entry behind.
- **Several profiles.** Entry files are per profile (`<profile>/hitl-endpoint/`), while the store file can be shared between profiles that share a plugin directory. A caller that reads the store should look for entries under each profile's `hitl-endpoint/`, and match them by `session_id`.

#### What it guards against, and what not

Guards against:

- other machines: there is no TCP port, only a socket file;
- other users of this machine: the socket (0600) and the entry (0600) are in a 0700 directory this user owns, so another user can neither connect, nor read the token, nor bind the name of a listener that died; the listener refuses a directory that is a link or another user's;
- web pages in a browser: a browser cannot reach a Unix socket; `Origin` is still refused (a proxy forwarding a page's request), and only `application/json` is taken (no form), every method but POST is refused, no CORS headers. There is no `Host` check: no page can rebind a name that is not there;
- a stale card answering over a newer answer (`version`, checked again inside the task change), the same answer sent twice (`request_id`), two sessions that drew one task number (`created_ms`), and a request held up across `/clear`, an exit or a resume, at any of its waits up to and including the pane cleanup of an endpoint answer, changing the next session's task, the field open on it or its draft (the session generation is checked after the waits, again inside the task change, and before and inside the pane cleanup); a press in the pane is as upstream (one held up after its task change still runs the pane cleanup in the next session);
- oversized or slow requests: 128 KiB body, 5 s to read it, 8 connections at once, 0.25 s to read away what a caller still sends after its answer, 15 s wait for the session;
- a secret-shaped answer: refused by the listener before it is printed, and by the session again.

Does not guard against:

- a program running as the same user. It can read the token, answer any open task of the session as the user, read or rewrite the store, write a `stop` file (the listener ends, the heartbeat restarts it within a minute), forge a result file (the session still applies only what it judged), read the listener's memory through `/proc` where ptrace is allowed, fill the 8 connection slots, unlink a dead listener's socket and bind its own at that name (a caller reading a fresh entry then reaches the real one; a caller following a stale entry is refused), or, without the endpoint at all, type into the terminal or edit the plugin;
- a `reject` `reason` carrying a secret: it has no secret check, and crosses the pipe to the session;
- another plugin in the same session (a hook on `process.spawn` or `fs.write` sees the listener's lines and result files);
- a caller off this machine (no TLS; reach it through something that runs here).

**Tested as another user by hand, not in the suite.** The claim about other users rests on the permission bits (directory 0700, socket and entry 0600, owner checked): the listener does not check a caller's peer credentials. The round-2 review checked it with a second uid (uid 12345 in a container, against the mounted directory), with the listener running and again after it was killed: listing the directory, reading the entry, connecting, binding a new name, unlinking the socket, binding the dead listener's name and writing a stop file all failed with `EACCES`. There is no automated test as a second user; the suite tests the modes and the owner.

### Dashboard

When the dashboard is set up (`dashboard/README.md`: its config file `~/.config/claude-tweaks/dashboard.toml`, or `phone.toml` while that is the only one there, from before the #167 rename; and its systemd user unit), the status line carries one more part after the task words, for example `dashboard: on · replies: off (Answer endpoint setting off)`. It says whether the dashboard is on (its server answers on its socket and Tailscale serves port 6767 to that socket over plain HTTP), off with the reason (`stopped`, `server failed`, `server not running`, `server not answering`, `not served on 6767`, `6767 serves something else`, `tailscale not found`; before it is set up, `unit not installed`, `unit masked`, `unit file has errors` or `unit not loaded`, shown in the pane only), or `unknown` (a check failed or did not answer in time). `replies` says whether this session takes answers from the dashboard: on, starting, or off with why (`Answer endpoint setting off`, `endpoint not running`, `endpoint failed: ...`). With no config file nothing is shown, nothing is run, and the `dashboard` tool answers that the dashboard is not set up.

- **Where it shows.** The status line, always (once set up). The My tasks pane adds the same line with a Start or Stop button under its foot, but that pane is open only while a task waits for you. The progress pane (the progress mod) shows the line too, as text only: this plugin publishes it in its state (`{ plugin: 'human-in-the-loop', key: 'dashboard' }`: once set up, `{ line, at, seq }`, the status line's dashboard part, when it was read in `$.clock.now()` milliseconds and a number each publication takes rising; else null), and the progress pane draws it while it is under 150 seconds old. It is published again on every reading and after `/clear` or a resume, changed or not; a write that a later publication overtook gives way to it (owner decision, AskUserQuestion 2026-11-19, option chosen: "Freshness stamp (Recommended)"). Start and Stop live in the My tasks pane (while a task is open) and in `/overview start|stop`.
- **Reading.** While the dashboard is installed (the config file and the unit file are both there), the state is read at session start and again on the plugin's minute heartbeat; once more on the heartbeat after either file is removed, so the status line and the published line drop it; otherwise nothing runs on its own. It is also read when the My tasks pane or the desktop menu is drawn (at most every 10 seconds) and on every press or command. A reading that answers after a newer one (or after a start or a stop) is dropped.
- **Start and stop.** The pane's button (`Start dashboard` or `Stop dashboard`, `Starting dashboard…` while it works) and `/overview start` / `/overview stop` do the same; `/overview web` reads now. Those are the Progress mod's command: it calls this plugin's `dashboard` tool (`mcp__human-in-the-loop__dashboard`, one `action`: `status`, `start` or `stop`; the answer is text blocks: the words first, then, while the dashboard is on, the address as a second block). The tool works from the session's start, and says the dashboard is not set up, running nothing, while its config is missing. It is hidden from the model: a `tool.offer` hook keeps it out of the tool list of the main agent and of every subagent and refuses any call a model makes, so Claude cannot call it directly. It is reached only through the Progress mod's `/overview`: a bare `/overview` asks for the status (to show the address), and `/overview web|start|stop` as above. `tool.offer` is not asked about a plugin's `$.tool.call`, and the tool itself refuses every call that does not come from the plugin named `progress` (the host's `next.origin`, the caller's manifest name whatever marketplace installed it), so a model's call that `tool.offer` is not asked about, such as a Code Mode script's, is refused too. `/overview` itself runs whatever sent it, so a scheduled task, `/loop` or another session whose prompt is `/overview start` does start the dashboard (accepted risk, owner decision AskUserQuestion 2026-11-24: it serves only the PIN-protected page on the owner's tailnet). Only the main agent's call runs it, not a subagent's. `/dash` was folded into `/overview` and is gone. Start runs `systemctl --user start claude-tweaks-dashboard.service` and `tailscale serve --bg --http=6767 unix:<socket>`; stop takes port 6767 off only when it maps to the dashboard's socket, then stops the unit. Start is refused, with the missing step named and nothing started, when the config or the unit is missing, `tailscale` is not on the PATH, or port 6767 already serves something else (it names what, as `scheme://host:port` or `a Unix socket`, and says to free it with `tailscale serve --http=6767 off`). A server run by hand without the unit reads as `unit not installed`. A start from here is not kept across a logout or reboot; `systemctl --user enable --now` (dashboard/README.md, Install, step 3) is.
- **Never** `systemctl enable`, Tailscale Funnel, or a port other than 6767.
- **Desktop menu.** Right-clicking a transcript row offers `Copy dashboard address` (and `Start dashboard` while it is not on). It copies because a menu link opens only `https:` addresses and the dashboard is plain `http:`.
- **How it runs.** `hooks/dashboard_control.py status|start|stop` prints one JSON line. Each child (`systemctl`, `tailscale`) is run from a fixed argument list, no shell, in a process group of its own with a time limit; the group is killed on the limit. Nothing a command prints is passed on: a failure says which command failed and its exit status, and systemd's values are mapped to fixed words. The fork drops a helper answer that was cut short or contradicts itself (an `on` that is not set up, or says why it is not on), and draws every helper word through `printable()`. If the helper itself is killed with SIGKILL while a child hangs, that child and what it started outlive it; the helper's own limits (48 seconds at most) sit below the fork's (20 seconds for a status, 60 for a start or stop), so this needs the engine to kill it first.
- **To check once:** after the first real start, run `tailscale serve status --json` and confirm the proxy for port 6767 is a `unix:` target naming the socket path (`unix:<socket path>`; any number of slashes after `unix:` is read as the same). If it differs, the line says `6767 serves something else` after a start, a second start is refused and stop leaves 6767 alone: note the exact Proxy value in #158, and until the reader is fixed, `tailscale serve --http=6767 off` takes it off by hand.

### Tests

`claude plugin test mods/human-in-the-loop` runs `tests/register.test.tsx`. The fork's tests are the last two `describe` blocks (`the fork: limits, detail and the decision log`, `the answer endpoint`). The dashboard's tests are the `the dashboard` describe block and `tests/test_dashboard_control.py` at the repository's root (`uv run pytest tests/test_dashboard_control.py`, fake `systemctl` and `tailscale` on a scratch PATH; the nested-input cases run under the system `python3`, as the fork does). The listener has its own tests, `tests/test_hitl_endpoint.py` at the repository's root (`uv run pytest tests/test_hitl_endpoint.py`). The host and race fixtures explicitly match plugin-owned UI events; the native suite passes on Claude Code 2.1.330 (#130).

### Deploy

A person installs the fork in place of the upstream plugin. The fork keeps the plugin name `human-in-the-loop`, so the tools stay `mcp__human-in-the-loop__*` and what refers to them keeps working. Colleagues install it from this repository's `mods/` marketplace (`docs/overview-trial.md`); the marketplace name there is `claude-tweaks-overview`.

1. **Answer or clear open tasks first, if you had the upstream plugin.** The store file is named after the marketplace: it moves from `<profile>/plugins/store/human-in-the-loop_human-in-the-loop-<hash>.json` to `…/human-in-the-loop_claude-tweaks-overview-<hash>.json`, and the new file starts empty. Open tasks stay in the old file. Answer or withdraw every open task, and let saved answers go, before switching. A fresh install has nothing to migrate.
2. Disable the upstream entry if you have it, then install the fork. Never leave both enabled: both register the same three tools.

   ```sh
   claude plugin disable human-in-the-loop@human-in-the-loop   # only if installed
   claude plugin marketplace add "$PWD/mods"
   claude plugin install human-in-the-loop@claude-tweaks-overview
   ```

   The marketplace name is the `name` in its `marketplace.json`. The owner's own route is a personal local marketplace (`~/.claude/local-plugins/`, name `local`, one folder per plugin holding `.claude-plugin/plugin.json`, `hooks/`, `types/`, `tsconfig.json` and `LICENSE`); the store file is then `…_local-<hash>.json`.
3. Optional: turn on **Answer endpoint** under the installed id (`/config`, or `pluginConfigs["human-in-the-loop@claude-tweaks-overview"].options.answer_endpoint: true`; from a shell, `printf '{"answer_endpoint":"true"}' | claude plugin configure human-in-the-loop@claude-tweaks-overview --values-stdin`), then restart Claude Code (or start a new session or `/clear`).
4. For the decision log, `hooks/decision_log.py` must be in `<profile>/hooks/`.
5. **Live checks** (what the test kit cannot show). With the endpoint on, in a new session:
   - Ask Claude for a task. Read `socket` and `token` from `<profile>/hitl-endpoint/<session_id>.json`, and the task's `id`, `createdMs` and `updatedMs` from the store. Send a `done` with the `curl --unix-socket` command above: expect 200 `accepted`, Claude gets what a press of **Done** sends, the pane updates.
   - Send the same request again: expect 200 with `"duplicate": true`.
   - Give a task a 1,500-character `detail`, open **Full picture** in a 76-column terminal, and scroll to its end.
   - Two sessions at once in the same profile (two terminals), each with a task: after a minute, both entries are still in `<profile>/hitl-endpoint/`, and a `done` sent to each session's socket gets 200 `accepted`. An entry that keeps vanishing means the sessions do not share a pid namespace (see **One pid namespace per profile**).
   - `/clear`, then exit: no `answer_endpoint.py` process is left (`pgrep -f answer_endpoint.py`), and `<profile>/hitl-endpoint/` holds only the live session's files.

Installing the fork for colleagues (and its docs) is tracked in issue #127.


---

# Human in the loop

**Claude hands you the tasks only you can do. They wait until you act, and your answer goes back to Claude.**

## Why

Claude often needs something only you can do: a key in `.env`, an approval on staging, a command on your own machine, a decision. Today it says so in the middle of a reply. You're busy steering the next fix, and the ask scrolls away. At best Claude keeps repeating "I still need you to…"; at worst the ask is lost.

With this mod, Claude assigns the ask as a task instead. It waits in the **My tasks** pane, counted under the prompt, until you do it, answer it or reject it.

## An example

> Get our Stripe webhooks library ready to open-source.

Claude works through it, and three times hits something only you can do: the integration tests need your Stripe key, making the repo public is your call, and the package needs a name. Each becomes a task, and Claude keeps working:

```
╭─ My tasks ──────────────────────────────────────────────────────────╮
│ ☐ 3 tasks for you                                                   │
│                                                                     │
│ ☐ #1 Add STRIPE_SECRET_KEY to .env  2m                              │
│   The integration tests run against Stripe's test mode and need it. │
│   Done when: It's in .env. Don't paste it here.                     │
│   d: Done   r: Answer…   x: Reject…                                 │
│ ☐ #2 Decide whether to make the repo public  1m                     │
│ ☐ #3 Choose the package's name on npm  now                          │
│                                                                     │
│ Esc: back to the prompt   Hide                                      │
╰─────────────────────────────────────────────────────────────────────╯
☐ 3 tasks for you · /my-tasks
```

- **#1** you do in your editor, then press `d`. The key never passes through Claude.
- **#2** is your decision: `1` makes the repo public, `2` keeps it private.
- **#3** needs your words: press `r`, type `@acme/stripe-hooks`, Enter.

Answer whenever it suits you. Answers you give while Claude works wait for it, and your next answer after it stops takes them along. Here #1 and #2 were answered while Claude worked and #3 after, so Claude gets them as one message, in your words:

```
My responses to tasks you gave me (Human in the loop):

#1 Add STRIPE_SECRET_KEY to .env: Done.

#2 Decide whether to make the repo public: I chose "Make it public".

#3 Choose the package's name on npm:
@acme/stripe-hooks
```

Claude picks up where it left off: the integration tests pass, the repo goes public, and the package gets its name. Publishing is left to you.

## How it works

- **Claude assigns** with `assign_task`: an imperative title, why it's needed, what counts as done, and a kind (`do`, `answer` or `choose`).
- **The status line** under the prompt counts what's waiting: `☐ 3 tasks for you · /my-tasks`.
- **The My tasks pane** opens by itself when a task arrives. In fullscreen it's a sidebar beside the transcript; on the main screen it sits above the prompt. `/my-tasks` opens it any time, with the keyboard.
- **You respond:** Done, an option (`1`–`4`), an answer (`r`), or a rejection with a reason (`x`). Click, or focus the pane with `/my-tasks` or `ctrl+x tab` and use the keys.
- **Or you archive it** (`a`): the task leaves the list without an answer and Claude is sent nothing, so a session that is idle stays idle. It waits under **Archived (n)** with **Restore** for 7 days, then it is deleted.
- **Your answer reaches Claude:**
  - while Claude is idle, right away;
  - while it works, it waits, so Claude isn't interrupted, and goes when Claude finishes its turn. If a task is still open then, your answers wait for that one too and arrive together (or with your next prompt). **Send now** sends right away.
- **Long answers** (a log, a stack trace): in the terminal the answer field holds four lines, and a backslash then Enter starts a new one. For more, or in the desktop app, **Long answer…** starts your own prompt box with `↳ Answer to #3:`, and you paste and press Enter.
- **Claude keeps working.** Unlike a question dialog, a task doesn't stop Claude: it carries on with everything else while the task waits for you, and takes the task back if it finds another way.
- **Nothing is lost** across a compaction or a new session: open tasks stay with the project and Claude is told about them again. With several sessions open in one project, each keeps its own tasks, so your answer always reaches the Claude that asked.

It never draws in the band above the prompt, so it works beside band mods such as [What's Agent Doing](https://github.com/tzafrir/whats-agent-doing).

## Guardrails

- At most 5 open tasks at a time.
- The same ask twice is one task.
- Only the main agent assigns tasks; a subagent reports what it needs in its result.
- An answer that looks like a secret (an API key, a token, a private key) is held with a warning before it is sent.

## Install

In Claude Code:

```
/plugin marketplace add tzafrir/human-in-the-loop
/plugin install human-in-the-loop@human-in-the-loop
```

Or from your shell:

```
claude plugin marketplace add tzafrir/human-in-the-loop
claude plugin install human-in-the-loop@human-in-the-loop
```

Then start a new session (or run `/reload-plugins`).

**Upgrading:** update the progress mod to 0.4.2 alongside human-in-the-loop 0.1.15. The `dashboard` tool now answers in text blocks, and an older Progress reads that as a failure, so `/overview` would say the dashboard tool failed. (Progress 0.4.2 still reads the older answer, so updating Progress alone is safe.)

**Requirements:** Claude Code 2.1.301 or later, in a terminal or in the desktop app's Code tab. The plugin is a [mod](https://github.com/anthropics/claude-code/blob/main/mods/README.md), written with Claude Code's function hooks, which are early access: they load only where function hooks are enabled, and their API may change between releases.

## Data and privacy

- **Stays on your machine.** Tasks live in the session's own state and in the plugin's own store (a JSON file under your Claude Code configuration directory), keyed by project folder, so open tasks come back in the next session there. No network, no files of yours, no processes.
- **Your responses become part of the conversation.** Claude reads what you answer, and the session's transcript on disk keeps it, like anything you type. That's why tasks ask you to put a secret where it belongs and press Done, never to paste it, and why an answer that looks like a secret is held first.
- **What it adds to the conversation:** the three tools, a few lines in the system prompt telling Claude about tasks, your responses, and, at a conversation's start or after a compaction, a short list of the tasks still open.

### What the mod puts in the prompts it submits

The mod submits a prompt in two cases, and these are all it puts in one:

- **Your responses to tasks.** When you respond to a task while Claude is idle, when Claude finishes a turn with your saved responses waiting and no task left open, or when you press **Send now**, the mod submits your responses as a prompt in your own words. It opens with "My response to a task you gave me (Human in the loop):" ("My responses to tasks…" for several). Then, for each task, it gives the task's number and the title Claude gave it, and what you did: "Done.", the option you chose, your answer, or "I won't do this." with your reason.
- **One fixed line:** "I answered a task while you were finishing your reply; my answer is above." It goes when your answer arrived during Claude's final reply.

Nothing else goes into a prompt it submits. The mod reads two facts about the session, the session's id and its project folder, and puts neither in a prompt. It uses them to keep each session's tasks apart from those of other sessions in the same folder, in the plugin's own store on your machine, and to mark a task an earlier session assigned as "from an earlier session". Nothing else from the conversation, your files or your machine goes in either.

### What else it sends to Claude, and which tool calls it answers

- **While Claude works:** **Send now** adds the same response as a row Claude reads at its next step, with a notice in the transcript for you ("Sent your response to #3 to Claude") that Claude doesn't read.
- **Your prompts:** the mod reads them only to recognize a long answer (`↳ Answer to #3: …`), which it turns into that same response, and to attach responses not yet sent as notes Claude reads.
- **The tool calls it answers:** only calls to its own tools, `assign_task`, `list_tasks`, `withdraw_task`, `open_tasks` and `dashboard`, which the mod itself serves. Every other tool call passes through untouched.

## Support

Report a problem or ask for a feature in [GitHub Issues](https://github.com/tzafrir/human-in-the-loop/issues). Read the [privacy policy](https://tzafrir.github.io/human-in-the-loop/privacy).

## Develop

Load the plugin from a clone; the session reloads it as you edit:

```
git clone https://github.com/tzafrir/human-in-the-loop
claude --plugin-dir human-in-the-loop
```

```
claude plugin validate --strict human-in-the-loop/.claude-plugin/plugin.json
claude plugin test human-in-the-loop
```

| File | What it does |
|------|--------------|
| `hooks/register.tsx` | The tools Claude calls, delivering your responses, the My tasks pane and status line, `/my-tasks`, long answers through the prompt box |
| `hooks/project.ts` | Each session's tasks in the project's store, and taking on those of sessions that ended |
| `hooks/tasks.ts` | Reading a task from Claude's call, what Claude is told, the status line, secret shapes |
| `hooks/text.ts` | Printable labels, ages, sizes |
| `types/index.d.ts` | The `$.state` contract: the tasks, the selection, the open field |
| `tests/register.test.tsx` | Assigning, the pane and `/my-tasks`, every response and when it reaches Claude, long answers, tasks carried across sessions |
| `docs/DESIGN.md` | The design and the decisions behind it |

## License

MIT

## Overview entry point

`mcp__human-in-the-loop__open_tasks` explicitly opens My tasks without assigning a task or enrolling an issue. It works when the task list is empty. `/my-tasks` remains available and also opens the empty view. A view explicitly opened this way stays available after its last task is answered or withdrawn; Hide closes it. The Progress plugin can route its Overview entry point through this owner-held tool, preserving the task plugin identity and all existing task/answer stores.

With no surface attached (T3 Code runs Claude Code through the SDK, so `$.session.surfaces()` is empty), the mod opens and focuses no pane, so nothing is left waiting for input that the host cannot show. A surface that attaches later (Remote Control) gets the pane from `/my-tasks`. `open_tasks` and `/my-tasks` instead answer in text: the web dashboard's link when it runs (otherwise that it is not set up, or `/overview start`), the open tasks, and "pane not shown: no surface is attached". Answering a task without a pane is out of scope here; the web dashboard covers it. Terminal sessions are unchanged.

For an independent clean-profile trial, see [Try Overview](../../docs/overview-trial.md). The answer endpoint remains off unless enabled.

## Try it independently

Use the [Overview trial guide](../../docs/overview-trial.md) for a local marketplace install from a clone or bundle, clean-profile validation, optional integrations and removal. Progress is optional. No owner hooks, ledgers or templates are required; the answer endpoint defaults off.
