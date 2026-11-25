import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptSubmitResult, Register, RenderElement, RenderSurface, StateValue, Timer, ToolSpec } from 'claude-code'

import type { Editing, Task, Took } from '../types'
import { audit } from './audit'
import { infoOf, isAt, isListenable, isShelfAction, isShelvable, patchOf, refusalOf, shelfRefusalOf, startEndpoint } from './endpoint'
import type { Answered, Endpoint, Request, Versioned } from './endpoint'
import {
  MAX_DETAIL,
  MAX_OPEN,
  MAX_OPTION,
  MAX_OPTIONS,
  MAX_TITLE,
  answerIn,
  assignedOf,
  bridgeOf,
  contextOf,
  digestOf,
  archivedDayOf,
  deletionDayOf,
  isActive,
  isArchived,
  isExpired,
  isKept,
  isShown,
  listOf,
  looksSecret,
  messageOf,
  newsHeadOf,
  ownHeadOf,
  parseAsk,
  sameAsk,
  statusOf,
  withoutExpired,
} from './tasks'
import {
  ANSWER_LABEL,
  ANSWER_ROWS,
  BUTTON_GAP,
  HELD,
  HIDE,
  MAX_SHOWN_TITLE,
  REASON_LABEL,
  RESTORE,
  REASON_PLACEHOLDER,
  actionsOf as actionsFor,
  ageOf,
  archivedHeadOf,
  archivedRowOf,
  detailLinesOf,
  answerButtonsOf,
  answerPlaceholderOf,
  doneWhenOf,
  fieldKeyOf,
  headlineOf,
  hintOf,
  isFullOf,
  nameOf,
  placeholderOf,
  rowsFor,
  savedOf,
  selectedOf,
  sendNowOf,
  submitLabelOf,
  titleOf,
  whyOf,
} from './pane'
import type { PaneView } from './pane'
import { NO_CONFIG, SETTING_OFF, controlDashboard, hasDashboardConfig, isDashboardInstalled, dashboardLineOf, readDashboard } from './dashboard'
import type { Control, Dashboard, Replies } from './dashboard'
import {
  HEARTBEAT_MS,
  adopt,
  editedLegacy,
  elsewhereIn,
  floorOf,
  hasLegacyPeer,
  isEmptyEdit,
  isSameTask,
  isSlot,
  isTakenFrom,
  keysOf,
  legacyOf,
  projectOf,
  prune,
  withSlots,
} from './project'
import type { Adoption, LegacyEdit, Project, Slot } from './project'
import { numbersOf, oneLine, printable } from './text'

const PLUGIN = 'human-in-the-loop'

const ASSIGN = 'mcp__human-in-the-loop__assign_task'
const LIST = 'mcp__human-in-the-loop__list_tasks'
const WITHDRAW = 'mcp__human-in-the-loop__withdraw_task'
const OPEN = 'mcp__human-in-the-loop__open_tasks'
const DASHBOARD = 'mcp__human-in-the-loop__dashboard'

/**
 * Three lines at the end of the system prompt: where an ask for the user goes
 * so it stays in front of them, that a review is one even when the reply asks
 * for it too (the user is often busy and lets the reply's question go by),
 * and where they see it. Said as what to do,
 * never what not to: nothing here stops Claude reminding the user of a task.
 */
const STEERING = [
  "When you need something only the user can do (a secret put in place, an action on their machine or an account you can't reach, a decision that's theirs), assign it with mcp__human-in-the-loop__assign_task so it stays in front of them until they act on it.",
  'That includes asking the user to review or approve your work: assign it as a task even when you also ask in your reply, since they may be busy with other things when you ask, and the task keeps it in front of them.',
  'The user sees open tasks in their My tasks pane, or opens it with /my-tasks, and their response reaches you as a message.',
].join('\n')

/** Resolutions pressed this close together go to Claude as one message. */
const BATCH_MS = 800

/** The longest a person, or Claude, waits on the store: what it doesn't answer by then finishes on its own. */
const STORE_WAIT_MS = 5000

/** What a tool answers while the session moves to another folder, before it has read that folder's tasks. */
const MOVING = 'This session is still joining its project: the task store is slow to answer. Try again in a moment.'

/** The pane the tasks wait in, and the command that opens it. */
const PANE = 'my-tasks'
const PANE_TITLE = 'My tasks'
const MAX_PANE_ROWS = 18

/** How a surface draws the pane: its body's width, whether it draws a field and holds the keys, and whether it seats the pane inline. */
type Seat = Pick<PaneView, 'canType' | 'isFocused'> & { columns: number; isInline: boolean }

/** What goes under the selected task: an open field, across the pane's body, and the buttons, in the task's indent. */
type Controls = readonly [field: RenderElement | null, buttons: RenderElement | null]

/** An 80-column terminal's main screen: the pane's seat until a surface draws it. */
const FIRST_SEAT: Seat = { columns: 76, canType: true, isFocused: false, isInline: true }

/** `seats` with `seat` among them: of seats alike but for their width, the narrowest stays, as it takes the most rows. */
function seatsWith(seats: readonly Seat[], seat: Seat): readonly Seat[] {
  const alike = seats.find(other => isAlike(other, seat))

  return alike !== undefined && alike.columns <= seat.columns ? seats : [...seats.filter(other => other !== alike), seat]
}

function isAlike(one: Seat, other: Seat): boolean {
  return one.canType === other.canType && one.isFocused === other.isFocused && one.isInline === other.isInline
}

const TOOLS: readonly ToolSpec[] = [
  {
    name: 'dashboard',
    description:
      "The web dashboard's controls, for the user's /overview web, start and stop commands: status says whether it runs and where to open it, start and stop run it. No model is offered it (a tool.offer hook): only those commands run it. It does nothing when the user never set the dashboard up.",
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['status', 'start', 'stop'], description: 'status: whether it runs and its address. start or stop: run it, or stop it.' } },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_tasks',
    description: 'Explicitly open My tasks, including its empty state, without assigning a task or enrolling any issue. Used by Overview and by agents when asked to show tasks.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'assign_task',
    description: [
      'Give the user a task that only they can do, and keep it in front of them until they act on it.',
      'Use it for a secret or credential they must put in place, an action on their machine or on an account you cannot reach (a dashboard, a device, a deploy approval), a decision that is theirs to make, or a review or approval of your work.',
      'Assign it even when you also ask in your reply: the user may be busy with other things, and the task keeps the ask in front of them.',
      'A task does not block: you keep working while it waits, and the response reaches you whenever the user gets to it, so it suits anything you need from them at some point in the session.',
      'AskUserQuestion is the blocking kind: it waits for the answer, so it suits what you need before you can go on.',
      'One task per need: list_tasks shows what is already open.',
      'Put each thing where it goes: the title is the ask, an imperative the user can act on without scrolling back (under 80 characters); why is one sentence (under 300); detail is the full picture, up to 4000 characters, that the user opens with Full picture (the card shows only the title and why).',
      'Text over a limit is refused with its length, never cut, so shorten it or move it to detail.',
      'For a secret, ask the user to put it where it belongs and mark the task done, rather than paste it.',
      'The user sees open tasks in their My tasks pane, or opens it with /my-tasks.',
      'The user rejects (with a reason) or fulfills it (done, an option, or an answer in their words). Their response reaches you as a message, or when you call list_tasks.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'What the user should do, as an imperative they can act on without scrolling back. Under 80 characters.',
        },
        why: {
          type: 'string',
          description: 'One sentence (at most 300 characters): what it unblocks, or why only the user can do it. Longer is refused; put the rest in detail.',
        },
        done_when: {
          type: 'string',
          description: "Optional (at most 300 characters): what counts as done. For a secret: \"It is in .env. Don't paste it here.\"",
        },
        detail: {
          type: 'string',
          description: `Optional: the full picture, up to ${MAX_DETAIL} characters, line breaks kept. The card shows only title and why; the user opens this with Full picture. Longer is refused, never cut.`,
        },
        kind: {
          type: 'string',
          enum: ['do', 'answer', 'choose'],
          description: 'do: the user does something and marks it done. answer: you need their words (an error, a log, test results). choose: they pick one of options.',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: MAX_OPTIONS,
          description: `For choose only: 2 to ${MAX_OPTIONS} options, each at most ${MAX_OPTION} characters.`,
        },
      },
      required: ['title', 'why', 'kind'],
    },
  },
  {
    name: 'list_tasks',
    description: [
      'List the tasks you gave the user and what they did with them: accepted, done (with their answer or choice), rejected (with their reason).',
      'Call it when you are about to need a task\'s result, when told an answer is saved for you, or before assigning, to avoid a duplicate.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        show: {
          type: 'string',
          enum: ['updates', 'open', 'all'],
          description: 'updates (the default): open tasks and responses you have not seen. open: open tasks only. all: every task this session.',
        },
        id: { type: 'number', description: 'One task, whole, by its number.' },
      },
    },
  },
  {
    name: 'withdraw_task',
    description: 'Take back a task you gave the user when you no longer need it: you found another way, or the plan changed. The user sees the reason.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The task\'s number.' },
        reason: { type: 'string', description: 'One short sentence the user sees.' },
      },
      required: ['id'],
    },
  },
]

const tasks = atom({ plugin: 'human-in-the-loop', key: 'tasks' } as const, [] as readonly Task[])
const nextId = atom({ plugin: 'human-in-the-loop', key: 'nextId' } as const, 1)
const took = atom({ plugin: 'human-in-the-loop', key: 'took' } as const, {} as Readonly<Record<string, Took>>)
const selectedId = atom({ plugin: 'human-in-the-loop', key: 'selectedId' } as const, null as number | null)
const fullId = atom({ plugin: 'human-in-the-loop', key: 'fullId' } as const, null as number | null)
const editing = atom({ plugin: 'human-in-the-loop', key: 'editing' } as const, null as Editing | null)
const loadedFor = atom({ plugin: 'human-in-the-loop', key: 'loadedFor' } as const, null as string | null)
/** The dashboard line as the status line shows it, stamped, for the progress pane; written by this plugin alone (any plugin may read it). */
const dashboardShown = atom({ plugin: 'human-in-the-loop', key: 'dashboard' } as const, null as StateValue<'human-in-the-loop', 'dashboard'>)
const isWorking = atom({ plugin: 'human-in-the-loop', key: 'isWorking' } as const, false)
/** The remote clients attached, by surface, as the state's contract declares them. */
type Roster = StateValue<'human-in-the-loop', 'clients'>
/** The roster, kept where a reload of the code finds it. */
const clients = atom({ plugin: 'human-in-the-loop', key: 'clients' } as const, {} as Roster)

/**
 * Send now goes to Claude as a message (`auto` while it is idle), Save for
 * later waits (`auto` while it works) until its turn ends with every task
 * answered, a later answer while it is idle, or the user's next prompt.
 */
type How = 'auto' | 'now' | 'later'

/**
 * What a toast says when a prompt carrying updates is dropped: why (`why`,
 * the mod's own prompt, which the user didn't type), only that they're kept
 * (`kept`, an answer the user typed, whose drop the engine shows), or nothing
 * (`nothing`, the user's own prompt, which they rode: they wait as before).
 */
type DropNote = 'why' | 'kept' | 'nothing'

/** A prompt as it entered: its words, and the blocks that go beside them. */
type Entered = { text: string; context?: readonly string[] }

/**
 * What a sync changed of what the session shows: nothing (`same`), the tasks
 * another session took on (`lost`), or everything, taking the project on
 * (`joined`).
 */
type Synced = 'same' | 'lost' | 'joined'

/** What the module tracks beside `$.state`; a hot reload starts it over. */
const live = {
  /** Explicitly opened Overview tasks remain available even when empty. */
  keepsEmpty: false,
  /** Whether the pane's Archived section is open: it starts collapsed. */
  isArchiveOpen: false,
  sessionId: '',
  root: '',
  /** The folder the latest join is for, set as it is asked: `root` follows in queue order. */
  joinRoot: '',
  /** A Send now row joined the running turn and no step has read it yet. */
  isUnread: false,
  /** A Send now the running turn could not take: it goes once the turn ends. */
  isSendingAtEnd: false,
  /** What the user has typed in each field so far, by `fieldKeyOf`. */
  drafts: new Map<string, string>(),
  /**
   * What was typed in each answer field as its task closed, by `fieldKeyOf`:
   * a button pressed on a drawing from before the task closed answers with it.
   */
  closed: new Map<string, string>(),
  /**
   * What each surface draws each field with, by `fieldKeyOf`: the draft as
   * the surface first drew it. It stays put while the field is typed in, as a
   * value drawn anew puts the field's text back to it, keys typed meanwhile
   * lost. A surface that forgets what its fields hold (the pane closed, or a
   * client of it came) draws them with the draft again.
   */
  drawn: new Map<RenderSurface, Map<string, string>>(),
  batch: null as Timer | null,
  /** Says in the project's store that this session is alive. */
  heartbeat: null as Timer | null,
  /** Tasks waiting in the project's other live sessions. */
  elsewhere: 0,
  /** The project's next task number at its last reading. */
  floor: 1,
  /** A 0.1.4 session was alive in the project at its last reading. */
  hasLegacyPeer: false,
  /** The session has a slot in the project's store: it writes it, its count in it, until it ends. */
  hasSlot: false,
  /** When the session's slot was last written. */
  writtenMs: 0,
  /** When the session last read the project. */
  readMs: 0,
  /** Set once the session ended: its slot says so from then on. */
  endedMs: undefined as number | undefined,
  /** How many sessions of the process have ended: one that ends before its join comes up in the queue stays ended. */
  ends: 0,
  /** Responses a prompt entered without, by `updateKeyOf`: they go with Send now, the next prompt or another response, never alone as a turn ends. */
  held: new Set<string>(),
  /** Joins into another folder not done yet: until then the tasks the process holds are the folder's it leaves. */
  moving: 0,
  /** The store work asked for and not yet done: each piece waits for the one before. */
  queue: Promise.resolve() as Promise<unknown>,
  /** Store work a wait gave up on, not settled yet: while there is any, nothing waits on the store. */
  stalled: 0,
  /** The roster's writes asked for and not yet done: each waits for the one before (see `rostered`). */
  rosterQueue: Promise.resolve() as Promise<unknown>,
  /** A turn of the main loop has begun and not ended: Claude is at work. */
  isWorking: false,
  /**
   * How each surface drawing the pane draws it, by `e.surface`: as it last
   * did, or, drawn by two clients or more, every way since one came or went
   * (by `seatsWith`), since a render names no client.
   */
  seats: new Map<RenderSurface, readonly Seat[]>(),
  /** Surfaces a client left while others stay: the next drawing there starts their seats over. */
  startingOver: new Set<RenderSurface>(),
  /** How many times each surface's last client has left: a drawing under way as one did keeps no seat there. */
  emptied: new Map<RenderSurface, number>(),
  /** The key of the element the pane's focus ring last moved onto. */
  ring: undefined as string | undefined,
  /** The rows the pane last asked for. */
  rows: 0,
  /** How many times the mod closed the pane: a re-size under way leaves it closed (see `fit`). */
  closes: 0,
  /** The re-sizes keys and ring moves asked for and not yet done: each waits for the one before (see `refit`). */
  refitQueue: Promise.resolve() as Promise<unknown>,
  /** The answer endpoint's listener for this session, while the setting has one (see `keepEndpoint`). */
  endpoint: null as Endpoint | null,
  /** Listener starts in a row that ended before they were ready, and the heartbeats to let pass before the next (see `keepEndpoint`). */
  endpointFailures: 0,
  endpointSkips: 0,
  /** Why the last listener that ended before it was ready did so, until one is ready. */
  endpointFailure: undefined as string | undefined,
  /** The dashboard as it was last read (see `freshDashboard`); undefined before, or without its config. */
  dashboard: undefined as Dashboard | undefined,
  /** Runs while the last reading is fresh: a pane drawn meanwhile reads nothing. */
  dashboardFresh: null as Timer | null,
  /** The reading under way, if any: one at a time. */
  dashboardReading: null as Promise<void> | null,
  /** A start or a stop under way, if any. */
  dashboardBusy: null as 'start' | 'stop' | null,
  /**
   * The order of what was learnt of the dashboard: a read takes its number
   * as it starts, a start or a stop as it ends (its reading is taken then).
   * Only a reading numbered above the one kept replaces it.
   */
  dashboardSeq: 0,
  dashboardKeptSeq: 0,
  /** When the kept reading was taken (`$.clock.now()` ms): the published line's `at`. */
  dashboardAt: undefined as number | undefined,
  /** The number the latest publication of `dashboardShown` took: an earlier one's write gives way to it. */
  dashboardPublishedSeq: 0,
  /** The dashboard line the pane was last drawn with, and the status line last pinned. */
  dashboardDrawn: undefined as string | undefined,
  pinned: undefined as string | undefined,
  /** The status line's words for the tasks (`statusOf`), which the dashboard line follows. */
  taskStatus: undefined as string | undefined,
}

