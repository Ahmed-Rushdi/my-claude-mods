# Progress

Explicit GitHub issue progress in a native pane, with the same displayed state
available to the local Overview web UI. It uses your existing `gh` login; no
model or paid API calls run in the background.

## Install independently

From the repository root, add the local marketplace and install this mod:

```sh
claude plugin marketplace add "$PWD/mods"
claude plugin install progress@claude-tweaks-overview
```

The plugin identity remains `progress`. Installing or opening it does not move
Human in the loop tasks or enable an answer endpoint. See the repository trial
instructions for the optional web server and task mod.

## Select exactly the issues you want

```text
/progress goal 165 127
/progress add https://github.com/owner/repo/issues/42
/progress remove 127
/progress refresh
/progress hide
/progress clear
```

`goal` replaces the selection; `add` appends. Numbers, `#numbers`,
`owner/repo#numbers`, and GitHub issue URLs work. A goal belongs to one
repository and holds at most 200 issues. Every number is validated as an Issue
before the selection changes. Standalone pull requests are refused. Parents do
not enroll their children; name each child you want counted.

`/progress` opens without enrolling anything. `hide` closes the pane and pauses
GitHub refresh until an explicit open, add, goal or refresh. `clear` removes the
goal. Selected issues remain until explicitly removed; none age out.

Ordinary prompts, turns, subagent activity, task lists, reads, mentions and
GitHub shell commands do not enroll, publish reports, open the pane or inject
prompts. Review rounds and round-4 tasks are never inferred.

## Overview entry point

`/overview` opens My tasks through its owning mod's explicit tool, then opens
Progress. Hosts that expose multiple native panes provide their tab navigation.
`/overview progress` and `/overview tasks` open one directly. Progress still
works independently when the task mod is absent; the command explains that My
tasks is unavailable. No task state is copied into Progress.

`/overview usage` opens the Usage pane, owned by the usage-collector mod, the same
way: it calls that mod's `open_usage` tool (a mod cannot open another plugin's
pane). With no surface attached (T3 Code) it opens nothing: the tool answers with
each profile's readings in text, and this mod leads them with the dashboard link
(`Open the dashboard: <address>`, or that it is not running), since
human-in-the-loop answers its dashboard tool for this mod only. Without
usage-collector it says `Usage is unavailable; install or enable usage-collector.`
A bare `/overview` opens Usage too, unfocused, after My tasks (with no surface,
its readings join the reply); without usage-collector it says nothing of Usage.
Tests: `#181` in `tests/progress.test.tsx`.

`/overview` is also the one command for the web dashboard (the same overview in
a browser). `/overview web` says whether the dashboard runs and where to open
it, `/overview start` and `/overview stop` run it, and a bare `/overview` opens
its panes first, then adds `Web dashboard: <address>` to its reply when the
dashboard's status says within a second that it runs (a slower answer is left
out). The controls live in human-in-the-loop and are reached through its
`mcp__human-in-the-loop__dashboard` tool; without that mod these three actions
say the controls come from it, and when its tool fails they say so with the
error. They do nothing until the dashboard is set up (`dashboard/README.md`).
The tool is hidden from the model (human-in-the-loop answers `tool.offer` with
`isOffered: false`) and refuses calls from anything but this mod, so Claude
cannot call it directly. From here it is reached only through `/overview`: a bare
`/overview` asks for the status, and `/overview web|start|stop` as above.
`/overview` runs whatever sent it, so a scheduled task, `/loop` or another session
whose prompt is `/overview start` does start the dashboard (accepted risk, owner
decision 2026-11-24: it serves only the PIN-protected page on your tailnet).
`/dash` no longer exists.

The terminal mod API supports these owner-scoped panes; desktop and VS Code
presentation must be checked on their actual hosts. This is not a single merged
plugin, and it does not require agents to call slash commands.

## Agent tools

The mod registers four tools with input schemas:

- `mcp__progress__enroll({ issues: "165 127" })`: explicitly enroll issues when
  taking them into work. Returns the current `session_id`; it does not open a
  pane. Reading or mentioning an issue is not a reason to enroll it.
- `mcp__progress__open({})`: open Progress without enrollment and return its
  current session identity.
- `mcp__progress__hide({})`: close Progress and pause metadata refresh.
- `mcp__progress__publish({...})`: explicitly report activity for the enrolled
  repository and current session, using the `session_id` from enroll/open.

Example explicit report:

