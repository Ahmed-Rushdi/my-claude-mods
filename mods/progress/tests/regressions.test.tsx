import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Agent, Pull, Round, Ticket } from '../types'

const NOW = 1_700_000_000_000

const BAND = {
  plugin: 'progress',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: true,
    maxRows: 10,
    bodyColumns: 200,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'progress',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'progress',
  props: {
    title: 'Progress',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const DONE = {
  durationMs: 61_000,
  isAborted: false,
  reason: 'answer',
  category: null,
  explanation: null,
} as const

const OUTPUT: Record<string, string> = {
  'git commit -m "fix round 1"': '[seam/hooks 4357a4c] fix round 1\n 2 files changed',
  'gh pr create --draft --fill': 'https://github.com/o/r/pull/24',
  'gh pr new --draft --fill': 'https://github.com/o/r/pull/24',
  'gh issue create -t x -b y': 'https://github.com/o/r/issues/7',
  'gh issue new -t x -b y': 'https://github.com/o/r/issues/7',
  'uv run pytest -q': '26 passed in 1.20s',
}

/** A commit's oid, as GitHub writes one: `n` padded to forty hex digits. */
const sha = (n: number) => String(n).padStart(40, '0')

const pull = (number: number, state: string, isDraft: boolean, headRefName: string, checks: string | null = null, more: Record<string, unknown> = {}) => ({
  number,
  state,
  isDraft,
  reviewDecision: null,
  headRefName,
  headRefOid: `head${number}`,
  baseRefName: 'umbrella/507-evals',
  mergeable: 'MERGEABLE',
  mergedAt: state === 'MERGED' ? '2026-11-10T09:00:00Z' : null,
  repository: { nameWithOwner: 'o/r' },
  ...more,
  statusCheckRollup: checks === null ? null : { state: checks },
})

const issue = (number: number, title: string, more: Record<string, unknown> = {}) => ({
  number,
  title,
  state: 'OPEN',
  url: `https://github.com/o/r/issues/${number}`,
  blockedBy: { nodes: [] },
  closedByPullRequestsReferences: { nodes: [] },
  timelineItems: { nodes: [] },
  ...more,
})

const mention = (source: ReturnType<typeof pull>, willCloseTarget = false) => ({ willCloseTarget, source })

/** #507 with five sub-issues, one in each state. */
const GITHUB = JSON.stringify({
  data: {
    repository: {
      i507: {
        // Its sub-issues share a branch, whose own PR into dev is still a draft.
        ...issue(507, 'Eval redesign', {
          timelineItems: { nodes: [mention(pull(540, 'OPEN', true, 'umbrella/507-evals', null, { baseRefName: 'dev' }))] },
        }),
        subIssues: {
          nodes: [
            // Its PR is out of draft: the person's turn.
            issue(511, 'Scorer contract', {
              timelineItems: { nodes: [mention(pull(530, 'OPEN', false, 'feat/511-scorer', 'SUCCESS'))] },
            }),
            issue(512, 'Dataset loader', {
              timelineItems: { nodes: [mention(pull(531, 'OPEN', true, 'feat/512-loader', 'FAILURE'))] },
            }),
            issue(513, 'Report page', { blockedBy: { nodes: [{ number: 512, state: 'OPEN' }] } }),
            // Blocked in its text only, by one that has landed: ready.
            issue(514, 'Docs', { body: 'Part of #507.\n\nBlocked by: #510' }),
            // Merged into a branch that is not the default: the issue stays
            // open, the work is in. #531 only mentions it.
            issue(510, 'Fixtures', { state: 'CLOSED', stateReason: 'COMPLETED',
              timelineItems: {
                nodes: [mention(pull(520, 'MERGED', false, 'feat/510-fixtures')), mention(pull(531, 'OPEN', true, 'feat/512-loader'))],
              },
            }),
          ],
        },
      },
    },
  },
})

const BODY = JSON.stringify({
  data: {
    repository: {
      issue: {
        title: 'Scorer contract',
        body: '## What to build\n\nA scorer.',
        comments: { totalCount: 1, nodes: [{ author: { login: 'colleague' }, createdAt: '2026-11-10T10:00:00Z', body: 'Ship it.' }] },
      },
    },
  },
})

const run = (text: string) => ({ exitCode: 0, stdout: text, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

/** What GitHub says of the branch `dev`, and of PR #540's checks: a test sets them. */
const DRAFT = JSON.stringify({ state: 'OPEN', isDraft: true, baseRefName: 'dev', headRefOid: 'head540', autoMergeRequest: null })
/** PR #540 as GitHub answers a view of it: out of draft, into `base`, at `head`. */
const READY = (base = 'dev', head = 'head540') => JSON.stringify({ state: 'OPEN', isDraft: false, baseRefName: base, headRefOid: head, autoMergeRequest: null })
/** `remote`: the session's git remote, null where it has none. `landed`: numbers GitHub answers as merged PRs. */
/** A Bash call that runs until `slow.end()`. */
const slow = { gate: Promise.resolve(), end: () => {} }
/**
 * What a merge call does: its exit, and what GitHub says of the pull request
 * after it (`then` merged over the view; null: it can no longer be read).
 */
type Merging = { exitCode: number; stderr: string; then: Record<string, unknown> | null; isTimeout?: boolean }
const MERGED: Merging = { exitCode: 0, stderr: '', then: { state: 'MERGED' } }
/** Set, the goal's GraphQL asks wait on `gate`, looks at the checks on `checks`, any process call `call.match` names on `call.until`, and a store read of `store.key` on `store.until`: held in flight. */
const held = {
  gate: null as Promise<void> | null,
  checks: null as Promise<void> | null,
  call: null as { match: (argv: readonly string[]) => boolean; until: Promise<void> } | null,
  store: null as { key: string; until: Promise<void> } | null,
  /** Set, every `$.env.get` waits on it: a decision-log write held before it reads anything else. */
  env: null as Promise<void> | null,
}
/** The session the engine is in: a test changes it as a /clear or a resume would. */
const session = { id: 's1' }
/** The decision-log writer (#99): the lines the mod handed to `python3 decision_log.py`, and how the writer behaves. */
type LogLine = { hook: string; decision: string; reason: string; session: string | null; inputs: Record<string, unknown> }
const logger = { lines: [] as LogLine[], mode: 'ok' as 'ok' | 'fail' | 'hang' | 'missing' }
/** How each writer mode reads in a test name; `missing`: the profile has no `hooks/decision_log.py` (#127). */
const WRITER = { fail: 'fails', hang: 'hangs', missing: 'is not installed (#127)' } as const
/** `elsewhere`: PRs on GitHub that are not in the goal's answer (an umbrella's own PR). `isCut`: the goal's answers come back cut at the read limit. */
const github = {
  answer: GITHUB,
  rules: '[]',
  checks: ['[]'],
  pull: DRAFT,
  board540: 'head540',
  repo540: 'o/r',
  merging: MERGED,
  remote: 'git@github.com:o/r.git' as string | null,
  landed: [] as number[],
  /** The base a landed PR the goal's answer makes up went into, by number; the umbrella otherwise. */
  bases: {} as Record<number, string>,
  /** When a landed PR the goal's answer makes up merged, by number (a test sets it; the fixed day in 2026 otherwise). */
  mergedAt: {} as Record<number, string>,
  /** The body of a PR the goal's answer makes up, by number. */
  bodies: {} as Record<number, string>,
  isOffRefused: false,
  elsewhere: [] as Record<string, unknown>[],
  isCut: false,
  /** A follow-up answer to give in place of the right one, once per refresh while set. */
  followUp: null as string | null,
}

/** Every PR an answer holds, wherever it is in it. */
const prsIn = (node: unknown): Record<string, unknown>[] => {
  if (typeof node !== 'object' || node === null) {
    return []
  }

  const one = node as Record<string, unknown>

  return [...(typeof one.number === 'number' && 'headRefName' in one ? [one] : []), ...Object.values(one).flatMap(prsIn)]
}

/** A refresh's follow-up ask (PR bodies), answered from the PRs GitHub holds; undefined for any other call. */
function followUpAnswer(argv: readonly string[], all: readonly Record<string, unknown>[]): string | undefined {
  const query = argv.at(-1) ?? ''

  if (!/\bb\d+: pullRequest\(/.test(query)) {
    return undefined
  }

  const repository: Record<string, unknown> = {}

  for (const [, number = ''] of query.matchAll(/\bb(\d+): pullRequest\(/g)) {
    repository[`b${number}`] = { body: all.find(one => one.number === Number(number))?.body ?? '' }
  }

  return JSON.stringify({ data: { repository } })
}
/** The mod's read of one pull request: a GraphQL ask, for the merge-queue fields `gh pr view` does not have. */
const isPullAsk = (argv: readonly string[]) => argv[1] === 'api' && argv[2] === 'graphql' && (argv.at(-1) ?? '').includes('isMergeQueueEnabled')
/** The gh calls "merge when green" made, in order: a read of the pull request is VIEW. */
const calls = (ran: readonly string[][]) => ran.filter(one => one[1] === 'pr' || isPullAsk(one)).map(one => (isPullAsk(one) ? VIEW : one.slice(2).join(' ')))

/** The engine beneath the mod: each hook answers as a session would. `kept`: what an earlier process left in the store. */
async function world($: Engine, on: On, saved?: unknown, kept: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: NOW })
  const store: Record<string, unknown> = saved === undefined ? { ...kept } : { ...kept, 'goal:s1': saved }
  const ran: string[][] = []
  /** When each of `ran` was made, by the mocked clock. */
  const times: number[] = []
  const toasts: string[] = []
  let tasks = 0
  session.id = 's1'
  held.checks = null
  held.call = null
  held.store = null
  held.env = null
  github.isOffRefused = false
  github.rules = '[]'
  github.checks = ['[]']
  github.pull = DRAFT
  github.merging = MERGED
  github.board540 = 'head540'
  github.repo540 = 'o/r'
  github.remote = 'git@github.com:o/r.git'
  github.landed = []
  github.bases = {}
  github.mergedAt = {}
  github.bodies = {}
  github.answer = GITHUB
  github.elsewhere = []
  github.isCut = false
  github.followUp = null

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: session.id }))
  on('env.get', async (_, e) => {
    if (held.env !== null) {
      await held.env
    }

    return { value: e.name === 'HOME' ? '/home/u' : undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('session.repo', () => ({ value: { root: '/repo', remote: github.remote, internal: false, name: null } }))
  on('store.get', async (_, e) => {
    if (held.store?.key === e.key) {
      await held.store.until
    }

    if (store[e.key] instanceof Error) throw store[e.key]
    return { value: store[e.key] }
  })
  on('store.set', (_, e) => {
    store[e.key] = e.value

    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    delete store[e.key]

    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  held.gate = null
  logger.lines = []
  logger.mode = 'ok'
  on('process.run', async (_, e) => {
    if (e.argv[0] === 'python3') {
      // Kept apart from `ran`, which is the gh calls.
      logger.lines.push(JSON.parse(e.init?.stdin ?? '{}') as LogLine)

      if (logger.mode === 'fail') {
        throw new Error('unwritable')
      }

      if (logger.mode === 'hang') {
        await new Promise<void>(() => undefined)
      }

      if (logger.mode === 'missing') {
        return { value: { ...run(''), exitCode: 2, stderr: "python3: can't open file '/home/u/.claude/hooks/decision_log.py': [Errno 2] No such file or directory" } }
      }

      return { value: run('') }
    }

    ran.push([...e.argv])
    times.push(clock.now())

    if (held.call?.match(e.argv) === true) {
      await held.call.until
    }

    if (e.argv[1] === 'api' && e.argv[2] !== 'graphql') {
      return { value: run(github.rules) }
    }

    if (isPullAsk(e.argv)) {
      return { value: run(github.pull === '' ? '' : JSON.stringify({ data: { repository: { pullRequest: JSON.parse(github.pull) } } })) }
    }

    if (e.argv[1] === 'pr' && e.argv[2] === 'merge') {
      if (e.argv.includes('--disable-auto')) {
        if (github.isOffRefused) {
          return { value: { ...run(''), exitCode: 1, stderr: 'GraphQL: Resource not accessible by integration' } }
        }

        github.pull = JSON.stringify({ ...JSON.parse(github.pull), autoMergeRequest: null })

        return { value: run('') }
      }

      const { exitCode, stderr, then, isTimeout } = github.merging
      github.pull = then === null ? '' : JSON.stringify({ ...JSON.parse(github.pull), ...then })

      if (isTimeout === true) {
        // As `$.process.run` does with a child still running at its timeout: killed, and the call rejects.
        throw new Error('the command timed out after 30000 ms')
      }

      return { value: { ...run(''), exitCode, stderr } }
    }

    if (e.argv[1] === 'pr' && e.argv[2] === 'checks' && held.checks !== null) {
      await held.checks
    }

    if (e.argv[1] === 'pr' && e.argv[2] === 'ready') {
      // Out of draft: a later view says so.
      github.pull = JSON.stringify({ ...JSON.parse(github.pull), isDraft: false })
    }

    if (e.argv[1] === 'pr') {
      // Each look at the checks is the next the test laid out; the last one stays.
      return { value: run(e.argv[2] === 'checks' ? (github.checks.length > 1 ? (github.checks.shift() as string) : (github.checks[0] as string)) : '') }
    }

    const asked = e.argv.at(-1) ?? ''

    if (asked.includes('comments(')) {
      return { value: run(BODY) }
    }

    const more = followUpAnswer(e.argv, [...prsIn(JSON.parse(github.answer)), ...github.elsewhere])

    if (more !== undefined) {
      return { value: run(github.followUp ?? more) }
    }

    if (held.gate !== null) {
      await held.gate
    }

    // A number that names a PR answers as one, as `issueOrPullRequest` does.
    const answer = JSON.parse(github.answer)

    // Issue aliases from the fixture are returned only when explicitly queried.
    for (const top of Object.values(answer.data.repository) as any[]) {
      for (const child of top?.subIssues?.nodes ?? []) answer.data.repository[`i${child.number}`] = child
    }

    // The head of #540 as the board reads it.
    if (answer.data.repository.i507 !== undefined) {
      answer.data.repository.i507.timelineItems.nodes[0].source.headRefOid = github.board540
      answer.data.repository.i507.timelineItems.nodes[0].source.repository = { nameWithOwner: github.repo540 }
    }

    for (const [, number = ''] of asked.matchAll(/\bi(\d+): issueOrPullRequest/g)) {
      answer.data.repository[`i${number}`] ??= {
        title: `PR ${number}`,
        url: `https://github.com/o/r/pull/${number}`,
        body: github.bodies[Number(number)] ?? '',
        ...pull(Number(number), github.landed.includes(Number(number)) ? 'MERGED' : 'OPEN', true, `feat/${number}-x`, null, { baseRefName: github.bases[Number(number)] ?? 'umbrella/507-evals', ...(github.mergedAt[Number(number)] === undefined ? {} : { mergedAt: github.mergedAt[Number(number)] }) }),
      }
    }

    return { value: github.isCut ? { ...run(JSON.stringify(answer).slice(0, 4096)), isStdoutTruncated: true } : run(JSON.stringify(answer)) }
  })
  const tools: unknown[] = []
  on('tool.register', (_, e) => { tools.push(e); return { value: { tool: `mcp__progress__${e.name}` } } })
  on('ui.close', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  const opened: unknown[] = []
  on('ui.open', (_, e) => { opened.push(e); return { value: { isPlaced: true } } })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  let spawned = 0
  // A resume runs on under the id it had.
  on('agent.spawn', (_, e) => ({ model: 'sonnet', agentId: e.resume?.agentId ?? `a${(spawned += 1)}` }))
  on('agent.list', () => ({ value: [] }))
  on('tool.call', { tool: 'Bash' }, async (_, e) => {
    // `sleep 3600` runs until the test lets it end.
    if (e.command === 'sleep 3600') {
      await slow.gate
    }

    return { result: { stdout: OUTPUT[e.command] ?? '', stderr: '', interrupted: false } }
  })
  on('tool.call', { tool: 'TaskCreate' }, (_, e) => ({
    result: { task: { id: String((tasks += 1)), subject: e.subject } },
  }))
  on('tool.call', { tool: 'TaskUpdate' }, (_, e) => ({
    result: { success: true, taskId: e.taskId, updatedFields: [] },
  }))

  return { clock, ran, times, store, toasts, opened, tools }
}

async function start($: Engine) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await progress($, '')
}

function progress($: Engine, args: string) {
  return $.command.run({
    command: 'progress',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
}

type Finder = { find: (query: { type: 'Text' | 'Button'; text: RegExp }) => Promise<{ text?: string } | undefined> }

/** What a pattern finds, or MISSING: a failure names what was looked for. */
async function seen(ui: Finder, text: RegExp) {
  const found = (await ui.find({ type: 'Text', text })) ?? (await ui.find({ type: 'Button', text }))

  return `${text}: ${found?.text ?? 'MISSING'}`
}

const labelled = (...names: string[]) => ({ labels: { nodes: names.map(name => ({ name })) } })
const intoUmbrella = (number: number, body: string, more: Record<string, unknown> = {}) => mention(pull(number, 'MERGED', false, `feat/x-${number}`, null, { body, ...more }))
const RULES = JSON.stringify([
  { type: 'pull_request', parameters: { allowed_merge_methods: ['squash'] } },
  { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'tests / tests' }] } },
])
const checks = (bucket: string) => JSON.stringify([{ name: 'retest', bucket: 'skipping' }, { name: 'tests / tests', bucket }])

const VIEW = 'view'
const CHECKS = 'checks 540 -R o/r --json name,bucket'
/** The one merge the mod makes: of the head the person confirmed, and no other. */
const MERGE = 'merge 540 -R o/r --squash --match-head-commit head540'

test('merge when green marks ready, waits out the draft-time skipped gate, then merges the confirmed head', { options: { owner_workflow: true } }, async ($, on) => {
  const { clock, ran, store } = await world($, on)
  await start($)
  await progress($, 'goal 507 512')
  github.rules = RULES
  // The gate job is created when the tests finish: until then its draft-time
  // result stands, skipped, which GitHub reads as passed.
  github.checks = [checks('skipping'), checks('skipping'), checks('pending'), checks('pass')]
  const did = () => calls(ran)

  const pane = await $.ui.mount(PANE)

  // A ticket whose PR goes into the umbrella branch has no such button.
  await pane.press({ key: 't512' })
  expect(await pane.find({ key: 'ship' })).toBeUndefined()
  await pane.press({ key: 'back' })

  // The heading's own PR goes into dev: asked, then confirmed.
  await pane.press({ key: 't507' })
  await pane.press({ key: 'ship' })
  expect(await seen(pane, /Mark PR o\/r#540 ready, which starts its CI run, and merge at head540 into dev once the checks pass\?/)).not.toContain('MISSING')
  expect(did()).toEqual([])
  expect((store['overview:s1'] as any).owner.ship.step).toBe('confirm')
  await pane.press({ key: 'ship-no' })
  expect((store['overview:s1'] as any).owner.ship).toBe(null)
  await pane.press({ key: 'ship' })
  await pane.press({ key: 'ship-yes' })
  expect((store['overview:s1'] as any).owner.ship.step).toBe('working')
  expect(did()).toEqual([VIEW, 'ready 540 -R o/r'])
  expect(await seen(pane, /Keep this session open until then/)).not.toContain('MISSING')
  // At work, there is nothing to press a second time.
  expect(await pane.find({ key: 'ship' })).toBeUndefined()
  expect(await pane.find({ key: 'ship-yes' })).toBeUndefined()

  await clock.advance(30_000)
  await clock.advance(30_000)
  await clock.advance(30_000)
  expect(did()).toEqual([VIEW, 'ready 540 -R o/r', CHECKS, CHECKS, CHECKS])
  // Passed: read again, held to what was confirmed, then merged by its head.
  await clock.advance(30_000)
  // Merged, then read back: GitHub's word is what the note says.
  expect(did()).toEqual([VIEW, 'ready 540 -R o/r', CHECKS, CHECKS, CHECKS, CHECKS, VIEW, MERGE, VIEW])
  expect(await seen(pane, /Its required checks passed: merged at head540/)).not.toContain('MISSING')
  expect((store['overview:s1'] as any).owner.ship.step).toBe('armed')
  expect((store['overview:s1'] as any).owner.ship.note).toMatch(/merged at head540/)
  // Done, it looks no more.
  await clock.advance(120_000)
  expect(did().length).toBe(9)
  await pane.unmount()
})

test('an auto-merge already queued is switched off before anything else, draft or not', { options: { owner_workflow: true } }, async ($, on) => {
  const { ran } = await world($, on)
  await start($)
  await progress($, 'goal 507')
  github.rules = RULES
  github.pull = JSON.stringify({ state: 'OPEN', isDraft: true, baseRefName: 'dev', headRefOid: 'head540', autoMergeRequest: { enabledAt: '2026-11-10T10:00:00Z' } })

  const pane = await $.ui.mount(PANE)

  await pane.press({ key: 't507' })
  await pane.press({ key: 'ship' })
  await pane.press({ key: 'ship-yes' })
  expect(calls(ran)).toEqual([VIEW, 'merge 540 -R o/r --disable-auto', 'ready 540 -R o/r'])
  await pane.unmount()
})

test('an auto-merge queued on a PR already out of draft is switched off too: it would outlive the confirmation', { options: { owner_workflow: true } }, async ($, on) => {
  const { ran } = await world($, on)
  await start($)
  await progress($, 'goal 507')
  github.rules = RULES
  github.pull = JSON.stringify({ state: 'OPEN', isDraft: false, baseRefName: 'dev', headRefOid: 'head540', autoMergeRequest: { enabledAt: '2026-11-10T10:00:00Z' } })

  const pane = await $.ui.mount(PANE)

  await pane.press({ key: 't507' })
  await pane.press({ key: 'ship' })
  await pane.press({ key: 'ship-yes' })
  expect(calls(ran)).toEqual([VIEW, 'merge 540 -R o/r --disable-auto'])
  await pane.unmount()
})

test('where every required check has already passed, it is merged at the first look', { options: { owner_workflow: true } }, async ($, on) => {
  const { clock, ran } = await world($, on)
  await start($)
  await progress($, 'goal 507')
  github.rules = RULES
  github.pull = READY()
  github.checks = [checks('pass')]

  const pane = await $.ui.mount(PANE)

  await pane.press({ key: 't507' })
  await pane.press({ key: 'ship' })
  await pane.press({ key: 'ship-yes' })
  await clock.advance(30_000)
  // Already out of draft: not marked again.
  expect(calls(ran)).toEqual([VIEW, CHECKS, VIEW, MERGE, VIEW])
  expect(ran.some(one => one.includes('--auto'))).toBe(false)
  await pane.unmount()
})

test('a branch with a merge queue is refused, at the press and right before the merge', { options: { owner_workflow: true } }, async ($, on) => {
  const { clock, ran } = await world($, on)
  await start($)
  await progress($, 'goal 507')
  github.rules = RULES
  github.checks = [checks('pass')]
  // A merge call there may turn auto-merge on instead of merging.
  github.pull = JSON.stringify({ ...JSON.parse(DRAFT), isMergeQueueEnabled: true })

  const pane = await $.ui.mount(PANE)

  await pane.press({ key: 't507' })
  await pane.press({ key: 'ship' })
  await pane.press({ key: 'ship-yes' })
  expect(await seen(pane, /dev has a merge queue.*Nothing was merged/)).not.toContain('MISSING')
  expect(calls(ran)).toEqual([VIEW])

  // Queue switched on while its checks ran: not merged either.
  github.pull = DRAFT
  await pane.press({ key: 'ship' })
  await pane.press({ key: 'ship-yes' })
  github.pull = JSON.stringify({ ...JSON.parse(READY()), isMergeQueueEnabled: true })
  await clock.advance(30_000)
  expect(calls(ran)).toEqual([VIEW, VIEW, 'ready 540 -R o/r', CHECKS, VIEW])
  expect(await seen(pane, /dev has a merge queue/)).not.toContain('MISSING')
  // It was marked ready by then: the note does not say nothing was changed.
  expect(await seen(pane, /Nothing was changed/)).toContain('MISSING')
  expect(await pane.find({ key: 'ship' })).toBeDefined()
  await pane.unmount()
})

/** Presses merge when green on a ready #540 whose checks have passed, and lets the first look run. */
async function mergeOnce($: Engine, on: On, merging: Merging) {
  const { clock, ran } = await world($, on)
  await start($)
  await progress($, 'goal 507')
  github.rules = RULES
  github.pull = READY()
  github.checks = [checks('pass')]
  github.merging = merging

  const pane = await $.ui.mount(PANE)

  await pane.press({ key: 't507' })
  await pane.press({ key: 'ship' })
  await pane.press({ key: 'ship-yes' })
  await clock.advance(30_000)

  return { pane, ran }
}








test('a required check that failed stops it: nothing is merged, and it can be pressed again', { options: { owner_workflow: true } }, async ($, on) => {
  const { clock, ran } = await world($, on)
  await start($)
  await progress($, 'goal 507')
  github.rules = RULES
  github.pull = READY()
  github.checks = [checks('fail')]

  const pane = await $.ui.mount(PANE)

  await pane.press({ key: 't507' })
  await pane.press({ key: 'ship' })
  await pane.press({ key: 'ship-yes' })
  await clock.advance(30_000)
  expect(calls(ran)).toEqual([VIEW, CHECKS])
  expect(await seen(pane, /these required checks failed: tests \/ tests\. Nothing was merged/)).not.toContain('MISSING')
  expect(await pane.find({ key: 'ship' })).toBeDefined()
  await pane.unmount()
})

test('a pull request that closed, or was pointed at an umbrella branch, is left alone', { options: { owner_workflow: true } }, async ($, on) => {
  const { ran } = await world($, on)
  await start($)
  await progress($, 'goal 507')
  github.rules = RULES
  github.pull = JSON.stringify({ state: 'MERGED', isDraft: false, baseRefName: 'dev', headRefOid: 'head540' })

  const pane = await $.ui.mount(PANE)

  await pane.press({ key: 't507' })
  await pane.press({ key: 'ship' })
  await pane.press({ key: 'ship-yes' })
  expect(await seen(pane, /the pull request is no longer open/)).not.toContain('MISSING')

  github.pull = JSON.stringify({ state: 'OPEN', isDraft: true, baseRefName: 'umbrella/507-evals', headRefOid: 'head540' })
  await pane.press({ key: 'ship' })
  await pane.press({ key: 'ship-yes' })
  expect(await seen(pane, /it now merges into umbrella\/507-evals, not dev as confirmed/)).not.toContain('MISSING')
  expect(calls(ran).map(one => one.split(' ')[0])).toEqual(['view', 'view'])
  await pane.unmount()
})

test('a PR retargeted after the confirmation is not merged, and no auto-merge is ever queued', { options: { owner_workflow: true } }, async ($, on) => {
  const { clock, ran } = await world($, on)
  await start($)
  await progress($, 'goal 507')
  github.rules = RULES
  github.checks = [checks('pending'), checks('pass')]

  const pane = await $.ui.mount(PANE)

  await pane.press({ key: 't507' })
  await pane.press({ key: 'ship' })
  expect(await seen(pane, /merge at head540 into dev once the checks pass/)).not.toContain('MISSING')
  await pane.press({ key: 'ship-yes' })
  // While its checks run, someone points it at another branch.
  github.pull = READY('main')
  await clock.advance(30_000)
  await clock.advance(30_000)
  await clock.advance(30_000)
  expect(ran.some(one => one[1] === 'pr' && one[2] === 'merge')).toBe(false)
  expect(await seen(pane, /now merges into main, not dev as confirmed/)).not.toContain('MISSING')
  await pane.unmount()
})

test('a PR whose head moved after the confirmation is not merged', { options: { owner_workflow: true } }, async ($, on) => {
  const { clock, ran } = await world($, on)
  await start($)
  await progress($, 'goal 507')
  github.rules = RULES
  github.checks = [checks('pass')]

  const pane = await $.ui.mount(PANE)

  // Pushed to between the board's read and the press: nothing is done.
  await pane.press({ key: 't507' })
  await pane.press({ key: 'ship' })
  github.pull = JSON.stringify({ state: 'OPEN', isDraft: true, baseRefName: 'dev', headRefOid: 'head999', autoMergeRequest: null })
  await pane.press({ key: 'ship-yes' })
  expect(calls(ran).map(one => one.split(' ')[0])).toEqual(['view'])
  expect(await seen(pane, /new commits since you confirmed/)).not.toContain('MISSING')

  // Pushed to while the checks run: read again before merging, and left alone.
  github.pull = DRAFT
  await pane.press({ key: 'ship' })
  await pane.press({ key: 'ship-yes' })
  github.pull = READY('dev', 'head999')
  await clock.advance(30_000)
  expect(ran.some(one => one[1] === 'pr' && one[2] === 'merge')).toBe(false)
  expect(await seen(pane, /new commits since you confirmed/)).not.toContain('MISSING')
  await pane.unmount()
})

test('a press that finds the PR moved reads the board again, so the next confirmation names the new head', { options: { owner_workflow: true } }, async ($, on) => {
  const { clock } = await world($, on)
  await start($)
  await progress($, 'goal 507')
  github.rules = RULES

  const pane = await $.ui.mount(PANE)

  await pane.press({ key: 't507' })
  await pane.press({ key: 'ship' })
  // Pushed to after the board's last read.
  github.pull = JSON.stringify({ ...JSON.parse(DRAFT), headRefOid: 'head999' })
  github.board540 = 'head999'
  await pane.press({ key: 'ship-yes' })
  expect(await seen(pane, /new commits since you confirmed/)).not.toContain('MISSING')
  await clock.advance(1000)
  await pane.press({ key: 'ship' })
  expect(await seen(pane, /merge at head999 into dev once the checks pass/)).not.toContain('MISSING')
  await pane.unmount()
})

test("a PR in another repository than the goal's is left out: no row, no merge when green button", { options: { owner_workflow: true } }, async ($, on) => {
  await world($, on)
  github.repo540 = 'x/y'
  await start($)
  await progress($, 'goal 507')

  const pane = await $.ui.mount(PANE)

  // Its number names another PR in the goal's repository: never shown, never offered.
  await pane.press({ key: 't507' })
  expect(await seen(pane, /PR #540/)).toContain('MISSING')
  expect(await pane.find({ key: 'ship' })).toBeUndefined()
  await pane.unmount()
})


test('merge when green changes nothing where the branch requires no checks', { options: { owner_workflow: true } }, async ($, on) => {
  const { ran } = await world($, on)
  await start($)
  await progress($, 'goal 507')
  github.rules = JSON.stringify([{ type: 'pull_request', parameters: { allowed_merge_methods: ['squash'] } }])

  const pane = await $.ui.mount(PANE)

  await pane.press({ key: 't507' })
  await pane.press({ key: 'ship' })
  await pane.press({ key: 'ship-yes' })
  expect(await seen(pane, /dev has no required checks, so a merge would go in with nothing run/)).not.toContain('MISSING')
  // Read, and nothing else: not marked ready, not merged.
  expect(calls(ran).map(one => one.split(' ')[0])).toEqual(['view'])
  await pane.unmount()
})

test('branch rules that share no merge method are refused before anything changes', { options: { owner_workflow: true } }, async ($, on) => {
  const { ran } = await world($, on)
  await start($)
  await progress($, 'goal 507')
  github.rules = JSON.stringify([...(JSON.parse(RULES) as unknown[]), { type: 'pull_request', parameters: { allowed_merge_methods: ['merge'] } }])

  const pane = await $.ui.mount(PANE)

  await pane.press({ key: 't507' })
  await pane.press({ key: 'ship' })
  await pane.press({ key: 'ship-yes' })
  expect(await seen(pane, /the rules of dev share no merge method.*Nothing was changed/)).not.toContain('MISSING')
  expect(calls(ran)).toEqual([VIEW])
  await pane.unmount()
})

test('a merge method the rules name that is not merge, squash or rebase is never passed on: the press is refused', { options: { owner_workflow: true } }, async ($, on) => {
  const { ran } = await world($, on)
  await start($)
  await progress($, 'goal 507')
  github.rules = JSON.stringify([{ type: 'pull_request', parameters: { allowed_merge_methods: ['admin'] } }, ...(JSON.parse(RULES) as unknown[]).slice(1)])

  const pane = await $.ui.mount(PANE)

  await pane.press({ key: 't507' })
  await pane.press({ key: 'ship' })
  await pane.press({ key: 'ship-yes' })
  expect(await seen(pane, /the rules of dev share no merge method this button uses \(merge, squash or rebase\).*Nothing was changed/)).not.toContain('MISSING')
  expect(calls(ran)).toEqual([VIEW])
  await pane.unmount()
})

test('repository names are compared without regard to case', { options: { owner_workflow: true } }, async ($, on) => {
  const { clock, store } = await world($, on)
  await start($)
  // GitHub reads O/R as o/r: the goal, the session's remote and the PR's repository agree.
  await progress($, 'goal O/R#507')
  github.answer = JSON.stringify({ data: { repository: { ...JSON.parse(GITHUB).data.repository, i12: issue(12, 'Explicit case comparison') } } })
  await progress($, 'add o/r#12')
  await clock.advance(8000)
  expect(store['goal:s1']).toMatchObject({ repo: 'O/R', numbers: [507, 12] })

  const pane = await $.ui.mount(PANE)

  await pane.press({ key: 't507' })
  expect(await pane.find({ key: 'ship' })).toBeDefined()
  await pane.unmount()
})

test('a gate that never reports leaves the PR ready and unmerged, and the looking stops', { options: { owner_workflow: true } }, async ($, on) => {
  const { clock, ran } = await world($, on)
  await start($)
  await progress($, 'goal 507')
  github.rules = RULES
  github.checks = [checks('skipping')]

  const pane = await $.ui.mount(PANE)

  await pane.press({ key: 't507' })
  await pane.press({ key: 'ship' })
  await pane.press({ key: 'ship-yes' })

  for (let tries = 0; tries < 360; tries += 1) {
    await clock.advance(30_000)
  }

  const looks = () => ran.filter(one => one[2] === 'checks').length

  expect(await seen(pane, /after three hours these required checks had not passed in this run: tests \/ tests\./)).not.toContain('MISSING')
  expect(calls(ran).map(one => one.split(' ')[0]).slice(0, 2)).toEqual(['view', 'ready'])
  expect(ran.some(one => one[2] === 'merge')).toBe(false)
  expect(looks()).toBe(360)
  await clock.advance(120_000)
  expect(looks()).toBe(360)
  // It can be pressed again.
  expect(await pane.find({ key: 'ship' })).toBeDefined()
  await pane.unmount()
})

/**
 * Presses merge when green on the draft #540, its checks pending, then passed:
 * marked ready, and waiting. The sessions after it (s2, s3) work toward the
 * same goal, stored under their own ids, so the issue's reader stays open.
 */
async function pressed($: Engine, on: On, beneath: (hook: On) => void = () => {}) {
  const same = { repo: 'o/r', numbers: [507] }
  const made = await world($, on, undefined, { 'goal:s2': same, 'goal:s3': same })
  beneath(on)
  await start($)
  await progress($, 'goal 507')
  github.rules = RULES
  github.checks = [checks('pending'), checks('pass')]

  const pane = await $.ui.mount(PANE)

  await pane.press({ key: 't507' })
  await pane.press({ key: 'ship' })
  await pane.press({ key: 'ship-yes' })
  expect(calls(made.ran)).toEqual([VIEW, 'ready 540 -R o/r'])

  return { ...made, pane }
}

// Owner decision (task #13, 2026-11-18; source, the owner's prompt of 2026-11-18:
// "for the 4 tasks go with the sensible option", which took the task's
// recommended option): a pending merge runs only while the session where the
// person pressed is still the current one.
for (const reason of ['clear', 'resume', 'prompt_input_exit', 'logout', 'other'] as const) {
  test(`a session change (${reason}) cancels a merge when green: it never merges, and the next session says so`, { options: { owner_workflow: true } }, async ($, on) => {
    const { clock, ran, toasts, pane } = await pressed($, on)

    session.id = 's2'
    await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } })

    for (let tries = 0; tries < 4; tries += 1) {
      await clock.advance(30_000)
    }

    // Nothing after the change: no look at the checks, no merge.
    expect(calls(ran)).toEqual([VIEW, 'ready 540 -R o/r'])
    // The next session's first event shows it, once, and it can be pressed again there.
    await progress($, '')
    await progress($, '')
    expect(await seen(pane, /PR o\/r#540 was cancelled.*nothing was merged/)).not.toContain('MISSING')
    expect(await pane.find({ key: 'ship' })).toBeDefined()
    expect(toasts.filter(one => /PR o\/r#540 was cancelled/.test(one))).toHaveLength(1)
    await pane.unmount()
  })
}

test('a confirmation not yet given is not carried into the next session', { options: { owner_workflow: true } }, async ($, on) => {
  const { ran } = await world($, on)
  await start($)
  await progress($, 'goal 507')
  github.rules = RULES

  const pane = await $.ui.mount(PANE)

  await pane.press({ key: 't507' })
  await pane.press({ key: 'ship' })
  expect(await pane.find({ key: 'ship-yes' })).toBeDefined()
  session.id = 's2'
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect(await pane.find({ key: 'ship-yes' })).toBeUndefined()
  expect(await pane.find({ key: 'ship' })).toBeDefined()
  expect(calls(ran)).toEqual([])
  await pane.unmount()
})


test('a timer that fires after the session changed does nothing, and the PR can be pressed again', { options: { owner_workflow: true } }, async ($, on) => {
  const { clock, ran, pane } = await pressed($, on)

  // Another copy of the mod heard the change, or none did: the timer is still set.
  session.id = 's2'
  await clock.advance(30_000)
  await clock.advance(30_000)
  expect(calls(ran)).toEqual([VIEW, 'ready 540 -R o/r'])
  expect(await seen(pane, /PR o\/r#540 was cancelled: the session changed/)).not.toContain('MISSING')

  // Pressed again in the session now current, it goes on there.
  github.checks = [checks('pass')]
  await pane.press({ key: 'ship' })
  await pane.press({ key: 'ship-yes' })
  await clock.advance(30_000)
  expect(calls(ran)).toEqual([VIEW, 'ready 540 -R o/r', VIEW, CHECKS, VIEW, MERGE, VIEW])
  await pane.unmount()
})

test('a look at the checks in flight when the session changes does not go on to merge', { options: { owner_workflow: true } }, async ($, on) => {
  const { clock, ran, pane } = await pressed($, on)
  github.checks = [checks('pass')]

  let release = () => {}
  held.checks = new Promise(resolve => {
    release = resolve
  })
  await clock.advance(30_000)
  session.id = 's2'
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  held.checks = null
  release()
  await clock.advance(30_000)
  await clock.advance(30_000)
  // Its answer came back green after the change: not read again, not merged.
  expect(calls(ran)).toEqual([VIEW, 'ready 540 -R o/r', CHECKS])
  await pane.unmount()
})

/** Holds every process call `match` names in flight; the function returned lets them go. */
function hold(match: (argv: readonly string[]) => boolean) {
  let release = () => {}
  held.call = {
    match,
    until: new Promise<void>(resolve => {
      release = resolve
    }),
  }

  return () => {
    held.call = null
    release()
  }
}

const isMergeCall = (argv: readonly string[]) => argv[1] === 'pr' && argv[2] === 'merge' && !argv.includes('--disable-auto')
const END = (sessionId = 's1') => ({ reason: 'clear', sessionId, resume: { id: sessionId } }) as const

test('a merge when green cancelled after it marked the PR ready says it stays marked ready', { options: { owner_workflow: true } }, async ($, on) => {
  const { store, pane } = await pressed($, on)

  session.id = 's2'
  await $.session.end(END())
  expect((store['ship-cancelled'] as { note: string }).note).toMatch(/so nothing was merged\. It stays marked ready\. Press again to go on\./)

  // Cancelled while its ready mark was out: it may have been taken.
  github.pull = DRAFT
  await progress($, '')
  await pane.press({ key: 'ship' })
  const release = hold(argv => argv[1] === 'pr' && argv[2] === 'ready')
  await pane.press({ key: 'ship-yes' })
  session.id = 's3'
  await $.session.end(END('s2'))
  release()
  expect((store['ship-cancelled'] as { note: string }).note).toMatch(/so nothing was merged\. Its ready mark was out, so it may stay marked ready\. Press again to go on\./)
  await pane.unmount()
})

test('after a session change with the merge call out, what GitHub did takes the note’s place: an auto-merge it could not switch off is said', { options: { owner_workflow: true } }, async ($, on) => {
  const { clock, ran, store, toasts, pane } = await pressed($, on)
  github.merging = { exitCode: 0, stderr: '', then: { autoMergeRequest: { enabledAt: '2026-11-18T10:00:00Z' } } }
  github.isOffRefused = true
  const release = hold(isMergeCall)

  await clock.advance(30_000)
  await clock.advance(30_000)
  expect(calls(ran)).toEqual([VIEW, 'ready 540 -R o/r', CHECKS, CHECKS, VIEW, MERGE])
  session.id = 's2'
  await $.session.end(END())
  release()
  await clock.advance(30_000)
  // The read-back and the switch-off it tried, and nothing more.
  expect(calls(ran)).toEqual([VIEW, 'ready 540 -R o/r', CHECKS, CHECKS, VIEW, MERGE, VIEW, 'merge 540 -R o/r --disable-auto'])
  const left = store['ship-cancelled'] as { note: string }
  expect(left.note).toMatch(/while its merge call was out\. Read back after it: auto-merge was on instead of a merge.*switching it off failed.*Switch it off on GitHub/)
  expect(left.note).not.toMatch(/not known here/)

  await progress($, '')
  expect(await seen(pane, /switching it off failed/)).not.toContain('MISSING')
  expect(toasts).toEqual([left.note])
  await pane.unmount()
})

test('an outcome read back after the next session showed the cancel takes its note’s place in the pane', { options: { owner_workflow: true } }, async ($, on) => {
  const { clock, store, pane } = await pressed($, on)
  const release = hold(isMergeCall)

  await clock.advance(30_000)
  await clock.advance(30_000)
  session.id = 's2'
  await $.session.end(END())
  await progress($, '')
  expect(await seen(pane, /whether it merged is not known here/)).not.toContain('MISSING')
  release()
  await clock.advance(30_000)
  expect(await seen(pane, /the session was cleared while its merge call was out\. Read back after it: its required checks passed: merged at head540\./)).not.toContain('MISSING')
  // Shown once already: not stored again for a later session.
  expect(store['ship-cancelled']).toBeUndefined()
  await pane.unmount()
})


test('a session whose id reads empty at the press is refused: nothing is read or changed', { options: { owner_workflow: true } }, async ($, on) => {
  const { ran } = await world($, on)
  await start($)
  await progress($, 'goal 507')
  github.rules = RULES

  const pane = await $.ui.mount(PANE)

  await pane.press({ key: 't507' })
  await pane.press({ key: 'ship' })
  session.id = ''
  await pane.press({ key: 'ship-yes' })
  expect(calls(ran)).toEqual([])
  expect(await seen(pane, /the session it was pressed in is not known/)).not.toContain('MISSING')
  await pane.unmount()
})

test('told of the end before the id changes, it does nothing more, and the next session takes over only once its id reads', { options: { owner_workflow: true } }, async ($, on) => {
  const { clock, ran, store, toasts, pane } = await pressed($, on)

  // The engine tells the end; the id still reads the ending session's.
  await $.session.end(END())
  await progress($, '')
  await clock.advance(30_000)
  await clock.advance(30_000)
  expect(calls(ran)).toEqual([VIEW, 'ready 540 -R o/r'])
  expect(toasts).toEqual([])
  expect(store['ship-cancelled']).toBeDefined()

  // The id changes: the next session shows it once, and keeps its own rounds under its own id.
  session.id = 's2'
  await progress($, '')
  await $.tool.call({ tool: 'mcp__progress__publish', session_id: 's2', repo: 'o/r', reviews: [{ pr: 531, key: '531:abc1234' }] })
  await progress($, '')
  expect(toasts.filter(one => /PR o\/r#540 was cancelled/.test(one))).toHaveLength(1)
  expect((store['review:s2'] as { rounds: Round[] }).rounds.map(one => one.key)).toEqual(['531:abc1234'])
  expect(store['review:s1']).toBeUndefined()
  await pane.unmount()
})


test('a merge when green cancelled by a resume away and back is said once, when its session is current again', { options: { owner_workflow: true } }, async ($, on) => {
  const { clock, ran, store, toasts, pane } = await pressed($, on)
  const said = () => toasts.filter(one => /PR o\/r#540 was cancelled/.test(one))

  // Away to s2 and back to s1, with no event in s2.
  session.id = 's2'
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
  session.id = 's1'
  await $.session.end({ reason: 'resume', sessionId: 's2', resume: { id: 's2' } })

  for (let tries = 0; tries < 4; tries += 1) {
    await clock.advance(30_000)
  }

  await progress($, '')
  expect(calls(ran)).toEqual([VIEW, 'ready 540 -R o/r'])
  expect(said()).toHaveLength(1)
  expect(store['ship-cancelled']).toBeUndefined()
  expect(await seen(pane, /PR o\/r#540 was cancelled: another conversation took its place.*It stays marked ready/)).not.toContain('MISSING')

  // Not said again in a later session.
  session.id = 's3'
  await $.session.end(END())
  await progress($, '')
  expect(said()).toHaveLength(1)
  await pane.unmount()
})


// Owner decision (task #26, 2026-11-18, option chosen: "Both as recommended"): one
// routine binds a session's state, re-reading its goal, review rounds and the
// stored cancel note together whenever the session id changes.

const crowd = (ready: number, deferred: number) =>
  JSON.stringify({
    data: {
      repository: {
        i600: {
          ...issue(600, 'Crowd', { timelineItems: { nodes: [mention(pull(71, 'MERGED', false, 'umbrella/600-x', null, { baseRefName: 'dev', headRefOid: sha(71) }))] } }),
          subIssues: {
            nodes: [
              ...Array.from({ length: ready }, (_, at) => issue(610 + at, `Waits ${at}`)),
              ...Array.from({ length: deferred }, (_, at) => issue(630 + at, `Later ${at}`, labelled('deferred'))),
              issue(650, 'Closed one', { state: 'CLOSED' }),
              issue(651, 'Closed as done', { state: 'CLOSED', stateReason: 'COMPLETED' }),
              issue(653, 'Closed as not planned', { state: 'CLOSED', stateReason: 'NOT_PLANNED' }),
              issue(652, 'Inside an umbrella', { timelineItems: { nodes: [intoUmbrella(72, 'Fixes #652')] } }),
            ],
          },
        },
      },
    },
  })

test('#155: each section heading is a button that folds its rows, the count stays, and the fold is kept with the goal', { options: { owner_workflow: true } }, async ($, on) => {
  const { store } = await world($, on)
  await start($)
  await progress($, 'goal 511 512 513 514 510')
  const pane = await $.ui.mount(PANE)

  expect(await seen(pane, /#514 Docs/)).not.toContain('MISSING')
  await pane.press({ key: 's-ready' })
  expect(await pane.find({ type: 'Button', text: /#514 Docs/ })).toBeUndefined()
  // Folded, the heading still says how many are in it.
  expect(await seen(pane, /Ready.* 1$/)).not.toContain('MISSING')
  expect(store['goal:s1']).toEqual({ repo: 'o/r', numbers: [511, 512, 513, 514, 510], sections: { ready: 'closed' } })

  await pane.press({ key: 's-ready' })
  expect(await seen(pane, /#514 Docs/)).not.toContain('MISSING')
  await pane.unmount()
})


test('#155: more than five rows start at the first five and "and N more", which shows the rest when pressed', { options: { owner_workflow: true } }, async ($, on) => {
  const { store } = await world($, on)
  github.answer = crowd(7, 0)
  await start($)
  await progress($, 'goal 610 611 612 613 614 615 616 650 651 653 652')
  const pane = await $.ui.mount(PANE)

  expect(await seen(pane, /#614 Waits 4/)).not.toContain('MISSING')
  expect(await pane.find({ type: 'Button', text: /#615 Waits 5/ })).toBeUndefined()
  expect(await seen(pane, /and 3 more/)).not.toContain('MISSING')

  await pane.press({ key: 'more-ready' })
  expect(await seen(pane, /#616 Waits 6/)).not.toContain('MISSING')
  expect(store['goal:s1']).toEqual({ repo: 'o/r', numbers: [610, 611, 612, 613, 614, 615, 616, 650, 651, 653, 652], sections: { ready: 'all' } })
})

test('#155: issues labelled deferred are in their own Deferred section, closed until pressed, below Ready', { options: { owner_workflow: true } }, async ($, on) => {
  await world($, on)
  github.answer = crowd(2, 3)
  await start($)
  await progress($, 'goal 610 611 630 631 632 650 651 653 652')
  const pane = await $.ui.mount(PANE)

  expect(await seen(pane, /Deferred.* 3/)).not.toContain('MISSING')
  expect(await pane.find({ type: 'Button', text: /Later 0/ })).toBeUndefined()
  // Not among the Ready rows' count.
  expect(await seen(pane, /Ready.* 3$/)).not.toContain('MISSING')
  expect(await seen(pane, /#610 Waits 0/)).not.toContain('MISSING')

  await pane.press({ key: 's-deferred' })
  expect(await seen(pane, /#630 Later 0/)).not.toContain('MISSING')
  const heads = (await pane.findAll({ type: 'Button' })).map(one => one.key)
  expect(heads.indexOf('s-ready')).toBeLessThan(heads.indexOf('s-deferred'))
})


// --- #156 feedback on hover and press (the progress pane) --------------------

const shownOf = async (ui: { find: (query: { key: string }) => Promise<{ text?: string } | undefined> }, key: string) => (await ui.find({ key }))?.text

test('#156: every Button and clickable row of the pane has a hover style of its own group', { options: { owner_workflow: true } }, async ($, on) => {
  await world($, on)
  await start($)
  await progress($, 'goal 507 511 512 513 514 510')
  const pane = await $.ui.mount(PANE)

  type Drawn = { type: string; props?: { key?: string }; hover?: { scope?: string; bold?: boolean; underline?: boolean }; children?: unknown[] }
  const buttonsIn = (node: unknown): Drawn[] => {
    const one = node as Drawn

    return typeof node !== 'object' || node === null ? [] : [...(one.type === 'Button' ? [one] : []), ...(one.children ?? []).flatMap(buttonsIn)]
  }

  const check = async () => {
    const buttons = buttonsIn(await pane.drawn())

    expect(buttons.length).toBeGreaterThanOrEqual(4)

    for (const one of buttons) {
      // Its own group, named after it; no colour, so it reads on a light and on a dark theme alike.
      expect(one.hover?.scope, `${one.props?.key}`).toBe(`progress:${one.props?.key}`)
      expect(one.hover?.bold).toBe(true)
      expect(one.hover?.underline).toBe(true)
    }
  }

  await check()
  await pane.press({ key: 't507' })
  await pane.press({ key: 'ship' })
  await check()
  expect(await pane.find({ key: 'ship-yes' })).toBeDefined()
  await pane.unmount()
})

test('#156: a press shows a mark at once, for about 200 ms, and its action runs once', { options: { owner_workflow: true } }, async ($, on) => {
  const { clock, store } = await world($, on)
  await start($)
  await progress($, 'goal 511 512 513 514 510')
  const pane = await $.ui.mount(PANE)

  expect(await shownOf(pane, 't514')).not.toMatch(/^●/)
  await pane.press({ key: 's-ready' })
  expect(await shownOf(pane, 's-ready')).toMatch(/^●/)
  // Pressed once: folded once, not folded and opened again.
  expect(store['goal:s1']).toEqual({ repo: 'o/r', numbers: [511, 512, 513, 514, 510], sections: { ready: 'closed' } })
  await clock.advance(199)
  expect(await shownOf(pane, 's-ready')).toMatch(/^●/)
  await clock.advance(1)
  expect(await shownOf(pane, 's-ready')).not.toMatch(/^●/)

  // A row too.
  await pane.press({ key: 't511' })
  await pane.press({ key: 'back' })
  expect(await shownOf(pane, 'back')).toBeUndefined()
  await pane.unmount()
})

test('#156: a slow action shows working on its Button, a second press is ignored and says so, then the result shows for a moment', { options: { owner_workflow: true } }, async ($, on) => {
  const { clock, ran } = await world($, on)
  await start($)
  await progress($, 'goal 511 512 513 514 510')
  const asks = () => ran.filter(one => one[2] === 'graphql' && (one.at(-1) ?? '').includes('issue(number:')).length
  const before = asks()
  const pane = await $.ui.mount(PANE)
  let release = () => {}
  held.gate = new Promise<void>(done => {
    release = done
  })

  await pane.press({ key: 'refresh' })
  expect(asks()).toBe(before + 1)
  expect(await shownOf(pane, 'refresh')).toBe('● refresh')
  await clock.advance(200)
  expect(await shownOf(pane, 'refresh')).toBe('◐ refreshing…')

  // Pressed again at work: nothing is asked, and the Button says why.
  await pane.press({ key: 'refresh' })
  expect(asks()).toBe(before + 1)
  expect(await shownOf(pane, 'refresh')).toBe('◐ still refreshing…')
  await clock.advance(200)
  expect(await shownOf(pane, 'refresh')).toBe('◐ refreshing…')

  release()
  held.gate = null
  await clock.advance(1)
  expect(await shownOf(pane, 'refresh')).toBe('✓ refresh')
  await clock.advance(1500)
  expect(await shownOf(pane, 'refresh')).toBe('refresh')
  expect(asks()).toBe(before + 1)
  await pane.unmount()
})

test('#156: merge when green keeps a Button while it is at work, which says so when pressed and does nothing', { options: { owner_workflow: true } }, async ($, on) => {
  const { clock, ran } = await world($, on)
  await start($)
  await progress($, 'goal 507 511 512 513 514 510')
  github.rules = RULES
  github.checks = [checks('pending')]
  const pane = await $.ui.mount(PANE)

  await pane.press({ key: 't507' })
  await pane.press({ key: 'ship' })
  await pane.press({ key: 'ship-yes' })
  const did = calls(ran).length

  expect(await shownOf(pane, 'ship-working')).toBe('merge when green is at work')
  await pane.press({ key: 'ship-working' })
  expect(await shownOf(pane, 'ship-working')).toBe('◐ it is at work: nothing to press')
  expect(calls(ran).length).toBe(did)
  await clock.advance(1500)
  expect(await shownOf(pane, 'ship-working')).toBe('merge when green is at work')
  await pane.unmount()
})

// --- #155 r1: budget, cut answers, press feedback, band and sections ----------


// The dashboard's line (#158): the human-in-the-loop plugin publishes it in
// its state once the dashboard is set up (its `dashboard` key), stamped with
// when it was read and a number; the pane draws it dim at its foot, as text
// only, drawn safe, while it is under 150 s old. No plugin, no line.
const DASHBOARD_LINE = { plugin: 'human-in-the-loop', key: 'dashboard' } as const
const stamped = (line: unknown, at = NOW, seq: unknown = 1) => ({ line, at, seq })

for (const [name, published, drawn] of [
  ['the line the human-in-the-loop plugin publishes', stamped('dashboard: on · replies: on'), 'dashboard: on · replies: on'],
  ['that line drawn without control, format or line-separator characters', stamped('dashboard: off (bad\u0000 \u001b[31mred\u202e end)'), 'dashboard: off (bad [31mred end)'],
  ['a line read 149 s ago', stamped('dashboard: on · replies: on', NOW - 149_999), 'dashboard: on · replies: on'],
  ['a line stamped a moment ahead of this clock', stamped('dashboard: on · replies: on', NOW + 5_000), 'dashboard: on · replies: on'],
] as const) {
  test(`the pane shows ${name}`, { options: { owner_workflow: true } }, async ($, on) => {
    await world($, on)
    on('state.get', DASHBOARD_LINE, () => ({ value: { value: published, version: 1 } }))
    await start($)

    const ui = await $.ui.mount(PANE)

    expect((await ui.find({ type: 'Text', text: /^dashboard: / }))?.text).toBe(drawn)
    await ui.unmount()
  })
}

for (const [name, published] of [
  ['without the human-in-the-loop plugin', undefined],
  ['with the dashboard not set up', null],
  ['with a value that is no line', { dashboard: 'on' }],
  ['with a line from before the stamp (a bare string)', 'dashboard: on · replies: on'],
  ['with a line read 150 s ago', stamped('dashboard: on · replies: on', NOW - 150_000)],
  ['with a line stamped well ahead of this clock', stamped('dashboard: on · replies: on', NOW + 5_001)],
  ['with a stamp that is no time', stamped('dashboard: on · replies: on', Number.NaN)],
  ['with a stamp whose time is a string', { line: 'dashboard: on · replies: on', at: String(NOW), seq: 1 }],
  ['with no number', { line: 'dashboard: on · replies: on', at: NOW }],
  ['with a number below zero', stamped('dashboard: on · replies: on', NOW, -1)],
  ['with a number that is no integer', stamped('dashboard: on · replies: on', NOW, 1.5)],
  ['with an empty line', stamped('')],
  ['with a line that is no string', stamped(['dashboard: on'])],
] as const) {
  test(`the pane has no dashboard line ${name}`, { options: { owner_workflow: true } }, async ($, on) => {
    await world($, on)

    if (published !== undefined) {
      on('state.get', DASHBOARD_LINE, () => ({ value: { value: published, version: 1 } }))
    }

    await start($)

    const ui = await $.ui.mount(PANE)

    expect(await seen(ui, /No goal yet/)).not.toContain('MISSING')
    expect(await ui.find({ type: 'Text', text: /dashboard/ })).toBeUndefined()
    await ui.unmount()
  })
}

// Fix round 3 (#158 / PR #163).
test('the pane draws no dashboard row, not even an empty one, for a line of control and format characters alone', { options: { owner_workflow: true } }, async ($, on) => {
  await world($, on)
  let published: unknown = null
  on('state.get', DASHBOARD_LINE, () => ({ value: { value: published, version: 1 } }))
  await start($)
  const without = await $.ui.mount(PANE)
  const texts = (await without.findAll({ type: 'Text' })).length
  await without.unmount()

  published = stamped('\u0000\u001b\u202e\u2028')
  const ui = await $.ui.mount(PANE)

  expect((await ui.findAll({ type: 'Text' })).length).toBe(texts)
  await ui.unmount()
})


// Whatever stops the plugin publishing (it is unloaded or stopped; the dashboard
// view's config or unit removed, so it reads no more), the last line it
// published stands still in the state: the pane drops it as it comes of age,
// with no publication and no other redraw to prompt it.
for (const readAgoMs of [0, 120_000]) {
  test(`a dashboard line read ${readAgoMs / 1000} s before the pane is drawn goes once it is 150 s old, with nothing published after it`, { options: { owner_workflow: true } }, async ($, on) => {
    const { clock } = await world($, on)
    on('state.get', DASHBOARD_LINE, () => ({ value: { value: stamped('dashboard: on · replies: on', NOW - readAgoMs), version: 1 } }))
    await start($)

    const ui = await $.ui.mount(PANE)
    expect((await ui.find({ type: 'Text', text: /^dashboard: / }))?.text).toBe('dashboard: on · replies: on')

    await clock.advance(150_000 - readAgoMs - 1)
    expect((await ui.find({ type: 'Text', text: /^dashboard: / }))?.text).toBe('dashboard: on · replies: on')

    await clock.advance(1)
    expect(await ui.find({ type: 'Text', text: /^dashboard: / })).toBeUndefined()
    await ui.unmount()
  })
}













test('#155: an answer cut at the read limit is a failed refresh, said so, never a wrong pane; its refresh Button ends on ✗', async ($, on) => {
  const { clock } = await world($, on)
  await start($)
  await progress($, 'goal 507 511 512 513 514 510')
  const pane = await $.ui.mount(PANE)

  github.isCut = true
  await pane.press({ key: 'refresh' })
  await clock.advance(200)
  expect(await seen(pane, /over the 4 MiB a call may read, and was cut/)).not.toContain('MISSING')
  expect(await shownOf(pane, 'refresh')).toBe('✗ refresh')
  // The rows of the last good answer stay.
  expect(await seen(pane, /#511 Scorer contract/)).not.toContain('MISSING')
  await clock.advance(1500)
  expect(await shownOf(pane, 'refresh')).toBe('refresh')
  await pane.unmount()
})

test('#156: a quick action that fails shows ✗ for a moment, failing at once or after its mark', async ($, on) => {
  const { clock } = await world($, on)
  const refused = { key: '', until: null as Promise<void> | null }
  on('state.set', async (_, e, next) => {
    if (refused.key !== '' && String((e as { key?: unknown }).key).endsWith(refused.key)) {
      if (refused.until !== null) {
        await refused.until
      }

      return { deny: 'the write was refused' }
    }

    return next(e)
  })
  await start($)
  await progress($, 'goal 507 511 512 513 514 510')
  const pane = await $.ui.mount(PANE)

  await pane.press({ key: 't511' })
  refused.key = 'doc'
  await pane.press({ key: 'back' })
  expect(await shownOf(pane, 'back')).toBe('● back')
  await clock.advance(200)
  expect(await shownOf(pane, 'back')).toBe('✗ back')
  await clock.advance(1500)
  expect(await shownOf(pane, 'back')).toBe('back')

  // Refused only after the mark has gone.
  let release = () => {}
  refused.until = new Promise<void>(done => {
    release = done
  })
  await pane.press({ key: 'back' })
  await clock.advance(200)
  expect(await shownOf(pane, 'back')).toBe('back')
  release()
  await clock.advance(1)
  expect(await shownOf(pane, 'back')).toBe('✗ back')
  await pane.unmount()
})

test('#156: a row pressed once opens its issue with exactly one ask of GitHub', async ($, on) => {
  const { ran } = await world($, on)
  await start($)
  await progress($, 'goal 507 511 512 513 514 510')
  const pane = await $.ui.mount(PANE)
  const reads = () => ran.filter(one => (one.at(-1) ?? '').includes('comments(')).length

  await pane.press({ key: 't511' })
  expect(reads()).toBe(1)
  await pane.unmount()
})







test('after the merge call, a pull request GitHub put in its merge queue is said to be queued, not merged', { options: { owner_workflow: true } }, async ($, on) => {
  const { pane, ran } = await mergeOnce($, on, { exitCode: 0, stderr: '', then: { isInMergeQueue: true } })
  expect(calls(ran)).toEqual([VIEW, CHECKS, VIEW, MERGE, VIEW])
  expect(await seen(pane, /queued in the merge queue of dev at head540/)).not.toContain('MISSING')
  expect(await seen(pane, /merged at/)).toContain('MISSING')
  await pane.unmount()
})

test('after the merge call, an auto-merge GitHub turned on instead is switched off, and nothing is said merged', { options: { owner_workflow: true } }, async ($, on) => {
  const { pane, ran } = await mergeOnce($, on, { exitCode: 0, stderr: '', then: { autoMergeRequest: { enabledAt: '2026-11-18T10:00:00Z' } } })
  expect(calls(ran)).toEqual([VIEW, CHECKS, VIEW, MERGE, VIEW, 'merge 540 -R o/r --disable-auto'])
  // Not said to be GitHub's doing alone: someone else may have turned it on.
  expect(await seen(pane, /auto-merge was on instead of a merge \(GitHub turns it on where it cannot merge yet, or someone else turned it on\); it was switched off\. Nothing was merged/)).not.toContain('MISSING')
  expect(await pane.find({ key: 'ship' })).toBeDefined()
  await pane.unmount()
})

test('a merge call that did not finish, with the pull request still open, says the outcome is not known yet', { options: { owner_workflow: true } }, async ($, on) => {
  const { pane, ran } = await mergeOnce($, on, { exitCode: 0, stderr: '', then: {}, isTimeout: true })
  expect(calls(ran)).toEqual([VIEW, CHECKS, VIEW, MERGE, VIEW])
  expect(await seen(pane, /did not finish.*GitHub may still merge it.*not known yet\. Look on GitHub before pressing again/)).not.toContain('MISSING')
  expect(await seen(pane, /Nothing was merged/)).toContain('MISSING')
  await pane.unmount()
})

test('a pull request merged at another head after the merge call failed is said so, with the head GitHub merged', { options: { owner_workflow: true } }, async ($, on) => {
  const { pane } = await mergeOnce($, on, { exitCode: 1, stderr: 'Head branch was modified', then: { state: 'MERGED', headRefOid: 'head999' } })
  expect(await seen(pane, /merged at head999, not at head540 as you confirmed.*Head branch was modified/)).not.toContain('MISSING')
  await pane.unmount()
})

test('a merge call that timed out after GitHub took it is read back: merged is said merged', { options: { owner_workflow: true } }, async ($, on) => {
  const { pane, ran } = await mergeOnce($, on, { exitCode: 124, stderr: 'timed out', then: { state: 'MERGED' } })
  expect(calls(ran)).toEqual([VIEW, CHECKS, VIEW, MERGE, VIEW])
  expect(await seen(pane, /Its required checks passed: merged at head540/)).not.toContain('MISSING')
  await pane.unmount()
})

test('a merge call whose outcome cannot be read back says the state is unknown', { options: { owner_workflow: true } }, async ($, on) => {
  const { pane } = await mergeOnce($, on, { exitCode: 124, stderr: 'timed out', then: null })
  expect(await seen(pane, /timed out.*whether it merged is unknown/)).not.toContain('MISSING')
  await pane.unmount()
})

test('a merge call GitHub refused, with the pull request still open, says so', { options: { owner_workflow: true } }, async ($, on) => {
  const { pane } = await mergeOnce($, on, { exitCode: 1, stderr: 'Head branch was modified', then: {} })
  expect(await seen(pane, /the merge failed: Head branch was modified\. Nothing was merged/)).not.toContain('MISSING')
  await pane.unmount()
})

test('a merge when green whose session ended with the process is shown cancelled in the next one', { options: { owner_workflow: true } }, async ($, on) => {
  const left = { pull: 540, repo: 'o/r', session: 's0', step: 'failed', note: 'Merge when green on PR o/r#540 was cancelled: the session was closed before it merged, so nothing was merged. Press again to go on.', head: 'head540', base: 'dev' }
  const { store, toasts } = await world($, on, { repo: 'o/r', numbers: [507] }, { 'ship-cancelled': left })
  await start($)

  const pane = await $.ui.mount(PANE)

  await pane.press({ key: 't507' })
  expect(await seen(pane, /PR o\/r#540 was cancelled.*nothing was merged/)).not.toContain('MISSING')
  expect(await pane.find({ key: 'ship' })).toBeDefined()
  expect(toasts).toEqual([left.note])
  expect(store['ship-cancelled']).toBeUndefined()
  await pane.unmount()
})

test('a session end whose writes were cut off leaves nothing shown at work: the next session says it stopped, and it can be pressed again', { options: { owner_workflow: true } }, async ($, on) => {
  let isCutOff = false
  let before: unknown = null
  // The end's time bound aborts its writes in flight: the ship state keeps what it held.
  const cutOff = (hook: On) =>
    hook('state.set', ((_: unknown, e: { key?: string; value?: unknown }, next: (e: unknown) => unknown) => {
      if (e.key !== 'ship') {
        return next(e)
      }

      before = isCutOff ? before : e.value

      return next(isCutOff ? { ...e, value: before } : e)
    }) as never)
  const { clock, ran, store, pane } = await pressed($, on, cutOff)

  isCutOff = true
  session.id = 's2'
  await $.session.end(END())
  delete store['ship-cancelled']
  isCutOff = false
  expect(await seen(pane, /Keep this session open until then/)).not.toContain('MISSING')
  await clock.advance(30_000)
  await progress($, '')
  expect(calls(ran)).toEqual([VIEW, 'ready 540 -R o/r'])
  expect(await seen(pane, /Interrupted: it was no longer at work/)).not.toContain('MISSING')
  expect(await pane.find({ key: 'ship' })).toBeDefined()
  await pane.unmount()
})

test('a cancelled note is shown only on its own repository’s PR, names that repository, and is said when its own session comes back in a new process', { options: { owner_workflow: true } }, async ($, on) => {
  const note = 'Merge when green on PR x/y#540 was cancelled: the session was closed before it merged, so nothing was merged. Press again to go on.'
  const left = { pull: 540, repo: 'x/y', session: 's1', step: 'failed', note, head: 'head540', base: 'dev' }
  // Pressed in s1, which was closed; `claude --continue` brings s1 back in a new process.
  const { clock, store, toasts } = await world($, on, { repo: 'o/r', numbers: [507] }, { 'ship-cancelled': left })
  await start($)
  await clock.advance(0)

  const pane = await $.ui.mount(PANE)

  // Told once, by repository; o/r#540 is another PR and keeps its button.
  await pane.press({ key: 't507' })
  expect(toasts).toEqual([note])
  expect(store['ship-cancelled']).toBeUndefined()
  expect(await seen(pane, /x\/y#540 was cancelled/)).toContain('MISSING')
  expect(await seen(pane, /^merge when green$/)).not.toContain('MISSING')

  // Not said again in a later session.
  session.id = 's2'
  await $.session.end(END())
  await progress($, '')
  expect(toasts).toEqual([note])
  await pane.unmount()
})

test('a cancelled note in an older shape is let go when read, and nothing is said', { options: { owner_workflow: true } }, async ($, on) => {
  // Written before notes named their repository.
  const old = { pull: 540, session: 's0', step: 'failed', note: 'Merge when green on PR #540 was cancelled.', head: 'head540', base: 'dev' }
  const { clock, store, toasts } = await world($, on, { repo: 'o/r', numbers: [507] }, { 'ship-cancelled': old })
  await start($)
  await clock.advance(0)
  expect(toasts).toEqual([])
  expect(store['ship-cancelled']).toBeUndefined()
})

test('a goal naming two repositories is refused, and the goal held stays', { options: { owner_workflow: true } }, async ($, on) => {
  const refused = { refused: 'A goal is in one repository: o/first#12 and o/second#13 name two. Name the issues of one.' }
  const { store } = await world($, on, { repo: 'o/r', numbers: [507] })
  await start($)
  const said = await progress($, 'goal o/first#12 o/second#13')

  expect('text' in said ? said.text : '').toBe(refused.refused)
  expect(store['goal:s1']).toEqual({ repo: 'o/r', numbers: [507] })
})

test('#155: a fold survives a restart', { options: { owner_workflow: true } }, async ($, on) => {
  const { clock } = await world($, on, { repo: 'o/r', numbers: [511, 512, 513, 514, 510], sections: { ready: 'closed', yours: 'closed' } })
  await start($)
  await clock.advance(0)
  const pane = await $.ui.mount(PANE)

  expect(await pane.find({ type: 'Button', text: /#514 Docs/ })).toBeUndefined()
  expect(await pane.find({ type: 'Button', text: /#511 Scorer/ })).toBeUndefined()
  expect(await pane.find({ type: 'Button', text: /#512 Dataset/ })).toBeDefined()
})

test('drawing the pane again with the same dashboard line leaves its expiry as it was; a newer line moves it', { options: { owner_workflow: true } }, async ($, on) => {
  // Each timer the plugin arms, as the mocked clock is asked for it.
  const armed: unknown[] = []
  const register = on as unknown as (...args: unknown[]) => unknown
  const counting = ((name: string, ...rest: unknown[]) => {
    const handler = rest.at(-1)

    if (name !== 'clock.after' || typeof handler !== 'function') {
      return register(name, ...rest)
    }

    return register(name, ...rest.slice(0, -1), (...args: unknown[]) => {
      armed.push(args[1])
      return handler(...args)
    })
  }) as unknown as typeof on
  const { clock } = await world($, counting)
  let published: unknown = stamped('dashboard: on · replies: on')
  on('state.get', DASHBOARD_LINE, () => ({ value: { value: published, version: 1 } }))
  await start($)
  const ui = await $.ui.mount(PANE)
  const expiries = () => armed.filter(e => JSON.stringify(e).includes('150000')).length
  expect(expiries()).toBe(1)

  await ui.redraw(PANE.props)
  await ui.redraw(PANE.props)
  expect(expiries()).toBe(1)

  // A newer reading, 60 s on: its line stands 150 s from then.
  await clock.advance(60_000)
  published = stamped('dashboard: on · replies: on', NOW + 60_000)
  await ui.redraw(PANE.props)
  expect(expiries()).toBe(2)

  await clock.advance(149_999)
  expect((await ui.find({ type: 'Text', text: /^dashboard: / }))?.text).toBe('dashboard: on · replies: on')
  await clock.advance(1)
  expect(await ui.find({ type: 'Text', text: /^dashboard: / })).toBeUndefined()
  await ui.unmount()
})
