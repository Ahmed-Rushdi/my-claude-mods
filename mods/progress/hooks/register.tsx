// Explicitly selected issue progress and agent-reported activity. No lifecycle
// or general tool observation; native and web readers share one computed view.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Agent, Doc, Fold, Goal, OwnerSnapshot, Round, Ship, Snap, Ticket } from '../types'
import type { GoalRef, Part, PullNow, Rules, SectionId, Status } from './github'
import {
  FIRST_ROWS,
  GATHERING,
  SECTIONS,
  STATUSES,
  agentsOn,
  checksOf,
  checksQuery,
  docQuery,
  REFRESH_BUDGET,
  SETTLE_MS,
  gapOf,
  goalQueries,
  keepReachable,
  importQueries,
  leadPull,
  openBlockers,
  parseDoc,
  parseGoal,
  parsePull,
  parseRules,
  partsOf,
  underOf,
  pointsOf,
  pullQuery,
  readGoal,
  repoOf,
  rulesQuery,
  sameRepo,
  sectionOf,
  statusOf,
} from './github'
import { activityAt, reportOf } from './reports'
import { startWebControl } from './web-control'
import type { OwnerAction, OwnerOutcome, WebControl } from './web-control'
import { savedActivity, savedGoal } from './saved'
import { STILL, feelsOf, look, nudge, pressing, resetFeel } from './feel'
import { age, bar, oneLine, printable } from './observe'

const PANE = 'progress'
const POLL_MS = 180_000
const MAX_ROUNDS = 300
/** The review round at which the person is asked whether to go on. */
const ROUND_ASK = 4
/** How often, and how many times, "merge when green" looks at the checks before it merges: three hours in all. */
const RUN_POLL_MS = 30_000
const RUN_TRIES = 360
const USAGE = 'Usage: /progress [goal <issues> | add <issues> | remove <numbers> | refresh | hide | clear | import]'
const shortText = { type: 'string', maxLength: 240 }
const positiveInteger = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
const stepInput = { type: 'object', properties: { id: { type: 'string', maxLength: 80 }, text: shortText, doing: shortText, status: { enum: ['pending', 'in_progress', 'completed'] } }, required: ['id', 'text', 'status'], additionalProperties: false }
const agentInput = { type: 'object', properties: { id: { type: 'string', maxLength: 80 }, type: { type: 'string', maxLength: 80 }, what: shortText, lane: shortText, ticket: positiveInteger, status: { enum: ['working', 'done', 'interrupted'] }, last: shortText, outcome: shortText, pr: positiveInteger, sha: { type: 'string', maxLength: 64 } }, required: ['id', 'type', 'what', 'ticket', 'status'], additionalProperties: false }
const markInput = { type: 'object', properties: { key: { type: 'string', maxLength: 120 }, kind: { enum: ['commit', 'push', 'pr', 'check'] }, text: shortText, isBad: { type: 'boolean' }, lane: shortText }, required: ['key', 'kind', 'text', 'isBad'], additionalProperties: false }
const reviewInput = { type: 'object', properties: { pr: positiveInteger, key: { type: 'string', maxLength: 120 } }, required: ['pr', 'key'], additionalProperties: false }
const TOOLS = [
  { name: 'enroll', description: 'Explicitly add GitHub issues when you take them into work. Never enroll issues merely read or mentioned. Issues only; returns session_id for subsequent activity reports.', inputSchema: { type: 'object', properties: { issues: { type: 'string', maxLength: 8000 } }, required: ['issues'], additionalProperties: false } },
  { name: 'publish', description: 'Explicitly report progress for the current enrolled issue goal. Requires the session_id returned by enroll/open. Replaces only fields supplied; reports are timestamped and never inferred from other tools.', inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, repo: { type: 'string' }, summary: { type: 'string', maxLength: 240 }, working: { type: 'boolean' }, steps: { type: 'array', maxItems: 100, items: stepInput }, agents: { type: 'array', maxItems: 40, items: agentInput }, marks: { type: 'array', maxItems: 60, items: markInput }, reviews: { type: 'array', maxItems: 300, items: reviewInput } }, required: ['session_id', 'repo'], additionalProperties: false } },
  { name: 'open', description: 'Open Progress without adding issues or reporting activity. Returns the current session identity and tracking summary.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'hide', description: 'Hide Progress and pause GitHub refresh. Keeps explicitly selected issues and reports.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
]
/** Theme keys keep status colors consistent on native surfaces. */
const COLOR: Record<Status, string> = { yours: 'warning', doing: 'suggestion', blocked: 'error', ready: 'success', done: 'merged' }

const EMPTY: Snap = {
  goal: '',
  isWorking: false,
  turnStartedAt: 0,
  turnMs: 0,
  calls: 0,
  now: '',
  nowAt: 0,
  steps: [],
  agents: [],
  marks: [],
  rounds: [],
  tasked: [],
  at: 0,
}

// Change a tag when its type's fields change: a reload meets what the code
// before it stored, and the tag declines it.
const snap = atom({ plugin: 'progress', key: 'snap' } as const, EMPTY, { shape: 'snap-2' })
const goal = atom({ plugin: 'progress', key: 'goal' } as const, null, { shape: 'goal-3' })
const doc = atom({ plugin: 'progress', key: 'doc' } as const, null)
const ship = atom({ plugin: 'progress', key: 'ship' } as const, null, { shape: 'ship-3' })
/** The dashboard's line, as the human-in-the-loop plugin publishes it (#158): absent without that plugin, null until the dashboard is set up. */
const dashboardLine = atom({ plugin: 'human-in-the-loop', key: 'dashboard' } as const, null)

/**
 * How long a published dashboard line is drawn after it was read: the plugin
 * publishes it on every reading, each minute while installed, so this is two
 * readings and a half. Past it the line is gone, whatever stopped the
 * publishing (the plugin unloaded, the dashboard uninstalled). Owner
 * decision, AskUserQuestion 2026-11-19, option "Freshness stamp".
 */
export const DASHBOARD_FOR_MS = 150_000
/** How far ahead of this clock a stamp may be and still count. */
const DASHBOARD_SKEW_MS = 5_000

/** The dashboard line to draw at `nowMs` and how much longer it stands, from what the plugin published; none unless it is a stamped line under DASHBOARD_FOR_MS old. */
export function dashboardAt(published: unknown, nowMs: number): { line: string; at: number; leftMs: number } | undefined {
  if (typeof published !== 'object' || published === null) {
    return undefined
  }

  const { line, at, seq } = published as Record<string, unknown>

  if (typeof line !== 'string' || line.length > 1000 || printable(line, 200) === '' || typeof at !== 'number' || !Number.isFinite(at) || !Number.isSafeInteger(seq) || (seq as number) < 0) {
    return undefined
  }

  const ageMs = nowMs - at

  return ageMs < -DASHBOARD_SKEW_MS || ageMs >= DASHBOARD_FOR_MS ? undefined : { line, at, leftMs: DASHBOARD_FOR_MS - ageMs }
}

/** Draws the pane again as the dashboard line drawn comes of age, with no publication after it. */
let dashboardExpiry: Timer | null = null
/** The stamp of the line `dashboardExpiry` was armed for: a redraw of the same line leaves it as it is. */
let dashboardExpiryAt: number | undefined

/** One computation supplies the native renderer and the web snapshot. */
function viewOf(g: Goal | null, activity: Snap) {
  const tickets = g?.tickets ?? []
  return {
    total: tickets.length,
    completed: tickets.filter(one => !one.isOpen).length,
    sections: SECTIONS.map(({ id, label, start }) => ({
      id, label, fold: g?.sections?.[id] ?? start,
      tickets: tickets.filter(one => sectionOf(one, tickets, activity.agents, g?.trunk ?? '') === id),
    })).filter(section => section.tickets.length > 0),
  }
}

/** Publish only on an explicit update or an actual metadata refresh, never a timer stamp alone. */
function publishOverview($: EngineInterface, isCurrent = () => true): Promise<void> {
  const id = sessionId
  const selected = publications.then(async () => {
    if (!isCurrent() || id === '' || id !== sessionId || await $.session.id().catch(() => '') !== id || !isCurrent()) return
    const held = await read($, goal)
    const at = await $.clock.now()
    const activity = activityAt(copy(live), at)
    if (!isCurrent() || id !== sessionId || await $.session.id().catch(() => '') !== id || !isCurrent()) return
    const shipped = await read($, ship)
    if (!isCurrent() || id !== sessionId || id === endedId || await $.session.id().catch(() => '') !== id || !isCurrent()) return
    await $.store.set(`overview:${id}`, { version: 1, session_id: id, at, goal: held, activity, view: viewOf(held, activity), owner: { enabled: ownerWorkflow && webControls && webOwnerWorkflow, targets: ownerWorkflow ? ownerTargets(held) : [], ship: shipped } })
  })
  publications = selected.catch(() => undefined)
  return selected
}

/** Only receipts of an ended session may update its frozen publication; never attach a new goal. */
function publishStoppedOverview($: EngineInterface, id: string, receipt: Pick<Ship, 'pull' | 'repo' | 'step' | 'note'> | null, previousNote?: string): Promise<void> {
  const selected = publications.then(async () => {
    if (!id || sessionId === id || binding?.id === id) return
    const saved = await $.store.get(`overview:${id}`) as { version?: number; session_id?: string; owner?: OwnerSnapshot } | undefined
    if (saved?.version !== 1 || saved.session_id !== id || !saved.owner) return
    const before = saved.owner.ship
    if (receipt === null ? before?.step !== 'confirm' : !before || before.pull !== receipt.pull || !sameRepo(before.repo, receipt.repo) || previousNote !== undefined && before.note !== previousNote) return
    const at = await $.clock.now()
    if (sessionId === id || binding?.id === id) return
    await $.store.set(`overview:${id}`, { ...saved, at, owner: { ...saved.owner, enabled: false, ship: receipt === null ? null : { ...before, ...receipt } } })
  })
  publications = selected.catch(() => undefined)
  return selected
}

