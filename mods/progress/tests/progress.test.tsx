import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Agent, Pull, Round, Ticket } from '../types'
import { asGitHub } from './github-shape'

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
            issue(510, 'Fixtures', {
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

/** #507 as GITHUB has it, with no sub-issues: the tests that name it mean one issue. #198 brings sub-issues in, so a test that wants them reads GITHUB. */
const SOLO = JSON.stringify((() => { const data = JSON.parse(GITHUB); delete data.data.repository.i507.subIssues; return data })())
/** `data` (parsed GITHUB) without #507's sub-issues, once the test has taken the rows it wants from them. */
const withoutSubs = (data: any) => { delete data.data.repository.i507.subIssues; return JSON.stringify(data) }

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
  store: null as { key: string; until: Promise<void>; reached?: () => void } | null,
  /** Set, every `$.env.get` waits on it: a decision-log write held before it reads anything else. */
  env: null as Promise<void> | null,
}
/** The session the engine is in: a test changes it as a /clear or a resume would. */
const session = { id: 's1' }
const refusedWrites = new Set<string>()
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
const VIEW = 'view'
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
  refusedWrites.clear()
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
  github.answer = SOLO
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
      held.store.reached?.()
      await held.store.until
    }

    if (store[e.key] instanceof Error) throw store[e.key]
    return { value: store[e.key] }
  })
  on('store.set', (_, e) => {
    if (refusedWrites.has(e.key)) throw new Error('snapshot store unavailable')
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
    const answer = asGitHub(JSON.parse(github.answer), asked)
    const missingIssue = [...asked.matchAll(/\bi(\d+): issue\(/g)].find(([, number]) => answer.data.repository[`i${number}`]?.__typename === 'PullRequest')
    if (missingIssue) return { value: { ...run(JSON.stringify({ ...answer, errors: [{ type: 'NOT_FOUND', path: ['repository', `i${missingIssue[1]}`] }] })), exitCode: 1 } }

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
  const commands: { name: string; argumentHint?: string }[] = []
  on('command.register', (_, e) => { commands.push(e as never); return { value: { command: e.name } } })
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

  return { clock, ran, times, store, toasts, opened, tools, commands }
}

function start($: Engine) {
  return $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
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

test('#165 ordinary tool and turn activity does not enroll, publish or open Progress', async ($, on) => {
  const { clock, store, ran, opened } = await world($, on)
  await start($)
  await $.turn.start({ turnId: 'quiet', text: 'Read issue #7 and create a PR.' })
  await $.tool.call({ tool: 'Bash', command: 'gh issue create -t x -b y' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --draft --fill' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Reading issues', description: 'ordinary work' })
  await clock.advance(200_000)
  expect(store['goal:s1']).toBeUndefined()
  expect(store['overview:s1']).toBeUndefined()
  expect(ran).toEqual([])
  expect(opened).toEqual([])
})


test('#165 an agent explicitly enrolls an issue and gets the same public snapshot as the native pane', async ($, on) => {
  const { store, tools } = await world($, on)
  await start($)
  const result = await $.tool.call({ tool: 'mcp__progress__enroll', issues: '507' })
  expect(result.isError).not.toBe(true)
  expect(tools.map((one: any) => one.name)).toEqual(['enroll', 'publish', 'open', 'hide'])
  const published = store['overview:s1'] as any
  expect(published.session_id).toBe('s1')
  expect(published.version).toBe(1)
  expect(published.goal.numbers).toEqual([507])
  expect(published.view.total).toBe(1)
  expect(published.view.completed).toBe(0)
  expect(published.view.sections.flatMap((one: any) => one.tickets.map((ticket: any) => ticket.number))).toEqual([507])
  const pane = await $.ui.mount(PANE)
  expect(await seen(pane, /#507 Eval redesign/)).not.toContain('MISSING')
  expect(await seen(pane, /0\/1/)).not.toContain('MISSING')
  await pane.unmount()
})

test('#203 every Progress tool answers with text the engine accepts, not an object', async ($, on) => {
  await world($, on)
  await start($)
  const enrolled = await $.tool.call({ tool: 'mcp__progress__enroll', issues: '507' })
  const published = await $.tool.call({ tool: 'mcp__progress__publish', session_id: 's1', repo: 'o/r', summary: 'Shape check' })
  const opened = await $.tool.call({ tool: 'mcp__progress__open' })
  const hidden = await $.tool.call({ tool: 'mcp__progress__hide' })
  for (const answer of [enrolled, published, opened, hidden]) {
    expect(answer.deny).toBeUndefined()
    expect(typeof answer.result).toBe('string')
  }
  expect(published.result).toBe('Progress reported for s1.')
  expect(hidden.result).toBe('Progress hidden; refresh paused.')
})

test('#165 explicitly selected parent and child retain hierarchy: since #198 the parent is the heading over the child', async ($, on) => {
  const { store, ran } = await world($, on)
  const data = JSON.parse(GITHUB)
  data.data.repository.i511 = { ...data.data.repository.i507.subIssues.nodes[0], parent: { number: 507 } }
  github.answer = withoutSubs(data)
  await start($)
  await $.tool.call({ tool: 'mcp__progress__enroll', issues: '507 511' })
  const published = store['overview:s1'] as any
  expect(published.goal.numbers).toEqual([507, 511])
  // #198: a parent with a sub-issue in the goal is its heading, not counted (pre-#168 style).
  expect(published.goal.tickets.map((one: any) => [one.number, one.parent])).toEqual([[511, 507]])
  expect(published.goal.heads.map((one: any) => one.number)).toEqual([507])
  expect(published.view.total).toBe(1)
  expect(published.view.sections.map((one: any) => [one.id, one.tickets.map((ticket: any) => ticket.number)])).toEqual([['yours', [511]]])
  const pane = await $.ui.mount(PANE)
  expect(await seen(pane, /#507 Eval redesign/)).not.toContain('MISSING')
  expect(await seen(pane, /#511 Scorer contract in #507/)).not.toContain('MISSING')
  expect(await seen(pane, /0\/1/)).not.toContain('MISSING')
  await pane.unmount()
  expect(ran.some(one => /parent\s*\{\s*number\s*\}/.test(one.at(-1) ?? ''))).toBe(true)
  expect(ran.every(one => !one.at(-1)?.includes('issueOrPullRequest('))).toBe(true)
})

/** #198: enrolling a parent enrolls its sub-issues, and only those. */
const sub = (number: number, title: string, more: Record<string, unknown> = {}) => issue(number, title, { parent: { number: 1 }, ...more })
const parentWith = (children: Record<string, unknown>[], more: Record<string, unknown> = {}) => ({ ...issue(1, 'Parent'), subIssues: { totalCount: children.length, nodes: children }, ...more })
const answerWith = (rows: Record<string, unknown>) => JSON.stringify({ data: { repository: rows } })
const numbersOf = (store: Record<string, unknown>) => ((store['overview:s1'] as any).goal.tickets as any[]).map(one => [one.number, one.parent])
/** The goal's headings: issues with sub-issues in the goal, shown over them and not counted (pre-#168 style). */
const headsOf = (store: Record<string, unknown>) => ((store['overview:s1'] as any).goal.heads as any[]).map(one => [one.number, one.parent])

test('#198 enrolling a parent enrolls its sub-issues under it as a heading, through the command and the tool', async ($, on) => {
  const { store, ran } = await world($, on)
  github.answer = answerWith({ i1: parentWith([sub(2, 'Child A'), sub(3, 'Child B')]) })
  await start($)
  await progress($, 'goal 1')
  expect(headsOf(store)).toEqual([[1, null]])
  expect(numbersOf(store)).toEqual([[2, 1], [3, 1]])
  expect((store['goal:s1'] as any).numbers).toEqual([1])
  // The heading is not counted; its sub-issues are.
  expect((store['overview:s1'] as any).view.total).toBe(2)
  expect(ran.some(one => one.at(-1)?.includes('subIssues('))).toBe(true)
  await progress($, 'clear')
  await $.tool.call({ tool: 'mcp__progress__enroll', issues: '1' })
  expect(headsOf(store)).toEqual([[1, null]])
  expect(numbersOf(store)).toEqual([[2, 1], [3, 1]])
})

test('#198 a named parent with no sub-issues is a counted ticket, not a heading', async ($, on) => {
  const { store } = await world($, on)
  github.answer = answerWith({ i1: parentWith([]) })
  await start($)
  await progress($, 'goal 1')
  expect(headsOf(store)).toEqual([])
  expect(numbersOf(store)).toEqual([[1, null]])
  expect((store['overview:s1'] as any).view.total).toBe(1)
})

test('#198 sub-issues of sub-issues are enrolled too', async ($, on) => {
  const { store } = await world($, on)
  const deep = sub(2, 'Child', { subIssues: { totalCount: 1, nodes: [{ number: 3 }] } })
  github.answer = answerWith({ i1: parentWith([deep]), i3: issue(3, 'Grandchild') })
  await start($)
  await progress($, 'goal 1')
  expect(headsOf(store)).toEqual([[1, null], [2, 1]])
  expect(numbersOf(store)).toEqual([[3, 2]])
})

test('#198 refresh adds a sub-issue attached later and drops one detached, but keeps one named too', async ($, on) => {
  const { store } = await world($, on)
  github.answer = answerWith({ i1: parentWith([sub(2, 'A'), sub(3, 'B')]), i3: sub(3, 'B') })
  await start($)
  await progress($, 'goal 1 3')
  expect(headsOf(store).map(one => one[0])).toEqual([1])
  expect(numbersOf(store).map(one => one[0])).toEqual([3, 2])
  github.answer = answerWith({ i1: parentWith([sub(4, 'C')]), i3: issue(3, 'B') })
  await progress($, 'refresh')
  expect(headsOf(store).map(one => one[0])).toEqual([1])
  expect(numbersOf(store).map(one => one[0]).sort()).toEqual([3, 4])
})

test('#198 removing a parent removes the children that came only through it; an explicit child stays', async ($, on) => {
  const { store } = await world($, on)
  github.answer = answerWith({ i1: parentWith([sub(2, 'A'), sub(3, 'B')]), i3: sub(3, 'B') })
  await start($)
  await progress($, 'goal 1 3')
  await progress($, 'remove 1')
  expect(headsOf(store)).toEqual([])
  expect(numbersOf(store)).toEqual([[3, 1]])
  expect((store['goal:s1'] as any).numbers).toEqual([3])
})

test('#198 a sub-issue removed by name stays out through a refresh', async ($, on) => {
  const { store } = await world($, on)
  github.answer = answerWith({ i1: parentWith([sub(2, 'A'), sub(3, 'B')]) })
  await start($)
  await progress($, 'goal 1')
  await progress($, 'remove 2')
  await progress($, 'refresh')
  expect(headsOf(store).map(one => one[0])).toEqual([1])
  expect(numbersOf(store).map(one => one[0])).toEqual([3])
})

test('#198 a heading whose last sub-issue is removed is a counted ticket again at once', async ($, on) => {
  const { store } = await world($, on)
  github.answer = answerWith({ i1: parentWith([sub(2, 'A')]) })
  await start($)
  await progress($, 'goal 1')
  expect(headsOf(store).map(one => one[0])).toEqual([1])
  await progress($, 'remove 2')
  expect(headsOf(store)).toEqual([])
  expect(numbersOf(store)).toEqual([[1, null]])
  expect((store['overview:s1'] as any).view.total).toBe(1)
})

test('#198 a sub-issue in another repository is skipped, with a note in the goal title', async ($, on) => {
  const { store } = await world($, on)
  github.answer = answerWith({ i1: parentWith([sub(2, 'Here', { repository: { nameWithOwner: 'O/R' } }), sub(9, 'There', { repository: { nameWithOwner: 'x/y' } })]) })
  await start($)
  await progress($, 'goal 1')
  expect(headsOf(store).map(one => one[0])).toEqual([1])
  expect(numbersOf(store).map(one => one[0])).toEqual([2])
  expect((store['overview:s1'] as any).goal.title).toContain('1 sub-issue in another repository skipped')
})

test('#198 the 200-issue cap holds: explicit issues first, the rest of the sub-issues left out and said', async ($, on) => {
  const { store } = await world($, on)
  const kids = (from: number) => Array.from({ length: 100 }, (_, at) => sub(from + at, `K${from + at}`))
  github.answer = answerWith({ i1: parentWith(kids(10)), i2: { ...issue(2, 'P2'), subIssues: { totalCount: 100, nodes: kids(200) } }, i3: { ...issue(3, 'P3'), subIssues: { totalCount: 100, nodes: kids(400) } } })
  await start($)
  await progress($, 'goal 1 2 3')
  // Headings and tickets together: 200 issues are read. #3's sub-issues are all over the cap, so #3 is a counted ticket.
  expect(headsOf(store).map(one => one[0])).toEqual([1, 2])
  expect(numbersOf(store).length).toBe(198)
  expect(numbersOf(store)[0]).toEqual([3, null])
  expect((store['overview:s1'] as any).goal.title).toContain('103 sub-issues not shown: over 200 issues')
})

test('#198 a heading is drawn over the counted rows, and a sub-issue row says the heading it is in, as the web view does', async ($, on) => {
  const { store } = await world($, on)
  github.answer = answerWith({ i1: parentWith([sub(2, 'Child A'), sub(3, 'Child B')]), i4: issue(4, 'Other') })
  await start($)
  await progress($, 'goal 1 4')
  const published = store['overview:s1'] as any
  expect(published.goal.heads.map((one: any) => one.number)).toEqual([1])
  expect(published.view.sections[0].tickets.map((one: any) => one.number)).toEqual([4, 2, 3])
  const pane = await $.ui.mount(PANE)
  expect(await seen(pane, /#1 Parent/)).not.toContain('MISSING')
  expect(await seen(pane, /#2 Child A in #1/)).not.toContain('MISSING')
  expect(await seen(pane, /#4 Other in #/)).toContain('MISSING')
  expect(await seen(pane, /0\/3/)).not.toContain('MISSING')
  await pane.unmount()
})

test('#198 a mention in a ticket does not enroll anything', async ($, on) => {
  const { store } = await world($, on)
  github.answer = answerWith({ i1: issue(1, 'Solo', { body: 'See #2 and blocked by #3' }), i2: issue(2, 'Other') })
  await start($)
  await progress($, 'goal 1')
  expect(numbersOf(store)).toEqual([[1, null]])
})

test('#165 parent metadata never enrolls relatives and survives a cached native resume', async ($, on) => {
  const { store, ran } = await world($, on)
  const data = JSON.parse(GITHUB)
  data.data.repository.i511 = { ...data.data.repository.i507.subIssues.nodes[0], parent: { number: 507 } }
  github.answer = withoutSubs(data)
  await start($)
  await progress($, 'goal 507')
  expect((store['overview:s1'] as any).goal.tickets.map((one: any) => one.number)).toEqual([507])
  expect((store['overview:s1'] as any).view.total).toBe(1)
  await progress($, 'goal 511')
  const published = store['overview:s1'] as any
  expect(published.goal.numbers).toEqual([511])
  expect(published.goal.tickets.map((one: any) => [one.number, one.parent])).toEqual([[511, 507]])
  expect(published.goal.heads).toEqual([])
  expect(published.view.total).toBe(1)
  expect(published.view.sections[0].tickets[0].parent).toBe(507)
  // Offline resume must validate and display the last published parent metadata.
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
  github.answer = JSON.stringify({ errors: [{ message: 'offline' }] })
  const beforeResume = ran.length
  await start($)
  await progress($, '')
  const pane = await $.ui.mount(PANE)
  expect(await seen(pane, /#511 Scorer contract/)).not.toContain('MISSING')
  expect(await seen(pane, /#507 Eval redesign/)).toContain('MISSING')
  expect(await seen(pane, /0\/1/)).not.toContain('MISSING')
  await pane.unmount()
  expect((store['overview:s1'] as any).goal.tickets[0].parent).toBe(507)
  const resumed = ran.slice(beforeResume).map(one => one.at(-1) ?? '').join('\n')
  expect(resumed).not.toContain('i507: issue(')
})

test('#165 a PR number or URL cannot replace an existing explicit issue goal', async ($, on) => {
  const { store } = await world($, on)
  await start($)
  await progress($, 'goal 507')
  github.answer = JSON.stringify({ data: { repository: { i24: { ...pull(24, 'OPEN', true, 'feat/24-x'), title: 'PR', url: 'https://github.com/o/r/pull/24' } } } })
  const rejected = await $.tool.call({ tool: 'mcp__progress__enroll', issues: '24' })
  expect(rejected.deny).toBeDefined()
  expect((store['goal:s1'] as any).numbers).toEqual([507])
  await progress($, 'goal https://github.com/o/r/pull/24')
  expect((store['goal:s1'] as any).numbers).toEqual([507])
})

test('#165 completion follows closed issues, including not planned; an old merged PR never completes a reopened issue', async ($, on) => {
  const { store, ran } = await world($, on)
  github.answer = JSON.stringify({ data: { repository: {
    i1: issue(1, 'Reopened', { stateReason: 'REOPENED', closedByPullRequestsReferences: { nodes: [pull(101, 'MERGED', false, 'feat/1-done', null, { baseRefName: 'main' })] } }),
    i2: issue(2, 'Done', { state: 'CLOSED', stateReason: 'COMPLETED' }),
    i3: issue(3, 'No longer planned', { state: 'CLOSED', stateReason: 'NOT_PLANNED' }),
  } } })
  await start($)
  await progress($, 'goal 1 2 3')
  const result = store['overview:s1'] as any
  expect(result.view.total).toBe(3)
  expect(result.view.completed).toBe(2)
  expect(result.view.sections.find((one: any) => one.id === 'shipped').tickets.map((one: any) => one.number)).toEqual([2, 3])
  const pane = await $.ui.mount(PANE)
  expect(await seen(pane, /2\/3/)).not.toContain('MISSING')
  expect(await seen(pane, /#1 Reopened.*merged #101/)).not.toContain('MISSING')
  expect(ran.every(one => !one.at(-1)?.includes('issueOrPullRequest('))).toBe(true)
  await pane.unmount()
})

test('#165 explicit activity and reviews are reported, timestamped and retained without inferred round-4 tasks', async ($, on) => {
  const { clock, store, ran } = await world($, on)
  await start($)
  await $.tool.call({ tool: 'mcp__progress__enroll', issues: '507' })
  await clock.advance(1000)
  const result = await $.tool.call({ tool: 'mcp__progress__publish', session_id: 's1', repo: 'o/r', summary: 'Implementing selected issue', working: true,
    steps: [{ id: 'tests', text: 'Verify explicit enrollment', status: 'in_progress' }],
    agents: [{ id: 'worker', type: 'implementer', what: 'Explicit contract', ticket: 507, status: 'working' }],
    marks: [{ key: 'tests', kind: 'check', text: '4 tests passed', isBad: false }],
    reviews: [1, 2, 3, 4].map(n => ({ pr: 540, key: `540:explicit-${n}` })),
  })
  expect(result.deny).toBeUndefined()
  const published = store['overview:s1'] as any
  expect(published.activity.reportedAt).toBe(NOW + 1000)
  expect(published.activity.agents[0].ticket).toBe(507)
  expect(published.activity.rounds.length).toBe(4)
  const pane = await $.ui.mount(PANE)
  expect(await seen(pane, /round 4/)).not.toContain('MISSING')
  expect(await seen(pane, /Explicit contract/)).not.toContain('MISSING')
  await clock.advance(180_000)
  const after = store['overview:s1'] as any
  expect(after.activity.reportedAt).toBe(NOW + 1000)
  expect(after.activity.agents[0].activeAt).toBe(NOW + 1000)
  expect(after.at).toBeGreaterThan(published.at)
  expect(ran.every(one => one[0] === 'gh')).toBe(true)
  await pane.unmount()
})

test('#165 legacy inferred additions wait for deliberate import and the original goal record is preserved', async ($, on) => {
  const original = { repo: 'o/r', numbers: [507, 511, 24], added: [511, 24], sections: { ready: 'closed' } }
  const { store, ran } = await world($, on, original)
  const data = JSON.parse(GITHUB)
  data.data.repository.i511 = data.data.repository.i507.subIssues.nodes[0]
  data.data.repository.i24 = { __typename: 'PullRequest' }
  github.answer = withoutSubs(data)
  await start($)
  expect(ran).toEqual([])
  await progress($, '')
  expect((store['overview:s1'] as any).goal.numbers).toEqual([507])
  expect(store['goal:s1']).toEqual(original)
  const imported = await progress($, 'import')
  expect('text' in imported ? imported.text : '').toContain('Imported 1 issue')
  expect((store['goal:s1'] as any).numbers).toEqual([507, 511])
  expect(store['legacy-goal:s1']).toEqual(original)
  expect((store['overview:s1'] as any).view.total).toBe(2)
})

test('#165 resuming restores only that session reports and review counts; another session cannot publish under its id', async ($, on) => {
  const { store } = await world($, on)
  await start($)
  await $.tool.call({ tool: 'mcp__progress__enroll', issues: '507' })
  await $.tool.call({ tool: 'mcp__progress__publish', session_id: 's1', repo: 'o/r', summary: 'Saved explicit report', reviews: [{ pr: 540, key: '540:a' }] })
  const first = store['overview:s1']
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
  session.id = 's2'
  await progress($, '')
  expect((store['overview:s2'] as any).goal).toBe(null)
  expect((store['overview:s2'] as any).activity.goal).toBe('')
  const stale = await $.tool.call({ tool: 'mcp__progress__publish', session_id: 's1', repo: 'o/r', summary: 'Wrong session' })
  expect(stale.deny).toBeDefined()
  expect(store['overview:s1']).toEqual(first)
  await $.session.end({ reason: 'resume', sessionId: 's2', resume: { id: 's2' } })
  session.id = 's1'
  refusedWrites.clear()
  await progress($, '')
  expect((store['overview:s1'] as any).activity.goal).toBe('Saved explicit report')
  expect((store['overview:s1'] as any).activity.rounds.length).toBe(1)
})

test('#165 hide pauses all metadata refresh until an explicit reopen; idle stamps and failed refreshes preserve report freshness', async ($, on) => {
  const { clock, store, ran, opened } = await world($, on)
  await start($)
  await progress($, 'goal 507')
  const before = store['overview:s1'] as any
  await $.tool.call({ tool: 'mcp__progress__hide' })
  const callsBefore = ran.length
  await clock.advance(540_000)
  expect(ran.length).toBe(callsBefore)
  expect(store['overview:s1']).toEqual(before)
  const opens = opened.length
  await $.tool.call({ tool: 'Bash', command: 'gh issue create -t x -b y' })
  expect(opened.length).toBe(opens)
  github.isCut = true
  await progress($, 'refresh')
  const after = store['overview:s1'] as any
  expect(after.goal.tickets.map((one: any) => one.number)).toEqual([507])
  expect(after.goal.error).toContain('cut')
  expect(after.goal.fetchedAt).toBe(before.goal.fetchedAt)
  expect(after.activity.at).toBe(before.activity.at)
})

test('#165 invalid explicit reports leave the last good public snapshot unchanged', async ($, on) => {
  const { store } = await world($, on)
  await start($)
  await progress($, 'goal 507')
  const initial = store['overview:s1']
  for (const invalid of [
    { session_id: 'other' }, { repo: 'other/repo' }, { working: 'true' },
    { summary: 'x'.repeat(241) }, { steps: Array(101).fill({}) },
    { steps: [{ id: 'x', text: 'test', status: 'unknown' }] },
    { agents: [{ id: 'x', type: 'worker', what: 'work', ticket: 511, status: 'working' }] },
    { agents: [{ id: 'x', type: 'worker', what: 'work', ticket: 507, status: 'working', injected: 'field' }] },
    { marks: [{ key: 'x', kind: 'check', text: 'tested', isBad: 'false' }] },
    { reviews: [{ pr: 1.5, key: 'fractional' }] },
    { reviews: [{ pr: 9007199254740992, key: 'unsafe' }] },
  ]) {
    const rejected = await $.tool.call({ tool: 'mcp__progress__publish', session_id: 's1', repo: 'o/r', ...invalid })
    expect(rejected.deny).toBeDefined()
    expect(store['overview:s1']).toEqual(initial)
  }
})

test('#165 a goal read failure in a new session cannot carry the previous goal or reports', async ($, on) => {
  const { store } = await world($, on)
  await start($)
  await progress($, 'goal 507')
  await $.tool.call({ tool: 'mcp__progress__publish', session_id: 's1', repo: 'o/r', summary: 'Private to s1' })
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  session.id = 's2'
  store['goal:s2'] = new Error('store unavailable')
  store['review:s2'] = new Error('store unavailable')
  await progress($, '')
  const after = store['overview:s2'] as any
  expect(after.goal).toBe(null)
  expect(after.activity.goal).toBe('')
  expect(after.activity.rounds).toEqual([])
})

const realWait = (ms: number) => new Promise<void>(resolve => (globalThis as unknown as { setTimeout: (done: () => void, ms: number) => void }).setTimeout(resolve, ms))

test('#165 concurrent explicit enrollments keep both issues', async ($, on) => {
  const { store } = await world($, on)
  const answer = JSON.parse(GITHUB)
  answer.data.repository.i511 = answer.data.repository.i507.subIssues.nodes[0]
  github.answer = JSON.stringify(answer)
  await start($)
  const results = await Promise.all([
    $.tool.call({ tool: 'mcp__progress__enroll', issues: '507' }),
    $.tool.call({ tool: 'mcp__progress__enroll', issues: '511' }),
  ])
  expect(results.every(one => one.deny === undefined)).toBe(true)
  expect((store['overview:s1'] as any).goal.numbers).toEqual([507, 511])
})

test('#165 Overview opens the task-owner bridge then Progress without enrolling anything', async ($, on) => {
  const { store, opened } = await world($, on)
  const taskOpens: number[] = []
  on('tool.call', { tool: 'mcp__human-in-the-loop__open_tasks' }, () => { taskOpens.push(opened.length); return { result: 'My tasks opened.' } })
  await start($)
  const result = await $.command.run({ command: 'overview', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect('text' in result ? result.text : '').toContain('Progress')
  expect(taskOpens).toEqual([0])
  expect(opened.length).toBe(1)
  expect(store['goal:s1']).toBeUndefined()
})

const overview = ($: Engine, args: string) => $.command.run({ command: 'overview', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }).then(done => ('text' in done ? done.text : ''))

/** Stands in for human-in-the-loop's dashboard tool: each action asked is recorded, and answered with `answer`. */
function fakeDashboard(on: On, answer: { text?: string; address?: string; deny?: string }) {
  const asked: unknown[] = []
  on('tool.call', { tool: 'mcp__human-in-the-loop__dashboard' }, (_, e) => {
    asked.push((e as unknown as { action: string }).action)
    return answer.deny === undefined ? { result: [{ type: 'text' as const, text: answer.text ?? '' }, ...(answer.address === undefined ? [] : [{ type: 'text' as const, text: answer.address }])] } : { deny: answer.deny }
  })
  return asked
}

test('#167 /overview is the one command: /dash is not registered, and the hint names every action', async ($, on) => {
  const { tools, commands } = await world($, on)
  await start($)
  expect(commands.map(one => one.name)).toEqual(['overview', 'progress'])
  expect(commands[0]?.argumentHint).toBe('[progress | tasks | usage | web | start | stop]')
  expect((commands[0] as { description?: string } | undefined)?.description).toBe('Overview: Progress, My tasks and Usage in native tabs')
  expect(tools.length).toBeGreaterThan(0)
})

test('#167 /overview web says how the dashboard stands, as human-in-the-loop words it', async ($, on) => {
  await world($, on)
  const asked = fakeDashboard(on, { text: 'dashboard: on · replies: off (x)\nOpen http://box:6767 in a browser.', address: 'http://box:6767' })
  await start($)
  expect(await overview($, 'web')).toBe('dashboard: on · replies: off (x)\nOpen http://box:6767 in a browser.')
  expect(asked).toEqual(['status'])
})

test('#167 /overview start and stop run the dashboard and say what came of it, refusals as they are', async ($, on) => {
  await world($, on)
  const asked = fakeDashboard(on, { text: 'The dashboard is not set up: its config file is missing (dashboard/README.md, Install, step 1). Nothing was run.' })
  await start($)
  expect(await overview($, 'start')).toBe('The dashboard is not set up: its config file is missing (dashboard/README.md, Install, step 1). Nothing was run.')
  expect(await overview($, ' stop ')).toContain('not set up')
  expect(asked).toEqual(['start', 'stop'])
})

/** The session's tools as `$.tool.list()` reads them: human-in-the-loop's dashboard tool among them when `hasDashboard`. */
function pool(on: On, hasDashboard: boolean) {
  const dashboardTool = { name: 'mcp__human-in-the-loop__dashboard', description: "The web dashboard's controls", mcp: true }
  on('tool.list', () => ({ value: [{ name: 'Bash', description: 'Runs a command', mcp: false }, ...(hasDashboard ? [dashboardTool] : [])] }))
}

test('#167 /overview web, start and stop say where the controls come from when human-in-the-loop is absent', async ($, on) => {
  await world($, on)
  pool(on, false)
  await start($)
  for (const action of ['web', 'start', 'stop']) expect(await overview($, action)).toBe('The dashboard controls come from human-in-the-loop; install or enable it.')
})

test('#167 /overview web, start and stop say the dashboard tool failed, not to install human-in-the-loop, when the tool is there and fails', async ($, on) => {
  await world($, on)
  pool(on, true)
  const answer: { isError?: true; text?: string; result?: unknown; isThrowing?: boolean } = { isError: true, text: 'Error: the helper\u0007 crashed', result: undefined }
  on('tool.call', { tool: 'mcp__human-in-the-loop__dashboard' }, () => {
    if (answer.isThrowing === true) throw new Error('the dashboard hook threw')
    return answer as never
  })
  await start($)
  for (const action of ['web', 'start', 'stop']) expect(await overview($, action)).toBe('The dashboard tool failed: Error: the helper crashed')
  // A hook that throws is skipped, so the call rejects as for an absent tool: the pool tells them apart.
  answer.isThrowing = true
  expect(await overview($, 'web')).toMatch(/^The dashboard tool failed: /)
  // An answer without its words.
  answer.isThrowing = false
  delete answer.isError
  delete answer.text
  answer.result = {}
  expect(await overview($, 'web')).toBe('The dashboard tool failed.')
})

test('#167 /overview web passes on a refusal of human-in-the-loop as it is', async ($, on) => {
  await world($, on)
  fakeDashboard(on, { deny: 'Only the main agent controls the dashboard.' })
  await start($)
  expect(await overview($, 'web')).toBe('Only the main agent controls the dashboard.')
})

test('#167 bare /overview adds the dashboard address when it runs, and nothing when it does not', async ($, on) => {
  const { opened } = await world($, on)
  on('tool.call', { tool: 'mcp__human-in-the-loop__open_tasks' }, () => ({ result: 'My tasks opened.' }))
  const answer: { text: string; address?: string } = { text: 'dashboard: on', address: 'http://box:6767' }
  const asked = fakeDashboard(on, answer)
  await start($)
  expect(await overview($, '')).toMatch(/^My tasks opened\. Progress: .*Web dashboard: http:\/\/box:6767$/)
  delete answer.address
  expect(await overview($, '')).not.toContain('Web dashboard')
  expect(await overview($, 'tasks')).toBe('My tasks opened.')
  expect(asked).toEqual(['status', 'status'])
  expect(opened.length).toBe(2)
})

test('#167 bare /overview opens My tasks and Progress at once, and replies within a second without the address when the dashboard status is slow', async ($, on) => {
  const { opened, clock } = await world($, on)
  const taskOpens: number[] = []
  on('tool.call', { tool: 'mcp__human-in-the-loop__open_tasks' }, () => { taskOpens.push(opened.length); return { result: 'My tasks opened.' } })
  // human-in-the-loop's status read answers only after 5 s (its own limit is 20 s).
  on('tool.call', { tool: 'mcp__human-in-the-loop__dashboard' }, async () => {
    await clock.sleep(5000)
    return { result: [{ type: 'text' as const, text: 'dashboard: on' }, { type: 'text' as const, text: 'http://box:6767' }] }
  })
  await start($)
  let replied: string | undefined
  void overview($, '').then(text => { replied = text })
  await clock.settle()

  expect(taskOpens).toEqual([0])
  expect(opened.length).toBe(1)

  await clock.advance(1000)

  expect(replied).toMatch(/^My tasks opened\. Progress: /)
  expect(replied).not.toContain('Web dashboard')
  await clock.advance(4000)
  expect(opened.length).toBe(1)
})

test('#165 a failed authoritative publication is reported and a later explicit retry succeeds', async ($, on) => {
  const { store } = await world($, on)
  await start($)
  await progress($, 'goal 507')
  const initial = store['overview:s1']
  refusedWrites.add('overview:s1')
  const failed = await $.tool.call({ tool: 'mcp__progress__publish', session_id: 's1', repo: 'o/r', summary: 'Explicit report needing persistence' })
  expect(failed.deny).toContain('store.set')
  expect(store['overview:s1']).toEqual(initial)
  refusedWrites.clear()
  const retry = await $.tool.call({ tool: 'mcp__progress__publish', session_id: 's1', repo: 'o/r', summary: 'Explicit report needing persistence' })
  expect(retry.deny).toBeUndefined()
  expect((store['overview:s1'] as any).activity.goal).toBe('Explicit report needing persistence')
})

test('#165 malformed saved reports cannot reach the renderer or a new authoritative snapshot', async ($, on) => {
  const { store } = await world($, on, { repo: 'o/r', numbers: [507] }, {
    'overview:s1': { version: 1, session_id: 's1', activity: { goal: 'malformed', isWorking: true, at: NOW, steps: [], agents: [{ id: 'broken' }], marks: [] } },
  })
  await start($)
  await progress($, '')
  expect((store['overview:s1'] as any).activity.agents).toEqual([])
  expect((store['overview:s1'] as any).activity.goal).toBe('')
  const pane = await $.ui.mount(PANE)
  expect(await seen(pane, /#507 Eval redesign/)).not.toContain('MISSING')
  await pane.unmount()
})

test('#165 an enrollment that finishes after a session change writes no goal or snapshot for either session', async ($, on) => {
  const { store } = await world($, on)
  await start($)
  let release = () => {}
  held.gate = new Promise<void>(resolve => { release = resolve })
  const pending = $.tool.call({ tool: 'mcp__progress__enroll', issues: '507' })
  await realWait(20)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  session.id = 's2'
  await progress($, '')
  const s2 = store['overview:s2']
  held.gate = null
  release()
  const refused = await pending
  expect(refused.deny).toBeDefined()
  expect(store['goal:s1']).toBeUndefined()
  expect(store['overview:s1']).toBeUndefined()
  expect(store['overview:s2']).toEqual(s2)
})

test('#165 concurrent explicit review reports preserve both declared rounds', async ($, on) => {
  const { store } = await world($, on)
  await start($)
  await progress($, 'goal 507')
  const results = await Promise.all([
    $.tool.call({ tool: 'mcp__progress__publish', session_id: 's1', repo: 'o/r', reviews: [{ pr: 540, key: '540:a' }] }),
    $.tool.call({ tool: 'mcp__progress__publish', session_id: 's1', repo: 'o/r', reviews: [{ pr: 540, key: '540:b' }] }),
  ])
  expect(results.every(one => one.deny === undefined)).toBe(true)
  expect((store['overview:s1'] as any).activity.rounds.map((one: any) => one.key)).toEqual(['540:a', '540:b'])
})

test('#165 removing an issue while a refresh is delayed cannot let that answer re-enroll it', async ($, on) => {
  const { store, clock } = await world($, on)
  await start($)
  await progress($, 'goal 507')
  let release = () => {}
  held.gate = new Promise<void>(resolve => { release = resolve })
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'refresh' })
  await realWait(20)
  await progress($, 'remove 507')
  const removed = store['overview:s1']
  held.gate = null
  release()
  await clock.advance(1)
  expect((store['overview:s1'] as any).goal.numbers).toEqual([])
  expect((store['overview:s1'] as any).view.total).toBe(0)
  expect((store['overview:s1'] as any).goal.tickets).toEqual([])
  await pane.unmount()
})

test('#165 colleague defaults hide the owner merge action; explicit Progress open needs no task mod', async ($, on) => {
  const { store } = await world($, on)
  await start($)
  await progress($, 'goal 507')
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 't507' })
  expect(await pane.find({ key: 'ship' })).toBeUndefined()
  await pane.unmount()
  const opened = await $.command.run({ command: 'overview', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect('text' in opened ? opened.text : '').toContain('My tasks is unavailable')
  expect((store['overview:s1'] as any).goal.numbers).toEqual([507])
})

test('#160 a refused first merge state write leaves the user action retryable', { options: { owner_workflow: true } }, async ($, on) => {
  const { clock, ran } = await world($, on)
  let refuse = false
  on('state.set', { key: 'ship' }, (_, e, next) => {
    const value = (e as any).value?.value
    if (refuse && value?.step === 'working') { refuse = false; return { deny: 'first write refused' } }
    return next(e)
  })
  await start($)
  await progress($, 'goal 507')
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 't507' })
  await pane.press({ key: 'ship' })
  refuse = true
  await pane.press({ key: 'ship-yes' })
  await clock.advance(200)
  expect(ran.some(one => one[1] === 'pr' && (one[2] === 'merge' || one[2] === 'ready'))).toBe(false)
  expect(await pane.find({ key: 'ship' })).toBeDefined()
  await pane.press({ key: 'ship' })
  await pane.press({ key: 'ship-yes' })
  expect(ran.filter(one => isPullAsk(one)).length).toBe(1)
  await pane.unmount()
})

test('#165 metadata reads retain labels, blockers and reviewed PRs without expanding unselected children', async ($, on) => {
  const { store, ran } = await world($, on)
  const data = JSON.parse(GITHUB)
  data.data.repository.i511 = data.data.repository.i507.subIssues.nodes[0]
  data.data.repository.i512 = data.data.repository.i507.subIssues.nodes[1]
  data.data.repository.i513 = data.data.repository.i507.subIssues.nodes[2]
  data.data.repository.i512.labels = { nodes: [{ name: 'deferred' }] }
  github.answer = withoutSubs(data)
  await start($)
  await progress($, 'goal 511 512 513')
  const snapshot = store['overview:s1'] as any
  expect(snapshot.view.total).toBe(3)
  expect(snapshot.goal.tickets.find((one: any) => one.number === 512).labels).toEqual(['deferred'])
  expect(snapshot.goal.tickets.find((one: any) => one.number === 513).blockedBy).toEqual([512])
  expect(snapshot.view.sections.find((one: any) => one.id === 'yours').tickets[0].number).toBe(511)
  expect(snapshot.view.sections.find((one: any) => one.id === 'doing').tickets[0].number).toBe(512)
  expect(snapshot.view.sections.find((one: any) => one.id === 'blocked').tickets[0].number).toBe(513)
  expect(ran.every(one => !one.at(-1)?.includes('issueOrPullRequest('))).toBe(true)
})

test('#165 large explicit selections use bounded Issue queries and idle refresh stays within its GitHub budget', async ($, on) => {
  const { clock, store, ran, times } = await world($, on)
  const numbers = Array.from({ length: 200 }, (_, n) => n + 1)
  github.answer = JSON.stringify({ data: { repository: Object.fromEntries(numbers.map(n => [`i${n}`, issue(n, `Issue ${n}`)])) } })
  await start($)
  await progress($, `goal ${numbers.join(' ')}`)
  for (let minute = 0; minute < 120; minute += 1) await clock.advance(60_000)
  const requests = ran.map((argv, at) => ({ query: argv.at(-1) ?? '', at: times[at] ?? 0 }))
  const issueRequests = requests.filter(one => /i\d+: issue\(/.test(one.query))
  expect(issueRequests.every(one => [...one.query.matchAll(/i\d+: issue\(/g)].length <= 30)).toBe(true)
  const worst = Math.max(...requests.map(first => requests.filter(one => one.at >= first.at && one.at < first.at + 3_600_000).length))
  expect(worst).toBeLessThanOrEqual(1000)
  expect((store['overview:s1'] as any).view.total).toBe(200)
})

test('#165 PR body metadata is cached until edited, and a partial GitHub refresh preserves the last good displayed issues', async ($, on) => {
  const { store, ran } = await world($, on)
  const answer = (body: string, updatedAt: string) => JSON.stringify({ data: { repository: { i1: issue(1, 'Tracked', { timelineItems: { nodes: [mention(pull(60, 'MERGED', false, 'feat/unrelated', null, { body, updatedAt }))] } }) } } })
  github.answer = answer('Closes #1', '2026-11-23T01:00:00Z')
  await start($)
  await progress($, 'goal 1')
  const bodies = () => ran.filter(argv => /b60: pullRequest/.test(argv.at(-1) ?? '')).length
  expect(bodies()).toBe(1)
  expect((store['overview:s1'] as any).goal.tickets[0].pulls[0].number).toBe(60)
  await progress($, 'refresh')
  expect(bodies()).toBe(1)
  github.answer = answer('Only mentions #1', '2026-11-23T02:00:00Z')
  await progress($, 'refresh')
  expect(bodies()).toBe(2)
  expect((store['overview:s1'] as any).goal.tickets[0].pulls).toEqual([])
  github.answer = JSON.stringify({ data: { repository: { i1: issue(1, 'Wrong partial title') } }, errors: [{ message: 'Partial failure' }] })
  await progress($, 'refresh')
  const after = store['overview:s1'] as any
  expect(after.goal.error).toBe('Partial failure')
  expect(after.goal.tickets[0].title).toBe('Tracked')
})

test('#165 clearing a legacy goal preserves its original record for deliberate import after restart', async ($, on) => {
  const original = { repo: 'o/r', numbers: [507, 511], added: [511] }
  const { store } = await world($, on, original)
  await start($)
  await progress($, 'clear')
  expect(store['goal:s1']).toBeUndefined()
  expect(store['legacy-goal:s1']).toEqual(original)
})

test('#165 enrollment reports a durable goal-write failure and an explicit retry recovers', async ($, on) => {
  const { store } = await world($, on)
  await start($)
  refusedWrites.add('goal:s1')
  const failed = await $.tool.call({ tool: 'mcp__progress__enroll', issues: '507' })
  expect(failed.deny).toBeDefined()
  expect(store['goal:s1']).toBeUndefined()
  refusedWrites.clear()
  const retry = await $.tool.call({ tool: 'mcp__progress__enroll', issues: '507' })
  expect(retry.deny).toBeUndefined()
  expect((store['goal:s1'] as any).numbers).toEqual([507])
})

test('#165 a legacy clear delayed on its backup read cannot clear a resumed session goal', async ($, on) => {
  const original = { repo: 'o/r', numbers: [507, 511], added: [511] }
  const { store } = await world($, on, original, { 'goal:s2': { repo: 'o/r', numbers: [507] } })
  await start($)
  let release = () => {}
  let reached = false
  held.store = { key: 'legacy-goal:s1', until: new Promise<void>(resolve => { release = resolve }), reached: () => { reached = true } }
  const clearing = progress($, 'clear')
  await realWait(20)
  expect(reached).toBe(true)
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
  session.id = 's2'
  await $.tool.call({ tool: 'mcp__progress__open' })
  const before = store['overview:s2']
  held.store = null
  release()
  await clearing
  expect(store['overview:s2']).toEqual(before)
  expect((store['goal:s2'] as any).numbers).toEqual([507])
})

test('#165 compact panes and publications omit empty groups while retaining every enrolled issue', async ($, on) => {
  const { store } = await world($, on)
  github.answer = JSON.stringify({ data: { repository: { i1: issue(1, 'Open work'), i2: issue(2, 'Closed work', { state: 'CLOSED' }) } } })
  await start($)
  await progress($, 'goal 1 2')
  const snapshot = store['overview:s1'] as any
  expect(snapshot.view.sections.map((one: any) => one.id)).toEqual(['ready', 'shipped'])
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ key: 's-yours' })).toBeUndefined()
  expect(await pane.find({ key: 't1' })).toBeDefined()
  expect(await pane.find({ key: 's-shipped' })).toBeDefined()
  await pane.unmount()
})

test('#165 a review write failure is refused and a deliberate retry survives resume', async ($, on) => {
  const { store } = await world($, on)
  await start($)
  await $.tool.call({ tool: 'mcp__progress__enroll', issues: '507' })
  refusedWrites.add('review:s1')
  const report = { tool: 'mcp__progress__publish', session_id: 's1', repo: 'o/r', reviews: [{ pr: 540, key: '540:durable' }] } as const
  expect((await $.tool.call(report)).deny).toBeDefined()
  refusedWrites.clear()
  expect((await $.tool.call(report)).deny).toBeUndefined()
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's2' } })
  session.id = 's2'
  await progress($, '')
  await $.session.end({ reason: 'resume', sessionId: 's2', resume: { id: 's1' } })
  session.id = 's1'
  await progress($, '')
  expect((store['overview:s1'] as any).activity.rounds.length).toBe(1)
})

test('#165 a summary-only explicit report is readable in the native pane', async ($, on) => {
  await world($, on)
  await start($)
  await $.tool.call({ tool: 'mcp__progress__enroll', issues: '507' })
  await $.tool.call({ tool: 'mcp__progress__publish', session_id: 's1', repo: 'o/r', summary: 'Implemented enrollment' })
  const pane = await $.ui.mount(PANE)
  expect(await seen(pane, /Implemented enrollment/)).not.toContain('MISSING')
  await pane.unmount()
})

test('#165 idle native presentation ages explicit reports without renewing their source timestamps', async ($, on) => {
  const { clock, store } = await world($, on)
  await start($)
  await $.tool.call({ tool: 'mcp__progress__enroll', issues: '507' })
  await $.tool.call({ tool: 'mcp__progress__publish', session_id: 's1', repo: 'o/r', summary: 'Checking state', working: true, agents: [{ id: 'worker', type: 'reviewer', what: 'Review selected work', ticket: 507, status: 'working' }] })
  const reportedAt = (store['overview:s1'] as any).activity.reportedAt
  const pane = await $.ui.mount(PANE)
  await clock.advance(46 * 60_000)
  expect(await seen(pane, /No report for 46m/)).not.toContain('MISSING')
  expect((store['overview:s1'] as any).activity.reportedAt).toBe(reportedAt)
  expect((store['overview:s1'] as any).activity.agents[0].activeAt).toBe(reportedAt)
  await pane.unmount()
})


test('#165 removing a selected parent retains its explicitly selected child', async ($, on) => {
  const { store } = await world($, on)
  const data = JSON.parse(GITHUB)
  data.data.repository.i511 = { ...data.data.repository.i507.subIssues.nodes[0], parent: { number: 507 } }
  github.answer = withoutSubs(data)
  await start($)
  await progress($, 'goal 507 511')
  await progress($, 'remove 507')
  const published = store['overview:s1'] as any
  expect(published.goal.numbers).toEqual([511])
  expect(published.goal.tickets.map((one: any) => [one.number, one.parent])).toEqual([[511, 507]])
  expect(published.view.total).toBe(1)
})

test('#180 with no surface /overview does not say My tasks opened, and names no pane it did not open', async ($, on) => {
  await world($, on)
  on('session.surfaces', () => ({ value: [] }))
  const link = 'Open the dashboard: http://box:6767. Open tasks: no open tasks (pane not shown: no surface is attached)'
  on('tool.call', { tool: 'mcp__human-in-the-loop__open_tasks' }, () => ({ result: link }))
  const asked = fakeDashboard(on, { text: 'dashboard: on', address: 'http://box:6767' })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  const text = await overview($, '')
  expect(text).not.toContain('My tasks opened')
  expect(text).toMatch(/^Open the dashboard: http:\/\/box:6767\. Open tasks: no open tasks \(pane not shown: no surface is attached\) Progress: /)
  expect(text).not.toContain('Web dashboard:')
  expect(asked).toEqual([])
  expect(await overview($, 'tasks')).toBe(link)
})

test('#181 /overview usage calls the usage-collector tool, focused, and opens no Progress pane or My tasks', async ($, on) => {
  const { opened } = await world($, on)
  const asked: unknown[] = []
  on('tool.call', { tool: 'mcp__usage-collector__open_usage' }, (_, e) => { asked.push([e.tool, (e as unknown as { focus?: boolean }).focus]); return { result: 'Usage opened.' } })
  on('tool.call', { tool: 'mcp__human-in-the-loop__open_tasks' }, () => { asked.push('tasks'); return { result: 'My tasks opened.' } })
  await start($)
  expect(await overview($, ' Usage ')).toBe('Usage opened.')
  expect(asked).toEqual([['mcp__usage-collector__open_usage', true]])
  expect(opened).toEqual([])
})

/** usage-collector's answer with no surface: the readings only (human-in-the-loop answers its dashboard tool for Progress alone). */
const READINGS = 'Usage: work: 5h 31% (pane not shown: no surface is attached)'

test('#181 with no surface /overview usage leads the readings with the dashboard link, which Progress asks for', async ($, on) => {
  const { opened } = await world($, on)
  on('session.surfaces', () => ({ value: [] }))
  on('tool.call', { tool: 'mcp__usage-collector__open_usage' }, () => ({ result: READINGS }))
  const answer: { text: string; address?: string } = { text: 'dashboard: on', address: 'http://box:6767' }
  const asked = fakeDashboard(on, answer)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  expect(await overview($, 'usage')).toBe(`Open the dashboard: http://box:6767. ${READINGS}`)
  delete answer.address
  expect(await overview($, 'usage')).toBe(`The web dashboard is not running (or did not answer in time): /overview start, dashboard/README.md. ${READINGS}`)
  expect(asked).toEqual(['status', 'status'])
  expect(opened).toEqual([])
})

test('#181 bare /overview opens Usage too, unfocused, after My tasks and Progress', async ($, on) => {
  const { opened } = await world($, on)
  const asked: unknown[] = []
  on('tool.call', { tool: 'mcp__human-in-the-loop__open_tasks' }, () => { asked.push('tasks'); return { result: 'My tasks opened.' } })
  on('tool.call', { tool: 'mcp__usage-collector__open_usage' }, (_, e) => { asked.push(['usage', (e as unknown as { focus?: boolean }).focus]); return { result: 'Usage opened.' } })
  await start($)
  expect(await overview($, '')).toMatch(/^My tasks opened\. Progress: /)
  expect(asked).toEqual(['tasks', ['usage', false]])
  expect(opened.length).toBe(1)
  expect(await overview($, 'progress')).not.toContain('Usage opened')
  expect(asked.length).toBe(2)
})

test('#181 bare /overview opens Progress at once even when Usage never answers', async ($, on) => {
  const { opened } = await world($, on)
  on('tool.call', { tool: 'mcp__human-in-the-loop__open_tasks' }, () => ({ result: 'My tasks opened.' }))
  let called = false
  on('tool.call', { tool: 'mcp__usage-collector__open_usage' }, () => { called = true; return new Promise<never>(() => {}) })
  await start($)
  expect(await overview($, '')).toMatch(/^My tasks opened\. Progress: /)
  expect(opened.length).toBe(1)
  expect(called).toBe(true)
})

test('#181 with no surface bare /overview gives the tasks (with the dashboard link) and the Usage readings as text', async ($, on) => {
  await world($, on)
  on('session.surfaces', () => ({ value: [] }))
  const tasks = 'Open the dashboard: http://box:6767. Open tasks: no open tasks (pane not shown: no surface is attached)'
  on('tool.call', { tool: 'mcp__human-in-the-loop__open_tasks' }, () => ({ result: tasks }))
  on('tool.call', { tool: 'mcp__usage-collector__open_usage' }, () => ({ result: READINGS }))
  const asked = fakeDashboard(on, { text: 'dashboard: on', address: 'http://box:6767' })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  expect(await overview($, '')).toStartWith(`${tasks} ${READINGS} Progress: `)
  expect(asked).toEqual([])
})

test('#181 bare /overview without usage-collector says nothing of Usage; /overview usage says to install it', async ($, on) => {
  await world($, on)
  on('tool.call', { tool: 'mcp__human-in-the-loop__open_tasks' }, () => ({ result: 'My tasks opened.' }))
  on('tool.call', { tool: 'mcp__usage-collector__open_usage' }, () => ({ deny: 'no such tool' }))
  await start($)
  expect(await overview($, '')).toMatch(/^My tasks opened\. Progress: /)
  expect(await overview($, 'usage')).toBe('Usage is unavailable; install or enable usage-collector.')
})

test('#203 a bare /overview still shows the address when human-in-the-loop 0.1.14 or older answers with the old {text, address} object', async ($, on) => {
  await world($, on)
  on('tool.call', { tool: 'mcp__human-in-the-loop__open_tasks' }, () => ({ result: 'My tasks opened.' }))
  on('tool.call', { tool: 'mcp__human-in-the-loop__dashboard' }, () => ({ result: { text: 'dashboard: on', address: 'http://box:6767' } as never }))
  await start($)
  expect(await overview($, '')).toMatch(/Web dashboard: http:\/\/box:6767$/)
  expect(await overview($, 'web')).toBe('dashboard: on')
})
