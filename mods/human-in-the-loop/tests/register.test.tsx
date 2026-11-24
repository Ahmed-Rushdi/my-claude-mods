import type { On, PaneOpenArgs, PromptSubmitInput } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted, Plugin, TestOptions } from 'claude-code/testing'

import { digestOf, isAt, refusalOf, requestOf } from '../hooks/endpoint'
import type { Request } from '../hooks/endpoint'
import { fieldRowsOf, rowsFor } from '../hooks/pane'
import { keysOf, projectOf } from '../hooks/project'
import { ARCHIVE_KEEP_MS } from '../hooks/tasks'
import { ENDPOINT_WAITS } from '../hooks/register'
import { cellsOf, rowsOf, wrapRows } from '../hooks/text'

const ASSIGN = 'mcp__human-in-the-loop__assign_task'
const LIST = 'mcp__human-in-the-loop__list_tasks'
const WITHDRAW = 'mcp__human-in-the-loop__withdraw_task'

const PANE = {
  plugin: 'human-in-the-loop',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'my-tasks',
  props: {
    title: 'My tasks',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const DONE = {
  answer: 'Done.',
  durationMs: 1000,
  isAborted: false,
  reason: 'answer',
  category: null,
  explanation: null,
} as const

const KEY_TASK = {
  tool: ASSIGN,
  title: 'Add STRIPE_SECRET_KEY to .env',
  why: "The webhook test can't run without it.",
  done_when: "It's in .env. Don't paste it here.",
  kind: 'do',
} as const

const XCODE_TASK = {
  tool: ASSIGN,
  title: 'Run xcodebuild test on your Mac, paste the failures',
  why: "I can't run Xcode here.",
  kind: 'answer',
} as const

const PAGING_TASK = {
  tool: ASSIGN,
  title: 'Pick a pagination strategy for /feed',
  why: 'I lean towards cursor: the feed is append-only.',
  kind: 'choose',
  options: ['Cursor', 'Offset, capped at 10k'],
} as const

const NOW = 1_000_000
/** A clock a month on from NOW: an archive time 7 days before it is still a time (archive times start at 0). */
const LATE = NOW + 30 * 24 * 60 * 60_000

/** Has the shape of a Stripe key, which `looksSecret` holds; built here, so no file carries one. */
const KEY_SHAPED = `sk_live_${'0'.repeat(24)}`

/** A task an earlier or another session assigned. */
const ROTATE = {
  id: 7,
  title: 'Rotate the leaked token in Vault',
  why: 'It was in a public gist.',
  kind: 'do',
  state: 'open',
  update: 'none',
  sessionId: 'session-0',
  createdMs: 0,
  updatedMs: 0,
} as const

// Plugin-owned UI events need explicit wildcard matchers in the host/race fixtures (#130).
/**
 * Seats the engine beneath the plugin: a session, a store, a clock, panes
 * and a status line, and the calls the plugin makes to Claude, kept in
 * `world`. `isNarrow` makes a pane opened unasked wait, as a narrow
 * terminal does.
 */
function seat(on: On, store: Record<string, unknown> = {}, now = NOW) {
  const world = {
    submitted: [] as string[],
    appended: [] as { type: string; text: string }[],
    toasts: [] as string[],
    /** The tools the plugin registered, as it described them to Claude. */
    registered: [] as { name: string; description: string; inputSchema: unknown }[],
    /** The slash commands the plugin registered, by name. */
    commands: [] as string[],
    opens: [] as PaneOpenArgs[],
    /** The pane ids `ui.focus` was asked to focus. */
    focuses: [] as string[],
    isPaneOpen: false,
    /** What `$.session.surfaces()` answers: none under the SDK. */
    surfaces: ['terminal'] as string[],
    isNarrow: false,
    status: undefined as string | undefined,
    composer: '',
    /** Set, the plugin's prompts don't enter: a hook beneath drops them with this reason. */
    refusing: undefined as string | undefined,
    /** Set, the user's typed prompts don't enter: a hook beneath (a settings hook, say) drops them with this reason. */
    refusingTyped: undefined as string | undefined,
    /** Set, the plugin's own rows don't enter the conversation: a hook beneath refuses them with this reason. */
    refusingRows: undefined as string | undefined,
    sessionId: 'session-1',
    root: '/repo',
    store: JSON.parse(JSON.stringify(store)) as Record<string, unknown>,
    /** Set, runs once just before the plugin's next store write: another session's write landing meanwhile. */
    landing: undefined as (() => void) | undefined,
    /** Every store call the plugin makes, in order: `get <key>`, `set <key>`, `delete <key>` or `keys`. */
    ops: [] as string[],
    /** Set, the plugin's store calls fail: its file locked too long, or out of reach. */
    isStoreFailing: false,
    /** How many of the plugin's next store calls fail, as a store failing a moment does. */
    failing: 0,
    /** Set, the plugin's store writes fail and its reads go on: a disk full, say. */
    isWriteFailing: false,
    /** Set, the store's next keys() doesn't answer until `unstick`: a store stuck on a slow disk. */
    isStuck: false,
    unstick: undefined as (() => void) | undefined,
    /** How long the plugin's store writes take. */
    setMs: 0,
    /** Set, the plugin's next read of this value of its state, past `fastReads` more, answers `readMs` late, with the value as it stood when asked. */
    slowRead: undefined as string | undefined,
    fastReads: 0,
    readMs: 0,
    /** Set, a hook beneath takes the context out of the user's typed prompts. */
    isStripping: false,
    /** Set, a hook beneath rewrites the user's typed prompts and their context with it (masks a secret, say). */
    rewriting: undefined as ((text: string) => string) | undefined,
    /** Set, a hook beneath rewrites every prompt, the plugin's own among them, and their context with it. */
    masking: undefined as ((text: string) => string) | undefined,
    /** Set, the user's typed prompts fail beneath: nothing there answers them, and the engine rejects them. */
    isTypedFailing: false,
    /** How long the plugin's own rows take to join the conversation. */
    appendMs: 0,
    /** How long the surface takes to open a pane. */
    openMs: 0,
    /** How long the surface takes to say which panes are open: it says so as they were when asked. */
    panesMs: 0,
    /** How long the engine takes to attach a client once the plugin's hooks have seen it. */
    attachMs: 0,
    /** Set, the engine can't list the plugin's panes. */
    isPanesFailing: false,
    /** How many times the plugin asked which of its panes are open. */
    panesAsked: 0,
    /** How many times the plugin read its task list. */
    tasksRead: 0,
    /**
     * Set, runs as each of the plugin's clock reads (`clock.now`) and state reads (`state.get <key>`) is answered, before the plugin has the answer: a test traces them, or holds one.
     * It also runs as each of the plugin's store, file, session and process calls is made, by its event's name (`store.get`, `fs.exists`, `session.id`, `process.run`...): traced, never held.
     */
    onCall: undefined as ((call: string) => Promise<void> | void) | undefined,
  }

  // Registered first, so outermost: they see every such call before the handlers below answer it.
  on('store.*', ($, e, next) => {
    void world.onCall?.(next.event)
    return next(e)
  })
  on('fs.*', ($, e, next) => {
    void world.onCall?.(next.event)
    return next(e)
  })
  on('session.*', ($, e, next) => {
    void world.onCall?.(next.event)
    return next(e)
  })
  on('process.*', ($, e, next) => {
    void world.onCall?.(next.event)
    return next(e)
  })

  const clock = mock.clock(answeringNowThrough(on, world), { now })
  // The plugin's own store, kept where a test can read it. Its keys run to
  // 256 characters, as the engine's do; a refusal rejects the plugin's call.
  const refused = (op: string, key?: string) => {
    world.ops.push(key === undefined ? op : `${op} ${key}`)
    const isFailing = world.failing > 0
    world.failing -= isFailing ? 1 : 0

    if (world.isStoreFailing || isFailing || (world.isWriteFailing && (op === 'set' || op === 'delete'))) {
      return { deny: 'The store is locked.' }
    }

    return key !== undefined && key.length > 256 ? { deny: `Store keys run to 256 characters; this one has ${key.length}.` } : undefined
  }
  on('store.get', ($, e) => refused('get', e.key) ?? { value: world.store[e.key] })
  on('store.set', async ($, e) => {
    const refusal = refused('set', e.key)

    if (refusal !== undefined) {
      return refusal
    }

    if (world.setMs > 0) {
      await clock.sleep(world.setMs)
    }

    const landing = world.landing
    world.landing = undefined
    landing?.()
    world.store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    const refusal = refused('delete', e.key)

    if (refusal !== undefined) {
      return refusal
    }

    delete world.store[e.key]
    return { value: undefined }
  })
  on('store.keys', () => {
    if (world.isStuck) {
      world.isStuck = false
      return new Promise<{ value: string[] }>(resolve => {
        world.unstick = () => resolve({ value: Object.keys(world.store) })
      })
    }

    return refused('keys') ?? { value: Object.keys(world.store) }
  })

  on('state.get', { plugin: 'human-in-the-loop' }, async ($, e, next) => {
    const read = await next(e)
    world.tasksRead += e.key === 'tasks' ? 1 : 0

    if (e.key === world.slowRead && world.fastReads > 0) {
      world.fastReads -= 1
    } else if (e.key === world.slowRead) {
      world.slowRead = undefined
      await clock.sleep(world.readMs)
    }

    if (world.onCall !== undefined) {
      await world.onCall(`state.get ${e.key}`)
    }

    return read
  })

  on('session.id', () => ({ value: world.sessionId }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.attach', async ($, e) => {
    if (world.attachMs > 0) {
      await clock.sleep(world.attachMs)
    }

    return { clientId: e.clientId }
  })
  on('session.detach', ($, e) => ({ clientId: e.clientId }))
  on('session.surfaces', () => ({ value: world.surfaces as never }))
  on('session.root', () => ({ value: world.root }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', ($, e) => {
    world.registered.push(e as unknown as { name: string; description: string; inputSchema: unknown })
    return { value: { tool: `mcp__human-in-the-loop__${e.name}` } }
  })
  on('command.register', ($, e) => {
    world.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    world.status = e.text
    return { value: undefined }
  })
  on('ui.open', async ($, e) => {
    if (world.openMs > 0) {
      await clock.sleep(world.openMs)
    }

    world.opens.push(e)
    world.isPaneOpen = true
    const isPlaced = e.focus === true || !world.isNarrow
    return { value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'narrow terminal' } }
  })
  on('ui.close', () => {
    world.isPaneOpen = false
    return { value: undefined }
  })
  on('ui.panes', async () => {
    world.panesAsked += 1

    if (world.isPanesFailing) {
      return { deny: 'The surface is busy.' }
    }

    const value = world.isPaneOpen ? [{ id: 'my-tasks', title: 'My tasks', isShown: true, isFocused: true, isPlaced: !world.isNarrow }] : []

    if (world.panesMs > 0) {
      await clock.sleep(world.panesMs)
    }

    return { value }
  })
  on('ui.focus', { plugin: '*' }, (_$, e) => {
    world.focuses.push(e.requestId)

    return {}
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => {
    if (e.origin.kind === 'plugin' && world.refusing !== undefined) {
      return { drop: world.refusing }
    }

    if (e.origin.kind === 'composer' && world.refusingTyped !== undefined) {
      return { drop: world.refusingTyped }
    }

    if (e.origin.kind === 'composer' && world.isTypedFailing) {
      // A hook that throws is skipped; with none beneath it, the engine rejects the prompt.
      throw new Error('The prompt hook timed out.')
    }

    if (e.origin.kind === 'composer' && world.isStripping) {
      return { text: e.text }
    }

    if (e.origin.kind === 'plugin') {
      world.submitted.push(e.text)
    }

    const rewrite = (e.origin.kind === 'composer' ? world.rewriting : undefined) ?? world.masking

    if (rewrite !== undefined) {
      return { text: rewrite(e.text), ...(e.context === undefined ? {} : { context: e.context.map(rewrite) }) }
    }

    return { text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }
  })
  on('session.append', async ($, e, next) => {
    if (e.door === 'note' && world.appendMs > 0) {
      await clock.sleep(world.appendMs)
    }

    // Only a plugin's own row may be refused; any other must go on with next.
    if (e.door === 'note' && world.refusingRows !== undefined) {
      return { deny: world.refusingRows }
    }

    const block = e.message.content[0] as { text?: string } | undefined
    world.appended.push({ type: e.message.type, text: block?.text ?? '' })

    return next(e)
  })
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('prompt.read', () => ({ value: { text: world.composer, cursor: world.composer.length } }))
  on('prompt.fill', ($, e) => {
    world.composer = e.mode === 'append' ? world.composer + e.text : e.text
    return { isFilled: true, text: world.composer, cursor: world.composer.length }
  })

  return { world, clock }
}

/**
 * `on`, with the handler the mock clock registers for `clock.now` answering
 * through `world.onCall` when that is set (a test cannot register a second
 * `clock.now` hook); unset, the handler is the clock's own, as it was.
 */
function answeringNowThrough(on: On, world: { onCall?: ((call: string) => Promise<void> | void) | undefined }): On {
  const register = on as unknown as (...args: unknown[]) => unknown

  return ((name: string, ...rest: unknown[]) => {
    const handler = rest.at(-1)

    if (name !== 'clock.now' || typeof handler !== 'function') {
      return register(name, ...rest)
    }

    return register(name, ...rest.slice(0, -1), (...args: unknown[]) => {
      const onCall = world.onCall

      if (onCall === undefined) {
        return handler(...args)
      }

      return (async () => {
        const value: unknown = await handler(...args)
        await onCall('clock.now')
        return value
      })()
    })
  }) as unknown as On
}

async function start($: Engine) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
}

async function startHeadless($: Engine, world: { surfaces: string[] }) {
  world.surfaces = []
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
}

function typed(text: string, turnId?: string): PromptSubmitInput {
  return { text, wait: false, origin: { kind: 'composer' }, ...(turnId === undefined ? {} : { turnId }) }
}

async function runTasks($: Engine) {
  return $.command.run({
    command: 'my-tasks',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
}

/**
 * Set, holds the next press short of its button until `letGo`: a press from
 * a drawing a write has changed since, before the drawing it wakes lands.
 */
function holdingPresses(on: On) {
  const held = { isOn: false, letGo: () => {} }

  on('ui.press', { plugin: '*' }, async ($, e, next) => {
    if (held.isOn) {
      held.isOn = false
      await new Promise<void>(resolve => {
        held.letGo = resolve
      })
    }

    return next(e)
  })

  return held
}

type Drawn = Pick<Mounted<'terminal', 'Pane'>, 'find'>

async function textOf(ui: Drawn, key: string): Promise<string> {
  return (await ui.find({ key }))?.text ?? ''
}

describe('assigning', () => {
  test('a task opens the Tasks pane, with its why and its buttons, and the status line counts it', async ($, on) => {
    const { world } = seat(on)
    await start($)

    const assigned = await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)

    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #1')
    expect(world.opens.at(-1)?.id).toBe('my-tasks')
    expect(world.opens.at(-1)?.focus).toBeUndefined()
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(await textOf(ui, 'head')).toContain('1 task for you')
    expect(await textOf(ui, 'task-1')).toContain("The webhook test can't run without it.")
    expect(await textOf(ui, 'task-1')).toContain('Done when:')
    expect(await textOf(ui, 'actions')).toContain('Done')
    expect(await textOf(ui, 'actions')).not.toContain('Accept')
    expect(world.toasts).toHaveLength(0)
  })

  test('where the pane cannot be seated unasked, a toast points at /my-tasks', async ($, on) => {
    const { world } = seat(on)
    world.isNarrow = true
    await start($)

    await $.tool.call(KEY_TASK)

    expect(world.toasts[0]).toBe('Claude assigned you a task: Add STRIPE_SECRET_KEY to .env. See /my-tasks')
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })

  test('the same ask twice is one task, and a sixth open task is refused', async ($, on) => {
    seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    const again = await $.tool.call({ ...KEY_TASK, title: 'add stripe_secret_key to .env!' })
    expect(String((again as { result?: unknown }).result)).toContain('Task #1 already asks')

    for (const n of [2, 3, 4, 5]) {
      await $.tool.call({ ...KEY_TASK, title: `Do thing number ${n}` })
    }

    const sixth = await $.tool.call({ ...KEY_TASK, title: 'One task too many' })
    expect((sixth as { deny?: string }).deny).toContain('already has 5 open tasks')
  })

  test("the tools stay in the prompt's list, where the engine puts an MCP tool behind ToolSearch", async ($, on) => {
    seat(on)
    on('tool.describe', ($, e) => ({ description: e.description, isDeferred: true }))
    await start($)

    for (const tool of [ASSIGN, LIST, WITHDRAW]) {
      const described = await $.tool.describe({ tool, description: 'From the server.', isDeferred: true, provider: { plugin: 'human-in-the-loop', tier: 'user' } })

      expect(described).toEqual({ description: 'From the server.', isDeferred: false })
    }
  })

  test('a subagent cannot assign tasks', async ($, on) => {
    seat(on)
    await start($)

    const call = { ...KEY_TASK, agentId: 'agent-1' } as unknown as Parameters<Engine['tool']['call']>[0]
    const refused = await $.tool.call(call)

    expect((refused as { deny?: string }).deny).toContain('Only the main agent')
  })

  test('a withdrawn task leaves: the pane closes and the status line clears', async ($, on) => {
    const { world } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call({ tool: WITHDRAW, id: 1, reason: 'Found the key in the vault' })

    expect(world.isPaneOpen).toBe(false)
    expect(world.status).toBeUndefined()
    expect(world.toasts.at(-1)).toBe('Claude withdrew the task: Add STRIPE_SECRET_KEY to .env. Found the key in the vault')
  })
})

/**
 * Two tasks with titles near the 80 characters a title may have, as an
 * earlier session left them. The live check (tests/live/test_pane.py) draws
 * them in a real Claude Code; the row counts here are what it drew.
 */
const INSTRUMENTS = {
  ...ROTATE,
  id: 1,
  title: 'Open Instruments from Xcode and record with the Activity Monitor template',
  why: 'I need a trace of the launch to see where the 4 seconds go.',
  doneWhen: 'The .trace file is in ~/traces.',
  createdMs: NOW - 180_000,
} as const

const XCODE_LONG = {
  ...ROTATE,
  id: 2,
  title: 'Run xcodebuild test on your Mac and paste every failure you see here please',
  why: "I can't run Xcode here.",
  kind: 'answer',
  createdMs: NOW - 180_000,
} as const

/** The pane seated inline above the prompt, `bodyColumns` across. */
function inline(bodyColumns: number) {
  return { ...PANE, props: { ...PANE.props, placement: 'inline', bodyColumns } } as const
}

function earlier(tasks: readonly unknown[]) {
  return { 'tasks:/repo': { nextId: 3, sessions: { 'session-0': { tasks, seenMs: 0, endedMs: 0 } } } }
}

describe('long titles', () => {
  test('wrap as the terminal wraps them: at spaces, a word wider than the row broken where it ends', () => {
    expect(wrapRows(' a b c d e f g h i j k l m n o p q r s t u v w x y z A B C D E F G H I J  3m · from an earlier session', 32)).toEqual([
      ' a b c d e f g h i j k l m n o p',
      ' q r s t u v w x y z A B C D E F',
      ' G H I J  3m · from an earlier ',
      'session',
    ])
    expect(wrapRows('#3 Datenbankverbindungseinstellungsüberprüfungsprotokoll im Ordner ablegen', 30)).toEqual([
      '#3 Datenbankverbindungseinstel',
      'lungsüberprüfungsprotokoll im ',
      'Ordner ablegen',
    ])
    expect(cellsOf('ステージング')).toBe(12)
    expect(rowsOf('ステージング環境のデータベース移行を承認してください', 30)).toBe(2)
  })

  test('count an emoji as the terminal draws it: two cells, however it is built', () => {
    // Drawn as emoji by default, below U+1F300 too.
    expect(cellsOf('⌛ ✅ ⚡ ⭐ 🀄 🈯')).toBe(17)
    // An emoji drawn as text unless U+FE0F asks otherwise.
    expect(cellsOf('☀ 🌡')).toBe(3)
    expect(cellsOf('☀️ 🌡️ ⚠️')).toBe(8)
    // A keycap, a skin tone, a flag, and emoji joined by U+200D.
    expect(cellsOf('1️⃣ 👍🏽 🇮🇱 👩‍💻 🫱🏼‍🫲🏿')).toBe(14)
    // Without U+FE0F: a keycap, and an emoji drawn as text joined to another.
    expect(cellsOf('1⃣ ❤‍🔥 ❤‍🩹')).toBe(8)
    // A digit, `©` and `®` stay text.
    expect(cellsOf('9️ ©‍🔥')).toBe(5)
    // Marks and format characters take no cell of their own, nor a Hangul vowel and final spelled apart.
    expect(cellsOf('é​')).toBe(1)
    expect(cellsOf('각')).toBe(2)
    expect(rowsOf('Fix the ⏳ timeouts ✅ before the ⛔ freeze', 20)).toBe(3)
  })

  test('break a word wider than the row between the characters the terminal draws, never inside one', () => {
    // A skin tone stays on its hand, U+FE0F on its sun, emoji joined by U+200D together, and a conjunct with its vowel sign.
    expect(wrapRows('👍🏽👍🏽👍🏽👍🏽👍🏽', 9)).toEqual(['👍🏽👍🏽👍🏽👍🏽', '👍🏽'])
    expect(wrapRows('Status:☀️', 8)).toEqual(['Status:', '☀️'])
    expect(wrapRows('Pair 👩‍💻👩‍💻👩‍💻👩‍💻', 7)).toEqual(['Pair 👩‍💻', '👩‍💻👩‍💻👩‍💻'])
    expect(wrapRows('नमस्ते', 3)).toEqual(['नम', 'स्ते'])
    // A row one cell wide: a wide character goes on a row past it, after an empty one where the row before is full.
    expect(wrapRows('一二', 1)).toEqual(['', '一', '二'])
    expect(wrapRows('a一', 1)).toEqual(['a', '', '一'])
  })

  test('count East Asian wide forms two cells, and the ambiguous ones one', () => {
    expect(cellsOf('〈☰⚊䷀ꥠ︐﹐\u{16FE0}\u{17000}\u{1B000}\u{1D300}\u{1F200}')).toBe(24)
    expect(cellsOf('㉈')).toBe(1)
  })

  test('the pane asks for a row for each row a wrapped title takes, at the width it is drawn in', () => {
    const view = {
      shown: [INSTRUMENTS, XCODE_LONG],
      selectedId: null,
      editing: null,
      draft: '',
      nowMs: NOW,
      sessionId: 'session-1',
      isWorking: false,
      canType: true,
      isFocused: true,
      isTyping: false,
    }

    // A title on one row would ask for 10 rows wherever it is drawn: the
    // rows Claude Code 2.1.296 drew at 36 and 64 columns, as the live check reads them.
    expect(rowsFor(view, 32, 99)).toBe(18)
    expect(rowsFor(view, 60, 99)).toBe(12)
    expect(rowsFor({ ...view, shown: [INSTRUMENTS] }, 32, 99)).toBe(14)
    expect(rowsFor({ ...view, shown: [INSTRUMENTS] }, 60, 99)).toBe(10)
    expect(rowsFor(view, 32, 18)).toBe(18)
  })

  test('drawn narrow, the pane opens again as tall as its wrapped titles', async ($, on) => {
    const { world } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)

    await runTasks($)
    const ui = await $.ui.mount(inline(60))
    expect(world.opens.at(-1)?.rows).toBe(12)

    // The terminal narrows: the titles take more rows, and the pane asks for them.
    await ui.redraw(inline(32).props)
    expect(world.opens.at(-1)?.rows).toBe(18)
  })

  test('drawn on two surfaces at once, the pane asks for the rows the narrower takes, and keeps them', async ($, on) => {
    const { world, clock } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)
    await $.session.attach({ surface: 'mobile', clientId: 'phone' })

    await runTasks($)
    const terminal = await $.ui.mount(inline(60))
    const phone = await $.ui.mount({ ...inline(32), surface: 'mobile' })
    expect(world.opens.at(-1)?.rows).toBe(18)

    // Each draws again: the pane asks for nothing new.
    const opens = world.opens.length
    await terminal.redraw(inline(60).props)
    await phone.redraw(inline(32).props)
    expect(world.opens.length).toBe(opens)

    // The phone leaves: the pane fits the terminal.
    await phone.unmount()
    await $.session.detach({ surface: 'mobile', clientId: 'phone', reason: 'detach' })
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(12)
  })

  test('a surface that docks the pane it drew inline leaves it as tall as the surfaces still drawing it inline', async ($, on) => {
    const { world } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)
    await $.session.attach({ surface: 'mobile', clientId: 'phone' })

    await runTasks($)
    const terminal = await $.ui.mount(inline(32))
    await $.ui.mount({ ...inline(60), surface: 'mobile' })
    expect(world.opens.at(-1)?.rows).toBe(18)

    // The terminal widens and docks the pane: the phone's rows are the pane's.
    await terminal.redraw(PANE.props)
    expect(world.opens.at(-1)?.rows).toBe(12)
  })

  test('drawn by two clients of one surface, the pane asks for the rows the narrower takes, and keeps them', async ($, on) => {
    const { world, clock } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)
    await $.session.attach({ surface: 'mobile', clientId: 'tablet' })
    await $.session.attach({ surface: 'mobile', clientId: 'phone' })

    // A render names its surface, not its client: the tablet's and the phone's come as one surface's.
    await runTasks($)
    const mobile = await $.ui.mount({ ...inline(60), surface: 'mobile' })
    await mobile.redraw(inline(32).props)
    expect(world.opens.at(-1)?.rows).toBe(18)

    // Each draws again: the pane asks for nothing new.
    const opens = world.opens.length
    await mobile.redraw(inline(60).props)
    await mobile.redraw(inline(32).props)
    expect(world.opens.length).toBe(opens)

    // The phone leaves: the tablet drawing again, the pane fits it, and
    // follows it as it widens.
    await $.session.detach({ surface: 'mobile', clientId: 'phone', reason: 'detach' })
    await mobile.redraw(inline(60).props)
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(12)

    await mobile.redraw(inline(100).props)
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(11)
  })

  test("of two clients of one surface, one drawing it otherwise again and again keeps the other's rows", async ($, on) => {
    const { world } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)
    await $.session.attach({ surface: 'mobile', clientId: 'phone' })
    await $.session.attach({ surface: 'mobile', clientId: 'tablet' })

    await runTasks($)
    const mobile = await $.ui.mount({ ...inline(32), surface: 'mobile' })
    // The tablet takes the keys and gives them back, turned one way and the other.
    for (const [columns, isFocused] of [[60, false], [60, true], [90, false], [90, true]] as const) {
      await mobile.redraw({ ...inline(columns).props, isFocused })
    }

    expect(world.opens.at(-1)?.rows).toBe(18)
  })

  test('a client of two leaving, the pane asks for none of the rows it took', async ($, on) => {
    const { world, clock } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)
    await $.session.attach({ surface: 'mobile', clientId: 'tablet' })
    await $.session.attach({ surface: 'mobile', clientId: 'phone' })

    await runTasks($)
    await $.ui.mount(inline(60))
    const mobile = await $.ui.mount({ ...inline(60), surface: 'mobile' })
    await mobile.redraw(inline(32).props)
    await mobile.redraw(inline(60).props)
    expect(world.opens.at(-1)?.rows).toBe(18)

    // The phone leaves, and the tablet draws the pane again: the pane fits it and the terminal.
    await $.session.detach({ surface: 'mobile', clientId: 'phone', reason: 'detach' })
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(12)
  })

  test('a client of three leaving, the two left draw the pane again, and it fits them', async ($, on) => {
    const { world, clock } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)

    for (const clientId of ['phone', 'tablet', 'laptop']) {
      await $.session.attach({ surface: 'mobile', clientId })
    }

    await runTasks($)
    const mobile = await $.ui.mount({ ...inline(32), surface: 'mobile' })
    await mobile.redraw(inline(60).props)
    await mobile.redraw(inline(50).props)
    expect(world.opens.at(-1)?.rows).toBe(18)

    // The phone leaves. No surface seats the pane inline but theirs, and the
    // narrower of the two drew last.
    await $.session.detach({ surface: 'mobile', clientId: 'phone', reason: 'detach' })
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(14)
  })

  test('two clients of one surface leaving at once, the pane fits the surfaces left', async ($, on) => {
    const { world, clock } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)
    await $.session.attach({ surface: 'mobile', clientId: 'tablet' })
    await $.session.attach({ surface: 'mobile', clientId: 'phone' })

    await runTasks($)
    await $.ui.mount(inline(60))
    const mobile = await $.ui.mount({ ...inline(32), surface: 'mobile' })
    expect(world.opens.at(-1)?.rows).toBe(18)

    // Both leave together, and the phone reads who is attached late: the tablet still is.
    await mobile.unmount()
    world.slowRead = 'clients'
    world.readMs = 500
    const leaving = Promise.all([
      $.session.detach({ surface: 'mobile', clientId: 'phone', reason: 'detach' }),
      $.session.detach({ surface: 'mobile', clientId: 'tablet', reason: 'detach' }),
    ])
    await clock.advance(500)
    await leaving
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(12)
  })

  test("clients leaving as the roster's write answers late, the pane still fits those left", async ($, on) => {
    const { world, clock } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    let lateMs = 0
    on('state.set', { plugin: 'human-in-the-loop' }, async ($, e, next) => {
      const set = await next(e)

      if (e.key === 'clients' && lateMs > 0) {
        await clock.sleep(lateMs)
      }

      return set
    })
    await start($)

    for (const clientId of ['laptop', 'tablet', 'phone']) {
      await $.session.attach({ surface: 'mobile', clientId })
    }

    await runTasks($)
    await $.ui.mount(inline(60))
    const mobile = await $.ui.mount({ ...inline(32), surface: 'mobile' })
    await mobile.redraw(inline(50).props)
    expect(world.opens.at(-1)?.rows).toBe(18)

    // The pane draws again before the write that wakes it answers: the two
    // left start their seats over, and once they leave too, the terminal's fit.
    lateMs = 100
    const phoneLeaving = $.session.detach({ surface: 'mobile', clientId: 'phone', reason: 'detach' })
    await clock.advance(100)
    await phoneLeaving
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(14)

    await mobile.unmount()

    for (const clientId of ['tablet', 'laptop']) {
      const leaving = $.session.detach({ surface: 'mobile', clientId, reason: 'detach' })
      await clock.advance(100)
      await leaving
    }

    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(12)
  })

  test("a client leaving and attaching again as the roster's write answers late keeps the rows it draws", async ($, on) => {
    const { world, clock } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    const lateMs: number[] = []
    on('state.set', { plugin: 'human-in-the-loop' }, async ($, e, next) => {
      const ms = e.key === 'clients' ? (lateMs.shift() ?? 0) : 0
      const set = await next(e)

      if (ms > 0) {
        await clock.sleep(ms)
      }

      return set
    })
    await start($)
    await $.session.attach({ surface: 'mobile', clientId: 'phone' })

    await runTasks($)
    const terminal = await $.ui.mount(inline(60))
    const mobile = await $.ui.mount({ ...inline(32), surface: 'mobile' })
    expect(world.opens.at(-1)?.rows).toBe(18)

    // The phone drops and comes back, drawing the pane, before the write of
    // its leaving answers: the seat it draws stays.
    lateMs.push(100)
    await mobile.unmount()
    const leaving = $.session.detach({ surface: 'mobile', clientId: 'phone', reason: 'detach' })
    await clock.settle()
    const attaching = $.session.attach({ surface: 'mobile', clientId: 'phone' })
    await $.ui.mount({ ...inline(32), surface: 'mobile' })
    await clock.advance(100)
    await Promise.all([leaving, attaching])

    await terminal.redraw(inline(60).props)
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(18)
  })

  test('a client leaving and attaching again stays counted, though the write of its leaving lands late', async ($, on) => {
    const { world, clock } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    let lateMs = 0
    on('state.set', { plugin: 'human-in-the-loop' }, async ($, e, next) => {
      if (e.key === 'clients' && lateMs > 0) {
        const ms = lateMs
        lateMs = 0
        await clock.sleep(ms)
      }

      return next(e)
    })
    await start($)
    await $.session.attach({ surface: 'mobile', clientId: 'phone' })

    await runTasks($)
    await $.ui.mount(inline(60))
    const mobile = await $.ui.mount({ ...inline(32), surface: 'mobile' })
    expect(world.opens.at(-1)?.rows).toBe(18)

    // The phone drops and attaches again, and the write of its leaving lands
    // after the engine has it back: it stays counted, so a tablet attaching
    // next draws as one of two.
    lateMs = 100
    await mobile.unmount()
    const leaving = $.session.detach({ surface: 'mobile', clientId: 'phone', reason: 'detach' })
    await clock.settle()
    const attaching = $.session.attach({ surface: 'mobile', clientId: 'phone' })
    await clock.advance(100)
    await Promise.all([leaving, attaching])

    const phone = await $.ui.mount({ ...inline(32), surface: 'mobile' })
    await $.session.attach({ surface: 'mobile', clientId: 'tablet' })
    await phone.redraw(inline(60).props)
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(18)
  })

  test('the last client of a surface leaving as it draws the pane, the pane asks for none of the rows that drawing takes', async ($, on) => {
    const { world, clock } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)
    await $.session.attach({ surface: 'mobile', clientId: 'phone' })

    await runTasks($)
    const terminal = await $.ui.mount(inline(60))
    const mobile = await $.ui.mount({ ...inline(32), surface: 'mobile' })
    expect(world.opens.at(-1)?.rows).toBe(18)

    // The phone draws the pane again and leaves before that drawing reads who is attached.
    world.slowRead = 'clients'
    world.readMs = 100
    const drawing = mobile.redraw(inline(32).props)
    await clock.settle()
    await mobile.unmount()
    await $.session.detach({ surface: 'mobile', clientId: 'phone', reason: 'detach' })
    await clock.advance(100)
    await drawing.catch(() => undefined)

    await terminal.redraw(inline(60).props)
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(12)
  })

  test('a client is counted before it first draws the pane', async ($, on) => {
    const { world, clock } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)
    await $.session.attach({ surface: 'mobile', clientId: 'phone' })

    await runTasks($)
    const mobile = await $.ui.mount({ ...inline(32), surface: 'mobile' })
    expect(world.opens.at(-1)?.rows).toBe(18)

    // The tablet draws as it attaches, before the engine is done attaching it.
    world.attachMs = 500
    const attached = $.session.attach({ surface: 'mobile', clientId: 'tablet' })
    await clock.advance(1)
    await mobile.redraw(inline(60).props)
    await clock.advance(500)
    await attached
    await clock.settle()

    expect(world.opens.at(-1)?.rows).toBe(18)
  })

  test("the clients attached are kept in the session's state, which a reload of the code keeps", async ($, on) => {
    seat(on)
    let roster: unknown
    on('state.set', { plugin: 'human-in-the-loop' }, ($, e, next) => {
      roster = e.key === 'clients' ? e.value : roster
      return next(e)
    })
    await start($)

    await $.session.attach({ surface: 'mobile', clientId: 'phone' })
    await $.session.attach({ surface: 'mobile', clientId: 'tablet' })
    await $.session.attach({ surface: 'desktop', clientId: 'laptop' })
    await $.session.detach({ surface: 'mobile', clientId: 'phone', reason: 'detach' })

    expect(roster).toEqual({ mobile: ['tablet'], desktop: ['laptop'] })
  })

  test('re-sizing the pane, a drawing or a keystroke reads the tasks once', async ($, on) => {
    const { world } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)

    await runTasks($)
    const ui = await $.ui.mount(inline(60))
    world.tasksRead = 0
    await ui.redraw(inline(32).props)
    expect(world.opens.at(-1)?.rows).toBe(18)
    expect(world.tasksRead).toBe(1)

    await ui.redraw(inline(100).props)
    await ui.press({ key: 'select-2' })
    await ui.press({ key: 'reject' })
    const rows = world.opens.at(-1)?.rows ?? 0
    world.tasksRead = 0
    await ui.input({
      key: 'reason-2',
      text: 'LoginTests.testExpiredToken failed, and CartTests.testCouponRounding failed with a rounding error in the total',
      kind: 'change',
    })
    expect(world.opens.at(-1)?.rows).toBe(rows + 1)
    expect(world.tasksRead).toBe(1)
  })

  test('docked beside the transcript, the terminal asks for no rows of its own', async ($, on) => {
    const { world } = seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)

    await runTasks($)
    await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 32 } })
    await $.ui.mount({ ...inline(60), surface: 'mobile' })

    expect(world.opens.at(-1)?.rows).toBe(12)
  })

  test('the last task leaving, the pane closes and asks for no rows as it goes', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(inline(60))
    const opens = world.opens.length
    // Drawn empty while the withdraw writes the store, before the pane closes.
    world.setMs = 1000
    const withdrawn = $.tool.call({ tool: WITHDRAW, id: 1 })
    await clock.advance(1)
    await ui.redraw(inline(60).props)
    await clock.advance(1000)
    await withdrawn

    expect(world.opens.length).toBe(opens)
    expect(world.isPaneOpen).toBe(false)
  })

  test('re-sizing as its last task leaves, the pane stays closed', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(inline(64))
    await ui.press({ key: 'reject' })
    const rows = world.opens.at(-1)?.rows ?? 0
    await ui.input({ key: 'reason-1', text: 'Two failures: LoginTests.testExpiredToken and CartTests.testCouponRounding', kind: 'change' })
    expect(world.opens.at(-1)?.rows).toBe(rows + 1)

    // The reason, cut short, takes a row less, and the pane re-sizes reading
    // the tasks late: Claude withdraws the task meanwhile.
    world.slowRead = 'tasks'
    world.readMs = 500
    const typing = ui.input({ key: 'reason-1', text: 'Two failures', kind: 'change' })
    await clock.advance(1)
    await $.tool.call({ tool: WITHDRAW, id: 1, reason: 'Found them in the CI logs' })
    await clock.advance(500)
    await typing
    await clock.settle()

    expect(world.isPaneOpen).toBe(false)
  })

  test('a re-size the surface answers late, as Claude withdraws the last task, leaves the pane closed', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(inline(64))
    await ui.press({ key: 'reject' })
    const rows = world.opens.at(-1)?.rows ?? 0

    // The reason takes a row more, and the surface says late, as it was when
    // asked, that the pane is open: Claude withdraws the task meanwhile.
    world.panesMs = 500
    const typing = ui.input({ key: 'reason-1', text: 'Two failures: LoginTests.testExpiredToken and CartTests.testCouponRounding', kind: 'change' })
    await clock.advance(1)
    await $.tool.call({ tool: WITHDRAW, id: 1, reason: 'Found them in the CI logs' })
    await clock.advance(500)
    await typing
    await clock.settle()

    expect(world.isPaneOpen).toBe(false)
    expect(world.opens.at(-1)?.rows).toBe(rows)
  })

  test('a re-size the surface answers late, as the pane is hidden, leaves it hidden', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(inline(64))
    await ui.press({ key: 'reject' })

    world.panesMs = 500
    const typing = ui.input({ key: 'reason-1', text: 'Two failures: LoginTests.testExpiredToken and CartTests.testCouponRounding', kind: 'change' })
    await clock.advance(1)
    await ui.press({ key: 'hide' })
    await clock.advance(500)
    await typing
    await clock.settle()

    expect(world.isPaneOpen).toBe(false)
  })

  test('every open task shows its whole title, wrapping, with its age after it in the same text', async ($, on) => {
    seat(on, earlier([INSTRUMENTS, XCODE_LONG]))
    await start($)

    const ui = await $.ui.mount(inline(32))
    const selected = await ui.find({ type: 'Text', text: /Open Instruments/ })
    const other = await ui.find({ type: 'Text', text: /Run xcodebuild/ })

    expect(selected?.props.wrap).toBe('wrap')
    expect(selected?.text).toBe(`#1 ${INSTRUMENTS.title}  3m · from an earlier session`)
    expect(other?.props.wrap).toBe('wrap')
    expect(other?.text).toBe(` ${XCODE_LONG.title}  3m · from an earlier session`)
    expect((await ui.find({ type: 'Button', key: 'select-2' }))?.props.label).toBe('#2')
  })

  test('a title past 80 characters, an older version left, is drawn whole', async ($, on) => {
    const title = `Rotate the deploy key ${'and check every runner that holds it '.repeat(3).trim()}`
    seat(on, earlier([{ ...INSTRUMENTS, title }, { ...XCODE_LONG, title, state: 'done', update: 'pending' }]))
    await start($)

    const ui = await $.ui.mount(inline(32))

    expect(title.length).toBeGreaterThan(80)
    expect(await textOf(ui, 'task-1')).toContain(title)
    expect(await textOf(ui, 'saved-2')).toContain(`#2 ${title} · not sent yet`)
  })

  test('a focused field wraps its text a column short of the field, for the cursor', () => {
    // 60 across: `Answer: ` and ` ⏎ send` leave the field 45 columns, its text 44.
    expect(fieldRowsOf('Answer', 'send', 'x'.repeat(44), true, 60)).toBe(1)
    expect(fieldRowsOf('Answer', 'send', 'x'.repeat(45), true, 60)).toBe(2)
    // Out of the keys, the text is cut to one row, and the label, cut short, wraps onto a second:
    // as Claude Code 2.1.296 drew 56 and 57 characters at 64 columns.
    expect(fieldRowsOf('Answer', 'send', 'x'.repeat(56), false, 60)).toBe(1)
    expect(fieldRowsOf('Answer', 'send', 'x'.repeat(57), false, 60)).toBe(2)
    // However narrow the pane, the terminal gives the field 12 columns, its text 11.
    expect(fieldRowsOf('Answer', 'send', 'x'.repeat(22), true, 20)).toBe(2)
    expect(fieldRowsOf('Answer', 'send', 'x'.repeat(23), true, 20)).toBe(3)
  })

  test('a row too narrow for the label, the field and the hint takes its lack from each, and what is cut short wraps onto a second', () => {
    // As Claude Code 2.1.296 drew them at 30, 29 and 28 columns: bodies 26, 25 and 24 across.
    // The placeholder takes the field's 12 columns, the text its cells and the cursor's: a row a cell short cuts only the field.
    expect(fieldRowsOf('Answer', 'send', '', true, 26)).toBe(1)
    expect(fieldRowsOf('Answer', 'send', '', true, 25)).toBe(2)
    expect(fieldRowsOf('Reason', 'reject', '', true, 26)).toBe(2)
    expect(fieldRowsOf('Answer', 'send', 'abc', true, 24)).toBe(1)
    expect(fieldRowsOf('Answer', 'send', 'abcdefghij', true, 25)).toBe(1)
    expect(fieldRowsOf('Answer', 'send', 'abcdefghijk', true, 26)).toBe(1)
    expect(fieldRowsOf('Answer', 'send', 'abcdefghijk', true, 25)).toBe(2)
    // Out of the keys, the placeholder cut to the field, at 23 and 22 columns.
    expect(fieldRowsOf('Answer', 'send', '', false, 19)).toBe(1)
    expect(fieldRowsOf('Answer', 'send', '', false, 18)).toBe(2)
  })

  test('a field of several rows is that tall, whatever it holds, with the keys or without', () => {
    expect(fieldRowsOf('Answer', 'send', '', true, 60, 4)).toBe(4)
    expect(fieldRowsOf('Answer', 'send', 'x'.repeat(500), true, 60, 4)).toBe(4)
    expect(fieldRowsOf('Answer', 'send', 'one\ntwo\nthree\nfour\nfive', false, 20, 4)).toBe(4)
  })

  test('a field squeezed onto a second row in a narrow pane asks for that row', async ($, on) => {
    const { world, clock } = seat(on, earlier([{ ...XCODE_LONG, title: 'Paste the failures', why: "I can't run Xcode." }]))
    await start($)

    await runTasks($)
    // At 28 columns Claude Code 2.1.296 squeezes the hint under an empty field of one row: 12 rows in all.
    const ui = await $.ui.mount(inline(24))
    await ui.press({ key: 'reject' })
    expect(world.opens.at(-1)?.rows).toBe(12)

    // A short reason leaves the hint room on its row.
    await ui.input({ key: 'reason-2', text: 'abc', kind: 'change' })
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(11)

    await ui.input({ key: 'reason-2', text: 'abcdefghijk', kind: 'change' })
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(12)
  })

  test('an empty field in a narrow pane, hidden and opened again, takes the ring and asks for the row it squeezes onto', async ($, on) => {
    const { world, clock } = seat(on, earlier([{ ...XCODE_LONG, title: 'Paste the failures', why: "I can't run Xcode." }]))
    await start($)

    await runTasks($)
    const ui = await $.ui.mount(inline(24))
    await ui.press({ key: 'reject' })
    // Out of the keys, the field draws no hint: one row.
    await $.ui.focus(ringTo('cancel'))
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(11)

    // Hidden and opened again, the field's autoFocus takes the ring, and `⏎ reject` squeezes under it.
    await ui.press({ key: 'hide' })
    await ui.unmount()
    await runTasks($)
    await $.ui.mount(inline(24))
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(12)
  })

  test('the transcript row keeps its label whole and wraps the title after it', async ($, on) => {
    seat(on)
    await start($)

    const ui = await $.ui.mount({
      plugin: 'human-in-the-loop',
      surface: 'terminal',
      component: 'ToolUse',
      props: {
        tool_use_id: 'toolu_1',
        tool: ASSIGN,
        input: { title: XCODE_LONG.title },
        isRunning: false,
        isErrored: false,
        isInterrupted: false,
      },
    })
    // One text, outermost: no row of columns for the label to be squeezed in.
    const row = await ui.find({ type: 'Text' })

    expect((await ui.drawn()).type).toBe('Text')
    expect(row?.props.wrap).toBe('wrap')
    expect(row?.text).toBe(`☐ Assigned you a task: ${XCODE_LONG.title}`)
  })
})