/** How long a reading of the dashboard stands before a pane drawn again reads it anew. */
const DASHBOARD_FRESH_MS = 10_000
/** How many times a publication reads the clock anew when the stored line changed under it. */
const DASHBOARD_PUBLISH_TRIES = 3
/** How far ahead of this clock another copy's stamp may be and still count as later: the progress pane's own allowance. */
const DASHBOARD_SKEW_MS = 5_000

/** The `answer_endpoint` setting: off unless the person turns it on. */
let isEndpointOn = false

/** Whether Claude is at work: the main loop's turns alone, not a subagent's or a teammate's. */
function working(): boolean {
  return live.isWorking
}

export const register: Register = (on, options) => {
  isEndpointOn = options['answer_endpoint'] === true

  on('session.start', async ($, e, next) => {
    for (const tool of TOOLS) {
      await $.tool.register(tool)
    }

    await $.command.register({ name: 'my-tasks', description: 'Show the tasks Claude gave you' })
    await join($)

    // With the config and the unit in place, the status line is current before the pane is ever opened.
    if (await isDashboardInstalled($)) {
      freshDashboard($)
    }

    return next(e)
  })

  // An ended session's tasks wait in the store for the next session in the
  // project. After /clear or a resume the process goes on as another session
  // with no session.start, so it joins the project again here.
  on('session.end', async ($, e, next) => {
    live.heartbeat?.cancel()
    live.heartbeat = null
    live.endedMs = await $.clock.now()
    live.ends += 1
    const ends = live.ends
    // The listener goes first: an answer that comes in from here on is told the session is gone.
    const endpoint = live.endpoint
    live.endpoint = null
    const stopped = endpoint?.stop()

    // The slot marked ended, in one write and no read, once the store work in
    // flight is done; a session that never read the project reads it first.
    // The exit's budget is short, and the end waits for the write only
    // through half of what is left: a slot not written by then goes stale,
    // and the next session takes it on then. A process that goes on makes
    // the write all the same, before it joins again.
    const written = Promise.all([queued(async () => ((await isLoaded($)) ? writeOwn($) : load($))).catch(() => undefined), stopped])
    const leftMs = next.budget.remainingMs

    await (Number.isFinite(leftMs) ? Promise.race([written, $.clock.sleep(leftMs / 2)]) : written)

    const ended = await next(e)

    if (e.reason === 'clear' || e.reason === 'resume') {
      // With the count as this session ended: the next one, ending before
      // the join runs, stays ended. The host may have cleared the state: the
      // dashboard line kept is published again, and read anew when installed.
      $.clock.after(0, () => {
        void join($, ends)
        syncDashboard($)
        void dashboardBeat($)
      })
    }

    return ended
  })

  on('tool.call', { tool: OPEN }, async $ => {
    await wake($)

    if (!(await hasSurface($))) {
      return { result: await tasksAsText($) }
    }

    const placed = await show($, true)
    return { result: placed ? 'My tasks opened.' : 'My tasks requested. No native pane is currently available; use the local web Overview.' }
  })

  on('command.run', { command: 'my-tasks' }, async ($, e) => {
    await wake($)
    const [verb = '', which = ''] = (e.args ?? '').trim().toLowerCase().split(/\s+/)

    // `/my-tasks archive 5` and `/my-tasks restore 5`: the pane's Archive and
    // Restore, for a surface with no pane (or a person who'd rather type).
    if (verb === 'archive' || verb === 'restore') {
      return { text: await shelveByCommand($, verb === 'archive', which) }
    }

    if (verb !== '') {
      return { text: MY_TASKS_USAGE }
    }

    if (!(await hasSurface($))) {
      return { text: await tasksAsText($) }
    }

    await show($, true)

    if ((await read($, tasks)).filter(isShown).length === 0) {
      const archived = (await archivedNow($)).length

      return { text: archived === 0 ? 'No tasks for you right now.' : `No tasks for you right now; ${archived} archived (Archived in My tasks).` }
    }

    return {}
  })

  // The dashboard tool starts a server on the tailnet: no model is shown it, the
  // main agent's or a subagent's, and a call one makes is refused, so neither
  // Claude nor a prompt injection can run it. The Progress mod's `$.tool.call`
  // (its /overview) is not asked here and still runs it. A hook that
  // fails passes the tool through, so its catch keeps it hidden.
  on('tool.offer', { tool: DASHBOARD }, () => ({ isOffered: false })).catch(() => ({ isOffered: false }))

  // The dashboard's controls, for the Progress mod's /overview web, start and stop. Without
  // the config (dashboard/README.md) the person never set it up: it says so and runs nothing.
  // Only Progress's own `$.tool.call` runs it: `tool.offer` may not be asked about a
  // Code Mode script's call, and the host sets `next.origin` from where a call came
  // (`engine` for the model's and a script's), as the plugin's manifest name, whatever
  // marketplace installed it.
  on('tool.call', { tool: DASHBOARD }, async ($, e, next) => {
    if (next.origin?.plugin !== 'progress') {
      return { deny: "Only the Progress mod's /overview controls the dashboard." }
    }

    const action = (e as unknown as Record<string, unknown>)['action']

    if (action !== 'status' && action !== 'start' && action !== 'stop') {
      return { deny: 'The dashboard action is status, start or stop.' }
    }

    if (e.agentId !== undefined) {
      return { deny: 'Only the main agent controls the dashboard.' }
    }

    if (!(await hasDashboardConfig($))) {
      return { result: [textBlock('The dashboard is not set up: its config file is missing (dashboard/README.md, Install, step 1). Nothing was run.')] }
    }

    if (action === 'status') {
      return dashboardResult(await askDashboard($))
    }

    const done = await pressDashboard($, action)

    return done === undefined ? { result: [textBlock(DASHBOARD_BUSY)] } : dashboardResult(done.dashboard, `${done.message}\n`)
  })

  // The desktop app's menu on a transcript row: the dashboard's address to
  // copy (a row can open only an https: link, and the page is plain HTTP),
  // and Start while it is off. Nothing without its config.
  on('ui.render', { component: 'ContextMenu' }, ($, e, next) => {
    freshDashboard($)
    const dashboard = live.dashboard

    if (dashboard === undefined || dashboard.why === NO_CONFIG || (dashboard.address === null && dashboard.dashboard === 'on')) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const address = dashboard.address

    return (
      <Box flexDirection="column">
        {address === null ? null : (
          <Button key="dashboard-copy" onPress={press => $.ui.copy({ text: address, surface: press.surface }).then(() => undefined)}>
            Copy dashboard address <Text dimColor>{address}</Text>
          </Button>
        )}
        {dashboard.dashboard === 'on' ? null : (
          <Button key="dashboard-start" onPress={() => pressDashboardToast($, 'start')}>
            Start dashboard <Text dimColor>{dashboardLine() ?? ''}</Text>
          </Button>
        )}
      </Box>
    )
  })

  // The tools stay in the prompt's list, descriptions and all, where an MCP
  // tool would wait behind ToolSearch: the description is what steers Claude
  // to assign a task, so the ask stays in front of the user.
  on('tool.describe', { tool: ASSIGN }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: LIST }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: WITHDRAW }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  on('tool.call', { tool: ASSIGN }, async ($, e) => {
    if (e.agentId !== undefined) {
      await audit($, 'refuse', 'a subagent called assign_task; only the main agent assigns tasks.', { field: 'caller' })

      return { deny: 'Only the main agent assigns tasks to the user. Say what you need from the user in your result instead.' }
    }

    const ask = parseAsk(e as unknown as Record<string, unknown>)

    if ('error' in ask) {
      const { reason, field, length, limit } = ask

      await audit($, 'refuse', reason, { field, ...(length === undefined ? {} : { length, limit }) })

      return { deny: ask.error }
    }

    // Resumed into another folder, the session takes it on once the store
    // work in flight is done and it has read it. A task assigned before then
    // is the old folder's: the join drops it here, and the old session's end
    // write may leave it there.
    if (live.moving > 0) {
      await audit($, 'refuse', 'the session is still joining its project.', { field: 'moving' })

      return { deny: MOVING }
    }

    // Task numbers count per project, across its sessions: the next is past
    // every number a session there drew, which each slot carries, so this
    // reads the project first (and lets go of tasks taken on while the
    // session slept). Two sessions assigning at the same moment can still
    // draw one number; each shows and answers only its own, and where their
    // tasks meet (one taking on the other's), `adopt` gives the later a new one.
    await beat($, false)

    const held = await read($, tasks)
    const active = held.filter(isActive)
    const same = active.find(task => sameAsk(task.title, ask.title))

    if (same !== undefined) {
      return { result: `Task #${same.id} already asks the user for this ("${same.title}"); nothing new was assigned.` }
    }

    // The owner set it aside unanswered: Claude doesn't ask it again (#187). Restoring it is theirs.
    const nowMs = await $.clock.now()
    const shelved = archivedIn(held, nowMs).find(task => sameAsk(task.title, ask.title))

    if (shelved !== undefined) {
      await audit($, 'refuse', `task #${shelved.id} with this title was archived by the owner.`, { field: 'archived', id: shelved.id })

      return { deny: `#${shelved.id} was archived by the owner on ${archivedDayOf(shelved)}; not re-assigned.` }
    }

    if (active.length >= MAX_OPEN) {
      await audit($, 'refuse', `${active.length} tasks are open; the limit is ${MAX_OPEN}.`, { field: 'open', length: active.length, limit: MAX_OPEN })

      return {
        deny: `The user already has ${MAX_OPEN} open tasks. Withdraw one you no longer need, or wait for them to act (list_tasks shows them).`,
      }
    }

    const id = (await update($, nextId, n => Math.max(n, live.floor) + 1)) - 1
    const task: Task = {
      id,
      ...ask,
      state: 'open',
      update: 'none',
      // The conversation's own: until it joins the project (a store slow
      // after /clear), the process still acts for the one it left.
      sessionId: await $.session.id(),
      createdMs: nowMs,
      updatedMs: nowMs,
    }

    await change($, list => [...list, task])
    await audit($, 'accept', `task #${id} assigned`, {
      id,
      kind: task.kind,
      why: task.why.length,
      done_when: task.doneWhen?.length ?? 0,
      detail: task.detail?.length ?? 0,
      options: task.options?.length ?? 0,
    })

    if (live.hasLegacyPeer) {
      await awaited($, queued(() => editLegacy($, { removed: [], taken: {} })))
    }

    await update($, selectedId, chosen => chosen ?? id)

    if (!(await show($, false))) {
      $.ui.toast(`Claude assigned you a task: ${printable(task.title, MAX_TITLE)}. See /my-tasks`)
    }

    return { result: assignedOf(task, active.length + 1) }
  })

  on('tool.call', { tool: LIST }, async ($, e) => {
    if (live.moving > 0) {
      return { deny: MOVING }
    }

    await wake($)
    const args = e as unknown as Record<string, unknown>
    const id = typeof args['id'] === 'number' ? args['id'] : undefined
    const scope = args['show'] === 'open' || args['show'] === 'all' ? args['show'] : 'updates'
    const nowMs = await $.clock.now()
    // Archived over 7 days ago: deleted at the next write, and listed nowhere meanwhile.
    const list = withoutExpired(await read($, tasks), nowMs)

    const picked =
      id !== undefined
        ? list.filter(task => task.id === id)
        : scope === 'all'
          ? list
          : scope === 'open'
            ? list.filter(isActive)
            : list.filter(task => isKept(task, nowMs))

    if (id !== undefined && picked.length === 0) {
      return { result: `No task #${id}.` }
    }

    // A subagent's read tells the main agent nothing. Claude hears the
    // responses this shows: one that came in after it read goes later.
    if (e.agentId === undefined) {
      await claim($, task => picked.some(one => one.id === task.id && one.update === 'pending'))
    }

    return { result: listOf(picked, await $.clock.now()) }
  })

  on('tool.call', { tool: WITHDRAW }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: 'Only the main agent withdraws tasks.' }
    }

    if (live.moving > 0) {
      return { deny: MOVING }
    }

    await wake($)
    const args = e as unknown as Record<string, unknown>
    const id = args['id']
    const reason = typeof args['reason'] === 'string' ? oneLine(args['reason']) : ''
    const task = (await read($, tasks)).find(one => one.id === id)
    // Withdrawn only while it is open: an answer the user gave a moment before stands.
    const found =
      task === undefined || !isActive(task)
        ? task
        : await edit($, task.id, one => ({
            ...one,
            state: 'withdrawn',
            update: 'delivered',
            ...(reason === '' ? {} : { reason }),
          }))

    if (found === undefined) {
      return { deny: `No task #${String(id)}.` }
    }

    if (isArchived(found)) {
      return { deny: `Task #${found.id} was archived by the owner, unanswered; there is nothing to withdraw. It is deleted on ${deletionDayOf(found)} unless they restore it.` }
    }

    if (!isActive(found)) {
      return { deny: `Task #${found.id} is already ${found.state}; there is nothing to withdraw.` }
    }

    // Its fields go with it, and what was typed in them: put in the prompt
    // box unasked, it would join whatever the user is writing there.
    await settle($, found.id)
    const why = reason === '' ? '' : `. ${printable(reason, 200)}`
    $.ui.toast(`Claude withdrew the task: ${printable(found.title, MAX_TITLE)}${why}`, { timeoutMs: 8000 })

    return { result: `Withdrew task #${found.id}; it is gone from the user's My tasks pane.` }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }

    live.isUnread = false
    live.isWorking = true
    await syncWorking($)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      live.isUnread = false
    }

    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId === undefined) {
      live.isWorking = false
      await syncWorking($)

      // Answers saved while Claude worked go now that it's free, unless a
      // task is still open: then they go with that last answer, together.
      // One a prompt entered without goes with them, but sends nothing alone.
      const all = await read($, tasks)
      const isAllAnswered = all.some(task => task.update === 'pending' && !live.held.has(updateKeyOf(task))) && !all.some(isActive)

      if (live.isSendingAtEnd || isAllAnswered) {
        live.isSendingAtEnd = false
        // This message wakes Claude, which reads any row it missed above it.
        live.isUnread = false
        void send($, true)
      } else if (live.isUnread) {
        // A Send now that joined the turn during its final reply sits in the
        // conversation with no step left to read it: wake Claude up for it.
        live.isUnread = false
        void $.prompt.submit({ text: 'I answered a task while you were finishing your reply; my answer is above.', asUser: true })
      }
    }

    return result
  })

  on('prompt.submit', async ($, e, next) => {
    if ((e.origin.kind === 'plugin' && e.origin.name === PLUGIN) || live.moving > 0) {
      return next(e)
    }

    await wake($)
    const bridged = answerIn(e.text)
    const task = bridged === null ? undefined : (await read($, tasks)).find(one => one.id === bridged.id && isActive(one))
    let isAnswered = false

    if (bridged !== null && task !== undefined) {
      if (looksSecret(bridged.answer)) {
        return {
          drop: `This looks like a secret, so it wasn't sent. Put it where it belongs, then mark #${task.id} Done.`,
        }
      }

      const given = bridged.answer === '' ? {} : { answer: bridged.answer }

      if (e.turnId === undefined) {
        // Claude is idle: this prompt is the answer, sent with every other
        // update Claude has not heard, those a batch was about to send among them.
        live.batch?.cancel()
        live.batch = null
      }

      // A task closed meanwhile (Claude withdrew it, say) keeps no answer:
      // the prompt goes as typed.
      const was = await resolve($, task.id, { state: 'done', ...given }, 'later')
      isAnswered = was !== undefined && isActive(was)

      if (isAnswered && e.turnId !== undefined) {
        const when = (await read($, tasks)).some(isActive) ? 'with your other answers' : 'when this turn ends'

        return {
          drop: `Saved as your answer to #${task.id}. Claude gets it ${when}, or press Send now in /my-tasks.`,
        }
      }
    }

    const due = await claim($)
    // A task still here has its answer in this prompt, or in another send
    // that took it as it was saved. One gone meanwhile (another session took
    // it on) leaves the prompt as typed.
    const isAnswer = isAnswered && task !== undefined && (await read($, tasks)).some(one => one.id === task.id)

    if (isAnswer && due.length === 0) {
      return { drop: `Your answer to #${task.id} already went to Claude.` }
    }

    if (due.length === 0) {
      return next(e)
    }

    if (isAnswer) {
      return passOn($, due, inWords, 'kept', () => next({ ...e, text: messageOf(due) }))
    }

    return passOn($, due, inDigest, 'nothing', () => next({ ...e, context: [...(e.context ?? []), digestOf(due)] }))
  })

  // Read at a conversation's start and again after a compaction: what is
  // still with the user, so Claude neither forgets nor assigns it twice.
  // Added last, on the session's side of the cache boundary, wherever the
  // tool can be reached: offered outright, or found through ToolSearch.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const isReachable = e.tools.some(tool => tool === ASSIGN || tool === 'ToolSearch')

    if (!isReachable || e.traits.includes('print') || e.traits.includes('bare')) {
      return composed
    }

    return { sections: [...composed.sections, { id: 'human-in-the-loop:tasks', text: STEERING, scope: 'session' }] }
  })

  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    const shown = (await read($, tasks)).filter(isShown)

    if (shown.length === 0 || live.moving > 0) {
      return result
    }

    return { ...result, blocks: [...result.blocks, { name: 'humanInTheLoop', text: contextOf(shown, await $.session.id()) }] }
  })

  on('ui.render', { component: 'ToolUse', props: { tool: ASSIGN } }, ($, e, next) => {
    const input = e.props.input as Record<string, unknown> | null | undefined
    const title = typeof input?.['title'] === 'string' ? input['title'] : ''

    if (title === '' || e.props.isErrored || e.props.isInterrupted) {
      return next(e)
    }

    const { Text } = $.ui.resolve(e)

    return (
      // One text, so the label keeps its words whole and the title wraps after it.
      <Text wrap="wrap">
        <Text color="yellow">{'☐ '}</Text>
        <Text bold>{'Assigned you a task: '}</Text>
        {printable(title, MAX_SHOWN_TITLE)}
      </Text>
    )
  })

  // A second client on a surface (two phones) draws the pane at a width of
  // its own, and its fields with what is typed in them so far: it is counted
  // before it draws.
  on('session.attach', async ($, e, next) => {
    live.drawn.delete(e.surface)
    await rostered($, all => ({ ...all, [e.surface]: [...new Set(all[e.surface]).add(e.clientId)] }))
    return next(e)
  })

  // A client gone, the pane fits the ones left, which draw it again as the
  // roster changes: no render says which of its surface's seats was its own,
  // so they start over, and go with the last client. Both happen ahead of the
  // write that wakes the drawings, which fit the pane to what is left.
  on('session.detach', async ($, e, next) => {
    await rostered($, all => {
      const left = (all[e.surface] ?? []).filter(id => id !== e.clientId)

      if (left.length > 0) {
        live.startingOver.add(e.surface)
      } else {
        live.seats.delete(e.surface)
        live.emptied.set(e.surface, (live.emptied.get(e.surface) ?? 0) + 1)
      }

      return { ...all, [e.surface]: left }
    })

    return next(e)
  })

  // The ring on the open field lets the terminal wrap what is typed there:
  // the pane asks for the rows that takes, and for one row once it leaves.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const moved = await next(e)

    if (moved.deny === undefined) {
      live.ring = e.element
      void refit($)
    }

    return moved
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const emptied = live.emptied.get(e.surface)
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // The mobile app draws no field yet: answers and reasons wait for a surface
    // that does. The engine fills an element a surface lacks with one that draws
    // nothing, so the surface says, not the table.
    const Input = e.surface !== 'mobile' && 'Input' in elements ? elements.Input : undefined
    const view = await paneView($, { canType: Input !== undefined, isFocused: e.props.isFocused })

    // The pane asks for the rows its tree takes at the width each surface
    // draws it in: a long title wraps, and a pane sized for one row would cut
    // off the rest.
    const columns = e.props.bodyColumns
    const seat: Seat = { columns, canType: view.canType, isFocused: view.isFocused, isInline: e.props.placement === 'inline' }
    // Drawn by two clients, a surface keeps how each drew it, or each one's
    // drawing would resize the pane against the other's: as a render names
    // neither, every way it was drawn since a client came or went. One drawn
    // as the surface's last client left keeps no seat, which nothing there
    // would draw again to take back.
    const isShared = ((await read($, clients))[e.surface]?.length ?? 0) > 1
    // A surface that docks the pane it seated inline asks for the rows of
    // those that still seat it inline.
    const wasInline = (live.seats.get(e.surface) ?? []).some(one => one.isInline)

    if (live.emptied.get(e.surface) === emptied) {
      const kept = live.startingOver.delete(e.surface) ? [] : (live.seats.get(e.surface) ?? [])
      live.seats.set(e.surface, isShared ? seatsWith(kept, seat) : [seat])
    }

    const { shown, editing: field, isWorking: working } = view
    const archived = view.archived ?? []

    // The Archived section: collapsed, one row that counts the archived
    // tasks; open, each with the day it is deleted and Restore. Neither
    // archiving nor restoring sends Claude anything.
    const archivedSection =
      archived.length === 0 ? null : (
        <Box key="archived-section" flexDirection="column" marginTop={1} flexShrink={0}>
          <Box flexShrink={0}>
            <Button key="archived" plain dimColor label={archivedHeadOf(archived.length, view.isArchiveOpen === true)} onPress={() => toggleArchive($)} />
          </Box>
          {view.isArchiveOpen === true
            ? archived.map(task => (
                <Box key={`archived-${task.id}`} flexDirection="row" flexShrink={0}>
                  <Text dimColor wrap="wrap">
                    {archivedRowOf(task)}
                  </Text>
                  <Box flexShrink={0} marginLeft={2}>
                    <Button key={`restore-${task.id}`} plain label={RESTORE} onPress={() => restoreTask($, task.id)} />
                  </Box>
                </Box>
              ))
            : null}
        </Box>
      )

    // The pane is closing: it asks for no rows, which would open it again.
    if (shown.length === 0) {
      return (
        <Box flexDirection="column" rowGap={1}>
          <Text dimColor>No tasks for you right now.</Text>
          {archivedSection}
          <Button key="hide" plain dimColor role="dismiss" label={HIDE} onPress={() => closePane($)} />
        </Box>
      )
    }

    freshDashboard($)

    if (seat.isInline || wasInline) {
      const rows = await rowsWanted($, view)

      if (rows !== live.rows) {
        void fit($, rows)
      }
    }

    const active = shown.filter(isActive)
    const saved = shown.filter(task => !isActive(task))
    const selected = selectedOf(view)
    const head = headlineOf(view)

    // The glyph keeps its cells beside a title that wraps.
    const glyph = (
      <Box flexShrink={0}>
        <Text color="yellow">{'☐ '}</Text>
      </Box>
    )

    // The title and its age are one text, so a long title wraps under itself
    // and the age follows it, never squeezed into a column of its own.
    const titleText = (task: Task, isBold: boolean) => (
      <Text wrap="wrap">
        <Text bold={isBold}>{titleOf(task)}</Text>
        <Text dimColor>{ageOf(task, view)}</Text>
      </Text>
    )

    const actionsOf = (task: Task) => (
      <Box key="actions" flexDirection="row" flexWrap="wrap" columnGap={BUTTON_GAP}>
        {actionsFor(task, view.canType, isFullOf(task, view)).map(action => (
          <Button
            key={action.key}
            plain
            hotkey={action.hotkey}
            label={action.label}
            onPress={() => {
              if (action.option !== undefined) {
                return respond($, task.id, { state: 'done', answer: action.option }, 'auto')
              }

              if (action.key === 'done') {
                return respond($, task.id, { state: 'done' }, 'auto')
              }

              if (action.key === 'full') {
                return toggleFull($, task.id)
              }

              if (action.key === 'archive') {
                return archiveTask($, task.id)
              }

              if (action.key === 'answer') {
                return startEditing($, task.id, 'answer')
              }

              return view.canType ? startEditing($, task.id, 'reason') : respond($, task.id, { state: 'rejected' }, 'auto')
            }}
          />
        ))}
      </Box>
    )

    const answerField = (task: Task, held: string | undefined): Controls => {
      if (Input === undefined) {
        return [null, null]
      }

      if (held !== undefined) {
        return [
          null,
          <Box key="held" flexDirection="column">
            <Text color="yellow" wrap="wrap">
              {HELD}
            </Text>
            <Box flexDirection="row" flexWrap="wrap" columnGap={BUTTON_GAP}>
              <Button key="edit" plain label="Edit" onPress={() => startEditing($, task.id, 'answer')} />
              <Button key="send-anyway" plain label="Send anyway" onPress={() => answer($, task.id, held, 'auto', true)} />
            </Box>
          </Box>,
        ]
      }

      const key = fieldKeyOf({ id: task.id, field: 'answer' })
      const submitLabel = submitLabelOf('answer', view)
      const [otherWay, long, cancel] = answerButtonsOf(view)

      return [
        <Input
          key={key}
          label={ANSWER_LABEL}
          placeholder={placeholderOf(answerPlaceholderOf(view), ANSWER_LABEL, submitLabel, columns)}
          value={fieldValueOf(e.surface, key)}
          rows={ANSWER_ROWS}
          submitLabel={submitLabel}
          autoFocus
          onInput={value => typed($, key, value)}
          onSubmit={value => answer($, task.id, value, 'auto')}
        />,
        <Box key="buttons" flexDirection="row" flexWrap="wrap" columnGap={BUTTON_GAP}>
          <Button key="other-way" plain label={otherWay} onPress={() => answerTyped($, task.id, working ? 'now' : 'later')} />
          <Button key="long" plain label={long} onPress={() => longAnswer($, task.id)} />
          <Button key="cancel" plain label={cancel} onPress={() => stopEditing($)} />
        </Box>,
      ]
    }

    const reasonField = (task: Task): Controls => {
      if (Input === undefined) {
        return [null, null]
      }

      const key = fieldKeyOf({ id: task.id, field: 'reason' })
      const submitLabel = submitLabelOf('reason', view)

      return [
        <Input
          key={key}
          label={REASON_LABEL}
          placeholder={placeholderOf(REASON_PLACEHOLDER, REASON_LABEL, submitLabel, columns)}
          value={fieldValueOf(e.surface, key)}
          submitLabel={submitLabel}
          autoFocus
          onInput={value => typed($, key, value)}
          onSubmit={value => {
            const reason = oneLine(value)
            return respond($, task.id, { state: 'rejected', ...(reason === '' ? {} : { reason }) }, 'auto', reason)
          }}
        />,
        <Button key="cancel" plain label="Cancel" onPress={() => stopEditing($)} />,
      ]
    }

    const selectedRows = (task: Task) => {
      // A field open on a surface that draws one: elsewhere the task keeps its buttons.
      const isEditing = view.canType && field !== null && field.id === task.id
      const [input, buttons]: Controls = !isEditing
        ? [null, actionsOf(task)]
        : field.field === 'answer'
          ? answerField(task, field.held)
          : reasonField(task)
      const doneWhen = doneWhenOf(task)

      // The terminal sizes a field by the pane's body, whatever box holds it:
      // it goes out of the task's indent, across the body's whole width.
      return (
        <Box key={`task-${task.id}`} flexDirection="column" flexShrink={0}>
          <Box flexDirection="row">
            {glyph}
            {titleText(task, true)}
          </Box>
          <Box flexDirection="column" paddingLeft={2}>
            <Text wrap="wrap">{whyOf(task)}</Text>
            {doneWhen === undefined ? null : (
              <Text dimColor wrap="wrap">
                {doneWhen}
              </Text>
            )}
            {isFullOf(task, view) ? (
              <Box key="detail" flexDirection="column">
                {detailLinesOf(task).map((line, i) => (
                  <Text key={`detail-${i}`} wrap="wrap">
                    {line}
                  </Text>
                ))}
              </Box>
            ) : null}
          </Box>
          {input}
          <Box flexDirection="column" paddingLeft={2}>
            {buttons}
          </Box>
        </Box>
      )
    }

    const taskRows = active.map(task =>
      task.id === selected?.id ? (
        selectedRows(task)
      ) : (
        <Box key={`task-${task.id}`} flexDirection="row" flexShrink={0}>
          {glyph}
          <Box flexShrink={0}>
            <Button key={`select-${task.id}`} plain dimColor label={`#${task.id}`} onPress={() => select($, task.id)} />
          </Box>
          <Text dimColor wrap="wrap">
            {` ${nameOf(task)}${ageOf(task, view)}`}
          </Text>
        </Box>
      ),
    )

    const savedRows = saved.map((task, i) => (
      <Box key={`saved-${task.id}`} flexDirection="row" flexShrink={0}>
        <Box flexShrink={0}>{task.state === 'rejected' ? <Text color="red">{'✗ '}</Text> : <Text color="green">{'✓ '}</Text>}</Box>
        <Text dimColor wrap="wrap">
          {savedOf(task)}
        </Text>
        <Box flexShrink={0} marginLeft={2}>
          <Button key={`send-${task.id}`} plain {...sendNowOf(i)} onPress={() => sendNow($)} />
        </Box>
      </Box>
    ))

    return (
      <Box flexDirection="column">
        <Box key="head" flexDirection="row" flexShrink={0}>
          <Text wrap="wrap">
            <Text color={active.length > 0 ? 'yellow' : 'gray'}>{head.glyph}</Text>
            <Text bold>{head.headline}</Text>
            <Text dimColor>{head.note}</Text>
          </Text>
        </Box>
        <Box key="tasks" flexDirection="column" marginTop={1} flexShrink={0}>
          {taskRows}
          {savedRows}
        </Box>
        {archivedSection}
        <Box key="foot" flexDirection="row" marginTop={1} columnGap={BUTTON_GAP} flexShrink={0}>
          <Text dimColor wrap="wrap">
            {hintOf(view)}
          </Text>
          <Box flexShrink={0}>
            <Button key="hide" plain dimColor role="dismiss" label={HIDE} onPress={() => closePane($)} />
          </Box>
        </Box>
        {view.dashboard === undefined ? null : (
          <Box key="dashboard-row" flexDirection="row" columnGap={BUTTON_GAP} flexShrink={0}>
            <Text dimColor wrap="wrap">
              {view.dashboard.line}
            </Text>
            <Box flexShrink={0}>
              <Button key="dashboard" plain dimColor label={view.dashboard.action} onPress={() => pressDashboardToast($, live.dashboard?.dashboard === 'on' ? 'stop' : 'start')} />
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}

/** Keeps the pane's word on whether Claude works (Enter sends, or saves) in step. */
async function syncWorking($: EngineInterface) {
  const now = working()

  await update($, isWorking, () => now)
}

/**
 * Joins the project as this session: takes on its tasks, the store's slot
 * kept alive by a heartbeat, the status line and, for tasks taken on from an
 * earlier session, the pane.
 */
async function join($: EngineInterface, ends = live.ends) {
  const sessionId = await $.session.id()
  const root = await $.session.root()
  // From the folder the latest join is for: one still queued takes the process there first.
  const isMoving = live.joinRoot !== '' && live.joinRoot !== root
  live.joinRoot = root

  // A row of the conversation the process leaves is none of this one's.
  live.isUnread = false

  // After /clear the process goes on as a new session, with no slot yet: it
  // takes over once the old session's writes are done, and takes on what
  // the old one held, ended whether or not its end write landed (or, when
  // the old one never read the project, what the one before it held).
  // Resumed in another folder, it leaves that folder's tasks as its last
  // write there left them and starts on this one as a new process would,
  // keeping nothing it tracked of that project. A store that fails now
  // takes nothing on yet: the session writes nothing until it has read the
  // project, which the heartbeat tries again.
  const joined = queued(async () => {
    if (live.root !== '' && live.root !== root) {
      await update($, tasks, () => [])
      await update($, nextId, () => 1)
      await update($, took, () => ({}))
      await update($, selectedId, () => null)
      await update($, editing, () => null)
      await update($, loadedFor, () => null)
      live.drafts.clear()
      live.closed.clear()
      live.drawn.clear()
      live.held.clear()
      live.batch?.cancel()
      live.batch = null
      live.isSendingAtEnd = false
      live.elsewhere = 0
      live.floor = 1
      live.hasLegacyPeer = false
    }

    live.sessionId = sessionId
    live.root = root
    live.hasSlot = false
    live.writtenMs = 0
    live.readMs = 0

    // A session that ended while this waited in the queue (an exit right
    // after /clear, the store slow) reads the project as an ending session
    // does, and its end write, queued after this, marks its slot ended.
    if (live.ends === ends) {
      live.endedMs = undefined
    }

    return load($)
  }).catch(() => undefined)

  if (isMoving) {
    live.moving += 1
    void joined.then(() => {
      live.moving -= 1
    })
  }

  // Tasks from an earlier session: the status line says so, and the pane
  // opens where the terminal is wide enough to seat it unasked, unless the
  // session has ended since.
  const shown = joined
    .then(async () => {
      if ((await refresh($)) && live.ends === ends) {
        await show($, false)
      }
    })
    .catch(() => undefined)

  // One that ended before this ran has no heartbeat: its end stopped the last.
  // The heartbeat also starts the listener again when it has ended.
  if (live.ends === ends) {
    live.heartbeat?.cancel()
    live.heartbeat = $.clock.every(HEARTBEAT_MS, () => {
      void beat($)
      void keepEndpoint($, ends)
      void dashboardBeat($)
    })
    await keepEndpoint($, ends)
  }

  // A store slow to answer holds up the start 5 seconds at most: what the
  // session takes on shows once it answers.
  await awaited($, joined)
  await redrawn($, shown)
}

/**
 * Takes on the tasks this session owns in the project's store: its own (a
 * resumed session) and those of sessions that ended or went quiet. A live
 * session's tasks stay its own: answers go to the session that asked. A hot
 * reload keeps the session's tasks as they are.
 */
async function load($: EngineInterface) {
  if (await isLoaded($)) {
    await sync($)
    return
  }

  const nowMs = await $.clock.now()
  const stored = await readProject($)
  const holder = await read($, loadedFor)
  const notes = await read($, took)
  const count = await read($, nextId)
  let project = stored
  let adoption!: Adoption
  // Tasks the process held that the join numbers anew.
  let moves: Move[] = []
  // Tasks the process didn't hold: their numbers may have named others here.
  let arrived: Task[] = []

  // Taken on against the task list as it stands when it changes hands, so a
  // press meanwhile is kept. `update` runs this again when another write
  // beat it: the last run is the list it wrote. The session's own tasks it
  // is done with, which no slot holds, stay in it, with the numbers its
  // Claude knows them by. Archived tasks are in the slots, so they come back
  // through the adoption, less those archived over 7 days ago: deleted here.
  await update($, tasks, current => {
    const done = current.filter(task => task.sessionId === live.sessionId && !isShown(task) && !isArchived(task))
    project = withHeld(stored, holder, slotFrom(current, notes, count, nowMs), nowMs)
    adoption = adopt(project, live.sessionId, nowMs, done.map(task => task.id), live.endedMs !== undefined, holder)
    moves = adoption.renumbered.filter(({ task }) => current.some(one => isSameTask(one, task))).map(({ task, id }) => ({ from: task.id, to: id }))
    arrived = adoption.adopted.filter(task => !current.some(one => isSameTask(one, task)) && !moves.some(move => move.to === task.id))

    return [...done, ...adoption.adopted].sort((a, b) => a.id - b.id)
  })

  await renumber($, moves, arrived.map(task => task.id))
  live.readMs = nowMs
  live.hasSlot ||= live.sessionId in stored.slots
  await update($, nextId, n => Math.max(n, adoption.nextId))
  await update($, took, () => adoption.took)
  await update($, loadedFor, () => live.sessionId)
  live.elsewhere = elsewhereIn(project, live.sessionId, nowMs)
  live.floor = adoption.nextId
  live.hasLegacyPeer = hasLegacyPeer(project, live.sessionId, nowMs)
  await reselect($)

  try {
    // The slot first, noting what it took: only then do the slots it took from leave.
    await writeOwn($, adoption.removed.length > 0)
    await clean($, project, adoption.removed, adoption.legacy)
  } catch {
    // What it took on stands, and the caller shows it: the next heartbeat
    // makes the writes.
  }
}

/** A task the process held that the join numbered anew: the number it leaves, and the one it takes. */
type Move = { from: number; to: number }

/**
 * Has what the process keeps under task numbers follow its tasks through a
 * join. A task it held that the join numbered anew (`moves`) takes its
 * drafts, a field open on it, the ring and the selection along. Under the
 * numbers of tasks it didn't hold (`arrived`: another session drew the
 * number too, or a resumed one did), it lets go of the drafts, what was
 * typed as a task under it closed, and a field open on it. Kept, they would
 * go with the task that holds the number now.
 */
async function renumber($: EngineInterface, moves: readonly Move[], arrived: readonly number[]) {
  const toOf = (id: number) => moves.find(move => move.from === id)?.to

  for (const field of ['answer', 'reason'] as const) {
    // Carried first: the number a task leaves may be one another arrived under.
    for (const { from, to } of moves) {
      const draft = live.drafts.get(fieldKeyOf({ id: from, field }))

      if (draft !== undefined) {
        live.drafts.set(fieldKeyOf({ id: to, field }), draft)
      }

      if (live.ring === fieldKeyOf({ id: from, field })) {
        live.ring = fieldKeyOf({ id: to, field })
      }
    }

    for (const id of arrived) {
      live.drafts.delete(fieldKeyOf({ id, field }))
    }
  }

  for (const id of arrived) {
    live.closed.delete(fieldKeyOf({ id, field: 'answer' }))
  }

  await update($, editing, field => {
    if (field === null) {
      return null
    }

    const to = toOf(field.id)
    return to !== undefined ? { ...field, id: to } : arrived.includes(field.id) ? null : field
  })
  await update($, selectedId, id => (id === null ? id : (toOf(id) ?? id)))
}

/**
 * Whether the session has read the project as itself: until then, the store
 * may hold tasks of its own it hasn't taken on. `loadedFor` names the session
 * whose tasks the process holds.
 */
async function isLoaded($: EngineInterface): Promise<boolean> {
  return (await read($, loadedFor)) === live.sessionId
}

/**
 * The project as read, with what this process holds (`slot`) that the store
 * may not have. Held for another session (`holder`, the one it left at
 * /clear or a resume in place), it is that session's slot, ended: its end
 * write may have failed. The slot keeps the time the store has, so that it
 * leaves once this session's is written. Held for none (no session of the
 * process has read the project), it is the tasks its sessions assigned: each
 * session's beside the tasks the store holds for it, ended, unless it is this
 * one or the store doesn't show it ended. One alive or quiet there has been
 * resumed by another process since, or may have been: it keeps its slot, and
 * what it assigned here goes on in this one's.
 */
function withHeld(project: Project, holder: string | null, slot: Slot, nowMs: number): Project {
  if (holder !== null) {
    const stored = project.slots[holder]

    if (stored === undefined && slot.tasks.length === 0 && slot.took === undefined) {
      return project
    }

    return withSlots(project, { [holder]: { ...slot, seenMs: stored?.seenMs ?? 0, endedMs: nowMs } })
  }

  const own = live.sessionId
  const slots: Record<string, Slot> = {}

  for (const task of slot.tasks) {
    const stored = project.all[task.sessionId]
    const id = stored === undefined || stored.endedMs !== undefined ? task.sessionId : own
    const into = (slots[id] ??= { seenMs: 0, ...project.all[id], tasks: [], ...(id === own ? {} : { endedMs: nowMs }) })

    into.tasks.push(task)
  }

  for (const [id, held] of Object.entries(slots)) {
    held.tasks.push(...(project.all[id]?.tasks ?? []))
  }

  return withSlots(project, slots)
}

/**
 * Says this session is alive, and counts the tasks waiting in the project's
 * other sessions: `sync`, and a redraw of what it changed. Not `isWriting`
 * where a write follows (assigning). While store work given up on is still
 * out, it asks for no more: the first heartbeat after it settles syncs.
 */
async function beat($: EngineInterface, isWriting = true) {
  if (live.stalled > 0) {
    return
  }

  const was = live.elsewhere
  const synced = queued(() => sync($, isWriting)).catch((): Synced => 'same')
  const shown = synced
    .then(async outcome => {
      // A first read shows the project as joining does: the pane opens for
      // the tasks it took on.
      if ((outcome !== 'same' || live.elsewhere !== was) && (await refresh($)) && outcome === 'joined') {
        await show($, false)
      }
    })
    .catch(() => undefined)

  await awaited($, synced)
  await redrawn($, shown)
}

/**
 * Reads the project and acts on it: lets go of the tasks another session
 * took on while this one slept, keeps the notes of what this one took that
 * are still needed, counts the tasks waiting elsewhere, and writes the slot,
 * unless not `isWriting` (a write follows) and nothing leaves it or the
 * store: a task let go of leaves at once, since the caller may write nothing
 * after all (an ask that repeats one, say). A session that couldn't read the
 * project as it joined takes it on instead.
 * Resolves what changed of what it shows.
 */
async function sync($: EngineInterface, isWriting = true): Promise<Synced> {
  if (!(await isLoaded($))) {
    await load($)
    return 'joined'
  }

  const nowMs = await $.clock.now()
  const stored = await readProject($)
  const own = live.sessionId
  // With the session's own slot as it holds it: the store may not have its
  // last write, the note of tasks it took back among them.
  const project = withSlots(stored, { [own]: await slotOf($, nowMs) })
  const isLost = await letGo($, project)
  const pruned = prune(project, own, await read($, took), nowMs)

  await update($, took, () => pruned.took)
  live.readMs = nowMs
  live.hasSlot ||= own in stored.slots
  live.elsewhere = elsewhereIn(project, own, nowMs)
  live.floor = floorOf(project)
  live.hasLegacyPeer = hasLegacyPeer(project, own, nowMs)

  try {
    // The slot first: it carries the tasks let go of before the note that
    // told of them leaves, and the notes and count of a slot before it does.
    if (isWriting || isLost || pruned.removed.length > 0 || !isEmptyEdit(pruned.legacy)) {
      await writeOwn($, pruned.removed.length > 0)
    }

    await clean($, project, pruned.removed, pruned.legacy)
  } catch {
    // What it let go of stands, and the caller redraws it: the next
    // heartbeat makes the writes.
  }

  return isLost ? 'lost' : 'same'
}

/**
 * Lets go of the tasks another session took on while this one was quiet (a
 * laptop asleep, say): they are that session's now, and the user answers
 * them there. Resolves whether any of them was shown.
 */
async function letGo($: EngineInterface, project: Project): Promise<boolean> {
  const isTaken = (task: Task) => isTakenFrom(project, live.sessionId, task)
  const list = await read($, tasks)

  if (!list.some(isTaken)) {
    return false
  }

  const lost = list.filter(task => isTaken(task) && isShown(task))

  await update($, tasks, current => current.filter(task => !isTaken(task)))

  for (const task of lost) {
    await settle($, task.id)
  }

  if (lost.length > 0) {
    const which = numbersOf(lost.map(task => task.id))
    const [noun, them] = lost.length === 1 ? ['task', 'it'] : ['tasks', 'them']

    $.ui.toast(`Another session in this project took on ${noun} ${which} while this one was away. Answer ${them} there.`, {
      timeoutMs: 8000,
    })
  }

  return lost.length > 0
}

/**
 * Runs store work one piece at a time, in the order asked, so no write of
 * the session's lands after a newer one. No piece asks for another.
 */
function queued<T>(work: () => Promise<T>): Promise<T> {
  const done = live.queue.then(work, work)
  live.queue = done.catch(() => undefined)

  return done
}

/**
 * Writes the roster as `rewrite` has it once the writes asked for before are
 * done, in the order the engine raised them, so a client that leaves and
 * attaches again stays counted. Nothing else writes the roster: `rewrite`
 * runs once, ahead of its write.
 */
function rostered($: EngineInterface, rewrite: (all: Roster) => Roster): Promise<Roster> {
  const done = live.rosterQueue.then(() => update($, clients, rewrite))
  live.rosterQueue = done.catch(() => undefined)

  return done
}

/**
 * Resolves once store `work` settles, or `STORE_WAIT_MS` on: a press, a
 * prompt or a tool call goes on without a store that is slow to answer, and
 * the work finishes on its own, in its place in the queue. Until work given
 * up on settles, nothing waits on the store at all.
 */
async function awaited($: EngineInterface, work: Promise<unknown>) {
  if (live.stalled > 0) {
    return
  }

  if (!(await within($, work))) {
    const settled = () => {
      live.stalled -= 1
    }

    live.stalled += 1
    void work.then(settled, settled)
  }
}

/**
 * Resolves once the redraw that store work leads to settles, `STORE_WAIT_MS`
 * on, or at once while that work was given up on: it is no store work, so a
 * surface slow to open the pane holds up neither the store nor the heartbeat.
 */
async function redrawn($: EngineInterface, shown: Promise<unknown>) {
  if (live.stalled === 0) {
    await within($, shown)
  }
}

/** Resolves once `work` settles, or `STORE_WAIT_MS` on, whichever is first: whether it settled. */
function within($: EngineInterface, work: Promise<unknown>): Promise<boolean> {
  return new Promise(finish => {
    const timer = $.clock.after(STORE_WAIT_MS, () => finish(false))
    const done = () => {
      timer.cancel()
      finish(true)
    }

    void work.then(done, done)
  })
}

/**
 * Reads the project: 0.1.4's value, when there is one, and each session's
 * slot, one read of the store each. Joining, the heartbeat and assigning
 * read it; a pane press or a prompt, which a person waits on, doesn't.
 */
async function readProject($: EngineInterface): Promise<Project> {
  const keys = keysOf(live.root)
  const wanted = (await $.store.keys()).filter(key => key === keys.legacy || key.startsWith(keys.prefix))
  const values = await Promise.all(wanted.map(key => $.store.get(key)))

  return projectOf(live.root, Object.fromEntries(wanted.map((key, i) => [key, values[i]])))
}

/**
 * Writes the session's slot from what it holds, under its own key: the one
 * key it writes. A session that never held a task has no slot, unless
 * `isForced` or the answer endpoint is on (then it writes one from its first
 * read of the project, #187): its count must be in the store before a slot that carries one
 * leaves it. One that has a slot keeps it, its count in it, until it ends,
 * and the next session in the project removes it; it has one from the first
 * write it makes, landed or not, since a write that fails, the next one
 * makes, its tasks gone by then or not. A session that hasn't read the
 * project writes nothing: it would write over tasks of its own.
 */
async function writeOwn($: EngineInterface, isForced = false) {
  if (!(await isLoaded($))) {
    return
  }

  const nowMs = await $.clock.now()
  // Archived over 7 days ago: deleted from what the session holds, and so
  // from the slot this writes. Nothing else leaves here (`withoutExpired`).
  // With none due, the list is read once and written not at all, as before.
  const held = await read($, tasks)
  const list = withoutExpired(held, nowMs) === held ? held : await update($, tasks, current => withoutExpired(current, nowMs))
  const slot = slotFrom(list, await read($, took), await read($, nextId), nowMs)

  // With the answer endpoint on, the slot is written from the first read of
  // the project, tasks or not: the dashboard finds the project's live sessions
  // by their slots, to send one an Archive or Restore of an ended session's
  // task (#187). An empty slot leaves with the next session to take it on.
  // TODO(deferred): #194 an endpoint-on session that ends holding nothing leaves an empty ended slot in projects never opened again
  if (!live.hasSlot && !isForced && !isEndpointOn && slot.tasks.length === 0 && slot.took === undefined) {
    return
  }

  live.hasSlot = true
  await $.store.set(keysOf(live.root).session(live.sessionId), slot)
  live.writtenMs = nowMs
}

/** The session's slot, from what it holds now. */
async function slotOf($: EngineInterface, nowMs: number): Promise<Slot> {
  return slotFrom(await read($, tasks), await read($, took), await read($, nextId), nowMs)
}

/** The session's slot, holding `list`, its `notes` of what it took, and its count. */
function slotFrom(list: readonly Task[], notes: Readonly<Record<string, Took>>, count: number, nowMs: number): Slot {
  return {
    tasks: list.filter(task => isKept(task, nowMs)),
    seenMs: nowMs,
    nextId: count,
    ...(Object.keys(notes).length > 0 ? { took: { ...notes } } : {}),
    ...(live.endedMs === undefined ? {} : { endedMs: live.endedMs }),
  }
}

/**
 * Removes the slots this session took over and no longer needs, once its own
 * is written: each of this version's unless it changed since it was read (its
 * session came back), and 0.1.4's by `legacyEdit`.
 */
async function clean($: EngineInterface, project: Project, removed: readonly string[], legacyEdit: LegacyEdit) {
  const keys = keysOf(live.root)

  for (const id of removed) {
    const key = keys.session(id)
    const current = await $.store.get(key)

    if (isSlot(current) && current.seenMs === project.slots[id]?.seenMs) {
      await $.store.delete(key)
    }
  }

  await editLegacy($, legacyEdit, project.legacy.nextId)
}

/**
 * Applies `legacyEdit` to 0.1.4's value as it stands just before, its count
 * raised to this session's; with nothing else to change, raises the count
 * alone, while a 0.1.4 session alive here numbers its tasks from it, and only
 * past the count as it was just read (`readCount`). A 0.1.4 session writing
 * in between is the race 0.1.4 always had among its own. A session that
 * hasn't read the project changes nothing there.
 */
async function editLegacy($: EngineInterface, legacyEdit: LegacyEdit, readCount = 0) {
  const key = keysOf(live.root).legacy
  const count = await read($, nextId)

  if (key === undefined || !(await isLoaded($)) || (isEmptyEdit(legacyEdit) && (!live.hasLegacyPeer || count <= readCount))) {
    return
  }

  const current = legacyOf(await $.store.get(key))
  const edited = editedLegacy(current, legacyEdit, count, await $.clock.now())

  if (!isEmptyEdit(legacyEdit) || edited.nextId > current.nextId) {
    await $.store.set(key, edited)
  }
}

/**
 * Before a person's press or prompt acts on the tasks: when the slot is two
 * heartbeats old, the session may have slept long enough for another to take
 * its tasks on, so it reads the project, lets them go and redraws. Otherwise
 * it reads nothing: a person waits on this.
 */
async function wake($: EngineInterface) {
  if (live.hasSlot && (await $.clock.now()) - Math.max(live.writtenMs, live.readMs) >= 2 * HEARTBEAT_MS) {
    await beat($)
  }
}

/**
 * Changes the task list and, when that changes it (`fn` hands back a new
 * list), writes the slot, reading nothing (see `wake`). The session's own
 * state is what counts: a write that fails now, the heartbeat makes.
 */
async function change($: EngineInterface, fn: (list: readonly Task[]) => readonly Task[]) {
  await wake($)
  let isChanged = false

  // `update` runs `fn` again when another write beat it: the last run counts.
  await update($, tasks, list => {
    const changed = fn(list)
    isChanged = changed !== list
    return changed
  })

  if (isChanged) {
    await awaited($, queued(() => writeOwn($)))
    await refresh($)
  }
}

/**
 * Marks the updates Claude has not heard delivered (every one, or those
 * `isWanted`), in one change of the task list, and resolves them: the path
 * that claims them sends them, and no other finds them waiting meanwhile.
 */
async function claim($: EngineInterface, isWanted: (task: Task) => boolean = () => true): Promise<readonly Task[]> {
  const isDue = (task: Task) => task.update === 'pending' && isWanted(task)
  let due: readonly Task[] = []

  if (!(await read($, tasks)).some(isDue)) {
    return due
  }

  await change($, list => {
    due = list.filter(isDue)

    return list.map(task => (isDue(task) ? { ...task, update: 'delivered' } : task))
  })

  return due
}

/**
 * Keeps the status line in step with the tasks, and closes the pane once
 * nothing is left in it. Resolves whether anything is shown.
 */
async function refresh($: EngineInterface): Promise<boolean> {
  const shown = (await read($, tasks)).filter(isShown)

  live.taskStatus = statusOf(shown, live.elsewhere)
  live.pinned = statusLine()
  $.ui.status(live.pinned)

  if (shown.length === 0 && !live.keepsEmpty) {
    await closePane($).catch(() => undefined)
  }

  return shown.length > 0
}

/** The status line: the tasks' words, then the dashboard line once the dashboard is set up. */
function statusLine(): string | undefined {
  const dashboard = live.dashboard?.isSetUp === true ? dashboardLine() : undefined

  return [live.taskStatus, dashboard].filter(part => part !== undefined && part !== '').join(' · ') || undefined
}

/** The dashboard line, unless the dashboard was never read or has no config. */
function dashboardLine(): string | undefined {
  return live.dashboard === undefined || live.dashboard.why === NO_CONFIG ? undefined : dashboardLineOf(live.dashboard, repliesNow())
}

/** The pane's dashboard row: the line, and the button that starts or stops the dashboard. */
function dashboardRow(): PaneView['dashboard'] {
  const line = dashboardLine()

  const action =
    live.dashboardBusy === 'start' ? 'Starting dashboard…' : live.dashboardBusy === 'stop' ? 'Stopping dashboard…' : live.dashboard?.dashboard === 'on' ? 'Stop dashboard' : 'Start dashboard'

  return line === undefined ? undefined : { line, action }
}

/** Whether this session takes answers from the dashboard: its answer endpoint's listener is running and ready. */
function repliesNow(): Replies {
  const endpoint = live.endpoint

  if (!isEndpointOn) {
    return { state: 'off', why: SETTING_OFF }
  }

  if (endpoint?.isReady() === true) {
    return { state: 'on', why: '' }
  }

  if (endpoint?.isRunning() === true) {
    return { state: 'starting', why: '' }
  }

  const failure = endpoint?.failure() ?? live.endpointFailure

  return { state: 'off', why: failure === undefined ? 'endpoint not running' : `endpoint failed: ${printable(failure, 60)}` }
}

/** Draws the pane again when its dashboard line changed, pins the status line again when it changed, and publishes the line for the progress pane. */
function syncDashboard($: EngineInterface) {
  const line = dashboardLine()

  if (line !== live.dashboardDrawn) {
    live.dashboardDrawn = line
    $.ui.invalidate('ui.render')
  }

  const status = statusLine()

  if (status !== live.pinned) {
    live.pinned = status
    $.ui.status(status)
  }

  // Published every time, changed or not: a reader (the progress pane) shows
  // the line only while `at` is recent, and the host may have cleared the
  // state (/clear, a resume).
  const seq = ++live.dashboardPublishedSeq
  const at = live.dashboardAt
  const published = live.dashboard?.isSetUp === true && line !== undefined && at !== undefined ? { line, at, seq } : null

  void publishDashboard($, seq, published).catch(() => undefined)
}

/**
 * Writes `published`, this copy's publication number `seq`, unless a later
 * publication overtook it, even after it read the state (`update` writes with
 * ifVersion and reads again on a miss): a later one of this copy, or a stored
 * line stamped later than this one, which another copy wrote (a hot reload
 * starts the numbers again while the host keeps the state). A stored stamp
 * more than DASHBOARD_SKEW_MS ahead of this clock does not count: the clock
 * stepped back, and publishing must not stop until it catches up (agent
 * decision, fix round 3). No line (null) counts as stamped now.
 */
async function publishDashboard($: EngineInterface, seq: number, published: StateValue<'human-in-the-loop', 'dashboard'>) {
  type Stored = StateValue<'human-in-the-loop', 'dashboard'>
  const same = (a: Stored, b: Stored) => a?.at === b?.at && a?.seq === b?.seq && a?.line === b?.line
  let isStale = true

  // `update` takes a callback that cannot wait for the clock, so the clock is
  // read after the state, and the callback gives up (leaves the line as it is)
  // when the stored line is not the one that clock was read for: a read that
  // stalled does not leave a stored stamp looking like a step of the clock.
  // When every try is overtaken this way, the line is left as it is: the next
  // reading (each minute) publishes again (Codex review r5).
  for (let attempt = 0; attempt < DASHBOARD_PUBLISH_TRIES && isStale; attempt += 1) {
    const seen = await read($, dashboardShown)
    const nowMs = await $.clock.now()
    const stamp = published?.at ?? nowMs

    isStale = false
    await update($, dashboardShown, current => {
      if (!same(current, seen)) {
        isStale = true
        return current
      }

      const isLater = typeof current?.at === 'number' && current.at > stamp && current.at - nowMs <= DASHBOARD_SKEW_MS

      return seq === live.dashboardPublishedSeq && !isLater ? published : current
    })
  }
}

/** Keeps `dashboard`, learnt as number `seq` and taken at `atMs`, as the latest reading, fresh for DASHBOARD_FRESH_MS, and shows and publishes it; one older than the reading kept is dropped. */
function keepDashboard($: EngineInterface, dashboard: Dashboard | undefined, seq: number, atMs: number) {
  if (seq <= live.dashboardKeptSeq) {
    return
  }

  live.dashboardKeptSeq = seq
  live.dashboard = dashboard
  live.dashboardAt = atMs
  live.dashboardFresh?.cancel()
  live.dashboardFresh = $.clock.after(DASHBOARD_FRESH_MS, () => {
    live.dashboardFresh = null
  })
  syncDashboard($)
}

/**
 * Reads the dashboard, once the drawing that asks has returned, unless a
 * reading is fresh or under way. Asked as the pane or the desktop's menu is
 * drawn, and once at session start when the dashboard is installed.
 */
function freshDashboard($: EngineInterface) {
  if (live.dashboardFresh !== null || live.dashboardReading !== null) {
    return
  }

  live.dashboardReading = new Promise<void>(resolve => {
    $.clock.after(0, resolve)
  })
    .then(async () => {
      const seq = ++live.dashboardSeq
      const dashboard = await readDashboard($, false)

      keepDashboard($, dashboard, seq, await $.clock.now())
    })
    .catch(() => undefined)
    .finally(() => {
      live.dashboardReading = null
    })
}

/**
 * On each heartbeat while the dashboard is installed (its config and its
 * unit), reads it again; once more after it stops being installed, while the
 * last reading still says it is set up, so the status line and the published
 * line drop it. Nothing runs otherwise.
 */
async function dashboardBeat($: EngineInterface) {
  if ((await isDashboardInstalled($)) || live.dashboard?.isSetUp === true) {
    freshDashboard($)
  }
}

/** Reads the dashboard now, as the person asked (the dashboard tool's status). */
async function askDashboard($: EngineInterface): Promise<Dashboard> {
  const seq = ++live.dashboardSeq
  const dashboard = (await readDashboard($, true)) ?? { dashboard: 'unknown', why: 'no reading', isSetUp: false, address: null, fix: '' }

  keepDashboard($, dashboard, seq, await $.clock.now())

  return dashboard
}

/** Starts or stops the dashboard as the person asked, one at a time; undefined while another is under way. */
async function pressDashboard($: EngineInterface, action: 'start' | 'stop'): Promise<Control | undefined> {
  if (live.dashboardBusy !== null) {
    return undefined
  }

  live.dashboardBusy = action
  $.ui.invalidate('ui.render')

  try {
    const done = await controlDashboard($, action)
    keepDashboard($, done.dashboard, ++live.dashboardSeq, await $.clock.now())

    return done
  } finally {
    live.dashboardBusy = null
    $.ui.invalidate('ui.render')
  }
}

/** One text block of a tool's answer. */
const textBlock = (text: string) => ({ type: 'text' as const, text })

const DASHBOARD_BUSY = 'The dashboard is already starting or stopping.'

/** What a press of Start or Stop says: what it did, and how the dashboard stands now. */
async function pressDashboardToast($: EngineInterface, action: 'start' | 'stop') {
  const done = await pressDashboard($, action)

  $.ui.toast(done === undefined ? DASHBOARD_BUSY : [done.message, dashboardLine()].filter(Boolean).join(' '), { timeoutMs: 8000 })
}

/**
 * A dashboard tool's answer, as text blocks (the engine takes no bare object as a tool's value): the words
 * first, then the address as a block of its own while the dashboard is on. Progress's /overview reads both.
 */
function dashboardResult(dashboard: Dashboard, lead = '') {
  return { result: [textBlock(lead + dashboardReport(dashboard)), ...(dashboard.dashboard === 'on' && dashboard.address !== null ? [textBlock(dashboard.address)] : [])] }
}

/** The dashboard tool's status words: the line, the next step, and where to open the page or turn replies on. */
function dashboardReport(dashboard: Dashboard): string {
  const replies = repliesNow()
  const lines = [dashboardLineOf(dashboard, replies)]

  if (dashboard.fix !== '') {
    lines.push(dashboard.fix)
  }

  if (dashboard.dashboard === 'on' && dashboard.address !== null) {
    lines.push(`Open ${dashboard.address} in a browser.`)
  }

  if (dashboard.dashboard === 'on' && replies.why === SETTING_OFF) {
    lines.push("Replies need the human-in-the-loop plugin's Answer endpoint setting on, then a new session or /clear.")
  }

  return lines.join('\n')
}

/**
 * Whether any surface is attached. A host that attaches none (T3 Code runs
 * Claude Code through the SDK) can't show a pane, and a pane opened or
 * focused there is left waiting for input the host fails the turn over. When
 * the engine can't say, a surface is assumed: the terminal is unchanged.
 */
async function hasSurface($: EngineInterface): Promise<boolean> {
  // An older engine without `surfaces` throws here; the surface is assumed.
  try {
    return (await $.session.surfaces()).length > 0
  } catch {
    return true
  }
}

/** How long a text reply waits on the dashboard's status for its link. */
const LINK_WAIT_MS = 1000

/** Where to open the web dashboard, for a session with no pane: its link when it runs, else how to set it up or start it. */
async function dashboardHint($: EngineInterface): Promise<string> {
  if (!(await hasDashboardConfig($))) {
    return 'The web dashboard is not set up (dashboard/README.md)'
  }

  let timer: Timer | undefined
  const late = new Promise<undefined>(resolve => {
    timer = $.clock.after(LINK_WAIT_MS, () => resolve(undefined))
  })

  try {
    const read = await Promise.race([askDashboard($), late])

    return read?.dashboard === 'on' && read.address !== null
      ? `Open the dashboard: ${read.address}`
      : 'The web dashboard is not running (or did not answer in time): /overview start, dashboard/README.md'
  } finally {
    timer?.cancel()
  }
}

/** The open tasks as text, for a session with no surface to draw the pane on, led by where the web dashboard is, and the archived ones after them. */
async function tasksAsText($: EngineInterface): Promise<string> {
  const open = (await read($, tasks)).filter(isShown)
  const list = open.length === 0 ? 'no open tasks' : open.map(task => `#${task.id} ${printable(task.title, MAX_TITLE)}`).join('; ')
  const archived = await archivedNow($)
  const shelf =
    archived.length === 0
      ? ''
      : ` Archived (${archived.length}): ${archived.map(task => `#${task.id} ${printable(task.title, MAX_TITLE)}, deleted on ${deletionDayOf(task)}`).join('; ')}. Restore one with /my-tasks restore <n>.`

  return `${await dashboardHint($)}. Open tasks: ${list} (pane not shown: no surface is attached)${shelf}`
}

const MY_TASKS_USAGE = 'Usage: /my-tasks [archive <n> | restore <n>]'

/** `/my-tasks archive <n>` or `/my-tasks restore <n>`: what it did, in words. Nothing is sent to Claude. */
async function shelveByCommand($: EngineInterface, isArchiving: boolean, which: string): Promise<string> {
  const id = Number(which.replace(/^#/, ''))

  if (which === '' || !Number.isSafeInteger(id) || id < 1) {
    return MY_TASKS_USAGE
  }

  const none = isArchiving ? `No open task #${id} here to archive.` : `No archived task #${id} here to restore.`
  let { found: was, nowMs } = await shelve($, id, isArchiving)
  // The number it goes by here: an ended session's task taken on may get a new one.
  let held = id

  if (was === undefined) {
    // Not this session's: an ended session's in the project, taken on first.
    const taken = await takeOver($, task => task.id === id, (task, at) => isShelvable(task, isArchiving, at), live.ends)

    if ('found' in taken) {
      return none
    }

    if ('refusal' in taken) {
      return taken.refusal === 'several'
        ? `More than one ended session in this project holds a task #${id}: it waits for the next session to start in this project.`
        : taken.refusal === 'pending'
          ? `Task #${id} is held by an ended session with answers Claude has not heard yet: it waits for the next session in this project.`
          : taken.refusal === 'busy'
            ? MOVING
            : none
    }

    held = taken.task.id
    ;({ found: was, nowMs } = await shelve($, held, isArchiving))
  }

  if (was === undefined || !isShelvable(was, isArchiving, nowMs)) {
    return none
  }

  const named = held === id ? `#${id}` : `#${held} (#${id} in an ended session)`

  if (!isArchiving) {
    await reselect($)
    return `Restored ${named}: ${printable(was.title, MAX_TITLE)}. It is back in My tasks; nothing was sent to Claude.`
  }

  await settle($, held)
  const archived = (await read($, tasks)).find(task => task.id === held && isArchived(task))
  const until = archived === undefined ? '' : ` until ${deletionDayOf(archived)}`

  return `Archived ${named}: ${printable(was.title, MAX_TITLE)}. Nothing was sent to Claude. Restore it with /my-tasks restore ${held}${until}.`
}

/** Closes the My tasks pane, and has a re-size under way leave it closed. */
function closePane($: EngineInterface): Promise<void> {
  live.keepsEmpty = false
  live.closes += 1

  return $.ui.close({ id: PANE })
}

/**
 * Opens the My tasks pane sized to what it holds; `isAsked` when the person
 * asked for it (/my-tasks), so it takes the keyboard. Resolves whether the
 * surface seated it: one opened unasked waits on a narrow terminal.
 */
async function show($: EngineInterface, isAsked: boolean): Promise<boolean> {
  if (!(await hasSurface($))) return false

  if (isAsked) live.keepsEmpty = true
  // A closed pane's fields are drawn with their drafts as it opens again:
  // the surfaces forget what they held as it closes. Its ring starts on the
  // open field, which takes it by autoFocus as the pane takes the keys.
  // Asked only when there is a draft to draw or a field open to take the
  // ring; when the engine can't say, they are drawn so anyway, and a field
  // still drawn gets back the text typed in it.
  if (live.drafts.size > 0 || (await read($, editing)) !== null) {
    const panes = await $.ui.panes().catch(() => undefined)

    if (panes === undefined || !panes.some(pane => pane.id === PANE)) {
      live.drawn.clear()
      live.ring = openKeyOf(await read($, editing))
    }
  }

  return openAt($, await rowsWanted($), isAsked)
}

/** Opens the My tasks pane `rows` tall, or re-sizes it; resolves whether the surface seated it. */
async function openAt($: EngineInterface, rows: number, isAsked: boolean): Promise<boolean> {
  // No surface: open nothing. #180 saw T3 fail the turn on a pane it cannot show;
  // a surface that attaches later (Remote Control) gets it from /my-tasks.
  if (!(await hasSurface($))) return false

  live.rows = rows
  // The pane is a view of the tasks: one that can't open costs the user a
  // click on /my-tasks, never the task itself.
  const opened = await $.ui
    .open({ id: PANE, title: PANE_TITLE, rows, ...(isAsked ? { focus: true as const } : {}) })
    .catch(() => ({ isPlaced: false as const }))

  return opened.isPlaced
}

/** What the pane draws from: the session's state, and what only the surface knows. */
async function paneView($: EngineInterface, surface: Pick<PaneView, 'canType' | 'isFocused'>): Promise<PaneView> {
  const field = await read($, editing)
  const key = openKeyOf(field)
  const list = await read($, tasks)
  const nowMs = await $.clock.now()
  const state = {
    shown: list.filter(isShown),
    selectedId: await read($, selectedId),
    fullId: await read($, fullId),
    editing: field,
    draft: key === undefined ? '' : (live.drafts.get(key) ?? ''),
    nowMs,
    sessionId: await $.session.id(),
    isWorking: await read($, isWorking),
    dashboard: dashboardRow(),
    archived: archivedIn(list, nowMs),
    isArchiveOpen: live.isArchiveOpen,
  }

  return seated(state, surface)
}

/** The pane's `view` as a surface that `canType`, and holds the keys or not, draws it. */
function seated(view: Omit<PaneView, 'canType' | 'isFocused' | 'isTyping'>, surface: Pick<PaneView, 'canType' | 'isFocused'>): PaneView {
  const key = openKeyOf(view.editing)

  return {
    ...view,
    canType: surface.canType,
    isFocused: surface.isFocused,
    isTyping: surface.canType && surface.isFocused && key !== undefined && live.ring === key,
  }
}

/** The key of the field open to type in, unless an answer held there for looking like a secret takes its place. */
function openKeyOf(field: Editing | null): string | undefined {
  return field === null || field.held !== undefined ? undefined : fieldKeyOf(field)
}

/** Re-sizes the pane to `wanted` rows, or else to what it holds now, when it is on screen. */
async function fit($: EngineInterface, wanted?: number) {
  const rows = wanted ?? (await rowsWanted($))
  const closes = live.closes
  // Asked once the rows are known, as the pane re-sizes: one that closed
  // meanwhile, its last task gone, stays closed, as does one closed while
  // the surface answers.
  const panes = await $.ui.panes().catch(() => [])

  if (live.closes === closes && panes.some(pane => pane.id === PANE && pane.isPlaced)) {
    await openAt($, rows, false)
  }
}

/**
 * Re-sizes an inline pane whose rows changed with what nothing draws it
 * again for: a draft growing, the ring moving onto its field or off it.
 * One at a time, in the order asked: each reads the draft and the ring once
 * the one before has asked for its rows, so the last asks for what the last
 * key or move left.
 */
function refit($: EngineInterface): Promise<void> {
  const done = live.refitQueue.then(async () => {
    if (inlineSeats().length === 0) {
      return
    }

    const rows = await rowsWanted($)

    if (rows !== live.rows) {
      await fit($, rows)
    }
  })
  live.refitQueue = done.catch(() => undefined)

  return done
}

/**
 * The rows the pane asks for: the most it takes on a surface seating it
 * inline. It is one height on all of them, and each asking for its own
 * would resize it against the others. From `view` when a render has just
 * read it, else from the state now.
 */
async function rowsWanted($: EngineInterface, view?: PaneView): Promise<number> {
  const inline = inlineSeats()
  const state = view ?? (await paneView($, FIRST_SEAT))

  return Math.max(...(inline.length > 0 ? inline : [FIRST_SEAT]).map(seat => rowsFor(seated(state, seat), seat.columns, MAX_PANE_ROWS)))
}

/** Every way a surface draws the pane inline, where its rows count. */
function inlineSeats(): Seat[] {
  return [...live.seats.values()].flat().filter(seat => seat.isInline)
}

/** Keeps what the user typed in the field keyed `key`, and the rows it takes. */
async function typed($: EngineInterface, key: string, value: string) {
  // Keys typed in a field say the ring is on it, though no move said so.
  live.ring = key
  live.drafts.set(key, value)
  await refit($)
}

/** What `surface` draws the field keyed `key` with: its draft, as the surface first drew it (see `live.drawn`). */
function fieldValueOf(surface: RenderSurface, key: string): string {
  const drawn = live.drawn.get(surface) ?? new Map<string, string>()
  const value = drawn.get(key) ?? live.drafts.get(key) ?? ''

  live.drawn.set(surface, drawn.set(key, value))
  return value
}

/**
 * Changes task `id` with `fn` while it is open, and resolves the task as the
 * change found it: one closed meanwhile (Claude withdrew it, or a press from
 * an older render answered it) or gone (another session took it on) stays
 * as it is. With `ref` (the answer endpoint), only the task of that number
 * assigned at `ref.createdMs`, only while it stands at `ref.version`, and
 * only while the session that judged the answer goes on (`ref.ends`): after
 * it ends, a task the next session took on (/clear) is not found.
 */
async function edit($: EngineInterface, id: number, fn: (task: Task) => Task, ref?: Judged): Promise<Task | undefined> {
  const nowMs = await $.clock.now()
  let found: Task | undefined

  await change($, list => {
    const isJudgingSession = ref === undefined || live.ends === ref.ends
    found = isJudgingSession ? list.find(task => task.id === id && (ref === undefined || task.createdMs === ref.createdMs)) : undefined

    return found !== undefined && isAt(found, ref) ? list.map(task => (task === found ? { ...fn(task), updatedMs: nowMs } : task)) : list
  })

  return found
}

/**
 * An answer through the endpoint as the session judged it: the task as the
 * caller saw it, and how many sessions of the process had ended then.
 */
type Judged = Versioned & { ends: number }

/**
 * Passes on a prompt that carries `due` to Claude, where `isCarried` looks
 * for each; the caller claimed them, so no other path sends them meanwhile.
 * Those that don't enter with it (a hook beneath dropped it or took them
 * out, or it failed) wait again for the next send, and a toast says so, as
 * `onDrop` says for a drop.
 */
async function passOn<R extends PromptSubmitResult>(
  $: EngineInterface,
  due: readonly Task[],
  isCarried: (entered: Entered, task: Task) => boolean,
  onDrop: DropNote,
  pass: () => Promise<R>,
): Promise<R> {
  let back: { lost: readonly Task[]; note: DropNote; reason?: string } | undefined

  try {
    const result = await pass()

    if (result.drop !== undefined) {
      back = { lost: due, note: onDrop, reason: result.drop }
    } else {
      const lost = due.filter(task => !isCarried(result, task))

      if (lost.length > 0) {
        // The prompt entered, and Claude takes a turn on it: sent again as
        // that turn ends, a response a hook beneath always takes out (or
        // rewords at its head) would go round and round. It waits for Send
        // now, as the toast says, or the next prompt.
        lost.forEach(task => live.held.add(updateKeyOf(task)))
        back = { lost, note: 'why', reason: 'a hook took it out of the prompt' }
      }
    }

    return result
  } catch (error) {
    back = { lost: due, note: 'why', reason: error instanceof Error ? error.message : String(error) }

    throw error
  } finally {
    if (back !== undefined) {
      await giveBack($, back.lost.map(task => task.id), back.note, back.reason)
    }
  }
}

/**
 * Whether a prompt that entered carries an update in its words, by how the
 * update opens there (`#5 <title>:`): a hook beneath may rewrite what an
 * answer says (mask a secret in it, say); one that takes the update out, or
 * rewords its head, leaves it to send again, since Claude hearing it twice
 * beats not hearing it.
 */
function inWords(entered: Entered, task: Task): boolean {
  return entered.text.includes(ownHeadOf(task))
}

/** The update a task carries, the same through each send and give-back: a new one changes `updatedMs`. */
function updateKeyOf(task: Task): string {
  return `${task.id}@${task.updatedMs}`
}

/** Whether a prompt that entered carries an update in a digest beside its words (`#5 done: <title>.`), read as `inWords` reads them. */
function inDigest(entered: Entered, task: Task): boolean {
  return (entered.context ?? []).some(block => block.includes(newsHeadOf(task)))
}

/**
 * Gives back updates that never reached Claude, to go with the next send,
 * and says so as `note` says. It never throws: `passOn` keeps the prompt's
 * own error.
 */
async function giveBack($: EngineInterface, ids: readonly number[], note: DropNote, reason?: string) {
  try {
    await undelivered($, ids)
  } catch {
    // `change` sets the session's state before the store and lets a store
    // write fail quietly; nothing else here is expected to throw.
  }

  if (note === 'nothing') {
    return
  }

  const which = numbersOf(ids)
  const why = note === 'why' && reason !== undefined ? `: ${printable(reason, 200).replace(/[.!]+$/, '')}` : ''

  $.ui.toast(`Claude didn't get your response to ${which}${why}. It's saved; press Send now in /my-tasks.`, {
    timeoutMs: 8000,
  })
}

/** Gives back updates marked delivered that never reached Claude: they wait again. */
async function undelivered($: EngineInterface, ids: readonly number[]) {
  await change($, list => list.map(task => (ids.includes(task.id) && task.update === 'delivered' ? { ...task, update: 'pending' } : task)))
}

/**
 * Keeps the selection on a task still open, and drops a field whose task is
 * gone, keeping what was typed for its answer for a press from a drawing
 * from before. With `ends` (an endpoint answer's session), a field open once
 * that session has ended is left: it may be the next session's.
 */
async function settle($: EngineInterface, id: number, ends?: number) {
  const key = fieldKeyOf({ id, field: 'answer' })
  const draft = live.drafts.get(key)

  if (draft !== undefined) {
    live.closed.set(key, draft)
  }

  for (const field of ['answer', 'reason'] as const) {
    forget(fieldKeyOf({ id, field }))
    live.drafts.delete(fieldKeyOf({ id, field }))
  }

  await update($, editing, field => (field?.id === id && (ends === undefined || live.ends === ends) ? null : field))
  await reselect($)
}

async function reselect($: EngineInterface) {
  const active = (await read($, tasks)).filter(isActive)

  await update($, selectedId, chosen => (active.some(task => task.id === chosen) ? chosen : (active[0]?.id ?? null)))
}

/** Full picture opens the selected task's detail in place of its card, and Back closes it. */
async function toggleFull($: EngineInterface, id: number) {
  if (!(await isOpenNow($, id))) {
    return
  }

  await update($, fullId, open => (open === id ? null : id))
  await fit($)
}

async function select($: EngineInterface, id: number) {
  // Pressed on a drawing from before its task closed, it leaves the pane as
  // it is: a field open on another task stays open.
  if (!(await isOpenNow($, id))) {
    return
  }

  await update($, selectedId, () => id)
  await update($, fullId, open => (open === id ? open : null))
  await update($, editing, field => (field?.id === id ? field : null))
  await fit($)
}

/**
 * The user fulfilled or rejected a task; `how` says when Claude hears of it.
 * Resolves the task as it stood, as `edit` does: one no longer open stays as it is.
 */
async function resolve($: EngineInterface, id: number, patch: Pick<Task, 'state'> & Partial<Task>, how: How, ref?: Judged) {
  const was = await edit($, id, task => ({ ...task, ...patch, update: 'pending' }), ref)
  const isOpen = was !== undefined && isAt(was, ref)

  // An endpoint answer the change found no task for, or whose session ended
  // after the change, leaves the pane alone: the field open under that
  // number, and what was typed in it, may be the next session's.
  if (ref === undefined || (was !== undefined && live.ends === ref.ends)) {
    await settle($, id, ref?.ends)
  }

  // One no longer open sends nothing new, and holds back no batch under way;
  // Send now still sends the answer it repeats, saved for later.
  if ((how === 'now' && (isOpen || isRepeatOf(was, patch))) || (how === 'auto' && isOpen && !working())) {
    sendSoon($)
  }

  return was
}

/** Whether task `was` stands answered as `patch` would answer it: a second press, say. */
function isRepeatOf(was: Task | undefined, patch: Pick<Task, 'state'> & Partial<Task>): boolean {
  return was !== undefined && was.state === patch.state && was.answer === patch.answer && was.reason === patch.reason
}

/**
 * A press on the pane resolves task `id`, as `resolve` does. One Claude
 * withdrew, another session took on, or the user answered otherwise (on
 * another surface, say) since the pane drew it says so, and what the user
 * typed for it (`typedText`) goes to the prompt box, unless it looks like a
 * secret; one already answered as this press would answer it (a second
 * press) stays answered.
 */
async function respond($: EngineInterface, id: number, patch: Pick<Task, 'state'> & Partial<Task>, how: How, typedText = '') {
  const was = await resolve($, id, patch, how)

  if (was === undefined || (!isActive(was) && !isRepeatOf(was, patch))) {
    const kept = (await toPromptBox($, typedText)) ? ' What you typed is in the prompt box.' : ''

    $.ui.toast(`Task #${id} isn't open any more, so your response wasn't saved.${kept}`, { timeoutMs: 8000 })
  }
}

/**
 * Puts what was typed for a task that closed in the prompt box, on a line
 * after any draft there, unless it looks like a secret; resolves whether the
 * box took it.
 */
async function toPromptBox($: EngineInterface, text: string): Promise<boolean> {
  if (text === '' || looksSecret(text)) {
    return false
  }

  const box = await $.prompt.read()
  const filled = await $.prompt.fill({ text: box.text === '' ? text : `\n${text}`, mode: 'append' }).catch(() => ({ isFilled: false }))

  return filled.isFilled
}

/**
 * Answers task `id` with what is typed in its field, or, pressed on a
 * drawing from before the task closed, with what was typed before it did.
 */
async function answerTyped($: EngineInterface, id: number, how: How) {
  const key = fieldKeyOf({ id, field: 'answer' })

  return answer($, id, live.drafts.get(key) ?? live.closed.get(key) ?? '', how)
}

/** Whether task `id` is open now: one closed meanwhile, or gone, takes no answer. */
async function isOpenNow($: EngineInterface, id: number): Promise<boolean> {
  return (await read($, tasks)).some(task => task.id === id && isActive(task))
}

async function answer($: EngineInterface, id: number, text: string, how: How, isSecretOk = false) {
  const value = text.trim()
  // Entered or pressed on a drawing from before its task closed, an answer
  // goes to `respond`, which says the task isn't open any more.
  const isOpen = await isOpenNow($, id)

  if (isOpen && value === '') {
    $.ui.toast('Type an answer first, or press Cancel.')
    return
  }

  if (isOpen && !isSecretOk && looksSecret(value)) {
    await update($, editing, (): Editing => ({ id, field: 'answer', held: value }))
    return
  }

  await respond($, id, { state: 'done', answer: value }, how, value)
}

async function startEditing($: EngineInterface, id: number, field: Editing['field']) {
  // Pressed on a drawing from before its task closed, it leaves the pane as it is.
  if (!(await isOpenNow($, id))) {
    return
  }

  const key = fieldKeyOf({ id, field })

  forget(key)
  // The field takes the ring as it opens: by the move below, or by its
  // autoFocus, whose `ui.focus` reaches none of this plugin's hooks.
  live.ring = key
  await update($, selectedId, () => id)
  await update($, editing, (): Editing => ({ id, field }))
  await fit($)

  // A field the pane can't focus (it doesn't hold the keyboard) is still a click away.
  if (await hasSurface($)) {
    void $.ui.focus({ requestId: PANE, key }).then(undefined, () => undefined)
  }
}

/** Has every surface draw the field keyed `key` afresh, with its draft. */
function forget(key: string) {
  for (const drawn of live.drawn.values()) {
    drawn.delete(key)
  }
}

async function stopEditing($: EngineInterface) {
  await update($, editing, () => null)
  await fit($)
}

/**
 * Archives open task `id` (`isArchiving`) or restores archived task `id`:
 * it leaves the open lists, or comes back to them as it was. Nothing is sent
 * to Claude either way: no update is marked pending, and no send, message or
 * turn starts; the asking session's `list_tasks` shows it archived when Claude
 * asks. With `ref` (the answer endpoint), as `edit` takes one: only that task,
 * at that version, while the judging session goes on. Resolves the task as
 * the change found it, and the time it judged it at; one not in the state
 * the press expects (or archived over 7 days ago, to restore) stays as it is.
 */
async function shelve($: EngineInterface, id: number, isArchiving: boolean, ref?: Judged): Promise<{ found: Task | undefined; nowMs: number }> {
  const nowMs = await $.clock.now()
  let found: Task | undefined

  await change($, list => {
    const isJudgingSession = ref === undefined || live.ends === ref.ends
    found = isJudgingSession ? list.find(task => task.id === id && (ref === undefined || task.createdMs === ref.createdMs)) : undefined
    const isReady = found !== undefined && isShelvable(found, isArchiving, nowMs, ref)

    return isReady ? list.map(task => (task === found ? shelved(task, isArchiving, nowMs) : task)) : list
  })

  return { found, nowMs }
}

/** `task` archived at `nowMs`, or restored: every other field as it was. */
function shelved(task: Task, isArchiving: boolean, nowMs: number): Task {
  if (isArchiving) {
    return { ...task, archivedMs: nowMs, updatedMs: nowMs }
  }

  const { archivedMs: _archived, ...rest } = task

  return { ...rest, updatedMs: nowMs }
}

/** Archive pressed in the pane: the task leaves the open list, its field and draft with it, and a toast says how to undo it. */
async function archiveTask($: EngineInterface, id: number) {
  const { found: was } = await shelve($, id, true)

  if (was === undefined || !isActive(was)) {
    $.ui.toast(`Task #${id} isn't open any more, so it wasn't archived.`, { timeoutMs: 8000 })
    return
  }

  await settle($, id)
  const archived = (await read($, tasks)).find(task => task.id === id && isArchived(task))
  const until = archived === undefined ? '' : ` until ${deletionDayOf(archived)}`

  $.ui.toast(`Archived #${id}. Nothing was sent to Claude. Restore it from Archived in /my-tasks${until}.`, { timeoutMs: 8000 })
}

/** Restore pressed: the task is back in the open list as it was, and Claude is told nothing. */
async function restoreTask($: EngineInterface, id: number) {
  const { found: was, nowMs } = await shelve($, id, false)

  if (was === undefined || !isShelvable(was, false, nowMs)) {
    $.ui.toast(`Task #${id} isn't archived any more.`, { timeoutMs: 8000 })
    return
  }

  await reselect($)
  await fit($)
}

/** Opens or closes the pane's Archived section. */
async function toggleArchive($: EngineInterface) {
  live.isArchiveOpen = !live.isArchiveOpen
  // Nothing in the state changed: a write of the selection, as it stands, draws the pane again.
  await update($, selectedId, chosen => chosen)
  await fit($)
}

/** The archived tasks the pane and /my-tasks list: those not yet due for deletion, oldest archive first. */
async function archivedNow($: EngineInterface): Promise<Task[]> {
  return archivedIn(await read($, tasks), await $.clock.now())
}

/** The archived tasks of `list` not yet due for deletion at `nowMs`, oldest archive first. */
function archivedIn(list: readonly Task[], nowMs: number): Task[] {
  return list.filter(task => isArchived(task) && !isExpired(task, nowMs)).sort((a, b) => (a.archivedMs ?? 0) - (b.archivedMs ?? 0))
}

/** Moves a long answer into the prompt box, where the real editor takes pastes and lines. */
async function longAnswer($: EngineInterface, id: number) {
  // Pressed on a drawing from before its task closed, it answers as Save for
  // later would: the task isn't open any more.
  if (!(await isOpenNow($, id))) {
    return answerTyped($, id, 'later')
  }

  const key = fieldKeyOf({ id, field: 'answer' })
  const box = await $.prompt.read()
  const draft = live.drafts.get(key) ?? ''
  const text = bridgeOf(id) + [draft, box.text].filter(part => part.trim() !== '').join('\n')
  const filled = await $.prompt.fill({ text, mode: 'replace' })

  if (!filled.isFilled) {
    $.ui.toast("Couldn't open the prompt box for your answer; type it here instead.")
    return
  }

  live.drafts.delete(key)
  await update($, editing, () => null)
  $.ui.toast('Write your answer in the prompt box (Esc gets you there), then press Enter.', {
    timeoutMs: 8000,
  })
}

function sendNow($: EngineInterface) {
  live.batch?.cancel()
  live.batch = null
  void send($)
}

function sendSoon($: EngineInterface) {
  live.batch?.cancel()
  live.batch = $.clock.after(BATCH_MS, () => {
    live.batch = null
    void send($)
  })
}

/**
 * Hands Claude every update it has not heard: a turn of its own while it is
 * idle, a row its running turn reads at the next step while it works.
 * `isTurnOver`: sent as main's turn ends, when Claude is idle whatever the
 * engine's last word on it was.
 */
async function send($: EngineInterface, isTurnOver = false) {
  // What the process holds is the folder's it leaves: its Claude hears it there.
  if (live.moving > 0) {
    return
  }

  await wake($)
  const due = await claim($)

  if (due.length === 0) {
    return
  }

  const text = messageOf(due)
  const ids = due.map(task => task.id)
  const which = numbersOf(ids)

  if (isTurnOver || !working()) {
    await passOn($, due, inWords, 'why', () => $.prompt.submit({ text, asUser: true })).catch(() => undefined)
    return
  }

  const isTaken = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).then(
    appended => appended.deny === undefined,
    () => false,
  )

  if (!isTaken) {
    await undelivered($, ids)

    // The turn ended while the row was being refused: they go now.
    if (!working()) {
      void send($, true)
      return
    }

    live.isSendingAtEnd = true
    $.ui.toast(`Claude gets your response to ${which} when it finishes this turn.`)
    return
  }

  live.isUnread = true

  try {
    await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: `Sent your response to ${which} to Claude` }] } })
  } catch {
    // The notice is for the user's eyes only; Claude has the answer either way.
  }
}

