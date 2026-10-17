import { continueList, indentList, renumberList, type TextEdit } from './lists'

/**
 * Puts `edit` into the textarea as one undoable step by typing over just the part that
 * changed. Assigning `value` would wipe the undo history. Fires `input`, so bindings update.
 */
export const applyEdit = (el: HTMLTextAreaElement, edit: TextEdit) => {
  const old = el.value
  const next = edit.value
  if (old !== next) {
    let from = 0
    while (from < old.length && from < next.length && old[from] === next[from]) from++
    let oldEnd = old.length
    let newEnd = next.length
    while (oldEnd > from && newEnd > from && old[oldEnd - 1] === next[newEnd - 1]) {
      oldEnd--
      newEnd--
    }
    const typed = next.slice(from, newEnd)
    el.focus()
    el.setSelectionRange(from, oldEnd)
    const done = typed ? document.execCommand('insertText', false, typed) : document.execCommand('delete')
    if (!done || el.value !== next) {
      el.value = next
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }
  el.setSelectionRange(edit.start, edit.end)
}

const lineCount = (s: string) => s.split('\n').length

/**
 * `use:listEditing` on a textarea: Shift+Enter continues a Markdown list (and ends it on an
 * empty item), Tab and Shift+Tab nest and un-nest items, and deleting lines from a numbered
 * list renumbers the rest. Plain Enter is left to the owner (it sends).
 */
export const listEditing = (el: HTMLTextAreaElement) => {
  let linesBefore = 0

  const onkeydown = (e: KeyboardEvent) => {
    if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return
    let edit: TextEdit | null = null
    if (e.key === 'Enter' && e.shiftKey) edit = continueList(el.value, el.selectionStart, el.selectionEnd)
    else if (e.key === 'Tab') edit = indentList(el.value, el.selectionStart, el.selectionEnd, e.shiftKey)
    if (!edit) return
    e.preventDefault()
    applyEdit(el, edit)
  }

  const onbeforeinput = () => (linesBefore = lineCount(el.value))

  const oninput = (e: Event) => {
    // Only deletions that removed whole lines; undo, redo and typing stay as they are.
    const type = e instanceof InputEvent ? e.inputType : ''
    if (!type.startsWith('delete') || lineCount(el.value) >= linesBefore) return
    // After the deletion finishes, so the fix is its own undo step.
    queueMicrotask(() => {
      const edit = renumberList(el.value, el.selectionStart, el.selectionEnd)
      if (edit) applyEdit(el, edit)
    })
  }

  el.addEventListener('keydown', onkeydown)
  el.addEventListener('beforeinput', onbeforeinput)
  el.addEventListener('input', oninput)
  return {
    destroy() {
      el.removeEventListener('keydown', onkeydown)
      el.removeEventListener('beforeinput', onbeforeinput)
      el.removeEventListener('input', oninput)
    }
  }
}
