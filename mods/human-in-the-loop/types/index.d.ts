/**
 * What Claude needs from the user: something done (`do`), an answer in
 * their own words (`answer`), or one of a few options (`choose`).
 */
export type TaskKind = 'do' | 'answer' | 'choose'

/**
 * Where a task stands: waiting for the user (`open`), fulfilled (`done`),
 * turned down (`rejected`), or taken back by Claude (`withdrawn`).
 */
export type TaskState = 'open' | 'done' | 'rejected' | 'withdrawn'

/**
 * Whether Claude has heard of the user's latest move on the task: nothing
 * to tell (`none`), told nothing yet (`pending`), or told (`delivered`).
 */
export type TaskUpdate = 'none' | 'pending' | 'delivered'

/** A task Claude gave the user. */
export type Task = {
  /** Counts up per project: #1, #2, … */
  id: number
  title: string
  why: string
  doneWhen?: string
  /** The full picture, up to 4000 characters; the pane shows it in its full view, never on the card. */
  detail?: string
  kind: TaskKind
  options?: readonly string[]
  state: TaskState
  /** The user's answer, or the option they chose. */
  answer?: string
  /** Why the user rejected it, or why Claude withdrew it. */
  reason?: string
  update: TaskUpdate
  /**
   * When the user archived it (`$.clock.now()` ms): set on an open task only,
   * which leaves the open list unanswered, and nothing is sent to Claude.
   * Restore takes it out; 7 days on, the next store write or load deletes the task.
   */
  archivedMs?: number
  /** The session that assigned it. */
  sessionId: string
  createdMs: number
  updatedMs: number
}

/**
 * A task as the session that held it numbered it, and when it was assigned:
 * where two sessions drew one number, that tells their tasks apart.
 */
export type TaskRef = { id: number; createdMs: number }

/**
 * The tasks one session took on from another that had ended or gone quiet,
 * as that session numbered them, and when. `isEnded`: it had ended, so it
 * won't come back for them.
 */
export type Took = { tasks: readonly TaskRef[]; atMs: number; isEnded?: boolean }

/**
 * The selected task's field, when the pane shows one in place of its
 * buttons: an answer, or a reason for rejecting. `held` is an answer held
 * back because it looks like a secret.
 */
export type Editing = {
  id: number
  field: 'answer' | 'reason'
  held?: string
}

declare module 'claude-code' {
  interface PluginState {
    'human-in-the-loop': {
      tasks: readonly Task[]
      nextId: number
      /** The tasks this session took on from others, by their session id. */
      took: Readonly<Record<string, Took>>
      selectedId: number | null
      /** The task whose full picture (its detail) the pane shows in place of its card, if any. */
      fullId: number | null
      editing: Editing | null
      loadedFor: string | null
      isWorking: boolean
      /** The remote clients attached, by surface: two phones are two clients on one. */
      clients: Readonly<Partial<Record<RenderSurface, readonly string[]>>>
      /**
       * The dashboard's line as the status line shows it (`dashboard: on · replies: on`),
       * once it is set up, with `at`, when it was read (`$.clock.now()` ms), and `seq`,
       * a number each publication of this plugin's copy takes rising; null otherwise.
       * Published again on every reading (each minute while installed); the progress
       * pane draws it while it is under 150 s old. The progress plugin declares this
       * member too (mods/progress/types/index.d.ts): keep both the same. One shared
       * declaration is not possible: `claude plugin validate` needs this literal object
       * here, and the progress plugin compiles without this file.
       */
      dashboard: { line: string; at: number; seq: number } | null
    }
  }
}
