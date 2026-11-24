// The session's side of the answer endpoint: it starts the listener
// (answer_endpoint.py) as a child of the session, reads the requests the
// listener passed on, hands each to the mod, and writes the outcome where
// the listener waits for it. The caller's contract: README.md, "Answer endpoint".
import type { EngineInterface } from 'claude-code'

import type { Task, TaskState } from '../types'
import { hashOf } from './project'
import { isActive, isArchived, isExpired, looksSecret } from './tasks'
import { oneLine } from './text'

/** The longest answer, and reason, the endpoint takes, in characters (agent decision: the pane has no cap). */
export const MAX_ANSWER = 10_000
export const MAX_REASON = 1_000

/** A line the listener prints that has not ended yet: past this many characters it is dropped. */
const MAX_LINE = 1_048_576

/** Requests remembered by request_id, per process, so one handed on again gets its first outcome. */
const REMEMBERED = 256

const ACTIONS = ['done', 'choose', 'answer', 'reject', 'archive', 'restore'] as const
type Action = (typeof ACTIONS)[number]

/** The actions that answer nothing: they archive an open task, or restore an archived one, and send Claude nothing. */
export type ShelfAction = Extract<Action, 'archive' | 'restore'>

export function isShelfAction(action: Action): action is ShelfAction {
  return action === 'archive' || action === 'restore'
}

/** Where an answer came from, as the decision log names it. */
export type Source = 'pane' | 'endpoint' | 'phone'

/** One answer request the listener passed on: its own checks made, the session's still to make. */
export type Request = {
  requestId: string
  sessionId: string
  taskId: number
  createdMs: number
  /** The task's `updatedMs` as the caller saw it. */
  version: number
  action: Action
  option?: string
  text?: string
  reason?: string
  source: Exclude<Source, 'pane'>
}

export type Outcome = 'accepted' | 'unknown' | 'stale' | 'closed' | 'gone' | 'refused' | 'busy' | 'reused'

/** The task as an outcome names it: no title, no answer. */
export type TaskInfo = { session_id: string; id: number; created_ms: number; version: number; state: TaskState }

/** What the session answers a request with; the listener sends it on with the outcome's status. */
export type Answered = { outcome: Outcome; message?: string; task?: TaskInfo }

/** What a request does to its task: the patch a press in the pane makes, or why none applies. */
export type Patch = Pick<Task, 'state'> & Partial<Pick<Task, 'answer' | 'reason'>>

/** A running listener, as the session holds it. */
export type Endpoint = {
  readonly sessionId: string
  /** Whether its listener still runs and the session has not stopped it. */
  isRunning(): boolean
  /** Whether it runs and said it is ready: it takes answers. */
  isReady(): boolean
  /** Has the listener end: its stop file, then its stream. Requests that arrive meanwhile are told the session is gone. */
  stop(): Promise<void>
  /** Why it ended before it was ready, in the last line it printed on stderr; undefined while it runs, once it was ready, or once stopped. */
  failure(): string | undefined
}

/** What is kept of the listener's stderr, its last characters. */
const MAX_STDERR = 4096

const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/

/** Whether a session id is one the listener takes, and so one to name a file by. */
export function isListenable(sessionId: string): boolean {
  return SESSION_ID.test(sessionId)
}

/** What the session remembers of each request: a hash of it (`digestOf`), never the request. */
const remembered = new Map<string, { digest: string; answered: Promise<Answered> }>()

/**
 * Starts the listener for `sessionId` and answers each request it passes on
 * with `apply`. A request whose request_id was answered before in this
 * process (the listener restarted, or handed it on again) gets that first
 * outcome and is not applied again; the same request_id with another request
 * is `reused`.
 */
