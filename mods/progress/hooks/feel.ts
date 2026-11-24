// How a Button answers a press: a mark at once, a working state while a slow
// action runs, the result for a moment (#156). The engine has hover styles and
// one press event (no mouse-down or mouse-up), so the press is one moment and
// the rest is this module's own short state, timed with `$.clock.sleep` (a hook
// module has no timer globals).
//
// TODO(deferred): #156 move to `mods/_shared/` (with a copy-pinning test) when the human-in-the-loop fork gets the same feedback; until then the progress mod's own copy, deployed with it from `hooks/`.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Phase } from '../types'

/** How long the press shows before anything else does, and how long a result stays. */
export const PRESSED_MS = 200
export const RESULT_MS = 1500

const feels = atom({ plugin: 'progress', key: 'feel' } as const, {} as Record<string, Phase>)

/** The mark before a label in each phase; none at rest. */
const MARKS: Record<Phase, string> = { pressed: '● ', working: '◐ ', again: '◐ ', done: '✓ ', failed: '✗ ' }

/** What each Button of the pane is in now: read in the drawing. */
export function feelsOf($: EngineInterface): Promise<Record<string, Phase>> {
  return read($, feels)
}

/**
 * What a Button draws: its hover (bold and underlined under the pointer, which
 * reads in a light and a dark theme alike), the mark of its phase before its
 * label, and, at work, `working` in place of the label; told again, `again`.
 * A name for the group the pointer lights: the Button's own key.
 */
export function look(
  phases: Record<string, Phase>,
  key: string,
  label: string,
  words: { working?: string; again?: string } = {},
): { hover: { scope: string; bold: true; underline: true }; mark: string; label: string } {
  const phase = phases[key]
  const said = phase === 'working' ? (words.working ?? label) : phase === 'again' ? (words.again ?? 'still working…') : label

  return { hover: { scope: `progress:${key}`.slice(0, 64), bold: true, underline: true }, mark: phase === undefined ? '' : MARKS[phase], label: said }
}

/** What an action answers when it did not run its work because the same work is already at work (a refresh in flight): said as "still working", not as done or failed. */
export const STILL = Symbol('still at work')

// Kept in step with the atom at once, so a second press in the same moment finds the first.
const shown = new Map<string, Phase>()
/** The press each slow Button is at work for, by key. */
const busy = new Map<string, number>()
/** The latest press of each key: an older press's feedback gives way to it. Unique across keys and sessions. */
const turns = new Map<string, number>()
let presses = 0

async function show($: EngineInterface, key: string, phase: Phase | null): Promise<void> {
  if (phase === null) {
    shown.delete(key)
  } else {
    shown.set(key, phase)
  }

  await update($, feels, held => {
    const next = { ...held }

    if (phase === null) {
      delete next[key]
    } else {
      next[key] = phase
    }

    return next
  })
}

/**
 * A new session's pane starts with no press shown and nothing at work: a
 * press of the session before, still running, shows nothing on it when it
 * ends, and does not hold back the new session's presses.
 */
export async function resetFeel($: EngineInterface): Promise<void> {
  shown.clear()
  busy.clear()
  turns.clear()
  await update($, feels, () => ({}))
}

/**
 * Runs a Button's action exactly once for the press and draws its feedback: the
 * pressed mark for PRESSED_MS; for a slow action, a working state after that
 * while it runs. Then, for any action, failed (`✗`) for RESULT_MS where it threw
 * or rejected, whenever that was; for a slow one, done (`✓`) where it worked,
 * or "still working" where it answered STILL. A second press of a slow action
 * while it runs does nothing and the Button says so. The action starts in the
 * same moment as before, and nothing here changes what it does.
 */
export function pressing($: EngineInterface, key: string, action: () => unknown, isSlow = false): Promise<void> {
  // The feedback is the Button's own: where its waits end early (the plugin unloaded), nothing is raised.
  return press($, key, action, isSlow).catch(() => undefined)
}

type Outcome = 'done' | 'failed' | 'still'

async function press($: EngineInterface, key: string, action: () => unknown, isSlow: boolean): Promise<void> {
  if (isSlow && busy.has(key)) {
    await show($, key, 'again')
    await $.clock.sleep(PRESSED_MS)

    // At work still: back to saying so, unless the work has finished meanwhile.
    if (busy.has(key) && shown.get(key) === 'again') {
      await show($, key, 'working')
    }

    return
  }

  presses += 1
  const turn = presses
  const isMine = () => turns.get(key) === turn
  turns.set(key, turn)
  let result: Outcome | undefined

  if (isSlow) {
    busy.set(key, turn)
  }

  let ran: Promise<Outcome>

  try {
    ran = Promise.resolve(action()).then(
      value => (value === STILL ? 'still' : 'done'),
      () => 'failed',
    )
  } catch {
    ran = Promise.resolve('failed')
  }

  void ran.then(outcome => {
    result = outcome
  })
  const struck = show($, key, 'pressed')

  await $.clock.sleep(PRESSED_MS)
  await struck

  if (isSlow && result === undefined && isMine()) {
    await show($, key, 'working')
  }

  if (!isSlow && result === undefined && isMine()) {
    // A quick action still running: its mark goes, and only a failure comes back.
    await show($, key, null)
  }

  const outcome = await ran

  if (busy.get(key) === turn) {
    busy.delete(key)
  }

  if (!isMine()) {
    return
  }

  const phase: Phase | null = outcome === 'failed' ? 'failed' : !isSlow ? null : outcome === 'still' ? 'again' : 'done'

  if (phase === null) {
    if (shown.get(key) === 'pressed') {
      await show($, key, null)
    }

    return
  }

  await show($, key, phase)
  await $.clock.sleep(RESULT_MS)

  if (isMine()) {
    await show($, key, null)
  }
}

/** A press on a Button that has nothing to do while work is at its end (a second press of what is at work): says so for a moment. */
export function nudge($: EngineInterface, key: string): Promise<void> {
  return told($, key).catch(() => undefined)
}

async function told($: EngineInterface, key: string): Promise<void> {
  presses += 1
  const turn = presses
  turns.set(key, turn)
  await show($, key, 'again')
  await $.clock.sleep(RESULT_MS)

  if (turns.get(key) === turn) {
    await show($, key, null)
  }
}
