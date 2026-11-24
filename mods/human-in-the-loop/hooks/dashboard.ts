// The dashboard (dashboard/README.md) as this session sees it: whether it is on,
// whether this session's answers can come from it, and its start and stop.
// hooks/dashboard_control.py reads and changes it; this runs that helper and says
// what it found in one line. The caller's contract: README.md, "Dashboard".
import type { EngineInterface } from 'claude-code'

import { printable } from './text'

/** How the dashboard stands, as the helper reads it. */
export type Dashboard = {
  dashboard: 'on' | 'off' | 'unknown'
  /** Why it is not on, in a few words; empty when it is. */
  why: string
  /** Its config and its unit are both there. */
  isSetUp: boolean
  /** Where the page is opened, once there is a config. */
  address: string | null
  /** The next step when it is not on; empty when there is none to give. */
  fix: string
}

/** What a start or a stop did, and how the dashboard stands after it. */
export type Control = { outcome: 'done' | 'refused' | 'failed'; message: string; dashboard: Dashboard }

/** The helper's `why` when there is no config: the person never set the dashboard up, so nothing shows. */
export const NO_CONFIG = 'no config'

/** How long a status may take (the helper's own bounds come to 13 s), and a start or a stop (48 s). */
export const STATUS_MS = 20_000
export const CONTROL_MS = 60_000

const DASHBOARD_STATES = ['on', 'off', 'unknown'] as const

/** The dashboard's systemd user unit (dashboard_control.py's UNIT). */
const UNIT = 'claude-tweaks-dashboard.service'

/** Where the dashboard's config and its unit are found: XDG_CONFIG_HOME, else ~/.config. */
async function configHome($: EngineInterface): Promise<string> {
  return (await $.env.get('XDG_CONFIG_HOME')) || `${(await $.env.get('HOME')) ?? ''}/.config`
}

/**
 * The config file the dashboard's server reads, as it finds it (dashboard/server.py,
 * `config_or_old`): `dashboard.toml`, else the phone view's `phone.toml` beside it when
 * only that one is there (the #167 rename).
 */
async function configPath($: EngineInterface): Promise<string> {
  const dir = `${await configHome($)}/claude-tweaks`
  // The server and dashboard_control.py test with lexists (a broken `dashboard.toml` link counts as present).
  // TODO(deferred): #173 the engine's `fs` (types/index.d.ts) offers no call that skips links, so a broken link reads as absent here.
  const isOld = !(await $.fs.exists(`${dir}/dashboard.toml`)) && (await $.fs.exists(`${dir}/phone.toml`))

  return `${dir}/${isOld ? 'phone' : 'dashboard'}.toml`
}

/** Whether the dashboard's config file is there: without it the person never set the dashboard up, and the dashboard tool says so. Never rejects. */
export async function hasDashboardConfig($: EngineInterface): Promise<boolean> {
  try {
    return await $.fs.exists(await configPath($))
  } catch {
    return false
  }
}

/** Whether the dashboard's config file and its systemd unit are both in place: the cue to read it at session start and on each heartbeat. Never rejects. */
export async function isDashboardInstalled($: EngineInterface): Promise<boolean> {
  try {
    return (await $.fs.exists(await configPath($))) && (await $.fs.exists(`${await configHome($)}/systemd/user/${UNIT}`))
  } catch {
    return false
  }
}

/**
 * Reads how the dashboard stands. Unless `isAsked` (a press, or a command),
 * nothing runs without the config: a person who never set it up has no line
 * to see, and resolves undefined. Never rejects: a helper that cannot run or
 * answers no reading is `unknown`.
 */
export async function readDashboard($: EngineInterface, isAsked: boolean): Promise<Dashboard | undefined> {
  try {
    if (!isAsked && !(await $.fs.exists(await configPath($)))) {
      return undefined
    }
  } catch {
    return undefined
  }

  const ran = await runHelper($, 'status', STATUS_MS)

  return 'error' in ran ? unknown(ran.error) : (dashboardOf(ran.value) ?? unknown(UNREAD))
}

