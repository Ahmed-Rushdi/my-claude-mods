# Upstream

Forked from the `human-in-the-loop` plugin by Tzafrir Rehan, version 0.1.10
(https://github.com/tzafrir/human-in-the-loop), MIT licence (see `LICENSE`).

The first commit of this folder is that version unchanged, minus `media/`,
`docs/assets/`, `.github/` and the generated `.claude-plugin/types/` (large or
inert here). Later commits change:

- over-long `why` / `done_when` are refused with their length, not cut;
- new optional `detail` field with a full-picture view;
- longer options (120 characters) and up to 6 options;
- one decision-log line per refusal, per accepted task and per answer through the endpoint;
- a local answer endpoint on a Unix socket in the profile, off unless the `answer_endpoint` setting
  turns it on (`hooks/endpoint.ts`, `hooks/answer_endpoint.py`);
- dashboard status, start and stop from the pane, the `dashboard` tool (behind the Progress mod's `/overview web|start|stop`) and the desktop menu, and the dashboard
  line published in the plugin's state for the progress pane (`hooks/dashboard.ts`,
  `hooks/dashboard_control.py`).

See `README.md` for the limits and the deploy step.
