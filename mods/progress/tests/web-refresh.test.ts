import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const SESSION = '5f0c6a2e-1b7d-4c39-9e51-0a7e3d2b8c41'
const OTHER = '0d9e3c55-6f2a-4b7e-8a1d-2c3b4a5f6e70'
const RESULTS = '/tmp/profile/progress-endpoint/123-0123456789abcdef.results'
const command = ($: Engine, args: string) => $.command.run({ command: 'progress', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

async function world($: Engine, on: On, saved: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const store: Record<string, any> = { ...saved }
  const opened: string[] = []
  const stopped: string[] = []
  const spawned: string[][] = []
  let session = SESSION
  let title = 'Before refresh'
  let hasPull = false
  let head = 'a'.repeat(40)
  let reads = 0
  let fail = false
  let gate: Promise<void> | undefined
  let entered: (() => void) | undefined
  let send!: (line: string) => void
  let pending = new Promise<string>(resolve => { send = resolve })
  let request = 0
  const replies = new Map<string, (outcome: string) => void>()
  on('session.id', () => ({ value: session }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.repo', () => ({ value: { root: '/repo', remote: 'git@github.com:o/r.git', internal: false, name: null } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__progress__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => { store[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_, e) => { delete store[e.key]; return { value: undefined } })
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('ui.open', (_, e) => { opened.push(e.id); return { value: { isPlaced: true } } })
  on('ui.close', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.write', (_, e) => {
    if (e.path.endsWith('/stop')) stopped.push(e.path)
    if (e.path.endsWith('.json')) {
      const reply = JSON.parse(e.text)
      replies.get(reply.request_id)?.(reply.outcome)
    }
    return { value: undefined }
  })
  on('process.spawn', async function* (_, e) {
    spawned.push([...e.argv])
    yield { stream: 'stdout', text: JSON.stringify({ type: 'ready', session_id: session, results: RESULTS }) + '\n' }
    while (true) {
      const line = await pending
      pending = new Promise<string>(resolve => { send = resolve })
      if (line === 'end') break
      yield { stream: 'stdout', text: line }
    }
    return { value: { code: 0, signal: null } }
  })
  on('process.run', async () => {
    reads += 1
    entered?.()
    await gate
    if (fail) return { value: { exitCode: 1, stdout: '', stderr: 'GitHub unavailable', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false, stdout: JSON.stringify({ data: { repository: {
      i7: { number: 7, title, state: 'OPEN', url: 'https://github.com/o/r/issues/7', blockedBy: { nodes: [] }, closedByPullRequestsReferences: { nodes: hasPull ? [{ number: 24, state: 'OPEN', isDraft: true, reviewDecision: null, headRefName: 'feature', headRefOid: head, baseRefName: 'main', repository: { nameWithOwner: 'o/r' }, statusCheckRollup: null }] : [] }, timelineItems: { nodes: [] } },
    } } }) } }
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  return {
    pull: () => { hasPull = true }, head: (value: string) => { head = value },
    owner: (fields: Record<string, unknown> = {}) => { const id = typeof fields.request_id === 'string' ? fields.request_id : (++request).toString(16).padStart(32, '0'); const result = new Promise<string>(resolve => replies.set(id, resolve)); send(JSON.stringify({ type: 'owner', session_id: SESSION, request_id: id, action: 'prepare', repo: 'o/r', pull: 24, head, base: 'main', confirmation_id: '', ...fields }) + '\n'); return result },
    clock, store, opened, spawned, stopped, reads: () => reads,
    fail: () => { fail = true },
    title: (value: string) => { title = value }, session: (value: string) => { session = value },
    hold: () => { let release!: () => void; gate = new Promise<void>(resolve => { release = resolve }); const reached = new Promise<void>(resolve => { entered = resolve }); return { release: () => { gate = undefined; release() }, reached } },
    refresh: () => { const id = (++request).toString(16).padStart(32, '0'); const result = new Promise<string>(resolve => replies.set(id, resolve)); send(JSON.stringify({ type: 'refresh', session_id: SESSION, request_id: id }) + '\n'); return result },
    end: async () => { send('end'); await $.session.end({ sessionId: session, reason: 'logout' } as never) },
  }
}

test('web refresh stays off by default after explicit open', async ($, on) => {
  const w = await world($, on)
  await command($, '')
  expect(w.spawned).toEqual([])
})

test('enabled web refresh starts only after explicit open, and session end stops it', { options: { web_controls: true } }, async ($, on) => {
  const w = await world($, on)
  expect(w.spawned).toEqual([])
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(w.spawned).toEqual([])
  await command($, '')
  expect(w.spawned.length).toBe(1)
  await w.end()
  expect(w.stopped.length).toBe(1)
})

test('hidden web refresh publishes current GitHub metadata without opening UI or restarting polling', { options: { web_controls: true } }, async ($, on) => {
  const w = await world($, on)
  await command($, 'goal 7')
  await command($, 'hide')
  const opens = w.opened.length
  const reads = w.reads()
  w.title('Updated from GitHub')
  expect(await w.refresh()).toBe('refreshed')
  expect(w.store[`overview:${SESSION}`].goal.tickets[0].title).toBe('Updated from GitHub')
  expect(w.opened.length).toBe(opens)
  await w.clock.advance(600_000)
  expect(w.reads()).toBe(reads + 1)
  expect(w.stopped).toEqual([])
  await w.end()
})

for (const interrupt of ['hide', 'selection', 'session-change', 'session-end']) {
  test(`web refresh discards an in-flight result after ${interrupt}`, { options: { web_controls: true } }, async ($, on) => {
    const w = await world($, on)
    await command($, 'goal 7')
    await command($, 'hide')
    const original = JSON.stringify(w.store[`overview:${SESSION}`])
    w.title('Must not arrive')
    const held = w.hold()
    const result = w.refresh()
    await held.reached
    if (interrupt === 'hide') await command($, 'hide')
    if (interrupt === 'selection') await command($, 'remove 7')
    if (interrupt === 'session-change') { w.session(OTHER); await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true }) }
    if (interrupt === 'session-end') await $.session.end({ sessionId: SESSION, reason: 'logout' } as never)
    const beforeRelease = JSON.stringify(w.store[`overview:${SESSION}`])
    held.release()
    expect(await result).toBe('gone')
    expect(JSON.stringify(w.store[`overview:${SESSION}`])).toBe(beforeRelease)
    if (interrupt === 'hide') expect(beforeRelease).toBe(original)
    if (interrupt === 'session-change' || interrupt === 'session-end') expect(w.stopped.length).toBe(1)
    await w.end()
  })
}

test('web refresh publishes empty selections, including a session without a goal', { options: { web_controls: true } }, async ($, on) => {
  const w = await world($, on)
  await command($, '')
  await command($, 'hide')
  await w.clock.advance(1000)
  expect(await w.refresh()).toBe('refreshed')
  expect(w.store[`overview:${SESSION}`].at).toBe(1_700_000_001_000)
  expect(w.store[`overview:${SESSION}`].goal).toBe(null)
  await command($, 'goal 7')
  await command($, 'remove 7')
  await command($, 'hide')
  await w.clock.advance(1000)
  const reads = w.reads()
  expect(await w.refresh()).toBe('refreshed')
  expect(w.store[`overview:${SESSION}`].goal.title).toBe('No issues')
  expect(w.store[`overview:${SESSION}`].at).toBe(1_700_000_002_000)
  expect(w.reads()).toBe(reads)
  await w.end()
})

for (const invocation of ['enroll', 'publish', 'refresh']) {
  test(`explicit ${invocation} enables the listener for a resumed selection`, { options: { web_controls: true } }, async ($, on) => {
    const w = await world($, on, { [`goal:${SESSION}`]: { repo: 'o/r', numbers: [7] } })
    expect(w.spawned).toEqual([])
    if (invocation === 'enroll') await $.tool.call({ tool: 'mcp__progress__enroll', issues: '7' })
    else if (invocation === 'publish') expect((await $.tool.call({ tool: 'mcp__progress__publish', session_id: SESSION, repo: 'o/r', summary: 'Explicit report' })).deny).toBeUndefined()
    else await command($, 'refresh')
    expect(w.spawned.length).toBe(1)
    if (invocation === 'publish') expect(w.opened).toEqual([])
    await w.end()
  })
}

test('web refresh reports busy for overlap and failed for GitHub errors', { options: { web_controls: true } }, async ($, on) => {
  const w = await world($, on)
  await command($, 'goal 7')
  await command($, 'hide')
  const held = w.hold()
  const first = w.refresh()
  await held.reached
  expect(await w.refresh()).toBe('busy')
  held.release()
  expect(await first).toBe('refreshed')
  w.fail()
  expect(await w.refresh()).toBe('failed')
  expect(w.store[`overview:${SESSION}`].goal.error).toBe('GitHub unavailable')
  expect(w.store[`overview:${SESSION}`].goal.tickets[0].title).toBe('Before refresh')
  await w.end()
})

test('owner web permission is separate from existing refresh permission', { options: { web_controls: true, owner_workflow: true } }, async ($, on) => {
  const w = await world($, on)
  await command($, 'goal 7')
  expect(w.store[`overview:${SESSION}`].owner).toEqual({ enabled: false, targets: [], ship: null })
  expect(w.spawned[0]).not.toContain('--owner')
  await w.end()
})


test('web owner prepare and cancel share native confirmation and publication, without GitHub writes', { options: { web_controls: true, owner_workflow: true, web_owner_workflow: true } }, async ($, on) => {
  const w = await world($, on)
  w.pull()
  await command($, 'goal 7')
  expect(w.spawned[0]).toContain('--owner')
  const snapshot = () => w.store[`overview:${SESSION}`].owner
  expect(snapshot().targets).toEqual([{ ticket: 7, repo: 'o/r', pull: 24, head: 'a'.repeat(40), base: 'main', isDraft: true }])
  const reads = w.reads()
  expect(await w.owner({ action: 'confirm', confirmation_id: 'missing' })).toBe('rejected')
  expect(await w.owner()).toBe('prepared')
  const confirmation = snapshot().ship.confirmation_id
  expect(snapshot().ship).toEqual({ repo: 'o/r', pull: 24, head: 'a'.repeat(40), base: 'main', step: 'confirm', note: '', confirmation_id: confirmation })
  expect(await w.owner({ action: 'cancel', confirmation_id: confirmation })).toBe('cancelled')
  expect(snapshot().ship).toBe(null)
  expect(await w.owner({ action: 'confirm', confirmation_id: confirmation })).toBe('rejected')
  expect(w.reads()).toBe(reads)
  await w.end()
})

test('web owner consumes one confirmation, publishes failed receipt, and refuses replay or changed heads', { options: { web_controls: true, owner_workflow: true, web_owner_workflow: true } }, async ($, on) => {
  const w = await world($, on)
  w.pull()
  await command($, 'goal 7')
  expect(await w.owner({ request_id: 'a'.repeat(32) })).toBe('prepared')
  const ship = () => w.store[`overview:${SESSION}`].owner.ship
  const confirmation = ship().confirmation_id
  expect(await w.owner({ action: 'confirm', confirmation_id: confirmation, head: 'b'.repeat(40) })).toBe('rejected')
  // The synthetic GitHub fixture cannot satisfy a merge read: it fails safely.
  const request = { request_id: 'b'.repeat(32), action: 'confirm', confirmation_id: confirmation }
  expect(await w.owner(request)).toBe('started')
  expect(ship().step).toBe('failed')
  const reads = w.reads()
  expect(await w.owner(request)).toBe('started')
  expect(w.reads()).toBe(reads)
  expect(await w.owner({ action: 'confirm', confirmation_id: confirmation })).toBe('rejected')
  // An explicit retry prepares a new identity; a previous confirmation cannot consume it.
  expect(await w.owner()).toBe('prepared')
  expect(ship().confirmation_id).not.toBe(confirmation)
  expect(await w.owner({ action: 'confirm', confirmation_id: confirmation })).toBe('rejected')
  await w.end()
})

test('overlapping owner requests stay single-flight and selection changes while awaiting stop the native job', { options: { web_controls: true, owner_workflow: true, web_owner_workflow: true } }, async ($, on) => {
  const w = await world($, on)
  w.pull()
  await command($, 'goal 7')
  expect(await w.owner()).toBe('prepared')
  const confirmation = w.store[`overview:${SESSION}`].owner.ship.confirmation_id
  const held = w.hold()
  const reads = w.reads()
  const pending = w.owner({ action: 'confirm', confirmation_id: confirmation })
  await held.reached
  expect(await w.owner({ action: 'confirm', confirmation_id: confirmation })).toBe('busy')
  await command($, 'remove 7')
  held.release()
  expect(await pending).toBe('started')
  expect(w.reads()).toBe(reads + 1)
  expect(w.store[`overview:${SESSION}`].owner.ship.step).toBe('failed')
  await w.end()
})

test('ending an owner confirmation publishes its cancellation and disables the ended snapshot', { options: { web_controls: true, owner_workflow: true, web_owner_workflow: true } }, async ($, on) => {
  const w = await world($, on)
  w.pull()
  await command($, 'goal 7')
  expect(await w.owner()).toBe('prepared')
  await w.end()
  expect(w.store[`overview:${SESSION}`].owner.ship).toBe(null)
  expect(w.store[`overview:${SESSION}`].owner.enabled).toBe(false)
})
