// Presentation text, ages and completion bar. No event observation.

export function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * A line safe to draw: control, format and line-separator characters out
 * (the engine refuses a drawing holding one), whitespace collapsed, cut to
 * `max`. The human-in-the-loop fork's `printable` (its hooks/text.ts), for
 * the dashboard line that plugin publishes.
 */
export function printable(text: string, max: number): string {
  return oneLine(text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\p{Cf}/gu, ''), max)
}

export function age(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))

  if (seconds < 60) {
    return `${seconds}s`
  }

  const minutes = Math.floor(seconds / 60)

  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

/** A filled-and-empty bar, `done` of `total`, `width` cells wide. */
export function bar(done: number, total: number, width: number): string {
  const filled = total === 0 ? 0 : Math.round((done / total) * width)

  return '▰'.repeat(filled) + '▱'.repeat(width - filled)
}