/**
 * Keeps the answer endpoint's listener running for the session, while the
 * setting is on and the session joined as `ends` has not ended: starts it,
 * or starts it again when it ended or is another session's (after /clear).
 */
async function keepEndpoint($: EngineInterface, ends: number) {
  if (!isEndpointOn) {
    return
  }

  try {
    const sessionId = await $.session.id()
    const running = live.endpoint

    if (live.ends !== ends || !isListenable(sessionId) || (running?.sessionId === sessionId && running.isRunning())) {
      return
    }

    // One that ended before it was ready could not start: the person is told
    // once, with what it printed, and it is tried again after 0, 1, 3, 7...
    // heartbeats, at most once an hour.
    // TODO(deferred): #138 the back-off count is never reset by a listener that started; the listener remembers a gone answer
    const failure = running?.failure()

    if (failure !== undefined) {
      live.endpoint = null
      live.endpointFailures += 1
      live.endpointSkips = Math.min(2 ** (live.endpointFailures - 1) - 1, 59)

      live.endpointFailure = failure

      if (live.endpointFailures === 1) {
        $.ui.toast(`The answer endpoint could not start: ${failure}`, { timeoutMs: 8000 })
      }
    } else if (running !== null) {
      live.endpointFailures = 0
    }

    if (live.endpointSkips > 0) {
      live.endpointSkips -= 1
      return
    }

    void running?.stop()
    live.endpoint = startEndpoint(
      $,
      sessionId,
      request => answerFromEndpoint($, request),
      () => {
        if (live.endpoint?.isReady() === true) {
          live.endpointFailure = undefined
        }

        syncDashboard($)
      },
    )
  } catch {
    // No listener now: the next heartbeat tries again.
  }
}

