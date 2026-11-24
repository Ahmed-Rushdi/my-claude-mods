import type { Agent, Goal, Mark, Snap, Step } from '../types'

const own = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}
const text = (value: unknown, label: string, max: number, fallback?: string): string => {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'string' || value.length > max || (fallback === undefined && value.trim() === '')) throw new Error(`${label} must be a nonempty string of at most ${max} characters.`)
  return value
}
const integer = (value: unknown, label: string, fallback?: number): number => {
  if (value === undefined && fallback !== undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive safe integer.`)
  return value as number
}
const list = (value: unknown, label: string, max: number): unknown[] => {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must contain at most ${max} items.`)
  return value
}
const fields = (value: Record<string, unknown>, allowed: string[], label: string) => {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label} contains an unsupported field.`)
}
const unique = (ids: string[], label: string) => { if (new Set(ids).size !== ids.length) throw new Error(`${label} must have unique ids.`) }

/** Presentation ages reports without renewing their source timestamps. */
export function activityAt(activity: Snap, now: number): Snap {
  return { ...activity, agents: activity.agents.map(one => ({ ...one, isStale: one.endedAt === null && now - one.activeAt >= 45 * 60_000 })) }
}

/** Validated explicit reports only: no tool observation, arbitrary writes or inferred verdicts. */
export function reportOf(input: Record<string, unknown>, current: Snap, goal: Goal, now: number): Snap {
  const result: Snap = { ...current, at: now, reportedAt: now }
  if (input.summary !== undefined) { result.goal = text(input.summary, 'summary', 240, ''); result.now = result.goal; result.nowAt = now }
  if (input.working !== undefined) {
    if (typeof input.working !== 'boolean') throw new Error('working must be a boolean.')
    if (input.working && !current.isWorking) { result.turnStartedAt = now; result.nowAt = now }
    if (!input.working && current.isWorking) result.turnMs = Math.max(0, now - current.turnStartedAt)
    result.isWorking = input.working
  }
  if (input.steps !== undefined) {
    result.steps = list(input.steps, 'steps', 100).map(value => {
      const one = own(value, 'step')
      fields(one, ['id', 'text', 'doing', 'status'], 'step')
      if (!['pending', 'in_progress', 'completed'].includes(String(one.status))) throw new Error('step status must be pending, in_progress or completed.')
      return { id: text(one.id, 'step id', 80), text: text(one.text, 'step text', 240), doing: text(one.doing, 'step doing', 240, ''), status: one.status as Step['status'], reportedAt: now }
    })
    unique(result.steps.map(one => one.id), 'steps')
  }
  if (input.agents !== undefined) {
    result.agents = list(input.agents, 'agents', 40).map(value => {
      const one = own(value, 'agent')
      fields(one, ['id', 'type', 'what', 'lane', 'ticket', 'status', 'last', 'outcome', 'pr', 'sha'], 'agent')
      const id = text(one.id, 'agent id', 80)
      const known = current.agents.find(agent => agent.id === id)
      const ticket = integer(one.ticket, 'agent ticket')
      if (!goal.numbers.includes(ticket)) throw new Error('An agent report must name an explicitly enrolled issue.')
      if (!['working', 'done', 'interrupted'].includes(String(one.status))) throw new Error('agent status must be working, done or interrupted.')
      return {
        id, type: text(one.type, 'agent type', 80), what: text(one.what, 'agent description', 240), lane: text(one.lane, 'agent lane', 240, ''),
        ticket, pr: integer(one.pr, 'agent PR', 0), sha: text(one.sha, 'agent SHA', 64, ''), startedAt: known?.startedAt ?? now,
        endedAt: one.status === 'working' ? null : known?.endedAt ?? now, calls: 0,
        last: text(one.last, 'agent last report', 240, ''), outcome: text(one.outcome, 'agent outcome', 240, ''),
        activeAt: now, reportedAt: now, isStale: false, isVerdict: false,
      } as Agent
    })
    unique(result.agents.map(one => one.id), 'agents')
  }
  if (input.marks !== undefined) {
    const reported = list(input.marks, 'marks', 60).map(value => {
      const one = own(value, 'mark')
      fields(one, ['key', 'kind', 'text', 'isBad', 'lane'], 'mark')
      if (!['commit', 'push', 'pr', 'check'].includes(String(one.kind))) throw new Error('mark kind must be commit, push, pr or check.')
      if (typeof one.isBad !== 'boolean') throw new Error('mark isBad must be a boolean.')
      return { key: text(one.key, 'mark key', 120), kind: one.kind as Mark['kind'], text: text(one.text, 'mark text', 240), isBad: one.isBad, lane: text(one.lane, 'mark lane', 240, ''), at: now }
    })
    unique(reported.map(one => one.key), 'marks')
    const keys = new Set(reported.map(one => one.key))
    result.marks = [...current.marks.filter(one => !keys.has(one.key)), ...reported].slice(-60)
  }
  if (input.reviews !== undefined) {
    const reported = list(input.reviews, 'reviews', 300).map(value => {
      const one = own(value, 'review')
      fields(one, ['pr', 'key'], 'review')
      return { pr: integer(one.pr, 'review PR'), key: text(one.key, 'review key', 120), at: now }
    })
    for (const round of reported) {
      const existing = result.rounds.find(one => one.key === round.key)
      if (existing !== undefined && existing.pr !== round.pr) throw new Error('A review key cannot change its PR.')
      if (existing === undefined) result.rounds = [...result.rounds, round].slice(-300)
    }
  }
  return result
}
