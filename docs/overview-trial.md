# Try Overview locally

Overview combines deliberately selected GitHub issue progress and tasks that need a person's answer. The native entry point uses Claude Code panes; the optional web view works beside a conversation in T3 or in a phone browser. Nothing here requires a paid API or a cloud deployment.

## Requirements

- Claude Code with native mod support. Development is checked against 2.1.330; older versions are not guaranteed.
- GitHub CLI `gh`, signed in, for issue and PR metadata. Without it, tasks still work and Progress reports the read error.
- Python 3.11 or later for the optional web server and task-answer endpoint. Both use the standard library.
- Linux is the verified platform for the web server and Unix answer endpoint. Native terminal rendering was verified. Official Claude Code documentation also supports Desktop and VS Code panes; actual pane rendering in those hosts remains unverified in this trial. The web view is available independently.

## Get the trial

Use a private clone you already have access to, or extract the trial archive provided by a colleague. Keep the extracted directory: moving a local plugin source can change its store identity. This trial does not change repository visibility or publish a website.

The package contains only the two mods and optional dashboard (web) component. Do not run the repository's broad `install.sh`: it also manages policy hooks unrelated to Overview.

## Install either mod independently

From the checkout or extracted bundle:

```sh
claude plugin marketplace add "$PWD/mods"
claude plugin install progress@claude-tweaks-overview
# Optional; installs independently of Progress:
claude plugin install human-in-the-loop@claude-tweaks-overview
```