/**
 * An answer that came through the endpoint, applied as a press in the pane
 * would apply it (`resolve`, `auto`), so Claude hears it the same way; it
 * never touches the pane's fields, toasts or the prompt box. One decision-log
 * line says what came of it, never what it said.
 */
async function answerFromEndpoint($: EngineInterface, request: Request): Promise<Answered> {
  const answered = await judge($, request)

  void audit($, 'answer', `${request.action} on task #${request.taskId} from the ${request.source}: ${answered.outcome}`, {
    id: request.taskId,
    created_ms: request.createdMs,
    action: request.action,
    outcome: answered.outcome,
    source: request.source,
  })

  return answered
}

/**
 * Archive or Restore from the endpoint (the dashboard), as the pane's press
 * does it (`shelve`): nothing is sent to Claude. The version and the state
 * are checked inside the change, so a press or an answer landing meanwhile
 * wins; an archived task's field and draft go with it, unless the judging
 * session has ended (they may be the next session's).
 */
async function shelveFromEndpoint($: EngineInterface, task: Task, isArchiving: boolean, ref: Judged, sessionId: string): Promise<Answered> {
  const { found: was, nowMs } = await shelve($, task.id, isArchiving, ref)

  if (was === undefined) {
    return live.ends === ref.ends ? { outcome: 'unknown', message: `This session holds no task #${ref.id} assigned at that created_ms.` } : GONE
  }

  const refusal = shelfRefusalOf(was, ref, isArchiving, sessionId, nowMs)

  if (refusal !== undefined) {
    return refusal
  }

  if (live.ends === ref.ends) {
    await (isArchiving ? settle($, task.id, ref.ends) : reselect($))
  }

  const isRef = (one: Task) => one.id === ref.id && one.createdMs === ref.createdMs

  return { outcome: 'accepted', task: infoOf((await read($, tasks)).find(isRef) ?? was, sessionId) }
}

