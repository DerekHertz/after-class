"""Mechanical post-processing for the rooms-v2 layers, and the manifest.

Run: python3 tools/process.py <folder holding the generated originals>

It never paints. For each generated original it only:
  1. makes alpha binary (alpha >= 128 becomes 255, the rest 0, and clears the colour of transparent pixels),
  2. drops connected opaque specks smaller than MIN_SPECK pixels that are not part of the object,
  3. crops to the stated box, or to the opaque bounding box,
  4. scales by exactly 2 with nearest neighbour, so every asset is at 2 asset pixels per plate pixel,
then measures sizes and centre colours and writes manifest.json.
"""
import json, os, sys
import numpy as np
from PIL import Image
from scipy import ndimage

OUT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1]
SCALE = 2
MIN_SPECK = 40
PLATE = {"width": 1586, "height": 992}
UNDER = 170

# Boxes are (left, top, right, bottom) in pixels of the generated original, right and bottom exclusive.
# Slices and inner areas are in pixels of the cropped original (plate pixels); the manifest doubles them.
ROOMS = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "rooms.json")))


def hex_rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def safe_area(layout):
    """The part of the background that no window from 4:3 to 21:9, nor 1100x1300, crops, in asset pixels."""
    x0, y0, x1, y1 = 0.0, 0.0, float(PLATE["width"]), float(PLATE["height"])
    for w in [4 / 3, 1.5, 1.6, 16 / 9, 2.0, 21 / 9, 2560 / 1080, 1100 / 1300, 1470 / 1270]:
        u0 = min(1.12 / PLATE["height"], 1.25 * w / PLATE["width"])
        b = max(w / PLATE["width"], (1 - UNDER * u0) / PLATE["height"])
        vw, vh = w / b, min(PLATE["height"], 1 / b)
        top = max(0.0, (PLATE["height"] - 1 / b) * layout["anchorY"])
        left = {"left": 0.0, "right": PLATE["width"] - vw, "center": (PLATE["width"] - vw) / 2}[layout["anchorX"]]
        x0, y0, x1, y1 = max(x0, left), max(y0, top), min(x1, left + vw), min(y1, top + vh)
    x0, y0, x1, y1 = (int(round(v * SCALE)) for v in (x0, y0, x1, y1))
    return {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0,
            "note": "No window from 4:3 to 21:9, nor 1100x1300, crops this area with the anchor above. The desk covers its lower part."}


def clean(im):
    a = np.array(im.convert("RGBA"))
    opaque = a[..., 3] >= 128
    labels, n = ndimage.label(opaque)
    if n > 1:
        sizes = ndimage.sum(opaque, labels, range(1, n + 1))
        for i, s in enumerate(sizes, start=1):
            if s < MIN_SPECK:
                opaque[labels == i] = False
    a[..., 3] = np.where(opaque, 255, 0)
    a[~opaque, :3] = 0
    return a


def bbox(a):
    ys, xs = np.where(a[..., 3] > 0)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def process(spec, opaque_image=False):
    im = Image.open(os.path.join(SRC, spec["source"]))
    if opaque_image:
        a = np.array(im.convert("RGB"))
        box = spec.get("box") or [0, 0, a.shape[1], a.shape[0]]
    else:
        a = clean(im)
        if spec.get("box"):
            l, t, r, b = spec["box"]
            sub = a[t:b, l:r]
            bl, bt, br, bb = bbox(sub)
            box = [l + bl, t + bt, l + br, t + bb] if spec.get("tight", True) else spec["box"]
        else:
            box = list(bbox(a))
    l, t, r, b = box
    a = a[t:b, l:r]
    out = Image.fromarray(a).resize(((r - l) * SCALE, (b - t) * SCALE), Image.NEAREST)
    out.save(os.path.join(OUT, spec["file"]), optimize=True)
    entry = {"file": spec["file"], "size": {"width": out.width, "height": out.height},
             "source": {"generated": spec["source"], "crop": box}}
    if not opaque_image:
        al = np.array(out)[..., 3]
        assert set(np.unique(al)) <= {0, 255}, spec["file"]
    if "slice" in spec:
        entry["slice"] = {k: v * SCALE for k, v in spec["slice"].items()}
        entry["repeat"] = spec.get("repeat", "stretch")
    if "inner" in spec:
        x, y, w, h = spec["inner"]
        entry["inner"] = {"x": x * SCALE, "y": y * SCALE, "width": w * SCALE, "height": h * SCALE}
        patch = a[y:y + h, x:x + w, :3].reshape(-1, 3).astype(float)
        mean = patch.mean(0)
        entry["centreColour"] = "#%02x%02x%02x" % tuple(int(round(v)) for v in mean)
        entry["centreSpread"] = round(float(patch.std(0).max()), 2)
        if "fill" in spec:
            target = np.array(hex_rgb(spec["fill"]), float)
            entry["appFill"] = spec["fill"]
            entry["distanceFromAppFill"] = round(float(np.sqrt(((mean - target) ** 2).sum())), 1)
    if opaque_image:
        entry["safeArea"] = safe_area(spec["layout"])
    for k in ("anchor", "layout", "note", "features"):
        if k in spec:
            entry[k] = spec[k]
    return entry


manifest = {
    "about": "Layered art for the three review rooms. Sizes, slices and inner areas are in asset pixels. Every asset is at 2 asset pixels per plate pixel (nearest-neighbour doubles of the generated originals), and a plate pixel is the art pixel of today's 1585x992 plates.",
    "assetPixelsPerPlatePixel": SCALE,
    "plate": PLATE,
    "deskCoversBackground": UNDER,
    "units": {
        "u0": "min(1.12 * windowHeight / 992, 1.25 * windowWidth / 1586).",
        "b": "Background scale, screen pixels per plate pixel: max(windowWidth / 1586, (windowHeight - 170 * u0) / 992). The background covers the window's width and reaches down behind the desk; the desk hides the last 170 plate pixels at object scale, so a tall window magnifies the background less.",
        "u": "Object scale, screen pixels per plate pixel, for every other layer: min(b, u0). It equals b from 16:10 to about 16:9, and is smaller than b on tall and very wide windows so the desk and objects keep their share of the window.",
    },
    "rooms": {},
}
for room, r in ROOMS.items():
    out = {k: r[k] for k in ("sceneId", "name", "notebook", "folio", "companion") if k in r}
    for layer, spec in r["layers"].items():
        if not os.path.exists(os.path.join(SRC, spec["source"])):
            print("missing", spec["source"])
            continue
        out[layer] = process(spec, opaque_image=(layer == "background"))
        e = out[layer]
        print(room, layer, e["size"], e.get("centreColour", ""), e.get("distanceFromAppFill", ""), e.get("centreSpread", ""))
    manifest["rooms"][room] = out
json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=2)
print("wrote manifest.json")