Restart Claude Code after installation. Use `/progress` for Progress and `/my-tasks` for tasks. `/overview` is the common entry point when both are installed: bare it opens both native tabs (and shows the web dashboard's address while it runs), `/overview web` says whether the web dashboard runs and where, and `/overview start` and `/overview stop` run it (once set up; human-in-the-loop provides these three). Task assignment keeps its existing `mcp__human-in-the-loop__assign_task` tool.

Use only one enabled copy of each mod. If you already have the upstream `human-in-the-loop@human-in-the-loop`, disable it first with `claude plugin disable human-in-the-loop@human-in-the-loop`; both register the same tools. The trial plugin keeps its store in a file named after the marketplace, so tasks open in the old copy do not appear in the new one: answer or withdraw them before switching, and back up your own configuration. A fresh install has nothing to migrate.

## View or set the options

`claude plugin configure progress@claude-tweaks-overview` lists the options and whether each is set (add `--json` for choices and current values). To set them from a shell, pipe a JSON object whose values are strings; booleans are the strings `"true"` and `"false"` (a JSON `true` is refused):

```sh
printf '{"web_controls":"true"}' | claude plugin configure progress@claude-tweaks-overview --values-stdin
printf '{"answer_endpoint":"true"}' | claude plugin configure human-in-the-loop@claude-tweaks-overview --values-stdin
```

Options left out keep their values. Restart Claude Code afterwards. `/plugin configure <plugin>` inside Claude Code does the same.

An isolated validation run can set `CLAUDE_CONFIG_DIR` to an empty temporary directory. Mod tests do not require signing in or starting model calls. An interactive session in a new profile requires its own normal Claude login; this package never copies credentials from another profile.

## Optional integrations

- **Web refresh** defaults off in Progress settings. Enable it, then explicitly open Progress in that session. The web **Refresh GitHub** button asks that native session to read GitHub and publish its result; it never calls a model, enrolls issues, opens a hidden pane or resumes background polling. It needs Python 3.11+. A slow read can be unconfirmed at the browser deadline; later publications still appear automatically.
- **Web owner merge controls** also default off. They require all three Progress settings: `owner_workflow`, `web_controls` and `web_owner_workflow`. The web view then shows the same eligible PR, pinned head/base, confirmation, cancellation, running state and outcome receipt as native Progress. Preparing a confirmation does not merge anything. Confirming a draft marks it ready and starts CI; Progress merges only after the native checks permit it. A timeout is unconfirmed, so inspect published state and GitHub before taking another action. No action retries automatically.
- Decision logging is best effort. With no profile-local writer, there is no log and no feature failure. The trial does not install policy hooks or a writer.
- The task answer endpoint defaults off. Enable it deliberately in the human-in-the-loop plugin's settings to answer through the web page. Without it, tasks remain readable and answerable in the native pane.
- Owner-specific review and merge conventions are optional. Ordinary progress tracking does not require umbrella branches, reviewer brief templates, a task-assignment tool or merge automation.
- Tailscale is optional. Local web access uses a separate loopback mode, with authentication and action protections; see `dashboard/README.md` for exact configuration and launch commands.

## Where localhost lives

Start the local server in the same environment whose Claude profiles you want to view. In a remote T3 environment, the browser target must reach that environment's server. Your phone's `localhost` means the phone itself. Use the retained Tailscale access path for phone access; never expose the loopback server by changing its bind address.

Refreshing the page does not call a model or enroll an issue. The page polls published state. Expand an issue or attached PR and choose **Read issue and comments** or **Read PR and comments** for its body and last 20 comments. Text is read on demand with the server process’s existing `gh` login, only for the exact enrolled session/profile selection. Keep that GitHub account aligned with the native session. The reader shows source Markdown as plain text.

Connection freshness and the age of the published progress are separate; a reachable server can still display stale source data.

## Stop or remove it

Stop a foreground web server with Ctrl+C. Use the documented Tailscale/service stop procedure only if you explicitly set those up. Hide the native view without deleting its state. Disable a mod with `claude plugin disable <name>@claude-tweaks-overview`; uninstall it with `claude plugin uninstall <name>@claude-tweaks-overview`. Keep a backup of any state you want to retain before removing its source directory.

## Check the trial without personal files

```sh
CLAUDE_CONFIG_DIR="$(mktemp -d)" claude plugin validate --strict mods/progress
CLAUDE_CONFIG_DIR="$(mktemp -d)" claude plugin validate --strict mods/human-in-the-loop
CLAUDE_CONFIG_DIR="$(mktemp -d)" claude plugin test mods/progress
CLAUDE_CONFIG_DIR="$(mktemp -d)" claude plugin test mods/human-in-the-loop
```

For repository development, run the Python and browser tests with the repository's locked development environment. The release notes must state which native surfaces were actually smoke-tested and any remaining limits; passing mod tests alone does not prove a real host draws correctly.

## Native Overview arrangement

The supported pane-opening API is plugin-owned: one plugin cannot open or render another plugin's pane directly. `/overview` coordinates explicit tools while retaining the existing `progress` and `human-in-the-loop` identities and stores. The host supplies native pane navigation; the web view supplies its own two tabs. `/progress` and `/my-tasks` remain direct aliases. No task or progress store is copied into a replacement plugin.

<!-- TODO(deferred): #166 Verify native pane hosting in desktop and VS Code with the same representative state.
why: Both mods loaded in an isolated official VS Code 2.1.330 extension, but a headless SDK had no surface and a later panel command stalled; no authenticated pane-rendering result was established.
wire: Issue #165 acceptance captures; repeat the terminal/browser smoke case in those hosts before claiming support.
-->

[Official Mods documentation](https://code.claude.com/docs/en/mods) lists supported hosts, and [VS Code documentation](https://code.claude.com/docs/en/vs-code#plugins-that-draw-in-the-panel) describes panel drawing. The isolated host procedure and evidence are recorded in the implementation handoff; loading tests establish neither rendering nor account-dependent behavior.

## Development checks and archive

From a clone with `uv` installed, run `uv sync --locked`, `uv run playwright install firefox`, then `uv run pytest`. Browser tests use isolated synthetic responses; no production server or model is started. The web server itself needs no Python package installation.

After committing the trial components, `scripts/package-overview.sh /absolute/path/overview-trial.tar.gz` packages that exact revision. It refuses an existing output path and uncommitted component changes. The archive contains the two mods, local marketplace, optional web server, and this guide. It contains no user profiles or credentials.
