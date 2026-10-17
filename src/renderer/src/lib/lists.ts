// Markdown list editing for a plain textarea. Shift+Enter continues a list (and ends it on an
// empty item), Tab and Shift+Tab nest and un-nest items, and numbered lists stay 1, 2, 3.
// Everything here works on text and offsets so it can be tested without a DOM.

/** The textarea's text and selection after an edit. */
export interface TextEdit {
  value: string
  start: number
  end: number
}

interface Item {
  /** Leading whitespace as typed, and its width in columns (a tab reaches the next multiple of 4). */
  lead: string
  indent: number
  bullet: string | null
  num: number | null
  /** '.' or ')' after a number; '' for bullets. */
  delim: string
  /** Whitespace between the marker and the text. */
  gap: string
  /** A task box like '[ ] ', or ''. */
  task: string
  content: string
}

const ITEM = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))([ \t]+)(\[[ xX]\](?:[ \t]+|$))?(.*)$/
const FENCE = /^\s*(```|~~~)/

const columns = (ws: string) => [...ws].reduce((n, c) => (c === '\t' ? n + 4 - (n % 4) : n + 1), 0)
const leadOf = (line: string) => /^[ \t]*/.exec(line)![0]

const parse = (line: string): Item | null => {
  const m = ITEM.exec(line)
  if (!m) return null
  return {
    lead: m[1]!,
    indent: columns(m[1]!),
    bullet: m[2] ?? null,
    num: m[3] ? Number(m[3]) : null,
    delim: m[4] ?? '',
    gap: m[5]!,
    task: m[6] ?? '',
    content: m[7]!
  }
}

const marker = (it: Item) => it.bullet ?? `${it.num}${it.delim}`
const render = (it: Item) => it.lead + marker(it) + it.gap + it.task + it.content
/** The column an item's text starts at, which is where items nested under it go. */
const contentColumn = (it: Item) => it.indent + marker(it).length + it.gap.length
const sameList = (a: Item, b: Item) => (a.num === null ? b.num === null && a.bullet === b.bullet : b.num !== null && a.delim === b.delim)
const blank = (line: string) => line.trim() === ''

const reindent = (it: Item, indent: number): Item => ({ ...it, lead: ' '.repeat(indent), indent })
/** Takes another item's marker style, keeping its own number (renumbering sets that). */
const restyle = (it: Item, like: Item): Item =>
  like.num === null ? { ...it, bullet: like.bullet, num: null, delim: '' } : { ...it, bullet: null, num: it.num ?? 1, delim: like.delim }

const locate = (lines: string[], offset: number) => {
  let line = 0
  while (line < lines.length - 1 && offset > lines[line]!.length) {
    offset -= lines[line]!.length + 1
    line++
  }
  return { line, col: offset }
}

const offsetOf = (lines: string[], line: number, col: number) => lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0) + col

// Lists in code blocks are code; leave them alone.
const inFence = (lines: string[], line: number) => lines.slice(0, line).filter((l) => FENCE.test(l)).length % 2 === 1

/** The text after a line's indentation and marker, which edits here never change. */
const textLength = (line: string) => parse(line)?.content.length ?? line.trimStart().length

/**
 * Carries an offset across an edit that only rewrote the start of lines (their indentation
 * and markers): it keeps its place in the line's text, or stays put if it was before the text.
 */
const remap = (before: string[], after: string[], offset: number) => {
  const { line, col } = locate(before, offset)
  const old = before[line]!
  const now = after[line]!
  const text = Math.min(textLength(old), textLength(now))
  const fromEnd = old.length - col
  return offsetOf(after, line, fromEnd <= text ? now.length - fromEnd : Math.min(col, now.length - text))
}

/**
 * A list here is a run of non-blank lines: items and the text indented under them.
 * Unindented text or a blank line ends it.
 */
const listBounds = (lines: string[], line: number): [number, number] | null => {
  const inList = (l: string) => !blank(l) && !FENCE.test(l) && (parse(l) !== null || columns(leadOf(l)) > 0)
  if (!inList(lines[line]!)) return null
  let first = line
  let last = line
  while (first > 0 && inList(lines[first - 1]!)) first--
  while (last < lines.length - 1 && inList(lines[last + 1]!)) last++
  return [first, last]
}

/** Numbers each numbered list around `line` in order, from the number its first item has. */
const renumber = (lines: string[], line: number) => {
  const bounds = listBounds(lines, line)
  if (!bounds) return
  const levels: Array<{ item: Item; next: number }> = []
  for (let i = bounds[0]; i <= bounds[1]; i++) {
    const item = parse(lines[i]!)
    if (!item) {
      // Text under an item ends any deeper list it is not indented into.
      const indent = columns(leadOf(lines[i]!))
      while (levels.length > 0 && levels.at(-1)!.item.indent >= indent) levels.pop()
      continue
    }
    while (levels.length > 0 && levels.at(-1)!.item.indent > item.indent) levels.pop()
    const top = levels.at(-1)
    if (top && top.item.indent === item.indent && sameList(top.item, item)) {
      if (item.num !== null && item.num !== top.next) {
        item.num = top.next
        lines[i] = render(item)
      }
      top.item = item
      top.next = (item.num ?? 0) + 1
    } else {
      // A different kind of marker at the same depth starts a new list.
      if (top && top.item.indent === item.indent) levels.pop()
      levels.push({ item, next: (item.num ?? 0) + 1 })
    }
  }
}

/**
 * Nests (or un-nests) the list items from the selection's first item through its last line,
 * along with anything indented under them. Null when that isn't possible, so Tab can still
 * move focus.
 */
const shift = (lines: string[], fromLine: number, toLine: number, outdent: boolean): number | null => {
  let first = -1
  for (let i = fromLine; i <= toLine && first < 0; i++) if (parse(lines[i]!) && !inFence(lines, i)) first = i
  if (first < 0) return null
  const item = parse(lines[first]!)!
  let last = Math.max(first, toLine)
  while (last + 1 < lines.length && !blank(lines[last + 1]!) && columns(leadOf(lines[last + 1]!)) > item.indent) last++

  let target: number
  let style: Item | null = null
  if (!outdent) {
    // Nest under the previous item at this depth, joining its sub-list if it has one.
    let sibling = -1
    for (let i = first - 1; i >= 0 && !blank(lines[i]!); i--) {
      const it = parse(lines[i]!)
      const indent = it ? it.indent : columns(leadOf(lines[i]!))
      if (indent < item.indent || (!it && indent === 0)) break
      if (it && it.indent === item.indent) {
        sibling = i
        break
      }
    }
    if (sibling < 0) return null
    const parent = parse(lines[sibling]!)!
    let child: Item | null = null
    for (let i = sibling + 1; i < first; i++) {
      const it = parse(lines[i]!)
      if (it && it.indent > parent.indent && (!child || it.indent <= child.indent)) child = it
    }
    target = child?.indent ?? contentColumn(parent)
    style = child
  } else {
    if (item.indent === 0) return null
    // Become the next item of the parent's list.
    let parent: Item | null = null
    for (let i = first - 1; i >= 0 && !blank(lines[i]!); i--) {
      const it = parse(lines[i]!)
      if (it && it.indent < item.indent) {
        parent = it
        break
      }
      if (!it && columns(leadOf(lines[i]!)) === 0) break
    }
    target = parent?.indent ?? 0
    style = parent
  }

  const delta = target - item.indent
  for (let i = first; i <= last; i++) {
    const line = lines[i]!
    if (blank(line)) continue
    const it = parse(line)
    if (it && it.indent === item.indent) {
      let moved = reindent(it, target)
      // A numbered item that starts a new sub-list starts it at 1.
      if (style) moved = restyle(moved, style)
      else if (moved.num !== null && i === first) moved.num = 1
      lines[i] = render(moved)
    } else {
      const lead = leadOf(line)
      lines[i] = ' '.repeat(Math.max(0, columns(lead) + delta)) + line.slice(lead.length)
    }
  }
  return first
}

/** Shift+Enter in a list: starts the next item, or ends the list on an empty one. Null outside lists. */
export const continueList = (value: string, start: number, end: number): TextEdit | null => {
  const lines = value.split('\n')
  const from = locate(lines, start)
  const to = locate(lines, end)
  const line = lines[from.line]!
  const item = parse(line)
  if (!item || inFence(lines, from.line)) return null
  const textStart = line.length - item.content.length

  if (item.content.trim() === '' && from.line === to.line) {
    // An empty nested item moves out a level; an empty top-level item ends the list.
    if (item.indent > 0) {
      const before = [...lines]
      const moved = shift(lines, from.line, from.line, true)
      if (moved !== null) {
        renumber(lines, moved)
        const caret = remap(before, lines, start)
        return { value: lines.join('\n'), start: caret, end: caret }
      }
    }
    lines[from.line] = ''
    const caret = offsetOf(lines, from.line, 0)
    return { value: lines.join('\n'), start: caret, end: caret }
  }

  // Inside the marker, it's just a line break.
  if (from.col < textStart) return null
  const head = line.slice(0, from.col)
  const tail = lines[to.line]!.slice(to.col)
  const next: Item = { ...item, num: item.num === null ? null : item.num + 1, task: item.task ? '[ ] ' : '', content: tail.trimStart() }
  // At the start of the text, the item stays (empty) and its text moves down.
  lines.splice(from.line, to.line - from.line + 1, from.col > textStart ? head.trimEnd() : head, render(next))
  renumber(lines, from.line + 1)
  const added = lines[from.line + 1]!
  const caret = offsetOf(lines, from.line + 1, added.length - next.content.length)
  return { value: lines.join('\n'), start: caret, end: caret }
}

/** Tab (or Shift+Tab with `outdent`) on list items. Null when there is nothing to move. */
export const indentList = (value: string, start: number, end: number, outdent: boolean): TextEdit | null => {
  const lines = value.split('\n')
  const before = [...lines]
  const from = locate(lines, start)
  const to = locate(lines, end)
  // A selection that ends at the start of a line doesn't include that line.
  const toLine = to.line > from.line && to.col === 0 ? to.line - 1 : to.line
  const first = shift(lines, from.line, toLine, outdent)
  if (first === null) return null
  renumber(lines, first)
  return { value: lines.join('\n'), start: remap(before, lines, start), end: remap(before, lines, end) }
}

/** Puts the numbered lists around the selection back in order. Null when they already are. */
export const renumberList = (value: string, start: number, end: number): TextEdit | null => {
  const lines = value.split('\n')
  const before = [...lines]
  const { line } = locate(lines, start)
  if (inFence(lines, line)) return null
  renumber(lines, line)
  if (lines.every((l, i) => l === before[i])) return null
  return { value: lines.join('\n'), start: remap(before, lines, start), end: remap(before, lines, end) }
}
