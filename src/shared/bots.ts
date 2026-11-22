// Bots' avatars, as stored (Bot.avatar) and as Settings › Bots picks them: Tomo's fox, a name's
// initial on one of a few tints of the app's own colours, or a small picture.

/** Tints an initial can sit on; each is a colour the theme already has (app.css), mixed light. */
export const AVATAR_TINTS = ['plain', 'blue', 'green', 'red', 'warm'] as const
export type AvatarTint = (typeof AVATAR_TINTS)[number]

/** How big a picture may be, as a data URL (Settings shrinks one to 96 px first). */
export const AVATAR_IMAGE_CHARS = 200_000

export type Avatar = { kind: 'mascot' } | { kind: 'initial'; tint: AvatarTint } | { kind: 'image'; url: string }

/** Reads a stored avatar; anything unknown is the plain initial. */
export const avatarOf = (raw: string | null | undefined): Avatar => {
  if (raw === 'mascot') return { kind: 'mascot' }
  if (raw?.startsWith('image:')) return { kind: 'image', url: raw.slice(6) }
  const tint = raw?.startsWith('tint:') ? AVATAR_TINTS.find((t) => t === raw.slice(5)) : undefined
  return { kind: 'initial', tint: tint ?? 'plain' }
}

const IMAGE = /^image:data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/

/** An avatar as sent from Settings, or undefined when it isn't one (left unchanged). */
export const cleanAvatar = (v: unknown): string | null | undefined => {
  if (v === null || v === 'mascot') return v
  if (typeof v !== 'string') return undefined
  if (v.startsWith('tint:')) return AVATAR_TINTS.some((t) => `tint:${t}` === v) ? v : undefined
  return v.length <= AVATAR_IMAGE_CHARS && IMAGE.test(v) ? v : undefined
}