export function startEndpoint($: EngineInterface, sessionId: string, apply: (request: Request) => Promise<Answered>, onChange: () => void = () => {}): Endpoint {
  let results: string | undefined
  let isEnded = false
  // The caller's display only: a throw from it must not end the listener's loop.
  const changed = () => {
    try {
      onChange()
    } catch {
      // Nothing to undo: the next change shows again.
    }
  }
  let isStopping = false

  // One argument, so a session id that starts with a dash is not read as an option.
  const stream = $.process.spawn({ argv: ['python3', '-I', `${$.plugin.root}/hooks/answer_endpoint.py`, `--session=${sessionId}`] })

  /** Writes the outcome where the listener looks, unless its directory is gone (the listener ended): a write would make it again. */
  const reply = async (requestId: string, answered: Answered) => {
    const dir = results

    if (dir !== undefined && (await $.fs.exists(dir).catch(() => false))) {
      await $.fs.write(`${dir}/${requestId}.json`, JSON.stringify({ request_id: requestId, ...answered })).catch(() => undefined)
    }
  }

  const writeStop = async () => {
    const dir = results

    if (dir !== undefined && (await $.fs.exists(dir).catch(() => false))) {
      await $.fs.write(`${dir}/stop`, '').catch(() => undefined)
    }
  }

  const onLine = async (text: string) => {
    let line: unknown

    try {
      line = JSON.parse(text)
    } catch {
      return
    }

    if (results === undefined) {
      results = resultsOf(line, sessionId)

      if (results !== undefined && isStopping) {
        await writeStop()
      }

      if (results !== undefined) {
        changed()
      }

      return
    }

    const requestId = (line as { request_id?: unknown } | null)?.request_id

    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
      return
    }

    const request = requestOf(line)

    if (request === undefined) {
      await reply(requestId, { outcome: 'refused', message: 'The request did not reach the session whole.' })
      return
    }

    if (isStopping || request.sessionId !== sessionId) {
      await reply(requestId, { outcome: 'gone', message: 'The session has ended.' })
      return
    }

    await reply(requestId, await once(sessionId, request, apply))
  }

  let stderr = ''
  let startError = ''

  void (async () => {
    let buffer = ''
    let isSkipping = false

    try {
      for await (const chunk of stream) {
        if (chunk.stream === 'stderr') {
          stderr = (stderr + chunk.text).slice(-MAX_STDERR)
        }

        if (chunk.stream !== 'stdout') {
          continue
        }

        buffer += chunk.text
        let end = buffer.indexOf('\n')

        while (end >= 0) {
          const text = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)

          if (!isSkipping) {
            void onLine(text)
          }

          isSkipping = false
          end = buffer.indexOf('\n')
        }

        // A line longer than any request the listener passes on is no request: it is skipped to its end.
        if (buffer.length > MAX_LINE) {
          buffer = ''
          isSkipping = true
        }
      }
    } catch (error) {
      // It could not start (no python3), or it was ended: the heartbeat starts another.
      startError = error instanceof Error ? error.message : String(error)
    } finally {
      isEnded = true
      changed()
    }
  })()

  return {
    sessionId,
    isRunning: () => !isEnded && !isStopping,
    isReady: () => !isEnded && !isStopping && results !== undefined,
    failure() {
      const said = oneLine(stderr.trim().split('\n').at(-1) ?? '') || oneLine(startError)

      return isEnded && !isStopping && results === undefined ? said.slice(0, 300) || 'it ended before it was ready.' : undefined
    },
    async stop() {
      if (isStopping) {
        return
      }

      isStopping = true
      // The stop file ends the listener whatever ending the stream does to a
      // child it is still reading; its parent gone ends it too.
      await writeStop()
      void stream.return({ code: null, signal: null }).catch(() => undefined)
    },
  }
}

/** `apply`'s outcome for `request`, once per request_id: a request handed on again gets the first outcome. */
async function once(sessionId: string, request: Request, apply: (request: Request) => Promise<Answered>): Promise<Answered> {
  const key = `${sessionId} ${request.requestId}`
  const digest = digestOf(request)
  const known = remembered.get(key)

  if (known !== undefined) {
    return known.digest === digest ? known.answered : { outcome: 'reused', message: 'This request_id was used for another request.' }
  }

  const answered = apply(request).catch((): Answered => ({ outcome: 'busy', message: 'The session could not apply it; send the same request again.' }))
  remembered.set(key, { digest, answered })

  while (remembered.size > REMEMBERED) {
    remembered.delete(remembered.keys().next().value as string)
  }

  const outcome = await answered

  // One the session could not take now is tried again when it comes again,
  // and so is one still under way as its session ended, of which nothing was
  // applied: after a resume in place, the same session judges it afresh.
  if (outcome.outcome === 'busy' || outcome.outcome === 'gone') {
    remembered.delete(key)
  }

  return outcome
}

