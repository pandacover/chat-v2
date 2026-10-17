/** Quotes `text` as Markdown for the composer, with the reply under it when there is one. */
export const citation = (text: string, reply = ''): string => {
  const quote = text
    .trim()
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => (line.trim() ? `> ${line.trimEnd()}` : '>'))
    .join('\n')
  return reply.trim() ? `${quote}\n\n${reply.trim()}` : quote
}
