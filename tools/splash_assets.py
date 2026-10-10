# Нарезка заставки из логотипа: python3 tools/splash_assets.py logo.png → icons/splash-*.webp, icons/splash-bg.jpg
# Фон — гладкая модель без переднего плана; знак, название и подпись — с альфой «по разнице с фоном».
import sys
import numpy as np
from PIL import Image
src = Image.open(sys.argv[1]).convert('RGB')
W = 2048
img = np.asarray(src).astype(np.float32)
fg = np.zeros((W, W), np.float32)
fg[100:1420, 380:1670] = 1
fg[1360:1650, 330:1720] = 1
fg[1690:1810, 420:1630] = 1
small = 256; k = W // small
down = lambda a: a.reshape(small, k, small, k, *a.shape[2:]).mean(axis=(1, 3))
w = down(1 - fg); col = down(img * (1 - fg)[..., None])
def gblur(a, s):
    r = int(3 * s); x = np.arange(-r, r + 1); g = np.exp(-x**2 / (2 * s * s)); g /= g.sum()
    p = np.pad(a, [(r, r), (r, r)] + [(0, 0)] * (a.ndim - 2), mode='edge')
    p = np.apply_along_axis(lambda v: np.convolve(v, g, 'valid'), 0, p)
    return np.apply_along_axis(lambda v: np.convolve(v, g, 'valid'), 1, p)
wb = gblur(w, 30); cb = np.stack([gblur(col[..., c], 30) for c in range(3)], -1)
bg_small = np.clip(cb / np.maximum(wb[..., None], 1e-4), 0, 255)
Image.fromarray(bg_small.astype(np.uint8)).save('icons/splash-bg.jpg', quality=92)
bg = np.asarray(Image.fromarray(bg_small.astype(np.uint8)).resize((W, W), Image.BICUBIC)).astype(np.float32)
print('edge colours top/bottom/left', bg_small[0, 128].round(), bg_small[-1, 128].round(), bg_small[128, 0].round(), bg_small[0,0].round())
def matte(box, out_w, name, T=38.0, TH=8):
    # Только то, что светлее фона (знак, свечение, буквы); тени темнее фона отбрасываем — при движении слоя
    # они дали бы тёмные полосы. Края слоя плавно уходят в ноль, чтобы при анимации не было видно прямоугольника.
    x0, y0, x1, y1 = box
    o = img[y0:y1, x0:x1]; b = bg[y0:y1, x0:x1]
    d = np.clip(o - b, 0, None).max(axis=2)
    a = np.clip((d - TH) / T, 0, 1)
    h, w = a.shape; f = 0.07 * min(h, w)
    yy, xx = np.mgrid[0:h, 0:w]
    edge = np.minimum(np.minimum(xx, w - 1 - xx), np.minimum(yy, h - 1 - yy))
    a *= np.clip(edge / f, 0, 1) ** 1.5
    c = np.clip(b + (o - b) / np.maximum(a[..., None], 1e-3), 0, 255)
    c[a < 0.004] = b[a < 0.004]
    im = Image.fromarray(np.dstack([c, a * 255]).astype(np.uint8), 'RGBA')
    im = im.resize((out_w, round(out_w * (y1 - y0) / (x1 - x0))), Image.LANCZOS)
    im.save(f'icons/{name}.webp', quality=84, method=6)
    print(name, im.size, box, [round(v / W * 100, 3) for v in (x0, y0, x1 - x0, y1 - y0)])
matte((400, 135, 1650, 1385), 520, 'splash-icon')
matte((340, 1370, 1710, 1640), 720, 'splash-title')
matte((430, 1695, 1620, 1805), 620, 'splash-sub')
# проверка: собрать обратно поверх фона
