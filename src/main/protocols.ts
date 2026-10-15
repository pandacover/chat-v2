import { createHash } from 'node:crypto'
import { protocol } from 'electron'
import { Effect, type ManagedRuntime } from 'effect'
import { Attachments } from './services/Attachments'

/**
 * Artifacts load from their own scheme rather than `srcdoc`, because srcdoc
 * frames inherit the app's strict CSP. Each artifact gets a permissive CSP of
 * its own and runs in an opaque-origin sandbox (no allow-same-origin).
 */
const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob: https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com",
  "style-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://fonts.googleapis.com",
  'img-src data: blob: https:',
  'font-src data: https:',
  'media-src data: blob: https:',
  'connect-src https:',
  "worker-src blob:"
].join('; ')

const artifacts = new Map<string, string>()
const MAX_ARTIFACTS = 200

export const publishArtifact = (html: string): string => {
  const id = createHash('sha256').update(html).digest('hex').slice(0, 32)
  artifacts.delete(id)
  artifacts.set(id, html)
  // Content is re-derived from messages on every render, so old entries are safe to evict.
  while (artifacts.size > MAX_ARTIFACTS) artifacts.delete(artifacts.keys().next().value!)
  return `artifact://view/${id}`
}

export const registerSchemes = () => {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'artifact', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: 'attachment', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ])
}

export const handleProtocols = (runtime: ManagedRuntime.ManagedRuntime<Attachments, unknown>) => {
  protocol.handle('artifact', (request) => {
    const id = new URL(request.url).pathname.replace(/^\//, '')
    const html = artifacts.get(id)
    if (!html) return new Response('Artifact expired; reopen it from the chat.', { status: 404 })
    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': ARTIFACT_CSP }
    })
  })

  protocol.handle('attachment', async (request) => {
    const id = new URL(request.url).hostname
    return runtime.runPromise(
      Effect.gen(function* () {
        const file = yield* (yield* Attachments).read(id)
        return new Response(new Blob([file.data], { type: file.mime }))
      }).pipe(Effect.catch(() => Effect.succeed(new Response('Not found', { status: 404 }))))
    )
  })
}