describe('the pane and /my-tasks', () => {
  test('/my-tasks opens the pane with the keyboard, or says there is nothing', async ($, on) => {
    const { world } = seat(on)
    await start($)

    expect((await runTasks($)).text).toBe('No tasks for you right now.')
    expect(world.isPaneOpen).toBe(true)

    await $.tool.call(KEY_TASK)
    await runTasks($)

    expect(world.opens.at(-1)?.focus).toBe(true)
  })

  test('the phone, which draws no field, offers Done and a Reject that rejects at once', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const phone = await $.ui.mount({ ...PANE, surface: 'mobile' })

    expect((await phone.findAll({ type: 'Button' })).map(button => button.props.label)).toEqual(['Done', 'Reject', 'Archive', 'Hide'])

    await phone.press({ key: 'reject' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toEqual([
      "My response to a task you gave me (Human in the loop):\n\n#1 Run xcodebuild test on your Mac, paste the failures: I won't do this.",
    ])
  })

  test('a field open on a surface that draws one leaves the task its buttons on the phone', async ($, on) => {
    seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    const phone = await $.ui.mount({ ...PANE, surface: 'mobile' })

    expect(await ui.find({ type: 'Input' })).toBeDefined()
    expect((await phone.findAll({ type: 'Button' })).map(button => button.props.label)).toEqual(['Done', 'Reject', 'Archive', 'Hide'])
  })

  test('Hide closes the pane and the status line keeps the count', async ($, on) => {
    const { world } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'hide' })

    expect(world.isPaneOpen).toBe(false)
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })
})

/** A second task that takes an answer, as XCODE_TASK does. */
const ANDROID_TASK = { ...XCODE_TASK, title: 'Run the Android tests on your phone, paste the failures' } as const

/** The pane's focus ring moving onto `element`, as the person's click or Tab moves it. */
function ringTo(element: string) {
  return {
    component: 'Pane',
    requestId: 'my-tasks',
    plugin: 'human-in-the-loop',
    element,
    origin: { kind: 'person' },
  } as const
}

describe('the answer field', () => {
  test("Answer… opens a field of the task's own, labelled for the terminal to add its colon", async ($, on) => {
    seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })

    expect((await ui.find({ type: 'Input', key: 'answer-1' }))?.props.label).toBe('Answer')
  })

  test("a draft stays with its task: another task's field opens empty, and the first keeps its own", async ($, on) => {
    seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed', kind: 'change' })
    await ui.press({ key: 'select-2' })
    await ui.press({ key: 'answer' })

    expect((await ui.find({ type: 'Input', key: 'answer-2' }))?.props.value).toBe('')

    await ui.press({ key: 'select-1' })
    await ui.press({ key: 'answer' })

    expect((await ui.find({ type: 'Input', key: 'answer-1' }))?.props.value).toBe('LoginTests.testExpiredToken failed')
  })

  test('a held answer comes back to its field on Edit', async ($, on) => {
    seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: KEY_SHAPED, kind: 'change' })
    await ui.input({ key: 'answer-1', text: KEY_SHAPED })
    await ui.press({ key: 'edit' })

    expect((await ui.find({ type: 'Input', key: 'answer-1' }))?.props.value).toBe(KEY_SHAPED)
  })

  test('typed in, the field keeps the value it opened with: one drawn anew puts its text back, keys typed since lost', async ($, on) => {
    seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests', kind: 'change' })
    // The pane draws again while the user types: Claude assigns another task.
    await $.tool.call(ANDROID_TASK)

    expect((await ui.find({ type: 'Input', key: 'answer-1' }))?.props.value).toBe('')
  })

  test('hidden and opened again, the field holds what was typed in it', async ($, on) => {
    const { clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'Use the staging creds', kind: 'change' })
    await clock.settle()
    await ui.press({ key: 'hide' })
    await ui.unmount()
    await runTasks($)
    const again = await $.ui.mount(PANE)

    expect((await again.find({ type: 'Input', key: 'answer-1' }))?.props.value).toBe('Use the staging creds')
  })

  test("hidden and opened again while the engine can't list its panes, the field holds what was typed in it", async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'Use the staging creds', kind: 'change' })
    await clock.settle()
    await ui.press({ key: 'hide' })
    await ui.unmount()
    world.isPanesFailing = true
    await runTasks($)
    const again = await $.ui.mount(PANE)

    expect((await again.find({ type: 'Input', key: 'answer-1' }))?.props.value).toBe('Use the staging creds')
  })

  test('with no draft to draw again, the pane opens without asking which panes are open', async ($, on) => {
    const { world } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await runTasks($)

    expect(world.opens).toHaveLength(2)
    expect(world.panesAsked).toBe(0)
  })

  test('a client attaching draws the field with what is typed in it, and leaves a field drawn elsewhere the value it opened with', async ($, on) => {
    const { clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'Use the staging creds', kind: 'change' })
    await clock.settle()
    await $.session.attach({ surface: 'desktop', clientId: 'laptop' })
    const laptop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    // The pane draws again: Claude assigns another task.
    await $.tool.call(ANDROID_TASK)

    expect((await laptop.find({ type: 'Input', key: 'answer-1' }))?.props.value).toBe('Use the staging creds')
    expect((await ui.find({ type: 'Input', key: 'answer-1' }))?.props.value).toBe('')
  })

  test('a second client of a surface draws the field with what is typed in it', async ($, on) => {
    const { clock } = seat(on)
    await start($)
    await $.session.attach({ surface: 'desktop', clientId: 'laptop' })

    await $.tool.call(XCODE_TASK)
    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await desktop.press({ key: 'answer' })
    await desktop.input({ key: 'answer-1', text: 'Use the staging creds', kind: 'change' })
    await clock.settle()
    // The desktop app opens on another computer, and draws the pane.
    await $.session.attach({ surface: 'desktop', clientId: 'office' })
    await desktop.redraw()

    expect((await desktop.find({ type: 'Input', key: 'answer-1' }))?.props.value).toBe('Use the staging creds')
  })

  test('typed in, a field of one row asks for the rows its text wraps to, and for one row less once the keys leave it', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(inline(60))
    // The field takes the keys as it opens.
    await ui.press({ key: 'reject' })
    const rows = world.opens.at(-1)?.rows ?? 0

    // 43 columns for the text beside `Reason: ` and ` ⏎ reject`, one kept for the cursor: three rows.
    await ui.input({
      key: 'reason-1',
      text: 'LoginTests.testExpiredToken failed, and CartTests.testCouponRounding failed with a rounding error',
      kind: 'change',
    })
    expect(world.opens.at(-1)?.rows).toBe(rows + 2)

    // Out of the keys, the text is cut to one row; the label, squeezed, wraps onto a second.
    await ui.redraw({ ...inline(60).props, isFocused: false })
    expect(world.opens.at(-1)?.rows).toBe(rows + 1)

    // Back in them, the ring is where it was.
    await ui.redraw(inline(60).props)
    expect(world.opens.at(-1)?.rows).toBe(rows + 2)

    // Tab moves the keys on, and Shift+Tab brings them back.
    await $.ui.focus(ringTo('cancel'))
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(rows + 1)

    await $.ui.focus(ringTo('reason-1'))
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(rows + 2)
  })

  test('the ring taken by the field unseen, as the pane opens again or a key is typed there, the field asks for the rows its text wraps to', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(inline(60))
    await ui.press({ key: 'reject' })
    const rows = world.opens.at(-1)?.rows ?? 0
    await ui.input({
      key: 'reason-1',
      text: 'LoginTests.testExpiredToken failed, and CartTests.testCouponRounding failed with a rounding error',
      kind: 'change',
    })
    await $.ui.focus(ringTo('cancel'))
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(rows + 1)

    // Hidden and opened again, the field's autoFocus takes the ring.
    await ui.press({ key: 'hide' })
    await ui.unmount()
    await runTasks($)
    const again = await $.ui.mount(inline(60))
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(rows + 2)

    // A key typed in the field says the ring is there.
    await $.ui.focus(ringTo('cancel'))
    await clock.settle()
    await again.input({ key: 'reason-1', text: 'LoginTests.testExpiredToken failed, and CartTests.testCouponRounding failed with rounding', kind: 'change' })
    expect(world.opens.at(-1)?.rows).toBe(rows + 2)
  })

  test('opened again, a field takes the ring and asks for the rows its draft wraps to', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(inline(60))
    await ui.press({ key: 'reject' })
    const rows = world.opens.at(-1)?.rows ?? 0
    await ui.input({
      key: 'reason-1',
      text: 'LoginTests.testExpiredToken failed, and CartTests.testCouponRounding failed with a rounding error',
      kind: 'change',
    })
    await $.ui.focus(ringTo('cancel'))
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(rows + 1)

    await ui.press({ key: 'cancel' })
    await ui.press({ key: 'reject' })
    expect(world.opens.at(-1)?.rows).toBe(rows + 2)
  })

  test('a key typed as a move of the ring re-sizes the pane, the pane asks for the rows the key leaves', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(inline(60))
    await ui.press({ key: 'reject' })
    const rows = world.opens.at(-1)?.rows ?? 0
    await ui.input({ key: 'reason-1', text: 'LoginTests.testExpiredToken failed, and CartTests.testCouponRounding failed', kind: 'change' })
    expect(world.opens.at(-1)?.rows).toBe(rows + 1)

    // Tab moves the keys on, and that re-size reads slowly once it has the
    // draft; the person comes back to the field and types meanwhile.
    world.slowRead = 'isWorking'
    world.readMs = 100
    await $.ui.focus(ringTo('cancel'))
    await clock.settle()
    const typing = ui.input({
      key: 'reason-1',
      text: 'LoginTests.testExpiredToken failed, and CartTests.testCouponRounding failed with a rounding error',
      kind: 'change',
    })
    await clock.settle()
    await clock.advance(100)
    await typing
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(rows + 2)
  })

  test('the answer field is four rows tall, and the pane keeps its height however much is typed, with the keys or without', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(inline(60))
    const buttons = world.opens.at(-1)?.rows ?? 0
    await ui.press({ key: 'answer' })

    expect((await ui.find({ type: 'Input', key: 'answer-1' }))?.props.rows).toBe(4)
    // The task's buttons give way to the field and the buttons under it.
    const rows = world.opens.at(-1)?.rows ?? 0
    expect(rows).toBe(buttons + 4)

    // A log longer than the field scrolls inside it.
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed\n'.repeat(8), kind: 'change' })
    expect(world.opens.at(-1)?.rows).toBe(rows)

    await $.ui.focus(ringTo('other-way'))
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(rows)
  })

  test('a placeholder longer than the field is cut to its row', async ($, on) => {
    seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(inline(32))
    await ui.press({ key: 'answer' })

    expect((await ui.find({ type: 'Input', key: 'answer-1' }))?.props.placeholder).toBe('Enter sends it t…')
  })
})

describe('responding', () => {
  test('Done while Claude is idle is sent to Claude as a message, and the pane closes', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toHaveLength(1)
    expect(world.submitted[0]).toBe('My response to a task you gave me (Human in the loop):\n\n#1 Add STRIPE_SECRET_KEY to .env: Done.')
    expect(world.isPaneOpen).toBe(false)
    expect(world.status).toBeUndefined()
  })

  test('an answer of several lines, typed in the pane while Claude is idle, reaches Claude whole', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken\nCartTests.testCouponRounding' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toEqual([
      'My response to a task you gave me (Human in the loop):\n\n#1 Run xcodebuild test on your Mac, paste the failures:\nLoginTests.testExpiredToken\nCartTests.testCouponRounding',
    ])
  })

  test('an answer while Claude works is saved, and goes when its turn ends', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)

    await ui.press({ key: 'answer' })
    expect((await ui.find({ type: 'Input', key: 'answer-1' }))?.props.placeholder).toBe('Enter saves it; Claude gets it when this turn ends')
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toHaveLength(0)
    expect(world.appended).toHaveLength(0)
    expect(await textOf(ui, 'saved-1')).toContain('not sent yet')
    // The pane has the room to say what is not sent; the status line says it short.
    expect(await textOf(ui, 'head')).toContain('✓ 1 response not sent yet')
    expect(world.status).toBe('✓ 1 not sent yet · /my-tasks')

    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    expect(world.submitted).toEqual([
      'My response to a task you gave me (Human in the loop):\n\n#1 Run xcodebuild test on your Mac, paste the failures:\nLoginTests.testExpiredToken failed',
    ])
    expect(world.status).toBeUndefined()
  })

  test('with a task still open, a saved answer waits for it, or rides along with the next prompt', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)

    await ui.press({ key: 'answer' })
    expect((await ui.find({ type: 'Input', key: 'answer-1' }))?.props.placeholder).toBe('Enter saves it; Claude gets it with your other answers')
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed' })
    await clock.advance(1000)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    expect(world.submitted).toHaveLength(0)
    expect(world.status).toBe('☐ 1 task for you · 1 not sent yet · /my-tasks')

    const next = await $.prompt.submit(typed('now the cart'))

    expect(next.context?.[0]).toContain('#1 done: Run xcodebuild test on your Mac, paste the failures.')
    expect(next.context?.[0]).toContain('LoginTests.testExpiredToken failed')
  })

  test('a saved answer riding a typed prompt that a hook beneath drops waits for the next one', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed' })
    await clock.advance(1000)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    world.refusingTyped = 'Blocked by your organization.'
    const blocked = await $.prompt.submit(typed('now the cart'))

    expect(blocked.drop).toBe('Blocked by your organization.')
    // The engine shows why the prompt didn't enter; the answer waits, as it did.
    expect(world.toasts).toEqual([])
    expect(world.status).toBe('☐ 1 task for you · 1 not sent yet · /my-tasks')

    world.refusingTyped = undefined
    const next = await $.prompt.submit(typed('now the cart'))

    expect(next.context?.[0]).toContain('LoginTests.testExpiredToken failed')
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })

  test('a saved answer that a hook beneath takes out of a typed prompt waits for the next one, and a toast says so', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed' })
    await clock.advance(1000)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    world.isStripping = true
    const stripped = await $.prompt.submit(typed('now the cart'))

    expect(stripped.context).toBeUndefined()
    expect(world.toasts.at(-1)).toBe("Claude didn't get your response to #1: a hook took it out of the prompt. It's saved; press Send now in /my-tasks.")
    expect(world.status).toBe('☐ 1 task for you · 1 not sent yet · /my-tasks')

    world.isStripping = false
    const next = await $.prompt.submit(typed('now the cart'))

    expect(next.context?.[0]).toContain('LoginTests.testExpiredToken failed')
  })

  test('a saved answer a hook beneath takes out of a typed prompt that quotes its head still waits for the next one', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed' })
    await clock.advance(1000)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    world.isStripping = true
    const stripped = await $.prompt.submit(typed('Earlier you wrote "#1 done: Run xcodebuild test on your Mac, paste the failures." Why?'))

    expect(stripped.context).toBeUndefined()
    expect(world.status).toBe('☐ 1 task for you · 1 not sent yet · /my-tasks')
  })

  test('a saved answer that a hook beneath rewrites as it rides a typed prompt reaches Claude', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed with token abc123' })
    await clock.advance(1000)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    world.rewriting = text => text.replace('abc123', '******')
    const next = await $.prompt.submit(typed('now the cart'))

    expect(next.context?.[0]).toContain('LoginTests.testExpiredToken failed with token ******')
    expect(world.toasts).toEqual([])
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })

  test('of two saved answers riding a typed prompt, the one a hook beneath takes out waits for the next', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(PAGING_TASK)
    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed' })
    await ui.press({ key: 'option-1' })
    await clock.advance(1000)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    // A hook beneath cuts #2's line out of what rides along.
    world.rewriting = text => text.split('\n').filter(line => !line.startsWith('#2 ')).join('\n')
    const next = await $.prompt.submit(typed('now the cart'))

    expect(next.context?.[0]).toContain('LoginTests.testExpiredToken failed')
    expect(next.context?.[0]).not.toContain('#2 ')
    expect(world.toasts.at(-1)).toBe("Claude didn't get your response to #2: a hook took it out of the prompt. It's saved; press Send now in /my-tasks.")
    expect(world.status).toBe('☐ 1 task for you · 1 not sent yet · /my-tasks')

    world.rewriting = undefined
    const again = await $.prompt.submit(typed('and the docs'))

    expect(again.context?.[0]).toContain('#2 done: Pick a pagination strategy for /feed. The user chose: Cursor')
    expect(again.context?.[0]).not.toContain('LoginTests.testExpiredToken failed')
  })

  test('a response a hook beneath takes out of the message that wakes Claude waits for Send now: the turn that message starts ends without sending it again', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    // A hook beneath masks the key's name in every prompt, the plugin's own among them.
    world.masking = text => text.replaceAll('STRIPE_SECRET_KEY', '*****')
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toHaveLength(1)
    expect(world.toasts.at(-1)).toBe("Claude didn't get your response to #1: a hook took it out of the prompt. It's saved; press Send now in /my-tasks.")

    // The turn that message starts ends, and another after it.
    for (const turnId of ['t1', 't2']) {
      await $.turn.start({ text: '', turnId })
      await $.turn.complete({ ...DONE, turnId })
      await clock.settle()
    }

    expect(world.submitted).toHaveLength(1)
    expect(world.status).toBe('✓ 1 not sent yet · /my-tasks')

    world.masking = undefined
    await ui.press({ key: 'send-1' })
    await clock.settle()

    expect(world.submitted).toHaveLength(2)
    expect(world.status).toBeUndefined()
  })

  test('a typed prompt that fails beneath keeps its own error, and its answer waits, though the store fails too', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed' })
    await clock.advance(1000)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    world.isTypedFailing = true
    world.isStoreFailing = true
    await expect($.prompt.submit(typed('now the cart'))).rejects.toThrow('no implementation for prompt.submit')

    expect(world.toasts.at(-1)).toContain("Claude didn't get your response to #1: no implementation for prompt.submit")
    expect(world.toasts.at(-1)).toContain("It's saved; press Send now in /my-tasks.")
    expect(world.status).toBe('☐ 1 task for you · 1 not sent yet · /my-tasks')

    world.isTypedFailing = false
    world.isStoreFailing = false
    const next = await $.prompt.submit(typed('now the cart'))

    expect(next.context?.[0]).toContain('LoginTests.testExpiredToken failed')
  })

  test("of two saved responses, the first row's Send now answers s and the other a click", async ($, on) => {
    seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(PAGING_TASK)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'Two failures' })
    await ui.press({ key: 'option-1' })

    expect((await ui.find({ type: 'Button', key: 'send-1' }))?.props.hotkey).toBe('s')
    expect((await ui.find({ type: 'Button', key: 'send-2' }))?.props.hotkey).toBeUndefined()
  })

  test('Send now while Claude works reaches it in the turn', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)

    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'CartTests.testCouponRounding', kind: 'change' })
    await ui.press({ key: 'other-way' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.appended.map(row => row.type)).toEqual(['user', 'system'])
    expect(world.appended[0]?.text).toContain('CartTests.testCouponRounding')
    expect(world.appended[1]?.text).toBe('Sent your response to #1 to Claude')
    expect(world.toasts).toHaveLength(0)

    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    // Claude has the row already, so the answer doesn't go again; but no step
    // read it before the turn ended, so a one-line prompt wakes Claude for it.
    expect(world.submitted).toEqual(['I answered a task while you were finishing your reply; my answer is above.'])
  })

  test('a prompt typed while Send now joins the turn carries no second copy of the answer', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed' })
    await clock.advance(1000)

    // The row takes a moment to join the conversation, and the user types meanwhile.
    world.appendMs = 500
    await ui.press({ key: 'send-1' })
    await clock.settle()
    const typedMeanwhile = await $.prompt.submit(typed('and the cart', 't1'))
    await clock.advance(500)

    expect(typedMeanwhile.context).toBeUndefined()
    expect(world.appended.filter(row => row.type === 'user')).toHaveLength(1)
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })

  test('Send now that the running turn refuses goes the moment the turn ends', async ($, on) => {
    const { world, clock } = seat(on)
    world.refusingRows = 'No conversation to append to.'
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)

    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'CartTests.testCouponRounding', kind: 'change' })
    await ui.press({ key: 'other-way' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.toasts.at(-1)).toBe('Claude gets your response to #1 when it finishes this turn.')
    expect(world.appended).toHaveLength(0)
    expect(world.submitted).toHaveLength(0)

    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    expect(world.submitted).toHaveLength(1)
    expect(world.submitted[0]).toContain('CartTests.testCouponRounding')
  })

  test('Send now that the running turn refuses as it ends goes at once', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'CartTests.testCouponRounding', kind: 'change' })

    // The row is refused a moment after it goes, and the turn ends meanwhile.
    world.refusingRows = 'No conversation to append to.'
    world.appendMs = 500
    await ui.press({ key: 'other-way' })
    await clock.advance(800)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.advance(500)
    await clock.settle()

    expect(world.submitted).toHaveLength(1)
    expect(world.submitted[0]).toContain('CartTests.testCouponRounding')
    expect(world.status).toBeUndefined()
  })

  test('Send now pressed twice at once sends the answer once', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed' })
    await clock.advance(1000)

    await Promise.all([ui.press({ key: 'send-1' }), ui.press({ key: 'send-1' })])
    await clock.settle()

    expect(world.appended.filter(row => row.type === 'user')).toHaveLength(1)
  })

  test('a choice and a rejection reach Claude together', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(PAGING_TASK)
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)

    await ui.press({ key: 'option-1' })
    await ui.press({ key: 'reject' })
    await ui.input({ key: 'reason-2', text: 'I will do it after the deploy' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toHaveLength(1)
    expect(world.submitted[0]).toContain('#1 Pick a pagination strategy for /feed: I chose "Cursor".')
    expect(world.submitted[0]).toContain("#2 Add STRIPE_SECRET_KEY to .env: I won't do this. I will do it after the deploy")
  })

  test("a response whose prompt doesn't enter stays saved, and Send now tries again", async ($, on) => {
    const { world, clock } = seat(on)
    world.refusing = 'Another plugin held the prompt.'
    await start($)

    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toHaveLength(0)
    expect(world.toasts.at(-1)).toBe(
      "Claude didn't get your response to #1: Another plugin held the prompt. It's saved; press Send now in /my-tasks.",
    )
    expect(world.status).toBe('✓ 1 not sent yet · /my-tasks')

    world.refusing = undefined
    await runTasks($)
    await ui.press({ key: 'send-1' })
    await clock.settle()

    expect(world.submitted).toEqual(['My response to a task you gave me (Human in the loop):\n\n#1 Add STRIPE_SECRET_KEY to .env: Done.'])
    expect(world.status).toBeUndefined()
  })

  test('an answer that looks like a secret is held', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: KEY_SHAPED })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toHaveLength(0)
    expect(await textOf(ui, 'held')).toContain('looks like a secret')
  })

  test('list_tasks shows a saved answer and marks it heard', async ($, on) => {
    const { world } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'Two failures' })

    const listed = await $.tool.call({ tool: LIST })
    expect(String((listed as { result?: unknown }).result)).toContain('Two failures')
    expect(world.isPaneOpen).toBe(false)
  })

  test('list_tasks for one task marks only that one heard', async ($, on) => {
    const { world } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(PAGING_TASK)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'Two failures' })
    await ui.press({ key: 'option-1' })

    expect(world.status).toBe('✓ 2 not sent yet · /my-tasks')

    const listed = await $.tool.call({ tool: LIST, id: 1 })
    expect(String((listed as { result?: unknown }).result)).toContain('Two failures')
    expect(world.status).toBe('✓ 1 not sent yet · /my-tasks')
  })

  test('a response that comes in while list_tasks reads is not marked heard: it goes later', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'Two failures' })
    // list_tasks reads the task list late: Done on #2 lands meanwhile, and
    // its write of #1 heard reads the list again.
    world.slowRead = 'tasks'
    world.readMs = 500
    const listed = $.tool.call({ tool: LIST })
    await clock.advance(1)
    await ui.press({ key: 'done' })
    await clock.advance(500)
    const result = String(((await listed) as { result?: unknown }).result)

    expect(result).toContain('Two failures')
    expect(result).toContain('#2 open')
    expect(world.status).toBe('✓ 1 not sent yet · /my-tasks')

    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    expect(world.submitted).toEqual(['My response to a task you gave me (Human in the loop):\n\n#2 Add STRIPE_SECRET_KEY to .env: Done.'])
  })

  test('a withdraw that meets an answer given a moment before leaves the answer, and Claude hears it', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    // The withdraw reads the task list late: Done lands meanwhile.
    world.slowRead = 'tasks'
    world.readMs = 500
    const withdrawn = $.tool.call({ tool: WITHDRAW, id: 1, reason: 'Found the key in the vault' })
    await clock.advance(1)
    await ui.press({ key: 'done' })
    await clock.advance(500)

    expect(((await withdrawn) as { deny?: string }).deny).toBe('Task #1 is already done; there is nothing to withdraw.')
    expect(world.toasts).toEqual([])

    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    expect(world.submitted).toEqual(['My response to a task you gave me (Human in the loop):\n\n#1 Add STRIPE_SECRET_KEY to .env: Done.'])
  })

  test('a press from a render older than a withdraw leaves the task withdrawn, and a toast says so', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    // Done reads the task list late: Claude withdraws #1 meanwhile.
    world.slowRead = 'tasks'
    world.readMs = 500
    const pressed = ui.press({ key: 'done' })
    await clock.advance(1)
    await $.tool.call({ tool: WITHDRAW, id: 1 })
    await clock.advance(500)
    await pressed
    await clock.settle()

    expect(world.toasts.at(-1)).toBe("Task #1 isn't open any more, so your response wasn't saved.")
    expect(world.submitted).toEqual([])
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })

  test('Save for later with nothing typed asks for an answer, or, pressed as Claude withdraws its task, says the task is gone', async ($, on) => {
    const { world } = seat(on)
    const held = holdingPresses(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.press({ key: 'other-way' })

    expect(world.toasts.at(-1)).toBe('Type an answer first, or press Cancel.')

    held.isOn = true
    const pressed = ui.press({ key: 'other-way' })
    await $.tool.call({ tool: WITHDRAW, id: 1 })
    held.letGo()
    await pressed

    expect(world.toasts.at(-1)).toBe("Task #1 isn't open any more, so your response wasn't saved.")
  })

  test('Save for later pressed as Claude withdraws its task puts what was typed in the prompt box', async ($, on) => {
    const { world, clock } = seat(on)
    const held = holdingPresses(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed', kind: 'change' })
    await clock.settle()
    // Save for later reaches its button as Claude withdraws the task, the
    // draft gone with it, before the drawing that withdraw wakes.
    held.isOn = true
    const pressed = ui.press({ key: 'other-way' })
    await $.tool.call({ tool: WITHDRAW, id: 1 })
    held.letGo()
    await pressed

    expect(world.toasts.at(-1)).toBe("Task #1 isn't open any more, so your response wasn't saved. What you typed is in the prompt box.")
    expect(world.composer).toBe('LoginTests.testExpiredToken failed')
  })

  test('Long answer… pressed as Claude withdraws its task says the task is gone, and puts what was typed in the prompt box', async ($, on) => {
    const { world, clock } = seat(on)
    const held = holdingPresses(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed', kind: 'change' })
    await clock.settle()
    held.isOn = true
    const pressed = ui.press({ key: 'long' })
    await $.tool.call({ tool: WITHDRAW, id: 1 })
    held.letGo()
    await pressed

    expect(world.toasts.at(-1)).toBe("Task #1 isn't open any more, so your response wasn't saved. What you typed is in the prompt box.")
    expect(world.composer).toBe('LoginTests.testExpiredToken failed')
  })

  test('a title pressed as Claude withdraws its task leaves the field open on another task', async ($, on) => {
    const { world, clock } = seat(on)
    const held = holdingPresses(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'select-2' })
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-2', text: 'Pixel 8 passes', kind: 'change' })
    await clock.settle()
    held.isOn = true
    const pressed = ui.press({ key: 'select-1' })
    await $.tool.call({ tool: WITHDRAW, id: 1 })
    held.letGo()
    await pressed

    expect(await ui.find({ type: 'Input', key: 'answer-2' })).toBeDefined()
    expect(world.toasts.at(-1)).toBe('Claude withdrew the task: Run xcodebuild test on your Mac, paste the failures')
  })

  test('Save for later pressed as the same answer lands from the prompt box says nothing, as a second press does', async ($, on) => {
    const { world, clock } = seat(on)
    const held = holdingPresses(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'Two failures', kind: 'change' })
    await clock.settle()
    held.isOn = true
    const pressed = ui.press({ key: 'other-way' })
    await $.prompt.submit(typed('↳ Answer to #1: Two failures'))
    held.letGo()
    await pressed

    expect(world.toasts).toEqual([])
    expect(world.composer).toBe('')
  })

  test('an answer held for looking like a secret, entered as Claude withdraws its task, says the task is gone', async ($, on) => {
    const { world } = seat(on)
    // Held, an input reaches its field once the test lets it go.
    let isHeld = false
    let letGo = () => {}
    on('ui.input', { plugin: '*' }, async ($, e, next) => {
      if (isHeld) {
        isHeld = false
        await new Promise<void>(resolve => {
          letGo = resolve
        })
      }

      return next(e)
    })
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    isHeld = true
    const entered = ui.input({ key: 'answer-1', text: KEY_SHAPED })
    await $.tool.call({ tool: WITHDRAW, id: 1 })
    letGo()
    await entered

    expect(world.toasts.at(-1)).toBe("Task #1 isn't open any more, so your response wasn't saved.")
    expect(world.composer).toBe('')
  })

  test('a task withdrawn as the user types for it takes the drafts along, and leaves the prompt box as the user has it', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed', kind: 'change' })
    await ui.press({ key: 'cancel' })
    await ui.press({ key: 'reject' })
    await ui.input({ key: 'reason-1', text: 'Not on this Mac', kind: 'change' })
    await clock.settle()
    world.composer = 'Also bump the version'
    await $.tool.call({ tool: WITHDRAW, id: 1, reason: 'Found it in the CI logs' })

    expect(world.composer).toBe('Also bump the version')
    expect(world.toasts.at(-1)).toBe('Claude withdrew the task: Run xcodebuild test on your Mac, paste the failures. Found it in the CI logs')
  })

  test("of two presses from one render, the response that lands first stands, and a toast says the other wasn't saved", async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(PAGING_TASK)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    // Offset reads the task list late: Cursor lands meanwhile.
    world.slowRead = 'tasks'
    world.readMs = 500
    const pressed = ui.press({ key: 'option-2' })
    await clock.advance(1)
    await ui.press({ key: 'option-1' })
    await clock.advance(500)
    await pressed
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    expect(world.submitted).toEqual(['My response to a task you gave me (Human in the loop):\n\n#1 Pick a pagination strategy for /feed: I chose "Cursor".'])
    expect(world.toasts).toEqual(["Task #1 isn't open any more, so your response wasn't saved."])
  })

  test('the same press twice from one render answers once, says nothing, and holds back no batch under way', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(PAGING_TASK)
    const ui = await $.ui.mount(PANE)
    // The first press reads the task list late: the second lands meanwhile, and the batch starts.
    world.slowRead = 'tasks'
    world.readMs = 500
    const pressed = ui.press({ key: 'option-1' })
    await clock.advance(1)
    world.ops = []
    await ui.press({ key: 'option-1' })
    await clock.advance(500)
    await pressed

    // The press that found it answered changed nothing, so wrote nothing.
    expect(world.ops).toEqual([`set ${keysOf('/repo').session('session-1')}`])

    await clock.advance(300)

    expect(world.submitted).toEqual(['My response to a task you gave me (Human in the loop):\n\n#1 Pick a pagination strategy for /feed: I chose "Cursor".'])
    expect(world.toasts).toEqual([])
  })

  test("an answer typed for a task answered meanwhile on another surface isn't saved: a toast says so, and it goes to the prompt box", async ($, on) => {
    const { world, clock } = seat(on)
    world.composer = 'and check the cart'
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    const phone = await $.ui.mount({ ...PANE, surface: 'mobile' })
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'Two failures', kind: 'change' })
    await clock.settle()
    // The answer reads the task list late: Done on the phone lands meanwhile.
    world.slowRead = 'tasks'
    world.readMs = 500
    const answered = ui.input({ key: 'answer-1', text: 'Two failures' })
    await clock.advance(1)
    await phone.press({ key: 'done' })
    await clock.advance(500)
    await answered
    await clock.advance(1000)

    expect(world.toasts).toEqual(["Task #1 isn't open any more, so your response wasn't saved. What you typed is in the prompt box."])
    expect(world.composer).toBe('and check the cart\nTwo failures')
    expect(world.submitted).toEqual(['My response to a task you gave me (Human in the loop):\n\n#1 Run xcodebuild test on your Mac, paste the failures: Done.'])
  })

  test('an answer held for looking like a secret, sent anyway as its task is answered elsewhere, stays out of the prompt box', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    const phone = await $.ui.mount({ ...PANE, surface: 'mobile' })
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: KEY_SHAPED })
    await clock.settle()
    // Send anyway reads the task list late: Done on the phone lands meanwhile.
    world.slowRead = 'tasks'
    world.readMs = 500
    const sent = ui.press({ key: 'send-anyway' })
    await clock.advance(1)
    await phone.press({ key: 'done' })
    await clock.advance(500)
    await sent

    expect(world.toasts).toEqual(["Task #1 isn't open any more, so your response wasn't saved."])
    expect(world.composer).toBe('')
  })

  test('Send now repeating an answer saved for later a moment before sends it', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'Two failures', kind: 'change' })
    await clock.settle()
    // Send now reads the task list late: Enter saves the same answer meanwhile.
    world.slowRead = 'tasks'
    world.readMs = 500
    const pressed = ui.press({ key: 'other-way' })
    await clock.advance(1)
    await ui.input({ key: 'answer-1', text: 'Two failures' })
    await clock.advance(500)
    await pressed
    await clock.advance(1000)
    await clock.settle()

    expect(world.appended.map(row => row.type)).toEqual(['user', 'system'])
    expect(world.appended[0]?.text).toContain('Two failures')
    expect(world.toasts).toEqual([])
  })
})

