// The goal: a set of GitHub issues (or one issue with sub-issues), read through
// the person's own `gh`. Pure: the queries, their parsing, and how an issue's
// state reads from its PRs and blockers. No `$` here.

import type { Agent, Closer, Fold, Goal, Pull, Ticket } from '../types'

export type GoalRef = {
  repo: string
  numbers: number[]
  /** Numbers the owner removed: a gh call that touches one again does not bring it back. */
  removed?: number[]
  /** Those of `numbers` the session's gh calls brought in, not the person: asked lightly, and aged out once landed. */
  added?: number[]
  /** The sections the person changed from their default, by section id. */
  sections?: Record<string, Fold>
}

/** One repository, however its `owner/name` is cased: GitHub reads `O/R` as `o/r`. */
export function sameRepo(one: string, other: string): boolean {
  return one.toLowerCase() === other.toLowerCase()
}

/** `owner/name` out of a git remote, or '' for one that is not GitHub's. */
export function repoOf(remote: string | null | undefined): string {
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote ?? '')?.[1] ?? ''
}

/**
 * What `/progress goal ...` names: issue numbers (`507`, `#12 #13`), an
 * `owner/name#507`, or an issue URL. The repository is the one a word names,
 * else the session's: a bare number is of the repository another word names.
 *
 * A goal is in one repository (owner decision, task #26, 2026-11-18, option
 * chosen: "Both as recommended"): words naming two are refused, with why.
 */
export function parseGoal(args: string, sessionRepo: string): GoalRef | { refused: string } | undefined {
  let named: { repo: string; word: string } | undefined
  const numbers: number[] = []

  for (const word of args.split(/[\s,]+/).filter(one => one !== '')) {
    const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/?$/.exec(word)
    const qualified = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(word)
    const bare = /^#?(\d+)$/.exec(word)
    const found = url ?? qualified
    const repo = found?.[1]

    if (repo !== undefined && named !== undefined && !sameRepo(named.repo, repo)) {
      return { refused: `A goal is in one repository: ${named.word} and ${word} name two. Name the issues of one.` }
    }

    named ??= repo === undefined ? undefined : { repo, word }
    const number = Number(found?.[2] ?? bare?.[1])

    if (!Number.isSafeInteger(number) || number <= 0) {
      return undefined
    }

    numbers.push(number)
  }

  const repo = named?.repo ?? sessionRepo

  return repo === '' || numbers.length === 0 ? undefined : { repo, numbers: [...new Set(numbers)] }
}

const ROW = `fragment Row on Issue {
  number title state stateReason url body
  parent { number }
  labels(first: 20) { nodes { name } }
  blockedBy(first: 20) { nodes { number state } }
  closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { ...Pull } }
  timelineItems(last: 40, itemTypes: [CROSS_REFERENCED_EVENT]) {
    nodes { ... on CrossReferencedEvent { willCloseTarget source { ... on PullRequest { ...Pull } } } }
  }
}
`
// No body: a PR's body is read only where it is the one place that says what
// the PR closes (merged into an umbrella), in the follow-up ask (#155 r1).
const PULL = `fragment Pull on PullRequest {
  number state isDraft reviewDecision headRefName headRefOid baseRefName mergeable mergedAt updatedAt
  statusCheckRollup { state }
  repository { nameWithOwner }
}`

// Each request asks at most 30 explicit issues, never children or standalone PRs.
const ISSUES_PER_REQUEST = 30
const FOLLOW_UP_POINTS = 1
function chunksOf(ref: GoalRef): number[][] {
  const chunks: number[][] = []
  for (let at = 0; at < ref.numbers.length; at += ISSUES_PER_REQUEST) chunks.push(ref.numbers.slice(at, at + ISSUES_PER_REQUEST))
  return chunks
}

export function goalQueries(ref: GoalRef): string[][] {
  const [owner = '', name = ''] = ref.repo.split('/')
  return chunksOf(ref).map(numbers => {
    const issues = numbers.map(number => `i${number}: issue(number: ${number}) { ...Row }`).join('\n')
    return ['gh', 'api', 'graphql', '-f', `owner=${owner}`, '-f', `name=${name}`, '-f',
      `query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { defaultBranchRef { name }\n${issues}\n} }\n${ROW}\n${PULL}`]
  })
}

