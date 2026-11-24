// Decision log caller for mods (#99). Format and path rule: docs/decision-log.md.
// A mod's hooks may import only relative files and "claude-code", so this cannot touch the
// disk itself: it runs the Python writer (hooks/decision_log.py, deployed to
// <profile>/hooks/) through $.process.run. Copy this file next to the mod's register file.
// Best effort: never throws, never blocks the decision (the caller may skip the await).
import type { EngineInterface } from 'claude-code'

export async function logDecision(
  $: EngineInterface,
  hook: string,
  decision: string,
  reason = '',
  inputs: Record<string, unknown> = {},
): Promise<void> {
  try {
    const profile = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.claude`
    const session = await $.session.id()

    // The JSON goes on stdin, not argv: argv is capped (E2BIG) and visible in /proc.
    await $.process.run(['python3', '-I', `${profile}/hooks/decision_log.py`], {
      stdin: JSON.stringify({ hook, decision, reason, session: session ?? null, inputs }),
      timeoutMs: 5_000,
    })
  } catch {
    // best effort
  }
}