describe('long answers in the prompt box', () => {
  test('typed while Claude is idle, the prompt is the answer', async ($, on) => {
    const { world } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.press({ key: 'long' })
    expect(world.composer).toBe('↳ Answer to #1: ')

    const sent = await $.prompt.submit(typed('↳ Answer to #1: LoginTests.testExpiredToken\nCartTests.testCouponRounding'))

    expect(sent.text).toContain('#1 Run xcodebuild test on your Mac, paste the failures:\nLoginTests.testExpiredToken\nCartTests.testCouponRounding')
  })

  test('a draft goes with Long answer… into the prompt box, and the field opens empty after', async ($, on) => {
    const { world } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken', kind: 'change' })
    await ui.press({ key: 'long' })

    expect(world.composer).toBe('↳ Answer to #1: LoginTests.testExpiredToken')

    await ui.press({ key: 'answer' })

    expect((await ui.find({ type: 'Input', key: 'answer-1' }))?.props.value).toBe('')
  })

  test('typed while Claude is idle and dropped by a hook beneath, the answer is kept to send', async ($, on) => {
    const { world } = seat(on)
    world.refusingTyped = 'Blocked by your organization.'
    await start($)

    await $.tool.call(XCODE_TASK)
    const blocked = await $.prompt.submit(typed('↳ Answer to #1: Two failures'))

    expect(blocked.drop).toBe('Blocked by your organization.')
    // The engine shows why; the toast says the answer is kept.
    expect(world.toasts.at(-1)).toBe("Claude didn't get your response to #1. It's saved; press Send now in /my-tasks.")
    expect(world.status).toBe('✓ 1 not sent yet · /my-tasks')
  })

  test('typed while Claude is idle and a response is about to go, the prompt carries both', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    // Done goes in a moment, with whatever else is pressed by then.
    await ui.press({ key: 'done' })
    world.setMs = 1000
    const sending = $.prompt.submit(typed('↳ Answer to #2: Two failures'))
    await clock.advance(3000)
    const sent = await sending
    await clock.settle()

    expect(sent.text).toContain('#1 Add STRIPE_SECRET_KEY to .env: Done.')
    expect(sent.text).toContain('#2 Run xcodebuild test on your Mac, paste the failures:\nTwo failures')
    expect(world.submitted).toEqual([])
  })

  test('typed while Claude is idle as Send now takes the same answer, it goes once', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    world.setMs = 1000
    const sending = $.prompt.submit(typed('↳ Answer to #2: Two failures'))
    await clock.settle()
    await ui.press({ key: 'send-2' })
    await clock.advance(3000)
    const sent = await sending
    await clock.settle()

    expect(sent.drop).toBe('Your answer to #2 already went to Claude.')
    expect(world.submitted).toEqual([
      'My response to a task you gave me (Human in the loop):\n\n#2 Run xcodebuild test on your Mac, paste the failures:\nTwo failures',
    ])
  })

  test('typed while Claude works, it is saved instead of sent', async ($, on) => {
    seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const result = await $.prompt.submit(typed('↳ Answer to #1: Two failures', 't1'))

    expect(result.drop).toContain('Saved as your answer to #1')

    const listed = await $.tool.call({ tool: LIST })
    expect(String((listed as { result?: unknown }).result)).toContain('Two failures')
  })

  test('typed while Claude works, an answer to a task Claude withdraws meanwhile goes as typed', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.turn.start({ text: 'go', turnId: 't1' })
    // The prompt reads the task list late: Claude withdraws #1 meanwhile.
    world.slowRead = 'tasks'
    world.readMs = 500
    const sending = $.prompt.submit(typed('↳ Answer to #1: Two failures', 't1'))
    await clock.advance(1)
    await $.tool.call({ tool: WITHDRAW, id: 1 })
    await clock.advance(500)
    const sent = await sending
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    expect(sent.drop).toBeUndefined()
    expect(sent.text).toBe('↳ Answer to #1: Two failures')
    expect(sent.context).toBeUndefined()
    expect(world.submitted).toEqual([])
  })
})

describe('the system prompt', () => {
  const COMPOSE = {
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    outputStyle: null,
  } as const

  test('tells Claude to assign what only the user can do, where the tool can be reached', async ($, on) => {
    seat(on)
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
    await start($)

    const offered = await $.prompt.compose({ ...COMPOSE, tools: ['Bash', ASSIGN], traits: [] })
    const deferred = await $.prompt.compose({ ...COMPOSE, tools: ['Bash', 'ToolSearch'], traits: [] })
    const headless = await $.prompt.compose({ ...COMPOSE, tools: ['Bash', ASSIGN], traits: ['print'] })
    const without = await $.prompt.compose({ ...COMPOSE, tools: ['Bash'], traits: [] })

    expect(offered.sections.at(-1)?.id).toBe('human-in-the-loop:tasks')
    expect(offered.sections.at(-1)?.scope).toBe('session')
    expect(offered.sections.at(-1)?.text).toContain('assign it with mcp__human-in-the-loop__assign_task so it stays in front of them')
    expect(offered.sections.at(-1)?.text).toContain('or opens it with /my-tasks')
    expect(offered.sections.at(-1)?.text).toContain('review or approve your work: assign it as a task even when you also ask in your reply')
    expect(deferred.sections.at(-1)?.id).toBe('human-in-the-loop:tasks')
    expect(headless.sections).toHaveLength(1)
    expect(without.sections).toHaveLength(1)
  })
})