/** Inspect legacy mixed issue/PR numbers without treating a PR as a failed Issue query. */
export function importQueries(ref: GoalRef): string[][] {
  const [owner = '', name = ''] = ref.repo.split('/')
  return chunksOf(ref).map(numbers => {
    const issues = numbers.map(number => `i${number}: issueOrPullRequest(number: ${number}) { __typename ... on Issue { number url } }`).join('\n')
    return ['gh', 'api', 'graphql', '-f', `owner=${owner}`, '-f', `name=${name}`, '-f',
      `query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {\n${issues}\n} }`]
  })
}

/** Four bounded connections per issue, plus one possible PR-metadata follow-up. */
export function pointsOf(ref: GoalRef): number {
  return chunksOf(ref).reduce((sum, numbers) => sum + Math.max(1, Math.round(numbers.length * 4 / 100)), FOLLOW_UP_POINTS)
}

const HOUR_MS = 3_600_000
/** Refreshes asked for closer together than this are one refresh. */
export const SETTLE_MS = 8000
/** GitHub's GraphQL points the goal's refreshes may spend in an hour, a soft cap (a slight overflow, as when the goal grows late in the hour, is accepted; owner prompt 2026-11-19, "just treat it as a soft cap ... the actual limit is 5k"): a fifth of the 5,000 GitHub allows, the rest left to the person's own gh calls. */
export const REFRESH_BUDGET = 1000

/**
 * How long after one refresh the next may start on its own, for a refresh
 * that costs `cost` points: any rolling hour holds one refresh more than it
 * has whole gaps, so the gap is the one at which those refreshes cost at most
 * REFRESH_BUDGET. Past an hour one refresh is all an hour can hold, so no gap
 * is longer than that (finite, far under a timer's 2^31 ms). null where one
 * refresh alone costs more than the budget: it refreshes only when pressed.
 */
export function gapOf(cost: number, spent = cost): number | null {
  if (cost > REFRESH_BUDGET) {
    return null
  }

  const spare = REFRESH_BUDGET - cost

  // Where refreshes spend less than the most one may (`spent` <= `cost`), each
  // is followed by spent × hour / spare: the n - 1 whole gaps of an hour then
  // hold at most `spare` of what was spent, and the last refresh at most `cost`.
  return Math.max(SETTLE_MS, spare === 0 ? HOUR_MS + 1 : Math.min(HOUR_MS + 1, Math.ceil((spent * HOUR_MS) / spare)))
}

type RawPull = {
  number?: number
  state?: string
  isDraft?: boolean
  reviewDecision?: string | null
  headRefName?: string
  headRefOid?: string
  baseRefName?: string
  mergedAt?: string | null
  updatedAt?: string | null
  mergeable?: string
  statusCheckRollup?: { state?: string } | null
  repository?: { nameWithOwner?: string } | null
}

type RawRow = RawPull & {
  number: number
  title: string
  state: string
  url: string
  stateReason?: string | null
  body?: string
  labels?: { nodes?: { name: string }[] }
  blockedBy?: { nodes?: { number: number; state: string }[] }
  closedByPullRequestsReferences?: { nodes?: RawPull[] }
  timelineItems?: { nodes?: { willCloseTarget?: boolean; source?: RawPull }[] }
  parent?: { number: number } | null
  subIssues?: { nodes?: RawRow[] }
}

function pullOf(raw: RawPull): Pull | undefined {
  if (raw.number === undefined) {
    return undefined
  }

  const state = raw.state === 'MERGED' || raw.state === 'CLOSED' ? raw.state : 'OPEN'
  const rollup = raw.statusCheckRollup?.state ?? ''
  const checks = rollup === 'SUCCESS' ? 'pass' : rollup === 'FAILURE' || rollup === 'ERROR' ? 'fail' : rollup === '' ? '' : 'running'
  const review = raw.reviewDecision === 'APPROVED' ? 'approved' : raw.reviewDecision === 'CHANGES_REQUESTED' ? 'changes requested' : ''

  return {
    number: raw.number,
    state,
    isDraft: raw.isDraft === true,
    review,
    checks,
    branch: raw.headRefName ?? '',
    head: raw.headRefOid ?? '',
    base: raw.baseRefName ?? '',
    mergedAt: raw.mergedAt ?? '',
    updatedAt: raw.updatedAt ?? '',
    hasConflicts: raw.mergeable === 'CONFLICTING',
    repo: raw.repository?.nameWithOwner ?? '',
  }
}

/** The numbers a branch or worktree name carries: `feat/7-owner-inbox` names 7. */
export function numbersIn(name: string): number[] {
  return (name.match(/\d+/g) ?? []).map(Number)
}

/**
 * The blockers an issue's own text declares: a `Blocked by: #512, #513` line,
 * or a "Blocked by" heading over a list. For trackers that do not use
 * GitHub's own "blocked by" links.
 */
