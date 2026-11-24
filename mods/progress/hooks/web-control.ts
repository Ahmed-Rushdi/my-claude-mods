import type { EngineInterface } from 'claude-code'

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const REQUEST = /^[0-9a-f]{32}$/
const MAX_LINE = 4096

export type OwnerAction = { request_id: string; action: 'prepare' | 'confirm' | 'cancel'; repo: string; pull: number; head: string; base: string; confirmation_id: string }
export type OwnerOutcome = 'prepared' | 'started' | 'cancelled' | 'rejected' | 'disabled' | 'gone' | 'failed' | 'busy'

// Keep in sync with dashboard/server.py and hooks/web_control.py owner_request: one shared
// accept/refuse table, tests/owner-request-cases.ts (run by tests/owner-request.test.ts).
export function isOwnerRequest(value: Record<string, unknown>): boolean {
  return Object.keys(value).sort().join(',') === 'action,base,confirmation_id,head,pull,repo,request_id,session_id'
    && typeof value.session_id === 'string' && SESSION.test(value.session_id)
    && typeof value.request_id === 'string' && REQUEST.test(value.request_id)
    && typeof value.action === 'string' && ['prepare', 'confirm', 'cancel'].includes(value.action)
    && typeof value.repo === 'string' && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value.repo)
    && Number.isSafeInteger(value.pull) && Number(value.pull) > 0
    && typeof value.head === 'string' && /^[a-fA-F0-9]{40,64}$/.test(value.head)
    && typeof value.base === 'string' && value.base.length > 0 && [...value.base].length <= 256 && !/[\x00-\x20\x7f]/.test(value.base)
    && typeof value.confirmation_id === 'string' && [...value.confirmation_id].length <= 200
    && (value.action === 'prepare' ? value.confirmation_id === '' : value.confirmation_id.length > 0)
}

export type RefreshOutcome = 'refreshed' | 'gone' | 'failed' | 'busy'

export type WebControl = {
  readonly sessionId: string
  isRunning(): boolean
  isReady(): boolean
  failure(): string | undefined
  stop(): Promise<void>
}

/** Only the caller refreshes/publishes native state; this transport never does. */
export function startWebControl($: EngineInterface, sessionId: string, refreshAndPublish: () => Promise<RefreshOutcome>, ownerAction?: (request: OwnerAction) => Promise<OwnerOutcome>): WebControl {
  if (!SESSION.test(sessionId)) throw new Error('Progress web controls need a canonical UUID session.')
  const stream = $.process.spawn({ argv: ['python3', '-I', `${$.plugin.root}/hooks/web_control.py`, `--session=${sessionId}`, ...(ownerAction ? ['--owner'] : [])] })
  let results: string | undefined
  let stopped = false
  let ended = false
  let busy = false
  let failure: string | undefined

  const isMine = async () => !stopped && !ended && await $.session.id().catch(() => '') === sessionId
  const stopFile = async () => {
    if (results && await $.fs.exists(results).catch(() => false)) await $.fs.write(`${results}/stop`, '').catch(() => undefined)
  }
  const reply = async (requestId: string, outcome: string) => {
    const path = results && `${results}/${requestId}.json`
    // The listener precreates this private file and removes it on expiry.
    if (path && await $.fs.exists(path).catch(() => false)) {
      await $.fs.write(path, JSON.stringify({ request_id: requestId, outcome })).catch(() => undefined)
    }
  }

  const onLine = async (text: string) => {
    let line: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
      line = parsed as Record<string, unknown>
    } catch { return }
    if (results === undefined) {
      const path = line.results
      if (line.type !== 'ready' || line.session_id !== sessionId || typeof path !== 'string' || path.length > 4096
          || !path.startsWith('/') || path.includes('\0') || path.split('/').some(part => part === '.' || part === '..')
          || !/\/progress-endpoint\/[1-9][0-9]{0,9}-[0-9a-f]{16}\.results$/.test(path)) return
      results = path
      if (stopped) await stopFile()
      return
    }
    const { type, ...request } = line
    const { session_id, ...action } = request
    const owner = type === 'owner' && isOwnerRequest(request)
    if (session_id !== sessionId || typeof line.request_id !== 'string' || !REQUEST.test(line.request_id)
        || !(owner || type === 'refresh' && Object.keys(line).length === 3)) return
    if (owner && !ownerAction) { await reply(line.request_id, 'disabled'); return }
    const requestId = line.request_id
    if (!await isMine()) { await reply(requestId, 'gone'); return }
    if (busy) { await reply(requestId, 'busy'); return }
    busy = true
    try {
      // Recheck after taking the single-refresh slot, before calling the native owner.
      if (!await isMine()) { await reply(requestId, 'gone'); return }
      const outcome = owner ? await ownerAction!(action as OwnerAction) : await refreshAndPublish()
      await reply(requestId, await isMine() ? outcome : 'gone')
    } catch {
      await reply(requestId, await isMine() ? 'failed' : 'gone')
    } finally { busy = false }
  }

  void (async () => {
    let buffer = ''
    let skipping = false
    try {
      for await (const chunk of stream) {
        if (chunk.stream === 'stderr') {
          failure = ((failure ?? '') + chunk.text).slice(-MAX_LINE)
          continue
        }
        if (chunk.stream !== 'stdout') continue
        for (const part of chunk.text.split(/(?<=\n)/)) {
          if (!skipping) buffer += part
          if (buffer.length > MAX_LINE) { buffer = ''; skipping = true }
          if (part.endsWith('\n')) {
            if (!skipping) void onLine(buffer).catch(() => undefined)
            buffer = ''; skipping = false
          }
        }
      }
    } catch { failure = 'Progress web control listener could not run.' }
    finally { ended = true }
  })()

  return {
    sessionId,
    isRunning: () => !stopped && !ended,
    isReady: () => !stopped && !ended && results !== undefined,
    failure: () => ended && !stopped && !results ? failure?.trim().slice(-300) || 'Progress web control listener ended before it was ready.' : undefined,
    async stop() {
      if (stopped) return
      stopped = true
      await stopFile()
      void stream.return({ code: null, signal: null }).catch(() => undefined)
    },
  }
}