describe('across sessions', () => {
  const KEYS = keysOf('/repo')
  const MINE = KEYS.session('session-1')

  /** This version's slots, by session id. */
  function slotsIn(store: Record<string, unknown>) {
    return projectOf('/repo', store).slots
  }

  /** A task as a note of what was taken names it. */
  function refOf(task: { id: number; createdMs: number }) {
    return { id: task.id, createdMs: task.createdMs }
  }

  test("the first store layout's open tasks come back in the next session, and Claude is told", async ($, on) => {
    const { world } = seat(on, {
      'tasks:/repo': {
        nextId: 8,
        tasks: [
          null,
          {
            id: 7,
            title: 'Rotate the leaked token in Vault',
            why: 'It was in a public gist.',
            kind: 'do',
            state: 'open',
            update: 'none',
            sessionId: 'session-0',
            createdMs: 0,
            updatedMs: 0,
          },
        ],
      },
    })
    await start($)

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(world.opens.at(-1)?.id).toBe('my-tasks')

    const ui = await $.ui.mount(PANE)
    expect(await textOf(ui, 'task-7')).toContain('from an earlier session')

    const context = await $.prompt.context({ blocks: [] })
    expect(context.blocks.at(-1)?.text).toContain('#7 open (from an earlier session): Rotate the leaked token in Vault')

    const assigned = await $.tool.call(KEY_TASK)
    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #8')
    expect(world.store['tasks:/repo']).toEqual({ nextId: 8, sessions: {}, taken: {} })
  })

  test("a live session's tasks stay in it: this one counts them but neither shows nor answers them", async ($, on) => {
    const { world } = seat(on, {
      'tasks:/repo': { nextId: 8, sessions: { 'session-0': { tasks: [ROTATE], seenMs: NOW - 30_000 } } },
    })
    await start($)

    expect(world.opens).toHaveLength(0)
    expect(world.status).toBe('1 task in another session')

    const context = await $.prompt.context({ blocks: [] })
    expect(context.blocks).toHaveLength(0)

    const assigned = await $.tool.call(KEY_TASK)
    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #8')
    expect(world.status).toBe('☐ 1 task for you · /my-tasks · 1 task in another session')

    // 0.1.4's value keeps its live session's slot as it wrote it, its count raised past #8, which
    // that session numbers from; this session's slot has a key of its own.
    expect(world.store['tasks:/repo']).toEqual({ nextId: 9, sessions: { 'session-0': { tasks: [ROTATE], seenMs: NOW - 30_000 } }, taken: {} })
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.id)).toEqual([8])
    expect(slotsIn(world.store)['session-1']?.nextId).toBe(9)
  })

  test("another session's write landing between this one's read and write stays", async ($, on) => {
    const { world, clock } = seat(on, { [KEYS.session('session-0')]: { tasks: [ROTATE], seenMs: NOW - 30_000 } })
    await start($)
    await $.tool.call(KEY_TASK)

    // Session 0 saves an answer while this session's heartbeat is between its read and its write.
    const answered = { ...ROTATE, state: 'done', update: 'pending' }
    world.landing = () => {
      world.store[KEYS.session('session-0')] = { tasks: [answered], seenMs: NOW + 30_000 }
    }
    await clock.advance(60_000)
    await clock.settle()

    expect(world.landing).toBeUndefined()
    expect(slotsIn(world.store)['session-0']).toEqual({ tasks: [answered], seenMs: NOW + 30_000 })
    expect(slotsIn(world.store)['session-1']?.seenMs).toBe(NOW + 60_000)
  })

  test("an ended 0.1.4 session's tasks, and a quiet one's, are taken on by the next session", async ($, on) => {
    const { world } = seat(on, {
      'tasks:/repo': {
        nextId: 9,
        sessions: {
          'session-0': { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000 },
          'session-x': { tasks: [{ ...ROTATE, id: 8, title: 'Approve the staging migration', sessionId: 'session-x' }], seenMs: NOW - 10 * 60_000 },
        },
      },
    })
    await start($)

    const ui = await $.ui.mount(PANE)
    expect(world.status).toBe('☐ 2 tasks for you · /my-tasks')
    expect(await textOf(ui, 'task-7')).toContain('from an earlier session')

    // The quiet one may come back (a laptop asleep), on 0.1.4: its value notes what it lets go of then.
    expect(world.store['tasks:/repo']).toEqual({ nextId: 9, sessions: {}, taken: { 'session-x': { ids: [8], atMs: NOW } } })
    expect(slotsIn(world.store)['session-1']?.took).toEqual({
      'session-0': { tasks: [refOf(ROTATE)], atMs: NOW, isEnded: true },
      'session-x': { tasks: [{ id: 8, createdMs: 0 }], atMs: NOW },
    })
  })

  test("an ended session's slot leaves once the next session's is written; a quiet one's stays until it comes back", async ($, on) => {
    const quiet = { ...ROTATE, id: 8, title: 'Approve the staging migration', sessionId: 'session-x' }
    const { world, clock } = seat(on, {
      [KEYS.session('session-0')]: { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 },
      [KEYS.session('session-x')]: { tasks: [quiet], seenMs: NOW - 10 * 60_000, nextId: 9 },
    })
    await start($)

    expect(world.status).toBe('☐ 2 tasks for you · /my-tasks')
    expect(Object.keys(slotsIn(world.store)).sort()).toEqual(['session-1', 'session-x'])
    expect(slotsIn(world.store)['session-1']?.took).toEqual({
      'session-0': { tasks: [refOf(ROTATE)], atMs: NOW, isEnded: true },
      'session-x': { tasks: [refOf(quiet)], atMs: NOW },
    })

    // The quiet one comes back and lets its task go: the notes have done their work.
    world.store[KEYS.session('session-x')] = { tasks: [], seenMs: NOW + 30_000, nextId: 9 }
    await clock.advance(60_000)
    await clock.settle()

    expect(slotsIn(world.store)['session-1']?.took).toBeUndefined()
    expect(world.status).toBe('☐ 2 tasks for you · /my-tasks')
  })

  test('where two sessions drew one number, the session taking on both gives the later a new one', async ($, on) => {
    seat(on, {
      'tasks:/repo': {
        nextId: 8,
        sessions: {
          'session-0': { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000 },
          'session-x': {
            tasks: [{ ...ROTATE, title: 'Approve the staging migration', sessionId: 'session-x' }],
            seenMs: NOW - 60_000,
            endedMs: NOW - 60_000,
          },
        },
      },
    })
    await start($)

    const context = await $.prompt.context({ blocks: [] })
    expect(context.blocks.at(-1)?.text).toContain('#7 open (from an earlier session): Rotate the leaked token in Vault')
    expect(context.blocks.at(-1)?.text).toContain('#8 open (from an earlier session): Approve the staging migration')

    const assigned = await $.tool.call(KEY_TASK)
    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #9')
  })

  test('a slot its session writes again after this one read it stays', async ($, on) => {
    const { world } = seat(on, { [KEYS.session('session-x')]: { tasks: [], seenMs: NOW - 10 * 60_000, nextId: 9 } })
    // Session x comes back as this session writes its slot, before x's empty one is removed.
    world.landing = () => {
      world.store[KEYS.session('session-x')] = { tasks: [], seenMs: NOW, nextId: 9 }
    }
    await start($)

    expect(world.landing).toBeUndefined()
    expect(slotsIn(world.store)['session-x']).toEqual({ tasks: [], seenMs: NOW, nextId: 9 })
  })

  test('a store that fails as the session starts: the heartbeat takes the project on once it answers, with what was assigned meanwhile', async ($, on) => {
    const { world, clock } = seat(on, {
      [KEYS.session('session-0')]: { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 },
    })
    world.isStoreFailing = true
    await start($)

    expect(world.status).toBeUndefined()

    // Numbered without the project's count, which the store didn't give.
    const assigned = await $.tool.call(KEY_TASK)
    world.isStoreFailing = false
    await clock.advance(60_000)
    await clock.settle()

    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #1')
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-1'])
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.id)).toEqual([1, 7])
    expect(slotsIn(world.store)['session-1']?.seenMs).toBe(NOW + 60_000)
    expect(world.status).toBe('☐ 2 tasks for you · /my-tasks')
  })

  test('a session that reads the project late keeps the tasks it was done with, and no task it takes on gets their numbers', async ($, on) => {
    const { world, clock } = seat(on, {
      [KEYS.session('session-0')]: { tasks: [{ ...ROTATE, id: 2 }], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 3 },
    })
    world.isStoreFailing = true
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)
    await $.tool.call(PAGING_TASK)
    await $.tool.call({ tool: WITHDRAW, id: 2, reason: 'Ran it in CI' })
    await $.tool.call({ tool: WITHDRAW, id: 3, reason: 'Went with cursor' })
    world.isStoreFailing = false
    await clock.advance(60_000)
    await clock.settle()

    for (const [id, title] of [[2, XCODE_TASK.title], [3, PAGING_TASK.title], [4, ROTATE.title]] as const) {
      const listed = await $.tool.call({ tool: LIST, id })
      expect(String((listed as { result?: unknown }).result)).toContain(title)
    }
  })

  test('a store that fails as the session starts: once the heartbeat reads the project, the pane opens for what it took on', async ($, on) => {
    const { world, clock } = seat(on, {
      [KEYS.session('session-0')]: { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 },
    })
    world.isStoreFailing = true
    await start($)

    world.isStoreFailing = false
    await clock.advance(60_000)
    await clock.settle()

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(world.opens.at(-1)?.id).toBe('my-tasks')
    expect(world.opens.at(-1)?.focus).toBeUndefined()
  })


  test('a store that fails as the session starts, then refuses writes: once the heartbeat reads the project, the pane opens for what it took on', async ($, on) => {
    const { world, clock } = seat(on, {
      [KEYS.session('session-0')]: { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 },
    })
    world.isStoreFailing = true
    await start($)

    world.isStoreFailing = false
    world.isWriteFailing = true
    await clock.advance(60_000)
    await clock.settle()

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(world.opens.at(-1)?.id).toBe('my-tasks')
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-0'])

    // The next heartbeat makes the writes, and the slot it took the task from leaves.
    world.isWriteFailing = false
    await clock.advance(60_000)
    await clock.settle()

    expect(Object.keys(slotsIn(world.store))).toEqual(['session-1'])
    expect(slotsIn(world.store)['session-1']?.tasks).toEqual([ROTATE])
  })

  test('a resumed session keeps its notes of what it took', async ($, on) => {
    const quiet = { ...ROTATE, id: 8, title: 'Approve the staging migration', sessionId: 'session-x' }
    const note = { tasks: [refOf(quiet)], atMs: NOW - 10 * 60_000 }
    const { world } = seat(on, {
      [KEYS.session('session-x')]: { tasks: [quiet], seenMs: NOW - 20 * 60_000, nextId: 9 },
      [MINE]: { tasks: [quiet], seenMs: NOW - 10 * 60_000, nextId: 9, took: { 'session-x': note } },
    })
    await start($)

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(slotsIn(world.store)['session-1']?.took).toEqual({ 'session-x': note })
  })

  test('a session that took a slot on and stopped before removing it leaves nothing to take on twice', async ($, on) => {
    const { world } = seat(on, {
      [KEYS.session('session-0')]: { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 },
      // Session 9 took session 0's task on, and stopped before it removed session 0's slot.
      [KEYS.session('session-9')]: {
        tasks: [ROTATE],
        seenMs: NOW - 10 * 60_000,
        nextId: 8,
        took: { 'session-0': { tasks: [refOf(ROTATE)], atMs: NOW - 10 * 60_000, isEnded: true } },
      },
    })
    await start($)

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(Object.keys(slotsIn(world.store)).sort()).toEqual(['session-1', 'session-9'])
  })

  test('a session resumed after it ended takes its task back from a quiet session that had taken it, and keeps it', async ($, on) => {
    const mine = { ...ROTATE, sessionId: 'session-1' }
    // Session t took #7 on as this session ended, removed its slot, and went quiet.
    const { world, clock } = seat(on, {
      [KEYS.session('session-t')]: {
        tasks: [mine],
        seenMs: NOW - 10 * 60_000,
        nextId: 8,
        took: { 'session-1': { tasks: [refOf(mine)], atMs: NOW - 50 * 60_000, isEnded: true } },
      },
    })
    await start($)
    await clock.advance(60_000)
    await clock.settle()

    expect(world.toasts).toEqual([])
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.id)).toEqual([7])
  })

  test('a session that takes its task back keeps it, though the write that notes it fails', async ($, on) => {
    const mine = { ...ROTATE, sessionId: 'session-1' }
    const { world, clock } = seat(on, {
      [KEYS.session('session-t')]: {
        tasks: [mine],
        seenMs: NOW - 10 * 60_000,
        nextId: 8,
        took: { 'session-1': { tasks: [refOf(mine)], atMs: NOW - 50 * 60_000, isEnded: true } },
      },
    })
    world.isWriteFailing = true
    await start($)
    world.isWriteFailing = false
    await clock.advance(60_000)
    await clock.settle()

    expect(world.toasts).toEqual([])
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(slotsIn(world.store)['session-1']?.took?.['session-t']?.tasks).toEqual([refOf(mine)])
  })

  test('a session whose task was taken back while it was away lets it go, and its note of taking it with it', async ($, on) => {
    const held = { ...ROTATE, sessionId: 'session-r' }
    const { world, clock } = seat(on, { [KEYS.session('session-r')]: { tasks: [held], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 } })
    await start($)

    // Asleep: session r, resumed, took #7 back.
    world.isStoreFailing = true
    await clock.advance(240_000)
    await clock.settle()
    world.isStoreFailing = false
    world.store[KEYS.session('session-r')] = {
      tasks: [held],
      seenMs: NOW + 240_000,
      nextId: 8,
      took: { 'session-1': { tasks: [refOf(held)], atMs: NOW + 230_000 } },
    }
    await clock.advance(60_000)
    await clock.settle()

    expect(world.toasts.at(-1)).toBe('Another session in this project took on task #7 while this one was away. Answer it there.')
    expect(slotsIn(world.store)['session-1']).toEqual({ tasks: [], seenMs: NOW + 300_000, nextId: 8 })
    expect(world.status).toBe('1 task in another session')

    // Session r drops its note once this slot has let #7 go: #7 is still its own.
    world.store[KEYS.session('session-r')] = { tasks: [held], seenMs: NOW + 330_000, nextId: 8 }
    await clock.advance(60_000)
    await clock.settle()

    expect(world.status).toBe('1 task in another session')
  })

  test('a resumed session whose task was taken back while it was gone holds nothing, and notes nothing as it joins', async ($, on) => {
    const held = { ...ROTATE, sessionId: 'session-r' }
    // This session took #7 on from session r, went quiet, and r, resumed, took it back.
    const { world } = seat(on, {
      [MINE]: { tasks: [held], seenMs: NOW - 20 * 60_000, nextId: 8, took: { 'session-r': { tasks: [refOf(held)], atMs: NOW - 30 * 60_000 } } },
      [KEYS.session('session-r')]: { tasks: [held], seenMs: NOW, nextId: 8, took: { 'session-1': { tasks: [refOf(held)], atMs: NOW - 10 * 60_000 } } },
    })
    await start($)

    expect(world.status).toBe('1 task in another session')
    expect(slotsIn(world.store)['session-1']).toEqual({ tasks: [], seenMs: NOW, nextId: 8 })
  })

  test('a resumed session that holds nothing marks its slot alive as it joins, its count in it', async ($, on) => {
    const { world } = seat(on, {
      [MINE]: { tasks: [], seenMs: NOW - 10 * 60_000, nextId: 8, endedMs: NOW - 10 * 60_000 },
    })
    await start($)

    expect(slotsIn(world.store)['session-1']).toEqual({ tasks: [], seenMs: NOW, nextId: 8 })
  })

  test("a 0.1.4 session's end counts at once, however recently it wrote", async ($, on) => {
    const { world } = seat(on, {
      'tasks:/repo': { nextId: 8, sessions: { 'session-0': { tasks: [ROTATE], seenMs: NOW - 30_000, endedMs: NOW - 10_000 } }, taken: {} },
    })
    await start($)

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(world.store['tasks:/repo']).toEqual({ nextId: 8, sessions: {}, taken: {} })
  })

  test("a session 0.1.4 kept takes its slot out of 0.1.4's value, resumed or hot reloaded", async ($, on) => {
    const mine = { ...ROTATE, sessionId: 'session-1' }
    const legacy = { nextId: 8, sessions: { 'session-1': { tasks: [mine], seenMs: NOW - 30_000 } }, taken: {} }
    const { world } = seat(on, { 'tasks:/repo': legacy })
    await start($)

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(world.store['tasks:/repo']).toEqual({ nextId: 8, sessions: {}, taken: {} })
    expect(slotsIn(world.store)['session-1']?.tasks).toEqual([mine])

    // Reloaded from 0.1.4, whose last write put its slot back.
    world.store['tasks:/repo'] = legacy
    await start($)

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(world.store['tasks:/repo']).toEqual({ nextId: 8, sessions: {}, taken: {} })
    expect(slotsIn(world.store)['session-1']?.tasks).toEqual([mine])
  })

  /** The store as session 2 leaves it on taking on session 1's tasks (those of `ids`, or all) while session 1 slept. */
  function takeOn(store: Record<string, unknown>, ids?: readonly number[]) {
    const mine = (slotsIn(store)['session-1']?.tasks ?? []).filter(task => ids === undefined || ids.includes(task.id))

    store[KEYS.session('session-2')] = {
      tasks: mine,
      seenMs: NOW,
      nextId: Math.max(...mine.map(task => task.id)) + 1,
      took: { 'session-1': { tasks: mine.map(refOf), atMs: NOW } },
    }
  }

  test('a session back from sleep lets go of the tasks another session took on meanwhile', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)
    takeOn(world.store)
    await clock.advance(60_000)
    await clock.settle()

    expect(world.toasts.at(-1)).toBe('Another session in this project took on tasks #1, #2 while this one was away. Answer them there.')
    expect(world.status).toBe('2 tasks in another session')
    expect(world.isPaneOpen).toBe(false)

    // Its slot stays, empty, to carry its count.
    expect(slotsIn(world.store)['session-1']).toEqual({ tasks: [], seenMs: NOW + 60_000, nextId: 3 })
    expect(slotsIn(world.store)['session-2']?.tasks.map(task => task.id)).toEqual([1, 2])
  })

  test('a task assigned on waking keeps its place, the ones taken on elsewhere go', async ($, on) => {
    const { world } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    takeOn(world.store)
    const assigned = await $.tool.call(XCODE_TASK)

    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #2')
    expect(String((assigned as { result?: unknown }).result)).toContain('Open tasks: 1 of 5.')
    expect(world.toasts.at(-1)).toBe('Another session in this project took on task #1 while this one was away. Answer it there.')
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.id)).toEqual([2])
    expect(slotsIn(world.store)['session-2']?.tasks.map(task => task.id)).toEqual([1])
  })

  test('an assignment Claude already made, on waking, still lets go of what was taken and redraws', async ($, on) => {
    const { world } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)
    takeOn(world.store, [2])
    const again = await $.tool.call(KEY_TASK)

    expect(String((again as { result?: unknown }).result)).toContain('Task #1 already asks the user for this')
    expect(world.toasts.at(-1)).toBe('Another session in this project took on task #2 while this one was away. Answer it there.')
    expect(world.status).toBe('☐ 1 task for you · /my-tasks · 1 task in another session')
    // Nothing was assigned, and the slot no longer holds what was let go.
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.id)).toEqual([1])
  })

  test('a heartbeat that lets tasks go redraws, though its write fails', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)
    // Session 2 took #2 on, and has ended since: nothing in another session to count.
    takeOn(world.store, [2])
    world.store[KEYS.session('session-2')] = { ...(world.store[KEYS.session('session-2')] as object), endedMs: NOW }
    world.isWriteFailing = true
    await clock.advance(60_000)
    await clock.settle()

    expect(world.toasts.at(-1)).toBe('Another session in this project took on task #2 while this one was away. Answer it there.')
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })

  test('a press while a heartbeat lets tasks go is kept', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    takeOn(world.store, [2])
    // The heartbeat reads the task list late as it lets #2 go, after reading
    // it once for its own slot: Done on #1 lands meanwhile.
    world.slowRead = 'tasks'
    world.fastReads = 1
    world.readMs = 500
    await clock.advance(60_000)
    const pressed = ui.press({ key: 'done' })
    await clock.advance(500)
    await pressed
    await clock.advance(1000)
    await clock.settle()

    expect(world.toasts).toContain('Another session in this project took on task #2 while this one was away. Answer it there.')
    expect(world.submitted).toEqual(['My response to a task you gave me (Human in the loop):\n\n#1 Add STRIPE_SECRET_KEY to .env: Done.'])
    expect(world.status).toBe('1 task in another session')
  })

  test('Claude withdrawing, on waking, a task another session took on meanwhile is told it is gone', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    takeOn(world.store)
    world.isStoreFailing = true
    await clock.advance(150_000)
    await clock.settle()
    world.isStoreFailing = false

    const withdrawn = await $.tool.call({ tool: WITHDRAW, id: 1, reason: 'Found it in the vault' })

    expect((withdrawn as { deny?: string }).deny).toBe('No task #1.')
    expect(world.toasts.at(-1)).toBe('Another session in this project took on task #1 while this one was away. Answer it there.')
  })

  test('assigning on waking reads the project once', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    world.isStoreFailing = true
    await clock.advance(150_000)
    await clock.settle()
    world.isStoreFailing = false
    world.ops = []
    await $.tool.call(XCODE_TASK)

    expect(world.ops).toEqual(['keys', `get ${MINE}`, `set ${MINE}`])
  })

  test('a pane press waking the session after two heartbeats lets go of what was taken first', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    takeOn(world.store)
    // Asleep: no heartbeat has written the slot since.
    world.isStoreFailing = true
    await clock.advance(120_000)
    await clock.settle()
    world.isStoreFailing = false

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.toasts.some(toast => toast.includes('took on task #1 while this one was away'))).toBe(true)
    expect(world.submitted).toHaveLength(0)
  })

  test('a prompt typed on waking carries no answer to a task another session took on meanwhile', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed' })
    await clock.advance(1000)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    // Asleep: session 2 took both on, the saved answer with them.
    takeOn(world.store)
    world.isStoreFailing = true
    await clock.advance(150_000)
    await clock.settle()
    world.isStoreFailing = false

    const next = await $.prompt.submit(typed('now the cart'))

    expect(next.context).toBeUndefined()
    expect(world.toasts.at(-1)).toBe('Another session in this project took on tasks #1, #2 while this one was away. Answer them there.')
    expect(world.status).toBe('2 tasks in another session')
  })

  test('an answer typed during a turn, on waking, to a task another session took on meanwhile goes as typed', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    // Asleep: session 2 took the task on.
    takeOn(world.store)
    world.isStoreFailing = true
    await clock.advance(150_000)
    await clock.settle()
    world.isStoreFailing = false
    await $.turn.start({ text: 'go', turnId: 't1' })

    const sent = await $.prompt.submit(typed('↳ Answer to #1: Two failures', 't1'))

    expect(sent.text).toBe('↳ Answer to #1: Two failures')
    expect(world.toasts.at(-1)).toBe('Another session in this project took on task #1 while this one was away. Answer it there.')
  })

  test('the heartbeat keeps the slot alive and counts tasks other sessions take on', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    world.store[KEYS.session('session-0')] = { tasks: [ROTATE], seenMs: NOW }
    await clock.advance(60_000)
    await clock.settle()

    expect(slotsIn(world.store)['session-1']?.seenMs).toBe(NOW + 60_000)
    expect(world.status).toBe('☐ 1 task for you · /my-tasks · 1 task in another session')
  })

  test('assigning reads the project and writes the slot once', async ($, on) => {
    const { world } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    world.ops = []
    await $.tool.call(XCODE_TASK)

    expect(world.ops).toEqual(['keys', `get ${MINE}`, `set ${MINE}`])
  })

  test('a pane press or a prompt writes the slot and reads nothing', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    world.ops = []

    await ui.press({ key: 'done' })
    await $.prompt.submit(typed('now the cart'))
    await clock.advance(1000)
    await clock.settle()

    expect(world.ops.length).toBeGreaterThan(0)
    expect(world.ops.filter(op => op !== `set ${MINE}`)).toEqual([])
  })

  test('a session that never held a task leaves no slot, though it reads the project', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await clock.advance(2 * 60_000)
    await clock.settle()
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-1', resume: { id: 'session-1' } })

    expect(world.ops.filter(op => op === 'keys')).toHaveLength(3)
    expect(world.ops.filter(op => op.startsWith('set '))).toEqual([])
  })

  test('an ending session leaves its tasks for the next in one write, and after /clear takes them on again', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    world.ops = []
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-1', resume: { id: 'session-1' } })

    // No read: the exit's budget is short.
    expect(world.ops).toEqual([`set ${MINE}`])
    expect(slotsIn(world.store)['session-1']?.endedMs).toBe(NOW)

    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(1)
    await clock.settle()

    const ui = await $.ui.mount(PANE)
    expect(await textOf(ui, 'task-1')).toContain('from an earlier session')
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-2'])
  })

  test('after an in-process resume the session joins the project again, taking on what the one it left had', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    world.sessionId = 'session-3'
    await $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(1)
    await clock.settle()

    const ui = await $.ui.mount(PANE)
    expect(await textOf(ui, 'task-1')).toContain('from an earlier session')
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-3'])

    await clock.advance(60_000)
    await clock.settle()

    expect(slotsIn(world.store)['session-3']?.seenMs).toBe(NOW + 60_000)
    expect(slotsIn(world.store)['session-3']?.endedMs).toBeUndefined()
  })

  test('an ending session goes on without its write when the store is stuck', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    // The heartbeat's read never comes back, and holds up the store work behind it.
    world.isStuck = true
    await clock.advance(60_000)
    const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(10_000)

    expect(await ending).toEqual({ sessionId: 'session-1' })
  })

  /** Ends session 1 with /clear while the store is stuck: session 2 waits to join until it answers. */
  async function clearStuck($: Engine, { world, clock }: ReturnType<typeof seat>) {
    // The heartbeat's read never comes back, and holds up the store work behind it.
    world.isStuck = true
    await clock.advance(60_000)
    world.sessionId = 'session-2'
    const cleared = $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(10_000)
    await cleared
    await clock.settle()
  }

  test("a response held for Send now holds back no other task's by its number", async ($, on) => {
    const done = { ...ROTATE, state: 'done', update: 'pending', answer: 'Rotated.' } as const
    const { world, clock } = seat(on, {
      [KEYS.session('session-0')]: { tasks: [{ ...done, updatedMs: 5 }], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 },
    })
    await start($)

    // A hook beneath takes the vault's name out of a typed prompt's digest: #7 waits for Send now.
    world.masking = text => text.replaceAll('Vault', '*****')
    await $.prompt.submit(typed('next'))
    world.masking = undefined
    await (await $.ui.mount(PANE)).press({ key: 'send-7' })
    await clock.settle()

    expect(world.submitted).toHaveLength(1)

    // Another session's #7, answered there before it ended, comes to the session after /clear, and goes as a turn ends.
    world.store[KEYS.session('session-9')] = {
      tasks: [{ ...done, sessionId: 'session-9', updatedMs: 9 }],
      seenMs: NOW - 60_000,
      endedMs: NOW - 60_000,
      nextId: 8,
    }
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(1)
    await clock.settle()
    await $.turn.start({ text: 'next', turnId: 't1' })
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    expect(world.submitted).toHaveLength(2)
    expect(world.submitted[1]).toContain('#7 Rotate the leaked token in Vault')
  })

  /** Session x drew #1 at the same moment as this one, and ended: the session after /clear takes it on as #1. */
  async function clearTakingOnAnotherOne($: Engine, { world, clock }: ReturnType<typeof seat>) {
    world.store[KEYS.session('session-x')] = {
      tasks: [{ ...ROTATE, id: 1, sessionId: 'session-x' }],
      seenMs: NOW - 60_000,
      endedMs: NOW - 60_000,
      nextId: 2,
    }
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(1)
    await clock.settle()
  }

  test('a task that comes back after /clear under the number of one Claude withdrew takes nothing typed for that one, open or closed', async ($, on) => {
    const seated = seat(on)
    const { world, clock } = seated
    const held = holdingPresses(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed', kind: 'change' })
    await clock.settle()
    await $.tool.call({ tool: WITHDRAW, id: 1 })
    await clearTakingOnAnotherOne($, seated)

    expect(slotsIn(world.store)['session-2']?.tasks.map(task => [task.id, task.title])).toEqual([
      [1, ROTATE.title],
      [2, ANDROID_TASK.title],
    ])

    await ui.press({ key: 'select-1' })
    await ui.press({ key: 'answer' })
    await ui.press({ key: 'other-way' })
    await clock.settle()

    expect(world.toasts.at(-1)).toBe('Type an answer first, or press Cancel.')
    expect(slotsIn(world.store)['session-2']?.tasks.find(task => task.id === 1)?.state).toBe('open')
    expect(world.composer).toBe('')

    // Withdrawn as Save for later is pressed again, with nothing typed for it.
    held.isOn = true
    const pressed = ui.press({ key: 'other-way' })
    await $.tool.call({ tool: WITHDRAW, id: 1 })
    held.letGo()
    await pressed

    expect(world.toasts.at(-1)).toBe("Task #1 isn't open any more, so your response wasn't saved.")
    expect(world.composer).toBe('')
  })

  test("keys that reach a field as Claude withdraws its task leave nothing for a task back under its number after /clear, and the session's own drafts stay", async ($, on) => {
    const seated = seat(on)
    // Held, an input reaches its field once the test lets it go.
    let isHeld = false
    let letGo = () => {}
    on('ui.input', { plugin: '*' }, async ($, e, next) => {
      if (isHeld) {
        isHeld = false
        await new Promise<void>(resolve => {
          letGo = resolve
        })
      }

      return next(e)
    })
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'select-2' })
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-2', text: 'Pixel 8 passes', kind: 'change' })
    await ui.press({ key: 'select-1' })
    await ui.press({ key: 'answer' })
    // A key reaches #1's field as Claude withdraws the task, before the drawing that withdraw wakes.
    isHeld = true
    const entered = ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed', kind: 'change' })
    await $.tool.call({ tool: WITHDRAW, id: 1 })
    letGo()
    await entered
    await clearTakingOnAnotherOne($, seated)
    await ui.press({ key: 'select-1' })
    await ui.press({ key: 'answer' })

    expect((await ui.find({ type: 'Input', key: 'answer-1' }))?.props.value).toBe('')

    await ui.press({ key: 'select-2' })
    await ui.press({ key: 'answer' })

    expect((await ui.find({ type: 'Input', key: 'answer-2' }))?.props.value).toBe('Pixel 8 passes')
  })

  for (const [label, key, field] of [
    ['Answer…', 'answer', 'answer-1'],
    ['Reject…', 'reject', 'reason-1'],
  ] as const) {
    test(`${label} pressed as Claude withdraws its task neither selects nor opens a field on a task back under its number after /clear`, async ($, on) => {
      const seated = seat(on)
      const held = holdingPresses(on)
      await start($)

      await $.tool.call(XCODE_TASK)
      await $.tool.call(ANDROID_TASK)
      const ui = await $.ui.mount(PANE)
      held.isOn = true
      const pressed = ui.press({ key })
      await $.tool.call({ tool: WITHDRAW, id: 1 })
      held.letGo()
      await pressed
      await clearTakingOnAnotherOne($, seated)

      // #2 stays the one selected, its why drawn, and the task back under #1 stays shut.
      expect(await textOf(ui, 'task-2')).toContain(XCODE_TASK.why)
      expect(await textOf(ui, 'task-1')).not.toContain(ROTATE.why)
      expect(await ui.find({ type: 'Input', key: field })).toBeUndefined()
    })
  }

  test('Answer… that reads its task open just before Claude withdraws it leaves no field for a task back under its number after /clear', async ($, on) => {
    const seated = seat(on)
    const { world, clock } = seated
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(PANE)
    // The press reads the tasks late, as they stood before the withdraw.
    world.slowRead = 'tasks'
    world.readMs = 500
    const pressed = ui.press({ key: 'answer' })
    await clock.settle()
    await $.tool.call({ tool: WITHDRAW, id: 1 })
    await clock.advance(500)
    await pressed
    await clearTakingOnAnotherOne($, seated)

    expect(await ui.find({ type: 'Input', key: 'answer-1' })).toBeUndefined()
  })

  test("a task the join after a resume in place numbers anew, as the resumed session's own task keeps the number, keeps its field, its draft and the ring", async ($, on) => {
    const { world, clock } = seat(on)
    const failures = 'LoginTests.testExpiredToken failed, and CartTests.testCouponRounding failed with a rounding error'
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(inline(60))
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: failures, kind: 'change' })
    await clock.settle()
    // Session 0 drew #1 at the same moment as this one, and ended; this one resumes it in place.
    world.store[KEYS.session('session-0')] = { tasks: [{ ...ROTATE, id: 1, sessionId: 'session-0' }], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 2 }
    world.sessionId = 'session-0'
    await $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-0' } })
    await clock.advance(1)
    await clock.settle()

    // The Xcode task is #3 now, still selected, its field open with the draft; session 0's own task keeps #1.
    expect(await textOf(ui, 'task-3')).toContain(XCODE_TASK.title)
    expect((await ui.find({ type: 'Input', key: 'answer-3' }))?.props.value).toBe(failures)
    expect(await ui.find({ type: 'Input', key: 'answer-1' })).toBeUndefined()

    // The ring went along: moved onto the field, it leaves the rows as they are.
    const rows = world.opens.at(-1)?.rows
    await $.ui.focus(ringTo('answer-3'))
    await clock.settle()
    expect(world.opens.at(-1)?.rows).toBe(rows)
  })

  test("after /clear the tasks the process holds keep their numbers and the open field, though another session's slot holding one of them comes first", async ($, on) => {
    // Session x's slot is first in the store.
    const seated = seat(on, { [KEYS.session('session-x')]: { tasks: [], seenMs: NOW, nextId: 1 } })
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.tool.call(ANDROID_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'Two failures', kind: 'change' })
    await seated.clock.settle()
    await clearTakingOnAnotherOne($, seated)

    // Session x's task is #3 now, and the Xcode task, still #1, stays selected.
    expect(await textOf(ui, 'task-3')).toContain(ROTATE.title)
    expect(await textOf(ui, 'task-3')).not.toContain(ROTATE.why)
    expect(await ui.find({ type: 'Input', key: 'answer-1' })).toBeDefined()

    // Claude withdrawing #1 withdraws the Xcode task.
    await $.tool.call({ tool: WITHDRAW, id: 1 })
    expect(seated.world.toasts.at(-1)).toBe('Claude withdrew the task: Run xcodebuild test on your Mac, paste the failures')
  })

  test('a session that ends after /clear before its join has begun ends all the same and takes nothing quiet', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    // Session 2 ends before the clock runs its join.
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-2', resume: { id: 'session-2' } })
    world.store[KEYS.session('session-q')] = { tasks: [{ ...ROTATE, sessionId: 'session-q' }], seenMs: NOW - 10 * 60_000, nextId: 8 }
    await clock.advance(1)
    await clock.settle()

    expect(slotsIn(world.store)['session-2']?.tasks.map(task => task.id)).toEqual([1])
    expect(slotsIn(world.store)['session-2']?.endedMs).toBe(NOW)
    // No heartbeat, and no pane opened unasked, for a session that has ended.
    expect(world.opens).toHaveLength(1)
    world.ops = []
    await clock.advance(60_000)
    await clock.settle()
    expect(world.ops).toEqual([])
  })

  test("a session resumed into another folder acts on none of the tasks it leaves, and assigns none, until it has read the new folder", async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    // A response saved while Claude works, not sent yet.
    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    await (await $.ui.mount(PANE)).press({ key: 'done' })
    await clock.advance(1000)
    // The heartbeat's read never comes back, and holds up the store work behind it.
    world.isStuck = true
    await clock.advance(60_000)
    world.sessionId = 'session-3'
    world.root = '/other'
    const resumed = $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
    await clock.advance(10_000)
    await resumed
    await clock.settle()

    const isRefused = async () => String(((await $.tool.call(XCODE_TASK)) as { deny?: string }).deny).includes('still joining its project')
    expect(await isRefused()).toBe(true)
    expect(((await $.tool.call({ tool: LIST })) as { deny?: string }).deny).toContain('still joining its project')
    expect((await $.prompt.context({ blocks: [] })).blocks).toHaveLength(0)
    expect((await $.prompt.submit(typed('hello'))).context).toBeUndefined()
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()
    expect(world.submitted).toHaveLength(0)

    // The store answers, and the new folder's first read is slow: still nothing until it is in.
    world.isStuck = true
    world.unstick?.()
    await clock.settle()
    expect(await isRefused()).toBe(true)

    world.unstick?.()
    await clock.settle()
    const assigned = await $.tool.call(XCODE_TASK)

    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #1')
    expect(world.submitted).toHaveLength(0)
    // The response waits in the folder it was given in, for the next session there.
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.update)).toEqual(['pending'])
  })

  test('a session resumed into another folder and straight back acts on none of that folder\'s tasks as it moves back', async ($, on) => {
    const { world, clock } = seat(on, {
      [keysOf('/other').session('session-0')]: { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 },
    })
    await start($)

    await $.tool.call(KEY_TASK)
    // The heartbeat's read never comes back, and holds up the store work behind it.
    world.isStuck = true
    await clock.advance(60_000)
    world.sessionId = 'session-3'
    world.root = '/other'
    const resumed = $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
    await clock.advance(10_000)
    await resumed
    world.sessionId = 'session-4'
    world.root = '/repo'
    const back = $.session.end({ reason: 'resume', sessionId: 'session-3', resume: { id: 'session-4' } })
    await clock.advance(10_000)
    await back

    // The store answers, its writes slow: Claude lists its tasks as the queue drains.
    world.setMs = 1000
    world.unstick?.()
    const listed: string[] = []

    for (let i = 0; i < 100; i++) {
      await clock.advance(100)
      const result = (await $.tool.call({ tool: LIST, show: 'all' })) as { result?: unknown; deny?: string }
      listed.push(String(result.result ?? result.deny))
    }

    expect(listed.some(one => one.includes(ROTATE.title))).toBe(false)
    expect(listed.at(-1)).toContain(KEY_TASK.title)
  })

  test("a response held for Send now holds back nothing of the folder the session resumes into", async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    world.masking = text => text.replaceAll('STRIPE_SECRET_KEY', '*****')
    await (await $.ui.mount(PANE)).press({ key: 'done' })
    await clock.advance(1000)
    await clock.settle()
    world.masking = undefined
    // An answer the session that ended in the other folder never sent, with
    // the number and the time of the response held here.
    const updatedMs = slotsIn(world.store)['session-1']?.tasks[0]?.updatedMs
    world.store[keysOf('/other').session('session-0')] = {
      tasks: [{ ...ROTATE, id: 1, state: 'done', update: 'pending', updatedMs }],
      seenMs: NOW - 60_000,
      endedMs: NOW - 60_000,
      nextId: 2,
    }
    world.sessionId = 'session-3'
    world.root = '/other'
    await $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
    await clock.advance(1)
    await clock.settle()
    await $.turn.start({ text: '', turnId: 't1' })
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    expect(world.submitted).toHaveLength(2)
    expect(world.submitted[1]).toContain(ROTATE.title)
  })

  test('a session that ends after /clear before it has joined, the store stuck, ends all the same and takes nothing quiet', async ($, on) => {
    const seated = seat(on)
    const { world, clock } = seated
    await start($)

    await $.tool.call(KEY_TASK)
    await clearStuck($, seated)
    const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-2', resume: { id: 'session-2' } })
    await clock.advance(10_000)
    await ending

    // A session gone quiet meanwhile keeps its task: the next live session takes it on.
    world.store[KEYS.session('session-q')] = { tasks: [{ ...ROTATE, sessionId: 'session-q' }], seenMs: NOW - 10 * 60_000, nextId: 8 }
    world.unstick?.()
    await clock.settle()

    expect(slotsIn(world.store)['session-2']?.tasks.map(task => task.id)).toEqual([1])
    expect(slotsIn(world.store)['session-2']?.endedMs).toBe(NOW + 70_000)
  })

  test("a task assigned after /clear before the session has joined, the store stuck, is the new session's", async ($, on) => {
    const seated = seat(on)
    const { world, clock } = seated
    await start($)

    await $.tool.call(KEY_TASK)
    await clearStuck($, seated)
    await $.tool.call(XCODE_TASK)

    const ui = await $.ui.mount(PANE)
    const context = async () => (await $.prompt.context({ blocks: [] })).blocks.at(-1)?.text
    expect(await textOf(ui, 'task-1')).toContain('from an earlier session')
    expect(await textOf(ui, 'task-2')).not.toContain('from an earlier session')
    expect(await context()).toContain('#2 open: Run xcodebuild')

    world.unstick?.()
    await clock.settle()

    expect(slotsIn(world.store)['session-2']?.tasks.map(task => task.sessionId)).toEqual(['session-1', 'session-2'])
    expect(await textOf(ui, 'task-2')).not.toContain('from an earlier session')
    expect(await context()).toContain('#1 open (from an earlier session)')
    expect(await context()).toContain('#2 open: Run xcodebuild')
  })

  test('a store that stops answering holds up a tool call a few seconds, and nothing after it', async ($, on) => {
    // A 0.1.4 session alive here: assigning raises 0.1.4's count too.
    const { world, clock } = seat(on, { 'tasks:/repo': { nextId: 1, sessions: { 'session-0': { tasks: [ROTATE], seenMs: NOW } }, taken: {} } })
    await start($)

    await $.tool.call(KEY_TASK)
    // The heartbeat's read never comes back, and holds up the store work behind it.
    world.isStuck = true
    await clock.advance(60_000)

    let isWithdrawn = false
    const withdrawn = $.tool.call({ tool: WITHDRAW, id: 8 }).then(result => {
      isWithdrawn = true
      return result
    })
    await clock.advance(4000)
    expect(isWithdrawn).toBe(false)
    await clock.advance(1000)
    expect(String(((await withdrawn) as { result?: unknown }).result)).toContain('Withdrew task #8')

    const assigned = await $.tool.call(XCODE_TASK)
    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #9')
    expect(world.status).toBe('☐ 1 task for you · /my-tasks · 1 task in another session')
  })

  test('a store that stops answering is asked nothing more until it answers', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    // The heartbeat's read doesn't come back; the heartbeats after it ask nothing.
    world.isStuck = true
    await clock.advance(5 * 60_000)
    world.ops = []
    world.unstick?.()
    await clock.settle()

    expect(world.ops.filter(op => op === 'keys')).toEqual([])

    await clock.advance(60_000)
    await clock.settle()

    expect(world.ops.filter(op => op === 'keys')).toEqual(['keys'])
  })

  test('a store stuck as the session starts holds the start up a few seconds, and what it takes on shows once it answers', async ($, on) => {
    const { world, clock } = seat(on, { [KEYS.session('session-0')]: { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 } })
    world.isStuck = true

    let isStarted = false
    void start($).then(() => {
      isStarted = true
    })
    await clock.advance(4000)
    expect(isStarted).toBe(false)
    await clock.advance(1000)
    await clock.settle()
    expect(isStarted).toBe(true)
    expect(world.status).toBeUndefined()

    world.unstick?.()
    await clock.settle()

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-1'])
  })


  test('a pane slow to open holds up neither the heartbeat nor the store', async ($, on) => {
    const { world, clock } = seat(on, {
      [KEYS.session('session-0')]: { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 },
    })
    world.isStoreFailing = true
    await start($)

    // The heartbeat takes the project on, and the pane it opens takes half a minute.
    world.isStoreFailing = false
    world.openMs = 30_000
    await clock.advance(66_000)
    world.openMs = 0
    const reads = world.ops.filter(op => op === 'keys').length
    await $.tool.call(KEY_TASK)

    // Assigning reads the project first, as it does with no pane opening.
    expect(world.ops.filter(op => op === 'keys').length).toBe(reads + 1)
  })


  test('a pane slow to open as the session starts holds up neither the heartbeat nor the store', async ($, on) => {
    const { world, clock } = seat(on, {
      [KEYS.session('session-0')]: { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 },
    })
    world.openMs = 30_000
    const started = start($)
    await clock.advance(6_000)
    await started
    world.openMs = 0
    const reads = world.ops.filter(op => op === 'keys').length
    await $.tool.call(KEY_TASK)

    expect(world.ops.filter(op => op === 'keys').length).toBe(reads + 1)
  })

  test('after /clear whose end write failed, the session it becomes still takes on the tasks', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    world.sessionId = 'session-2'
    world.isWriteFailing = true
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    world.isWriteFailing = false
    await clock.advance(1)
    await clock.settle()

    const ui = await $.ui.mount(PANE)
    expect(await textOf(ui, 'task-1')).toContain('from an earlier session')
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-2'])
    expect(slotsIn(world.store)['session-2']?.took?.['session-1']?.isEnded).toBe(true)
  })

  test('after /clear whose first read failed, the session it becomes takes the tasks on once the store answers, and only once', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    world.isStoreFailing = true
    await clock.advance(1)
    await clock.settle()
    world.isStoreFailing = false

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-1'])

    await clock.advance(60_000)
    await clock.settle()

    expect(Object.keys(slotsIn(world.store))).toEqual(['session-2'])
    expect(slotsIn(world.store)['session-2']?.took?.['session-1']?.isEnded).toBe(true)
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })

  test('a session resumed in place while the store fails writes nothing until it reads the project, and keeps its own tasks', async ($, on) => {
    const own = { ...ROTATE, id: 8, title: 'Approve the staging migration', sessionId: 'session-3' }
    // Session 3, resumed below, last wrote a minute ago.
    const { world, clock } = seat(on, { [KEYS.session('session-3')]: { tasks: [own], seenMs: NOW - 60_000, nextId: 9 } })
    await start($)

    await $.tool.call(KEY_TASK)
    world.sessionId = 'session-3'
    await $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
    world.isStoreFailing = true
    await clock.advance(1)
    await clock.settle()
    world.isStoreFailing = false

    // Done on the task it holds, before it has read the project.
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toHaveLength(1)
    expect(slotsIn(world.store)['session-3']?.tasks).toEqual([own])

    await clock.advance(60_000)
    await clock.settle()

    expect(Object.keys(slotsIn(world.store))).toEqual(['session-3'])
    expect(slotsIn(world.store)['session-3']?.tasks).toEqual([own])
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })

  test('a session that ends before it could read the project hands on what it holds', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    world.isStoreFailing = true
    await clock.advance(1)
    await clock.settle()
    world.isStoreFailing = false

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })
    await clock.advance(1000)
    await clock.settle()
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-2', resume: { id: 'session-2' } })

    // The next session finds nothing open: the answer went to Claude.
    expect(Object.values(slotsIn(world.store)).flatMap(slot => slot.tasks)).toEqual([])
  })

  test('a session that reads the project only as it ends takes nothing from a quiet session, which may come back', async ($, on) => {
    const quiet = { tasks: [{ ...ROTATE, sessionId: 'session-q' }], seenMs: NOW - 10 * 60_000, nextId: 8 }
    const { world } = seat(on, { [KEYS.session('session-q')]: quiet })
    world.isStoreFailing = true
    await start($)

    await $.tool.call(KEY_TASK)
    world.isStoreFailing = false
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-1', resume: { id: 'session-1' } })

    expect(slotsIn(world.store)['session-q']).toEqual(quiet)
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.title)).toEqual([KEY_TASK.title])
    expect(slotsIn(world.store)['session-1']?.took).toBeUndefined()
  })

  test('after /clear, a press while the session it becomes takes the tasks on is kept', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    // Taking the tasks on, the new session reads its task list late: Done lands meanwhile.
    world.slowRead = 'tasks'
    world.readMs = 500
    await clock.advance(1)
    const pressed = ui.press({ key: 'done' })
    await clock.advance(500)
    await pressed
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toEqual(['My response to a task you gave me (Human in the loop):\n\n#1 Add STRIPE_SECRET_KEY to .env: Done.'])
    expect(world.status).toBeUndefined()
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-2'])
    expect(slotsIn(world.store)['session-2']?.tasks).toEqual([])
  })

  test('after two /clears, the first never reading the project, the third session takes the tasks on once', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    world.isStoreFailing = true
    await clock.advance(1)
    await clock.settle()
    world.sessionId = 'session-3'
    await $.session.end({ reason: 'clear', sessionId: 'session-2', resume: { id: 'session-2' } })
    world.isStoreFailing = false
    await clock.advance(1)
    await clock.settle()

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-3'])
    expect(slotsIn(world.store)['session-3']?.took?.['session-1']?.isEnded).toBe(true)
  })

  test('after /clear in a session that never read the project, the session it becomes takes on what it assigned', async ($, on) => {
    const { world, clock } = seat(on)
    world.isStoreFailing = true
    await start($)

    await $.tool.call(KEY_TASK)
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    world.isStoreFailing = false
    await clock.advance(1)
    await clock.settle()

    const ui = await $.ui.mount(PANE)
    expect(await textOf(ui, 'task-1')).toContain('from an earlier session')
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-2'])
    expect(slotsIn(world.store)['session-2']?.took?.['session-1']?.isEnded).toBe(true)
  })

  test('after /clear in a session that never read the project, one resumed elsewhere meanwhile keeps its slot', async ($, on) => {
    const { world, clock } = seat(on)
    world.isStoreFailing = true
    await start($)

    await $.tool.call(KEY_TASK)
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(1)
    await clock.settle()
    // Session 1, resumed in another terminal, wrote its slot; what this process assigned as session 1 it never saw.
    const resumed = { tasks: [{ ...ROTATE, sessionId: 'session-1' }], seenMs: NOW, nextId: 8 }
    world.store[MINE] = resumed
    world.isStoreFailing = false
    await clock.advance(60_000)
    await clock.settle()

    expect(world.status).toBe('☐ 1 task for you · /my-tasks · 1 task in another session')
    expect(slotsIn(world.store)['session-1']).toEqual(resumed)
    expect(slotsIn(world.store)['session-2']?.tasks.map(task => task.title)).toEqual([KEY_TASK.title])
  })

  test('after /clear in a session that never read the project, one resumed elsewhere that went quiet keeps its slot to come back to', async ($, on) => {
    const { world, clock } = seat(on)
    world.isStoreFailing = true
    await start($)

    await $.tool.call(KEY_TASK)
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(1)
    await clock.settle()
    // Session 1, resumed in another terminal, wrote its slot and went quiet there: a laptop lid closed on it, say.
    const quiet = { tasks: [{ ...ROTATE, sessionId: 'session-1' }], seenMs: NOW - 10 * 60_000, nextId: 8 }
    world.store[MINE] = quiet
    world.isStoreFailing = false
    await clock.advance(60_000)
    await clock.settle()

    expect(world.status).toBe('☐ 2 tasks for you · /my-tasks')
    expect(slotsIn(world.store)['session-2']?.tasks.map(task => task.id)).toEqual([1, 7])
    const note = slotsIn(world.store)['session-2']?.took?.['session-1']
    expect(note?.tasks.map(ref => ref.id)).toEqual([7])
    expect(note?.isEnded).toBeUndefined()

    // Its note stays until it comes back and lets the tasks go.
    await clock.advance(60_000)
    await clock.settle()

    expect(slotsIn(world.store)['session-1']).toEqual(quiet)
    expect(slotsIn(world.store)['session-2']?.took?.['session-1']).toEqual(note)
  })

  test('a session resumed into another folder takes on nothing the process held for this one', async ($, on) => {
    // Quiet session q's task, which this session takes on, noting it.
    const quiet = { ...ROTATE, sessionId: 'session-q' }
    const { world, clock } = seat(on, { [KEYS.session('session-q')]: { tasks: [quiet], seenMs: NOW - 10 * 60_000, nextId: 8 } })
    await start($)

    await $.tool.call(KEY_TASK)
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    world.isStoreFailing = true
    await clock.advance(1)
    await clock.settle()
    world.sessionId = 'session-3'
    world.root = '/other'
    await $.session.end({ reason: 'resume', sessionId: 'session-2', resume: { id: 'session-3' } })
    world.isStoreFailing = false
    await clock.advance(1)
    await clock.settle()

    expect(world.status).toBeUndefined()
    expect(projectOf('/other', world.store).slots).toEqual({})
    // The next session here takes them on.
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.id)).toEqual([7, 8])
  })

  test("a session resumed into another folder while the store fails shows nothing of this folder's", async ($, on) => {
    const { world, clock } = seat(on, { [KEYS.session('session-0')]: { tasks: [ROTATE], seenMs: NOW } })
    await start($)

    await $.tool.call(KEY_TASK)
    expect(world.status).toBe('☐ 1 task for you · /my-tasks · 1 task in another session')

    world.sessionId = 'session-3'
    world.root = '/other'
    world.isStoreFailing = true
    await $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
    await clock.advance(1)
    await clock.settle()

    expect(world.status).toBeUndefined()
    expect(world.isPaneOpen).toBe(false)

    // Numbered as a new process there would number it, without either project's count.
    const assigned = await $.tool.call(XCODE_TASK)
    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #1')
  })

  test('a session resumed into another folder leaves behind the answer it was typing for this one', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    // Typed, not sent.
    await ui.input({ key: 'answer-1', text: 'LoginTests.testExpiredToken failed', kind: 'change' })
    world.sessionId = 'session-3'
    world.root = '/other'
    await $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
    await clock.advance(1)
    await clock.settle()

    const assigned = await $.tool.call({ ...XCODE_TASK, title: 'Run the Android tests on your phone, paste the failures' })
    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #1')

    expect(await ui.find({ type: 'Input', key: 'answer-1' })).toBeUndefined()
    await ui.press({ key: 'answer' })
    expect((await ui.find({ type: 'Input', key: 'answer-1' }))?.props.value).toBe('')
  })



  test('a session resumed into another folder as a turn ends wakes Claude for no answer the first one sent', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(XCODE_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'CartTests.testCouponRounding', kind: 'change' })
    await ui.press({ key: 'other-way' })
    await clock.advance(1000)
    world.sessionId = 'session-3'
    world.root = '/other'
    await $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
    await clock.advance(1)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    expect(world.appended.map(row => row.text)).toContain('Sent your response to #1 to Claude')
    expect(world.submitted).toEqual([])
  })

  test('a session resumed into another folder selects there as a new session would', async ($, on) => {
    const migration = { ...ROTATE, id: 2, title: 'Approve the staging migration', why: 'It drops a column.' }
    const { world, clock } = seat(on, {
      [keysOf('/other').session('session-0')]: {
        tasks: [{ ...ROTATE, id: 1 }, migration],
        seenMs: NOW - 60_000,
        endedMs: NOW - 60_000,
        nextId: 3,
      },
    })
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'select-2' })
    world.sessionId = 'session-3'
    world.root = '/other'
    await $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
    await clock.advance(1)
    await clock.settle()

    expect(await textOf(ui, 'task-1')).toContain(ROTATE.why)
    expect(await textOf(ui, 'task-2')).not.toContain(migration.why)
  })


  test('a session resumed into another folder takes on the slot there of the session it left', async ($, on) => {
    // Session 1 ran in the other folder once, and ended there holding a task.
    const { world, clock } = seat(on, {
      [keysOf('/other').session('session-1')]: {
        tasks: [{ ...ROTATE, sessionId: 'session-1' }],
        seenMs: NOW - 60_000,
        endedMs: NOW - 60_000,
        nextId: 8,
      },
    })
    await start($)

    world.sessionId = 'session-3'
    world.root = '/other'
    await $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
    await clock.advance(1)
    await clock.settle()

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(Object.keys(projectOf('/other', world.store).slots)).toEqual(['session-3'])
  })

  test("a session resumed into another folder changes nothing of 0.1.4's there before it reads that project", async ($, on) => {
    // A 0.1.4 session alive in this folder.
    const { world, clock } = seat(on, { 'tasks:/repo': { nextId: 8, sessions: { 'session-0': { tasks: [ROTATE], seenMs: NOW } }, taken: {} } })
    await start($)

    world.sessionId = 'session-3'
    world.root = '/other'
    world.isStoreFailing = true
    await $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
    await clock.advance(1)
    await clock.settle()
    world.isStoreFailing = false
    // Assigning, the session reads the project, and the store fails just then.
    world.failing = 1
    await $.tool.call(KEY_TASK)

    expect(world.ops).toContain('keys')
    expect(Object.keys(world.store)).toEqual(['tasks:/repo'])
  })


  test("after /clear, the session it becomes changes nothing of 0.1.4's before it reads the project", async ($, on) => {
    // A 0.1.4 session alive in this folder.
    const { world, clock } = seat(on, { 'tasks:/repo': { nextId: 8, sessions: { 'session-0': { tasks: [ROTATE], seenMs: NOW } }, taken: {} } })
    await start($)

    await $.tool.call(KEY_TASK)
    const legacy = JSON.parse(JSON.stringify(world.store['tasks:/repo'])) as unknown
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    // Its reads of the project fail: as it joins, and as it assigns.
    world.failing = 1
    await clock.advance(1)
    world.failing = 1
    await $.tool.call(XCODE_TASK)

    expect(world.store['tasks:/repo']).toEqual(legacy)
  })

  test('a slot that leaves after a month hands its own notes on, so nothing it took is taken twice', async ($, on) => {
    const DAY = 24 * 60 * 60_000
    const held = { ...ROTATE, sessionId: 'session-b' }
    // Session a took #7 on from quiet session b, and went quiet holding it; this one took it on from a.
    const { world, clock } = seat(on, {
      [KEYS.session('session-b')]: { tasks: [held], seenMs: NOW - 34 * DAY, nextId: 8 },
      [KEYS.session('session-a')]: {
        tasks: [held],
        seenMs: NOW - 32 * DAY,
        nextId: 8,
        took: { 'session-b': { tasks: [refOf(held)], atMs: NOW - 33 * DAY } },
      },
      [MINE]: { tasks: [held], seenMs: NOW - 31 * DAY, nextId: 8, took: { 'session-a': { tasks: [refOf(held)], atMs: NOW - 31 * DAY } } },
    })
    await start($)
    await clock.advance(60_000)
    await clock.settle()

    expect(Object.keys(slotsIn(world.store)).sort()).toEqual(['session-1', 'session-b'])
    expect(slotsIn(world.store)['session-1']?.took?.['session-b']).toEqual({ tasks: [refOf(held)], atMs: NOW - 33 * DAY })

    await clock.advance(60_000)
    await clock.settle()

    expect(Object.keys(slotsIn(world.store))).toEqual(['session-1'])
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })

  test('a slot that leaves as this session takes it on hands its own notes on, so nothing it took is taken twice', async ($, on) => {
    const held = { ...ROTATE, sessionId: 'session-q' }
    const note = { tasks: [refOf(held)], atMs: NOW - 5 * 60_000 }
    // Session x took #7 on from quiet session q, and ended holding it.
    const { world, clock } = seat(on, {
      [KEYS.session('session-q')]: { tasks: [held], seenMs: NOW - 10 * 60_000, nextId: 8 },
      [KEYS.session('session-x')]: { tasks: [held], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8, took: { 'session-q': note } },
    })
    await start($)

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(Object.keys(slotsIn(world.store)).sort()).toEqual(['session-1', 'session-q'])
    expect(slotsIn(world.store)['session-1']?.took?.['session-q']).toEqual(note)

    // After /clear, the session it becomes takes this one's task on, and not q's again.
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(1)
    await clock.settle()

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(slotsIn(world.store)['session-2']?.tasks.map(task => task.id)).toEqual([7])
  })

  test("a slot or a note in 0.1.4's value that isn't one is skipped", async ($, on) => {
    const quiet = { ...ROTATE, id: 8, title: 'Approve the staging migration', sessionId: 'session-y' }
    const { world } = seat(on, {
      'tasks:/repo': {
        nextId: 9,
        sessions: {
          'session-0': { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000 },
          'session-x': { seenMs: NOW },
          'session-y': { tasks: [quiet], seenMs: NOW - 10 * 60_000 },
        },
        taken: { 'session-y': { atMs: NOW - 60_000 } },
      },
    })
    await start($)

    expect(world.status).toBe('☐ 2 tasks for you · /my-tasks')
    expect(world.store['tasks:/repo']).toEqual({ nextId: 9, sessions: {}, taken: { 'session-y': { ids: [8], atMs: NOW } } })

    const assigned = await $.tool.call(KEY_TASK)
    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #9')
  })

  test("what in a slot isn't a task, a count or a note is skipped", async ($, on) => {
    const elsewhere = { ...ROTATE, id: 5, title: 'Approve the staging migration', sessionId: 'session-z' }
    const { world } = seat(on, {
      [KEYS.session('session-0')]: {
        tasks: [ROTATE, null, { id: 9 }],
        seenMs: NOW - 60_000,
        endedMs: NOW - 60_000,
        nextId: 'ten',
        took: { 'session-x': {}, 'session-z': { tasks: [null], atMs: NOW - 60_000 } },
      },
      [KEYS.session('session-z')]: { tasks: [elsewhere], seenMs: NOW, nextId: 6 },
    })
    await start($)

    expect(world.status).toBe('☐ 1 task for you · /my-tasks · 1 task in another session')
    expect(Object.keys(slotsIn(world.store)).sort()).toEqual(['session-1', 'session-z'])
    expect((world.store[MINE] as { nextId?: unknown }).nextId).toBe(8)

    const assigned = await $.tool.call(KEY_TASK)
    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #8')
  })

  test("a slot that leaves takes with it the copy of it 0.1.4's value kept", async ($, on) => {
    const answered = { ...ROTATE, id: 6, title: 'Approve the staging migration', sessionId: 'session-s' }
    const held = { ...ROTATE, sessionId: 'session-s' }
    // Session s came to this version from 0.1.4, and a 0.1.4 session's write put its slot back as it was then.
    const { world } = seat(on, {
      'tasks:/repo': { nextId: 8, sessions: { 'session-s': { tasks: [answered, held], seenMs: NOW - 60 * 60_000 } }, taken: {} },
      [KEYS.session('session-s')]: { tasks: [held], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 },
    })
    await start($)

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-1'])
    expect(world.store['tasks:/repo']).toEqual({ nextId: 8, sessions: {}, taken: {} })
  })

  test("a slot left behind that leaves on the heartbeat takes 0.1.4's copy of it too", async ($, on) => {
    const held = { ...ROTATE, sessionId: 'session-s' }
    const left = { tasks: [held], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 }
    const { world, clock } = seat(on, { [KEYS.session('session-s')]: left })
    await start($)

    // The removal didn't stay, and a 0.1.4 session's write put back the copy its value had of session s.
    world.store[KEYS.session('session-s')] = left
    world.store['tasks:/repo'] = { nextId: 8, sessions: { 'session-s': { tasks: [held], seenMs: NOW - 60 * 60_000 } }, taken: {} }
    await clock.advance(60_000)
    await clock.settle()

    expect(Object.keys(slotsIn(world.store))).toEqual(['session-1'])
    expect(world.store['tasks:/repo']).toEqual({ nextId: 8, sessions: {}, taken: {} })
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })

  test("with a 0.1.4 session alive, a heartbeat reads its value once, and raises its count only when it fell back", async ($, on) => {
    const { world, clock } = seat(on, { 'tasks:/repo': { nextId: 8, sessions: { 'session-0': { tasks: [ROTATE], seenMs: NOW } }, taken: {} } })
    await start($)

    await $.tool.call(KEY_TASK)
    world.ops = []
    await clock.advance(60_000)
    await clock.settle()

    expect(world.ops.filter(op => op === 'get tasks:/repo')).toEqual(['get tasks:/repo'])
    expect((world.store['tasks:/repo'] as { nextId: number }).nextId).toBe(9)

    // A 0.1.4 session's write puts back the count it read before.
    world.store['tasks:/repo'] = { nextId: 8, sessions: { 'session-0': { tasks: [ROTATE], seenMs: NOW + 60_000 } }, taken: {} }
    await clock.advance(60_000)
    await clock.settle()

    expect((world.store['tasks:/repo'] as { nextId: number }).nextId).toBe(9)
  })

  test("a slot of another folder whose key starts as this one's is not this project's", async ($, on) => {
    const other = keysOf('/repo#session:b').session('session-9')
    const { world } = seat(on, { [other]: { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 } })
    await start($)

    expect(world.status).toBeUndefined()
    expect(world.store[other]).toBeDefined()
  })

  test('a 0.1.4 note of tasks taken from this session leaves only once its slot has let them go', async ($, on) => {
    const { world } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)
    // A 0.1.4 session took #2 on while this one slept.
    world.store['tasks:/repo'] = { nextId: 3, sessions: {}, taken: { 'session-1': { ids: [2], atMs: NOW } } }
    const again = await $.tool.call(KEY_TASK)

    expect(String((again as { result?: unknown }).result)).toContain('Task #1 already asks the user for this')
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.id)).toEqual([1])
    expect(world.store['tasks:/repo']).toEqual({ nextId: 3, sessions: {}, taken: {} })
  })


  test('a 0.1.4 note whose task the session let go of in a write that failed leaves only once the slot is written without it', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)
    // A 0.1.4 session took #2 on while this one slept; the heartbeat lets it go, and can't write.
    world.store['tasks:/repo'] = { nextId: 3, sessions: {}, taken: { 'session-1': { ids: [2], atMs: NOW } } }
    world.isWriteFailing = true
    await clock.advance(60_000)
    await clock.settle()
    world.isWriteFailing = false
    const again = await $.tool.call(KEY_TASK)

    expect(String((again as { result?: unknown }).result)).toContain('Task #1 already asks the user for this')
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.id)).toEqual([1])
    expect(world.store['tasks:/repo']).toEqual({ nextId: 3, sessions: {}, taken: {} })
  })

  test('a 0.1.4 note of tasks taken from this session, put back after it was read, takes nothing this session took on', async ($, on) => {
    // A 0.1.4 session took this one's #3 on while it slept, and an ended session left a #3 of its own.
    const legacy = { nextId: 4, sessions: {}, taken: { 'session-1': { ids: [3], atMs: NOW - 60_000 } } }
    const { world, clock } = seat(on, {
      'tasks:/repo': legacy,
      [KEYS.session('session-0')]: { tasks: [{ ...ROTATE, id: 3 }], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 4 },
    })
    await start($)

    expect((world.store['tasks:/repo'] as { taken: unknown }).taken).toEqual({})

    // A 0.1.4 session's write, from what it read before, puts the note back.
    world.store['tasks:/repo'] = legacy
    await clock.advance(60_000)
    await clock.settle()

    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.title)).toEqual([ROTATE.title])
    expect(world.toasts).toHaveLength(0)
  })

  test('the count never goes back: a slot carries it once its tasks are gone, and the next session once it ends', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    for (const title of ['Approve the release', 'Rotate the key', 'Pick a name']) {
      await $.tool.call({ ...KEY_TASK, title })
    }

    for (const id of [1, 2, 3]) {
      await $.tool.call({ tool: WITHDRAW, id })
    }

    expect(slotsIn(world.store)['session-1']).toEqual({ tasks: [], seenMs: NOW, nextId: 4 })

    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(1)
    await clock.settle()

    // The empty slot left once the next session's carried the count.
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-2'])

    const assigned = await $.tool.call(KEY_TASK)
    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #4')
  })

  test('the count of a session whose writes failed while it held a task reaches the store once it answers', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    world.isWriteFailing = true
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })
    await clock.advance(1000)
    await clock.settle()
    world.isWriteFailing = false
    await clock.advance(60_000)
    await clock.settle()

    expect(world.submitted).toHaveLength(1)
    expect(slotsIn(world.store)['session-1']).toEqual({ tasks: [], seenMs: NOW + 60_000, nextId: 2 })
  })

  test("an ended slot that carries only its count keeps the numbers going, and leaves once this one's carries it", async ($, on) => {
    const { world } = seat(on, { [KEYS.session('session-0')]: { tasks: [], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 4 } })
    await start($)

    const assigned = await $.tool.call(KEY_TASK)

    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #4')
    expect(Object.keys(slotsIn(world.store))).toEqual(['session-1'])
    expect(slotsIn(world.store)['session-1']?.nextId).toBe(5)
  })

  test('a project root too long for the store keys its slots by a hash', async ($, on) => {
    const { world } = seat(on)
    world.root = `/${'deep/'.repeat(42)}repo`
    world.sessionId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
    await start($)

    await $.tool.call(KEY_TASK)

    expect(Object.keys(world.store)).toEqual([keysOf(world.root).session(world.sessionId)])
    expect(Object.keys(world.store)[0]!.length).toBeLessThanOrEqual(256)
  })
})