/** What a request still under way as its session ended is told. */
const GONE: Answered = { outcome: 'gone', message: 'The session has ended.' }

/**
 * Archive or Restore, through this live session's endpoint, of a task an
 * ended session in its project holds (the dashboard sends it here): the
 * session takes that slot on (`takeOver`), then archives or restores the
 * task as it would its own. Nothing is sent to Claude in either session.
 */
async function shelveEnded($: EngineInterface, isArchiving: boolean, ref: Judged, sessionId: string): Promise<Answered> {
  const isRef = (task: Task) => task.id === ref.id && task.createdMs === ref.createdMs
  // Judged as `shelve` judges it, at the time its slot is read: a stale or closed one is refused, and its slot left as it is.
  const taken = await takeOver($, isRef, (task, nowMs) => isShelvable(task, isArchiving, nowMs, ref), ref.ends)

  if (live.ends !== ref.ends) {
    return GONE
  }

  if ('found' in taken) {
    return shelfRefusalOf(taken.found, ref, isArchiving, sessionId, taken.nowMs) ?? { outcome: 'busy', message: 'Send the same request again in a moment.' }
  }

  if ('refusal' in taken) {
    return taken.refusal === 'pending'
      ? { outcome: 'refused', message: `Task #${ref.id} is held by an ended session with answers Claude has not heard yet: it waits for the next session in this project.` }
      : taken.refusal === 'busy'
        ? { outcome: 'busy', message: 'The session is still joining its project; send the same request again in a moment.' }
        : taken.refusal === 'several'
          ? { outcome: 'refused', message: `More than one ended session in this project holds task #${ref.id} assigned at that created_ms: it waits for the next session to start in this project.` }
          : { outcome: 'unknown', message: `Neither this session nor an ended one in its project holds task #${ref.id} assigned at that created_ms.` }
  }

  return shelveFromEndpoint($, taken.task, isArchiving, { ...ref, id: taken.task.id }, sessionId)
}

