/**
 * A fixture answer as GitHub gives it to `goalQueries` (#198 r1): a sub-issue is listed under its parent by
 * number and repository only, and its own row is answered under its alias when a request asks for it. Fixtures
 * write the tree with full rows nested; this keeps them readable while the code meets GitHub's shape.
 */
export function asGitHub(answer: any, asked: string): any {
  const repository = answer?.data?.repository
  if (repository === null || typeof repository !== 'object') return answer
  const rows = new Map<number, any>()
  const trim = (row: any) => {
    const nodes = row?.subIssues?.nodes
    if (!Array.isArray(nodes)) return
    for (const child of nodes) {
      if (typeof child?.title === 'string' && !rows.has(child.number)) {
        rows.set(child.number, child)
        trim(child)
      }
    }
    row.subIssues = { ...row.subIssues, nodes: nodes.map((child: any) => ({ number: child.number, ...(child.repository === undefined ? {} : { repository: child.repository }) })) }
  }

  for (const [alias, row] of Object.entries(repository)) if (/^i\d+$/.test(alias)) trim(row)
  for (const [, number = ''] of asked.matchAll(/\bi(\d+): issue\(/g)) {
    if (rows.has(Number(number))) repository[`i${number}`] ??= rows.get(Number(number))
  }

  return answer
}