describe('the README example', () => {
  test('two answers while Claude works, the third after it stops, reach Claude as one message', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.turn.start({ text: 'Get our Stripe webhooks library ready to open-source.', turnId: 't1' })
    await $.tool.call({
      tool: ASSIGN,
      title: 'Add STRIPE_SECRET_KEY to .env',
      why: "The integration tests run against Stripe's test mode and need it.",
      done_when: "It's in .env. Don't paste it here.",
      kind: 'do',
    })
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })
    expect(world.status).toBe('✓ 1 not sent yet · /my-tasks')

    await $.tool.call({
      tool: ASSIGN,
      title: 'Decide whether to make the repo public',
      why: 'npm will link to it, and its whole git history becomes public. I found no secrets in it.',
      kind: 'choose',
      options: ['Make it public', 'Keep it private'],
    })
    await ui.press({ key: 'option-1' })

    await $.tool.call({
      tool: ASSIGN,
      title: "Choose the package's name on npm",
      why: 'stripe-webhooks is taken. The name goes in package.json and the README.',
      kind: 'answer',
    })
    expect(world.status).toBe('☐ 1 task for you · 2 not sent yet · /my-tasks')
    await clock.advance(1000)
    expect(world.submitted).toHaveLength(0)

    // #3 is still open when Claude stops, so #1 and #2 wait to go with it.
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()
    expect(world.submitted).toHaveLength(0)

    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-3', text: '@acme/stripe-hooks' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toEqual([
      [
        'My responses to tasks you gave me (Human in the loop):',
        '',
        '#1 Add STRIPE_SECRET_KEY to .env: Done.',
        '',
        '#2 Decide whether to make the repo public: I chose "Make it public".',
        '',
        "#3 Choose the package's name on npm:",
        '@acme/stripe-hooks',
      ].join('\n'),
    ])
    expect(world.status).toBeUndefined()
  })
})

describe('knowing whether Claude works', () => {
  test("a teammate's turn leaves Claude idle", async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.turn.complete({ ...DONE, turnId: 't1' })
    // Main's turn is over; a teammate is still at work in its own.
    await $.turn.start({ text: 'review the diff', turnId: 'mate', agentId: 'reviewer' })

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toHaveLength(1)
  })

  test("a subagent's turn ending leaves Claude at work in its own", async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.turn.start({ text: 'find the flaky test', turnId: 'sub', agentId: 'explorer' })
    await $.turn.complete({ ...DONE, turnId: 'sub', agentId: 'explorer' })

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toHaveLength(0)

    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    expect(world.submitted).toHaveLength(1)
  })
})

// The fork's changes: long text is refused with its length and never cut, a
// `detail` field has its own full view, options may be longer and more, and
// every refusal and acceptance is one decision-log line.
describe('the fork: limits, detail and the decision log', () => {
  const OK = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

  /** Records what the plugin hands the decision-log writer, as `process.run` calls. */
  function logging(on: On) {
    const lines: Record<string, unknown>[] = []
    on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? '/prof' : '/home/u' }))
    on('fs.exists', (_, e) => ({ value: e.path === '/prof/hooks/decision_log.py' }))
    on('process.run', (_, e) => {
      expect(e.argv).toEqual(['python3', '-I', '/prof/hooks/decision_log.py'])
      lines.push(JSON.parse(e.init?.stdin ?? '{}'))

      return { value: OK }
    })

    return lines
  }

  /** A text of `n` characters that is never a secret shape and has a findable end. */
  const filler = (n: number, end = 'END') => `${'word '.repeat(Math.ceil(n / 5)).slice(0, n - end.length)}${end}`

  const refusal = async ($: Engine, args: Record<string, unknown>) =>
    String(((await $.tool.call({ ...KEY_TASK, ...args } as never)) as { deny?: string }).deny)

  test('a why or a done_when over the limit is refused with its length and the limit, never cut', async ($, on) => {
    seat(on)
    await start($)

    expect(await refusal($, { why: 'w'.repeat(301) })).toBe('why is 301 characters; the limit is 300. Shorten it and put the rest in detail.')
    expect(await refusal($, { done_when: 'd'.repeat(412) })).toBe(
      'done_when is 412 characters; the limit is 300. Shorten it and put the rest in detail.',
    )

    const exact = (await $.tool.call({ ...KEY_TASK, why: 'w'.repeat(300) })) as { result?: unknown }
    expect(String(exact.result)).toContain('Assigned task #1')
  })

  test('a detail over its limit is refused with its length and the limit', async ($, on) => {
    seat(on)
    await start($)

    expect(await refusal($, { detail: 'x'.repeat(4001) })).toBe('detail is 4001 characters; the limit is 4000.')

    const exact = (await $.tool.call({ ...KEY_TASK, detail: 'x'.repeat(4000) })) as { result?: unknown }
    expect(String(exact.result)).toContain('Assigned task #1')
  })

  test('the card shows title and why only; Full picture shows a 1,500 character detail whole, and Back hides it', async ($, on) => {
    const { world } = seat(on)
    await start($)
    const detail = `${filler(700, 'MIDDLE')}\n\nSecond paragraph.\n${filler(700, 'THE-VERY-END')}`
    expect(detail.length).toBeGreaterThanOrEqual(1400)

    await $.tool.call({ ...KEY_TASK, detail })
    const ui = await $.ui.mount(PANE)

    expect(await textOf(ui, 'task-1')).toContain("The webhook test can't run without it.")
    expect(await textOf(ui, 'task-1')).not.toContain('MIDDLE')
    expect(await ui.find({ key: 'detail' })).toBeUndefined()
    expect((await ui.findAll({ type: 'Button' })).map(b => b.props.label)).toContain('Full picture')

    await ui.press({ key: 'full' })
    const shown = await textOf(ui, 'detail')
    expect(shown).toContain('MIDDLE')
    expect(shown).toContain('Second paragraph.')
    expect(shown.endsWith('THE-VERY-END')).toBe(true)
    // The tree's text joins the lines; every character of the detail is in it, in order.
    expect(shown.replace(/\s+/g, '')).toBe(detail.replace(/\s+/g, ''))
    expect((await ui.findAll({ type: 'Button' })).map(b => b.props.label)).toContain('Back')

    await ui.press({ key: 'full' })
    expect(await ui.find({ key: 'detail' })).toBeUndefined()
    expect(JSON.stringify(world.store)).toContain('THE-VERY-END')
  })

  test('a task with no detail has no Full picture button', async ($, on) => {
    seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)

    expect((await ui.findAll({ type: 'Button' })).map(b => b.props.label)).not.toContain('Full picture')
  })

  test('a detail stored by an earlier session comes back in the full view', async ($, on) => {
    seat(on, {
      'tasks:/repo': { nextId: 8, tasks: [{ ...ROTATE, detail: 'The gist is https://example.test/g and the token starts with ghp.' }] },
    })
    await start($)

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'full' })

    expect(await textOf(ui, 'detail')).toBe('The gist is https://example.test/g and the token starts with ghp.')
  })

  test('the full view fits the rows the pane asks for, capped at 18, as the pane scrolls the rest', async () => {
    const task = { ...ROTATE, detail: filler(1500) }
    const view = {
      shown: [task],
      selectedId: 7,
      fullId: null as number | null,
      editing: null,
      draft: '',
      nowMs: 0,
      sessionId: 'session-0',
      isWorking: false,
      canType: true,
      isFocused: true,
      isTyping: false,
    }

    const card = rowsFor(view, 100, 100)
    const full = rowsFor({ ...view, fullId: 7 }, 100, 100)

    expect(full - card).toBeGreaterThanOrEqual(Math.ceil(1500 / 96))
    expect(rowsFor({ ...view, fullId: 7 }, 100, 18)).toBe(18)
  })

  test('options past the old caps (60 characters, 4 options) are accepted, and shown whole', async ($, on) => {
    seat(on)
    await start($)
    const options = ['A', 'B', 'C', 'D', 'E'].map(l => `${l}: ${filler(100, l)}`)

    const assigned = (await $.tool.call({ ...PAGING_TASK, options: [...options, 'F'.repeat(120)] })) as { result?: unknown }
    expect(String(assigned.result)).toContain('Assigned task #1')

    const ui = await $.ui.mount(PANE)
    const labels = (await ui.findAll({ type: 'Button' })).map(b => String(b.props.label))

    expect(labels.filter(l => l.includes('F'.repeat(120)))).toHaveLength(1)
    expect(labels.filter(l => options.includes(l))).toHaveLength(5)
  })

  test('an option over 120 characters, or a seventh option, is refused', async ($, on) => {
    seat(on)
    await start($)

    const long = await $.tool.call({ ...PAGING_TASK, options: ['ok', 'x'.repeat(121)] })
    expect((long as { deny?: string }).deny).toBe('option 2 is 121 characters; the limit is 120.')

    const many = await $.tool.call({ ...PAGING_TASK, options: ['1', '2', '3', '4', '5', '6', '7'] })
    expect((many as { deny?: string }).deny).toBe('a choose task needs 2 to 6 options; this has 7.')
  })

  test('six options of 120 characters keep the pane at its row cap on a 76 column terminal', () => {
    const task = { ...ROTATE, kind: 'choose' as const, options: Array.from({ length: 6 }, (_, i) => `${i}${'o'.repeat(119)}`) }
    const view = {
      shown: [task],
      selectedId: 7,
      fullId: null as number | null,
      editing: null,
      draft: '',
      nowMs: 0,
      sessionId: 'session-0',
      isWorking: false,
      canType: true,
      isFocused: true,
      isTyping: false,
    }

    // Each button is wider than the row (3 + 120 cells in 74), so it takes two rows, not one.
    expect(rowsFor(view, 76, 100)).toBeGreaterThanOrEqual(6 * 2)
    expect(rowsFor(view, 76, 18)).toBeLessThanOrEqual(18)
  })

  test('the tool lists detail and the new caps for the calling agent', async ($, on) => {
    const { world } = seat(on)
    await start($)
    const tool = world.registered.find(spec => spec.name === 'assign_task') as { description: string; inputSchema: unknown }
    const props = (tool.inputSchema as { properties: Record<string, { description?: string; maxItems?: number }> }).properties

    expect(props['detail']?.description).toContain('4000')
    expect(props['why']?.description).toContain('300')
    expect(props['options']?.maxItems).toBe(6)
    expect(props['options']?.description).toContain('120')
    expect(tool.description).toContain('title is the ask')
    expect(tool.description).toContain('detail is the full picture')
  })

  test('a refusal is one decision-log line with the field, its length and the limit, and no task text', async ($, on) => {
    seat(on)
    const lines = logging(on)
    await start($)

    await refusal($, { why: `secret-why ${'w'.repeat(429)}` })
    await refusal($, { done_when: 'd'.repeat(301) })
    await refusal($, { detail: 'x'.repeat(4001) })

    expect(lines).toHaveLength(3)
    expect(lines[0]).toEqual({
      hook: 'human-in-the-loop',
      decision: 'refuse',
      reason: 'why is 440 characters; the limit is 300.',
      session: 'session-1',
      inputs: { field: 'why', length: 440, limit: 300 },
    })
    expect(lines[1]).toMatchObject({ decision: 'refuse', inputs: { field: 'done_when', length: 301, limit: 300 } })
    expect(lines[2]).toMatchObject({ decision: 'refuse', inputs: { field: 'detail', length: 4001, limit: 4000 } })
    expect(JSON.stringify(lines)).not.toContain('secret-why')
  })

  test('an accepted task, and the sixth open one refused, are logged', async ($, on) => {
    seat(on)
    const lines = logging(on)
    await start($)

    await $.tool.call({ ...KEY_TASK, detail: 'x'.repeat(1500) })
    expect(lines).toEqual([
      {
        hook: 'human-in-the-loop',
        decision: 'accept',
        reason: 'task #1 assigned',
        session: 'session-1',
        inputs: { id: 1, kind: 'do', why: KEY_TASK.why.length, done_when: KEY_TASK.done_when.length, detail: 1500, options: 0 },
      },
    ])

    for (const n of [2, 3, 4, 5]) {
      await $.tool.call({ ...KEY_TASK, title: `Do thing number ${n}` })
    }

    await $.tool.call({ ...KEY_TASK, title: 'One task too many' })
    expect(lines.at(-1)).toMatchObject({ decision: 'refuse', inputs: { field: 'open', length: 5, limit: 5 } })
  })

  test('a subagent assigning, and an assign while the session moves to another folder, are one refusal line each', async ($, on) => {
    const { world, clock } = seat(on)
    const lines = logging(on)
    await start($)

    const fromSubagent = { ...KEY_TASK, agentId: 'agent-1' } as unknown as Parameters<Engine['tool']['call']>[0]
    expect(((await $.tool.call(fromSubagent)) as { deny?: string }).deny).toContain('Only the main agent')
    expect(lines).toEqual([
      {
        hook: 'human-in-the-loop',
        decision: 'refuse',
        reason: 'a subagent called assign_task; only the main agent assigns tasks.',
        session: 'session-1',
        inputs: { field: 'caller' },
      },
    ])

    // Resumed into another folder, with the store slow to answer: the session is still moving.
    world.isStuck = true
    await clock.advance(60_000)
    world.sessionId = 'session-3'
    world.root = '/other'
    const resumed = $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
    await clock.advance(10_000)
    await resumed
    await clock.settle()

    expect(((await $.tool.call(KEY_TASK)) as { deny?: string }).deny).toContain('still joining its project')
    expect(lines.at(-1)).toEqual({
      hook: 'human-in-the-loop',
      decision: 'refuse',
      reason: 'the session is still joining its project.',
      session: 'session-3',
      inputs: { field: 'moving' },
    })
    world.unstick?.()
    await clock.settle()
  })

  test('a stored task whose done_when, detail, answer or reason is not text is skipped as no task', () => {
    const slotWith = (task: Record<string, unknown>) =>
      projectOf('/repo', { [keysOf('/repo').session('session-0')]: { tasks: [task], seenMs: 0, endedMs: 0 } }).slots['session-0']?.tasks

    expect(slotWith({ ...ROTATE, detail: 'The gist is public.' })).toHaveLength(1)

    for (const key of ['doneWhen', 'detail', 'answer', 'reason']) {
      expect([key, slotWith({ ...ROTATE, [key]: 42 })]).toEqual([key, []])
    }
  })

  test('a log directory that cannot be written leaves the task assigned', async ($, on) => {
    seat(on)
    on('env.get', () => ({ value: '/nonexistent/readonly' }))
    on('fs.exists', () => ({ value: true }))
    on('process.run', () => {
      throw new Error('EACCES')
    })
    await start($)

    const assigned = (await $.tool.call(KEY_TASK)) as { result?: unknown }
    const refused = await refusal($, { why: 'w'.repeat(301) })

    expect(String(assigned.result)).toContain('Assigned task #1')
    expect(refused).toContain('why is 301 characters')
  })

  test('a writer that hangs delays the task by half a second at most', async ($, on) => {
    const { clock } = seat(on)
    on('env.get', () => ({ value: '/prof' }))
    on('fs.exists', () => ({ value: true }))
    on('process.run', () => new Promise(() => {}))
    await start($)

    let isDone = false
    const assigning = $.tool.call(KEY_TASK).then(answer => {
      isDone = true
      return answer
    })

    await clock.advance(499)
    expect(isDone).toBe(false)
    await clock.advance(2)
    expect(String(((await assigning) as { result?: unknown }).result)).toContain('Assigned task #1')
  })
})