/**
 * A short hash of the request's fields in a fixed order, with their length:
 * two requests alike have one digest, and up to 256 remembered requests hold
 * a few kilobytes, not their texts. Two different requests sharing a
 * request_id and a digest (a 53-bit hash: only by design) get the first one's
 * outcome rather than `reused`; neither is applied twice.
 */
export function digestOf(request: Request): string {
  const fields = JSON.stringify([
    request.sessionId,
    request.taskId,
    request.createdMs,
    request.version,
    request.action,
    request.option ?? null,
    request.text ?? null,
    request.reason ?? null,
    request.source,
  ])

  return `${fields.length}:${hashOf(fields)}`
}

/** The results directory a ready line names: `<...>/hitl-endpoint/<session>.<pid>.results`, or undefined. */
function resultsOf(line: unknown, sessionId: string): string | undefined {
  const ready = line as { type?: unknown; results?: unknown } | null
  const path = ready?.type === 'ready' && typeof ready.results === 'string' ? ready.results : undefined
  const name = path?.split('/').at(-1) ?? ''
  const pid = name.startsWith(`${sessionId}.`) && name.endsWith('.results') ? name.slice(sessionId.length + 1, -'.results'.length) : ''

  return path !== undefined && path.startsWith('/') && path.split('/').at(-2) === 'hitl-endpoint' && /^[0-9]{1,10}$/.test(pid) ? path : undefined
}

const isWhole = (value: unknown, low: number): value is number => Number.isSafeInteger(value) && (value as number) >= low

/** A request line as the listener prints it, checked again here; undefined when it is not one. */
export function requestOf(line: unknown): Request | undefined {
  if (line === null || typeof line !== 'object') {
    return undefined
  }

  const raw = line as Record<string, unknown>
  const { request_id, session_id, task_id, created_ms, version, action, option, text, reason, source } = raw
  const known = ['type', 'request_id', 'session_id', 'task_id', 'created_ms', 'version', 'action', 'option', 'text', 'reason', 'source']
  const texts = { choose: ['option'], answer: ['text'], reject: ['reason'], done: [], archive: [], restore: [] } as Record<string, string[] | undefined>
  const allowed = texts[String(action)]

  if (
    raw['type'] !== 'answer' ||
    Object.keys(raw).some(key => !known.includes(key)) ||
    typeof request_id !== 'string' ||
    !REQUEST_ID.test(request_id) ||
    typeof session_id !== 'string' ||
    !SESSION_ID.test(session_id) ||
    !isWhole(task_id, 1) ||
    !isWhole(created_ms, 0) ||
    !isWhole(version, 0) ||
    !ACTIONS.includes(action as Action) ||
    allowed === undefined ||
    ['option', 'text', 'reason'].some(key => raw[key] !== undefined && (!allowed.includes(key) || typeof raw[key] !== 'string')) ||
    (action === 'choose' && option === undefined) ||
    (action === 'answer' && text === undefined) ||
    (source !== undefined && source !== 'endpoint' && source !== 'phone')
  ) {
    return undefined
  }

  return {
    requestId: request_id,
    sessionId: session_id,
    taskId: task_id,
    createdMs: created_ms,
    version,
    action: action as Action,
    ...(typeof option === 'string' ? { option } : {}),
    ...(typeof text === 'string' ? { text } : {}),
    ...(typeof reason === 'string' ? { reason } : {}),
    source: source === 'phone' ? 'phone' : 'endpoint',
  }
}

/**
 * What `request` does to `task`, as the pane would do it: Done on a do or
 * answer task, an option of a choose task, an answer in words on any, a
 * rejection with or without a reason. Anything the pane would not offer,
 * an empty answer, one that looks like a secret, or text over its cap is
 * refused, with why; nothing of what was sent is repeated.
 */
