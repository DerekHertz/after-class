import sys
import numpy as np
from PIL import Image
from scipy.optimize import minimize
orig = Image.open(sys.argv[1]).convert("RGB"); new = Image.open(sys.argv[2]).convert("RGB")
W, H = orig.size
box = (0, 0, 470, 640)
o = np.asarray(orig.crop(box).convert("L")).astype(float)
def warp(p, im=new, size=(W, H)):
    sx, sy, dx, dy = p  # orig (x,y) -> new (sx*x+dx, sy*y+dy)
    return im.transform(size, Image.AFFINE, (sx, 0, dx, 0, sy, dy), resample=Image.BICUBIC)
def cost(p):
    w = np.asarray(warp(p).crop(box).convert("L")).astype(float)
    return ((w - o) ** 2).mean()
best = None
for sx in np.linspace(0.97, 1.0, 7):
    for sy in np.linspace(1.0, 1.03, 7):
        for dx in range(-12, 13, 3):
            for dy in range(-12, 13, 3):
                c = cost((sx, sy, dx, dy))
                if best is None or c < best[0]: best = (c, (sx, sy, dx, dy))
print("grid", best)
r = minimize(cost, best[1], method="Nelder-Mead", options={"xatol": 0.01, "fatol": 0.01, "maxiter": 400})
print("refined", r.fun, r.x)
warp(r.x).save("aligned.png")