// The answer endpoint: a local listener, answer_endpoint.py, hands the
// session answers given outside the pane (the dashboard). Here
// `listening` stands in for that listener at the `process.spawn` seam, and
// for the files the two share; tests/test_hitl_endpoint.py covers the
// listener itself, against the same line format.
describe('the answer endpoint', () => {
  const ON = { options: { answer_endpoint: true } } as const

  /** The session a listener was started for, from its one `--session=<id>` argument. */
  const sessionOf = (argv: readonly string[]) => argv.find(arg => arg.startsWith('--session='))?.slice('--session='.length)

  type Child = {
    argv: readonly string[]
    results: string
    queue: string[]
    wake: () => void
    isOver: boolean
    isEnded: boolean
  }

  /**
   * Stands in for answer_endpoint.py beneath the plugin: each spawn is a
   * child that prints its ready line, then the lines a test sends it, and
   * ends when the plugin writes its stop file, ends its stream, or the test
   * ends it (`exit`). The results directory exists while its child runs.
   */
  function listening(on: On, { hasWriter = false } = {}) {
    const children: Child[] = []
    const files = new Map<string, string>()
    const dirs = new Set<string>()
    const deafened = new Set<Child>()

    on('process.spawn', async function* ($, e) {
      const child: Child = {
        argv: e.argv,
        results: `/prof/hitl-endpoint/${sessionOf(e.argv) ?? ''}.${4242 + children.length}.results`,
        queue: [],
        wake: () => {},
        isOver: false,
        isEnded: false,
      }
      children.push(child)
      dirs.add(child.results)

      try {
        yield { stream: 'stdout' as const, text: `${JSON.stringify({ type: 'ready', results: child.results })}\n` }

        while (!child.isOver) {
          const text = child.queue.shift()

          if (text !== undefined) {
            yield { stream: 'stdout' as const, text }
          } else {
            await new Promise<void>(resolve => {
              child.wake = resolve
            })
          }
        }

        return { value: { code: 0, signal: null } }
      } finally {
        child.isEnded = true
        dirs.delete(child.results)
      }
    })
    const asked: string[] = []
    on('fs.exists', ($, e) => {
      asked.push(e.path)
      return { value: dirs.has(e.path) || files.has(e.path) || (hasWriter && e.path.endsWith('/hooks/decision_log.py')) }
    })
    on('fs.write', ($, e) => {
      files.set(e.path, e.text)
      // The listener ends once it sees its stop file.
      const child = children.find(one => e.path === `${one.results}/stop` && dirs.has(one.results) && !deafened.has(one))

      if (child !== undefined) {
        child.isOver = true
        child.wake()
      }

      return { value: undefined }
    })

    const latest = () => {
      const child = children.at(-1)

      if (child === undefined) {
        throw new Error('no listener was started')
      }

      return child
    }

    return {
      children,
      files,
      /** Every path the plugin asked about, in order. */
      asked,
      /** Has the latest listener print `text` as it is, split or not. */
      print(text: string, child = latest()) {
        child.queue.push(text)
        child.wake()
      },
      /** Has the latest listener hand the plugin one request line. */
      send(line: Record<string, unknown>, child = latest()) {
        this.print(`${JSON.stringify({ type: 'answer', ...line })}\n`, child)
      },
      /** Has `child` not look at its stop file: it runs on until its stream is ended. */
      deaf(child = latest()) {
        deafened.add(child)
      },
      /** Ends the latest listener as a crash would. */
      exit(child = latest()) {
        child.isOver = true
        child.wake()
      },
      /** The result the plugin wrote for `requestId`, parsed; undefined while none. */
      resultOf(requestId: string, child = latest()): Record<string, unknown> | undefined {
        const text = files.get(`${child.results}/${requestId}.json`)
        return text === undefined ? undefined : (JSON.parse(text) as Record<string, unknown>)
      },
    }
  }

  test('with the setting on, the session starts one listener for itself, from the plugin folder', ON, async ($, on) => {
    seat(on)
    const endpoint = listening(on)
    await start($)

    expect(endpoint.children).toHaveLength(1)
    const argv = endpoint.children[0]?.argv ?? []
    expect(argv.slice(0, 2)).toEqual(['python3', '-I'])
    expect(argv[2]?.endsWith('/hooks/answer_endpoint.py')).toBe(true)
    // One argument: a session id that starts with a dash is not read as an option.
    expect(argv.slice(3)).toEqual(['--session=session-1'])
  })

  let requests = 0

  /** A request for task #1 as the session holds it, Done unless `fields` say otherwise. */
  const request = (fields: Record<string, unknown> = {}) => ({
    request_id: `request-${String(++requests).padStart(8, '0')}`,
    session_id: 'session-1',
    task_id: 1,
    created_ms: NOW,
    version: NOW,
    action: 'done',
    ...fields,
  })

  test('an answer through the endpoint reaches Claude as the same press in the pane does, and the pane updates', ON, async ($, on) => {
    const PRESSED = 'My response to a task you gave me (Human in the loop):\n\n#1 Add STRIPE_SECRET_KEY to .env: Done.'
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    expect(await textOf(ui, 'task-1')).toContain('Add STRIPE_SECRET_KEY')

    const done = request()
    endpoint.send(done)
    await clock.settle()

    expect(endpoint.resultOf(done.request_id)).toEqual({
      request_id: done.request_id,
      outcome: 'accepted',
      task: { session_id: 'session-1', id: 1, created_ms: NOW, version: NOW, state: 'done' },
    })
    await clock.advance(1000)
    await clock.settle()
    expect(world.submitted).toEqual([PRESSED])
    expect(world.isPaneOpen).toBe(false)
    expect(world.status).toBeUndefined()
  })

  test('Archive through the endpoint sends the live session nothing; an answer to the archived task is refused; Restore brings it back, sending nothing (#187)', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(KEY_TASK)
    await clock.advance(1000)

    const archive = request({ action: 'archive' })
    endpoint.send(archive)
    await clock.settle()

    expect(endpoint.resultOf(archive.request_id)).toEqual({
      request_id: archive.request_id,
      outcome: 'accepted',
      task: { session_id: 'session-1', id: 1, created_ms: NOW, version: NOW + 1000, state: 'open' },
    })
    await clock.advance(1000)
    await clock.settle()
    expect(world.submitted).toEqual([])
    expect(world.appended).toEqual([])
    expect(world.status).toBeUndefined()
    expect(projectOf('/repo', world.store).slots['session-1']?.tasks[0]?.archivedMs).toBe(NOW + 1000)

    const late = request({ version: NOW + 1000 })
    endpoint.send(late)
    await clock.settle()
    expect(endpoint.resultOf(late.request_id)).toMatchObject({ outcome: 'closed', message: 'Task #1 is archived: restore it first.' })

    const stale = request({ action: 'restore' })
    endpoint.send(stale)
    await clock.settle()
    expect(endpoint.resultOf(stale.request_id)).toMatchObject({ outcome: 'stale' })

    const restore = request({ action: 'restore', version: NOW + 1000 })
    endpoint.send(restore)
    await clock.settle()
    expect(endpoint.resultOf(restore.request_id)).toMatchObject({ outcome: 'accepted', task: { state: 'open', version: NOW + 2000 } })
    await clock.advance(1000)
    await clock.settle()
    expect(world.submitted).toEqual([])
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(projectOf('/repo', world.store).slots['session-1']?.tasks[0]?.archivedMs).toBeUndefined()
  })

  test('archive and restore take no text: a request carrying one is refused whole (#187)', ON, async ($, on) => {
    const { clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(KEY_TASK)

    const archive = request({ action: 'archive', reason: 'stale' })
    endpoint.send(archive)
    await clock.settle()

    expect(endpoint.resultOf(archive.request_id)).toMatchObject({ outcome: 'refused' })
  })

  test("an Archive of an ended session's task, sent to a live session in its project, is taken on there, numbered anew, and archived; Claude hears nothing (#187)", ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(KEY_TASK)
    // Ended after this session joined: its slot waits for the next session, and its #1 meets this one's.
    world.store[KEYS.session('session-0')] = { tasks: [{ ...ROTATE, id: 1 }], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 2 }
    world.store[KEYS.session('session-3')] = { tasks: [{ ...ROTATE, id: 5, createdMs: 5, sessionId: 'session-3' }], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 6 }

    const archive = request({ created_ms: 0, version: 0, action: 'archive' })
    endpoint.send(archive)
    await clock.settle()

    expect(endpoint.resultOf(archive.request_id)).toEqual({
      request_id: archive.request_id,
      outcome: 'accepted',
      task: { session_id: 'session-1', id: 6, created_ms: 0, version: NOW, state: 'open' },
    })
    await clock.advance(1000)
    await clock.settle()
    expect(world.submitted).toEqual([])
    expect(world.appended).toEqual([])
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    const slots = projectOf('/repo', world.store).slots
    // Only the slot that held it is taken on; the other ended one waits for the next session.
    expect(slots['session-0']).toBeUndefined()
    expect(slots['session-3']?.tasks.map(task => task.id)).toEqual([5])
    expect(slots['session-1']?.tasks.map(task => [task.id, task.sessionId, task.archivedMs])).toEqual([
      [1, 'session-1', undefined],
      [6, 'session-0', NOW],
    ])
  })

  test("an ended session's task is left where it is when it is stale, or its slot holds an answer Claude has not heard (#187)", ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    const told = { ...ROTATE, id: 3, createdMs: 3, title: 'Answered, not yet told', state: 'done', update: 'pending' }
    const ended = { tasks: [ROTATE, told], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 }
    world.store[KEYS.session('session-0')] = ended

    const stale = request({ task_id: 7, created_ms: 0, version: 5, action: 'archive' })
    endpoint.send(stale)
    const pending = request({ task_id: 7, created_ms: 0, version: 0, action: 'archive' })
    endpoint.send(pending)
    const nobody = request({ task_id: 9, created_ms: 0, version: 0, action: 'archive' })
    endpoint.send(nobody)
    await clock.settle()

    expect(endpoint.resultOf(stale.request_id)).toMatchObject({ outcome: 'stale', task: { id: 7, version: 0 } })
    expect(endpoint.resultOf(pending.request_id)).toMatchObject({ outcome: 'refused', message: expect.stringContaining('answers Claude has not heard yet') })
    expect(endpoint.resultOf(nobody.request_id)).toMatchObject({ outcome: 'unknown' })
    expect(projectOf('/repo', world.store).slots['session-0']?.tasks).toEqual(ended.tasks)
    expect(world.submitted).toEqual([])
  })

  test("with the endpoint on, a session that assigned nothing has a slot from its start, so an ended session's task is archived through it (#187)", ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)

    // The dashboard finds a project's live sessions by their slots.
    expect(projectOf('/repo', world.store).slots['session-1']?.tasks).toEqual([])

    world.store[KEYS.session('session-0')] = { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 }
    const archive = request({ task_id: 7, created_ms: 0, version: 0, action: 'archive' })
    endpoint.send(archive)
    await clock.settle()

    expect(endpoint.resultOf(archive.request_id)).toMatchObject({ outcome: 'accepted', task: { session_id: 'session-1', id: 7 } })
    expect(world.submitted).toEqual([])
  })

  test("an ended session's Archive held up in its takeover as /clear completes is told gone; the next session holds the task, not archived (#187)", ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on, { hasWriter: true })
    const outcomes = loggedOutcomes(on)
    await start($)
    world.store[KEYS.session('session-0')] = { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 }

    // Held at the takeover's read of what the session took, after it read the project.
    let release = () => {}
    let isArmed = true
    world.onCall = async call => {
      if (isArmed && call === 'state.get took') {
        isArmed = false
        await new Promise<void>(resolve => {
          release = resolve
        })
      }
    }
    endpoint.send(request({ task_id: 7, created_ms: 0, version: 0, action: 'archive' }))
    await clock.settle()
    expect(isArmed).toBe(false)

    world.sessionId = 'session-2'
    const ended = $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-2' } })
    await clock.advance(1)
    await clock.settle()
    release()
    await clock.settle()
    await ended
    await clock.advance(1000)
    await clock.settle()

    expect(outcomes()).toEqual(['gone'])
    expect(world.submitted).toEqual([])
    const slots = projectOf('/repo', world.store).slots
    expect(slots['session-0']).toBeUndefined()
    expect(slots['session-2']?.tasks.map(task => [task.id, task.sessionId, task.archivedMs])).toEqual([[7, 'session-0', undefined]])
  })

  test('a Restore past the 7-day mark is refused: the task is deleted, not restored (#187)', ON, async ($, on) => {
    const own = { ...ROTATE, id: 1, sessionId: 'session-1', archivedMs: LATE - ARCHIVE_KEEP_MS }
    const { world, clock } = seat(on, { [KEYS.session('session-1')]: { tasks: [own], seenMs: LATE - 10 * 60_000, nextId: 2 } }, LATE)
    const endpoint = listening(on)
    await start($)
    await clock.advance(1)

    const restore = request({ created_ms: 0, version: 0, action: 'restore' })
    endpoint.send(restore)
    await clock.settle()

    expect(endpoint.resultOf(restore.request_id)).toMatchObject({ outcome: 'closed', message: 'Task #1 was archived over 7 days ago and is deleted.' })
    expect(projectOf('/repo', world.store).slots['session-1']?.tasks[0]?.archivedMs).toBe(LATE - ARCHIVE_KEEP_MS)
  })

  test('each kind of answer reaches Claude in the words its press in the pane sends', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(PAGING_TASK)
    await $.tool.call(XCODE_TASK)
    await $.tool.call(KEY_TASK)
    await $.tool.call({ ...KEY_TASK, title: 'Approve the staging deploy' })

    endpoint.send(request({ task_id: 1, action: 'choose', option: 'Cursor' }))
    endpoint.send(request({ task_id: 2, action: 'answer', text: '  LoginTests.testExpiredToken\nCartTests.testCouponRounding  ' }))
    endpoint.send(request({ task_id: 3, action: 'reject', reason: 'I will do it\n after the deploy' }))
    endpoint.send(request({ task_id: 4, action: 'reject' }))
    await clock.settle()
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toEqual([
      [
        'My responses to tasks you gave me (Human in the loop):',
        '',
        '#1 Pick a pagination strategy for /feed: I chose "Cursor".',
        '',
        '#2 Run xcodebuild test on your Mac, paste the failures:\nLoginTests.testExpiredToken\nCartTests.testCouponRounding',
        '',
        "#3 Add STRIPE_SECRET_KEY to .env: I won't do this. I will do it after the deploy",
        '',
        "#4 Approve the staging deploy: I won't do this.",
      ].join('\n'),
    ])
  })

  test('an answer through the endpoint while Claude works is saved, shown in the pane, and goes when the turn ends', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(XCODE_TASK)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    const ui = await $.ui.mount(PANE)

    endpoint.send(request({ action: 'answer', text: 'LoginTests.testExpiredToken failed' }))
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toHaveLength(0)
    expect(await textOf(ui, 'saved-1')).toContain('not sent yet')
    expect(world.status).toBe('✓ 1 not sent yet · /my-tasks')

    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()

    expect(world.submitted).toEqual([
      'My response to a task you gave me (Human in the loop):\n\n#1 Run xcodebuild test on your Mac, paste the failures:\nLoginTests.testExpiredToken failed',
    ])
  })

  /** Sends `line` and resolves the outcome the plugin wrote for it. */
  async function outcomeOf(endpoint: ReturnType<typeof listening>, clock: { settle: () => Promise<void> }, line: Record<string, unknown>) {
    endpoint.send(line)
    await clock.settle()
    return endpoint.resultOf(String(line['request_id']))
  }

  test('a task named by its number with another created_ms is unknown, and the task of that number stays as it was', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(KEY_TASK)

    const result = await outcomeOf(endpoint, clock, request({ created_ms: NOW - 1 }))
    await clock.advance(1000)
    await clock.settle()

    expect(result?.['outcome']).toBe('unknown')
    expect(result?.['task']).toBeUndefined()
    expect(world.submitted).toEqual([])
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })

  test('an answer to a version the task has left is stale, and leaves the field open on it with its draft', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'half typed', kind: 'change' })

    const result = await outcomeOf(endpoint, clock, request({ version: NOW - 5, action: 'answer', text: 'from the phone' }))
    await clock.advance(1000)
    await clock.settle()

    expect(result).toEqual({
      request_id: expect.any(String),
      outcome: 'stale',
      message: 'Task #1 changed since that version.',
      task: { session_id: 'session-1', id: 1, created_ms: NOW, version: NOW, state: 'open' },
    })
    expect(world.submitted).toEqual([])
    // The field is still open, and what was typed in it is the answer Save for later sends.
    expect(await ui.find({ type: 'Input', key: 'answer-1' })).toBeDefined()
    await ui.press({ key: 'other-way' })
    await ui.press({ key: 'send-1' })
    await clock.settle()
    expect(world.submitted).toEqual(['My response to a task you gave me (Human in the loop):\n\n#1 Run xcodebuild test on your Mac, paste the failures:\nhalf typed'])
  })

  test('an answer to a task already answered in the pane is closed at its new version, and stale at the old one', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(KEY_TASK)
    await clock.advance(10)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })

    const old = await outcomeOf(endpoint, clock, request({ action: 'reject' }))
    const current = await outcomeOf(endpoint, clock, request({ version: NOW + 10, action: 'reject' }))
    await clock.advance(1000)
    await clock.settle()

    expect(old?.['outcome']).toBe('stale')
    expect(current?.['outcome']).toBe('closed')
    expect(current?.['task']).toEqual({ session_id: 'session-1', id: 1, created_ms: NOW, version: NOW + 10, state: 'done' })
    expect(world.submitted).toEqual(['My response to a task you gave me (Human in the loop):\n\n#1 Add STRIPE_SECRET_KEY to .env: Done.'])
  })

  test('only what the pane offers for a task is taken: Done or an option as its kind has them, an answer in words, a rejection', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(PAGING_TASK)
    await $.tool.call(KEY_TASK)

    const refusals = [
      [request({ task_id: 1, action: 'done' }), 'Task #1 asks for one of its options: send choose, or answer.'],
      [request({ task_id: 1, action: 'choose', option: 'cursor' }), 'option is none of the task’s options.'],
      [request({ task_id: 2, action: 'choose', option: 'Cursor' }), 'Task #2 has no options: send done, or answer.'],
      [request({ task_id: 2, action: 'answer', text: ' \n\t ' }), 'text is empty.'],
    ] as const

    for (const [line, message] of refusals) {
      const result = await outcomeOf(endpoint, clock, line)

      expect(result?.['outcome']).toBe('refused')
      expect(result?.['message']).toBe(message)
    }

    await clock.advance(1000)
    await clock.settle()
    expect(world.submitted).toEqual([])
    expect(world.status).toBe('☐ 2 tasks for you · /my-tasks')
  })

  test('an answer that looks like a secret is refused, and neither held in the pane, toasted, nor put in the prompt box', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(XCODE_TASK)

    const result = await outcomeOf(endpoint, clock, request({ action: 'answer', text: `the key is ${KEY_SHAPED}` }))
    await clock.advance(1000)
    await clock.settle()

    expect(result?.['outcome']).toBe('refused')
    expect(result?.['message']).toBe('text looks like a secret, so it was not sent: put it where it belongs, then send done.')
    expect(JSON.stringify(result)).not.toContain(KEY_SHAPED)
    expect(JSON.stringify(world.store)).not.toContain(KEY_SHAPED)
    expect(world.submitted).toEqual([])
    expect(world.toasts).toEqual([])
    expect(world.composer).toBe('')
    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ key: 'held' })).toBeUndefined()
  })

  test('an answer over 10,000 characters, or a reason over 1,000, is refused with its length; at the limit it is taken', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(XCODE_TASK)
    await $.tool.call(KEY_TASK)
    const words = (n: number) => 'ab '.repeat(n).slice(0, n - 1) + 'z'

    const long = await outcomeOf(endpoint, clock, request({ action: 'answer', text: words(10_001) }))
    const reason = await outcomeOf(endpoint, clock, request({ task_id: 2, action: 'reject', reason: words(1_001) }))

    expect(long?.['message']).toBe('text is 10001 characters; the limit is 10000.')
    expect(reason?.['message']).toBe('reason is 1001 characters; the limit is 1000.')

    const exact = await outcomeOf(endpoint, clock, request({ action: 'answer', text: words(10_000) }))
    const exactReason = await outcomeOf(endpoint, clock, request({ task_id: 2, action: 'reject', reason: words(1_000) }))
    await clock.advance(1000)
    await clock.settle()

    expect([exact?.['outcome'], exactReason?.['outcome']]).toEqual(['accepted', 'accepted'])
    expect(world.submitted).toHaveLength(1)
  })

  test("a request naming another session is told it is gone, and touches this session's task of that number", ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(KEY_TASK)

    const result = await outcomeOf(endpoint, clock, request({ session_id: 'session-0' }))
    await clock.advance(1000)
    await clock.settle()

    expect(result?.['outcome']).toBe('gone')
    expect(world.submitted).toEqual([])
  })

  test('a request while the session moves to another folder is busy, and the same request sent again is applied afresh', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(KEY_TASK)
    world.isStuck = true
    await clock.advance(60_000)
    world.sessionId = 'session-3'
    world.root = '/other'
    const resumed = $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
    await clock.advance(10_000)
    await resumed
    await clock.settle()

    expect(endpoint.children.map(child => sessionOf(child.argv))).toEqual(['session-1', 'session-3'])
    const line = request({ session_id: 'session-3' })
    expect((await outcomeOf(endpoint, clock, line))?.['outcome']).toBe('busy')

    world.unstick?.()
    await clock.settle()
    world.unstick?.()
    await clock.settle()

    // In the new folder the session holds no task #1: the request is judged again, not answered busy from memory.
    expect((await outcomeOf(endpoint, clock, line))?.['outcome']).toBe('unknown')
  })

  // Races (requirement 6). Each forces its interleaving: one side's read of
  // the task list answers late, with the list as it stood when asked.
  test('6a: a press in the pane landing while an endpoint answer reads the task wins, and the endpoint is told stale', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)

    world.slowRead = 'tasks'
    world.readMs = 500
    const line = request({ action: 'reject', reason: 'from the phone' })
    endpoint.send(line)
    await clock.advance(1)
    await ui.press({ key: 'done' })
    await clock.advance(500)
    await clock.settle()
    await clock.advance(1000)
    await clock.settle()

    expect(endpoint.resultOf(line.request_id)?.['outcome']).toBe('stale')
    expect(world.submitted).toEqual(['My response to a task you gave me (Human in the loop):\n\n#1 Add STRIPE_SECRET_KEY to .env: Done.'])
    expect(world.toasts).toEqual([])
  })

  test('6a: an endpoint answer landing while a press in the pane reads the task wins, and the pane says the task is gone', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)

    world.slowRead = 'tasks'
    world.readMs = 500
    const pressed = ui.press({ key: 'done' })
    await clock.advance(1)
    const line = request({ action: 'reject', reason: 'from the phone' })
    endpoint.send(line)
    await clock.settle()
    await clock.advance(500)
    await pressed
    await clock.advance(1000)
    await clock.settle()

    expect(endpoint.resultOf(line.request_id)?.['outcome']).toBe('accepted')
    expect(world.submitted).toEqual([
      "My response to a task you gave me (Human in the loop):\n\n#1 Add STRIPE_SECRET_KEY to .env: I won't do this. from the phone",
    ])
    expect(world.toasts).toEqual(["Task #1 isn't open any more, so your response wasn't saved."])
  })

  test('6b: of two endpoint answers to one task at once, the first to land is taken and the other is stale; Claude hears one', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(XCODE_TASK)
    await clock.advance(5)

    world.slowRead = 'tasks'
    world.readMs = 500
    const slow = request({ action: 'answer', text: 'from the laptop' })
    const fast = request({ action: 'answer', text: 'from the phone' })
    endpoint.print(`${JSON.stringify({ type: 'answer', ...slow })}\n${JSON.stringify({ type: 'answer', ...fast })}\n`)
    await clock.settle()
    await clock.advance(500)
    await clock.settle()
    await clock.advance(1000)
    await clock.settle()

    expect(endpoint.resultOf(fast.request_id)?.['outcome']).toBe('accepted')
    expect(endpoint.resultOf(slow.request_id)?.['outcome']).toBe('stale')
    expect(world.submitted).toEqual([
      'My response to a task you gave me (Human in the loop):\n\n#1 Run xcodebuild test on your Mac, paste the failures:\nfrom the phone',
    ])
  })

  test('6c: an answer to a task Claude withdrew is closed, and Claude hears nothing of it', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(KEY_TASK)
    await $.tool.call({ tool: WITHDRAW, id: 1, reason: 'Found the key in the vault' })

    const result = await outcomeOf(endpoint, clock, request())
    await clock.advance(1000)
    await clock.settle()

    expect(result?.['outcome']).toBe('closed')
    expect((result?.['task'] as { state?: string } | undefined)?.state).toBe('withdrawn')
    expect(world.submitted).toEqual([])
  })

  test('6c: a withdraw landing while an endpoint answer reads the task wins: the answer is stale', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(KEY_TASK)

    world.slowRead = 'tasks'
    world.readMs = 500
    const line = request()
    endpoint.send(line)
    await clock.advance(1)
    const withdrawn = await $.tool.call({ tool: WITHDRAW, id: 1 })
    await clock.advance(500)
    await clock.settle()
    await clock.advance(1000)
    await clock.settle()

    expect(String((withdrawn as { result?: unknown }).result)).toContain('Withdrew task #1')
    expect(endpoint.resultOf(line.request_id)?.['outcome']).toBe('stale')
    expect(world.submitted).toEqual([])
    // It stays withdrawn: nothing waits for Claude, and the next prompt carries nothing.
    expect(world.status).toBeUndefined()
    expect((await $.prompt.submit(typed('next'))).context).toBeUndefined()
  })

  test('6d: the session ending stops its listener (stop file, then its stream), and a request still coming is told gone', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(KEY_TASK)
    const child = endpoint.children[0]
    expect(child?.isEnded).toBe(false)

    // The listener has not looked at its stop file yet when the last request comes.
    endpoint.deaf(child)
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.settle()
    expect(endpoint.files.has(`${child?.results}/stop`)).toBe(true)

    const line = request()
    endpoint.send(line, child)
    await clock.settle()

    expect(endpoint.resultOf(line.request_id, child)?.['outcome']).toBe('gone')
    // Ending the stream waits for the read under way; then the child is ended.
    expect(child?.isEnded).toBe(true)
    expect(projectOf('/repo', world.store).slots['session-1']?.tasks.map(task => task.state)).toEqual(['open'])
    expect(world.submitted).toEqual([])
  })

  test('6d: a request held up as /clear completes is never applied to the task the next session took on', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on, { hasWriter: true })
    const lines: { decision?: string; inputs?: Record<string, unknown> }[] = []
    on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? '/prof' : undefined }))
    on('process.run', (_, e) => {
      lines.push(JSON.parse(e.init?.stdin ?? '{}'))
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    await start($)
    await $.tool.call(KEY_TASK)

    // The request reads the task list late; meanwhile /clear completes and the
    // next session takes the task on, at the same number, created_ms and version.
    world.slowRead = 'tasks'
    world.readMs = 500
    endpoint.send(request())
    await clock.advance(1)
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(1)
    await clock.settle()
    expect(projectOf('/repo', world.store).slots['session-2']?.tasks.map(task => [task.id, task.createdMs, task.updatedMs])).toEqual([[1, NOW, NOW]])
    await clock.advance(500)
    await clock.settle()
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toEqual([])
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(projectOf('/repo', world.store).slots['session-2']?.tasks.map(task => task.state)).toEqual(['open'])
    expect(lines.filter(line => line.decision === 'answer').map(line => line.inputs?.['outcome'])).toEqual(['gone'])
  })

  const KEYS = keysOf('/repo')

  /** The outcome of each answer the session judged, from its decision-log lines: an ended listener's result file is never written. */
  function loggedOutcomes(on: On) {
    const lines: { decision?: string; inputs?: Record<string, unknown> }[] = []
    on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? '/prof' : undefined }))
    on('process.run', (_, e) => {
      lines.push(JSON.parse(e.init?.stdin ?? '{}'))
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })

    return () => lines.filter(line => line.decision === 'answer').map(line => line.inputs?.['outcome'])
  }

  /**
   * What the field `key` holds, undefined while it is closed: the pane hidden
   * and opened again draws it with its draft (a drawing keeps the value it
   * began with).
   */
  async function draftOf($: Engine, ui: Mounted<'terminal', 'Pane'>, key: string): Promise<unknown> {
    if ((await ui.find({ type: 'Input', key })) === undefined) {
      return undefined
    }

    await ui.press({ key: 'hide' })
    await ui.unmount()
    await runTasks($)
    return (await (await $.ui.mount(PANE)).find({ type: 'Input', key }))?.props.value
  }

  test('6d: a request held up inside wake(), reading the project as /clear completes, is never applied to the task the next session took on', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on, { hasWriter: true })
    const outcomes = loggedOutcomes(on)
    await start($)
    await $.tool.call(KEY_TASK)

    // Two heartbeats with the store out of reach: the slot is two heartbeats
    // old, so the request's wake() reads the project, and that read hangs.
    world.isStoreFailing = true
    await clock.advance(2 * 60_000)
    world.isStoreFailing = false
    world.isStuck = true
    endpoint.send(request())
    await clock.advance(1)
    world.sessionId = 'session-2'
    const cleared = $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(10_000)
    await cleared
    world.unstick?.()
    await clock.settle()
    await clock.advance(1000)
    await clock.settle()

    expect(outcomes()).toEqual(['gone'])
    expect(world.submitted).toEqual([])
    expect(projectOf('/repo', world.store).slots['session-2']?.tasks.map(task => [task.id, task.state, task.update])).toEqual([[1, 'open', 'none']])
  })

  test('6d: a request held up as /clear completes leaves the answer field open on that task in the next session, with what was typed in it', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'half an answer', kind: 'change' })

    world.slowRead = 'tasks'
    world.readMs = 500
    endpoint.send(request())
    await clock.advance(1)
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(1)
    await clock.settle()
    await clock.advance(500)
    await clock.settle()
    await clock.advance(1000)
    await clock.settle()

    expect(await draftOf($, ui, 'answer-1')).toBe('half an answer')
    expect(world.submitted).toEqual([])
  })

  test('at a start with the store slow, a request before the session has read its project is busy, remembered nowhere, and the same request is taken once it has', ON, async ($, on) => {
    // A new process resumes session 1: its own slot, ended, holds task #7.
    const { world, clock } = seat(on, { [KEYS.session('session-1')]: { tasks: [{ ...ROTATE, sessionId: 'session-1' }], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 } })
    const endpoint = listening(on)
    world.isStuck = true
    const started = start($)
    await clock.advance(5000)
    await started

    const line = request({ task_id: 7, created_ms: 0, version: 0 })
    const first = await outcomeOf(endpoint, clock, line)
    world.unstick?.()
    await clock.settle()
    const again = await outcomeOf(endpoint, clock, line)
    await clock.advance(1000)
    await clock.settle()

    expect(first?.['outcome']).toBe('busy')
    expect(again?.['outcome']).toBe('accepted')
    expect(world.submitted).toHaveLength(1)
    expect(world.submitted[0]).toContain('#7 Rotate the leaked token in Vault: Done.')
  })

  test('at a resume with the store slow, a request before the resumed session has read its project is busy, remembered nowhere, and the same request is taken once it has', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(KEY_TASK)

    // Session 3, resumed, holds task #7 of its own; its first read of the project hangs.
    world.store[KEYS.session('session-3')] = { tasks: [{ ...ROTATE, sessionId: 'session-3' }], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 }
    world.isStuck = true
    world.sessionId = 'session-3'
    const resumed = $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
    await clock.advance(10_000)
    await resumed
    await clock.settle()
    expect(endpoint.children.map(child => [sessionOf(child.argv), child.isEnded])).toEqual([
      ['session-1', true],
      ['session-3', false],
    ])

    // #7 is session 3's own; #1, which the process still holds as it reads, is session 1's.
    const own = request({ session_id: 'session-3', task_id: 7, created_ms: 0, version: 0 })
    const held = request({ session_id: 'session-3' })
    const first = await outcomeOf(endpoint, clock, own)
    const other = await outcomeOf(endpoint, clock, held)
    world.unstick?.()
    await clock.settle()
    const again = await outcomeOf(endpoint, clock, own)
    await clock.advance(1000)
    await clock.settle()

    expect(first?.['outcome']).toBe('busy')
    expect(other?.['outcome']).toBe('busy')
    expect(again?.['outcome']).toBe('accepted')
    expect(world.submitted).toHaveLength(1)
    expect(world.submitted[0]).toContain('#7 Rotate the leaked token in Vault: Done.')
  })

  test('a request told gone as the session resumes in place is judged afresh when it comes again, and applied once', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on, { hasWriter: true })
    const outcomes = loggedOutcomes(on)
    await start($)
    await $.tool.call(KEY_TASK)

    world.slowRead = 'tasks'
    world.readMs = 500
    const line = request()
    endpoint.send(line)
    await clock.advance(1)
    await $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(1)
    await clock.settle()
    await clock.advance(500)
    await clock.settle()
    expect(outcomes()).toEqual(['gone'])

    // The caller lost its connection as the old listener ended, and sends the request again to the new one.
    const again = await outcomeOf(endpoint, clock, line)
    await clock.advance(1000)
    await clock.settle()

    expect(again?.['outcome']).toBe('accepted')
    expect(outcomes()).toEqual(['gone', 'accepted'])
    expect(world.submitted).toEqual(['My response to a task you gave me (Human in the loop):\n\n#1 Add STRIPE_SECRET_KEY to .env: Done.'])
  })

  /**
   * Traces the clock and state reads the plugin makes once armed (`calls`):
   * with `arm`, up to its next write of the task list; with `armAfterChange`,
   * from that write up to its next write of the selection, where the pane
   * cleanup ends. Armed at an index, holds the read of that index, its
   * answer read, until `release`.
   */
  // TODO(deferred): #140 holding reports isHeld at a store, fs, session or process call, which the seat only traces; make it throw there
  function holding(on: On, world: ReturnType<typeof seat>['world']) {
    const calls: string[] = []
    let at = -1
    let span: 'none' | 'to change' | 'awaiting change' | 'after change' = 'none'
    let isHeld = false
    let release = () => {}

    on('state.set', { plugin: 'human-in-the-loop' }, ($, e, next) => {
      if (e.key === 'tasks' && span !== 'after change') {
        span = span === 'awaiting change' ? 'after change' : 'none'
      } else if (e.key === 'selectedId' && span === 'after change') {
        span = 'none'
      }

      return next(e)
    })
    world.onCall = async call => {
      if (span !== 'to change' && span !== 'after change') {
        return
      }

      calls.push(call)

      if (calls.length - 1 === at) {
        isHeld = true
        await new Promise<void>(resolve => {
          release = resolve
        })
        isHeld = false
      }
    }

    return {
      calls,
      arm(index = -1) {
        calls.length = 0
        at = index
        span = 'to change'
      },
      armAfterChange(index = -1) {
        calls.length = 0
        at = index
        span = 'awaiting change'
      },
      isHeld: () => isHeld,
      release: () => release(),
    }
  }

  test('every wait of an endpoint request, from its arrival to its task change, is in the list the session keeps of them', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    const trace = holding(on, world)
    await start($)
    await $.tool.call(KEY_TASK)
    await clock.settle()

    trace.arm()
    const line = request()
    endpoint.send(line)
    await clock.settle()

    expect(endpoint.resultOf(line.request_id)?.['outcome']).toBe('accepted')
    expect(trace.calls).toEqual(ENDPOINT_WAITS.map(one => one.call))
  })

  /** Each way a session ends, and where its task, the field open on it and the draft are once the session after it has joined. */
  const ENDINGS = [
    { ending: '/clear', reason: 'clear', next: 'session-2', field: 'answer-1', tasks: [[1, 'open', 'none', NOW]] },
    { ending: 'an exit', reason: 'prompt_input_exit', next: 'session-1', field: 'answer-1', tasks: [[1, 'open', 'none', NOW]] },
    { ending: 'a resume in place', reason: 'resume', next: 'session-1', field: 'answer-1', tasks: [[1, 'open', 'none', NOW]] },
    // Session 3's own task keeps #1; the process's task, numbered anew, takes its field and draft along.
    {
      ending: 'a resume of another conversation',
      reason: 'resume',
      next: 'session-3',
      field: 'answer-2',
      tasks: [
        [1, 'open', 'none', 0],
        [2, 'open', 'none', NOW],
      ],
    },
  ] as const

  for (const [at, { wait }] of ENDPOINT_WAITS.entries()) {
    for (const { ending, reason, next, field, tasks } of ENDINGS) {
      test(`a request held up at its wait "${wait}" as ${ending} completes changes no task, field or draft of the session after, and is told gone`, ON, async ($, on) => {
        const { world, clock } = seat(on)
        const endpoint = listening(on, { hasWriter: true })
        const outcomes = loggedOutcomes(on)
        const trace = holding(on, world)
        await start($)
        await $.tool.call(KEY_TASK)
        const ui = await $.ui.mount(PANE)
        await ui.press({ key: 'answer' })
        await ui.input({ key: 'answer-1', text: 'half an answer', kind: 'change' })
        await clock.settle()

        trace.arm(at)
        endpoint.send(request())
        await clock.settle()
        expect(trace.isHeld()).toBe(true)

        if (next === 'session-3') {
          world.store[KEYS.session('session-3')] = { tasks: [{ ...ROTATE, id: 1, sessionId: 'session-3' }], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 2 }
        }

        world.sessionId = next
        await $.session.end({ reason, sessionId: 'session-1', resume: { id: next } })
        await clock.advance(1)
        await clock.settle()
        trace.release()
        await clock.settle()
        await clock.advance(1000)
        await clock.settle()

        expect(outcomes()).toEqual(['gone'])
        expect(world.submitted).toEqual([])
        expect(projectOf('/repo', world.store).slots[next]?.tasks.map(task => [task.id, task.state, task.update, task.updatedMs])).toEqual(tasks)
        expect(await draftOf($, ui, field)).toBe('half an answer')
      })
    }
  }

  for (const [at, { wait }] of ENDPOINT_WAITS.entries()) {
    test(`an Archive held up at its wait "${wait}" as /clear completes archives none of the next session's tasks, and is told gone (#187)`, ON, async ($, on) => {
      const { world, clock } = seat(on)
      const endpoint = listening(on, { hasWriter: true })
      const outcomes = loggedOutcomes(on)
      const trace = holding(on, world)
      await start($)
      await $.tool.call(KEY_TASK)
      await clock.settle()

      trace.arm(at)
      endpoint.send(request({ action: 'archive' }))
      await clock.settle()
      expect(trace.isHeld()).toBe(true)

      world.sessionId = 'session-2'
      await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-2' } })
      await clock.advance(1)
      await clock.settle()
      trace.release()
      await clock.settle()
      await clock.advance(1000)
      await clock.settle()

      expect(outcomes()).toEqual(['gone'])
      expect(world.submitted).toEqual([])
      expect(projectOf('/repo', world.store).slots['session-2']?.tasks.map(task => [task.id, task.state, task.updatedMs, task.archivedMs])).toEqual([[1, 'open', NOW, undefined]])
    })
  }

  test("an answer held up after its task change as a resume of another conversation completes leaves the field the person opened on that conversation's own #1, and its draft", ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on, { hasWriter: true })
    const outcomes = loggedOutcomes(on)
    let isArmed = false
    let hasChanged = false
    let tasksReads = 0
    let release = () => {}
    on('state.set', { plugin: 'human-in-the-loop' }, ($, e, next) => {
      hasChanged ||= isArmed && e.key === 'tasks'
      return next(e)
    })
    await start($)
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await clock.settle()

    // Held at the second read of the task list after the change: the one `refresh` makes, once the slot is written.
    world.onCall = async call => {
      if (isArmed && hasChanged && call === 'state.get tasks' && ++tasksReads === 2) {
        isArmed = false
        await new Promise<void>(resolve => {
          release = resolve
        })
      }
    }
    isArmed = true
    endpoint.send(request())
    await clock.settle()
    expect(tasksReads).toBe(2)

    // Session 3, resumed, keeps #1 for its own task; the task answered is numbered anew.
    world.store[KEYS.session('session-3')] = { tasks: [{ ...ROTATE, id: 1, sessionId: 'session-3' }], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 2 }
    world.sessionId = 'session-3'
    const ended = $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
    await clock.advance(6000)
    await ended
    await clock.advance(1)
    await clock.settle()
    await ui.press({ key: 'answer' })
    await ui.input({ key: 'answer-1', text: 'typed for session three', kind: 'change' })
    await clock.settle()

    release()
    await clock.settle()
    await clock.advance(1000)
    await clock.settle()

    expect(outcomes()).toEqual(['accepted'])
    expect(world.submitted).toEqual(['My response to a task you gave me (Human in the loop):\n\n#2 Add STRIPE_SECRET_KEY to .env: Done.'])
    // The answer reached Claude, and its task left the list; session 3's own #1 is still open, its field with it.
    expect(projectOf('/repo', world.store).slots['session-3']?.tasks.map(task => [task.id, task.state])).toEqual([[1, 'open']])
    expect(await draftOf($, ui, 'answer-1')).toBe('typed for session three')
  })

  /**
   * Every wait of an endpoint answer after its task change, through the pane
   * cleanup (`refresh`, then `settle`), in order, with the call the engine
   * sees for it. `canEnd`: the session can end, and the next one join, while
   * a request waits there; it cannot at the slot write's own waits, since
   * the next session's join is queued behind that write.
   */
  const AFTER_CHANGE_WAITS = [
    // `writeOwn`, the slot write: whether the project was read, the time, what the slot holds.
    { wait: 'slot loaded', call: 'state.get loadedFor', canEnd: false },
    { wait: 'slot time', call: 'clock.now', canEnd: false },
    { wait: 'slot tasks', call: 'state.get tasks', canEnd: false },
    { wait: 'slot took', call: 'state.get took', canEnd: false },
    { wait: 'slot count', call: 'state.get nextId', canEnd: false },
    { wait: 'slot write', call: 'store.set', canEnd: false },
    // `refresh`: the tasks, for the status line and the pane.
    { wait: 'refresh', call: 'state.get tasks', canEnd: true },
    // `settle`: the field open, dropped when it is on the answered task's number.
    { wait: 'settle', call: 'state.get editing', canEnd: true },
    // `reselect`: the tasks still open, then the selection kept among them.
    { wait: 'reselect', call: 'state.get tasks', canEnd: true },
    { wait: 'selection', call: 'state.get selectedId', canEnd: true },
  ] as const

  test('every wait of an endpoint answer after its task change, through the pane cleanup, is in the list the tests hold it at', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    const trace = holding(on, world)
    await start($)
    await $.tool.call(KEY_TASK)
    await $.ui.mount(PANE)
    await clock.settle()

    trace.armAfterChange()
    const line = request()
    endpoint.send(line)
    await clock.settle()

    expect(endpoint.resultOf(line.request_id)?.['outcome']).toBe('accepted')
    expect(trace.calls).toEqual(AFTER_CHANGE_WAITS.map(one => one.call))
  })

  // Only a resume of another conversation gives the answered task's number
  // to another task, open, whose field the person can open in the session
  // after; after /clear, an exit or a resume in place, the number is still
  // the answered task's.
  for (const [at, { wait, canEnd }] of AFTER_CHANGE_WAITS.entries()) {
    if (!canEnd) {
      continue
    }

    test(`an answer held up at its wait "${wait}" after its task change, as a resume of another conversation completes, leaves the field the person opens there on #1, and its draft`, ON, async ($, on) => {
      const { world, clock } = seat(on)
      const endpoint = listening(on, { hasWriter: true })
      const outcomes = loggedOutcomes(on)
      const trace = holding(on, world)
      await start($)
      await $.tool.call(KEY_TASK)
      const ui = await $.ui.mount(PANE)
      await clock.settle()

      trace.armAfterChange(at)
      endpoint.send(request())
      await clock.settle()
      expect(trace.isHeld()).toBe(true)

      world.store[KEYS.session('session-3')] = { tasks: [{ ...ROTATE, id: 1, sessionId: 'session-3' }], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 2 }
      world.sessionId = 'session-3'
      const ended = $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-3' } })
      await clock.advance(6000)
      await ended
      await clock.advance(1)
      await clock.settle()
      await ui.press({ key: 'answer' })
      await ui.input({ key: 'answer-1', text: 'typed for session three', kind: 'change' })
      await clock.settle()

      trace.release()
      await clock.settle()
      await clock.advance(1000)
      await clock.settle()

      expect(outcomes()).toEqual(['accepted'])
      expect(world.submitted).toEqual(['My response to a task you gave me (Human in the loop):\n\n#2 Add STRIPE_SECRET_KEY to .env: Done.'])
      expect(projectOf('/repo', world.store).slots['session-3']?.tasks.map(task => [task.id, task.state])).toEqual([[1, 'open']])
      expect(await draftOf($, ui, 'answer-1')).toBe('typed for session three')
    })
  }

  test('the version check stands on its own: an open task at another version than the caller saw is stale', () => {
    const task = { ...ROTATE, updatedMs: 5 }
    const seen = { id: 7, createdMs: 0, version: 0 }

    expect(isAt(task, seen)).toBe(false)
    expect(isAt(task, { ...seen, version: 5 })).toBe(true)
    expect(refusalOf(task, seen, 'session-1')).toEqual({
      outcome: 'stale',
      message: 'Task #7 changed since that version.',
      task: { session_id: 'session-1', id: 7, created_ms: 0, version: 5, state: 'open' },
    })
    expect(refusalOf(task, { ...seen, version: 5 }, 'session-1')).toBeUndefined()
  })

  test('the session remembers a request by a short hash of it, never by its text', () => {
    const line = { type: 'answer', request_id: 'request-00000001', session_id: 'session-1', task_id: 1, created_ms: NOW, version: NOW, action: 'answer' }
    const long = requestOf({ ...line, text: `${'word '.repeat(20_000)}end` }) as Request
    const digest = digestOf(long)

    expect(digest.length).toBeLessThanOrEqual(32)
    expect(digest).not.toContain('word')
    expect(digestOf({ ...long })).toBe(digest)
    expect(digestOf({ ...long, text: `${'word '.repeat(20_000)}End` })).not.toBe(digest)
    expect(digestOf({ ...long, source: 'phone' })).not.toBe(digest)
  })

  test('6d: the listener ends with the session: its stream is ended, and nothing restarts it', ON, async ($, on) => {
    const { clock } = seat(on)
    const endpoint = listening(on)
    await start($)

    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.settle()
    await clock.advance(5 * 60_000)
    await clock.settle()

    expect(endpoint.children.map(child => child.isEnded)).toEqual([true])
  })

  test('a listener that ended is started again by the heartbeat, and answers', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(KEY_TASK)

    endpoint.exit()
    await clock.settle()
    expect(endpoint.children[0]?.isEnded).toBe(true)
    await clock.advance(60_000)
    await clock.settle()

    expect(endpoint.children.map(child => [sessionOf(child.argv), child.isEnded])).toEqual([
      ['session-1', true],
      ['session-1', false],
    ])
    const line = request()
    expect((await outcomeOf(endpoint, clock, line))?.['outcome']).toBe('accepted')
    await clock.advance(1000)
    await clock.settle()
    expect(world.submitted).toHaveLength(1)
  })

  test("after /clear the old session's listener stops and the new session's starts, and answers the tasks it took on", ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(KEY_TASK)
    const first = endpoint.children[0]

    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(1)
    await clock.settle()

    expect(endpoint.files.has(`${first?.results}/stop`)).toBe(true)
    expect(endpoint.children.map(child => [sessionOf(child.argv), child.isEnded])).toEqual([
      ['session-1', true],
      ['session-2', false],
    ])
    const stale = await outcomeOf(endpoint, clock, request())
    const taken = await outcomeOf(endpoint, clock, request({ session_id: 'session-2' }))
    await clock.advance(1000)
    await clock.settle()

    expect(stale?.['outcome']).toBe('gone')
    expect(taken?.['outcome']).toBe('accepted')
    expect(taken?.['task']).toEqual({ session_id: 'session-2', id: 1, created_ms: NOW, version: NOW + 1, state: 'done' })
    expect(world.submitted).toEqual(['My response to a task you gave me (Human in the loop):\n\n#1 Add STRIPE_SECRET_KEY to .env: Done.'])
  })

  test('after /clear, a request while the new session still joins (the store slow) is busy, and taken once it has joined', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(KEY_TASK)
    world.isStuck = true
    await clock.advance(60_000)
    world.sessionId = 'session-2'
    const cleared = $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(10_000)
    await cleared
    await clock.settle()

    expect(endpoint.children.map(child => [sessionOf(child.argv), child.isEnded])).toEqual([
      ['session-1', true],
      ['session-2', false],
    ])
    const line = request({ session_id: 'session-2' })
    expect((await outcomeOf(endpoint, clock, line))?.['outcome']).toBe('busy')

    world.unstick?.()
    await clock.settle()
    world.unstick?.()
    await clock.settle()

    expect((await outcomeOf(endpoint, clock, line))?.['outcome']).toBe('accepted')
  })

  test('a request handed on again gets its first outcome and is applied once; its request_id with another request is reused', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(XCODE_TASK)

    const line = request({ action: 'answer', text: 'from the phone' })
    expect((await outcomeOf(endpoint, clock, line))?.['outcome']).toBe('accepted')
    // The listener restarted and forgot it; the caller sends it again.
    endpoint.exit()
    await clock.advance(60_000)
    await clock.settle()
    const again = await outcomeOf(endpoint, clock, line)
    const other = await outcomeOf(endpoint, clock, { ...line, text: 'something else' })
    await clock.advance(1000)
    await clock.settle()

    expect(again?.['outcome']).toBe('accepted')
    expect(again?.['task']).toEqual({ session_id: 'session-1', id: 1, created_ms: NOW, version: NOW, state: 'done' })
    expect(other).toEqual({ request_id: line.request_id, outcome: 'reused', message: 'This request_id was used for another request.' })
    expect(world.submitted).toEqual([
      'My response to a task you gave me (Human in the loop):\n\n#1 Run xcodebuild test on your Mac, paste the failures:\nfrom the phone',
    ])
  })

  test('a request printed in pieces is read whole; a line that is not one is skipped, or refused when it names a request', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(KEY_TASK)
    await $.tool.call(XCODE_TASK)

    const whole = JSON.stringify({ type: 'answer', ...request() })
    endpoint.print(whole.slice(0, 20))
    await clock.settle()
    endpoint.print(`${whole.slice(20)}\nnot json\n`)
    const odd = request({ task_id: 2, extra: 'field' })
    endpoint.send(odd)
    await clock.settle()
    endpoint.print('x'.repeat(1_100_000))
    endpoint.print(`${'y'.repeat(10)}\n`)
    const after = request({ task_id: 2, action: 'answer', text: 'after the long line' })
    endpoint.send(after)
    await clock.settle()

    expect(endpoint.resultOf(String((JSON.parse(whole) as { request_id: string }).request_id))?.['outcome']).toBe('accepted')
    expect(endpoint.resultOf(odd.request_id)).toEqual({ request_id: odd.request_id, outcome: 'refused', message: 'The request did not reach the session whole.' })
    expect(endpoint.resultOf(after.request_id)?.['outcome']).toBe('accepted')
    expect([...endpoint.files.keys()].filter(path => path.endsWith('.json'))).toHaveLength(3)
    await clock.advance(1000)
    await clock.settle()
    expect(world.submitted).toHaveLength(1)
  })

  test('a listener that cannot start leaves the session as it was, and the heartbeat tries again', ON, async ($, on) => {
    const { world, clock } = seat(on)
    let tries = 0
    on('process.spawn', async function* () {
      tries += 1
      return { deny: 'python3: not found' }
    })
    await start($)
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })
    await clock.advance(60_000)
    await clock.settle()

    expect(tries).toBe(2)
    expect(world.submitted).toHaveLength(1)
  })

  test('a listener that cannot start is said once, with what it printed, and is tried again ever less often', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const TOO_LONG = 'hitl-endpoint: the socket path is too long (110 bytes, at most 103): use a shorter CLAUDE_CONFIG_DIR'
    let tries = 0
    on('process.spawn', async function* () {
      tries += 1
      yield { stream: 'stderr' as const, text: `${TOO_LONG}\n` }
      return { value: { code: 1, signal: null } }
    })
    await start($)
    await clock.advance(10 * 60_000)
    await clock.settle()

    expect(world.toasts).toEqual([`The answer endpoint could not start: ${TOO_LONG}`])
    // Tried at 0, 1, 3 and 7 minutes; then at 15, and at most once an hour.
    expect(tries).toBe(4)
  })

  test('a session whose id the listener would not take starts none', ON, async ($, on) => {
    const { world } = seat(on)
    world.sessionId = '../session-1'
    const endpoint = listening(on)
    await start($)

    expect(endpoint.children).toHaveLength(0)
  })

  const RAN = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

  test('each answer the session judges is one decision-log line: what came of it and from where, never what it said', ON, async ($, on) => {
    const { clock } = seat(on)
    const endpoint = listening(on, { hasWriter: true })
    const lines: { hook?: string; decision?: string; reason?: string; inputs?: Record<string, unknown> }[] = []
    on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? '/prof' : undefined }))
    on('process.run', (_, e) => {
      lines.push(JSON.parse(e.init?.stdin ?? '{}'))
      return { value: RAN }
    })
    await start($)
    await $.tool.call(XCODE_TASK)
    await $.tool.call(KEY_TASK)

    await outcomeOf(endpoint, clock, request({ action: 'answer', text: 'the words of the answer', source: 'phone' }))
    await outcomeOf(endpoint, clock, request({ task_id: 2, action: 'answer', text: KEY_SHAPED }))
    await outcomeOf(endpoint, clock, request({ task_id: 2, action: 'reject', reason: 'the words of the reason', version: NOW - 1 }))
    await clock.advance(1000)
    await clock.settle()

    const answers = lines.filter(line => line.decision === 'answer')
    expect(answers).toEqual([
      {
        hook: 'human-in-the-loop',
        decision: 'answer',
        reason: 'answer on task #1 from the phone: accepted',
        session: 'session-1',
        inputs: { id: 1, created_ms: NOW, action: 'answer', outcome: 'accepted', source: 'phone' },
      },
      {
        hook: 'human-in-the-loop',
        decision: 'answer',
        reason: 'answer on task #2 from the endpoint: refused',
        session: 'session-1',
        inputs: { id: 2, created_ms: NOW, action: 'answer', outcome: 'refused', source: 'endpoint' },
      },
      {
        hook: 'human-in-the-loop',
        decision: 'answer',
        reason: 'reject on task #2 from the endpoint: stale',
        session: 'session-1',
        inputs: { id: 2, created_ms: NOW, action: 'reject', outcome: 'stale', source: 'endpoint' },
      },
    ])
    const logged = JSON.stringify(lines)
    expect(logged).not.toContain('the words of')
    expect(logged).not.toContain(KEY_SHAPED)
  })

  test('with no decision-log writer in the profile, nothing is run, and tasks and answers go on as before', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const endpoint = listening(on)
    let runs = 0
    on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
    on('process.run', () => {
      runs += 1
      return { value: RAN }
    })
    await start($)
    const assigned = await $.tool.call(KEY_TASK)
    const refused = await $.tool.call({ ...KEY_TASK, title: 'Another', why: 'w'.repeat(301) })
    const answered = await outcomeOf(endpoint, clock, request())
    await clock.advance(1000)
    await clock.settle()

    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #1')
    expect((refused as { deny?: string }).deny).toContain('why is 301 characters')
    expect(answered?.['outcome']).toBe('accepted')
    expect(world.submitted).toHaveLength(1)
    expect(world.toasts).toEqual([])
    expect(runs).toBe(0)
    // With CLAUDE_CONFIG_DIR unset, the profile is ~/.claude.
    expect(endpoint.asked.filter(path => path.endsWith('decision_log.py'))).toEqual(Array(3).fill('/home/u/.claude/hooks/decision_log.py'))
  })

  test('with the setting off, as it is unless turned on, nothing listens and nothing is written', async ($, on) => {
    const { world } = seat(on)
    const endpoint = listening(on)
    await start($)
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'done' })
    await $.session.end({ reason: 'prompt_input_exit', sessionId: world.sessionId, resume: { id: world.sessionId } })

    expect(endpoint.children).toHaveLength(0)
    expect([...endpoint.files.keys()]).toEqual([])
  })
})