function activate($: EngineInterface): void {
  isActive = true
  ensureWebControl($)
  aging?.cancel()
  aging = $.clock.every(10_000, () => { if (isActive) $.ui.invalidate('ui.render') })
  poll?.cancel()
  poll = $.clock.every(POLL_MS, () => {
    void bound($).then(() => { if (isActive) void refresh($).catch(() => undefined) })
  })
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// Explicit activity reports write here; drawings read the published atom.
let live: Snap = copy(EMPTY)
let flushing: Promise<void> = Promise.resolve()
let poll: Timer | null = null
let aging: Timer | null = null
let isFetching = false
let isQueued = false
let queued: Timer | null = null
let pauseEpoch = 0
let webControls = false
let webOwnerWorkflow = false
let webControl: WebControl | null = null

/** Hide pauses presentation and automatic work; an explicitly enabled web listener stays usable. */
function pauseRefresh(): void {
  pauseEpoch += 1
  isActive = false
  aging?.cancel()
  aging = null
  poll?.cancel()
  poll = null
  queued?.cancel()
  queued = null
  isQueued = false
}

async function stopWebControl(): Promise<void> {
  const held = webControl
  webControl = null
  await held?.stop()
}

/** Explicit entry only. The host kills spawned children automatically on module unload. */
function ensureWebControl($: EngineInterface, id = sessionId): void {
  if (id !== sessionId || !webControls || id === '' || id === endedId || binding !== null) return
  if (webControl?.sessionId === id && webControl.isRunning()) return
  void stopWebControl()
  try {
    webControl = startWebControl($, id, async () => {
      if (id !== sessionId || binding !== null || id === endedId || await $.session.id().catch(() => '') !== id) return 'gone'
      const result = await refresh($, true)
      return result === 'done' ? 'refreshed' : result === 'skipped' ? 'gone' : result
    }, ownerWorkflow && webOwnerWorkflow ? request => ownerAction($, id, request) : undefined)
  } catch { /* Optional controls cannot prevent native Progress use. */ }
}
let fetchedAt = 0
/** What the last refresh spent, in points: the gap after it is worked out from it (`gapOf`). */
let spentLast = 0

/** How many sessions' review rounds the store keeps: the oldest go first. */
const KEPT_SESSIONS = 30
/** The session whose state the mod holds, '' while none is bound: its goal and review rounds are kept in the store under its id. */
let sessionId = ''
/** The session the engine last said ended: while the id still reads it, no session is bound. */
let endedId = ''
/** The binding in flight, of one session id: that session's events wait for it; another session's start their own. */
let binding: { id: string; done: Promise<void> } | null = null
/** The repository the session's review rounds are of: the goal's when they were counted, '' where none was known. */
let reviewRepo = ''
let isActive = false
let legacyGoal: unknown = null
let legacyAdded: number[] = []
let ownerWorkflow = false
let publications: Promise<void> = Promise.resolve()

const reviewKey = (id: string) => `review:${id}`
const goalKey = (id: string) => `goal:${id}`

/** A session's review rounds and round-4 asks, and the repository they are of. */
type Review = Pick<Snap, 'rounds' | 'tasked'> & { repo: string }

/** A session's review record as the store keeps it, or undefined where the value is not that. */
function keptReview(value: unknown): Review | undefined {
  const kept = value as { rounds?: unknown; tasked?: unknown; repo?: unknown } | null | undefined
  const isRound = (one: unknown) => {
    const round = one as Partial<Round> | null

    return Number.isSafeInteger(round?.pr) && (round?.pr ?? 0) > 0 && typeof round?.key === 'string' && round.key.length <= 120 && Number.isSafeInteger(round.at) && (round.at ?? -1) >= 0
  }
  const rounds = Array.isArray(kept?.rounds) && kept.rounds.length <= MAX_ROUNDS && kept.rounds.every(isRound) ? (kept.rounds as Round[]) : undefined
  const tasked = Array.isArray(kept?.tasked) && kept.tasked.length <= MAX_ROUNDS && kept.tasked.every(one => Number.isSafeInteger(one) && one > 0) ? (kept.tasked as number[]) : undefined

  return rounds === undefined || tasked === undefined ? undefined : { rounds, tasked, repo: typeof kept?.repo === 'string' ? kept.repo : '' }
}

/**
 * A goal is in one repository (owner decision, task #26, 2026-11-18, option
 * chosen: "Both as recommended"), and review rounds and round-4 asks know
 * their PRs by number only: a goal in another repository than theirs starts
 * them over. Rounds counted with no goal are taken as the first goal's.
 */
function roundsFor($: EngineInterface, repo: string): void {
  if (repo === '' || sameRepo(reviewRepo, repo)) {
    return
  }

  const isOther = reviewRepo !== ''
  reviewRepo = repo

  if (isOther) {
    live.rounds = []
    live.tasked = []
    void flush($)
  }

  if (isOther || live.rounds.length > 0 || live.tasked.length > 0) {
    void keepReview($).catch(() => undefined)
  }
}

/** A session's goal as the store keeps it, or null where none is (or the value is not one). */
function keptGoal(value: unknown): GoalRef | null {
  const saved = value as Partial<GoalRef> | null | undefined
  const numbersIn = (list: unknown) => (Array.isArray(list) && list.length <= 200 && list.every(one => Number.isSafeInteger(one) && one > 0) ? (list as number[]) : undefined)
  const allNumbers = numbersIn(saved?.numbers)
  const inferred = new Set(numbersIn(saved?.added) ?? [])
  const numbers = allNumbers?.filter(one => !inferred.has(one))

  const sections = Object.fromEntries(
    Object.entries(saved?.sections ?? {}).filter(([id, fold]) => SECTIONS.some(one => one.id === id) && (fold === 'open' || fold === 'all' || fold === 'closed')),
  ) as Record<string, Fold>

  return typeof saved?.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(saved.repo) && numbers !== undefined ? refOf({ repo: saved.repo, numbers, removed: numbersIn(saved.removed) ?? [], added: [], sections }) : null
}

/**
 * The one session routine (owner decision, task #26, 2026-11-18, option
 * chosen: "Both as recommended"): run at each event, it binds the session
 * whose id now reads, where that is not the one held. Nothing else binds
 * session state. Told that a session ended while the id still reads it, it
 * binds nothing until the id changes.
 */
async function bound($: EngineInterface): Promise<void> {
  // A few turns at most: each binding either holds or gave way to a later one.
  for (let tries = 0; tries < 3; tries += 1) {
    const id = await $.session.id().catch(() => '')

    // TODO(deferred): #125 R6-6: an ended id that never changes leaves the mod unbound for the rest of the process.
    if (id === '' || id === endedId) {
      return
    }

    if (binding?.id === id) {
      await binding.done

      continue
    }

    if (id === sessionId) {
      return
    }

    const mine: { id: string; done: Promise<void> } = { id, done: Promise.resolve() }
    binding = mine
    mine.done = bind($, id, mine)
      .catch(() => undefined)
      .finally(() => {
        binding = binding === mine ? null : binding
      })
    await mine.done
  }
}

/**
 * Binds session `id`: reads, together, its snapshot, its goal, its review
 * rounds and round-4 asks, and (in turn with the store's writes) the note of a
 * "merge when green" a change of session cancelled. After each wait it checks
 * that the id still reads `id` and no later binding or session end came
 * between; where one did, it binds nothing and leaves it to the later one.
 *
 * The goal is the session's own: a resumed session takes up the goal it had,
 * and one with none stored (after `/clear`, a new session) starts with none.
 * The rounds are the store's (no record means none), so a restarted process
 * takes them up and a new session starts at zero. Where a store read fails, this session starts
 * empty instead of retaining another session’s goal or reports. A "merge when green" left shown at
 * work with nothing at work is shown stopped.
 */
async function bind($: EngineInterface, id: string, mine: { id: string }): Promise<void> {
  const isMine = async () => (await $.session.id().catch(() => '')) === id && binding === mine && id !== endedId
  let shown = copy(EMPTY)
  let restored: Goal | null = null

  if (!(await isMine())) {
    return
  }

  pauseRefresh()
  await stopWebControl()
  if (!(await isMine())) return

  // A failed read is an empty binding, never the previous session’s state.
  let ref: GoalRef | null | undefined
  let kept: Review | undefined

  try {
    const original = await $.store.get(goalKey(id))
    if (!(await isMine())) return
    const backup = await $.store.get(`legacy-goal:${id}`)
    if (!(await isMine())) return
    legacyGoal = (original as { added?: unknown } | null)?.added !== undefined ? original : backup ?? null
    const oldAdded = (legacyGoal as { added?: unknown } | null)?.added
    legacyAdded = Array.isArray(oldAdded) ? oldAdded.filter(one => Number.isSafeInteger(one) && one > 0).slice(0, 200) : []
    ref = keptGoal(original)
  } catch {
    ref = null
    legacyGoal = null
    legacyAdded = []
  }

  if (!(await isMine())) {
    return
  }

  try {
    kept = keptReview(await $.store.get(reviewKey(id))) ?? { rounds: [], tasked: [], repo: '' }
  } catch {
    kept = { rounds: [], tasked: [], repo: '' }
  }

  if (!(await isMine())) {
    return
  }

  try {
    const saved = await $.store.get(`overview:${id}`) as { version?: unknown; session_id?: unknown; activity?: Snap; goal?: Goal } | undefined
    if (!(await isMine())) return
    if (saved?.version === 1 && saved.session_id === id) {
      shown = savedActivity(saved.activity) ?? copy(EMPTY)
      const keptGoal = savedGoal(saved.goal)
      if (ref && keptGoal && sameRepo(keptGoal.repo, ref.repo)) {
        restored = { ...keptGoal, ...ref, ...keepReachable(keptGoal, ref.numbers) }
      }
    }
  } catch { /* Missing/corrupt snapshot restores no other session's state. */ }
  if (!(await isMine())) return

  // A press of the session before shows nothing on this one's Buttons.
  await resetFeel($).catch(() => undefined)

  // The reset waits on a write: a later binding may have come in the meantime (#155 r2).
  if (!(await isMine())) {
    return
  }

  // Bound: from here the state is this session's, set with no wait in between.
  sessionId = id
  live = copy(shown)

  if (kept !== undefined) {
    live.rounds = kept.rounds
    live.tasked = kept.tasked
    reviewRepo = kept.repo
  }

  void flush($)
  let isNew = false
  const held = await update($, goal, current => {
    if (binding !== mine) return current
    isNew = ref === null ? current !== null : current === null || JSON.stringify(refOf(current)) !== JSON.stringify(ref)
    return ref === null || ref === undefined ? null : restored ?? { ...ref, title: ref.numbers.map(number => `#${number}`).join(' '), tickets: [], heads: [], fetchedAt: 0, error: '' }
  })

  if (isNew && binding === mine) {
    await update($, doc, () => null)
  }

  if (held !== null) {
    if (binding === mine) {
      roundsFor($, held.repo)
    }

    if (isActive) void refresh($, isNew)
  }

  await notAtWork($).catch(() => undefined)
  await showCancelled($, id).catch(() => undefined)
}

function flush($: EngineInterface): Promise<void> {
  const id = sessionId
  flushing = flushing
    .then(async () => {
      if (id === '' || id !== sessionId || await $.session.id().catch(() => '') !== id) return
      const published = copy(live)
      await update($, snap, () => published)
    })
    .catch(() => undefined)

  return flushing
}

const roundsOf = (rounds: readonly Round[], pr: number) => rounds.filter(one => one.pr === pr).length

function isBlank(s: Snap): boolean {
  return s.goal === '' && !s.isWorking && s.steps.length === 0 && s.agents.length === 0 && s.marks.length === 0
}

/**
 * The goal GitHub was asked about is still the one held: the same repository,
 * each number asked still in it or since removed. Numbers added meanwhile do
 * not void the answer; the next refresh asks for them.
 */
function isStillAsked(held: GoalRef, asked: GoalRef): boolean {
  return held.repo === asked.repo && asked.numbers.every(number => held.numbers.includes(number) || (held.removed ?? []).includes(number))
}

/** The goal's numbers as they are stored and as the next ask names them. */
function refOf(held: GoalRef): GoalRef {
  const listed = (key: 'removed' | 'added') => (held[key] === undefined || held[key].length === 0 ? {} : { [key]: held[key] })
  const folded = held.sections !== undefined && Object.keys(held.sections).length > 0 ? { sections: held.sections } : {}

  return { repo: held.repo, numbers: held.numbers, ...listed('removed'), ...listed('added'), ...folded }
}

let persisting: Promise<void> = Promise.resolve()
let goalWrites: Promise<void> = Promise.resolve()

/**
 * Keeps the session's review rounds and round-4 asks in the store, as they
 * stand now and under the session they are of, with the repository they are
 * of and when they were written, one write after another; past KEPT_SESSIONS
 * the sessions' records written longest ago are let go (the store's key order
 * says nothing of that).
 */
function keepReview($: EngineInterface): Promise<void> {
  const id = sessionId
  const key = reviewKey(id)
  const value: Review = { rounds: [...live.rounds], tasked: [...live.tasked], repo: reviewRepo }

  if (sessionId === '') {
    return persisting
  }

  const selected = persisting
    .then(async () => {
      const at = await $.clock.now()
      if (id !== sessionId || await $.session.id().catch(() => '') !== id) return
      await $.store.set(key, { ...value, at })
      const others = (await $.store.keys()).filter(one => one.startsWith('review:') && one !== key)
      const over = others.length - (KEPT_SESSIONS - 1)

      if (over <= 0) {
        return
      }

      const written = await Promise.all(
        others.map(async one => {
          const at = ((await $.store.get(one)) as { at?: unknown } | null | undefined)?.at

          return { key: one, at: typeof at === 'number' ? at : 0 }
        }),
      )

      for (const old of written.sort((a, b) => a.at - b.at).slice(0, over)) {
        await $.store.delete(old.key)
      }
    })

  persisting = selected.catch(() => undefined)
  return selected
}

/**
 * Stores the goal as it now stands, under the session bound when asked, one
 * write after another: a later write never carries an older list, and none
 * lands under a session no longer bound.
 */
function persist($: EngineInterface): Promise<void> {
  const id = sessionId
  const originalLegacy = legacyGoal

  const revision = selectionRevision
  const selected = goalWrites.then(async () => {
    const held = await read($, goal)
    const isMine = async () => id !== '' && id === sessionId && revision === selectionRevision && await $.session.id().catch(() => '') === id
    if (!(await isMine())) throw new Error('Session or selection changed; update again in the current session.')
    if (originalLegacy !== null && await $.store.get(`legacy-goal:${id}`) === undefined) {
      if (!(await isMine())) throw new Error('Session or selection changed; update again in the current session.')
      await $.store.set(`legacy-goal:${id}`, originalLegacy)
    }
    if (!(await isMine())) throw new Error('Session or selection changed; update again in the current session.')
    if (held === null) await $.store.delete(goalKey(id))
    else await $.store.set(goalKey(id), refOf(held))
  })
  goalWrites = selected.catch(() => undefined)
  return selected
}

async function readGitHub($: EngineInterface, asked: GoalRef & { closers?: Goal['closers'] }) {
  return readGoal(asked, { closers: asked.closers ?? {} }, async query => {
      const ran = await $.process.run(query, { timeoutMs: 20_000 })

      // A cut answer would read as a wrong pane, or as JSON that does not parse: said as what it is.
      if (ran.isStdoutTruncated) {
        throw new Error("GitHub's answer was over the 4 MiB a call may read, and was cut: the goal is too large to read in one refresh")
      }

      // On a GraphQL error `gh` exits non-zero with the answer still on stdout.
      if (!ran.stdout.trimStart().startsWith('{')) {
        throw new Error(ran.stderr.trim() || `gh exited ${ran.exitCode}`)
      }

      return ran.stdout
    })
}

/** How a refresh ended: it read GitHub; it failed (the goal shows why); one was in flight, so this one waits its turn; or it was not due. */
type Refreshed = 'done' | 'failed' | 'busy' | 'skipped'

/**
 * Asks GitHub where the goal stands: one refresh at a time, and none sooner
 * after the last than its cost allows (`gapOf`), unless forced (the person
 * asked, or named a new goal). A goal whose one refresh costs more than the
 * hour’s budget refreshes only when forced. Explicit selections never age out.
 */
async function refresh($: EngineInterface, isForced = false): Promise<Refreshed> {
  const id = sessionId
  const revision = selectionRevision
  const epoch = pauseEpoch
  const isCurrent = () => id !== '' && id === sessionId && id !== endedId && binding === null && revision === selectionRevision && epoch === pauseEpoch && (isForced || isActive)
  const isMine = async () => isCurrent() && await $.session.id().catch(() => '') === id && isCurrent()
  const asked = await read($, goal)
  if (!(await isMine())) return 'skipped'
  const now = await $.clock.now()
  if (!(await isMine())) return 'skipped'
  // Empty/native-only sessions still publish an authoritative refreshed snapshot.
  if (asked === null) {
    if (isFetching) return 'busy'
    await publishOverview($, isCurrent)
    return await isMine() ? 'done' : 'skipped'
  }
  const points = pointsOf(asked)
  const gap = gapOf(points, spentLast)
  if (isFetching || (!isForced && (gap === null || now - fetchedAt < gap))) {
    if (!isQueued && gap !== null && isActive) {
      isQueued = true
      queued = $.clock.after(Math.max(SETTLE_MS, gap - (now - fetchedAt)), () => {
        isQueued = false
        queued = null
        if (isCurrent() && isActive) void refresh($).catch(() => undefined)
      })
    }
    return isFetching ? 'busy' : 'skipped'
  }
  isFetching = true
  fetchedAt = now
  spentLast = points
  try {
    if (asked.numbers.length === 0) {
      await update($, goal, held => (!isCurrent() || held === null || !isStillAsked(held, asked) ? held : { ...held, title: 'No issues', tickets: [], heads: [], fetchedAt: now, error: '' }))
      if (!(await isMine())) return 'skipped'
      await publishOverview($, isCurrent)
      return await isMine() ? 'done' : 'skipped'
    }
    const { spent, ...parsed } = await readGitHub($, asked)
    if (!(await isMine())) return 'skipped'
    const at = await $.clock.now()
    if (!(await isMine())) return 'skipped'
    fetchedAt = at
    spentLast = spent
    await update($, goal, current => {
      if (!isCurrent() || current === null || !isStillAsked(current, asked)) return current
      // A number removed while GitHub was asked is left out of its answer here (`isStillAsked` lets the answer through).
      const out = new Set(current.removed ?? [])
      return { ...current, ...parsed, ...keepReachable({ tickets: parsed.tickets.filter(one => !out.has(one.number)), heads: parsed.heads.filter(one => !out.has(one.number)) }, current.numbers), fetchedAt: at, error: '' }
    })
    if (!(await isMine())) return 'skipped'
    await publishOverview($, isCurrent)
    return await isMine() ? 'done' : 'skipped'
  } catch (error) {
    if (!(await isMine())) return 'skipped'
    const reason = oneLine(error instanceof Error ? error.message : String(error), 160)
    const at = await $.clock.now()
    if (!(await isMine())) return 'skipped'
    fetchedAt = at
    await update($, goal, held => (!isCurrent() || held === null || !isStillAsked(held, asked) ? held : { ...held, error: reason }))
    if (!(await isMine())) return 'skipped'
    await publishOverview($, isCurrent)
    return await isMine() ? 'failed' : 'skipped'
  } finally {
    isFetching = false
  }
}

let selectionRevision = 0
async function setGoal($: EngineInterface, ref: GoalRef | null): Promise<void> {
  const id = sessionId
  const revision = ++selectionRevision
  if (id === '' || await $.session.id().catch(() => '') !== id) throw new Error('No current session is available.')
  if (ref === null) {
    await update($, doc, () => null)
    if (id !== sessionId || revision !== selectionRevision || await $.session.id().catch(() => '') !== id) throw new Error('Session or selection changed; clear again in the current session.')
    await update($, goal, () => null)
    await persist($)
    return
  }
  // Validate the entire selection as Issues before changing enrollment. A PR or
  // unavailable issue cannot silently join a goal or erase the previous one.
  const parsed = await readGitHub($, ref)
  const at = await $.clock.now()
  if (id !== sessionId || revision !== selectionRevision || await $.session.id().catch(() => '') !== id) throw new Error('Session or selection changed; enroll again.')
  fetchedAt = at
  spentLast = parsed.spent
  const { spent, ...metadata } = parsed
  await update($, doc, () => null)
  if (id !== sessionId || revision !== selectionRevision || await $.session.id().catch(() => '') !== id) throw new Error('Session or selection changed; enroll again.')
  await update($, goal, () => ({ ...ref, ...metadata, fetchedAt: at, error: '' }))
  roundsFor($, ref.repo)
  await persist($)
}

/**
 * Folds or opens a section of the pane; a state that is the section's own
 * start is not kept. The goal keeps the rest. `toggle` folds an open section
 * and opens a folded one to its start, as the section stands when the write
 * lands, so two presses before a redraw fold it and open it again.
 */
async function foldSection($: EngineInterface, id: string, to: Fold | 'toggle'): Promise<void> {
  const start = SECTIONS.find(one => one.id === id)?.start

  await update($, goal, held => {
    if (held === null) {
      return held
    }

    const sections = { ...held.sections }
    const now = sections[id] ?? start
    const fold = to !== 'toggle' ? to : now === 'closed' ? (start === 'closed' ? 'open' : (start ?? 'open')) : 'closed'

    if (fold === start) {
      delete sections[id]
    } else {
      sections[id] = fold
    }

    return { ...held, sections }
  })
  await persist($)
  await publishOverview($)
}

/** Explicitly removes selected issues without inferring any new enrollment. */
async function removeNumbers($: EngineInterface, numbers: readonly number[]): Promise<string> {
  selectionRevision += 1
  let gone: number[] = []

  await update($, goal, held => {
    gone = []

    if (held === null) {
      return held
    }

    const known = new Set([...held.numbers, ...held.tickets.map(one => one.number)])
    gone = [...new Set(numbers)].filter(number => known.has(number))
    const out = new Set(gone)
    const left = held.numbers.filter(number => !out.has(number))

    return gone.length === 0
      ? held
      : {
          ...held,
          numbers: left,
          added: (held.added ?? []).filter(number => !out.has(number)),
          removed: [...new Set([...(held.removed ?? []), ...gone])],
          // Shown without it at once; nothing is asked of GitHub for this.
          // A sub-issue that came only through a removed parent goes with it.
          ...keepReachable({ tickets: held.tickets.filter(one => !out.has(one.number)), heads: held.heads.filter(one => !out.has(one.number)) }, left),
        }
  })

  if (gone.length === 0) {
    return `Not in the goal's list: ${numbers.map(number => `#${number}`).join(' ')}.`
  }

  await persist($)

  return `Removed ${gone.map(number => `#${number}`).join(' ')} from the goal.`
}

async function openDoc($: EngineInterface, repo: string, number: number): Promise<void> {
  await update($, doc, () => ({ number, text: '', error: '' }))
  let loaded: Doc

  try {
    const ran = await $.process.run(docQuery(repo, number), { timeoutMs: 20_000 })

    if (!ran.stdout.trimStart().startsWith('{')) {
      throw new Error(ran.stderr.trim() || `gh exited ${ran.exitCode}`)
    }

    loaded = { number, text: parseDoc(ran.stdout), error: '' }
  } catch (error) {
    loaded = { number, text: '', error: oneLine(error instanceof Error ? error.message : String(error), 160) }
  }

  // Still the one being read: the person may have gone back, or on to another.
  await update($, doc, held => (held?.number === number ? loaded : held))
}

async function openWeb($: EngineInterface, repo: string, number: number): Promise<void> {
  await $.process.run(['gh', 'issue', 'view', String(number), '-R', repo, '--web']).catch(() => undefined)
}

// "Merge when green" runs only from explicit native or authenticated web owner
// actions: no registered model tool reaches it. Two steps, the second a confirmation. It runs
// only while the session the person pressed in is the current one (owner
// decision, task #13, 2026-11-18; source, the owner's prompt of 2026-11-18:
// "for the 4 tasks go with the sensible option", which took the task's
// recommended option): any change of session cancels it, and nothing is
// carried over.

/** The same last eligible PR supplies native and web owner actions. */
function ownerPull(ticket: Ticket, repo: string) {
  return ticket.pulls.findLast(one => one.state === 'OPEN' && sameRepo(one.repo, repo) && one.base !== '' && !GATHERING.test(one.base))
}

function ownerTargets(g: Goal | null): OwnerSnapshot['targets'] {
  return g === null ? [] : [...g.heads, ...g.tickets].flatMap(ticket => {
    const pull = ownerPull(ticket, g.repo)
    return pull ? [{ ticket: ticket.number, repo: g.repo, pull: pull.number, head: pull.head, base: pull.base, isDraft: pull.isDraft }] : []
  })
}

async function updateShip($: EngineInterface, change: (held: Ship | null) => Ship | null): Promise<void> {
  let changed = false
  await update($, ship, held => { const next = change(held); changed = JSON.stringify(held) !== JSON.stringify(next); return next })
  if (changed) await publishOverview($)
}

let confirmationSequence = 0
// confirmation_id is a UI token, not a secret: it is published in the Overview snapshot
// and only names which prepared confirmation a confirm or cancel answers. Authority comes
// from the user's explicit confirm and the native checks, so Math.random is sufficient.
function prepareShip($: EngineInterface, repo: string, confirmed: Confirmed): Promise<void> {
  return updateShip($, held => held?.step === 'working' || held?.step === 'armed' && held.pull === confirmed.pull && sameRepo(held.repo, repo) ? held :
    held?.step === 'confirm' && held.confirmation_id && sameRepo(held.repo, repo) && held.pull === confirmed.pull && held.head === confirmed.head && held.base === confirmed.base ? held :
      { pull: confirmed.pull, head: confirmed.head, base: confirmed.base, repo, step: 'confirm', note: '', confirmation_id: `${sessionId}:${Math.random().toString(36).slice(2)}:${Math.random().toString(36).slice(2)}:${++confirmationSequence}` })
}

async function cancelShip($: EngineInterface, confirmed: Ship): Promise<boolean> {
  let cancelled = false
  await updateShip($, held => {
    if (!held || held.step !== 'confirm' || held.pull !== confirmed.pull || !sameRepo(held.repo, confirmed.repo) || held.head !== confirmed.head || held.base !== confirmed.base || held.confirmation_id !== confirmed.confirmation_id) return held
    cancelled = true
    return null
  })
  return cancelled
}

// Retained for the session: a lost response must never replay a consumed confirmation.
const ownerRequests = new Map<string, { body: string; result: Promise<OwnerOutcome> }>()
function ownerAction($: EngineInterface, id: string, request: OwnerAction): Promise<OwnerOutcome> {
  if (id !== sessionId || id === endedId) return Promise.resolve('gone')
  for (const key of ownerRequests.keys()) if (!key.startsWith(`${id}:`)) ownerRequests.delete(key)
  const key = `${id}:${request.request_id}`
  const body = JSON.stringify(request)
  const previous = ownerRequests.get(key)
  if (previous) return previous.body === body ? previous.result : Promise.resolve('rejected')
  if (ownerRequests.size >= 512) return Promise.resolve('busy')
  const result = performOwnerAction($, id, request)
  ownerRequests.set(key, { body, result })
  return result
}

async function performOwnerAction($: EngineInterface, id: string, request: OwnerAction): Promise<OwnerOutcome> {
  if (!ownerWorkflow || !webControls || !webOwnerWorkflow) return 'disabled'
  const current = () => id === sessionId && id !== endedId && binding === null
  if (!current() || await $.session.id().catch(() => '') !== id || !current()) return 'gone'
  const g = await read($, goal)
  const target = ownerTargets(g).find(one => sameRepo(one.repo, request.repo) && one.pull === request.pull && one.head === request.head && one.base === request.base)
  if (!target || !current()) return 'rejected'
  const held = await read($, ship)
  // Session/selection may change across either read. No GitHub call precedes this recheck.
  if (!current() || await $.session.id().catch(() => '') !== id || !current()) return 'gone'
  const latest = await read($, goal)
  if (!ownerTargets(latest).some(one => JSON.stringify(one) === JSON.stringify(target))) return 'rejected'
  if (!current() || await $.session.id().catch(() => '') !== id || !current()) return 'gone'
  if (request.action === 'prepare') {
    if (request.confirmation_id !== '' || held?.step === 'working' || held?.step === 'armed' && held.pull === target.pull && sameRepo(held.repo, target.repo)) return 'rejected'
    await prepareShip($, target.repo, target)
    return current() ? 'prepared' : 'gone'
  }
  if (!held || held.step !== 'confirm' || !held.confirmation_id || held.confirmation_id !== request.confirmation_id || !sameRepo(held.repo, target.repo) || held.pull !== target.pull || held.head !== target.head || held.base !== target.base) return 'rejected'
  if (request.action === 'cancel') {
    return await cancelShip($, held) ? 'cancelled' : 'rejected'
  }
  const accepted = await startShip($, target.repo, held, { session: id, selection: selectionOf(latest) })
  return current() ? accepted ? 'started' : 'rejected' : 'gone'
}

/** What the person confirmed: the pull request, its head SHA and its base branch. */
type Confirmed = Pick<Ship, 'pull' | 'head' | 'base'>

/**
 * A "merge when green" at work: its pull request and repository, the session
 * it was pressed in, the timer it waits on, whether its merge call is out,
 * how far it marked the PR ready ('' it did not, 'asked' the call was out,
 * 'done'), and the note a session change left for it with why ('' while not
 * cancelled).
 */
const selectionOf = (g: Goal | null) => JSON.stringify(g && { repo: g.repo.toLowerCase(), numbers: g.numbers })

type Job = { context?: { session: string; selection: string }; pull: number; repo: string; session: string; timer: Timer | null; isMerging: boolean; ready: '' | 'asked' | 'done'; cancelled: string; why: string }

/** Each pull request a "merge when green" is at work on, with its job: a second press starts no second one. */
const inFlight = new Map<number, Job>()

/** Where a cancelled "merge when green" waits for the next session to show it: the ship state, with the session it was pressed in. */
const CANCELLED = 'ship-cancelled'

type Cancelled = Ship & { session: string }

/** What a change of session did to the session, in the words of a note. */
const ENDED: Record<string, string> = {
  clear: 'the session was cleared',
  resume: 'another conversation took its place',
  prompt_input_exit: 'the session was closed',
  logout: 'the account logged out',
}

/**
 * What a cancelled job's note says: why, whether anything was merged, and
 * whether it stays marked ready. With its merge call out, what was read back
 * after the call (`outcome`), where it is known by then.
 */
function cancelNote(job: Pick<Job, 'pull' | 'repo' | 'isMerging' | 'ready'>, why: string, outcome = ''): string {
  const cancelled = `Merge when green on PR ${job.repo}#${job.pull} was cancelled: ${why}`

  if (job.isMerging) {
    return outcome === ''
      ? `${cancelled} while its merge call was out, so whether it merged is not known here. Look on GitHub before pressing again.`
      : `${cancelled} while its merge call was out. Read back after it: ${outcome.charAt(0).toLowerCase()}${outcome.slice(1)}`
  }

  const ready = job.ready === 'done' ? ' It stays marked ready.' : job.ready === 'asked' ? ' Its ready mark was out, so it may stay marked ready.' : ''

  return `${cancelled} before it merged, so nothing was merged.${ready} Press again to go on.`
}

/** Thrown where a job is no longer the one at work in the session it was pressed in: it stops, and does nothing more. */
class Gone extends Error {}

/**
 * Holds a job to the session it was pressed in, after each wait: still the
 * job in hand, in a session that is still the current one. One whose session
 * went without its end reaching this copy (a timer of an older copy) lets
 * itself go and says so; one ended or replaced by another press stays quiet.
 */
async function still($: EngineInterface, job: Job): Promise<void> {
  const isMine = () => inFlight.get(job.pull) === job
  if (job.context) {
    const g = await read($, goal)
    if (job.context.session !== sessionId || sessionId === endedId || binding !== null || selectionOf(g) !== job.context.selection) {
      if (isMine()) { inFlight.delete(job.pull); await shipSays($, job.pull, 'failed', cancelNote(job, 'the selected session or goal changed')) }
      throw new Gone()
    }
  }

  // TODO(deferred): #122 a copy that never hears session.end, with the session resumed away and back within one look, finds its session current again and goes on to merge.
  if (isMine() && (await $.session.id()) === job.session && isMine()) {
    return
  }

  if (isMine()) {
    inFlight.delete(job.pull)
    await shipSays($, job.pull, 'failed', cancelNote(job, 'the session changed'))
  }

  throw new Gone()
}

/** Where a "merge when green" stands, while it is still the one in hand. */
async function shipSays($: EngineInterface, pull: number, step: Ship['step'], note: string): Promise<void> {
  await updateShip($, held => (held?.pull === pull ? { ...held, step, note } : held))
}

/**
 * A change of session ends every "merge when green" this copy has at work,
 * its timer first, before any wait. The next session shows it cancelled: in
 * the ship state, and in the store, where a new process finds it. A
 * confirmation not yet given is dropped.
 */
async function cancelShips($: EngineInterface, why: string, id: string): Promise<void> {
  const ended = [...inFlight.values()]

  for (const job of ended) {
    job.timer?.cancel()
  }

  inFlight.clear()
  const held = await read($, ship)

  if (held?.step === 'confirm') {
    await updateShip($, now => (now?.step === 'confirm' ? null : now))
    await publishStoppedOverview($, id, null)
  } else if (held?.step === 'working') {
    const job = ended.find(one => one.pull === held.pull && one.repo === held.repo)
    const note = cancelNote(job ?? { pull: held.pull, repo: held.repo, isMerging: false, ready: '' }, why)
    const left: Ship = { ...held, step: 'failed', note }

    if (job !== undefined) {
      // What its merge call did, read back later, takes this note's place.
      job.cancelled = note
      job.why = why
    }

    await updateShip($, now => (now?.pull === left.pull && now.step === 'working' ? left : now))
    await serially(() => $.store.set(CANCELLED, { ...left, session: job?.session ?? '' } satisfies Cancelled))
    await publishStoppedOverview($, id, left)
  }
}

/**
 * One store write after another, behind those already asked: the cancelled
 * note is written, rewritten and taken in the order asked.
 */
function serially(work: () => Promise<void>): Promise<void> {
  persisting = persisting.then(work).catch(() => undefined)

  return persisting
}

/**
 * The binding of the next session, or of one taken up again (a new process
 * on the same session, or a resume back to it): a "merge when green" a
 * session change cancelled is shown, once, as a toast naming its repository
 * and as the PR's note (on that repository's PR only). Not in a session told
 * ended (a process ending after it), nor where a later binding took over:
 * that one shows it. A value of an older shape is let go.
 */
function showCancelled($: EngineInterface, id: string): Promise<void> {
  return serially(async () => {
    const left = (await $.store.get(CANCELLED)) as Partial<Cancelled> | null | undefined

    if (left === null || left === undefined || id === endedId || id !== sessionId) {
      return
    }

    if (typeof left.pull !== 'number' || typeof left.note !== 'string' || typeof left.repo !== 'string') {
      await $.store.delete(CANCELLED)

      return
    }

    const shown: Ship = { pull: left.pull, step: left.step === 'armed' ? 'armed' : 'failed', note: left.note, head: String(left.head ?? ''), base: String(left.base ?? ''), repo: left.repo }
    await $.store.delete(CANCELLED)
    await updateShip($, held => (held?.step === 'working' ? held : shown))
    $.ui.toast(shown.note, { timeoutMs: 10_000 })
  })
}

/**
 * What the merge call a session change caught out did, read back after it,
 * in place of the note that said it was not known: in the ship state, and in
 * the store while the next session has not taken it. It calls nothing.
 */
async function laterOutcome($: EngineInterface, job: Job, step: Ship['step'], outcome: string): Promise<void> {
  const was = job.cancelled
  const note = cancelNote(job, job.why, outcome)
  const after: Ship['step'] = step === 'armed' ? 'armed' : 'failed'
  job.cancelled = note
  await publishStoppedOverview($, job.session, { pull: job.pull, repo: job.repo, step: after, note }, was)
  await updateShip($, (held): Ship | null => (held?.pull === job.pull && held.note === was ? { ...held, step: after, note } : held))
  await serially(async () => {
    const left = (await $.store.get(CANCELLED)) as Partial<Cancelled> | null | undefined

    if (left?.note === was) {
      await $.store.set(CANCELLED, { ...left, step: after, note })
    }
  })
}

/**
 * A "merge when green" shown at work with no job at work in this copy (the
 * mod reloaded and dropped its timer, or a session end's writes were cut off
 * at its time bound) is shown stopped, and can be pressed again.
 */
async function notAtWork($: EngineInterface): Promise<void> {
  await updateShip($, (held): Ship | null =>
    held?.step === 'working' && !inFlight.has(held.pull)
      ? {
          ...held,
          step: 'failed',
          note: 'Interrupted: it was no longer at work (the mod reloaded, or the session changed before it could say so), so it stopped. Look on GitHub to see where the pull request stands before pressing again.',
        }
      : held,
  )
}

/** `gh`, its output, or its own words for why it failed. */
async function gh($: EngineInterface, argv: string[]): Promise<string> {
  const ran = await $.process.run(argv, { timeoutMs: 30_000 })

  if (ran.exitCode !== 0) {
    throw new Error(oneLine(ran.stderr.trim() || ran.stdout.trim() || `gh exited ${ran.exitCode}`, 200))
  }

  return ran.stdout
}

/**
 * A job ends with a note: only while it is still the one in hand, so an ended
 * job writes over nothing. One a session change cancelled with its merge call
 * out says what the call did in place of its cancel note.
 */
async function shipEnds($: EngineInterface, job: Job, step: Ship['step'], note: string): Promise<void> {
  if (inFlight.get(job.pull) === job) {
    inFlight.delete(job.pull)
    await shipSays($, job.pull, step, note)
  } else if (job.isMerging && job.cancelled !== '') {
    await laterOutcome($, job, step, note)
  }
}

async function shipFailed($: EngineInterface, job: Job, error: unknown): Promise<void> {
  if (error instanceof Gone && inFlight.get(job.pull) === job) {
    inFlight.delete(job.pull)
    await updateShip($, held => held?.step === 'working' && held.pull === job.pull && sameRepo(held.repo, job.repo) ? { ...held, step: 'failed', note: cancelNote(job, 'the selected session or confirmation changed') } : held)
  }
  if (!(error instanceof Gone)) {
    await shipEnds($, job, 'failed', oneLine(error instanceof Error ? error.message : String(error), 300))
  }
}

/** Why the pull request no longer is what the person confirmed, or ''. */
function unlike(pull: PullNow, confirmed: Confirmed): string {
  if (!pull.isOpen) {
    return 'the pull request is no longer open.'
  }

  // There a merge call may queue it, or turn auto-merge on, instead of
  // merging: either would outlive the confirmation.
  if (pull.hasMergeQueue) {
    return `${pull.base} has a merge queue, which this button does not use. Nothing was merged; merge it on GitHub.`
  }

  if (pull.base !== confirmed.base) {
    return `it now merges into ${pull.base}, not ${confirmed.base} as confirmed. Nothing was merged; press again to merge it there.`
  }

  if (pull.head !== confirmed.head) {
    return `it has new commits since you confirmed (head ${pull.head.slice(0, 7)}, not ${confirmed.head.slice(0, 7)}). Nothing was merged; press again.`
  }

  return ''
}

/**
 * The pull request as it stands now, held to what the person confirmed: still
 * open, into the same base with no merge queue, at the same head. Where not,
 * it reads the board again and throws with why.
 */
async function stillConfirmed($: EngineInterface, repo: string, confirmed: Confirmed): Promise<PullNow> {
  const pull = parsePull(await gh($, pullQuery(repo, confirmed.pull)))
  const why = unlike(pull, confirmed)

  if (why !== '') {
    // The board read it as it was: read again, so the next press confirms it as it is.
    void refresh($, true)
    throw new Error(why)
  }

  return pull
}

/**
 * The merge call, then GitHub's word on what it did: the note says what
 * happened, not what was asked. A call that failed or timed out may still
 * have been taken, and on a branch with a merge queue a call may turn
 * auto-merge on instead of merging, which is switched off.
 *
 * The call waits on the session as every step does. Once it is out, what
 * follows only reads what it did and switches off an auto-merge left on in
 * its place: neither merges anything, so both run even if the session has
 * changed meanwhile (an auto-merge left on would outlive it).
 */
async function merge($: EngineInterface, repo: string, confirmed: Confirmed, rules: Rules, job: Job): Promise<void> {
  const pull = confirmed.pull
  let said = ''
  /** The call did not come back with GitHub's answer (it timed out, or was killed): GitHub may have taken it all the same. */
  let isUnsure = false

  await still($, job)
  job.isMerging = true

  try {
    const ran = await $.process.run(['gh', 'pr', 'merge', String(pull), '-R', repo, `--${rules.method}`, '--match-head-commit', confirmed.head], { timeoutMs: 30_000 })

    if (ran.exitCode !== 0) {
      said = oneLine(ran.stderr.trim() || ran.stdout.trim() || `gh exited ${ran.exitCode} with no word of why`, 200)
      // A refusal says why; a child ended by a signal says nothing.
      isUnsure = ran.stderr.trim() === '' && ran.stdout.trim() === ''
    }
  } catch (error) {
    said = error instanceof Error ? error.message : String(error)
    isUnsure = true
  }

  const call = said === '' ? 'GitHub took the merge call' : `the merge call failed (${said})`
  let now: PullNow

  try {
    now = parsePull(await gh($, pullQuery(repo, pull)))
  } catch {
    throw new Error(`${call} and the pull request could not be read back, so whether it merged is unknown. Look on GitHub before pressing again.`)
  }

  // The head GitHub has: after a failed call, another may have been merged in its place.
  const at = (now.head || confirmed.head).slice(0, 7)
  const unlikeConfirmed = now.head === '' || now.head === confirmed.head ? '' : `, not at ${confirmed.head.slice(0, 7)} as you confirmed`
  const instead = 'auto-merge was on instead of a merge (GitHub turns it on where it cannot merge yet, or someone else turned it on)'

  if (now.isMerged) {
    await shipEnds($, job, 'armed', unlikeConfirmed === '' ? `Its required checks passed: merged at ${at}.` : `It was merged at ${at}${unlikeConfirmed}: ${call}, and it was merged another way.`)
  } else if (now.isInMergeQueue) {
    await shipEnds($, job, 'armed', `Its required checks passed: queued in the merge queue of ${now.base} at ${at}${unlikeConfirmed}; GitHub merges it from there.`)
  } else if (now.hasAutoMerge) {
    try {
      await gh($, ['gh', 'pr', 'merge', String(pull), '-R', repo, '--disable-auto'])
    } catch (error) {
      throw new Error(`${instead}, and switching it off failed (${error instanceof Error ? error.message : String(error)}). Switch it off on GitHub: it would merge whatever is pushed next.`)
    }

    throw new Error(`${instead}; it was switched off. Nothing was merged; press again.`)
  } else if (isUnsure) {
    throw new Error(`the merge call did not finish (${said}), and the pull request still reads open: GitHub may still merge it, so the outcome is not known yet. Look on GitHub before pressing again.`)
  } else if (said !== '') {
    throw new Error(`the merge failed: ${said}. Nothing was merged.`)
  } else {
    throw new Error(`${call}, but the pull request is still open, not merged or queued. Nothing was merged; press again.`)
  }
}

/**
 * Merges once every required check has passed in this run, and not before.
 * No auto-merge is queued: one would outlive the confirmation (a retarget or a
 * push after it would still merge). Right before the merge the pull request is
 * read again and held to the confirmed base and head, and the merge itself
 * names the head (`--match-head-commit`), so GitHub refuses it if one landed
 * in between.
 *
 * Until the job that replaces it is created, a ready pull request still shows
 * its draft-time check, skipped, which GitHub reads as passed: a skipped
 * required check is waited out.
 *
 * Each look is a timer the job holds, so a change of session cancels it; each
 * step after a wait first checks the session (`still`).
 */
function mergeWhenGreen($: EngineInterface, repo: string, confirmed: Confirmed, rules: Rules, left: number, job: Job): void {
  const pull = confirmed.pull

  job.timer = $.clock.after(RUN_POLL_MS, () => {
    void (async () => {
      try {
        await still($, job)
        // `gh pr checks` exits non-zero while checks are pending or failing: its output is what is read.
        const checks = checksOf((await $.process.run(checksQuery(repo, pull), { timeoutMs: 30_000 })).stdout, rules.required)
        await still($, job)

        if (checks.failed.length > 0) {
          throw new Error(`these required checks failed: ${checks.failed.join(', ')}. Nothing was merged; press again once they pass.`)
        }

        if (checks.isGreen) {
          const now = await stillConfirmed($, repo, confirmed)

          if (now.isDraft) {
            throw new Error('it was put back to draft. Nothing was merged.')
          }

          await merge($, repo, confirmed, rules, job)
          void refresh($, true)
        } else if (left > 1) {
          mergeWhenGreen($, repo, confirmed, rules, left - 1, job)
        } else {
          throw new Error(`after three hours these required checks had not passed in this run: ${checks.waiting.join(', ')}. The pull request is ready; nothing was merged.`)
        }
      } catch (error) {
        await shipFailed($, job, error)
      }
    })()
  })
}

async function startShip($: EngineInterface, repo: string, confirmed: Confirmed, context?: Job['context']): Promise<boolean> {
  const number = confirmed.pull

  if (inFlight.has(number)) {
    return false
  }

  // Taken before any wait, so a second press finds it.
  const job: Job = { context, pull: number, repo, session: '', timer: null, isMerging: false, ready: '', cancelled: '', why: '' }
  inFlight.set(number, job)
  let consumed = false
  try {
    await updateShip($, held => {
      if (held?.step !== 'confirm' || held.pull !== number || !sameRepo(held.repo, repo) || held.head !== confirmed.head || held.base !== confirmed.base || ('confirmation_id' in confirmed && held.confirmation_id !== confirmed.confirmation_id)) return held
      consumed = true
      return { ...held, step: 'working', note: 'Reading the pull request and the rules of its branch…' }
    })
    if (!consumed) throw new Gone()
    // The session the person pressed in: the job is bound to it, and to no session not known.
    job.session = await $.session.id()
    if (context && job.session !== context.session) throw new Gone()

    if (job.session === '') {
      throw new Error('the session it was pressed in is not known, so it could not be held to it. Nothing was changed; press again.')
    }

    if (confirmed.head === '' || confirmed.base === '') {
      throw new Error('the board does not know its head yet. Refresh and press again.')
    }

    await still($, job)
    // As it stands now: what the board last read may be minutes old.
    const pull = await stillConfirmed($, repo, confirmed)
    await still($, job)

    if (GATHERING.test(pull.base)) {
      throw new Error(`it merges into ${pull.base}, which the session merges into itself.`)
    }

    const rules = parseRules(await gh($, rulesQuery(repo, pull.base)))
    await still($, job)

    if (rules.required.length === 0) {
      throw new Error(`${pull.base} has no required checks, so a merge would go in with nothing run. Nothing was changed.`)
    }

    if (rules.method === '') {
      throw new Error(`the rules of ${pull.base} share no merge method this button uses (merge, squash or rebase), so it could not merge. Nothing was changed.`)
    }

    // An auto-merge queued by anyone is not bound to this confirmation: a
    // retarget or a push would still merge it, and on a draft the ready mark
    // itself would, over the draft's skipped checks. Off first, or not at all.
    if (pull.hasAutoMerge) {
      await gh($, ['gh', 'pr', 'merge', String(number), '-R', repo, '--disable-auto'])
      await still($, job)
    }

    if (pull.isDraft) {
      await shipSays($, number, 'working', 'Marking it ready…')
      await still($, job)
      job.ready = 'asked'
      await gh($, ['gh', 'pr', 'ready', String(number), '-R', repo])
      job.ready = 'done'
      await still($, job)
    }

    await shipSays(
      $,
      number,
      'working',
      `It is ready and CI runs. It is merged at ${confirmed.head.slice(0, 7)} into ${confirmed.base} once every required check has passed in this run, if neither has changed by then. Keep this session open until then: a change of session cancels it.`,
    )
    await still($, job)
    mergeWhenGreen($, repo, confirmed, rules, RUN_TRIES, job)
  } catch (error) {
    await shipFailed($, job, error)
  }
  return consumed
}

let enrollments: Promise<void> = Promise.resolve()
function enrolled($: EngineInterface, args: string, replace = false): Promise<string> {
  const id = sessionId
  const selected = enrollments.then(async () => {
    if (id === '' || id !== sessionId || await $.session.id().catch(() => '') !== id) throw new Error('Session changed; enroll again in the current session.')
    return enrollNow($, args, replace)
  })
  enrollments = selected.then(() => undefined, () => undefined)
  return selected
}

async function enrollNow($: EngineInterface, args: string, replace = false): Promise<string> {
  const id = sessionId
  if (id === '') throw new Error('No current session is available.')
  if (typeof args !== 'string' || args.length > 8000) throw new Error('issues must be a string of at most 8000 characters.')
  const held = await read($, goal)
  const remote = await $.session.repo()
  if (id !== sessionId || await $.session.id().catch(() => '') !== id) throw new Error('Session changed; enroll again in the current session.')
  const parsed = parseGoal(args, held?.repo ?? repoOf(remote?.remote))
  if (parsed === undefined) throw new Error('Name positive issue numbers or GitHub issue URLs. Pull requests are metadata only.')
  if ('refused' in parsed) throw new Error(parsed.refused)
  if (parsed.numbers.length > 200) throw new Error('Select at most 200 issues.')
  if (!replace && held !== null && !sameRepo(held.repo, parsed.repo)) throw new Error('Clear the current goal before enrolling another repository.')
  const ref = replace || held === null ? parsed : { ...refOf(held), numbers: [...new Set([...held.numbers, ...parsed.numbers])], removed: (held.removed ?? []).filter(one => !parsed.numbers.includes(one)) }
  if (ref.numbers.length > 200) throw new Error('Select at most 200 issues.')
  activate($)
  await setGoal($, ref)
  await publishOverview($)
  return `Tracking issues in ${ref.repo}; session_id: ${id}.`
}

async function importLegacy($: EngineInterface): Promise<string> {
  const id = sessionId
  const held = await read($, goal)
  const saved = legacyGoal as { repo?: unknown } | null
  const repo = held?.repo ?? (typeof saved?.repo === 'string' ? saved.repo : '')
  if (repo === '' || legacyAdded.length === 0) return 'No legacy inferred issues to import.'
  const numbers: number[] = []
  for (const query of importQueries({ repo, numbers: legacyAdded })) {
    const ran = await $.process.run(query, { timeoutMs: 20_000 })
    if (ran.exitCode !== 0 || ran.isStdoutTruncated) throw new Error('Could not validate the legacy issues; nothing imported.')
    const answer = JSON.parse(ran.stdout)
    if (answer.errors?.length || !answer.data?.repository) throw new Error('Could not validate the legacy issues; nothing imported.')
    for (const number of legacyAdded) {
      const row = answer.data.repository[`i${number}`]
      if (row && typeof row.url === 'string' && /\/issues\/\d+$/.test(row.url)) numbers.push(number)
    }
    if (id !== sessionId || await $.session.id().catch(() => '') !== id) throw new Error('Session changed; nothing imported.')
  }
  const unique = [...new Set(numbers)]
  if (unique.length > 0) await enrolled($, unique.map(one => `${repo}#${one}`).join(' '))
  await publishOverview($)
  return `Imported ${unique.length} issue${unique.length === 1 ? '' : 's'}; standalone PRs were excluded. Original record preserved.`
}

async function openProgress($: EngineInterface): Promise<string> {
  const id = sessionId
  if (id === '' || id === endedId || await $.session.id().catch(() => '') !== id) throw new Error('No current session is available.')
  activate($)
  const heldBefore = await read($, goal)
  if (heldBefore !== null && heldBefore.fetchedAt === 0) await refresh($, true)
  await publishOverview($)
  const opened = await $.ui.open({ id: PANE, title: 'Progress' })
  const held = await read($, goal)
  const text = held === null ? 'No goal set. ' + USAGE : held.error !== '' ? `Goal ${held.title} in ${held.repo}: GitHub said: ${held.error}` : `Tracking ${held.title} in ${held.repo}: ${held.tickets.length} issue${held.tickets.length === 1 ? '' : 's'}.`
  return `${text} Session: ${sessionId}.${opened.isPlaced ? '' : ` (Pane not shown: ${opened.reason})`}`
}

async function hideProgress($: EngineInterface): Promise<void> {
  pauseRefresh()
  await $.ui.close({ id: PANE })
  $.ui.invalidate('ui.render')
}

const DASHBOARD_TOOL = 'mcp__human-in-the-loop__dashboard'
const NO_DASHBOARD = 'The dashboard controls come from human-in-the-loop; install or enable it.'

/** What the dashboard commands say when human-in-the-loop's tool is there and failed, with the error it gave. */
function dashboardFailed(why: string): string {
  const reason = printable(why, 300)
  return reason === '' ? 'The dashboard tool failed.' : `The dashboard tool failed: ${reason}`
}

/**
 * Asks human-in-the-loop's dashboard tool: its words, and the address while the dashboard runs.
 * Without that tool (the call rejects and the session's tools lack it), says where the controls come
 * from; when the tool errs, rejects while it is there, or answers without words, says it failed.
 */
async function dashboard($: EngineInterface, action: 'status' | 'start' | 'stop'): Promise<{ text: string; address?: string }> {
  let done: { deny?: string; isError?: boolean; text?: string; result?: unknown }
  try { done = await $.tool.call({ tool: DASHBOARD_TOOL, action } as never) as typeof done }
  catch (error) {
    const isThere = await $.tool.list().then(tools => tools.some(tool => tool.name === DASHBOARD_TOOL), () => false)
    return { text: isThere ? dashboardFailed(error instanceof Error ? error.message : String(error)) : NO_DASHBOARD }
  }
  if (done.deny !== undefined) return { text: done.deny }
  if (done.isError === true) return { text: dashboardFailed(done.text ?? '') }
  // The tool answers in text blocks: its words first, then the address while the dashboard runs.
  const said = done.result
  if (typeof said === 'string') return { text: said }
  // human-in-the-loop 0.1.14 and older answered with a bare {text, address?} object; accept it so updating only Progress keeps /overview working.
  if (typeof said === 'object' && said !== null && !Array.isArray(said)) {
    const old = said as { text?: unknown; address?: unknown }
    return { text: typeof old.text === 'string' ? old.text : dashboardFailed(''), ...(typeof old.address === 'string' ? { address: old.address } : {}) }
  }
  const [words, address] = (Array.isArray(said) ? said : []) as { text?: unknown }[]
  return { text: typeof words?.text === 'string' ? words.text : dashboardFailed(''), ...(typeof address?.text === 'string' ? { address: address.text } : {}) }
}

const USAGE_TOOL = 'mcp__usage-collector__open_usage'

/**
 * Opens Usage: the usage-collector mod owns the pane, and a mod cannot open another plugin's pane, so its `open_usage`
 * tool opens it (focused for /overview usage, unfocused beside the others for a bare /overview). With no surface the
 * tool opens nothing and answers with the readings in text: that is the reply. Undefined when usage-collector is not
 * there or failed.
 */
async function openUsage($: EngineInterface, isFocused: boolean): Promise<{ text: string; isHeadless: boolean } | undefined> {
  try {
    const result = await $.tool.call({ tool: USAGE_TOOL, focus: isFocused } as never) as { deny?: string; isError?: boolean; result?: unknown }
    if (result.deny !== undefined || result.isError === true) return undefined
    const isHeadless = ((await $.session.surfaces().catch(() => undefined))?.length ?? 1) === 0
    return { text: isHeadless && typeof result.result === 'string' ? result.result : 'Usage opened.', isHeadless }
  } catch { return undefined }
}

/**
 * /overview usage. With no surface the readings come led by where the web dashboard is: human-in-the-loop answers its
 * dashboard tool for this mod only, so this mod asks it, not usage-collector.
 */
async function usageReply($: EngineInterface): Promise<string> {
  const usage = await openUsage($, true)
  if (usage === undefined) return 'Usage is unavailable; install or enable usage-collector.'
  if (!usage.isHeadless) return usage.text
  const address = await dashboardAddress($)
  const link = address === undefined ? 'The web dashboard is not running (or did not answer in time): /overview start, dashboard/README.md' : `Open the dashboard: ${address}`
  return `${link}. ${usage.text}`
}

/** How long a bare /overview waits on the dashboard's status for its address, after the panes are open (the status itself may take 20 s). */
const ADDRESS_WAIT_MS = 1000

/** The web dashboard's address if human-in-the-loop says within ADDRESS_WAIT_MS that it runs; a later answer is dropped. */
async function dashboardAddress($: EngineInterface): Promise<string | undefined> {
  let timer: Timer | undefined
  const late = new Promise<undefined>(resolve => { timer = $.clock.after(ADDRESS_WAIT_MS, () => resolve(undefined)) })
  try { return await Promise.race([dashboard($, 'status').then(said => said.address), late]) }
  finally { timer?.cancel() }
}

export const register: Register = (on, options) => {
  ownerWorkflow = options['owner_workflow'] === true
  webControls = options['web_controls'] === true
  webOwnerWorkflow = options['web_owner_workflow'] === true
  on('session.start', async ($, e, next) => {
    for (const tool of TOOLS) await $.tool.register(tool)
    await $.command.register({ name: 'overview', description: 'Overview: Progress, My tasks and Usage in native tabs', argumentHint: '[progress | tasks | usage | web | start | stop]' })
    await $.command.register({
      name: 'progress',
      description: 'Explicitly selected GitHub issues and reported activity',
      argumentHint: '[goal <issues> | add <issues> | remove <numbers> | refresh | hide | clear | import]',
    })
    // A reload drops the timer a "merge when green" was waiting on: the binding shows it stopped (notAtWork).
    await bound($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // After /clear or a resume the process goes on as another session: its
    // state is bound afresh, once the id no longer reads this one. Any other
    // end is the process's.
    pauseRefresh()
    const stopped = stopWebControl()
    binding = null
    live = copy(EMPTY)
    sessionId = ''
    reviewRepo = ''
    endedId = e.sessionId
    await stopped

    // A "merge when green" belongs to the session it was pressed in.
    await cancelShips($, ENDED[e.reason] ?? 'the session ended', e.sessionId).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'overview' }, async ($, e) => {
    await bound($)
    const view = e.args.trim().toLowerCase()
    if (view !== '' && view !== 'progress' && view !== 'tasks' && view !== 'usage' && view !== 'web' && view !== 'start' && view !== 'stop') return { text: 'Usage: /overview [progress | tasks | usage | web | start | stop]' }
    if (view === 'usage') return { text: await usageReply($) }
    if (view === 'web' || view === 'start' || view === 'stop') return { text: (await dashboard($, view === 'web' ? 'status' : view)).text }
    let tasks = ''
    let isHeadless = false
    if (view !== 'progress') {
      try {
        const result = await $.tool.call({ tool: 'mcp__human-in-the-loop__open_tasks' } as never) as { deny?: string; isError?: boolean; result?: unknown }
        const isOk = result.deny === undefined && result.isError !== true
        // With no surface the tool opened nothing and answered with the dashboard's link and the tasks as text: that is the reply.
        isHeadless = ((await $.session.surfaces().catch(() => undefined))?.length ?? 1) === 0
        tasks = !isOk ? 'My tasks is unavailable; install or enable human-in-the-loop.' : isHeadless && typeof result.result === 'string' ? result.result : 'My tasks opened.'
      } catch { tasks = 'My tasks is unavailable; install or enable human-in-the-loop.' }
    }
    if (view === 'tasks') return { text: tasks }
    let progress: string
    try { progress = await openProgress($) }
    catch (error) { return { text: error instanceof Error ? error.message : String(error) } }
    // A bare /overview opens Usage too, unfocused, after the other two and without holding them up (the snapshot reader may
    // take seconds), where usage-collector is there; where it is not, Usage goes unsaid. With no surface its readings are
    // the reply, so that case waits for them.
    if (view === '') {
      const opening = openUsage($, false)
      if (isHeadless) {
        const usage = (await opening)?.text
        if (usage !== undefined) tasks = tasks ? `${tasks} ${usage}` : usage
      }
    }
    // The panes are open. The web dashboard's address, when human-in-the-loop says within
    // ADDRESS_WAIT_MS that it runs: nothing is added when it does not, is not set up, or is slower.
    const address = view === '' && !isHeadless ? await dashboardAddress($) : undefined
    return { text: `${tasks ? tasks + ' ' : ''}Progress: ${progress}${address === undefined ? '' : ` Web dashboard: ${address}`}` }
  })

  on('command.run', { command: 'progress' }, async ($, e) => {
    await bound($)
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    try {
      if (verb === 'import') return { text: await importLegacy($) }
      if (verb === 'hide') { await hideProgress($); return { text: 'Progress hidden; refresh paused.' } }
      if (verb === 'clear' || (verb === 'goal' && rest[0] === 'clear')) {
        await setGoal($, null)
        await publishOverview($)
        return { text: 'Goal cleared.' }
      }
      if (verb === 'goal' || verb === 'add') await enrolled($, rest.join(' '), verb === 'goal')
      else if (verb === 'remove') {
        const numbers = rest.map(word => Number(/^#?(\d+)$/.exec(word)?.[1]))
        if (numbers.length === 0 || numbers.some(one => !Number.isSafeInteger(one) || one <= 0)) return { text: USAGE }
        const text = await removeNumbers($, numbers)
        await publishOverview($)
        return { text }
      } else if (verb === 'refresh') { activate($); await refresh($, true) }
      else if (verb !== '') return { text: USAGE }
      return { text: await openProgress($) }
    } catch (error) { return { text: error instanceof Error ? error.message : String(error) } }
  })

  on('tool.call', { tool: 'mcp__progress__enroll' }, async ($, e) => {
    await bound($)
    try { return { result: await enrolled($, (e as unknown as { issues: string }).issues) } }
    catch (error) { return { deny: error instanceof Error ? error.message : String(error) } }
  })
  let reporting: Promise<void> = Promise.resolve()
  on('tool.call', { tool: 'mcp__progress__publish' }, async ($, e) => {
    await bound($)
    const id = sessionId
    const reported = reporting.then(async () => {
    try {
      const args = e as unknown as Record<string, unknown>
      if (id === '' || args.session_id !== id) throw new Error('Report session_id must match the current session.')
      const held = await read($, goal)
      if (held === null || typeof args.repo !== 'string' || !sameRepo(args.repo, held.repo)) throw new Error('Report repo must match an explicitly enrolled goal.')
      const revision = selectionRevision
      const now = await $.clock.now()
      const reported = reportOf(args, live, held, now)
      if (id !== sessionId || revision !== selectionRevision || await $.session.id().catch(() => '') !== id) throw new Error('Session changed; report again in the current session.')
      live = reported
      await flush($)
      if (id !== sessionId || await $.session.id().catch(() => '') !== id) throw new Error('Session changed; report again.')
      await keepReview($)
      if (id !== sessionId || await $.session.id().catch(() => '') !== id) throw new Error('Session changed; report again.')
      await publishOverview($)
      ensureWebControl($, id)
      return { result: `Progress reported for ${id}.` }
    } catch (error) { return { deny: error instanceof Error ? error.message : String(error) } }
    })
    reporting = reported.then(() => undefined, () => undefined)
    return reported
  })
  on('tool.call', { tool: 'mcp__progress__open' }, async ($) => {
    await bound($)
    return { result: await openProgress($) }
  })
  on('tool.call', { tool: 'mcp__progress__hide' }, async ($) => {
    await bound($)
    await hideProgress($)
    return { result: 'Progress hidden; refresh paused.' }
  })

  // The band: the goal in one row, and under it what the session is doing now.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await $.clock.now()
    const s = activityAt(await read($, snap), now)
    const g = await read($, goal)

    if (!isActive || e.props.hasSurvey || (g === null && isBlank(s))) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const tickets = g?.tickets ?? []
    const view = viewOf(g, s)
    const count = (id: SectionId) => view.sections.find(one => one.id === id)?.tickets.length ?? 0
    // Done is what the pane draws as landed; a PR of the goal closed unmerged is in no section, so in neither count (#155 r2, R2-4).
    const done = view.completed
    const total = view.total
    // A heading's own PR out of draft waits for the person as a ticket's does.
    const yours = [...(g?.heads ?? []), ...tickets].filter(one => statusOf(one, tickets, s.agents) === 'yours')
    // By the pane's sections: ready leaves out the deferred ones, and landed work is said as in umbrella and shipped (#125).
    const BAND_COUNTS: readonly { id: SectionId; label: string; hue: Status }[] = [
      { id: 'doing', label: 'in progress', hue: 'doing' },
      { id: 'blocked', label: 'blocked', hue: 'blocked' },
      { id: 'ready', label: 'ready', hue: 'ready' },
      { id: 'umbrella', label: 'in umbrella', hue: 'done' },
      { id: 'shipped', label: 'complete', hue: 'done' },
    ]
    const rest = BAND_COUNTS.map(one => ({ ...one, n: count(one.id) })).filter(one => one.n > 0)
    const running = s.agents.filter(one => one.endedAt === null)
    const last = s.marks.at(-1)

    return (
      <Box flexDirection="column">
        {g !== null && (
          <Text wrap="truncate-end">
            <Text bold>{oneLine(g.title, 44)}</Text>
            {total > 0 && (
              <Text>
                {' '}
                {done}/{total} <Text color={COLOR.done}>{bar(done, total, 10)}</Text>
              </Text>
            )}
            {yours.length > 0 && (
              <Text color={COLOR.yours} bold>
                {' '}
                · {yours.length} waiting for you
                {yours
                  .slice(0, 3)
                  .map(one => ` #${leadPull(one)?.number ?? one.number}`)
                  .join('')}
              </Text>
            )}
            {rest.map(one => (
              <Text>
                <Text dimColor> · </Text>
                <Text color={COLOR[one.hue]}>
                  {one.n} {one.label}
                </Text>
              </Text>
            ))}
            {g.error !== '' && <Text color="error"> · {g.error}</Text>}
            {g.error === '' && g.fetchedAt === 0 && <Text dimColor> · asking GitHub…</Text>}
          </Text>
        )}
        {(s.isWorking || g === null) && (
          <Text wrap="truncate-end">
            {s.isWorking ? (
              <Text>
                <Text color="warning">◐ </Text>
                {s.now || s.goal || 'Working (reported)'}
                <Text dimColor> · {age(now - s.nowAt)}</Text>
              </Text>
            ) : (
              <Text dimColor>● {s.goal || 'No work reported'}{s.turnMs > 0 ? ` · last reported work ${age(s.turnMs)}` : ''}</Text>
            )}
            {running.length > 0 && (
              <Text dimColor>
                {' '}
                · {running.length} agent{running.length === 1 ? '' : 's'}: {running.map(one => `${one.type} ${age(now - one.startedAt)}`).join(', ')}
              </Text>
            )}
            {last !== undefined && (
              <Text dimColor>
                {' '}
                · <Text color={last.isBad ? 'error' : undefined}>{last.text}</Text> {age(now - last.at)} ago
              </Text>
            )}
          </Text>
        )}
        {running.some(one => one.isStale) && (
          <Text color="warning" wrap="truncate-end">
            {running
              .filter(one => one.isStale)
              .map(one => `${one.type} ${one.lane || oneLine(one.what, 24)} No report for ${age(now - one.activeAt)}`)
              .join(' · ')}
          </Text>
        )}
      </Box>
    )
  })

  // The pane: the goal's issues by where they stand, each opening to be read;
  // under them, the session's own agents and what it made.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const now = await $.clock.now()
    const s = activityAt(await read($, snap), now)
    const g = await read($, goal)
    const reading = await read($, doc)
    const dashboard = dashboardAt(await read($, dashboardLine), await $.clock.now())

    if (dashboard !== undefined && dashboard.at !== dashboardExpiryAt) {
      dashboardExpiry?.cancel()
      dashboardExpiryAt = dashboard.at
      dashboardExpiry = $.clock.after(dashboard.leftMs, () => {
        dashboardExpiry = null
        dashboardExpiryAt = undefined
        $.ui.invalidate('ui.render')
      })
    }
    const feels = await feelsOf($)
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const tickets = g?.tickets ?? []
    const standing = (ticket: Ticket) => statusOf(ticket, tickets, s.agents)

    /** ` · round 3` after a PR, from the verdicts this session recorded; warm from the round the person is asked at. */
    const roundTag = (pr: number | undefined) => {
      const n = pr === undefined ? 0 : roundsOf(s.rounds, pr)

      return n === 0 ? null : (
        <Text color={n >= ROUND_ASK ? 'warning' : undefined} dimColor={n < ROUND_ASK}>
          {' '}
          · round {n}
        </Text>
      )
    }

    /** What a Button draws for its key: its hover and its label with the mark of its press before it. `feel(key).mark` alone, for a Button whose label is its children. `press` runs its action with the feedback. */
    const feel = (key: string, label = '', words?: { working?: string; again?: string }) => {
      const drawn = look(feels, key, label, words)

      return { hover: drawn.hover, mark: drawn.mark, label: drawn.mark + drawn.label }
    }
    const press = (key: string, action: () => unknown, isSlow = false) => () => void pressing($, key, action, isSlow)

    /** A row's parts after its title, each in its tone, a space before each. */
    const toned = (parts: readonly Part[]) =>
      parts.map(part =>
        part.tone === 'dim' ? <Text dimColor> {part.text}</Text> : <Text color={part.tone === 'good' ? 'success' : 'error'}> {part.text}</Text>,
      )

    if (g !== null && reading !== null) {
      const ticket = [...g.heads, ...tickets].find(one => one.number === reading.number)
      const status = ticket === undefined ? undefined : standing(ticket)
      const label = STATUSES.find(one => one.status === status)?.label ?? ''
      const blockers = ticket === undefined ? [] : openBlockers(ticket, tickets)
      // Its open PR into a branch that ships: the person's to merge, from here. Only one in the goal's repository: the ship path asks for its number there.
      const shippable = ownerWorkflow ? ticket && ownerPull(ticket, g.repo) : undefined
      const shipped = await read($, ship)
      // Its own, in its own repository: a note of another repository's PR of that number is not this one's.
      const mine = shipped !== null && shipped.pull === shippable?.number && sameRepo(shipped.repo, g.repo) ? shipped : null
      // One at a time: another PR's is at work.
      const other = shipped !== null && shipped.step === 'working' && mine === null ? `${shipped.repo}#${shipped.pull}` : undefined

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={3}>
            <Button
              key="back"
              plain
              hotkey="b"
              hover={feel('back').hover}
              label={feel('back', 'back').label}
              onPress={press('back', () => update($, doc, () => null))}
            />
            <Button
              key="web"
              plain
              hotkey="o"
              hover={feel('web').hover}
              label={feel('web', 'open in browser', { working: 'opening…' }).label}
              onPress={press('web', () => openWeb($, g.repo, reading.number), true)}
            />
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text bold wrap="wrap">
              #{reading.number} {ticket?.title ?? ''}
            </Text>
            {status !== undefined && (
              <Text bold color={COLOR[status]}>
                {label}
              </Text>
            )}
            {(ticket?.pulls ?? []).map(one => (
              <Text wrap="truncate-end">
                <Text dimColor>
                  PR #{one.number} {one.state === 'OPEN' ? (one.isDraft ? 'draft' : 'ready') : one.state.toLowerCase()} → {one.base}
                </Text>
                {one.state === 'OPEN' && toned(partsOf({ ...(ticket as Ticket), pulls: [one] }, 'doing', tickets).slice(1))}
                {roundTag(one.number)}
              </Text>
            ))}
            {blockers.map(number => {
              const blocker = tickets.find(one => one.number === number)

              // One of the goal's own opens in its place.
              return blocker === undefined ? (
                <Text dimColor>← #{number}</Text>
              ) : (
                <Button key={`b${number}`} plain hover={feel(`b${number}`).hover} onPress={press(`b${number}`, () => openDoc($, g.repo, number))}>
                  {feel(`b${number}`).mark}
                  <Text color={COLOR.blocked}>← </Text>
                  {oneLine(`#${number} ${blocker.title}`, Math.max(12, columns - 4))}
                </Button>
              )
            })}
            {shippable !== undefined && other !== undefined && <Text dimColor>A merge when green is at work on PR {other}.</Text>}
            {shippable !== undefined && other === undefined && (mine === null || mine.step === 'failed') && (
              <Box flexDirection="column">
                {mine !== null && (
                  <Text color="error" wrap="wrap">
                    {mine.note}
                  </Text>
                )}
                <Button
                  key="ship"
                  plain
                  hotkey="m"
                  hover={feel('ship').hover}
                  label={feel('ship', mine === null ? 'merge when green' : 'try again').label}
                  onPress={press('ship', () => prepareShip($, g.repo, { pull: shippable.number, head: shippable.head, base: shippable.base }))}
                />
              </Box>
            )}
            {shippable !== undefined && mine?.step === 'confirm' && (
              <Box flexDirection="column">
                <Text color="warning" wrap="wrap">
                  {shippable.isDraft ? `Mark PR ${mine.repo}#${shippable.number} ready, which starts its CI run, and merge` : `Merge PR ${mine.repo}#${shippable.number}`} at{' '}
                  {mine.head.slice(0, 7) || 'its head'} into {mine.base} once the checks pass?
                </Text>
                <Box flexDirection="row" columnGap={3}>
                  <Button key="ship-yes" plain hotkey="y" hover={feel('ship-yes').hover} label={feel('ship-yes', 'yes, go').label} onPress={press('ship-yes', () => startShip($, g.repo, mine))} />
                  <Button key="ship-no" plain hotkey="n" hover={feel('ship-no').hover} label={feel('ship-no', 'cancel').label} onPress={press('ship-no', () => cancelShip($, mine))} />
                </Box>
              </Box>
            )}
            {mine !== null && (mine.step === 'working' || mine.step === 'armed') && (
              <Button
                key="ship-working"
                plain
                dimColor
                hover={feel('ship-working').hover}
                label={feel('ship-working', 'merge when green is at work', { again: 'it is at work: nothing to press' }).label}
                onPress={() => void nudge($, 'ship-working')}
              />
            )}
            {mine !== null && (mine.step === 'working' || mine.step === 'armed') && (
              <Text color={mine.step === 'armed' ? 'success' : undefined} dimColor={mine.step === 'working'} wrap="wrap">
                {mine.note}
              </Text>
            )}
          </Box>
          <Box marginTop={1} flexDirection="column">
            {reading.error !== '' ? (
              <Text color="error" wrap="wrap">
                {reading.error}
              </Text>
            ) : reading.text === '' ? (
              <Text dimColor>Asking GitHub…</Text>
            ) : (
              <Markdown key="doc" text={reading.text} />
            )}
          </Box>
        </Box>
      )
    }

    const done = s.steps.filter(one => one.status === 'completed').length
    const doing = s.steps.find(one => one.status === 'in_progress')
    const running = s.agents.filter(one => one.endedAt === null)
    const ended = s.agents.filter(one => one.endedAt !== null).slice(-4)
    const made = s.marks.slice(-6).reverse()
    const cost = pointsOf(g ?? { repo: '', numbers: [] })
    const view = viewOf(g, s)
    const landed = view.completed
    const inSections = view.total

    const row = (ticket: Ticket, status: Status) => {
      // A sub-issue says the heading it is in, as the web view does (#198): its parts after its title.
      const parts = [...underOf(ticket, g?.heads ?? []), ...partsOf(ticket, status, tickets)]
      const workers = agentsOn(ticket, s.agents)
        .map(one => ` ◐ ${one.type} ${age(now - one.startedAt)}`)
        .join('')
      // The round tag takes its own width, and none where there is no round.
      const rounds = roundsOf(s.rounds, leadPull(ticket)?.number ?? 0)
      const taken = parts.reduce((sum, part) => sum + part.text.length + 1, workers.length + (rounds === 0 ? 0 : ` · round ${rounds}`.length))

      return (
        <Button key={`t${ticket.number}`} plain dimColor={status === 'done'} hover={feel(`t${ticket.number}`).hover} onPress={press(`t${ticket.number}`, () => openDoc($, g?.repo ?? '', ticket.number))}>
          {feel(`t${ticket.number}`).mark}
          {oneLine(`#${ticket.number} ${ticket.title}`, Math.max(12, columns - taken - 3))}
          {toned(parts)}
          {roundTag(leadPull(ticket)?.number)}
          {workers !== '' && <Text color={COLOR.doing}>{workers}</Text>}
        </Button>
      )
    }

    /** A heading, over the counted rows and not counted itself (as before #168): pressed, it opens with its own PR, where its sub-issues are gathered on one branch. */
    const headRow = (head: Ticket) => {
      const status = standing(head)
      const pull = leadPull(head)

      return (
        <Button key={`t${head.number}`} plain dimColor={status === 'done'} hover={feel(`t${head.number}`).hover} onPress={press(`t${head.number}`, () => openDoc($, g?.repo ?? '', head.number))}>
          {feel(`t${head.number}`).mark}
          {oneLine(`#${head.number} ${head.title}`, Math.max(12, columns - 30))}
          {toned([...underOf(head, g?.heads ?? []), ...partsOf(head, status, tickets)])}
          {roundTag(pull?.number)}
          {pull !== undefined && <Text dimColor> → {pull.base}</Text>}
          {status === 'yours' && (
            <Text bold color={COLOR.yours}>
              {' '}
              waiting for you
            </Text>
          )}
        </Button>
      )
    }

    const agentRow = (one: Agent) => {
      const isRunning = one.endedAt === null
      const detail = isRunning ? one.last : one.outcome

      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text color={isRunning ? 'warning' : 'success'}>{isRunning ? '◐ ' : '✓ '}</Text>
            <Text bold>{one.type}</Text> {one.what}
            <Text dimColor>
              {' '}
              · {age((one.endedAt ?? now) - one.startedAt)}
              {one.lane !== '' && ` · ${one.lane}`}
            </Text>
          </Text>
          {isRunning && one.isStale && (
            <Text color="warning" wrap="truncate-end">
              {'  '}No report for {age(now - one.activeAt)}
            </Text>
          )}
          {detail !== '' && (
            <Text dimColor wrap="truncate-end">
              {'  '}
              {detail}
            </Text>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {g === null ? (
          <Text dimColor wrap="wrap">
            No goal yet. Name exactly the issues this session works toward: /progress goal 507 or /progress goal
            12 13 14.
          </Text>
        ) : (
          <Box flexDirection="column">
            <Text wrap="wrap">
              <Text bold>{g.title}</Text>
              {inSections > 0 && (
                <Text>
                  {' '}
                  {landed}/{inSections} <Text color={COLOR.done}>{bar(landed, inSections, 12)}</Text>
                </Text>
              )}
            </Text>
            {g.heads.map(headRow)}
            <Box flexDirection="row" columnGap={3}>
              <Button
                key="refresh"
                plain
                hotkey="r"
                hover={feel('refresh').hover}
                label={feel('refresh', 'refresh', { working: 'refreshing…', again: 'still refreshing…' }).label}
                onPress={press(
                  'refresh',
                  async () => {
                    const how = await refresh($, true)

                    // Only a refresh that read GitHub ends on ✓; one that waits behind another in flight says so.
                    if (how === 'busy') {
                      return STILL
                    }

                    if (how !== 'done') {
                      throw new Error(`the refresh ${how}`)
                    }

                    return undefined
                  },
                  true,
                )}
              />
              <Text dimColor>
                {g.repo} · {g.fetchedAt === 0 ? 'asking GitHub…' : `${age(now - g.fetchedAt)} ago`}
              </Text>
            </Box>
            {cost > REFRESH_BUDGET && (
              <Text dimColor wrap="wrap">
                A refresh of this goal costs {cost} of GitHub's points, more than the {REFRESH_BUDGET} an hour it may spend: it refreshes only when you press refresh.
              </Text>
            )}
            {g.error !== '' && (
              <Text color="error" wrap="wrap">
                {g.error}
              </Text>
            )}
            {view.sections.map(({ id, label, fold, tickets: rows }) => {
              const isLanded = id === 'umbrella' || id === 'shipped'
              const shown = fold === 'all' ? rows : isLanded ? rows.slice(-FIRST_ROWS) : rows.slice(0, FIRST_ROWS)
              const hue = isLanded ? 'done' : id === 'deferred' ? 'ready' : id

              return (
                <Box key={`section-${id}`} flexDirection="column" marginTop={1}>
                  <Button key={`s-${id}`} plain hover={feel(`s-${id}`).hover} onPress={press(`s-${id}`, () => foldSection($, id, 'toggle'))}>
                    {feel(`s-${id}`).mark}
                    <Text bold color={COLOR[hue as Status]} dimColor={rows.length === 0 || id === 'deferred'}>
                      {fold === 'closed' ? '▸ ' : '▾ '}
                      {label}
                    </Text>
                    <Text dimColor> {rows.length}</Text>
                  </Button>
                  {fold !== 'closed' && shown.map(one => row(one, statusOf(one, tickets, s.agents)))}
                  {fold !== 'closed' && shown.length < rows.length && (
                    <Button key={`more-${id}`} plain dimColor hover={feel(`more-${id}`).hover} onPress={press(`more-${id}`, () => foldSection($, id, 'all'))}>
                      {feel(`more-${id}`).mark || '  '}and {rows.length - shown.length} more
                    </Button>
                  )}
                </Box>
              )
            })}
          </Box>
        )}

        {!isBlank(s) && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold dimColor>
              This session
            </Text>
            {s.isWorking ? (
              <Text wrap="truncate-end">
                <Text color="warning">◐ </Text>
                {s.now || s.goal || 'Working (reported)'}
                <Text dimColor>
                  {' '}
                  · {age(now - s.nowAt)} · reported work {age(now - s.turnStartedAt)}
                </Text>
              </Text>
            ) : (
              <Text dimColor>● {s.goal || 'No work reported'}{s.turnMs > 0 ? ` · last reported work ${age(s.turnMs)}` : ''}</Text>
            )}
            {s.steps.length > 0 && (
              <Text wrap="truncate-end">
                <Text dimColor>plan </Text>
                {done}/{s.steps.length} <Text color={COLOR.done}>{bar(done, s.steps.length, 8)}</Text>
                {doing !== undefined && <Text> {doing.doing || doing.text}</Text>}
              </Text>
            )}
            {[...running, ...ended].map(agentRow)}
            {made.map(mark => (
              <Text wrap="truncate-end">
                <Text dimColor>{age(now - mark.at).padStart(4)} </Text>
                <Text color={mark.isBad ? 'error' : undefined}>
                  {mark.kind === 'check' ? (mark.isBad ? '✗ ' : '✓ ') : ''}
                  {mark.text}
                </Text>
                {mark.lane !== '' && <Text dimColor> {mark.lane}</Text>}
              </Text>
            ))}
          </Box>
        )}

        {dashboard !== undefined && (
          <Box marginTop={1}>
            <Text dimColor wrap="truncate-end">
              {printable(dashboard.line, 200)}
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}
