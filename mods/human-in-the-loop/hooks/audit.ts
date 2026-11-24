import type { EngineInterface } from 'claude-code'

import { logDecision } from './decision-log'

/** The longest a task waits on the decision-log writer. */
export const LOG_WAIT_MS = 500

/** The name the lines carry in the decision log. */
const HOOK = 'human-in-the-loop'

/**
 * One decision-log line (docs/decision-log.md): `refuse` or `accept` for
 * `assign_task`, `answer` for an answer through the endpoint. Best effort:
 * the writer never throws, and a slow one is left behind after LOG_WAIT_MS,
 * so the log never fails or delays a task. A profile without the writer gets
 * no line: nothing is run, written or raised (`decision-log.ts`, a copy of
 * the shared caller kept byte for byte, runs python3 either way).
 */
export async function audit($: EngineInterface, decision: 'refuse' | 'accept' | 'answer', reason: string, inputs: Record<string, unknown>): Promise<void> {
  try {
    await Promise.race([hasWriter($).then(has => (has ? logDecision($, HOOK, decision, reason, inputs) : undefined)), $.clock.sleep(LOG_WAIT_MS)])
  } catch {
    // best effort
  }
}

/** Whether the profile holds the decision-log writer (`<profile>/hooks/decision_log.py`, the path `logDecision` runs); never throws. */
async function hasWriter($: EngineInterface): Promise<boolean> {
  try {
    const profile = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.claude`

    return await $.fs.exists(`${profile}/hooks/decision_log.py`)
  } catch {
    return false
  }
}