/** Starts or stops the dashboard, as the helper does it. Never rejects. */
export async function controlDashboard($: EngineInterface, action: 'start' | 'stop'): Promise<Control> {
  const ran = await runHelper($, action, CONTROL_MS)

  if ('error' in ran) {
    return { outcome: 'failed', message: `Could not ${action} the dashboard: ${ran.error}.`, dashboard: unknown(ran.error) }
  }

  const said = ran.value as { outcome?: unknown; message?: unknown } | null
  const dashboard = dashboardOf(ran.value)
  const outcome = said?.outcome === 'done' || said?.outcome === 'refused' || said?.outcome === 'failed' ? said.outcome : undefined

  return dashboard === undefined || outcome === undefined || typeof said?.message !== 'string'
    ? { outcome: 'failed', message: `Could not ${action} the dashboard: ${UNREAD}.`, dashboard: dashboard ?? unknown(UNREAD) }
    : { outcome, message: printable(said.message, 400), dashboard }
}

/** Why a reading is unknown when the helper printed nothing it reads. */
const UNREAD = 'the check answered nothing it reads'

/**
 * The helper's one JSON line, parsed; or why there is none, in a few fixed
 * words: what it printed on stderr, or stdout that is not its whole JSON
 * line, is never passed on.
 */
async function runHelper($: EngineInterface, action: string, timeoutMs: number): Promise<{ value: unknown } | { error: string }> {
  let ran: { exitCode: number; stdout: string; isStdoutTruncated: boolean }

  try {
    ran = await $.process.run(['python3', '-I', `${$.plugin.root}/hooks/dashboard_control.py`, action], { timeoutMs })
  } catch {
    return { error: 'the check could not run' }
  }

  if (ran.exitCode !== 0) {
    return { error: `the check failed (exit status ${ran.exitCode})` }
  }

  if (ran.isStdoutTruncated) {
    return { error: 'the check printed too much' }
  }

  try {
    return { value: JSON.parse(ran.stdout) as unknown }
  } catch {
    return { error: UNREAD }
  }
}

function unknown(why: string): Dashboard {
  return { dashboard: 'unknown', why, isSetUp: false, address: null, fix: '' }
}

/** A reading as the helper prints it, checked; undefined when it is not one, or an `on` that says it is not set up or why it is not on. */
export function dashboardOf(value: unknown): Dashboard | undefined {
  const raw = value as Record<string, unknown> | null
  const dashboard = DASHBOARD_STATES.find(state => state === raw?.['dashboard'])

  if (raw === null || typeof raw !== 'object' || dashboard === undefined || typeof raw['why'] !== 'string' || typeof raw['set_up'] !== 'boolean') {
    return undefined
  }

  if (dashboard === 'on' && (raw['set_up'] !== true || raw['why'] !== '')) {
    return undefined
  }

  const address = raw['address']

  return {
    dashboard,
    why: printable(raw['why'], 80),
    isSetUp: raw['set_up'],
    address: typeof address === 'string' && /^https?:\/\/[!-~]{1,255}$/.test(address) ? address : null,
    fix: typeof raw['fix'] === 'string' ? printable(raw['fix'], 400) : '',
  }
}

/** Why replies are off while the answer endpoint setting is off. */
export const SETTING_OFF = 'Answer endpoint setting off'

/** Whether this session takes answers from the dashboard: `on`, `starting`, or `off` with why. */
export type Replies = { state: 'on' | 'starting' | 'off'; why: string }

/** The pane's and the status line's words for the dashboard and this session's replies. */
export function dashboardLineOf(dashboard: Dashboard, replies: Replies): string {
  const head = dashboard.dashboard === 'on' ? 'dashboard: on' : `dashboard: ${dashboard.dashboard} (${dashboard.why})`

  if (!dashboard.isSetUp && dashboard.dashboard !== 'on') {
    return head
  }

  return `${head} · replies: ${replies.state === 'off' ? `off (${replies.why})` : replies.state}`
}