export function declaredIn(body: string): number[] {
  const lines = body.split('\n')
  const at = lines.findIndex(line => /^[#\s*_-]*blocked by\b/i.test(line))

  if (at === -1) {
    return []
  }

  // The line itself, then the list under it, up to the next line of prose.
  const under = lines.slice(at + 1)
  const end = under.findIndex(line => line.trim() !== '' && !/^\s*[-*]\s/.test(line))
  const span = [lines[at] ?? '', ...(end === -1 ? under : under.slice(0, end))].join('\n')

  return [...new Set([...span.matchAll(/#(\d+)/g)].map(found => Number(found[1])))]
}

function labelsOf(raw: RawRow): string[] {
  return (raw.labels?.nodes ?? []).map(one => one.name)
}

/**
 * Whether a PR body closes issue `number` of `repo` by a closing keyword
 * (`Closes`, `Fixes`, `Resolves` and their other forms), as `#n` or
 * `owner/name#n`. GitHub records a closing reference only for a PR into the
 * default branch, so the body is the one place a PR into an umbrella says it.
 * It only moves an issue between In umbrella and Ready, never to Shipped.
 */
export function closesIn(body: string | null | undefined, number: number, repo: string): boolean {
  return closedBy(body, repo).includes(number)
}

/** The issues of `repo` a PR body closes by a closing keyword, one keyword per number (as GitHub reads it). */
export function closedBy(body: string | null | undefined, repo: string): number[] {
  const numbers: number[] = []

  for (const found of (body ?? '').matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?[ \t]+([\w.-]+\/[\w.-]+)?#(\d+)\b/gi)) {
    if (found[1] === undefined || sameRepo(found[1], repo)) {
      numbers.push(Number(found[2]))
    }
  }

  return [...new Set(numbers)]
}

/**
 * A merged PR into an umbrella branch that mentions an issue but is not its
 * by GitHub's closing reference or by its branch name: only its body can say
 * it closes the issue, and the body is read in the follow-up ask.
 */
function isByBody(one: { willCloseTarget?: boolean; source?: RawPull }, number: number): boolean {
  return one.willCloseTarget !== true && !numbersIn(one.source?.headRefName ?? '').includes(number) && one.source?.state === 'MERGED' && GATHERING.test(one.source.baseRefName ?? '')
}

function ticketOf(raw: RawRow, parent: number | null, repo: string, closers: Readonly<Record<string, readonly number[]>>): Ticket {
  // A PR is the issue's when GitHub says it closes it, or when it mentions
  // the issue and its branch carries the issue's number: one merged into a
  // branch that is not the default never counts as closing.
  const mentioned = (raw.timelineItems?.nodes ?? [])
    .filter(
      one =>
        one.willCloseTarget === true ||
        numbersIn(one.source?.headRefName ?? '').includes(raw.number) ||
        // Merged into an umbrella branch: GitHub keeps no closing reference, so its body's own words count.
        (isByBody(one, raw.number) && (closers[String(one.source?.number)] ?? []).includes(raw.number)),
    )
    .map(one => one.source ?? {})
  const pulls = new Map<number, Pull>()

  for (const one of [...(raw.closedByPullRequestsReferences?.nodes ?? []), ...mentioned]) {
    const pull = pullOf(one)

    // The goal is in one repository: another's PR is left out before PRs are told apart by number.
    if (pull !== undefined && (pull.repo === '' || sameRepo(pull.repo, repo))) {
      pulls.set(pull.number, pull)
    }
  }

  return {
    number: raw.number,
    title: raw.title,
    // Closed only when GitHub says CLOSED: a missing, null or unknown state is treated as open (#155 r6, owner decision "Fix now").
    isOpen: raw.state !== 'CLOSED',
    // Closed as not planned or as a duplicate (agent decision, #155 r4): it shipped nothing, the work is tracked elsewhere.
    isNotPlanned: raw.state === 'CLOSED' && (raw.stateReason === 'NOT_PLANNED' || raw.stateReason === 'DUPLICATE'),
    url: raw.url,
    labels: labelsOf(raw),
    parent,
    blockedBy: (raw.blockedBy?.nodes ?? []).filter(one => one.state === 'OPEN').map(one => one.number),
    declared: declaredIn(raw.body ?? '').filter(number => number !== raw.number),
    pulls: [...pulls.values()].sort((a, b) => a.number - b.number),
  }
}

type Answered = { repository: Record<string, RawRow | null>; trunk: string }

/** The answers to `goalQueries` as one record of aliases, and the repository's default branch; throws with GitHub's words on an error. */
function answered(stdouts: string | readonly string[], ref: GoalRef): Answered {
  const repository: Record<string, RawRow | null> = {}
  let trunk = ''

  for (const stdout of typeof stdouts === 'string' ? [stdouts] : stdouts) {
    const answer = JSON.parse(stdout) as {
      data?: { repository?: (Record<string, RawRow | null> & { defaultBranchRef?: { name?: unknown } | null }) | null }
      errors?: { message?: string }[]
    }
    const part = answer.data?.repository
    if (answer.errors?.length) throw new Error(answer.errors[0]?.message ?? 'GitHub returned a partial answer')

    if (part === null || part === undefined) {
      throw new Error(answer.errors?.[0]?.message ?? `no repository ${ref.repo}`)
    }

    const name = part.defaultBranchRef?.name
    trunk = typeof name === 'string' ? name : trunk
    Object.assign(repository, part)
  }

  return { repository, trunk }
}

/** The goal's tickets out of the answers to `goalQueries`; throws with GitHub's words on an error. `closers`: what the bodies of merged PRs into umbrellas close, by PR number. */
export function parseTickets(
  stdouts: string | readonly string[],
  ref: GoalRef,
  closers: Readonly<Record<string, readonly number[]>> = {},
): Pick<Goal, 'title' | 'tickets' | 'heads'> & { trunk: string; byBody: Pull[] } {
  const { repository, trunk } = answered(stdouts, ref)
  const tickets: Ticket[] = []
  const heads: RawRow[] = []
  const byBody = new Map<number, Pull>()

  for (const number of ref.numbers) {
    const head = repository[`i${number}`]

    if (head === null || head === undefined) {
      throw new Error(`no issue #${number} in ${ref.repo}`)
    }

    if (head.headRefName !== undefined || /\/pull\//.test(head.url ?? '')) {
      throw new Error(`#${number} is a pull request. Progress tracks issues only.`)
    }
    heads.push(head)
    for (const one of head.timelineItems?.nodes ?? []) {
      const pull = one.source === undefined ? undefined : pullOf(one.source)
      if (pull !== undefined && isByBody(one, head.number) && (pull.repo === '' || sameRepo(pull.repo, ref.repo))) byBody.set(pull.number, pull)
    }
    // Parentage is metadata only: it never enrolls another issue or adds a heading.
    tickets.push(ticketOf(head, head.parent?.number ?? null, ref.repo, closers))
  }

  const [only] = heads
  const pulls = ref.numbers.length - heads.length
  const named = [heads.length > 0 ? `${heads.length} issue${heads.length === 1 ? '' : 's'}` : '', pulls > 0 ? `${pulls} PR${pulls === 1 ? '' : 's'}` : '']
  const title = heads.length === 1 && only !== undefined && ref.numbers.length === 1 ? `#${only.number} ${only.title}` : named.filter(one => one !== '').join(', ')
  // One the person removed stays out, a sub-issue of one named too.
  const removed = new Set(ref.removed ?? [])

  return {
    title,
    tickets: tickets.filter((one, index) => !removed.has(one.number) && tickets.findIndex(other => other.number === one.number) === index),
    // A heading has a PR of its own where its sub-issues are gathered on one branch.
    heads: [],
    trunk,
    /** The merged PRs into umbrellas that only their bodies can tie to an issue. */
    byBody: [...byBody.values()],
  }
}

/** The most bodies one follow-up ask reads: well under GitHub's 4 MiB answer and 1 point. */
const MAX_BODIES = 30
/**
 * The follow-up ask of a refresh: the bodies of merged PRs into umbrellas
 * (`b<n>`), the one place that says what such a PR closes.
 */
export function followUpQuery(repo: string, bodies: readonly number[]): string[] {
  const [owner = '', name = ''] = repo.split('/')
  const lines = bodies.map(number => `b${number}: pullRequest(number: ${number}) { body }`).join('\n')

  return ['gh', 'api', 'graphql', '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {\n${lines}\n} }`]
}

/**
 * The answer to `followUpQuery`: what each body closes. Throws with GitHub's
 * words where the answer carries an error or lacks a body it asked for: a part
 * GitHub failed to answer is never read as empty (#155 r2).
 */
export function parseFollowUp(stdout: string, repo: string, bodies: readonly number[]): Record<string, number[]> {
  const answer = JSON.parse(stdout) as FollowUpAnswer
  const part = answer.data?.repository
  const [error] = answer.errors ?? []

  if (error !== undefined || part === null || part === undefined) {
    throw new Error(error?.message ?? `no repository ${repo}`)
  }

  const closers: Record<string, number[]> = {}

  for (const number of bodies) {
    const body = (part[`b${number}`] as { body?: unknown } | null | undefined)?.body

    if (typeof body !== 'string') {
      throw new Error(`GitHub did not answer the body of #${number}`)
    }

    closers[String(number)] = closedBy(body, repo)
  }

  return closers
}

type FollowUpAnswer = { data?: { repository?: Record<string, unknown> | null } | null; errors?: { message?: string }[] }

/** What a refresh learns and what the next one may reuse. */
export type Known = {
  closers: Record<string, Closer>
}

/**
 * The bodies to read, at most MAX_BODIES: those never read first, then those
 * read before and changed since, the longest unread first, so no PR starves
 * under others that keep being edited.
 */
function bodiesToRead(byBody: readonly Pull[], closers: Readonly<Record<string, Closer>>, known: Readonly<Record<string, Closer>>): Pull[] {
  const readAt = (one: Pull) => {
    const at = known[String(one.number)]?.at

    return typeof at === 'string' ? at : undefined
  }
  const stale = byBody.filter(one => closers[String(one.number)] === undefined)
  const never = stale.filter(one => readAt(one) === undefined)
  const old = stale.filter(one => readAt(one) !== undefined).sort((a, b) => timeOf(readAt(a)) - timeOf(readAt(b)))

  return [...never, ...old].slice(0, MAX_BODIES)
}

function timeOf(at: string | undefined): number {
  const time = Date.parse(at ?? '')

  return Number.isNaN(time) ? -Infinity : time
}

/**
 * One refresh of the goal: its requests, then, only where needed, one
 * follow-up ask for the bodies of merged PRs into umbrellas not read since
 * they last changed. `ask` runs a `gh` call and answers its stdout, or throws:
 * any failure fails the whole refresh, and nothing it learned is kept. `spent`
 * is what the refresh cost in points.
 */
export async function readGoal(
  ref: GoalRef,
  known: Partial<Known>,
  ask: (argv: string[]) => Promise<string>,
): Promise<Pick<Goal, 'title' | 'tickets' | 'heads'> & Known & { trunk: string; spent: number }> {
  const stdouts: string[] = []

  for (const query of goalQueries(ref)) {
    stdouts.push(await ask(query))
  }

  const first = parseTickets(stdouts, ref)
  // A body read before is reused only while its PR has not changed since (an edited body may close other issues).
  const closers: Record<string, Closer> = {}

  for (const one of first.byBody) {
    const kept = known.closers?.[String(one.number)]

    if (kept !== undefined && typeof kept.at === 'string' && Array.isArray(kept.closes) && kept.at === (one.updatedAt ?? '')) {
      closers[String(one.number)] = kept
    }
  }

  const bodies = bodiesToRead(first.byBody, closers, known.closers ?? {})
  const numbers = bodies.map(one => one.number)
  const isAsked = numbers.length > 0

  if (isAsked) {
    const answer = await ask(followUpQuery(ref.repo, numbers))
    const more = parseFollowUp(answer, ref.repo, numbers)

    for (const one of bodies) {
      closers[String(one.number)] = { at: one.updatedAt ?? '', closes: more[String(one.number)] ?? [] }
    }
  }

  const read = parseTickets(stdouts, ref, Object.fromEntries(Object.entries(closers).map(([number, one]) => [number, one.closes])))

  return {
    title: read.title,
    tickets: read.tickets,
    heads: read.heads,
    trunk: read.trunk,
    closers,
    spent: pointsOf(ref) - (isAsked ? 0 : FOLLOW_UP_POINTS),
  }
}

export type Status = 'yours' | 'doing' | 'blocked' | 'ready' | 'done'

/** The sections of the pane, in order: where a ticket is drawn, and whether its section starts open. */
export type SectionId = 'yours' | 'doing' | 'blocked' | 'ready' | 'deferred' | 'umbrella' | 'shipped'

/** Waiting for you and In progress start with every row shown: they are the ones to act on (agent decision). */
export const SECTIONS: readonly { id: SectionId; label: string; start: Fold }[] = [
  { id: 'yours', label: 'Waiting for you', start: 'all' },
  { id: 'doing', label: 'In progress', start: 'all' },
  { id: 'blocked', label: 'Blocked', start: 'open' },
  { id: 'ready', label: 'Ready', start: 'open' },
  { id: 'deferred', label: 'Deferred', start: 'closed' },
  { id: 'umbrella', label: 'In umbrella', start: 'open' },
  { id: 'shipped', label: 'Completed', start: 'closed' },
]

/** The rows a section shows before "and N more". */
export const FIRST_ROWS = 5

/**
 * The section a ticket is drawn in: where it stands, except that a ready one
 * labelled `deferred` goes to Deferred and landed work to In umbrella or
 * Shipped. null where no section holds it: an issue closed as not planned or
 * as a duplicate (or closed for a reason not read yet), and a PR of the goal's
 * own that closed without merging or merged into a branch that is neither
 * shipping nor an umbrella.
 */
export function sectionOf(ticket: Ticket, all: readonly Ticket[], agents: readonly Agent[], trunk: string): SectionId | null {
  const status = statusOf(ticket, all, agents)

  if (status === 'done') {
    return doneKindOf(ticket, trunk)
  }

  return status === 'ready' && (ticket.labels ?? []).includes('deferred') ? 'deferred' : status
}

export const STATUSES: readonly { status: Status; label: string }[] = [
  { status: 'yours', label: 'Waiting for you' },
  { status: 'doing', label: 'In progress' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'ready', label: 'Ready' },
  { status: 'done', label: 'Done' },
]

/** Completion follows the issue's own state, including reopened issues. */
export function isLanded(ticket: Ticket): boolean { return !ticket.isOpen }

/** Closed issues are complete; merged PRs on open issues remain metadata. */
export function doneKindOf(ticket: Ticket, _trunk: string): 'umbrella' | 'shipped' | null {
  return ticket.isOpen ? null : 'shipped'
}

/** The session's running agents that work on a ticket: by a `#N` in the task, or the number in the worktree's name. */
export function agentsOn(ticket: Ticket, agents: readonly Agent[]): Agent[] {
  return agents.filter(
    one =>
      one.endedAt === null &&
      one.ticket === ticket.number,
  )
}

export function statusOf(ticket: Ticket, all: readonly Ticket[], agents: readonly Agent[]): Status {
  if (isLanded(ticket)) {
    return 'done'
  }

  const open = ticket.pulls.filter(one => one.state === 'OPEN')

  // A PR out of draft is the agent saying "your turn".
  if (open.some(one => !one.isDraft)) {
    return 'yours'
  }

  if (open.length > 0 || agentsOn(ticket, agents).length > 0) {
    return 'doing'
  }

  return openBlockers(ticket, all).length > 0 ? 'blocked' : 'ready'
}

/**
 * The blockers still in the way. One GitHub links is open unless it is one of
 * the goal's own that has landed; one only the issue's text declares counts
 * when it is one of the goal's own, since nothing else says where it stands.
 */
export function openBlockers(ticket: Ticket, all: readonly Ticket[]): number[] {
  const known = (number: number) => all.find(one => one.number === number)
  const linked = ticket.blockedBy.filter(number => {
    const blocker = known(number)

    return blocker === undefined || !isLanded(blocker)
  })
  const declared = ticket.declared.filter(number => {
    const blocker = known(number)

    return blocker !== undefined && !isLanded(blocker)
  })

  return [...new Set([...linked, ...declared])].sort((a, b) => a - b)
}

/** The PR that says where a ticket stands: its open one, else the one that merged. */
export function leadPull(ticket: Ticket): Pull | undefined {
  return ticket.pulls.findLast(one => one.state === 'OPEN') ?? ticket.pulls.findLast(one => one.state === 'MERGED')
}

/** A piece of what a row says after its title, and how it reads: good news, bad news, or neither. */
export type Part = { text: string; tone: 'dim' | 'good' | 'bad' }

/** What a row says after the title: its blockers, or its PR with its conflicts, checks and review. */
export function partsOf(ticket: Ticket, status: Status, all: readonly Ticket[]): Part[] {
  if (status === 'blocked') {
    const blockers = openBlockers(ticket, all).map(number => `#${number}`)

    // A long list says less than its head and its length.
    return [{ text: `← ${blockers.slice(0, 3).join(' ')}${blockers.length > 3 ? ` +${blockers.length - 3}` : ''}`, tone: 'dim' }]
  }

  const pull = leadPull(ticket)

  if (pull === undefined) {
    return []
  }

  if (pull.state === 'MERGED') {
    return [{ text: `merged #${pull.number}`, tone: 'dim' }]
  }

  const parts: Part[] = [{ text: `PR #${pull.number}${pull.isDraft ? ' draft' : ''}`, tone: 'dim' }]

  if (pull.hasConflicts) {
    parts.push({ text: 'conflicts', tone: 'bad' })
  }

  if (pull.checks === 'pass') {
    parts.push({ text: '✓', tone: 'good' })
  } else if (pull.checks === 'fail') {
    parts.push({ text: '✗ checks', tone: 'bad' })
  } else if (pull.checks === 'running') {
    parts.push({ text: '…', tone: 'dim' })
  }

  if (pull.review !== '') {
    parts.push({ text: `· ${pull.review}`, tone: pull.review === 'approved' ? 'good' : 'bad' })
  }

  return parts
}

export function metaOf(ticket: Ticket, status: Status, all: readonly Ticket[]): string {
  return partsOf(ticket, status, all)
    .map(part => part.text)
    .join(' ')
}

/** One issue to read: its body and its last comments. */
export function docQuery(repo: string, number: number): string[] {
  const [owner = '', name = ''] = repo.split('/')

  return [
    'gh',
    'api',
    'graphql',
    '-f',
    `owner=${owner}`,
    '-f',
    `name=${name}`,
    '-F',
    `number=${number}`,
    '-f',
    'query=query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue: issueOrPullRequest(number: $number) { ... on Issue { title body author { login } comments(last: 20) { totalCount nodes { author { login } createdAt body } } } ... on PullRequest { title body author { login } comments(last: 20) { totalCount nodes { author { login } createdAt body } } } } } }',
  ]
}

/** The issue as one Markdown text: body, then its comments, oldest first. */
export function parseDoc(stdout: string): string {
  const issue = (
    JSON.parse(stdout) as {
      data?: {
        repository?: {
          issue?: {
            body?: string
            comments?: { totalCount?: number; nodes?: { author?: { login?: string } | null; createdAt?: string; body?: string }[] }
          } | null
        } | null
      }
    }
  ).data?.repository?.issue

  if (issue === null || issue === undefined) {
    throw new Error('the issue was not found')
  }

  const comments = issue.comments?.nodes ?? []
  const total = issue.comments?.totalCount ?? comments.length
  const body = issue.body?.trim() === '' || issue.body === undefined ? '_No description._' : issue.body.trim()
  const parts = [body]

  if (comments.length > 0) {
    parts.push(`---\n\n**${total} comment${total === 1 ? '' : 's'}**${total > comments.length ? ` (last ${comments.length})` : ''}`)
  }

  for (const comment of comments) {
    parts.push(`**@${comment.author?.login ?? 'ghost'}** · ${(comment.createdAt ?? '').slice(0, 10)}\n\n${(comment.body ?? '').trim()}`)
  }

  return parts.join('\n\n')
}

// "Merge when green": the person's one step on a pull request into a branch
// that ships. Marked ready, its CI run starts; once the branch's required
// checks have passed in that run, the mod merges the head the person
// confirmed, and only that head. No auto-merge is left queued, and a branch
// with a merge queue is refused.

/** A branch where an epic's tickets are gathered: the session merges into it itself, and nothing ships from it. */
export const GATHERING = /^umbrella\//

/** The rules GitHub holds a branch to. */
export function rulesQuery(repo: string, base: string): string[] {
  return ['gh', 'api', `repos/${repo}/rules/branches/${base}`]
}

export type Rules = {
  /** The checks a merge into the branch waits for; none means a merge would go in with nothing run. */
  required: string[]
  /**
   * How the branch takes a merge: the first method (in the first rule's
   * order) that every pull-request rule allows and that is one of METHODS,
   * else a squash where none names any; '' where the rules share none of them.
   */
  method: string
}

/** The methods `gh pr merge` takes as flags: a word the rules name is passed on as a flag only if it is one of these. */
const METHODS = ['merge', 'squash', 'rebase']

export function parseRules(stdout: string): Rules {
  const rules = JSON.parse(stdout) as {
    type?: string
    parameters?: { allowed_merge_methods?: string[]; required_status_checks?: { context?: string }[] }
  }[]

  if (!Array.isArray(rules)) {
    throw new Error('GitHub did not list the branch rules')
  }

  const required = rules
    .filter(one => one.type === 'required_status_checks')
    .flatMap(one => one.parameters?.required_status_checks ?? [])
    .map(one => one.context ?? '')
    .filter(one => one !== '')
  // Each ruleset that applies holds a merge to its own list: only a method on every list passes them all.
  const allowed = rules.flatMap(one => (one.type === 'pull_request' && Array.isArray(one.parameters?.allowed_merge_methods) ? [one.parameters.allowed_merge_methods] : []))
  const [first] = allowed
  const method = first === undefined ? 'squash' : (first.find(one => METHODS.includes(one) && allowed.every(list => list.includes(one))) ?? '')

  return { required: [...new Set(required)], method }
}

/** Where each of a pull request's checks stands now. */
export function checksQuery(repo: string, number: number): string[] {
  return ['gh', 'pr', 'checks', String(number), '-R', repo, '--json', 'name,bucket']
}

/**
 * The pull request as it stands now, asked at the press and after the merge
 * call: what the board last read may be minutes old. GraphQL, for the
 * merge-queue fields `gh pr view` does not have.
 */
export function pullQuery(repo: string, number: number): string[] {
  const [owner = '', name = ''] = repo.split('/')

  return [
    'gh',
    'api',
    'graphql',
    '-f',
    `owner=${owner}`,
    '-f',
    `name=${name}`,
    '-F',
    `number=${number}`,
    '-f',
    'query=query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { state isDraft baseRefName headRefOid autoMergeRequest { enabledAt } isMergeQueueEnabled isInMergeQueue } } }',
  ]
}

export type PullNow = {
  isOpen: boolean
  isMerged: boolean
  isDraft: boolean
  base: string
  head: string
  hasAutoMerge: boolean
  /** Its base branch has a merge queue: a merge call there may queue it, or turn auto-merge on, instead of merging. */
  hasMergeQueue: boolean
  isInMergeQueue: boolean
}

export function parsePull(stdout: string): PullNow {
  const answer = JSON.parse(stdout) as {
    data?: {
      repository?: {
        pullRequest?: {
          state?: string
          isDraft?: boolean
          baseRefName?: string
          headRefOid?: string
          autoMergeRequest?: unknown
          isMergeQueueEnabled?: boolean
          isInMergeQueue?: boolean
        } | null
      }
    }
  }
  const pull = answer.data?.repository?.pullRequest

  if (pull === null || pull === undefined) {
    throw new Error('GitHub did not answer with the pull request')
  }

  return {
    isOpen: pull.state === 'OPEN',
    isMerged: pull.state === 'MERGED',
    isDraft: pull.isDraft === true,
    base: pull.baseRefName ?? '',
    head: pull.headRefOid ?? '',
    // Left on from an earlier round, it would merge on the ready mark itself.
    hasAutoMerge: pull.autoMergeRequest !== null && pull.autoMergeRequest !== undefined,
    hasMergeQueue: pull.isMergeQueueEnabled === true,
    isInMergeQueue: pull.isInMergeQueue === true,
  }
}

/**
 * The required checks that have no result of this run yet: absent from the
 * pull request's checks, or still showing a skipped one. The merge waits
 * while there are any.
 *
 * A draft's checks are skipped, and GitHub reads a skipped check as passed.
 * Marked ready, the pull request keeps that result until the job that
 * replaces it is created, which for a gate that waits on the test jobs is
 * when they have finished. A merge before then goes in with nothing run. One that is absent may be a skipped result still on its way (a push
 * just before the press), or a name the rules spell differently: neither is
 * known to be safe.
 */
export function unsettled(stdout: string, required: readonly string[]): string[] {
  let checks: unknown

  try {
    checks = JSON.parse(stdout)
  } catch {
    // No checks reported yet, or `gh` said something else.
    return [...required]
  }

  if (!Array.isArray(checks)) {
    return [...required]
  }

  const all = checks as { name?: string; bucket?: string }[]

  return required.filter(name => {
    const mine = all.filter(one => one.name === name)

    return mine.length === 0 || mine.some(one => one.bucket === 'skipping')
  })
}

/**
 * Where the required checks stand for a merge the mod makes itself: `green`
 * once every one has passed in this run, else the ones that failed, else the
 * ones still waiting (absent, skipped from the draft, or running).
 */
export function checksOf(stdout: string, required: readonly string[]): { isGreen: boolean; failed: string[]; waiting: string[] } {
  const early = unsettled(stdout, required)
  let all: { name?: string; bucket?: string }[] = []

  try {
    const parsed: unknown = JSON.parse(stdout)
    all = Array.isArray(parsed) ? (parsed as typeof all) : []
  } catch {
    all = []
  }

  const failed = required.filter(name => all.some(one => one.name === name && (one.bucket === 'fail' || one.bucket === 'cancel')))
  const waiting = required.filter(name => !failed.includes(name) && (early.includes(name) || all.some(one => one.name === name && one.bucket !== 'pass')))

  return { isGreen: failed.length === 0 && waiting.length === 0, failed, waiting }
}
