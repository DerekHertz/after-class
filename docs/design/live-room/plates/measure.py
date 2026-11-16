"""Measures the numbers of each room's Plate in src/app/room/rooms.ts from the wide plates and the signed-off mockups.

Run from the repo root: python3 docs/design/live-room/plates/measure.py
It prints the board and mat boxes (plate pixels, the plain colour of each surface, found as its largest connected area) and
fits the companion's painted cell to the mockup: the cell's size, middle and ground line that make the companion drawn over the
empty plate match the mockup the companion was cleaned out of. Needs Pillow, NumPy and SciPy.
"""
from pathlib import Path
import numpy as np
from PIL import Image
from scipy import ndimage

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
CORE_X = 364

ROOMS = {
    # name: (mockup, companion sheet, board colour, mat colour, board rows, mat rows)
    "rail": ("live-room", "pip", (30, 86, 72), (246, 238, 228), (0, 540), (560, 990)),
    "harbor": ("harbor-room", "mote", (9, 99, 89), (254, 235, 205), (0, 570), (660, 990)),
    "canal": ("canal-room", "mote-pagewing", (251, 225, 197), (44, 58, 97), (60, 560), (650, 990)),
}


def largest(mask, rows):
    m = mask.copy()
    m[: rows[0]] = 0
    m[rows[1] :] = 0
    m = ndimage.binary_opening(m, iterations=3)
    lab, n = ndimage.label(m)
    sizes = ndimage.sum(m, lab, range(1, n + 1))
    comp = lab == int(np.argmax(sizes)) + 1
    ys, xs = np.nonzero(comp)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def near(a, colour, tol):
    return np.abs(a.astype(int) - np.array(colour)).sum(2) < tol


def fit_companion(plate, mockup, sheet):
    """Grid search over the cell's size and place, scoring the sprite's own pixels against the mockup."""
    cell = Image.open(ROOT / f"src/app/assets/companions-v3/{sheet}.webp").convert("RGBA").crop((0, 0, 724, 724))
    box = (0, 540, 460, 992)
    base = plate.crop(box).convert("RGBA")
    want = np.array(mockup.convert("RGB").crop(box)).astype(float)
    best = None
    for size in range(270, 316, 4):
        sprite = cell.resize((size, size), Image.LANCZOS)
        mask_all = np.array(sprite)[:, :, 3] > 40
        for cx in range(-60, 300, 8):
            for bottom in range(880, 992, 6):
                x0, y0 = cx - box[0], bottom - size - box[1]
                if y0 < 0:
                    continue
                layer = base.copy()
                layer.alpha_composite(sprite, (max(x0, 0), y0), (max(-x0, 0), 0)) if x0 < 0 else layer.alpha_composite(sprite, (x0, y0))
                got = np.array(layer.convert("RGB")).astype(float)
                mask = np.zeros(got.shape[:2], bool)
                h, w = mask.shape
                sx0, sy0 = max(x0, 0), y0
                part = mask_all[:, max(-x0, 0) :][: h - sy0, : w - sx0]
                mask[sy0 : sy0 + part.shape[0], sx0 : sx0 + part.shape[1]] = part
                err = np.abs(got - want)[mask].mean()
                if best is None or err < best[0]:
                    best = (err, size, cx + size // 2, bottom)
    return best


for name, (mock, sheet, board_colour, mat_colour, board_rows, mat_rows) in ROOMS.items():
    plate = Image.open(HERE / f"{name}-wide.png").convert("RGB")
    mockup = Image.open(HERE.parent / "mockup" / f"{mock}.png").convert("RGB")
    a = np.array(plate)
    print(name, "board surface", largest(near(a, board_colour, 60), board_rows), "mat surface", largest(near(a, mat_colour, 45), mat_rows))
    core = plate.crop((CORE_X, 0, CORE_X + mockup.width, plate.height))
    err, size, cx, bottom = fit_companion(core, mockup, sheet)
    print(name, f"companion cell {size}, middle {cx + CORE_X} (core {cx}), ground {bottom}, error {err:.1f}")