```json
{
  "session_id": "the-id-returned-by-enroll",
  "repo": "owner/repo",
  "summary": "Implementing explicit enrollment",
  "working": true,
  "steps": [{ "id": "tests", "text": "Verify enrollment", "status": "in_progress" }],
  "agents": [{ "id": "worker-1", "type": "implementer", "what": "Enrollment", "ticket": 165, "status": "working" }],
  "marks": [{ "key": "checks", "kind": "check", "text": "Tests passed", "isBad": false }],
  "reviews": [{ "pr": 201, "key": "201:reviewed-head-sha" }]
}
```

Omitted fields remain unchanged. `steps` and `agents` replace their lists;
`marks` update by key; `reviews` add rounds by stable key, so retrying a report
cannot double-count a review. Reports never create tasks or run GitHub writes.
Agent `ticket` must already be enrolled. Agent status is `working`, `done` or
`interrupted`; optional fields are `lane`, `last`, `outcome`, `pr`, and `sha`.
Step status is `pending`, `in_progress`, or `completed`, with optional `doing`.
Mark kind is `commit`, `push`, `pr`, or `check`, with optional `lane`.

Input limits: summary/text fields 240 characters, IDs 80, mark/review keys 120,
agent SHA 64; 100 steps, 40 agents, 60 marks and 300 retained rounds. Numbers
must be positive safe integers. Unsupported nested fields and invalid types
are refused atomically; this is not an arbitrary state-write API.

## Completion, metadata and freshness

Every selected closed issue counts complete, including not planned and
reopened-then-closed issues. An open or reopened issue remains incomplete even
when an older PR merged. PRs, labels and blockers remain metadata, not progress
units. Native and web views use the same computed totals, section order, folds
and ticket rows. Completed issues are labelled **Completed**, not shipped.

While explicitly active, metadata polls every three minutes, paced by a soft
1,000 GitHub GraphQL points/hour budget. Queries contain at most 30 Issue rows,
without automatic sub-issue queries. A bounded PR-body follow-up supplies
umbrella metadata when necessary; unchanged bodies are cached. Errors and cut
answers retain the last good tickets and say why refresh failed.

The `progress` plugin's profile-local store publishes this versioned record:

```text
overview:<session_id> = {
  version: 1, session_id, at,
  goal: Goal | null,
  activity: Snap,
  view: { total, completed, sections: [{ id, label, fold, tickets }] }
}
```

`at` is actual publication time; `goal.fetchedAt` is the last successful GitHub
read. `activity.reportedAt`, agent `reportedAt`/`activeAt`, and mark timestamps
come only from explicit reports. A metadata poll never renews an agent report's
freshness. There are no periodic stamp-only publications. The containing
plugin store supplies profile isolation; each record is additionally bound to
its session. Delayed work checks that binding before later writes.

## Existing sessions

Goals and reviews keep their existing namespace and store keys. Legacy
explicit numbers remain selected; legacy `added` numbers (inferred by old
observers) are excluded by default. `/progress import` deliberately imports
only valid Issue rows from those inferred entries, excluding standalone PRs.
The original record is retained as `legacy-goal:<session_id>` before the first
selection write. Failed store reads start an empty binding rather than carrying
another session's goal or reports. Corrupt saved reports are ignored.

## Optional owner merge action

The `owner_workflow` user setting defaults to **false**. Enable it explicitly
in the Progress plugin settings to restore the user-only **merge when green**
action. Its existing confirmation, pinned head/base, required-check polling,
session cancellation and read-back receipts remain. Agent tools cannot invoke
it. A refused first state write leaves the action retryable. No merge happens
merely because an issue was enrolled or a PR was mentioned.

## Verify

```sh
claude plugin test mods/progress
claude plugin validate mods/progress
```

Tests use the native test kit at commands/tools and displayed/published state.
GitHub/process/store/clock boundaries are mocked; no test mutates GitHub or
calls a model. Actual host rendering and browser parity are separate checks.

## Optional web refresh

Enable **Web refresh** in this plugin's settings (default off), then explicitly open Progress. Python 3.11+ hosts a private refresh-only Unix listener in the active profile. The optional Overview page can ask this session to refresh GitHub metadata and publish the authoritative snapshot. The listener calls no model and writes no Progress store itself. Hiding Progress pauses its automatic refresh and presentation timers; an explicit web refresh still works without reopening it. Session end stops the listener. See [the trial guide](../../docs/overview-trial.md) and [web server guide](../../dashboard/README.md).
