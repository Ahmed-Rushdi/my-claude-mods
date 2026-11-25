import type { SectionId } from './github'

/**
 * The order the issue bar draws its states, left to right (#209): Completed first,
 * then the open work (the legacy `umbrella` section sits beside Waiting for you),
 * then Blocked and Deferred. Keep in step with STATE_ORDER in dashboard/static/app.js.
 */
export const STATE_ORDER: readonly SectionId[] = ['shipped', 'umbrella', 'yours', 'doing', 'ready', 'blocked', 'deferred']

/**
 * One theme colour per state, shared by the bar, the count words and the section headings.
 * Open work is blue (the theme has two blues: Waiting for you permission, In progress suggestion; Ready is
 * suggestion drawn dim, see `stateDim`), Completed green, Blocked red, Deferred none and dim.
 * Keep in step with STATE_ORDER in dashboard/static/app.js and the --state-* tokens in dashboard/static/app.css.
 */
export const STATE_COLOR = {
  shipped: 'success',
  umbrella: 'suggestion',
  yours: 'permission',
  doing: 'suggestion',
  ready: 'suggestion',
  blocked: 'error',
  deferred: undefined,
} as const satisfies Record<SectionId, string | undefined>

export function stateColor(id: SectionId): string | undefined {
  return STATE_COLOR[id]
}

/** Ready and Deferred are drawn dim: Ready a dim blue, Deferred dim with no colour. */
export function stateDim(id: SectionId): boolean {
  return id === 'ready' || id === 'deferred'
}

const BAND_LABEL: Partial<Record<SectionId, string>> = {
  shipped: 'complete',
  umbrella: 'in umbrella',
  doing: 'in progress',
  ready: 'ready',
  blocked: 'blocked',
  deferred: 'deferred',
}

/** The count words of the band, in the bar's order, for the non-empty states. Waiting for you is said apart, with its issue numbers. */
export function bandWords(counts: Readonly<Record<SectionId, number>>): { id: SectionId; label: string; n: number }[] {
  return STATE_ORDER.filter(id => id !== 'yours' && counts[id] > 0).map(id => ({ id, label: BAND_LABEL[id]!, n: counts[id] }))
}

/** The cells each non-empty state takes of a `width`-cell bar, `total` issues wide; issues in no section leave plain track. */
export function stateSegments(counts: Readonly<Record<SectionId, number>>, total: number, width: number): { id: SectionId; cells: number }[] {
  if (!(total > 0) || !(width > 0)) return []
  const states = STATE_ORDER.filter(id => counts[id] > 0)
  const exact = states.map(id => (counts[id] / total) * width)
  const cells = exact.map(one => Math.max(1, Math.floor(one)))
  const target = Math.min(width, Math.round((states.reduce((sum, id) => sum + counts[id], 0) / total) * width))
  let used = cells.reduce((sum, one) => sum + one, 0)
  // Hand out what is left by the largest remainder; take back from the widest segment when the minimum of one cell overshoots.
  while (used < target) {
    const at = exact.map((one, i) => [one - cells[i]!, i] as const).sort((a, b) => b[0] - a[0])[0]![1]
    cells[at]!++
    used++
  }
  while (used > target) {
    const at = cells.indexOf(Math.max(...cells))
    if (cells[at]! <= 1) break
    cells[at]!--
    used--
  }

  return states.map((id, i) => ({ id, cells: cells[i]! }))
}