/** What taking an ended session's task on came to: the task as this session holds it now, or why nothing was taken. */
type TakenOver = { task: Task } | { found: Task; nowMs: number } | { refusal: 'none' | 'several' | 'pending' | 'busy' }

/**
 * Takes on, for this live session, the one ended session's slot in the
 * project that holds the task `isWanted` names, as joining takes an ended
 * session's slot on (`adopt`, from it alone): its tasks join this session's,
 * one whose number is taken here numbered anew, its note of what it took
 * kept in this session's slot, and the ended slot removed once that is
 * written. The store work runs in the session's queue; a session writes only
 * its own slot. The rest of the project waits for the next session to start.
 *
 * Nothing is taken on when no ended slot, or more than one, holds such a
 * task (`none`, `several`); when it is not `isReady` (resolved as `found`,
 * for the caller's refusal); or when the slot holds an answer Claude has not
 * heard (`pending`): taken on, it would reach this session's Claude, and an
 * Archive or Restore sends Claude nothing. Nor once the session that asked
 * (`ends`) has ended, or before it has read its project (`busy`).
 */
async function takeOver($: EngineInterface, isWanted: (task: Task) => boolean, isReady: (task: Task, nowMs: number) => boolean, ends: number): Promise<TakenOver> {
  return queued(async (): Promise<TakenOver> => {
    if (live.ends !== ends || live.endedMs !== undefined || !(await isLoaded($))) {
      return { refusal: 'busy' }
    }

    const nowMs = await $.clock.now()
    const stored = await readProject($)
    const own = live.sessionId
    const holding = Object.entries(stored.all)
      .filter(([id, slot]) => id !== own && slot.endedMs !== undefined)
      .flatMap(([id, slot]) => slot.tasks.filter(task => isKept(task, nowMs) && !isTakenFrom(stored, id, task) && isWanted(task)).map(task => ({ from: id, wanted: task })))

    if (holding.length !== 1) {
      return { refusal: holding.length === 0 ? 'none' : 'several' }
    }

    const { from, wanted } = holding[0]!

    if (!isReady(wanted, nowMs)) {
      return { found: wanted, nowMs }
    }

    if (stored.all[from]!.tasks.some(task => task.update === 'pending' && !isTakenFrom(stored, from, task))) {
      return { refusal: 'pending' }
    }

    const notes = await read($, took)
    const count = await read($, nextId)
    let project = stored
    let adoption!: Adoption
    let arrived: number[] = []

    // As `load` does it, against the task list as it stands when it changes:
    // what the session holds stays, its own done tasks with it, numbers kept.
    await update($, tasks, current => {
      const rest = current.filter(task => !isKept(task, nowMs) && !isExpired(task, nowMs))
      project = withSlots(stored, { [own]: slotFrom(current, notes, count, nowMs) })
      adoption = adopt(project, own, nowMs, rest.map(task => task.id), false, null, from)
      arrived = adoption.adopted.filter(task => !current.some(one => isSameTask(one, task))).map(task => task.id)

      return [...rest, ...adoption.adopted].sort((a, b) => a.id - b.id)
    })

    await renumber($, [], arrived)
    await update($, nextId, n => Math.max(n, adoption.nextId))
    await update($, took, () => adoption.took)
    live.readMs = nowMs
    live.elsewhere = elsewhereIn(project, own, nowMs)
    live.floor = Math.max(live.floor, adoption.nextId)

    try {
      // The slot first, noting what it took: only then does the ended slot leave.
      await writeOwn($, true)
      await clean($, project, adoption.removed, adoption.legacy)
    } catch {
      // What it took on stands: the next heartbeat makes the writes.
    }

    const id = adoption.renumbered.find(({ task }) => isSameTask(task, wanted))?.id ?? wanted.id
    const task = (await read($, tasks)).find(one => one.id === id && one.createdMs === wanted.createdMs)

    return task === undefined ? { refusal: 'none' } : { task }
  }).then(async taken => {
    if ('task' in taken) {
      await refresh($)
    }

    return taken
  })
}

