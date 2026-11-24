/** One explicitly reported work step. */
export type Step = {
  reportedAt?: number
  id: string
  text: string
  /** Its present-continuous form ("Running tests"); may be empty. */
  doing: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** One explicitly reported agent. */
export type Agent = {
  reportedAt?: number
  id: string
  type: string
  /** The spawn's own short description. */
  what: string
  /** The worktree it works in (`.claude/worktrees/<lane>`), or '' for the session's own checkout. */
  lane: string
  startedAt: number
  /** null while it runs. */
  endedAt: number | null
  calls: number
  /** What its last tool call was doing. */
  last: string
  /** The first line (or the verdict line) of its hand-back. */
  outcome: string
  /** When it last did anything: a tool call, a turn started or handed back. Its ledger writes are tool calls. */
  activeAt: number
  /** Running, with no activity for the stale time: the line "nothing moved for 45m". Cleared on activity. */
  isStale: boolean
  /** A reviewer's PR, read from its task, or 0. */
  pr: number
  /** The ticket a reviewer's task names where it names no PR outright, or 0: its PR is the goal's to say when the review ends. */
  ticket: number
  /** The head SHA a reviewer was pinned to, read from its task, or ''. */
  sha: string
  /** A reviewer whose hand-back stated a verdict. */
  isVerdict: boolean
}

/** One review round of a PR: a verdict, or the verdicts of the reviewers pinned to one SHA. */
export type Round = {
  pr: number
  /** `<pr>:<sha>`, or `<pr>:<agent id>` where the task named no SHA: a key counts once. */
  key: string
  at: number
}

/** Something the session produced: a commit, a push, a PR change, a check run. */
export type Mark = {
  /** Marks sharing a key replace each other (a PR's state, a check's latest run). */
  key: string
  kind: 'commit' | 'push' | 'pr' | 'check'
  text: string
  isBad: boolean
  lane: string
  at: number
}

export type Snap = {
  /** Last explicit activity report, not the GitHub refresh/publication time. */
  reportedAt?: number
  /** The explicit activity summary. */
  goal: string
  isWorking: boolean
  turnStartedAt: number
  /** The last finished turn's length. */
  turnMs: number
  /** Tool calls of the main loop this turn. */
  calls: number
  /** What the main loop's last tool call was doing, and when. */
  now: string
  nowAt: number
  steps: Step[]
  agents: Agent[]
  marks: Mark[]
  /** The review rounds recorded this session; a PR's round count is how many carry its number. */
  rounds: Round[]
  /** PRs that were put to the person at round 4: asked once each. */
  tasked: number[]
  /** When this snapshot was written: the clock the drawings read ages from. */
  at: number
}

/** A pull request that belongs to a ticket. */
export type Pull = {
  number: number
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  /** 'approved', 'changes requested', or '' for none yet. */
  review: string
  /** 'pass', 'fail', 'running', or '' where the PR has no checks. */
  checks: string
  branch: string
  /** Its head commit's SHA, or '' where GitHub did not say. */
  head: string
  /** The branch it merges into. */
  base: string
  /** When it merged (GitHub's ISO time), '' where it has not; absent in a goal held before it was read. */
  mergedAt?: string
  /** When it last changed on GitHub (its body among the rest), '' where GitHub did not say. */
  updatedAt?: string
  hasConflicts: boolean
  /** `owner/name` of the repository it is in (a PR that closes an issue may be in another), or '' where GitHub did not say. */
  repo: string
}

/** One issue of the goal. */
export type Ticket = {
  number: number
  title: string
  isOpen: boolean
  /** Closed as not planned or as a duplicate: it shipped nothing, so no section holds it. Absent in a goal held before it was read: a closed one is then in no section until GitHub answers. */
  isNotPlanned?: boolean
  url: string
  /** The issue it is a sub-issue of, when the goal named that one. */
  parent: number | null
  /** The numbers of the open issues GitHub says block it. */
  blockedBy: number[]
  /** The numbers its own text declares ("Blocked by: #512"), where the tracker uses no links. */
  declared: number[]
  /** Its labels' names; absent in a goal stored before they were read. */
  labels?: string[]
  pulls: Pull[]
}

/** How a section of the pane stands: open to its first five rows, open to all of them, or folded. */
export type Fold = 'open' | 'all' | 'closed'

/** What a merged PR's body closes, and the PR's updatedAt when the body was read. */
export type Closer = { at: string; closes: number[] }

/** What the session is working toward: the issues `/progress goal` named. */
export type Goal = {
  /** The sections the person changed from their default, by section id (`ready`, `deferred`, ...): kept with the goal. */
  sections?: Record<string, Fold>
  /** `owner/name`. */
  repo: string
  numbers: number[]
  /** Numbers deliberately removed from the goal. */
  removed?: number[]
  /** Legacy inferred numbers retained only for deliberate migration; new enrollment never sets this list. */
  added?: number[]
  /** Legacy inferred-number aging metadata, preserved for migration. */
  landedAt?: Record<string, number>
  title: string
  tickets: Ticket[]
  /** The named issues that have sub-issues: headings, each with a PR of its own where its sub-issues share a branch. */
  heads: Ticket[]
  /** The repository's default branch, as GitHub last named it; absent before the first answer. */
  trunk?: string
  /** What the bodies of merged PRs into umbrellas close, by PR number, with the PR's updatedAt when read: read again once it changes. */
  closers?: Record<string, Closer>
  /** When GitHub last answered; 0 before the first answer. */
  fetchedAt: number
  /** Why the last refresh failed, or ''. */
  error: string
}

/** The issue open in the pane's reader. */
export type Doc = {
  number: number
  /** Its body and comments as Markdown; '' while loading. */
  text: string
  error: string
}

/**
 * The person's "merge when green" on one pull request: asked to confirm, at
 * work, armed (merged, or in the merge queue), or failed with why.
 */
export type Ship = {
  /** Identity of the exact two-step owner confirmation; absent in older receipts. */
  confirmation_id?: string
  pull: number
  step: 'confirm' | 'working' | 'armed' | 'failed'
  note: string
  /** The head SHA and the base branch the person confirmed: the merge is of these, or none. */
  head: string
  base: string
  /** The pull request's repository, owner/name: its note shows only on that repository's PR. */
  repo: string
}

/** Optional version-1 Overview extension: native owner state and explicit web permission. */
export type OwnerSnapshot = {
  enabled: boolean
  targets: { ticket: number; repo: string; pull: number; head: string; base: string; isDraft: boolean }[]
  ship: Ship | null
}

/** Where a Button stands after a press: struck at once, at work, told again while at work, or finished. */
export type Phase = 'pressed' | 'working' | 'again' | 'done' | 'failed'

declare module 'claude-code' {
  interface PluginState {
    progress: { snap: Shaped<Snap>; goal: Shaped<Goal | null>; doc: Doc | null; ship: Shaped<Ship | null>; feel: Record<string, Phase> }
    /**
     * The human-in-the-loop plugin's own, read here only (#158): the dashboard's
     * line once it is set up, stamped with when it was read (`at`, `$.clock.now()`
     * ms) and a rising number (`seq`), else null. The member is the same as that
     * plugin's declaration of it (mods/human-in-the-loop/types/index.d.ts): keep
     * both the same. One shared declaration is not possible: `claude plugin
     * validate` needs the owner's whole contract as a literal object there.
     */
    'human-in-the-loop': { dashboard: { line: string; at: number; seq: number } | null }
  }
}
