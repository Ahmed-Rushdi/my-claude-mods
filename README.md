# my-claude-mods

Two native [Claude Code](https://code.claude.com) mods, plus an optional web dashboard, for keeping an eye on agent work:

- **Progress**: a pane showing the GitHub issues you or an agent deliberately enrolled, with what is done and what is left.
- **Human in the loop**: Claude hands you tasks only you can do (a decision, a secret to put in place, a review). They stay in a **My tasks** pane until you answer, mark them done, reject them, or **archive** them. Archiving sends Claude nothing (it only sees the task as archived if it lists its tasks); archived tasks are deleted after 7 days.
- **Dashboard** (optional): the same Progress and My tasks in a browser, for hosts without native panes (such as T3 Code) or a phone over Tailscale. Standard-library Python, behind a PIN.

Each mod installs on its own. `/overview` opens both when both are installed.

## Try it

Requirements: Claude Code with native mod support (checked against 2.1.330), the GitHub CLI `gh` signed in (for Progress), and Python 3.11+ for the optional dashboard. Verified on Linux.

```sh
git clone https://github.com/Ahmed-Rushdi/my-claude-mods ~/my-claude-mods
cd ~/my-claude-mods
claude plugin marketplace add "$PWD/mods"
claude plugin install progress@claude-tweaks-overview
claude plugin install human-in-the-loop@claude-tweaks-overview   # optional, independent of Progress
```

Restart Claude Code, then use `/progress`, `/my-tasks`, or `/overview`. Keep the clone where it is: the plugins load from it.

The full guide, including the dashboard setup, is [docs/overview-trial.md](docs/overview-trial.md). Each mod's README covers its details and limits.

## Credits

`mods/human-in-the-loop` is a fork of [human-in-the-loop](https://github.com/tzafrir/human-in-the-loop) by Tzafrir Rehan (MIT licence, see `mods/human-in-the-loop/LICENSE` and `UPSTREAM.md` for what changed).