/**
 * The waits an endpoint request makes from its arrival to its task change,
 * in order, each with the engine call it waits on. A test holds a request at
 * each in turn as /clear, an exit, a resume in place or a resume of another
 * conversation completes: it is told `gone`, and changes none of the next
 * session's tasks, fields or drafts (`judge`, `edit`, `resolve`). Another
 * test traces the clock, state, store, file, session and process calls a
 * request makes on that path, and fails unless they are these: a wait added
 * on any such call fails it until it is listed here. A wait on no engine
 * call (`await Promise.resolve()`) is not seen by that test. The waits after
 * the task change, through the pane cleanup, are in the tests' own list.
 * An Archive or Restore of an ended session's task (`shelveEnded`) takes
 * another path, outside this list and its trace: its store work runs in the
 * session's queue, which a join after /clear waits behind, and it is told
 * `gone` once the session has ended (a test holds it across /clear).
 */
export const ENDPOINT_WAITS = [
  // `wake`: how old the slot is (one two heartbeats old reads the project, inside this same wait).
  { wait: 'wake', call: 'clock.now' },
  // `isLoaded`: whether the session has read its project yet.
  { wait: 'loaded', call: 'state.get loadedFor' },
  // The task list the request is judged against.
  { wait: 'tasks', call: 'state.get tasks' },
  // `edit`: the time the change carries.
  { wait: 'now', call: 'clock.now' },
  // `change`: its own `wake`.
  { wait: 'change', call: 'clock.now' },
  // `update`: its read, just before the change itself.
  { wait: 'update', call: 'state.get tasks' },
] as const

