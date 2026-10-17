// Turns an arbitrary sequence of text deltas into complete lines.
// Used for line-by-line streaming: nothing reaches the UI or the database
// until its trailing newline has arrived (or the stream ends).

export interface LineBuffer {
  /** Feed a delta; returns the lines it completed (without their line endings). */
  push(delta: string): string[]
  /** End of stream; returns the trailing partial line, if any. */
  flush(): string[]
}

export const makeLineBuffer = (): LineBuffer => {
  let pending = ''
  return {
    push(delta) {
      pending += delta
      // Without this, a long line (minified artifact HTML) is re-split on every delta.
      if (!delta.includes('\n')) return []
      const parts = pending.split('\n')
      pending = parts.pop() ?? ''
      // A `\r` at the end of `pending` may be the first half of a split `\r\n`; it is
      // stripped once the `\n` arrives, so only strip it from completed lines here.
      return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    },
    flush() {
      if (pending === '') return []
      const last = pending.endsWith('\r') ? pending.slice(0, -1) : pending
      pending = ''
      return [last]
    }
  }
}

/** Joins persisted lines back into message content. */
export const joinLines = (lines: readonly string[]): string => lines.join('\n')
