// Images for models: no larger than they can use.
import { nativeImage } from 'electron'
import type { ShrinkImage } from './services/Attachments'

/**
 * The longest edge an image goes to a model at. Claude scales anything larger down to about
 * this itself, and other providers bill by tiles, so more pixels cost tokens and upload time
 * for nothing. A Retina screenshot is often three times this.
 */
export const MAX_IMAGE_EDGE = 1568

/** Scales an image down to MAX_IMAGE_EDGE; JPEGs stay JPEG, everything else becomes PNG. */
export const shrinkImage: ShrinkImage = (data, mime) => {
  // Animated GIFs would lose their animation; nativeImage can't read the frames anyway.
  if (mime === 'image/gif') return null
  const image = nativeImage.createFromBuffer(data)
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  const scale = MAX_IMAGE_EDGE / Math.max(width, height)
  if (scale >= 1) return null
  const small = image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' })
  return mime === 'image/jpeg' ? { data: small.toJPEG(85), mime } : { data: small.toPNG(), mime: 'image/png' }
}