export function patchOf(task: Task, request: Request): Patch | { refusal: string } {
  switch (request.action) {
    case 'done':
      return task.kind === 'choose' ? { refusal: `Task #${task.id} asks for one of its options: send choose, or answer.` } : { state: 'done' }
    case 'choose':
      return task.kind === 'choose' && task.options?.includes(request.option ?? '') === true
        ? { state: 'done', answer: request.option ?? '' }
        : { refusal: task.kind === 'choose' ? 'option is none of the task’s options.' : `Task #${task.id} has no options: send done, or answer.` }
    case 'answer': {
      const value = (request.text ?? '').trim()
      const length = [...value].length

      if (value === '') {
        return { refusal: 'text is empty.' }
      }

      if (length > MAX_ANSWER) {
        return { refusal: `text is ${length} characters; the limit is ${MAX_ANSWER}.` }
      }

      return looksSecret(value) ? { refusal: 'text looks like a secret, so it was not sent: put it where it belongs, then send done.' } : { state: 'done', answer: value }
    }
    case 'reject': {
      const reason = oneLine(request.reason ?? '')
      const length = [...reason].length

      if (length > MAX_REASON) {
        return { refusal: `reason is ${length} characters; the limit is ${MAX_REASON}.` }
      }

      return { state: 'rejected', ...(reason === '' ? {} : { reason }) }
    }
    case 'archive':
    case 'restore':
      // Not an answer: the session archives or restores (`shelfRefusalOf`), and patches nothing.
      return { refusal: `${request.action} answers nothing.` }
  }
}

/**
 * A task as the answer endpoint names it: its number, when it was assigned
 * (two sessions can draw one number), and the version the caller saw.
 */
export type Versioned = { id: number; createdMs: number; version: number }

/** Whether `task` is open, and at the version `ref` saw, if any. */
export function isAt(task: Task, ref?: Versioned): boolean {
  return isActive(task) && (ref === undefined || task.updatedMs === ref.version)
}

/**
 * Whether `task` can be archived (open, not archived) or restored (archived,
 * and not yet due for deletion at `nowMs`), at the version `ref` saw, if any.
 */
export function isShelvable(task: Task, isArchiving: boolean, nowMs: number, ref?: Versioned): boolean {
  const isReady = isArchiving ? isActive(task) : isArchived(task) && !isExpired(task, nowMs)

  return isReady && (ref === undefined || task.updatedMs === ref.version)
}

/**
 * Why archiving `task` (`isArchiving`) or restoring it, as `ref` saw it, is
 * refused: it changed since (`stale`), or it is not open to archive, or not
 * archived to restore, or archived over 7 days ago (`closed`).
 */
export function shelfRefusalOf(task: Task, ref: Versioned, isArchiving: boolean, sessionId: string, nowMs: number): Answered | undefined {
  if (task.updatedMs !== ref.version) {
    return { outcome: 'stale', message: `Task #${task.id} changed since that version.`, task: infoOf(task, sessionId) }
  }

  if (isShelvable(task, isArchiving, nowMs)) {
    return undefined
  }

  const message = isArchiving
    ? `Task #${task.id} is ${isArchived(task) ? 'archived already' : task.state}.`
    : isExpired(task, nowMs)
      ? `Task #${task.id} was archived over 7 days ago and is deleted.`
      : `Task #${task.id} is not archived: it is ${task.state}.`

  return { outcome: 'closed', message, task: infoOf(task, sessionId) }
}

/** Why an answer to `task`, as `ref` saw it, is refused: it changed since (`stale`) or is no longer open (`closed`). */
export function refusalOf(task: Task, ref: Versioned, sessionId: string): Answered | undefined {
  if (task.updatedMs !== ref.version) {
    return { outcome: 'stale', message: `Task #${task.id} changed since that version.`, task: infoOf(task, sessionId) }
  }

  if (isActive(task)) {
    return undefined
  }

  const message = isArchived(task) ? `Task #${task.id} is archived: restore it first.` : `Task #${task.id} is ${task.state}.`

  return { outcome: 'closed', message, task: infoOf(task, sessionId) }
}

/** The task as an outcome names it, in session `sessionId`'s store slot. */
export function infoOf(task: Task, sessionId: string): TaskInfo {
  return { session_id: sessionId, id: task.id, created_ms: task.createdMs, version: task.updatedMs, state: task.state }
}
