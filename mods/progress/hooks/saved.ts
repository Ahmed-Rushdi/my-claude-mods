import type { Goal, Snap } from '../types'

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const string = (value: unknown): value is string => typeof value === 'string' && value.length <= 20_000
const time = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const positive = (value: unknown): value is number => time(value) && value > 0
const list = (value: unknown, max: number, valid: (item: unknown) => boolean): boolean => Array.isArray(value) && value.length <= max && value.every(valid)
const optional = (value: unknown, valid: (item: unknown) => boolean) => value === undefined || valid(value)
const round = (value: unknown) => record(value) && positive(value.pr) && string(value.key) && time(value.at)
const step = (value: unknown) => record(value) && string(value.id) && string(value.text) && string(value.doing) && ['pending', 'in_progress', 'completed'].includes(String(value.status)) && optional(value.reportedAt, time)
const agent = (value: unknown) => record(value) && ['id', 'type', 'what', 'lane', 'last', 'outcome', 'sha'].every(key => string(value[key])) && ['startedAt', 'calls', 'activeAt', 'pr', 'ticket'].every(key => time(value[key])) && (value.endedAt === null || time(value.endedAt)) && typeof value.isStale === 'boolean' && typeof value.isVerdict === 'boolean' && optional(value.reportedAt, time)
const mark = (value: unknown) => record(value) && ['key', 'text', 'lane'].every(key => string(value[key])) && ['commit', 'push', 'pr', 'check'].includes(String(value.kind)) && typeof value.isBad === 'boolean' && time(value.at)
const pull = (value: unknown) => record(value) && positive(value.number) && ['OPEN', 'CLOSED', 'MERGED'].includes(String(value.state)) && typeof value.isDraft === 'boolean' && typeof value.hasConflicts === 'boolean' && ['review', 'checks', 'branch', 'head', 'base', 'repo'].every(key => string(value[key])) && optional(value.mergedAt, string) && optional(value.updatedAt, string)
const ticket = (value: unknown) => record(value) && positive(value.number) && string(value.title) && string(value.url) && /\/issues\/\d+$/.test(value.url) && typeof value.isOpen === 'boolean' && optional(value.isNotPlanned, one => typeof one === 'boolean') && (value.parent === null || positive(value.parent)) && list(value.blockedBy, 200, positive) && list(value.declared, 200, positive) && optional(value.labels, one => list(one, 100, string)) && list(value.pulls, 100, pull)

/** Persisted plugin data is untrusted input too; malformed reports restore nothing. */
export function savedActivity(value: unknown): Snap | undefined {
  if (!record(value) || !string(value.goal) || !string(value.now) || typeof value.isWorking !== 'boolean' ||
      !['turnStartedAt', 'turnMs', 'calls', 'nowAt', 'at'].every(key => time(value[key])) ||
      !optional(value.reportedAt, time) || !list(value.steps, 100, step) || !list(value.agents, 40, agent) ||
      !list(value.marks, 60, mark) || !list(value.rounds, 300, round) || !list(value.tasked, 300, positive)) return undefined
  return value as Snap
}

export function savedGoal(value: unknown): Goal | undefined {
  if (!record(value) || !string(value.repo) || !string(value.title) || !string(value.error) ||
      !time(value.fetchedAt) || !list(value.numbers, 200, positive) || !list(value.tickets, 200, ticket) ||
      !list(value.heads, 200, ticket) || !optional(value.trunk, string)) return undefined
  return value as Goal
}
