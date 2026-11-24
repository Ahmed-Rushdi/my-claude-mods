# Dashboard

Overview shows explicitly selected GitHub issue progress and tasks that need a person's answer. Its two-tab web page can stay open beside a T3 conversation or in a phone browser, updating independently of model activity. Tasks retain acknowledged delivery and safe retries; issue details include an on-demand body/comments reader and optional explicit native metadata refresh. Local loopback and the existing Tailscale/Unix modes share the page. See [the colleague trial guide](../docs/overview-trial.md) for independent mod installation.

`server.py` is Python's standard library only and runs under the system interpreter (`python3 -I`), like the human-in-the-loop fork's answer endpoint; it needs Python 3.11 or later (`tomllib`). Its default Unix/Tailscale mode opens no TCP port. Explicit `--local` mode opens only IPv4 loopback for a local browser or T3 pane.

## Contents

- [Install](#install)
- [Upgrading from the phone view](#upgrading-from-the-phone-view)
- [Local browser or T3 pane](#local-browser-or-t3-pane)
- [How a request travels](#how-a-request-travels)
- [Endpoints](#endpoints)
- [Threat model](#threat-model)
- [Limits](#limits)
- [Files](#files)
- [Tests](#tests)

## Install

Nothing here is installed, enabled or started for you, and no agent runs `tailscale serve`. You turn it on. Below, `CT` is your checkout of this repository: `CT=~/claude-tweaks` (or the worktree you run from).

1. **Config.** Create `~/.config/claude-tweaks/dashboard.toml`, readable by you alone. It is not in the repository and must not be: it holds the PIN.

   ```sh
   mkdir -p ~/.config/claude-tweaks
   install -m 600 /dev/null ~/.config/claude-tweaks/dashboard.toml
   "${EDITOR:-nano}" ~/.config/claude-tweaks/dashboard.toml
   ```

   ```toml
   pin = "1337"                      # the PIN the page asks for; 1337 when left out
   # hosts = ["<machine>:6767"]      # the names you open the page at; <hostname>:6767 when left out
   # profiles = ["~/.claude-work", "~/.claude"]   # the profiles read; when left out, CLAUDE_CONFIG_DIR or ~/.claude
   ```

   Your Tailscale login is not in the config. When the server starts it runs `tailscale status --json` once and admits only the Tailscale user this machine is logged in as (this machine's `Self.UserID`, and that user's `LoginName`). It keeps the login in memory, never writes it anywhere and does not ask Tailscale again while it runs. So after you log this machine in to Tailscale as someone else, restart the server: `systemctl --user restart claude-tweaks-dashboard`. Browsers then need the PIN again.

   The server refuses to start, saying what to fix in one line, when:
   - the file is missing, or someone else can read or write it (`chmod 600`);
   - it has a key the server does not know. An `owner_login` line left from an older version is refused with a message saying it is no longer used: delete it;
   - Tailscale cannot say who this machine is logged in as: `tailscale` is not on the PATH or cannot run, tailscaled is not running, `tailscale status` takes over 5 seconds or prints more than 8 MiB (a tailnet of 3 devices prints about 6 KB), the system fails the call (out of file descriptors, say: the refusal names the system's error), or Tailscale is logged out or not connected (`tailscale up`). The refusal names Tailscale's state only when it is one Tailscale defines, else `unknown`. It never starts admitting anyone without a login;
   - this machine is tagged in Tailscale: a tagged machine belongs to Tailscale's tagged-devices user, not to you, so there is no login to admit. Run the dashboard on a machine your Tailscale user owns;
   - the login is not plain ASCII without spaces. Serve would send such a login encoded (RFC 2047), and the server does not decode it: not supported, since Tailscale logins are ASCII email-like names in practice.

   `hosts` must name every way you open the page: add `<machine>.<tailnet>.ts.net:6767` or the machine's `100.x.y.z:6767` if you use those. `profiles` lists the profile directories to read (absolute or starting with `~`), each labelled by its directory's name (`.claude-work` is `work`, `.claude` is `default`).

   The config, the `secret` file and your Tailscale login are read when the server starts. After you change the config (a new PIN, say), restart it: `systemctl --user restart claude-tweaks-dashboard`, or Ctrl+C and start it again by hand.

2. **Try it by hand.**

   ```sh
   python3 -I "$CT/dashboard/server.py"
   # dashboard: listening on /home/you/.local/state/claude-tweaks/dashboard/dashboard.sock
   # dashboard: admitting only the Tailscale user this machine is logged in as (read at start: ...)
   ```

   Ctrl+C stops it and removes the socket. Flags: `--config PATH`, `--state-dir DIR` (the socket, the secret and the lockout go there), `--profile LABEL=DIR` (repeatable; replaces the config's `profiles`; default: the effective profile only, `CLAUDE_CONFIG_DIR` or `~/.claude`).

   **Several profiles** (separate Claude accounts through `CLAUDE_CONFIG_DIR`, say) are read only when named. List them in the config, for example `profiles = ["~/.claude-work", "~/.claude-personal", "~/.claude"]`, or pass one `--profile` per directory (`--profile work=$HOME/.claude-work`). The systemd unit passes no flags, so for a service put the list in the config. Before this default changed, Unix mode read those three directories when the config named none: add that line to keep reading them.

3. **Keep it running.** The unit is `dashboard/claude-tweaks-dashboard.service`. Its `ExecStart` runs `~/claude-tweaks/dashboard/server.py`; if your checkout is elsewhere, point it at `$CT`:

   ```sh
   mkdir -p ~/.config/systemd/user
   cp "$CT/dashboard/claude-tweaks-dashboard.service" ~/.config/systemd/user/
   "${EDITOR:-nano}" ~/.config/systemd/user/claude-tweaks-dashboard.service   # ExecStart path
   systemctl --user daemon-reload
   systemctl --user enable --now claude-tweaks-dashboard
   journalctl --user -u claude-tweaks-dashboard      # "dashboard: listening on ...", or what to fix
   ```

   A user unit starts when you log in. To have it start at boot, before any login: `loginctl enable-linger "$USER"`. If it starts before Tailscale is connected, the start fails and systemd tries again every 10 seconds, five times in two minutes at most; after that, `systemctl --user restart claude-tweaks-dashboard`. The unit allows the server Unix sockets only (`RestrictAddressFamilies=AF_UNIX`), so it cannot open a network socket even by mistake. The `tailscale status` call at start reaches tailscaled through its Unix socket (`/var/run/tailscale/tailscaled.sock`), so the rule does not get in its way. That line and `SystemCallArchitectures=native` pass `systemd-analyze --user verify`; if the service fails at start with a seccomp error, remove them and report it.

4. **Expose it on the tailnet.** One command, kept across reboots by Tailscale (`sudo` unless you made yourself operator with `sudo tailscale set --operator=$USER`):

   ```sh
   tailscale serve --bg --http=6767 unix:$HOME/.local/state/claude-tweaks/dashboard/dashboard.sock
   tailscale serve status
   ```

   Never `tailscale funnel`: the server refuses Funnel requests anyway (see below). To take it off: `tailscale serve --http=6767 off`.

   **Other mappings.** This adds port 6767 only. Anything else `tailscale serve status` lists (an older `https://<machine>.<tailnet>.ts.net` mapping, say) is unrelated and left as it is.

5. **Open `http://<machine>:6767`** in a browser on your tailnet (a phone or another computer), enter the PIN once. The browser keeps a cookie for 30 days.

   SameSite=Strict means the cookie is not sent when you arrive from a link on another site (a chat app, say): the page then asks for the PIN again. Open it from a bookmark, the home screen or the address bar.

   A bare `{"outcome":"forbidden"}` means the request did not pass the identity and host check (below). Usually the name you opened is not in `hosts`: the full `<machine>.<tailnet>.ts.net` name and the `100.x.y.z` address each need their own entry, with `:6767`. Otherwise the device is on your tailnet under another Tailscale login than the user this machine is logged in as (`tailscale status` on each shows its login). The server logs nothing for it. From the machine itself, `curl -s http://<machine>:6767/ | head -3` shows the start of the PIN page when both are right.

6. **To answer from the dashboard**, install the human-in-the-loop fork and turn on its **Answer endpoint** setting for each login ([the fork's README, Deploy](../mods/human-in-the-loop/README.md#deploy)), then start a new session or `/clear`. Until then every task is read-only on the dashboard: no session has an answer endpoint, and an answer gets `no_endpoint`.

7. **Turn it off**: `tailscale serve --http=6767 off` takes it off the tailnet; `systemctl --user disable --now claude-tweaks-dashboard` stops the service (remove `~/.config/systemd/user/claude-tweaks-dashboard.service` to uninstall it).

**Start and stop from Claude Code.** With the human-in-the-loop fork installed and step 1's config in place when a session starts (without it the fork shows nothing of the dashboard and its controls say it is not set up), the status line shows `dashboard: on|off (why)`, and `/overview web|start|stop` reads, starts or stops the dashboard (a bare `/overview` shows its address too; the progress mod's command, using human-in-the-loop); the My tasks pane, while a task is open, has the same line with a Start or Stop button ([the fork's README, Dashboard](../mods/human-in-the-loop/README.md#dashboard)). Start needs step 1, and step 3's copy and `daemon-reload` (skip its `enable --now` if you want the dashboard started only by hand), and, once, operator rights for step 4 (`sudo tailscale set --operator=$USER`). It then does the `--now` start of step 3 and step 4's `tailscale serve` command, and says which step is missing when one is. It refuses when port 6767 already serves something else, rather than replace it. It never enables the unit, never uses Funnel and never serves another port. A start from the button is not kept across a logout or reboot (the line then says `stopped`); `systemctl --user enable --now claude-tweaks-dashboard` is.

**Log every browser out, or change the PIN**: delete `~/.local/state/claude-tweaks/dashboard/secret` (or edit `pin`), then restart the server; a running server keeps the key and the PIN it started with. **Clear a lockout**: delete `lockout.json` in the same directory, then restart.

## Upgrading from the phone view

Until #167 this was the phone view: `phone/server.py`, the unit `claude-tweaks-phone`, the config `~/.config/claude-tweaks/phone.toml`, the state folder `~/.local/state/claude-tweaks/phone/` with the socket `phone.sock`, the cookie `ctphone` and the command `/phone`. What carries over by itself:

- **Config.** With no `dashboard.toml`, the server reads `phone.toml` and prints one line naming both paths; with both there, `dashboard.toml` is read and the line says `phone.toml` is ignored. The human-in-the-loop fork finds the config the same way. Only the default path falls back; a `--config` given is used as it is. Rename the file when convenient: `mv ~/.config/claude-tweaks/phone.toml ~/.config/claude-tweaks/dashboard.toml`.
- **State.** With no `dashboard/` state folder, the server's first start moves `phone/` there (one rename beside it) and prints one line. The signing key (`secret`) and the PIN lockout carry over, and the old `phone.sock` and `phone.lock` are removed. It refuses, moving nothing, while the phone view still runs on that folder (stop it first), or when `phone` is a link or another user's folder. Only the default state folder moves; a `--state-dir` given is used as it is.
- **Browsers log in once more.** The cookie is now `ctdash` (`ctdash-<port>` in local mode); a `ctphone` cookie is not read, though the key that signed it carried over.
- **`/phone` is now `/overview web|start|stop`**, in sessions started after the plugin update (it was `/dash` for a while before that): Claude Code ships `/dashboard` itself.
- **Answers still reach sessions started before the upgrade**: the answer the server sends keeps `source: "phone"`, the only value besides `endpoint` such a session takes.

On the live machine (nothing here runs for you), once `CT` holds a revision with `dashboard/server.py` (an older checkout may already have the phone view's `dashboard/` folder without it):

```sh
git -C "$CT" fetch && git -C "$CT" checkout <merged main>   # the revision with dashboard/server.py
systemctl --user disable --now claude-tweaks-phone     # stop the phone view and its autostart
rm ~/.config/systemd/user/claude-tweaks-phone.service
cp "$CT/dashboard/claude-tweaks-dashboard.service" ~/.config/systemd/user/
"${EDITOR:-nano}" ~/.config/systemd/user/claude-tweaks-dashboard.service   # ExecStart=/usr/bin/python3 -I %h/<CT under home>/dashboard/server.py, e.g. %h/claude-tweaks-live/dashboard/server.py (systemd does not expand $CT)
systemctl --user daemon-reload
systemctl --user enable --now claude-tweaks-dashboard
journalctl --user -u claude-tweaks-dashboard   # "dashboard: moved ... (the phone view's state) to ...", then "dashboard: listening on ..."
tailscale serve --http=6767 off                # takes 6767's old phone.sock target off
tailscale serve --bg --http=6767 unix:$HOME/.local/state/claude-tweaks/dashboard/dashboard.sock
tailscale serve status
```

The address stays `http://<machine>:6767`. Then update the human-in-the-loop and progress plugins and start new sessions, so the status line, `/overview` and the progress pane's line follow.

## Local browser or T3 pane

Local mode runs directly on `127.0.0.1`, without Tailscale, a proxy, or identity headers.
It still requires a PIN login, a signed browser cookie, exact Host/Origin checks, and
a CSRF token on actions. It starts no services and changes no installed profiles.

1. Create a private config as in Install, step 1, but **choose your own PIN**: local
   mode refuses both a missing `pin` and the legacy `1337`. Use a long, unique PIN
   or passphrase without spaces (4–64 visible ASCII characters). Keep the file
   owned by you with mode 0600. The `hosts` setting is used only by Unix/Tailscale
   mode; local mode always requires the literal address and actual bound port.
2. Run in the foreground, using a separate state directory if you also use the
   Tailscale service:

   ```sh
   python3 -I "$CT/dashboard/server.py" --local \
     --config ~/.config/claude-tweaks/dashboard.toml \
     --state-dir ~/.local/state/claude-tweaks/overview-local
   # dashboard: listening on http://127.0.0.1:6767
   ```

3. Open the exact printed URL in a local browser or T3's browser pane, enter your
   PIN, and leave it open. The page polls independently of model activity. Stop
   the foreground server with Ctrl+C; closing the browser alone does not stop it.

`--port 6768` chooses another local port; `--port 0` asks the OS for a free one and
prints the resulting URL. `--port` requires `--local`. There is no bind-address
flag: `localhost`, network interfaces, IPv6, and arbitrary forwarded hosts are not
accepted. Use `127.0.0.1` exactly, including the printed port.

Local mode reads **only `CLAUDE_CONFIG_DIR`, or `~/.claude` when unset**, by default.
Set `profiles` in the private config or repeat `--profile LABEL=/absolute/path` to
select an explicit allowlist. These override the default; `--profile` overrides
the config's list. Unix mode uses the same default. Review the selected directories before sharing a browser session:
every task and saved Progress entry in those stores is visible after login.

Loopback is local to the machine where this process runs. A server on a remote
T3 environment or VPS is not your laptop's `127.0.0.1`. Open it from a browser
running in that environment, or use an explicitly arranged private tunnel that
preserves the local Host and Origin. Do not expose it with a public proxy or add
spoofed Tailscale headers; local mode refuses proxy headers. The existing systemd
unit permits AF_UNIX only and therefore cannot start TCP local mode unchanged.
This command does not modify that unit or the fork's dashboard controls.

Other local OS users can reach the port, so loopback alone is not authentication.
The PIN gate and persistent lockout protect reads and actions; a process running
as you can already read the config, state and stores. Cookies are scoped separately
from Unix/Tailscale mode, so switching transport requires the appropriate login.
The local cookie is named `ctdash-<port>`: browsers send 127.0.0.1 cookies to every
port, so the name only stops two local servers from overwriting each other; any other
local web server opened in the same browser still receives it (threat model, The cookie).
Both modes lock their state directory for their lifetime: use separate directories
to run them concurrently. For local mode removal, stop the process and remove its
private config/state directory if no other mode uses them; nothing was installed.

## Issue context and explicit refresh

`GET /api/document?session_id=<uuid>&profiles=<JSON-label-array>&repo=<owner/name>&number=<number>` reads the body and last 20 comments of an enrolled issue or attached PR. Normal authentication and exact session/profile selection apply. The server checks enrollment before and after the bounded GitHub CLI read (20 seconds, 2 MiB); it never accepts arbitrary GitHub repository access. The page renders source Markdown as plain text. Its GitHub login is the account of the server process, so use the intended native account's environment.

`POST /api/progress/refresh` takes `{ "session_id": "<uuid>", "profiles": ["label"] }`, with sorted exact profile labels, the signed cookie, same Origin and `X-CSRF-Token`. Enable **Web refresh** in Progress settings (off by default), then explicitly invoke Progress in the target session. The server contacts only that selected profile's private `progress-endpoint` Unix listener. The native mod owns metadata refresh and publication. Nothing writes its store from Python, calls a model, enrolls issues or opens a pane. Ordinary page polls never trigger this action.

A hidden Progress pane can accept a deliberate web refresh while staying hidden and without restarting its timers. Session end removes its listener. Missing/disabled controls, session changes, busy reads and GitHub failures have separate outcomes. A browser timeout is **unconfirmed**, not proof the native read stopped: a later publication still appears. No automatic retry sends another refresh.

## How a request travels

```
browser --WireGuard--> tailscaled on <machine> (Tailscale Serve, port 6767)
     --> unix:~/.local/state/claude-tweaks/dashboard/dashboard.sock --> server.py
            reads    <profile>/plugins/store/human-in-the-loop_*.json, progress_*.json
            answers  <profile>/hitl-endpoint/<session>.json --> that session's socket (the fork's listener)
            logs     python3 -I <profile>/hooks/decision_log.py
```

What Tailscale Serve does to each request, read from its source at the installed version (1.104.5, `ipn/ipnlocal/serve.go`): it deletes any `Tailscale-User-Login`, `Tailscale-User-Name`, `Tailscale-User-Profile-Pic` and `Tailscale-Funnel-Request` headers the client sent, then sets `Tailscale-User-Login` to the login of the node the request came from (none for a tagged node; `Tailscale-Funnel-Request: ?1` and no login for a Funnel request). For a `unix:` target it sends `Host: localhost` and puts the host the browser used in `X-Forwarded-Host`, which it sets (replacing any value the client sent).

## Endpoints

Every request's head must be strict HTTP/1.1 (see the threat model), else `400`. In default Unix mode, every request, whatever its path or method, passes these checks, or gets `403 {"outcome":"forbidden"}` and nothing else: exactly one `Host: localhost`; exactly one `X-Forwarded-Host` that is in `hosts`; no `Tailscale-Funnel-Request`; exactly one `Tailscale-User-Login` equal, byte for byte, to the login of the Tailscale user this machine was logged in as when the server started. Local mode instead requires exactly one `Host: 127.0.0.1:<bound-port>` and rejects every `Tailscale-*`, `X-Forwarded-*`, or `Forwarded` header. It uses `Origin: http://127.0.0.1:<bound-port>` for writes. Then the same endpoints and PIN/cookie/CSRF checks apply:

| Method and path | Needs | Returns |
|---|---|---|
| `GET /` | | the PIN page (`pin.html`) without a session; the page (`main.html`, carrying the CSRF token) with one |
| `GET /app.js` | | the page script |
| `GET /app.css` | | the page's stylesheet (`text/css`); `404` when `static/app.css` is not there |
| `GET /favicon.svg`, `GET /favicon.ico` | | the page icon (`image/svg+xml`, both paths; T3 asks for `/favicon.ico` when a page names none); `/favicon.svg?n=<1..99>` draws that count in an amber badge, any other query is `404` |
| `POST /unlock` | `Origin: http://<X-Forwarded-Host>`; a form body `pin=...` (`application/x-www-form-urlencoded`, at most 1 KiB) | `303` to `/` with the session cookie; `401` the PIN page with the tries left; `429` the PIN page with `Retry-After` while locked; `400` for a form without exactly one non-empty `pin`, `415` for another body type, `403` for another origin (none of these count as a try) |
| `GET /api/tasks` | the session cookie | the open tasks, below; `401 {"outcome":"locked"}` without a session |
| `GET /api/progress` | the session cookie | the progress store, below; `401` without a session |
| `GET /api/usage` | the session cookie | each configured profile's wrap-up usage, below; `401` without a session |
| `POST /api/answer` | the session cookie, `Origin: http://<X-Forwarded-Host>`, `X-CSRF-Token` of that session, `Content-Type: application/json`, at most 64 KiB | `200` and the endpoint's outcome, below. Refusals: `401 locked`, `403 forbidden` (origin), `403 {"outcome":"csrf"}`, `415`, `400 bad_request` (with a `message` naming the field, never its value), `411`, `413` |
| anything else | | `404 {"outcome":"not_found"}` |

Every reply has `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin` (not `no-referrer`, under which a browser sends `Origin: null` with the PIN form, which `/unlock` refuses), `X-Frame-Options: DENY` and `Content-Security-Policy: default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` (no inline script or style: a stylesheet comes from its own path, as `app.js` does).

### `GET /api/tasks`

```json
{"tasks": [{"session_id": "5f0c…", "root": "/home/you/proj", "profiles": ["work"],
            "session_state": "live", "endpoint": true,
            "id": 7, "created_ms": 1794999995000, "version": 1794999995000,
            "title": "…", "why": "…", "detail": "…" , "done_when": null,
            "kind": "choose", "options": ["Yes", "No"], "age_s": 5}],
 "skipped": {"files": 0, "entries": 0}}
```

- Only `state: "open"` tasks, newest first. An archived task (#187) also carries `archived_ms` and `deletes_ms` (7 days after archiving); one past `deletes_ms` is left out, as its session deletes it at its next store write. An ended session's task carries `via` when a live session in the same project and store has an answer endpoint entry (the one seen last): the page sends that task's Archive or Restore there, and that session takes the ended slot on to apply it; answers still wait for the next session. The page lists archived tasks apart, in a closed "Archived (n)" group. A task another session took on shows under the taker only, when the takeover note is one the fork reads (a list of tasks and a number at `atMs`); any other note hides nothing and counts in `skipped`.
- `profiles`: the profile whose `plugins/store/` held the store file, when that directory is that profile's alone; `[]` when several profiles reach one directory through a link (as the logins often share one), since such a store cannot say which login wrote a task. Each directory is read once. `endpoint`: an answer endpoint entry for the session exists in some profile (not proof that its listener runs). `session_state`: `ended` (the slot has `endedMs`), `quiet` (not seen for 3 minutes) or `live`.
- `root` is the project folder, or `#<hash>` where the fork hashed a long one. `detail` and `done_when` are `null` when the task has none; `options` is `[]` except for `choose`.
- `skipped`: store files that could not be read (not JSON, not an object, over 2 MiB, a link, a FIFO) or were past one read's bounds (32 files, 8 MiB by their sizes when listed), and entries that were not of the fork's shape (a slot, a task, or a key of the fork's older 0.1.4 layout, which no session can be answered through).

Store files read: `<profile>/plugins/store/human-in-the-loop_*.json`, which covers the upstream plugin's name (`human-in-the-loop_human-in-the-loop-<hash>.json`) and the fork's (`human-in-the-loop_local-<hash>.json`). A file several profiles reach is read once.

### `GET /api/progress`

```json
{"sessions": [{"session_id": "cc0a…", "profiles": ["work"],
               "goal": {"repo": "o/r", "numbers": [94, 95, 120], "added": [120], "removed": [96]},
               "review": {"repo": "o/r", "at": 1795052975767, "rounds": {"132": 2, "110": 1}, "tasked": [132]}}],
 "cancelled": [{"session_id": "cc0a…", "profiles": ["work"], "pull": 132, "repo": "o/r",
                "step": "failed", "note": "the session was cleared"}],
 "skipped": {"files": 0, "entries": 0}}
```

From `<profile>/plugins/store/progress_*.json`: each session's goal (`goal:<session>`), its review rounds per PR (every stored round, as the pane counts them) and the PRs it put to you at round 4 (`review:<session>`), and a cancelled "merge when green" (`ship-cancelled`). Sessions with review rounds come first, the latest first; `goal` or `review` is `null` when the store holds none for that session.

Current Progress also publishes `overview:<session>` after explicit invocation or a metadata refresh. `/api/progress` relays this versioned record as `session.snapshot`: its goal, issue rows, PR metadata, ordered sections/folds, issue-only totals, explicitly reported activity and separate publication/source timestamps. The native renderer and publisher use the same view computation. Malformed or inconsistent publications are skipped, while legacy goal/review data remains available. Older sessions without a publication are labeled legacy; the page never invents their groups or completion counts.

Each session also carries `session_state` and `seen_ms`, joined from the task stores' `tasks:<root>#session:<id>` slots (the progress store records neither): `live` or `quiet` as for tasks, `ended` only when every slot holding the session has `endedMs`, and `unknown` with `seen_ms: null` when no task store holds it. The Progress tab folds ended sessions, every legacy session, `unknown` sessions and `quiet` sessions whose snapshot is over an hour old into a closed "Earlier sessions (n)" line, one row each (session id, "Last published" for a published session that has not ended, else "Last seen", then repository and goal); a legacy session that has not ended is marked "Not published". With nothing live it says "No session is publishing progress now." A published session with no enrolled issues is one line, without the goal title, count and bar.

### `GET /api/usage`

The Usage tab's data: for each profile this dashboard reads (`profiles` in its config, else the effective `CLAUDE_CONFIG_DIR` or `~/.claude`), the 5-hour and 7-day readings from `<profile>/wrap-up/usage.json` with their reset and age, the profile's `wrap-up.toml` thresholds, whether wrap-up is latched and until when, and an `attention` list. The server loads the wrap-up engine from this checkout's `hooks/wrap_up_usage.py` and takes each row from its `profile_view` (which applies the engine's `policy` and `evaluate` and opens `usage.json` with `open_regular`), its stale limit `STALE_S`, and its `label_of` and `listed_profiles` for the config's `profiles`, so the page shows exactly what the hook decides; without that file the response is `{"available": false}` and the tab stays hidden. A `usage.json` whose `config` names another directory counts as no readings. It never returns session ids, generation ids, account identity or tokens. See `design/usage-view.md`.

### `POST /api/answer`

The page sends:

```json
{"request_id": "dash-3f9c…", "session_id": "5f0c…", "task_id": 7, "created_ms": 1794999995000,
 "version": 1794999995000, "action": "choose", "option": "Yes"}
```

`action` is `done`, `choose` (with `option`), `answer` (with `text`), `reject` (with an optional `reason`), `archive` or `restore` (no text: the task leaves the open list unanswered, or comes back, and nothing is sent to Claude; #187), as the fork's endpoint takes them; `task_id`, `created_ms` and `version` are the task's `id`, `created_ms` and `version` from `/api/tasks`. `request_id` (16 to 64 letters, digits, `-`, `_`) is drawn by the page and sent again unchanged when you retry the same answer, so it is applied once. The server adds `source: "phone"` (the endpoint's name for this server, kept from before the #167 rename: a session started earlier takes no other), finds the session's entry, `<profile>/hitl-endpoint/<session_id>.json` (format 2, a regular file of yours naming `<pid>.sock` directly in its own directory, which must be, by `lstat`, a socket of yours and not a link), and sends the answer to that socket with the entry's token. Where the session has entries in several profiles, one whose socket refuses the connection (nothing was sent) gives way to the next; once anything may have been sent, the answer goes to no other. It never writes a store file.

The reply is what the endpoint said:

```json
{"outcome": "accepted", "status": 200, "task": {"session_id": "5f0c…", "id": 7, "created_ms": 1794999995000, "version": 1795000001000, "state": "done"}}
```

- `outcome` and `status` are the endpoint's (`accepted`, `refused` 422 with its message, `stale`, `closed`, `reused` 409, `unknown` 404, `gone` 410, `busy` and `pending` 503, ...); `message`, `task` and `duplicate: true` come along where the endpoint gave them. An answer that looks like a secret is refused by the endpoint with 422 and its message; the server relays it and keeps nothing of the text.
- `{"outcome": "no_endpoint", "status": null, "message": "..."}`: the session has no entry, or its socket refuses the connection (a listener killed outright leaves its entry). The fork's endpoint is off unless turned on (Install, step 6).
- `{"outcome": "unreachable", "status": null, ...}`: the whole exchange with the endpoint (connect, send, its reply) did not end within 20 seconds, however slowly it came, or the endpoint answered something that is not its reply. Send the same answer again.

After `busy`, `pending` or `unreachable`, the page keeps the `request_id` so a second tap sends the same request.

### Decision log

Each answer that passed the checks writes one line through `<profile>/hooks/decision_log.py` (`docs/decision-log.md`), hook `dashboard`, decision `answer`, `reason` `<action> on task #<id> from the dashboard: <outcome>`, `inputs` `{id, created_ms, action, outcome, status, source: "phone"}`, `session` the task's session. Never the answer, the option or the reason. The line goes to the log of the profile whose entry took the answer; when none did, to the profile of the first entry tried, and with no entry at all to the first profile in the list (the effective profile, with the default list). It is handed on after the reply was tried, also when the browser had already gone. At most two writers run at once, each killed with everything it started (its process group) after 5 seconds or when the server stops; up to 64 lines wait for a writer, and a line past that is dropped. A writer that is missing, failing or hung changes and delays no answer. A refused request writes no line. Where the session judged the answer, the fork writes its own `human-in-the-loop` line too, with `source: phone`.

### The page

Designed in phase 2 with the impeccable skill, then revised after a design read by Codex (less to read before you know what needs you and whether you can answer it here). It reads like a mail reader with one correspondent: each open task is a message from a session, you reply to it, and every reply gets a receipt that says in words whether it reached the session.

**Files** (all in `static/`, served by the server itself; the Content-Security-Policy allows no inline script or style and no other origin, so there is no web font, framework or build step):

| File | What |
|---|---|
| `pin.html` | the PIN page; `{{message}}` is filled in (HTML-escaped) with the server's wrong-PIN or lockout sentence |
| `main.html` | the page; `{{csrf}}` is filled in. Its first comment states the design direction |
| `app.css` | the one stylesheet, served at `/app.css` (needs the server route that phase 2 handed over as a patch) |
| `app.js` | the one script, for both pages, served at `/app.js` |

**Look.** System sans for words and system monospace only for code, ids and times; graphite on paper in light, paper on graphite in dark, following the system setting (`prefers-color-scheme`). Messages are divided by hairline rules, not boxed. Reverse video is the one emphatic device: the status line (light theme) and the primary button. Amber means waiting, green delivered, red not delivered; each always comes with a drawn icon and a word, never colour alone. Icons are SVG drawn by the script (`createElementNS`) or inline in `pin.html`. Text is in `rem`, so it follows the browser's text size; it reflows at 200%. Touch targets are at least 44 px (T3C's tabs are 32 px tall to match T3's compact chrome, which still meets WCAG 2.5.8's 24 px minimum); focus shows a 2 px outline; all text passes WCAG AA in every theme; a third theme, **T3C**, matches T3 Code's own dark interface for the T3 side browser (from the theme toggle, or a link ending in `#theme=t3c`, such as `http://pop-os:6767/#theme=t3c`: a fragment, so the server still serves `/`; it applies on the PIN page too and is remembered like the others; see `design/t3c-theme.md`); the tab title leads with the count waiting on you ("(2) Overview": open tasks plus usage rows over threshold) and the page icon shows it as a badge that blinks three times when the count rises (so also on a first load with a count), then holds; a steady count never blinks (nor anything under reduced motion); motion (the sending spinner, a disclosure's chevron turning) stops under `prefers-reduced-motion`; receipts appear at once, with no entrance effect.

**Hooks.** Main page: `meta[name="csrf-token"]`, `.bar` (the sticky status line, `data-tone` `wait` or `fail`), `#status` (a live region: the count or the connection problem, rewritten only when it changes), `#checked` (freshness in words: "Updated just now", "Updated 20 s ago", "Last updated 2 min ago" while refreshes fail), `#tasks-heading` (visually hidden when nothing waits), `#feed-notice`, `#task-list`, `#sent` and `#sent-list` ("Answers from this browser", this page load only), `#progress-note`, `#progress-limits` (a disclosure: what the progress store does not hold, issue #146), `#progress-list`, `#last-answer` (a visually hidden live region that reads each outcome aloud). In `#task-list`: `.all-off` (the one note shown when every listed session that has not ended has web answers off), the active `article.task` cards, then `details.ended-group` (tasks of ended sessions, closed by default, its summary a count), then `details.ended-group.archived-group` ("Archived (n)", closed by default: an `article.archived-task` per archived task with its project and deletion day in `.task-meta`, and **Restore** in `.actions` where its session takes web answers (for an ended session's task, where it has `via`), else a note: restore it with `/my-tasks restore <n>` in that session, or, for an ended session's task, start a session in its project (the number is not named: the session that takes it on may number it anew)). An ended session's card shows **Archive** alone where it has `via`, else a note to start a session in its project to archive it (#191). Each task is `article.task[data-key][data-kind]` (`id` `task-…`, the target of progress's round-4 links) with `.from` (project, session state, "Asked 12 min ago"), `.task-title`, `.reach` when it cannot be answered here ("Web answers off" or "Session ended"), `.why`, `.done-when`, `.detail` (a `pre` in `.detail-text`; past 4 lines a preview cut at a line's edge, with "Read full instructions"), `.actions` (`.controls`: `button.option` per option, a primary Done, or the answer field, plus quiet "Other answer" / "Answer in words" / "Mark done without a reply" / "Reject" / "Archive"; and the `form[data-mode]` forms those open), `.task-note` (the full sentence of a card that cannot be answered), `.receipt[data-tone]` and `.task-meta` (short session id and project folder, the full path behind a disclosure; the profile list is left out because every profile reaches the one store here). PIN page: `#pin-form`, `#pin`, `#pin-message`, `#pin-unlock`.

**Behaviour.** The script polls `/api/tasks` and `/api/progress` every 5 s and when the page becomes visible. Each refresh is numbered and an older reply is never drawn over a newer one. Cards are kept and updated in place across polls, and only cards that moved are moved, so a field you are typing in keeps its focus, selection and text (the phone keyboard stays up). A card is rebuilt when its task's version, session state or endpoint changes, unless you are typing in it or its delivery is unconfirmed; after a `stale` outcome it is rebuilt anyway and keeps your draft and open form. One reply mode at a time: "Other answer", "Answer in words" and "Reject" put their form in place of the card's controls, with Cancel (or Escape) to bring them back; what you typed stays. While an answer is in flight the controls make way for a line naming what is being sent ("Sending: #139 first, then #104"). With one or two task cards each is shown whole; with three or more (owner decision, task #36, 2026-11-19: "Expanded up to 2 tasks, compact beyond that") each is one line (subject, project, "Web answers off" or "Session ended", age), a button with `aria-expanded` that opens the card in place; several can be open, an open card stays open across polls, a card holding a draft, an open reply form or an unconfirmed delivery is always open, and none opens by itself. A task missing from one poll proves nothing (its store may have been unreadable just then): its card stays as it was, in muted text, with "Not in the last update", and is whole again when the task is listed again; it goes after three polls in a row without it, unless its delivery is unconfirmed or it holds a draft (that card then says it is no longer listed, holds back its buttons and keeps your text to copy). An answered card stays 6 s with its receipt, then leaves; the answer stays in "Answers from this browser". Store text is set with `textContent` only. `http://pop-os:6767` is no secure context, so ids come from `crypto.getRandomValues`; the `request_id` is drawn once per answer and reused when you tap Try again or Retry same answer, so the session applies it at most once. While a delivery is unconfirmed the card offers only Retry same answer: a different answer would carry a new `request_id`, and nothing the page can see tells whether the first one landed (the retry is what finds out). Only a reply from the session's endpoint that says what became of the answer (`accepted`, also as a duplicate, `stale`, `closed`, `unknown`, `gone`, `refused`) settles it; any other retry result (`error`, `no_endpoint`, `unreachable`, `pending`, `busy`, a refusal by the dashboard itself, no reply or a cut-off one) keeps it unconfirmed, with the same request, the attempted answer, and a line saying what the last retry got. A Try again or Retry button carried over to a rebuilt card acts on the card in the page.

**States.** First load: two message-shaped placeholders. No open tasks: the section heading goes and "Nothing is waiting on you." speaks alone. A session that ended, or one with web answers off (`endpoint: false`): a short label under the title, a sentence where the buttons would be ("Web answers are disabled for this session. Answer in Claude."), and no answer buttons. When every listed session that has not ended has web answers off, one note above the list says so and where to turn them on (the human-in-the-loop plugin's "Answer endpoint" setting, then restart the session), and the cards carry only the label. Load failure before any data: a red notice with Try now; failure after data: the status line turns red ("Can't reach pop-os", or "The Overview server isn't answering" for a 502 to 504) with "Last updated …", and a notice says the list is from the last good poll. Answer outcomes, each a headline and a sentence:

| Outcome | Headline |
|---|---|
| `accepted` | Delivered (with what you sent); with `duplicate`, Already delivered |
| `stale` | Not sent: the task changed |
| `closed` | Not sent: already answered |
| `unknown` | Not sent: the task is gone |
| `gone` | Not sent: the session ended (the card then shows its session as ended) |
| `busy` | Not sent yet: the session is busy (Try again) |
| `pending`, `unreachable`, `error`, an outcome the page does not know, no reply or a cut-off reply | Delivery unconfirmed: "Your answer may have reached the session. Retrying the same answer is safe.", the attempted answer, and Retry same answer as the only control |
| anything but `accepted`, `stale`, `closed`, `unknown`, `gone`, `refused` on a retry of an unconfirmed delivery | Delivery still unconfirmed: "Last retry: …" with what it got, the attempted answer, and Retry same answer as the only control |
| `no_endpoint` | Not sent: web answers are off (answer in Claude) |
| `refused` with the secret message | Not sent: it looks like a secret (the field is emptied) |
| `refused`, other | Not sent, saying what answer is needed (one of its options, a shorter answer, a non-empty one); an unrecognised message is shown as it came |
| `csrf`, `reused`, `forbidden`, `bad_request` | Not sent, with a Reload button |
| `timeout`, `too_large`, `length_required`, `unsupported_media_type`, `not_found` (the dashboard's own refusals, before anything is relayed) | Not sent, naming the outcome |
| `401` | the page reloads to the PIN page (on a retry of an unconfirmed delivery the card first says it is still unconfirmed; the next poll reloads) |

PIN page: a wrong PIN shows the server's sentence with the tries left; a lockout keeps the server's sentence (its duration) and adds "Try again at 05:17.", with the field disabled until then.

**Previewing it.** Run `--local --port 0` with a scratch config, state directory and an explicit scratch `--profile` (never your real ones). No identity proxy or fake Tailscale is needed. Store files shaped like the ones in `tests/test_dashboard_view.py` give every state; a small Unix-socket server answering `POST /v1/answer` with a chosen outcome stands in for the fork's listener. Keep fixtures outside the repository and stop the server when done. Then `node --check dashboard/static/app.js` and the tests below.

## Threat model

**Who can reach the socket.** In default Unix mode, the socket (0600) is in `~/.local/state/claude-tweaks/dashboard/` (0700, owned by you; the server refuses a link or a directory someone else owns, and narrows a wider mode). So: tailscaled (root, for Tailscale Serve), and any process running as you. No other user of the machine, and nothing off the machine except through Tailscale Serve. Unix mode has no TCP port. Explicit local mode creates no Unix listener: other local OS users can reach its loopback TCP port, but PIN authentication still guards data and actions. The following identity/proxy discussion applies to Unix mode; local mode's safeguards and limits are above.

**What each check protects against, and what not.**

- **The identity header** (`Tailscale-User-Login` equal to your login) keeps out other people on the tailnet and tagged nodes: Serve sets the header from the WireGuard identity of the sending node and deletes whatever the client sent. It does not keep out any process on this machine running as you: such a process can connect to the socket and send the header itself. It also does not keep out anything else on this machine that reaches `http://<machine>:6767` through Tailscale: a request from the machine to its own tailnet address carries your login, whichever local user sent it. Duplicates, other cases, padding, an encoded form and a Funnel mark are all refused.
- **Who the owner is** comes from `tailscale status --json` on this machine, run once at start (the first `tailscale` on the server's PATH, no shell, a fixed argument list): the user this machine is logged in as. The identity check trusts that answer. Only a process running as you could change it (a `tailscale` placed earlier on your PATH, say), and such a process can already reach the socket and send any header, so nothing new is trusted. If the answer is missing, slow, over 8 MiB or names no login, or the system fails the call (out of file descriptors, say), the server does not start, saying so in one line; it never admits anyone without one. The command runs in a process group of its own, and when the call ends, however it ends (its answer, the 5 s bound, too much output, a failure, or a stop signal such as Ctrl+C or `systemctl stop`), that group is killed with everything the command started that is still in it. A process the command started that leaves the group (with `setsid`, say) is not killed then: under the unit, systemd ends it when the unit stops, since stopping a unit ends every process in its control group; run by hand, it runs until it ends by itself. The real `tailscale` is one program that starts no other, so this concerns only a wrapper put in its place (owner decision, AskUserQuestion 2026-11-19: the process group, with the unit's own cleanup behind it). Nothing from the answer is printed but a state Tailscale defines (`Stopped`, say); the login is never printed or written to any file.
- **The host check** (`Host: localhost`, `X-Forwarded-Host` in `hosts`) refuses a page that points a name of its own at the tailnet address (DNS rebinding through your phone's browser) and a request that did not come through Serve's `unix:` proxy. A process running as you can still send the right headers.
- **The PIN** stands in for a lost or borrowed device that is logged in to your tailnet, and for anything on this machine that goes through Tailscale. Four digits are few: five wrong PINs in a row lock the gate for 15 minutes, every further run of five doubles that (up to a day), one try at a time, and the count is kept in `lockout.json`, so restarting the server does not reset it (a process running as you can delete the file). The PIN is compared as SHA-256 digests in constant time. If the lockout cannot be saved (a full disk, say), no PIN is judged until it can: the gate answers locked and the server says why on stderr, once, so a restart cannot reopen guessing. A right PIN gives the browser a cookie signed with a key drawn from `secret`, the owner's login and the PIN: a new login, a new PIN or deleting `secret` logs every browser out once the server restarts (all are read at start).
- **The cookie** is `HttpOnly` (no script reads it) and `SameSite=Strict` (no other site's page makes the browser send it). It has no `Secure` flag, because the page is plain HTTP. It is not bound to a port: the phone's browser sends it to any other web server under the same host name (another port on `<machine>`), and `SameSite` counts that as the same site. Over plain HTTP neither `Secure` nor a `__Host-` name is available, so this is a risk left, not fixed. Local mode has the same gap on `127.0.0.1`: its `ctdash-<port>` cookie reaches every local port the browser opens, so a web server another local user runs on 127.0.0.1 could capture it from a page you open there and replay it until it expires or `secret` is deleted. Open only local pages you trust in the browser profile you unlock Overview in.
- **The CSRF token** (an HMAC of the session, in the page, sent back as `X-CSRF-Token` on every answer) and the `Origin` check refuse an answer another page in the same browser tries to send. Only `application/json` is taken for answers (a form cannot send it), and no CORS header is ever sent.
- **No TLS on the tailnet hop.** The page is plain HTTP inside WireGuard, which encrypts and authenticates every packet between your devices; the HTTPS certificate Tailscale offers matches only the full `*.ts.net` name. Anything that can read the traffic inside your devices can read the PIN and the cookie.
- **The request head is read strictly**: the request line and every header line must be of RFC 9112's shape, ended by CRLF, and the head by an empty line. A bare CR, a line without a colon, an obsolete folded line, a bare LF, a space before the colon, a control byte in a name or value, or a head cut off before its end is `400`. The identity check rests on reading the head as Tailscale Serve wrote it; Python's lenient parser read such shapes differently from Serve's Go parser and between Python versions (one could forge or hide a header). Serve never sends them.
- **Answer endpoint entries are checked as files**: the entry must be a regular file of yours, and the socket it names must be, by `lstat`, a socket of yours directly in the entry's directory; a link is not followed.
- **Store files are untrusted input**: a malformed file or entry is skipped and counted, never a crash; files are opened without following a link and never waited on (a FIFO is skipped); each is read only up to 2 MiB, one read takes at most 32 files and 8 MiB, and requests that arrive while a read runs share its reply.
- **Request bounds**: 48 headers and 16 KiB of head, a 64 KiB answer body (1 KiB for the PIN form), 5 s to read a request whole, 16 connections at once (one more is told `503 busy` at once and closed), 0.25 s to read away what a client still sends after its answer, 20 s for the whole exchange with an answer endpoint. A client that sends slowly holds one slot for 5 seconds at most.

**Work-profile data on a personal device.** The page shows the tasks and progress of both logins, the work one included, on whatever device opens it; that is your call. Session transcripts are not served at all in this phase; phase 3 adds them behind a per-session allowlist, and work sessions stay off it until the org admin agrees.

**Not guarded against:** a program running as you (it can read the config, the secret and the stores, reach the socket with the right headers, answer tasks through the fork's endpoint directly, or forge an entry, which holds one connection slot for the relay's 20 seconds at most); someone who has both a device on your tailnet and the PIN; a compromised Tailscale.

## Limits

- Live chat: phase 3.
- Sessions running an older Progress version have only legacy goal/review data. Current sessions must be explicitly invoked to publish; hiding Progress pauses its metadata refresh. HTTP connection freshness does not establish source freshness.
- The fork's 0.1.4 store layout (`tasks:<root>` with no `#session:`) is counted in `skipped`, not shown.
- Answers need the fork's answer endpoint (Install, step 6); without it each answer is `no_endpoint`.
- One server per state directory: a second exits with "already served by another process".
- In Unix mode the socket path must fit in 103 bytes: use a shorter `--state-dir` if it does not. Local HTTP has no Unix listener path limit.
- A cookie lives 30 days; there is no "log out" button (delete the cookie in the browser, or delete `secret` or change the PIN and restart the server).

## Files

| Path | What |
|---|---|
| `~/.config/claude-tweaks/dashboard.toml` | the config (yours, 0600, never committed) |
| `~/.local/state/claude-tweaks/dashboard/dashboard.sock` | the socket (0600) |
| `~/.local/state/claude-tweaks/dashboard/secret` | the key cookies are signed with (0600); delete it and restart the server to log every browser out |
| `~/.local/state/claude-tweaks/dashboard/lockout.json` | wrong PINs in a row and the lockout end (0600); delete it and restart to clear a lockout |
| `~/.local/state/claude-tweaks/dashboard/dashboard.lock` | held by the running server, so a second one stops before touching the socket |

`$XDG_CONFIG_HOME` and `$XDG_STATE_HOME` replace `~/.config` and `~/.local/state` when set. Nothing about requests is logged: no path, header, PIN or answer goes to stdout, stderr or a file. The server prints where it listens and its access mode (local PIN gate or the Tailscale user this machine is logged in as, never the login itself), one line saying why when it refuses to start, one line when it cannot save the PIN lockout, and one line when it reads the phone view's config or moves its state folder (Upgrading from the phone view).

## Tests

```sh
uv run --locked pytest -q tests/test_dashboard_view.py tests/test_dashboard_control.py tests/test_hitl_endpoint.py tests/test_dashboard_local.py tests/test_dashboard_migration.py
```

They run the server as the unit does (`python3 -I dashboard/server.py`; the strict-head test also under `/usr/bin/python3`, the unit's interpreter) on a scratch config, state directory and profiles, and send answers to the fork's real listener (`mods/human-in-the-loop/hooks/answer_endpoint.py`), started as `tests/test_hitl_endpoint.py` starts it. They never touch your `~/.claude*` directories, your config or Tailscale: a fake `tailscale`, alone on a scratch PATH, reports a made-up login.

`test_dashboard_local.py` runs the same server with `--local --port 0` and no Tailscale
on PATH. It verifies PIN login and lockout, profile isolation, Host/Origin and CSRF
checks, refused proxy identities, and real endpoint answer acknowledgement/retry.

`test_dashboard_migration.py` starts the server on its default paths in a scratch HOME and XDG folders, and checks the fallback to the phone view's config and the one-time move of its state folder (Upgrading from the phone view).