async function judge($: EngineInterface, request: Request): Promise<Answered> {
  if (live.moving > 0) {
    return { outcome: 'busy', message: 'The session is moving to another folder; send the same request again in a moment.' }
  }

  // The listener is this session's and still running (an ended one's
  // requests are told it is gone before they get here), so the session is
  // still joining its project after /clear: the store is slow.
  if (live.endedMs !== undefined || request.sessionId !== live.sessionId) {
    return { outcome: 'busy', message: 'The session is still joining its project; send the same request again in a moment.' }
  }

  // The session judging it, counted before the first wait: once it ends
  // (/clear, an exit, a resume), what is still under way here changes none of
  // the next session's tasks, fields or drafts, and is told it is gone, both
  // after the waits that judge it (ENDPOINT_WAITS) and inside the change
  // itself (see `edit`).
  const ref: Judged = { id: request.taskId, createdMs: request.createdMs, version: request.version, ends: live.ends }
  await wake($)

  // Joined but its project not read yet (the store slow at a start or a
  // resume): the tasks the process holds are not this session's yet.
  if (!(await isLoaded($))) {
    return live.ends !== ref.ends ? GONE : { outcome: 'busy', message: 'The session is still joining its project; send the same request again in a moment.' }
  }

  const isRef = (task: Task) => task.id === ref.id && task.createdMs === ref.createdMs
  const task = (await read($, tasks)).find(isRef)

  // Ended during `wake`, the check or the read: what was read may be the next session's.
  if (live.ends !== ref.ends) {
    return GONE
  }

  if (task === undefined) {
    // Archive or Restore of an ended session's task in this project: the
    // dashboard sends it here, the live session, which takes that slot on.
    return isShelfAction(request.action)
      ? shelveEnded($, request.action === 'archive', ref, request.sessionId)
      : { outcome: 'unknown', message: `This session holds no task #${ref.id} assigned at that created_ms.` }
  }

  if (isShelfAction(request.action)) {
    return shelveFromEndpoint($, task, request.action === 'archive', ref, request.sessionId)
  }

  const before = refusalOf(task, ref, request.sessionId)

  if (before !== undefined) {
    return before
  }

  const patch = patchOf(task, request)

  if ('refusal' in patch) {
    return { outcome: 'refused', message: patch.refusal, task: infoOf(task, request.sessionId) }
  }

  // The version and the open check again, inside the change itself: a press
  // in the pane, another answer or a withdraw landing meanwhile wins.
  const was = await resolve($, task.id, patch, 'auto', ref)

  if (was === undefined) {
    return live.ends === ref.ends ? { outcome: 'unknown', message: `This session holds no task #${ref.id} assigned at that created_ms.` } : GONE
  }

  return refusalOf(was, ref, request.sessionId) ?? { outcome: 'accepted', task: infoOf((await read($, tasks)).find(isRef) ?? was, request.sessionId) }
}
