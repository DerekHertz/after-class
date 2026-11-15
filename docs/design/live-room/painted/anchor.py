# Puts a companion's approved frames into art/masters/companion-frames/<companion>/ on one canvas and one ground line.
# usage: python3 anchor.py pip
# Mechanical only: each grounded frame is translated straight down or up so the lowest opaque row of its body sits on idle's.
# Airborne frames (hop-air) are copied as drawn and keep their measured offset in provenance.json for the stage to place.
# Nothing is redrawn. The script refuses a frame whose alpha is not binary, whose canvas is not the master's cell, or that has
# a speck (a separate opaque island that is not listed in ISLANDS below).
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "../../../.."))
CELL = 724
AIRBORNE = {"hop-air"}
ISLANDS = {"think": 1}  # the sweat drop is meant to be its own island


def body_bottom(alpha):
    labels, n = ndimage.label(alpha)
    sizes = ndimage.sum(alpha, labels, range(1, n + 1))
    body = labels == 1 + int(np.argmax(sizes))
    return int(np.where(body.any(1))[0].max()), n


def main(who):
    src = os.path.join(HERE, who)
    out = os.path.join(ROOT, "art/masters/companion-frames", who)
    os.makedirs(out, exist_ok=True)
    record = json.load(open(os.path.join(src, "provenance.json")))
    master = np.array(Image.open(os.path.join(ROOT, record["master"])))
    ground, _ = body_bottom(np.array(Image.open(os.path.join(src, "idle.png")))[..., 3] > 128)
    result = {"companion": who, "master": record["master"], "cell": CELL, "model": record["model"], "groundRow": ground, "frames": {}}
    for name, info in record["frames"].items():
        img = np.array(Image.open(os.path.join(src, f"{name}.png")).convert("RGBA"))
        assert img.shape == (CELL, CELL, 4), f"{name}: {img.shape}"
        alpha = img[..., 3]
        assert set(np.unique(alpha)) <= {0, 255}, f"{name}: alpha is not binary"
        bottom, islands = body_bottom(alpha > 0)
        assert islands == 1 + ISLANDS.get(name, 0), f"{name}: {islands} separate islands"
        dy = 0 if name in AIRBORNE else ground - bottom
        if dy:
            moved = np.zeros_like(img)
            if dy > 0: moved[dy:] = img[: CELL - dy]
            else: moved[: CELL + dy] = img[-dy:]
            assert (moved[..., 3] > 0).sum() == (alpha > 0).sum(), f"{name}: shifting by {dy} would clip"
            img = moved
        Image.fromarray(img).save(os.path.join(out, f"{name}.png"), optimize=True)
        result["frames"][name] = {**info, "shiftY": dy, "airborne": name in AIRBORNE, "bodyBottomRow": bottom + dy}
        print(name, "shiftY", dy, "body bottom", bottom + dy)
    json.dump(result, open(os.path.join(out, "provenance.json"), "w"), indent=1)
    open(os.path.join(out, "provenance.json"), "a").write("\n")


main(sys.argv[1])