// The dashboard (#158): whether it is on and whether this session's
// answers can come from it, in the pane and the status line, and its start
// and stop. hooks/dashboard_control.py reads and changes it (tests/
// test_dashboard_control.py covers it against fake systemctl and tailscale);
// here `dashboardHelper` stands in for it at the `process.run` seam, and for
// the config file the fork looks for before running it.
describe('the dashboard', () => {
  const ON = { options: { answer_endpoint: true } } as const
  const CONFIG = '/home/u/.config/claude-tweaks/dashboard.toml'
  /** The phone view's config, which the dashboard's server reads while CONFIG is missing (#167). */
  const OLD_CONFIG = '/home/u/.config/claude-tweaks/phone.toml'
  const UNIT = '/home/u/.config/systemd/user/claude-tweaks-dashboard.service'
  const RAN = { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  const DASHBOARD_ON = { dashboard: 'on', why: '', set_up: true, address: 'http://box:6767', fix: '' }
  const NO_UNIT = {
    dashboard: 'off',
    why: 'unit not installed',
    set_up: false,
    address: 'http://box:6767',
    fix: 'Copy dashboard/claude-tweaks-dashboard.service to /home/u/.config/systemd/user/, then run systemctl --user daemon-reload (dashboard/README.md, Install, step 3).',
  }
  const STOPPED = { dashboard: 'off', why: 'server not running', set_up: true, address: 'http://box:6767', fix: '/overview start.' }

  /**
   * Stands in for hooks/dashboard_control.py beneath the plugin: each run of it
   * is recorded, and answered with what `answers` holds for its action
   * (`status`, `start` or `stop`) as its one JSON line (a string as it is),
   * or rejected as a
   * command that cannot start when `isFailing`; the next run for the action
   * `holding` waits for `letGo`. The config file is there
   * while `hasConfig`, the phone view's while `hasOldConfig`, the unit while `hasUnit`; listeners of the answer endpoint, spawned,
   * print their ready line, unless `isListenerFailing` (they end, saying
   * why) or `isListenerSilent` (they never say anything).
   */
  function dashboardHelper(on: On, { hasConfig = true, hasOldConfig = false, hasUnit = false } = {}) {
    const runs: { argv: readonly string[]; timeoutMs?: number }[] = []
    const answers: Record<string, unknown> = { status: DASHBOARD_ON }
    const helper = {
      runs,
      answers,
      /** Fields of the process result to set for an action, over the one printing its answer. */
      results: {} as Record<string, Partial<typeof RAN> & { stdout?: string }>,
      listenerSays: 'answer endpoint: the profile cannot be written',
      /** Each value the fork's writes left in its `dashboard` state (a write that missed its version is not one), the progress pane's line. */
      published: [] as unknown[],
      hasConfig,
      hasOldConfig,
      hasUnit,
      isFailing: false,
      isListenerFailing: false,
      isListenerSilent: false,
      holding: undefined as string | undefined,
      letGo: () => {},
    }
    on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
    on('fs.exists', (_, e) => ({
      value: (helper.hasConfig && e.path === CONFIG) || (helper.hasOldConfig && e.path === OLD_CONFIG) || (helper.hasUnit && e.path === UNIT),
    }))
    on('state.set', { plugin: 'human-in-the-loop' }, async ($, e, next) => {
      const set = await next(e)

      if (e.key === 'dashboard' && (set as { value?: { isSet?: boolean } }).value?.isSet !== false) {
        helper.published.push(e.value)
      }

      return set
    })
    on('process.run', async (_, e) => {
      runs.push({ argv: e.argv, ...(e.init?.timeoutMs === undefined ? {} : { timeoutMs: e.init.timeoutMs }) })
      // What it answers is fixed as it starts: a held run answers what it read then.
      const answer = answers[e.argv.at(-1) ?? '']
      const result = helper.results[e.argv.at(-1) ?? ''] ?? {}

      if (e.argv.at(-1) === helper.holding) {
        helper.holding = undefined
        await new Promise<void>(resolve => {
          helper.letGo = resolve
        })
      }

      if (helper.isFailing) {
        throw new Error('spawn python3 ENOENT')
      }

      // A string is printed as it is: what a helper that prints no JSON line would print.
      return { value: { ...RAN, stdout: typeof answer === 'string' ? answer : `${JSON.stringify(answer)}\n`, ...result } }
    })
    on('process.spawn', async function* ($, e) {
      if (helper.isListenerFailing) {
        yield { stream: 'stderr' as const, text: `${helper.listenerSays}\n` }
        return { value: { code: 1, signal: null } }
      }

      if (helper.isListenerSilent) {
        await new Promise(() => {})
      }

      yield { stream: 'stdout' as const, text: `${JSON.stringify({ type: 'ready', results: `/prof/hitl-endpoint/${e.argv.at(-1)?.slice('--session='.length) ?? ''}.4242.results` })}\n` }
      await new Promise(() => {})
      return { value: { code: 0, signal: null } }
    })

    return helper
  }

  const dashboardLine = async (ui: { find: (query: { type: string; text: RegExp }) => Promise<{ text: string } | undefined> }) =>
    (await ui.find({ type: 'Text', text: /^dashboard: / }))?.text

  type Published = { line: string; at: number; seq: number } | null

  /** The lines the fork left in its `dashboard` state, with when each was read (null: no line). */
  const lines = (helper: { published: unknown[] }) =>
    (helper.published as Published[]).map(value => (value === null ? null : { line: value.line, at: value.at }))

  /** Whether each stamped value the fork left carries a number above the one before. */
  const isRising = (helper: { published: unknown[] }) => {
    const seqs = (helper.published as Published[]).flatMap(value => (value === null ? [] : [value.seq]))

    return seqs.every((seq, i) => i === 0 || seq > (seqs[i - 1] ?? Infinity))
  }

  test('without its config the pane and the status line say nothing of the dashboard, and nothing is run', async ($, on) => {
    const { world, clock } = seat(on)
    const helper = dashboardHelper(on, { hasConfig: false })
    await start($)
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await clock.settle()

    expect(await dashboardLine(ui)).toBeUndefined()
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(helper.runs).toEqual([])
  })

  test('with its config and its unit in place, the status line is current from the session start, before any pane is opened', async ($, on) => {
    const { world, clock } = seat(on)
    const helper = dashboardHelper(on, { hasUnit: true })
    await start($)
    await clock.settle()

    expect(helper.runs).toHaveLength(1)
    expect(world.status).toBe('dashboard: on · replies: off (Answer endpoint setting off)')
  })

  for (const [name, flags] of [
    ['no unit', { hasConfig: true, hasUnit: false }],
    ['no config', { hasConfig: false, hasUnit: true }],
  ] as const) {
    test(`with ${name}, nothing is read at the session start`, async ($, on) => {
      const { clock } = seat(on)
      const helper = dashboardHelper(on, flags)
      await start($)
      await clock.settle()

      expect(helper.runs).toEqual([])
    })
  }

  test('set up and on, the pane and the status line say so, with whether this session takes replies', async ($, on) => {
    const { world, clock } = seat(on)
    const helper = dashboardHelper(on)
    await start($)
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await clock.settle()

    expect(await dashboardLine(ui)).toBe('dashboard: on · replies: off (Answer endpoint setting off)')
    expect(world.status).toBe('☐ 1 task for you · /my-tasks · dashboard: on · replies: off (Answer endpoint setting off)')
    expect(helper.runs).toHaveLength(1)
    const [run] = helper.runs
    expect(run?.argv.slice(0, 2)).toEqual(['python3', '-I'])
    expect(run?.argv[2]?.endsWith('/hooks/dashboard_control.py')).toBe(true)
    expect(run?.argv.slice(3)).toEqual(['status'])
    expect(run?.timeoutMs).toBe(20_000)
    // The progress pane reads the same line from the fork's state, with when it was read.
    expect(lines(helper)).toEqual([{ line: 'dashboard: on · replies: off (Answer endpoint setting off)', at: NOW }])
  })

  test('not set up, the pane says what is missing and the status line stays quiet', async ($, on) => {
    const { world, clock } = seat(on)
    const helper = dashboardHelper(on)
    helper.answers['status'] = NO_UNIT
    await start($)
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await clock.settle()

    expect(await dashboardLine(ui)).toBe('dashboard: off (unit not installed)')
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })

  /** Each reading the helper can give, the line the pane draws for it, and whether the status line carries it (only once set up). */
  const LINES = [
    { reading: STOPPED, line: 'dashboard: off (server not running) · replies: off (Answer endpoint setting off)', isPinned: true },
    { reading: { ...STOPPED, why: 'server failed' }, line: 'dashboard: off (server failed) · replies: off (Answer endpoint setting off)', isPinned: true },
    { reading: { ...STOPPED, why: 'not served on 6767' }, line: 'dashboard: off (not served on 6767) · replies: off (Answer endpoint setting off)', isPinned: true },
    { reading: { ...STOPPED, why: '6767 serves something else' }, line: 'dashboard: off (6767 serves something else) · replies: off (Answer endpoint setting off)', isPinned: true },
    { reading: { ...STOPPED, why: 'tailscale not found' }, line: 'dashboard: off (tailscale not found) · replies: off (Answer endpoint setting off)', isPinned: true },
    { reading: { ...STOPPED, dashboard: 'unknown', why: 'tailscale did not answer' }, line: 'dashboard: unknown (tailscale did not answer) · replies: off (Answer endpoint setting off)', isPinned: true },
    { reading: { ...NO_UNIT, dashboard: 'unknown', why: 'systemctl did not answer', fix: '' }, line: 'dashboard: unknown (systemctl did not answer)', isPinned: false },
    { reading: { ...NO_UNIT, why: 'unit masked' }, line: 'dashboard: off (unit masked)', isPinned: false },
    { reading: 'not json', line: 'dashboard: unknown (the check answered nothing it reads)', isPinned: false },
    { reading: '"just a string"\n', line: 'dashboard: unknown (the check answered nothing it reads)', isPinned: false },
    { reading: { dashboard: 'maybe', why: '', set_up: true }, line: 'dashboard: unknown (the check answered nothing it reads)', isPinned: false },
  ] as const

  for (const { reading, line, isPinned } of LINES) {
    test(`read as ${JSON.stringify(reading)}, the pane says ${line}${isPinned ? ', and so does the status line' : ''}`, async ($, on) => {
      const { world, clock } = seat(on)
      const helper = dashboardHelper(on)
      helper.answers['status'] = reading
      await start($)
      await $.tool.call(KEY_TASK)
      const ui = await $.ui.mount(PANE)
      await clock.settle()

      expect(await dashboardLine(ui)).toBe(line)
      expect(world.status).toBe(isPinned ? `☐ 1 task for you · /my-tasks · ${line}` : '☐ 1 task for you · /my-tasks')
    })
  }

  test('a helper that cannot run reads as unknown, and the status line stays quiet', async ($, on) => {
    const { world, clock } = seat(on)
    const helper = dashboardHelper(on)
    helper.isFailing = true
    await start($)
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await clock.settle()

    expect(await dashboardLine(ui)).toBe('dashboard: unknown (the check could not run)')
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
  })

  test('with the answer endpoint on, replies are on once its listener is ready', ON, async ($, on) => {
    const { world, clock } = seat(on)
    dashboardHelper(on)
    await start($)
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await clock.settle()

    expect(await dashboardLine(ui)).toBe('dashboard: on · replies: on')
    expect(world.status).toBe('☐ 1 task for you · /my-tasks · dashboard: on · replies: on')
  })

  test('with a listener not ready yet, replies are starting', ON, async ($, on) => {
    const { clock } = seat(on)
    const helper = dashboardHelper(on)
    helper.isListenerSilent = true
    await start($)
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await clock.settle()

    expect(await dashboardLine(ui)).toBe('dashboard: on · replies: starting')
  })

  test('with a listener that ended before it was ready, replies are off with what it said', ON, async ($, on) => {
    const { world, clock } = seat(on)
    const helper = dashboardHelper(on)
    helper.isListenerFailing = true
    await start($)
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await clock.settle()

    expect(await dashboardLine(ui)).toBe('dashboard: on · replies: off (endpoint failed: answer endpoint: the profile cannot be written)')
    expect(world.status).toContain('replies: off (endpoint failed: ')
  })

  test('a reading stands for 10 seconds: the pane drawn again meanwhile reads nothing, and after it reads again', async ($, on) => {
    const { clock } = seat(on)
    const helper = dashboardHelper(on)
    await start($)
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await clock.settle()
    await ui.redraw(PANE.props)
    await clock.settle()
    expect(helper.runs).toHaveLength(1)

    helper.answers['status'] = STOPPED
    await clock.advance(10_000)
    await ui.redraw(PANE.props)
    await clock.settle()

    expect(helper.runs).toHaveLength(2)
    expect(await dashboardLine(ui)).toBe('dashboard: off (server not running) · replies: off (Answer endpoint setting off)')
  })

  test('without the unit installed, nothing is read on the heartbeat while the pane is not drawn', async ($, on) => {
    const { clock } = seat(on)
    const helper = dashboardHelper(on)
    await start($)
    await $.tool.call(KEY_TASK)
    await clock.advance(120_000)
    await clock.settle()

    expect(helper.runs).toEqual([])
  })

  test('the pane drawn inline asks for the rows the dashboard line takes', async ($, on) => {
    const { world, clock } = seat(on)
    dashboardHelper(on)
    await start($)
    await $.tool.call(KEY_TASK)
    await runTasks($)
    await $.ui.mount({ ...PANE, props: { ...PANE.props, placement: 'inline', bodyColumns: 60 } })
    const before = world.opens.at(-1)?.rows ?? 0
    await clock.settle()

    // At 60 columns, beside its button, the line takes two rows.
    expect(world.opens.at(-1)?.rows).toBe(before + 2)
  })

  const STARTED = { outcome: 'done', message: 'Started the dashboard.', ...DASHBOARD_ON }
  const STOPPED_NOW = { outcome: 'done', message: 'Took 6767 off the tailnet. Stopped claude-tweaks-dashboard.service.', ...STOPPED }

  /**
   * A plugin named `name` whose `/dashboard-by-<name> <action>` calls the
   * dashboard tool and answers with what came back, as JSON. Named
   * `progress`, it stands for the Progress mod, whose /overview makes that call.
   */
  const callerNamed = (name: string): Plugin => ({
    name,
    register(on) {
      on('command.run', async ($, e, next) =>
        e.command === `dashboard-by-${$.plugin.name}`
          ? { text: JSON.stringify(await $.tool.call({ tool: 'mcp__human-in-the-loop__dashboard', action: e.args })) }
          : next(e),
      )
    },
  })
  /** Loads the Progress mod's stand-in, through which `dashboardCommand` calls. */
  const BY_PROGRESS: TestOptions = { plugins: [callerNamed('progress')] }

  /** What the dashboard tool answered `plugin`'s call: its words as `text` (a refusal's reason too), and its `address`. */
  const dashboardBy = async ($: Engine, plugin: string, action: string) => {
    const ran = await $.command.run({ command: `dashboard-by-${plugin}`, args: action, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    const done = JSON.parse(('text' in ran ? ran.text : undefined) ?? '{}') as { deny?: string; result?: { text?: string; address?: string } }

    return { text: done.deny ?? done.result?.text, address: done.result?.address }
  }

  /** The dashboard tool as Progress's /overview web|start|stop calls it (needs BY_PROGRESS), its words as `text`; a refusal's reason as `text` too. */
  const dashboardCommand = ($: Engine, args: string) => dashboardBy($, 'progress', args.trim().toLowerCase() || 'status')

  test('the pane starts the dashboard while it is off, and stops it once it is on', async ($, on) => {
    const { world, clock } = seat(on)
    const helper = dashboardHelper(on)
    helper.answers['status'] = STOPPED
    helper.answers['start'] = STARTED
    helper.answers['stop'] = STOPPED_NOW
    await start($)
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await clock.settle()
    expect((await ui.find({ key: 'dashboard' }))?.text).toBe('Start dashboard')

    await ui.press({ key: 'dashboard' })

    expect(helper.runs.at(-1)?.argv.slice(3)).toEqual(['start'])
    expect(helper.runs.at(-1)?.timeoutMs).toBe(60_000)
    expect(world.toasts.at(-1)).toBe('Started the dashboard. dashboard: on · replies: off (Answer endpoint setting off)')
    expect(await dashboardLine(ui)).toBe('dashboard: on · replies: off (Answer endpoint setting off)')
    expect((await ui.find({ key: 'dashboard' }))?.text).toBe('Stop dashboard')

    await ui.press({ key: 'dashboard' })

    expect(helper.runs.at(-1)?.argv.slice(3)).toEqual(['stop'])
    expect(await dashboardLine(ui)).toBe('dashboard: off (server not running) · replies: off (Answer endpoint setting off)')
  })

  test('a start the helper refuses says the missing step, and starts nothing', async ($, on) => {
    const { world, clock } = seat(on)
    const helper = dashboardHelper(on)
    helper.answers['status'] = NO_UNIT
    helper.answers['start'] = { outcome: 'refused', message: NO_UNIT.fix, ...NO_UNIT }
    await start($)
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await clock.settle()

    await ui.press({ key: 'dashboard' })

    expect(world.toasts.at(-1)).toBe(`${NO_UNIT.fix} dashboard: off (unit not installed)`)
    expect(helper.runs.map(run => run.argv.at(-1))).toEqual(['status', 'start'])
  })

  test('a second press while a start is under way runs nothing more', BY_PROGRESS, async ($, on) => {
    const { world, clock } = seat(on)
    const helper = dashboardHelper(on)
    helper.answers['status'] = STOPPED
    helper.answers['start'] = STARTED
    helper.holding = 'start'
    await start($)
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await clock.settle()

    const first = ui.press({ key: 'dashboard' })
    await clock.settle()
    expect((await ui.find({ key: 'dashboard' }))?.text).toBe('Starting dashboard…')
    const second = await dashboardCommand($, 'start')
    helper.letGo()
    await first

    expect(second.text).toBe('The dashboard is already starting or stopping.')
    expect(helper.runs.filter(run => run.argv.at(-1) === 'start')).toHaveLength(1)
    expect(world.toasts.at(-1)).toBe('Started the dashboard. dashboard: on · replies: off (Answer endpoint setting off)')
  })

  test('there is no /dash command: the dashboard is the Progress mod\'s /overview web, start and stop', async ($, on) => {
    const { world, clock } = seat(on)
    dashboardHelper(on)
    await start($)
    await clock.settle()

    expect(world.commands).toEqual(['my-tasks'])
  })

  // The tool runs the dashboard on the tailnet: the model (and so a prompt
  // injection) is never shown it and its calls are refused (`tool.offer`, the
  // engine's ask for the list and for each call a model makes). A plugin's
  // `$.tool.call`, how /overview reaches it, is not asked and still runs it:
  // here an inline plugin named `progress` makes that call.
  test("the dashboard tool is kept from the model, the main agent's and every subagent's, and /overview's call still runs it", BY_PROGRESS, async ($, on) => {
    const { clock } = seat(on)
    const helper = dashboardHelper(on)
    helper.answers['start'] = STARTED
    helper.answers['stop'] = STOPPED_NOW
    on('tool.offer', () => ({ isOffered: true }))
    await start($)
    await clock.settle()
    const provider = { plugin: 'human-in-the-loop', tier: 'user' } as const

    for (const asked of ['list', 'call'] as const) {
      expect(await $.tool.offer({ tool: 'mcp__human-in-the-loop__dashboard', provider, for: asked })).toEqual({ isOffered: false })
      expect(await $.tool.offer({ tool: 'mcp__human-in-the-loop__dashboard', provider, for: asked, agentId: 'a1', subagentType: 'Explore' })).toEqual({ isOffered: false })
    }

    expect(await $.tool.offer({ tool: ASSIGN, provider, for: 'list' })).toEqual({ isOffered: true })
    expect((await dashboardCommand($, 'status')).address).toBe('http://box:6767')
    expect((await dashboardCommand($, 'start')).text).toContain('Started the dashboard.')
    expect((await dashboardCommand($, 'stop')).text).toContain('Stopped claude-tweaks-dashboard.service.')
    expect(helper.runs.map(run => run.argv.at(-1))).toEqual(['status', 'start', 'stop'])
  })

  // Defence in depth for what `tool.offer` may not be asked about: a Code Mode
  // script's call. The test's `$` calls as the engine does, the model's and a
  // `REPL` script's calls; `another` is any plugin but Progress.
  test('only the Progress mod runs the dashboard tool: a call from the model, a script or another plugin is refused, and runs nothing', { plugins: [callerNamed('progress'), callerNamed('another')] }, async ($, on) => {
    const { clock } = seat(on)
    const helper = dashboardHelper(on)
    helper.answers['start'] = STARTED
    helper.answers['stop'] = STOPPED_NOW
    await start($)
    await clock.settle()

    for (const action of ['status', 'start', 'stop']) {
      const engine = await $.tool.call({ tool: 'mcp__human-in-the-loop__dashboard', action })

      expect(engine).toEqual({ deny: "Only the Progress mod's /overview controls the dashboard." })
      expect(await dashboardBy($, 'another', action)).toEqual({ text: "Only the Progress mod's /overview controls the dashboard.", address: undefined })
    }

    expect(helper.runs).toEqual([])
    expect((await dashboardBy($, 'progress', 'status')).address).toBe('http://box:6767')
    expect((await dashboardBy($, 'progress', 'start')).text).toContain('Started the dashboard.')
    expect((await dashboardBy($, 'progress', 'stop')).text).toContain('Stopped claude-tweaks-dashboard.service.')
    expect(helper.runs.map(run => run.argv.at(-1))).toEqual(['status', 'start', 'stop'])
  })

  test('without its config the dashboard tool says it is not set up, and nothing is run', BY_PROGRESS, async ($, on) => {
    const { clock } = seat(on)
    const helper = dashboardHelper(on, { hasConfig: false, hasUnit: true })
    await start($)
    await clock.settle()

    for (const action of ['status', 'start', 'stop']) {
      const said = await dashboardCommand($, action)

      expect(said.text).toBe('The dashboard is not set up: its config file is missing (dashboard/README.md, Install, step 1). Nothing was run.')
      expect(said.address).toBeUndefined()
    }

    expect(helper.runs).toEqual([])
  })

  test("with only the phone view's config (before the #167 rename), the status line is current from the session start and the tool works", BY_PROGRESS, async ($, on) => {
    const { world, clock } = seat(on)
    const helper = dashboardHelper(on, { hasConfig: false, hasOldConfig: true, hasUnit: true })
    await start($)
    await clock.settle()

    expect((await dashboardCommand($, 'status')).address).toBe('http://box:6767')
    expect(helper.runs).toHaveLength(2)
    expect(world.status).toBe('dashboard: on · replies: off (Answer endpoint setting off)')
  })

  test('the dashboard tool says how the dashboard stands and the next step once its config is there, before its unit is', BY_PROGRESS, async ($, on) => {
    seat(on)
    const helper = dashboardHelper(on)
    helper.answers['status'] = NO_UNIT
    await start($)

    const said = await dashboardCommand($, '')

    expect(said.address).toBeUndefined()
    expect(said.text).toBe(`dashboard: off (unit not installed)\n${NO_UNIT.fix}`)
    expect(helper.runs.map(run => [run.argv.at(-1), run.timeoutMs])).toEqual([['status', 20_000]])
  })

  test('the dashboard tool, on, gives its address and says where to open it and how to turn replies on', BY_PROGRESS, async ($, on) => {
    seat(on)
    dashboardHelper(on)
    await start($)

    const said = await dashboardCommand($, 'status')

    expect(said.text).toBe(
      "dashboard: on · replies: off (Answer endpoint setting off)\nOpen http://box:6767 in a browser.\nReplies need the human-in-the-loop plugin's Answer endpoint setting on, then a new session or /clear.",
    )
  })

  test('the dashboard tool starts and stops it: it runs the helper and say what came of it', BY_PROGRESS, async ($, on) => {
    seat(on)
    const helper = dashboardHelper(on)
    helper.answers['start'] = STARTED
    helper.answers['stop'] = STOPPED_NOW
    await start($)

    const started = await dashboardCommand($, 'start')
    const stopped = await dashboardCommand($, ' Stop ')

    expect(started.text).toBe('Started the dashboard.\ndashboard: on · replies: off (Answer endpoint setting off)\nOpen http://box:6767 in a browser.\nReplies need the human-in-the-loop plugin\'s Answer endpoint setting on, then a new session or /clear.')
    expect(stopped.text).toBe('Took 6767 off the tailnet. Stopped claude-tweaks-dashboard.service.\ndashboard: off (server not running) · replies: off (Answer endpoint setting off)\n/overview start.')
    expect(helper.runs.map(run => [run.argv.at(-1), run.timeoutMs])).toEqual([
      ['start', 60_000],
      ['stop', 60_000],
    ])
  })

  test('the dashboard tool refuses any other action, and runs nothing', BY_PROGRESS, async ($, on) => {
    seat(on)
    const helper = dashboardHelper(on)
    await start($)

    expect((await dashboardCommand($, 'funnel')).text).toBe('The dashboard action is status, start or stop.')
    expect(helper.runs).toEqual([])
  })

  test('a helper that cannot run makes a start fail, saying so', BY_PROGRESS, async ($, on) => {
    seat(on)
    const helper = dashboardHelper(on)
    helper.isFailing = true
    await start($)

    expect((await dashboardCommand($, 'start')).text).toBe('Could not start the dashboard: the check could not run.\ndashboard: unknown (the check could not run)')
  })

  const MENU = { plugin: 'human-in-the-loop', surface: 'desktop', component: 'ContextMenu', props: { row: { component: 'AssistantMessage', requestId: 'm1' } } } as const

  test("the desktop's menu offers the dashboard's address to copy, and Start while it is off", async ($, on) => {
    const { world, clock } = seat(on)
    const helper = dashboardHelper(on)
    helper.answers['status'] = STOPPED
    helper.answers['start'] = STARTED
    const copied: string[] = []
    on('ui.copy', (_, e) => {
      copied.push(e.text)
      return { value: { isCopied: true } }
    })
    await start($)
    const menu = await $.ui.mount(MENU)
    await clock.settle()

    expect((await menu.find({ key: 'dashboard-copy' }))?.text).toContain('Copy dashboard address')
    await menu.press({ key: 'dashboard-copy' })
    expect(copied).toEqual(['http://box:6767'])

    await menu.press({ key: 'dashboard-start' })
    expect(helper.runs.at(-1)?.argv.slice(3)).toEqual(['start'])
    expect(world.toasts.at(-1)).toBe('Started the dashboard. dashboard: on · replies: off (Answer endpoint setting off)')
    expect(await menu.find({ key: 'dashboard-start' })).toBeUndefined()
    expect(await menu.find({ key: 'dashboard-copy' })).toBeDefined()
  })

  test("without its config the desktop's menu has no dashboard rows, and nothing is run", async ($, on) => {
    const { clock } = seat(on)
    const helper = dashboardHelper(on, { hasConfig: false })
    await start($)
    const menu = await $.ui.mount(MENU)
    await clock.settle()

    expect(await menu.find({ type: 'Button' })).toBeUndefined()
    expect(helper.runs).toEqual([])
  })

  // Fix round 1 (#158 / PR #163).
  const NOW_ON = 'dashboard: on · replies: off (Answer endpoint setting off)'
  const NOW_OFF = 'dashboard: off (server not running) · replies: off (Answer endpoint setting off)'

  test('installed, the dashboard is read again on the minute heartbeat; each reading is published with its time and a rising number, changed or not', async ($, on) => {
    const { world, clock } = seat(on)
    const helper = dashboardHelper(on, { hasUnit: true })
    await start($)
    await clock.settle()
    expect(world.status).toBe(NOW_ON)

    await clock.advance(60_000)
    await clock.settle()
    helper.answers['status'] = STOPPED
    await clock.advance(60_000)
    await clock.settle()

    expect(helper.runs.map(run => run.argv.at(-1))).toEqual(['status', 'status', 'status'])
    expect(world.status).toBe(NOW_OFF)

    helper.answers['status'] = NO_UNIT
    await clock.advance(60_000)
    await clock.settle()

    expect(lines(helper)).toEqual([
      { line: NOW_ON, at: NOW },
      { line: NOW_ON, at: NOW + 60_000 },
      { line: NOW_OFF, at: NOW + 120_000 },
      null,
    ])
    expect(isRising(helper)).toBe(true)
  })

  // Fix round 2 (#158 / PR #163): the published line carries when it was
  // read and a number; the progress pane shows it only while it is under
  // 150 s old (owner decision, AskUserQuestion 2026-11-19, "Freshness stamp").

  for (const newer of ['status', 'start', 'stop', 'endpoint'] as const) {
    test(`an older publication whose write lands last leaves the newer line (${newer}) in the state`, newer === 'endpoint' ? { ...ON, ...BY_PROGRESS } : BY_PROGRESS, async ($, on) => {
      const { world, clock } = seat(on)
      const helper = dashboardHelper(on, { hasUnit: true })
      helper.answers['status'] = newer === 'start' ? STOPPED : DASHBOARD_ON
      helper.answers['start'] = STARTED
      helper.answers['stop'] = STOPPED_NOW
      // The first publication reads the state 5 s late, with the value as it stood when asked.
      world.slowRead = 'dashboard'
      world.readMs = 5_000
      await start($)
      await clock.settle()

      if (newer !== 'endpoint') {
        helper.answers['status'] = STOPPED
        await dashboardCommand($, newer)
      }

      await clock.advance(5_000)
      await clock.settle()

      expect(world.status).toBe(newer === 'stop' || newer === 'status' ? NOW_OFF : newer === 'start' ? NOW_ON : 'dashboard: on · replies: on')
      expect(lines(helper).at(-1)?.line).toBe(world.status)
    })
  }

  // Fix round 3 (#158 / PR #163): the order holds across copies of the code.
  // A hot reload starts the new copy's numbers again while the host keeps the
  // state, so a write gives way to a stored line stamped later than its own,
  // unless that stamp is more than 5 s ahead of this clock (agent decision:
  // a clock stepped back must not stop publishing).
  /**
   * The fork's `dashboard` state as the host holds it, written only at the version
   * last read; set `isHolding` and this copy's next read of it answers the
   * value as it stood when asked, once `release` is called.
   */
  function dashboardCell(on: On, value: Published) {
    const cell = { value, version: 1, isHolding: false, release: () => {} }
    on('state.get', { plugin: 'human-in-the-loop', key: 'dashboard' }, async () => {
      const held = { value: cell.value, version: cell.version }

      if (cell.isHolding) {
        cell.isHolding = false
        await new Promise<void>(resolve => {
          cell.release = resolve
        })
      }

      return { value: held }
    })
    on('state.set', { plugin: 'human-in-the-loop', key: 'dashboard' }, (_, e) => {
      const { ifVersion } = e as { ifVersion?: number }

      if (ifVersion !== undefined && ifVersion !== cell.version) {
        return { value: { isSet: false, version: cell.version } }
      }

      cell.value = e.value as Published
      cell.version += 1
      return { value: { isSet: true, version: cell.version } }
    })

    return cell
  }

  /** A stored line, with when it was read. */
  const lineOf = (value: Published) => (value === null ? null : { line: value.line, at: value.at })

  test('a write that lands after a reloaded copy published a later line leaves the later line, and the next reading publishes again', async ($, on) => {
    const { clock } = seat(on)
    dashboardHelper(on, { hasUnit: true })
    const cell = dashboardCell(on, null)
    // This copy's publication of on, read at NOW, reads the state late.
    cell.isHolding = true
    await start($)
    await clock.settle()

    // Meanwhile a reloaded copy, its numbers started again, reads off and publishes it.
    await clock.advance(1_000)
    const later = { line: NOW_OFF, at: NOW + 1_000, seq: 1 }
    cell.value = later
    cell.version += 1
    cell.release()
    await clock.settle()

    expect(cell.value).toEqual(later)

    // Not stopped for good: this copy's next reading, stamped later, is published.
    await clock.advance(59_000)
    await clock.settle()

    expect(lineOf(cell.value)).toEqual({ line: NOW_ON, at: NOW + 60_000 })
  })

  test('a write held for 6 s before it reads the state still gives way to a line another copy stamped 6 s later (a stall is not a clock step)', async ($, on) => {
    const { clock } = seat(on)
    dashboardHelper(on, { hasUnit: true })
    const cell = dashboardCell(on, null)
    cell.isHolding = true
    await start($)
    await clock.settle()

    await clock.advance(6_000)
    const later = { line: NOW_OFF, at: NOW + 6_000, seq: 1 }
    cell.value = later
    cell.version += 1
    cell.release()
    await clock.settle()

    expect(cell.value).toEqual(later)
  })

  test('a stored line stamped 1 s ahead stays when this copy publishes no line (null counts as stamped now)', async ($, on) => {
    const { clock } = seat(on)
    dashboardHelper(on)
    const ahead = { line: NOW_OFF, at: NOW + 1_000, seq: 9 }
    const cell = dashboardCell(on, ahead)
    await start($)
    await clock.settle()

    expect(cell.value).toEqual(ahead)
  })

  for (const [aheadMs, isPublished] of [
    [5_000, false],
    [5_001, true],
    [3_600_000, true],
  ] as const) {
    test(`a stored line stamped ${aheadMs} ms ahead of this clock ${isPublished ? 'does not stop this copy publishing (the clock stepped back)' : 'is kept over an earlier line'}`, async ($, on) => {
      const { clock } = seat(on)
      dashboardHelper(on, { hasUnit: true })
      const ahead = { line: NOW_OFF, at: NOW + aheadMs, seq: 9 }
      const cell = dashboardCell(on, ahead)
      await start($)
      await clock.settle()

      expect(lineOf(cell.value)).toEqual(isPublished ? { line: NOW_ON, at: NOW } : lineOf(ahead))
    })
  }

  for (const reason of ['clear', 'resume'] as const) {
    for (const status of [DASHBOARD_ON, STOPPED]) {
      test(`after ${reason}, an unchanged ${status.dashboard} reading is published again`, async ($, on) => {
        const { world, clock } = seat(on)
        const helper = dashboardHelper(on, { hasUnit: true })
        helper.answers['status'] = status
        await start($)
        await clock.settle()
        const before = helper.published.length

        world.sessionId = 'session-2'
        await $.session.end({ reason, sessionId: 'session-1', resume: { id: 'session-1' } })
        await clock.advance(1)
        await clock.settle()

        // At once, the reading kept, with when it was read; then each minute anew.
        expect(helper.published.length).toBe(before + 1)
        expect(lines(helper).at(-1)).toEqual({ line: status === DASHBOARD_ON ? NOW_ON : NOW_OFF, at: NOW })

        await clock.advance(60_000)
        await clock.settle()
        const last = lines(helper).at(-1)
        expect(last?.line).toBe(status === DASHBOARD_ON ? NOW_ON : NOW_OFF)
        expect((last?.at ?? 0) >= NOW + 60_000).toBe(true)
      })
    }
  }

  for (const [name, gone] of [
    ['its config is removed', (helper: ReturnType<typeof dashboardHelper>) => (helper.hasConfig = false)],
    ['its unit is removed', (helper: ReturnType<typeof dashboardHelper>) => ((helper.hasUnit = false), (helper.answers['status'] = NO_UNIT))],
    ['the session ends', undefined],
  ] as const) {
    test(`once ${name}, nothing the fork published claims the dashboard as on past 150 s`, async ($, on) => {
      const { world, clock } = seat(on)
      const helper = dashboardHelper(on, { hasUnit: true })
      await start($)
      await clock.settle()
      expect(lines(helper).at(-1)).toEqual({ line: NOW_ON, at: NOW })

      if (gone === undefined) {
        await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-1', resume: { id: 'session-1' } })
      } else {
        gone(helper)
      }

      await clock.advance(150_000)
      await clock.settle()
      const last = lines(helper).at(-1)

      expect(last === null || (last !== undefined && clock.now() - last.at >= 150_000)).toBe(true)

      if (gone !== undefined) {
        expect(world.status ?? '').not.toContain('dashboard:')
      }
    })
  }

  const LOGIN = 'owner@example.test'
  const TOKEN = 'tskey-auth-kSYNTHETIC0CNTRL-0123456789abcdef'
  const PIN = '975310'
  const LEAK = `${LOGIN}:${TOKEN}:${PIN}`
  const LEAKS = [
    ['exits 1 saying them', { exitCode: 1, stderr: LEAK, stdout: LEAK }],
    ['prints them in no JSON', { stderr: LEAK, stdout: `${LEAK}\n` }],
    ['prints them in a line cut short', { isStdoutTruncated: true, stdout: JSON.stringify({ outcome: 'done', message: LEAK, ...DASHBOARD_ON, why: LEAK }) }],
  ] as const

  for (const [name, result] of LEAKS) {
    test(`a helper that ${name}: no login, token or PIN reaches the pane, the status line, a toast or the dashboard tool`, BY_PROGRESS, async ($, on) => {
      const { world, clock } = seat(on)
      const helper = dashboardHelper(on)
      helper.results['status'] = result
      helper.results['start'] = result
      await start($)
      await $.tool.call(KEY_TASK)
      const ui = await $.ui.mount(PANE)
      await clock.settle()
      await ui.press({ key: 'dashboard' })
      const said = [(await dashboardCommand($, 'start')).text, (await dashboardCommand($, 'status')).text]
      const shown = [await dashboardLine(ui), world.status, ...world.toasts, ...said].join('\n')

      for (const secret of [LOGIN, TOKEN, PIN]) {
        expect(shown).not.toContain(secret)
      }

      expect(await dashboardLine(ui)).toMatch(/^dashboard: unknown \(/)
    })
  }

  test('a helper output cut short is no reading: a read is unknown and a start failed', BY_PROGRESS, async ($, on) => {
    seat(on)
    const helper = dashboardHelper(on)
    helper.answers['start'] = STARTED
    helper.results['status'] = { isStdoutTruncated: true }
    helper.results['start'] = { isStdoutTruncated: true }
    await start($)

    expect((await dashboardCommand($, 'status')).text).toBe('dashboard: unknown (the check printed too much)')
    expect((await dashboardCommand($, 'start')).text).toBe('Could not start the dashboard: the check printed too much.\ndashboard: unknown (the check printed too much)')
  })

  for (const reading of [
    { ...DASHBOARD_ON, set_up: false },
    { ...DASHBOARD_ON, why: 'unit not installed' },
  ]) {
    test(`an on reading that contradicts itself (${JSON.stringify(reading)}) is no reading, from a read or from a start`, BY_PROGRESS, async ($, on) => {
      seat(on)
      const helper = dashboardHelper(on)
      helper.answers['status'] = reading
      helper.answers['start'] = { outcome: 'done', message: 'Started the dashboard.', ...reading }
      await start($)

      expect((await dashboardCommand($, 'status')).text).toBe('dashboard: unknown (the check answered nothing it reads)')
      expect((await dashboardCommand($, 'start')).text).toMatch(/^Could not start the dashboard: /)
    })
  }

  const HOSTILE = 'bad\u0000 \u001b[31mred\u202e\u2028end'
  const UNDRAWABLE = /[\u0000-\u0009\u000b-\u001f\u007f\u202e\u2028\u2029]/

  test('what the helper says is drawn without control, format or line-separator characters, wherever it shows', BY_PROGRESS, async ($, on) => {
    const { world, clock } = seat(on)
    const helper = dashboardHelper(on)
    helper.answers['status'] = { ...STOPPED, why: HOSTILE, fix: HOSTILE }
    helper.answers['start'] = { outcome: 'failed', message: HOSTILE, ...STOPPED, why: HOSTILE, fix: HOSTILE }
    await start($)
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await clock.settle()
    await ui.press({ key: 'dashboard' })
    const said = [(await dashboardCommand($, 'start')).text, (await dashboardCommand($, 'status')).text]

    expect(await dashboardLine(ui)).toBe('dashboard: off (bad [31mred end) · replies: off (Answer endpoint setting off)')

    for (const text of [await dashboardLine(ui), world.status, ...world.toasts, ...said]) {
      expect(text ?? '').not.toMatch(UNDRAWABLE)
    }
  })

  test("a listener's last words are drawn without control characters in the replies part", ON, async ($, on) => {
    const { clock } = seat(on)
    const helper = dashboardHelper(on)
    helper.isListenerFailing = true
    helper.listenerSays = 'gone \u001b[2J\u202eaway'
    await start($)
    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await clock.settle()

    expect(await dashboardLine(ui)).toBe('dashboard: on · replies: off (endpoint failed: gone [2Jaway)')
  })

  for (const older of ['automatic', 'explicit'] as const) {
    for (const newer of ['status', 'start', 'stop'] as const) {
      test(`an older ${older} read that answers last leaves the newer ${newer} standing`, BY_PROGRESS, async ($, on) => {
        const { world, clock } = seat(on)
        const helper = dashboardHelper(on)
        // The older read sees the opposite of what the newer one leaves.
        helper.answers['status'] = newer === 'start' ? STOPPED : DASHBOARD_ON
        helper.answers['start'] = STARTED
        helper.answers['stop'] = STOPPED_NOW
        helper.holding = 'status'
        await start($)
        await $.tool.call(KEY_TASK)
        const asked = older === 'automatic' ? undefined : dashboardCommand($, 'status')

        if (older === 'automatic') {
          await $.ui.mount(PANE)
        }

        await clock.settle()
        helper.answers['status'] = STOPPED
        await dashboardCommand($, newer)
        helper.letGo()
        await asked
        await clock.settle()

        expect(world.status).toBe(`☐ 1 task for you · /my-tasks · ${newer === 'start' ? NOW_ON : NOW_OFF}`)
      })
    }
  }
  describe('with no surface attached, the text replies lead to the web page (#180)', () => {
    const OPEN_TASKS = 'mcp__human-in-the-loop__open_tasks'

    test('a running dashboard: open_tasks and /my-tasks lead with its link', async ($, on) => {
      const { world } = seat(on)
      dashboardHelper(on)
      await startHeadless($, world)
      const tool = String((await $.tool.call({ tool: OPEN_TASKS })).result)
      const command = (await runTasks($)).text

      for (const text of [tool, command]) {
        expect(text).toMatch(/^Open the dashboard: http:\/\/box:6767\. Open tasks: no open tasks \(pane not shown: no surface is attached\)$/)
      }

      expect(world.opens).toEqual([])
    })

    test('a dashboard that is not running names /overview start', async ($, on) => {
      const { world } = seat(on)
      const helper = dashboardHelper(on)
      helper.answers['status'] = STOPPED
      await startHeadless($, world)

      expect(String((await $.tool.call({ tool: OPEN_TASKS })).result)).toContain('/overview start')
    })

    test('a dashboard never set up says so and names its README', async ($, on) => {
      const { world } = seat(on)
      const helper = dashboardHelper(on, { hasConfig: false })
      await startHeadless($, world)

      expect(String((await $.tool.call({ tool: OPEN_TASKS })).result)).toContain('not set up (dashboard/README.md)')
      expect(helper.runs).toEqual([])
    })
  })
})

describe('Overview entry point', () => {
  test('an agent can explicitly open My tasks with no task assigned', async ($, on) => {
    const { world } = seat(on)
    await start($)
    const result = await $.tool.call({ tool: 'mcp__human-in-the-loop__open_tasks' })
    expect(result.isError).not.toBe(true)
    expect(world.opens.at(-1)?.id).toBe('my-tasks')
    expect((await (await $.ui.mount(PANE)).find({ type: 'Text' }))?.text).toContain('No tasks for you right now.')
    expect((await $.tool.call({ tool: LIST })).result).toContain('No tasks')
  })
})


test('Overview keeps an explicitly opened My tasks pane available after the last task is withdrawn', async ($, on) => {
  const { world } = seat(on)
  await start($)
  await $.tool.call(KEY_TASK)
  await $.tool.call({ tool: 'mcp__human-in-the-loop__open_tasks' })
  await $.tool.call({ tool: WITHDRAW, id: 1, reason: 'No longer needed.' })
  expect(world.isPaneOpen).toBe(true)
  expect((await (await $.ui.mount(PANE)).find({ type: 'Text' }))?.text).toContain('No tasks for you right now.')
})


describe('a session with no surface (T3 Code runs Claude Code through the SDK)', () => {
  test('open_tasks lists the open tasks as text and opens nothing', async ($, on) => {
    const { world } = seat(on)
    await startHeadless($, world)
    await $.tool.call(KEY_TASK)
    const result = await $.tool.call({ tool: 'mcp__human-in-the-loop__open_tasks' })

    expect(result.isError).not.toBe(true)
    expect(String(result.result)).toContain('pane not shown: no surface is attached')
    expect(String(result.result)).toContain('#1')
    expect(world.opens).toEqual([])
  })

  test('open_tasks with no task says so', async ($, on) => {
    const { world } = seat(on)
    await startHeadless($, world)
    const result = await $.tool.call({ tool: 'mcp__human-in-the-loop__open_tasks' })

    expect(String(result.result)).toContain('no open tasks')
    expect(String(result.result)).toContain('pane not shown: no surface is attached')
    expect(world.opens).toEqual([])
  })

  test('/my-tasks answers in text and opens nothing', async ($, on) => {
    const { world } = seat(on)
    await startHeadless($, world)
    await $.tool.call(KEY_TASK)
    const result = await runTasks($)

    expect(result.text).toContain('pane not shown: no surface is attached')
    expect(result.text).toContain('#1')
    expect(world.opens).toEqual([])
  })

  test('assigning a task opens no pane and focuses nothing', async ($, on) => {
    const { world } = seat(on)
    await startHeadless($, world)
    const assigned = await $.tool.call(KEY_TASK)

    expect(String((assigned as { result?: unknown }).result)).toContain('Assigned task #1')
    expect(world.opens).toEqual([])
    expect(world.focuses).toEqual([])
  })

  const KEYS = keysOf('/repo')

  test('tasks from an earlier session open no pane as the session joins', async ($, on) => {
    const { world } = seat(on, {
      [KEYS.session('session-0')]: { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 },
    })
    await startHeadless($, world)

    expect(world.opens).toEqual([])
  })

  test('the heartbeat that first reads the project opens no pane', async ($, on) => {
    const { world, clock } = seat(on, {
      [KEYS.session('session-0')]: { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 },
    })
    world.isStoreFailing = true
    await startHeadless($, world)

    world.isStoreFailing = false
    await clock.advance(60_000)
    await clock.settle()

    expect(world.opens).toEqual([])
  })

  test('opening a field asks no surface to focus it', async ($, on) => {
    const { world } = seat(on)
    await startHeadless($, world)
    await $.tool.call(XCODE_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'answer' })

    expect(world.focuses).toEqual([])
    expect(world.opens.every(open => open.focus === undefined)).toBe(true)
  })
})

describe('archiving (#187)', () => {
  const DAY = 24 * 60 * 60_000
  const KEYS = keysOf('/repo')
  const MINE = KEYS.session('session-1')

  function slotsIn(store: Record<string, unknown>) {
    return projectOf('/repo', store).slots
  }

  test("Archive in a live session's pane sends it nothing: no message, no turn, no digest on the next prompt", async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'archive' })
    await clock.advance(1000)
    await clock.settle()

    expect(world.submitted).toEqual([])
    expect(world.appended).toEqual([])
    expect(world.status).toBeUndefined()
    expect(world.toasts.at(-1)).toContain('Archived #1')
    expect(world.toasts.at(-1)).toContain('Nothing was sent to Claude')

    // Claude finishing a turn, or the user's next prompt, carries nothing about it either.
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.settle()
    const next = await $.prompt.submit(typed('now the cart'))

    expect(world.submitted).toEqual([])
    expect(next.context ?? []).toEqual([])
    // The slot keeps it, archived, still open and unanswered.
    const kept = slotsIn(world.store)['session-1']?.tasks[0]
    expect(kept).toMatchObject({ id: 1, state: 'open', update: 'none', archivedMs: NOW })
  })

  test('the Archived section lists the task with its deletion day, and Restore puts it back unchanged, sending nothing', async ($, on) => {
    const { world, clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    const before = slotsIn(world.store)['session-1']?.tasks[0]
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'archive' })
    await clock.settle()
    await runTasks($)
    const archived = ui

    // Collapsed: one row that counts them.
    expect(await textOf(archived, 'archived')).toContain('Archived (1)')
    expect(await archived.find({ key: 'restore-1' })).toBeUndefined()

    await archived.press({ key: 'archived' })
    // NOW is 1970-01-01T00:16:40Z: archived then, deleted 7 days on.
    expect(await textOf(archived, 'archived-1')).toContain('#1 Add STRIPE_SECRET_KEY to .env')
    expect(await textOf(archived, 'archived-1')).toContain('deleted on 1970-01-08')

    await archived.press({ key: 'restore-1' })
    await clock.settle()

    const restored = slotsIn(world.store)['session-1']?.tasks[0]
    expect(restored?.archivedMs).toBeUndefined()
    expect({ ...restored, updatedMs: 0 }).toEqual({ ...before, updatedMs: 0 })
    expect(world.status).toBe('☐ 1 task for you · /my-tasks')
    expect(world.submitted).toEqual([])
    expect(await textOf(ui, 'task-1')).toContain("The webhook test can't run without it.")
  })

  test('list_tasks shows an archived task as archived by the owner, never as answered', async ($, on) => {
    const { clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'archive' })
    await clock.settle()

    const listed = String(((await $.tool.call({ tool: LIST })) as { result?: unknown }).result)
    expect(listed).toContain('#1 archived by the owner')
    expect(listed).toContain('deleted on 1970-01-08')
    const open = String(((await $.tool.call({ tool: LIST, show: 'open' })) as { result?: unknown }).result)
    expect(open).toBe('No tasks match.')

    const withdrawn = await $.tool.call({ tool: WITHDRAW, id: 1 })
    expect((withdrawn as { deny?: string }).deny).toContain('Task #1 was archived by the owner, unanswered')

    // It no longer counts toward the 5 open tasks.
    for (const n of [2, 3, 4, 5, 6]) {
      const assigned = await $.tool.call({ ...KEY_TASK, title: `Do thing number ${n}` })
      expect(String((assigned as { result?: unknown }).result)).toContain(`Assigned task #${n}`)
    }
  })

  test('/my-tasks archive and restore by number; with no surface, the text lists the archived task with its deletion day', async ($, on) => {
    const { world } = seat(on)
    await startHeadless($, world)
    await $.tool.call(KEY_TASK)

    const archived = await $.command.run({ command: 'my-tasks', args: 'archive #1', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    expect(archived.text).toBe('Archived #1: Add STRIPE_SECRET_KEY to .env. Nothing was sent to Claude. Restore it with /my-tasks restore 1 until 1970-01-08.')

    const listed = await runTasks($)
    expect(listed.text).toContain('Open tasks: no open tasks')
    expect(listed.text).toContain('Archived (1): #1 Add STRIPE_SECRET_KEY to .env, deleted on 1970-01-08.')

    const again = await $.command.run({ command: 'my-tasks', args: 'archive 1', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    expect(again.text).toBe('No open task #1 here to archive.')

    const restored = await $.command.run({ command: 'my-tasks', args: 'restore 1', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    expect(restored.text).toBe('Restored #1: Add STRIPE_SECRET_KEY to .env. It is back in My tasks; nothing was sent to Claude.')
    expect((await runTasks($)).text).toContain('Open tasks: #1 Add STRIPE_SECRET_KEY to .env')
    expect(world.submitted).toEqual([])

    const wrong = await $.command.run({ command: 'my-tasks', args: 'archive soon', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    expect(wrong.text).toBe('Usage: /my-tasks [archive <n> | restore <n>]')
  })

  test("an ended session's task is archived from the session that took it on, and stays archived through the next session that takes it on", async ($, on) => {
    const { world, clock } = seat(on, { [KEYS.session('session-0')]: { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 } })
    await start($)

    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'archive' })
    await clock.settle()

    expect(slotsIn(world.store)['session-0']).toBeUndefined()
    expect(slotsIn(world.store)['session-1']?.tasks).toEqual([{ ...ROTATE, archivedMs: NOW, updatedMs: NOW }])

    // After /clear, the next session takes it on still archived: the pane counts it under Archived, the status line not at all.
    world.sessionId = 'session-2'
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    await clock.advance(1)
    await clock.settle()

    expect(slotsIn(world.store)['session-2']?.tasks).toEqual([{ ...ROTATE, archivedMs: NOW, updatedMs: NOW }])
    expect(world.status).toBeUndefined()
    expect(world.submitted).toEqual([])
    const listed = String(((await $.tool.call({ tool: LIST })) as { result?: unknown }).result)
    expect(listed).toContain('#7 archived by the owner')
  })

  test('a stored task whose archive time is not a whole number from 0 is kept, as an open task, never deleted', async ($, on) => {
    // The dashboard's rule too (`is_whole`): a string, a negative or a fraction is no archive time.
    const bad = ['last week', -1, 1.5].map((archivedMs, i) => ({ ...ROTATE, id: i + 1, createdMs: i, sessionId: 'session-1', archivedMs }))
    const { world, clock } = seat(on, { [MINE]: { tasks: bad, seenMs: NOW - 10 * 60_000, nextId: 4 } })
    await start($)
    await clock.advance(60_000)
    await clock.settle()

    expect(slotsIn(world.store)['session-1']?.tasks).toEqual(bad.map(({ archivedMs: _bad, ...kept }) => kept))
    expect(world.status).toBe('☐ 3 tasks for you · /my-tasks')
  })

  test('assign_task does not ask again what the owner archived: it refuses, naming the day', async ($, on) => {
    const { clock } = seat(on)
    await start($)

    await $.tool.call(KEY_TASK)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'archive' })
    await clock.settle()

    const again = await $.tool.call({ ...KEY_TASK, title: 'add stripe_secret_key to .env!' })
    expect((again as { deny?: string }).deny).toBe('#1 was archived by the owner on 1970-01-01; not re-assigned.')
    const listed = String(((await $.tool.call({ tool: LIST })) as { result?: unknown }).result)
    expect(listed).not.toContain('assign it again')
    expect(listed).toContain('#1 archived by the owner')
  })

  test('an archived task is kept, listed and restorable to the exact 7-day mark; 1 ms on it is listed nowhere and cannot be restored', async ($, on) => {
    const atMark = { ...ROTATE, id: 1, sessionId: 'session-1', archivedMs: LATE - ARCHIVE_KEEP_MS }
    const later = { ...ROTATE, id: 2, createdMs: 1, sessionId: 'session-1', title: 'Archived 1 ms later', archivedMs: LATE - ARCHIVE_KEEP_MS + 1 }
    const { world, clock } = seat(on, { [MINE]: { tasks: [atMark, later], seenMs: LATE - 10 * 60_000, nextId: 3 } }, LATE)
    await startHeadless($, world)
    const list = async (args: Record<string, unknown> = {}) => String(((await $.tool.call({ tool: LIST, ...args })) as { result?: unknown }).result)

    // At the mark: kept by the load, and listed.
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.id)).toEqual([1, 2])
    expect(await list()).toContain('#1 archived by the owner')

    await clock.advance(1)

    // 1 ms past it, before any write: #1 is listed nowhere, and Restore leaves it to be deleted.
    expect(await list()).not.toContain('#1 ')
    expect(await list({ show: 'all' })).not.toContain('#1 ')
    expect(await list({ id: 1 })).toBe('No task #1.')
    expect((await runTasks($)).text).toContain('Archived (1): #2 Archived 1 ms later')
    const restore = async (n: number) => (await $.command.run({ command: 'my-tasks', args: `restore ${n}`, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })).text
    expect(await restore(1)).toBe('No archived task #1 here to restore.')
    // #2 is at its own mark now: still restorable.
    expect(await restore(2)).toBe('Restored #2: Archived 1 ms later. It is back in My tasks; nothing was sent to Claude.')
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => [task.id, task.archivedMs])).toEqual([[2, undefined]])
  })

  test("/my-tasks archive and restore take on an ended session's task in a live session: only that session's slot, nothing sent to Claude", async ($, on) => {
    const { world } = seat(on)
    await startHeadless($, world)
    await $.tool.call(KEY_TASK)
    world.store[KEYS.session('session-0')] = { tasks: [ROTATE], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 8 }
    const shelvedThere = { ...ROTATE, id: 8, createdMs: 8, sessionId: 'session-3', title: 'Archived in an ended session', archivedMs: NOW - 1000 }
    world.store[KEYS.session('session-3')] = { tasks: [shelvedThere], seenMs: NOW - 60_000, endedMs: NOW - 60_000, nextId: 9 }
    const run = async (args: string) => (await $.command.run({ command: 'my-tasks', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })).text

    expect(await run('archive 7')).toBe('Archived #7: Rotate the leaked token in Vault. Nothing was sent to Claude. Restore it with /my-tasks restore 7 until 1970-01-08.')
    expect(slotsIn(world.store)['session-0']).toBeUndefined()
    expect(slotsIn(world.store)['session-3']?.tasks).toEqual([shelvedThere])

    expect(await run('restore 8')).toBe('Restored #8: Archived in an ended session. It is back in My tasks; nothing was sent to Claude.')
    expect(slotsIn(world.store)['session-3']).toBeUndefined()
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => [task.id, task.archivedMs])).toEqual([
      [1, undefined],
      [7, NOW],
      [8, undefined],
    ])
    expect(await run('archive 9')).toBe('No open task #9 here to archive.')
    expect(world.submitted).toEqual([])
  })

  test('a resumed session holding its own archived task keeps it once, not twice', async ($, on) => {
    const own = { ...ROTATE, id: 1, sessionId: 'session-1', archivedMs: NOW - 60_000 }
    const { world, clock } = seat(on, { [MINE]: { tasks: [own], seenMs: NOW - 10 * 60_000, nextId: 2 } })
    await start($)
    await clock.advance(60_000)
    await clock.settle()

    expect(slotsIn(world.store)['session-1']?.tasks).toEqual([own])
    const listed = String(((await $.tool.call({ tool: LIST, show: 'all' })) as { result?: unknown }).result)
    expect(listed.match(/#1 archived by the owner/g)).toHaveLength(1)
  })

  test('with a fixed clock, archived tasks over 7 days old are gone after the next load and the next write; newer ones and every other task stay', async ($, on) => {
    const open = { ...ROTATE, id: 1, sessionId: 'session-1', title: 'Open task' }
    const pending = { ...ROTATE, id: 2, sessionId: 'session-1', title: 'Answered task', state: 'done', update: 'pending' }
    const old = { ...ROTATE, id: 3, sessionId: 'session-1', title: 'Archived 8 days ago', archivedMs: LATE - 8 * DAY }
    const due = { ...ROTATE, id: 4, sessionId: 'session-1', title: 'Archived 7 days less 30 s ago', archivedMs: LATE - 7 * DAY + 30_000 }
    const recent = { ...ROTATE, id: 5, sessionId: 'session-1', title: 'Archived 6 days ago', archivedMs: LATE - 6 * DAY }
    // An ended session's slot: its archived tasks go with the rest to whoever takes it on.
    const ended = { ...ROTATE, id: 6, sessionId: 'session-0', title: "Ended session's archived task", archivedMs: LATE - 9 * DAY }
    const endedKept = { ...ROTATE, id: 8, sessionId: 'session-0', title: "Ended session's recent archive", archivedMs: LATE - DAY }
    const { world, clock } = seat(on, {
      [MINE]: { tasks: [open, pending, old, due, recent], seenMs: LATE - 10 * 60_000, nextId: 6 },
      [KEYS.session('session-0')]: { tasks: [ended, endedKept], seenMs: LATE - DAY, endedMs: LATE - DAY, nextId: 9 },
    }, LATE)
    await start($)

    // The load: 8- and 9-day-old archives are gone; nothing else is.
    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.id)).toEqual([1, 2, 4, 5, 8])
    expect(slotsIn(world.store)['session-0']).toBeUndefined()

    // The next write, a heartbeat a minute on: #4 is now over 7 days archived.
    await clock.advance(60_000)
    await clock.settle()

    expect(slotsIn(world.store)['session-1']?.tasks.map(task => task.id)).toEqual([1, 2, 5, 8])
    const listed = String(((await $.tool.call({ tool: LIST, show: 'all' })) as { result?: unknown }).result)
    expect(listed).not.toContain('#4 ')
    expect(listed).toContain('#1 open')
    expect(listed).toContain('#2 done')
  })
})
