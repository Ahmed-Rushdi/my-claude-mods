import { expect, test } from 'claude-code/testing'

import { followUpQuery, gapOf, goalQueries, pointsOf, readGoal, REFRESH_BUDGET, shapeOf } from '../hooks/github'

const row = (number: number, more: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${number}`,
  state: 'OPEN',
  url: `https://github.com/o/r/issues/${number}`,
  blockedBy: { nodes: [] },
  closedByPullRequestsReferences: { nodes: [] },
  timelineItems: { nodes: [] },
  ...more,
})
const ref = { repo: 'o/r', numbers: [1] }
const answerOf = (rows: Record<string, unknown>) => JSON.stringify({ data: { repository: rows } })

const subs = (...numbers: number[]) => ({ subIssues: { totalCount: numbers.length, nodes: numbers.map(number => ({ number })) } })

test('#198 sub-issues listed by number alone are read in further batches of aliases, one level at a time', async () => {
  const asked: string[] = []
  // As GitHub answers: each row lists its sub-issues by number; their rows come from the next level's batch.
  const answers = [
    answerOf({ i1: row(1, subs(2)) }),
    answerOf({ i2: row(2, subs(3, 4)) }),
    answerOf({ i3: row(3, subs(5)), i4: row(4) }),
    answerOf({ i5: row(5) }),
  ]
  const read = await readGoal(ref, {}, async argv => {
    asked.push(argv.at(-1) ?? '')
    return answers[asked.length - 1] as string
  })
  expect([...read.heads, ...read.tickets].map(one => [one.number, one.parent])).toEqual([[1, null], [2, 1], [3, 2], [4, 2], [5, 3]])
  expect(asked.length).toBe(4)
  expect(asked[1]).toContain('i2: issue(')
  expect(asked[2]).toContain('i3: issue(')
  expect(asked[2]).toContain('i4: issue(')
  expect(asked[2]).not.toContain('i2: issue(')
  expect(asked[3]).toContain('i5: issue(')
  // Four requests of a few issues each: one point each, by GitHub's dry run.
  expect(read.spent).toBe(4)
})

test('#198 no more levels than the bound: deeper sub-issues are left out and said', async () => {
  const answers = [1, 2, 3, 4].map(number => answerOf({ [`i${number}`]: row(number, subs(number + 1)) }))
  let at = 0
  const read = await readGoal(ref, {}, async () => answers[at++] as string)
  expect([...read.heads, ...read.tickets].map(one => one.number)).toEqual([1, 2, 3, 4])
  expect(at).toBe(4)
  expect(read.title).toContain('1 sub-issue not shown: deeper than 3 levels')
})

test('#198 a request names at most 30 issues, each with its sub-issue list', () => {
  const queries = goalQueries({ repo: 'o/r', numbers: Array.from({ length: 61 }, (_, at) => at + 1) })
  expect(queries.length).toBe(3)
  expect(queries[0]?.at(-1)).toContain('subIssues(first: 100)')
  expect((queries[0]?.at(-1)?.match(/: issue\(/g) ?? []).length).toBe(30)
})

const batchOf = (count: number) => goalQueries({ repo: 'o/r', numbers: Array.from({ length: count }, (_, at) => at + 1) })[0] ?? []

// Pinned to GitHub's own dry run (`rateLimit(dryRun: true) { cost nodeCount }`, 2026-11-24, #198 fix round 1).
test("#198 a goal request costs what GitHub's dry run says: 1, 10 and 30 issues", () => {
  expect(shapeOf(batchOf(1))).toEqual({ nodes: 190, cost: 1 })
  expect(shapeOf(batchOf(10))).toEqual({ nodes: 1900, cost: 1 })
  expect(shapeOf(batchOf(30))).toEqual({ nodes: 5700, cost: 2 })
  expect(shapeOf(followUpQuery('o/r', Array.from({ length: 30 }, (_, at) => at + 1)))).toEqual({ nodes: 0, cost: 1 })
})

test('#198 the shape counts nested connections as GitHub does: full rows under each sub-issue were 518,130 nodes at 27 issues', () => {
  // The round-1 query, which GitHub refused (MAX_NODE_LIMIT_EXCEEDED, 518,130 nodes at 27 issues; dry-run cost 131 at 26).
  const nested = (count: number) => batchOf(count).map(one => one.replace(/subIssues\(first: 100\) \{ totalCount nodes \{ number/g, 'subIssues(first: 100) { totalCount nodes { ...Row subIssues(first: 100) { totalCount nodes { number } } number'))
  expect(shapeOf(nested(27)).nodes).toBe(518_130)
  expect(shapeOf(nested(26)).cost).toBe(131)
})

test("#198 a full batch, top level or a deeper level, stays under GitHub's 500,000 nodes", () => {
  // A deeper level is asked with the same query, by number.
  for (const query of goalQueries({ repo: 'o/r', numbers: Array.from({ length: 30 }, (_, at) => 1000 + at) })) {
    expect(shapeOf(query).nodes).toBeLessThan(500_000)
  }
  expect(shapeOf(batchOf(30)).nodes).toBeLessThan(500_000)
})

test('#198 a 200-issue goal, its sub-issue batches included, keeps the refreshes within 1,000 points an hour', async () => {
  // One named issue, its 3 sub-issues, and 196 under those, read level by level: 200 issues.
  const top = row(1, subs(2, 3, 4))
  const middle = [2, 3, 4].map(number => row(number, subs(...Array.from({ length: 66 }, (_, at) => 100 + (number - 2) * 66 + at).slice(0, number === 4 ? 64 : 66))))
  const leaves = Array.from({ length: 196 }, (_, at) => row(100 + at))
  const asked: string[][] = []
  const read = await readGoal(ref, {}, async argv => {
    asked.push(argv)
    const wanted = new Set([...(argv.at(-1) ?? '').matchAll(/\bi(\d+): issue\(/g)].map(found => Number(found[1])))
    return answerOf(Object.fromEntries([top, ...middle, ...leaves].filter(one => wanted.has(one.number)).map(one => [`i${one.number}`, one])))
  })
  expect(read.heads.length + read.tickets.length).toBe(200)
  // GitHub's dry run: 2 points a full batch of 30, 1 a smaller one; 1 + 1 + 6 x 2 + 1 (16 left over).
  expect(asked.length).toBe(9)
  expect(read.spent).toBe(15)
  const cost = pointsOf({ ...ref, tickets: read.tickets, heads: read.heads })
  expect(cost).toBeGreaterThanOrEqual(read.spent)
  const gap = gapOf(cost, read.spent)
  expect(gap).not.toBeNull()
  // Any rolling hour holds one refresh more than its whole gaps: each gap follows one that spent `read.spent`, the last may cost `cost`.
  expect(Math.floor(3_600_000 / (gap ?? 1)) * read.spent + cost).toBeLessThanOrEqual(REFRESH_BUDGET)
})
