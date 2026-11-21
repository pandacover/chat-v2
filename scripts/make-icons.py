# Makes every logo file from the fox (assets/logo-source.png, the fox on a cream square):
#   python scripts/make-icons.py        (needs Pillow and NumPy)
# Cuts the fox out of its square (the background connected to the edges goes transparent, with a
# softened edge), crops it, and writes:
#   src/renderer/src/assets/logo.png   the in-app mark (sidebar, Settings > About), transparent
#   assets/logo.png                    the same, for the README
#   build/icon.png                     1024 px app icon (electron-builder makes the .ico and .icns)
#   assets/icon-256.png, src/renderer/public/icon.png   smaller icons (the latter is the favicon)
# The icons put the fox on its own cream, in a rounded square with the usual inset.
import os
from collections import deque
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
src, out_dir = os.path.join(root, 'assets', 'logo-source.png'), root
im = np.asarray(Image.open(src).convert('RGB')).astype(np.float32)
h, w, _ = im.shape
corners = np.concatenate([im[:40, :40].reshape(-1, 3), im[:40, -40:].reshape(-1, 3), im[-40:, :40].reshape(-1, 3), im[-40:, -40:].reshape(-1, 3)])
bg = corners.mean(0)
dist = np.sqrt(((im - bg) ** 2).sum(2))

# Flood fill the background from the border.
TOL = 9
bgmask = np.zeros((h, w), bool)
q = deque()
for x in range(w):
    for y in (0, h - 1):
        if dist[y, x] < TOL and not bgmask[y, x]:
            bgmask[y, x] = True
            q.append((y, x))
for y in range(h):
    for x in (0, w - 1):
        if dist[y, x] < TOL and not bgmask[y, x]:
            bgmask[y, x] = True
            q.append((y, x))
while q:
    y, x = q.popleft()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        ny, nx = y + dy, x + dx
        if 0 <= ny < h and 0 <= nx < w and not bgmask[ny, nx] and dist[ny, nx] < TOL:
            bgmask[ny, nx] = True
            q.append((ny, nx))

# Alpha: the flood-filled shape, its edge softened by a slight blur (colour distance can't be used:
# near its outline the fox's cream is nearly the background's own colour).
fg = np.asarray(Image.fromarray(((~bgmask) * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.1))).astype(np.float32) / 255
alpha = fg
rgba = np.dstack([im, alpha * 255]).astype(np.uint8)
img = Image.fromarray(rgba, 'RGBA')

# Crop to the fox, square, with a small margin.
ys, xs = np.nonzero(alpha > 0.02)
x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
side = int(max(x1 - x0, y1 - y0) * 1.04)
cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
box = (cx - side // 2, cy - side // 2, cx - side // 2 + side, cy - side // 2 + side)
fox = img.crop(box)

# In-app mark (sidebar, About): 256 px, transparent.
fox.resize((256, 256), Image.LANCZOS).save(f'{out_dir}/src/renderer/src/assets/logo.png', optimize=True)

# App icon: the fox on its own cream, a rounded square with the usual inset (macOS-style), 1024 and 256 px.
def icon(size):
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    inset = round(size * 0.1)
    r = round((size - 2 * inset) * 0.225)
    tile = Image.new('RGBA', (size - 2 * inset, size - 2 * inset), tuple(int(c) for c in bg) + (255,))
    m = Image.new('L', tile.size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, tile.size[0] - 1, tile.size[1] - 1), r, fill=255)
    canvas.paste(tile, (inset, inset), m)
    f = round((size - 2 * inset) * 0.8)
    mark = fox.resize((f, f), Image.LANCZOS)
    canvas.alpha_composite(mark, ((size - f) // 2, (size - f) // 2))
    return canvas

icon(1024).save(f'{out_dir}/build/icon.png', optimize=True)
icon(256).save(f'{out_dir}/assets/icon-256.png', optimize=True)
icon(64).save(f'{out_dir}/src/renderer/public/icon.png', optimize=True)
fox.resize((256, 256), Image.LANCZOS).save(f'{out_dir}/assets/logo.png', optimize=True)
