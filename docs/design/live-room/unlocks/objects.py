# Unlock objects: a Meshy nano-banana-pro image-to-image edit of each slot's room crop adds the object, then the object is
# keyed out by differencing the edit against the crop and fitted to the slot's box at plate density.
# usage: python3 objects.py gen <slot> [hint]   submit one more take of a slot (about 9 credits)
#        python3 objects.py build [slot ...]   key each slot's chosen take into art/masters/unlock-objects/, write sheet.png
#        python3 objects.py balance            print the account's credit balance
import json
import os
import subprocess
import sys
import time

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "../../../.."))
MASTERS = os.path.join(ROOT, "art/masters/unlock-objects")
MESHY = ["npm", "exec", "--yes", "--package=meshy-cli@0.4.0", "--", "meshy"]
FLAGS = ["--output-schema", "v1", "--format", "json", "--no-update-check"]
REFERENCE_SIDE = 1024
# A pixel whose largest channel moved more than this between the crop and the edit is part of the edit.
CHANGED = 40
# Next to the object, a pixel that moved more than this is still the object, painted close to the room's colour behind it.
WEAK = 20

LIGHT = {
    "last-desk": "warm afternoon daylight from the window on the right",
    "study-bench": "bright sunny seaside daylight from above",
    "projection-booth": "dim blue rainy evening light with a warm glow from the lanterns outside",
}

# Slot id: what to paint, how it meets the room (stands on its base or hangs from its top), what it rests on or hangs from,
# its box in plate pixels and the box's top left corner in the crop (docs/design/live-room/unlocks.md).
SLOTS = {
    "last-desk/1": ("a pencil cup holding a few pencils", "stand", "the top of the wooden desk's back edge", (52, 74), (111, 111)),
    "last-desk/2": ("a small potted plant in a terracotta pot", "stand", "the green window sill", (70, 84), (126, 126)),
    "last-desk/3": ("a low, wide stack of two closed hardback books lying flat", "stand", "the top of the wooden desk's back edge", (112, 52), (168, 168)),
    "last-desk/4": ("a red apple", "stand", "the wooden chalk ledge under the chalkboard", (40, 40), (60, 60)),
    "last-desk/5": ("two closed hardback books standing and leaning on each other", "stand", "the green window sill", (64, 70), (105, 105)),
    "last-desk/6": ("a small desk globe on a wooden stand", "stand", "the top of the wooden desk's back edge", (64, 72), (108, 108)),
    "study-bench/1": ("a potted basil herb in a small terracotta pot", "stand", "the top of the teal terrace railing", (56, 64), (96, 96)),
    "study-bench/2": ("a glass of lemonade with a lemon slice and a straw", "stand", "the top of the wooden desk's back edge", (44, 64), (96, 96)),
    "study-bench/3": ("a round paper lantern on a short cord", "hang", "the edge of the striped awning above, off the top of the picture", (52, 84), (126, 126)),
    "study-bench/4": ("a short stack of three closed hardback books lying flat", "stand", "the top of the wooden desk's back edge", (112, 52), (168, 168)),
    "study-bench/5": ("a pale pink spiral seashell", "stand", "the top of the wooden desk's back edge", (60, 40), (90, 90)),
    "study-bench/6": ("a small sparrow perched side-on", "stand", "the top of the teal terrace railing", (44, 40), (16, 66)),
    "projection-booth/1": ("a cup of tea on a saucer, with no steam", "stand", "the top of the wooden desk's back edge", (52, 56), (84, 84)),
    "projection-booth/2": ("a small unlit red paper lantern on a short cord, with no glow around it", "hang", "the top of the window frame, off the top of the picture", (50, 80), (120, 120)),
    "projection-booth/3": ("a low stack of two round metal film canisters lying flat", "stand", "the top of the wooden desk's back edge", (100, 56), (150, 150)),
    "projection-booth/4": ("a small glass wind chime with a long white paper strip hanging below it", "hang", "the top of the window frame, off the top of the picture", (40, 84), (110, 126)),
    "projection-booth/5": ("a small brass desk lamp, switched off, with no glow", "stand", "the top of the wooden desk's back edge", (60, 74), (111, 111)),
    "projection-booth/6": ("a small glass jar filled with colourful paper ticket stubs", "stand", "the top of the wooden desk's back edge", (48, 58), (87, 87)),
}

BASE = ("Edit the reference image, a crop of a cosy painted pixel-art room. Add ONLY one new object: {what}, {meet} {on}. "
        "Put it in this exact place: its left edge {left}% and its right edge {right}% across the picture from the left, "
        "its top {top}% and its bottom {bottom}% down from the top. Paint it in exactly the same soft painted HD pixel-art "
        "style, resolution, dark outlines, colours and shading as the room, lit by the room's own light ({light}), seen "
        "straight on from the front like the rest of the room. Keep every other pixel exactly the same: do not move, "
        "recolour, redraw, crop or restyle anything else. No cast shadow on the room, no text, no letters, no numbers, no people, no characters.{hint}")


def name(slot):
    return slot.replace("/", "-")


def crop_box(slot):
    """The largest square of the slot's crop that holds its box, as near centred on it as the crop allows."""
    crop = Image.open(os.path.join(HERE, "crops", f"{name(slot)}.png"))
    (w, h), (x, y) = SLOTS[slot][3], SLOTS[slot][4]
    side = min(crop.size)
    left = int(np.clip(x + w / 2 - side / 2, 0, crop.width - side))
    top = int(np.clip(y + h / 2 - side / 2, 0, crop.height - side))
    return crop.convert("RGB").crop((left, top, left + side, top + side)), (x - left, y - top)


def prompt(slot, hint=""):
    what, how, on, (w, h), _ = SLOTS[slot]
    square, (x, y) = crop_box(slot)
    pct = lambda v: round(100 * v / square.width)
    meet = "standing with its base resting on" if how == "stand" else "hanging from"
    return BASE.format(what=what, meet=meet, on=on, left=pct(x), right=pct(x + w), top=pct(y), bottom=pct(y + h),
                       light=LIGHT[slot.split("/")[0]], hint=f" {hint}" if hint else "")


def meshy(args, cwd):
    out = subprocess.run(MESHY + args + FLAGS, capture_output=True, text=True, cwd=cwd)
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "error": out.stderr[-300:]}


def balance():
    out = subprocess.run(MESHY + ["api", "GET", "/balance", "--no-update-check"], capture_output=True, text=True, cwd=HERE)
    return json.loads(out.stdout)["balance"]


def takes(slot):
    d = os.path.join(HERE, "gen", name(slot))
    return sorted((t for t in os.listdir(d) if os.path.exists(os.path.join(d, t, "image_0.png"))), key=int) if os.path.isdir(d) else []


def gen(slot, hint=""):
    root = os.path.join(HERE, "gen", name(slot))
    os.makedirs(root, exist_ok=True)
    take = str(len(os.listdir(root)) + 1)
    d = os.path.join(root, take)
    os.makedirs(d)
    square, _ = crop_box(slot)
    k = -(-REFERENCE_SIDE // square.width)
    square.resize((square.width * k, square.height * k), Image.NEAREST).save(os.path.join(d, "reference.png"))
    text = prompt(slot, hint)
    open(os.path.join(d, "prompt.txt"), "w").write(text)
    for _ in range(60):
        sub = meshy(["image-to-image", "create", "--ai-model", "nano-banana-pro", "--prompt", text, "--reference-image-urls", "reference.png", "--aspect-ratio", "1:1", "--async"], d)
        if sub.get("ok") or "rate_limit" not in str(sub.get("error")):
            break
        time.sleep(30)
    if not sub.get("ok"):
        return slot, take, f"failed {sub.get('error')}", 0
    tid = sub["result"]["submission"]["task_id"]
    proj = meshy(["project", "init", "--root", d, "--name", take, "--task-id", tid, "--task-type", "image-to-image", "--workspace", d], d)["result"]["project_dir"]
    task = (meshy(["image-to-image", "wait", tid, "--timeout", "900", "--project", proj, "--workspace", d], d).get("result") or {}).get("task") or {}
    meshy(["download", "--task-json", os.path.join(proj, f"task_{tid}.json"), "--kind", "image", "--output-dir", d, "--project", proj, "--workspace", d], d)
    json.dump({"task_id": tid, "status": task.get("status"), "credits": task.get("consumed_credits")}, open(os.path.join(d, "meta.json"), "w"))
    return slot, take, task.get("status"), task.get("consumed_credits")


def key(slot, take):
    """The object of one take on transparency at the slot's box size, how much of the room outside it moved, and the edit."""
    _, how, _, (w, h), _ = SLOTS[slot]
    square, (x, y) = crop_box(slot)
    side = square.width
    edit = Image.open(os.path.join(HERE, "gen", name(slot), take, "image_0.png")).convert("RGB").resize((side, side), Image.LANCZOS)
    a, b = np.asarray(edit).astype(int), np.asarray(square).astype(int)
    changed = ndimage.binary_opening(np.abs(a - b).max(axis=2) > CHANGED, iterations=1)
    labels, n = ndimage.label(changed)
    if n == 0:
        return None, 0.0, edit
    sizes = ndimage.sum(changed, labels, range(1, n + 1))
    # The model does not always put the object where it was asked, so the object is the largest change near the box, and
    # anything within a few pixels of it, such as a chime's paper strip below its thin string.
    reach = max(w, h)
    near = np.zeros_like(changed)
    near[max(0, y - reach):y + h + reach, max(0, x - reach):x + w + reach] = True
    candidates = (set(np.unique(labels[y:y + h, x:x + w])) - {0}) or (set(np.unique(labels[near])) - {0}) or set(range(1, n + 1))
    biggest = labels == max(candidates, key=lambda i: sizes[i - 1])
    touching = set(np.unique(labels[ndimage.binary_dilation(biggest, iterations=10)])) - {0}
    mask = np.isin(labels, [i for i in touching if sizes[i - 1] >= 20])
    # Grow into weaker change next to the object, where its colour is close to the room's behind it, then fill it solid.
    weak = (np.abs(a - b).max(axis=2) > WEAK) & ndimage.binary_dilation(mask, iterations=3)
    weak_labels, _ = ndimage.label(weak | mask)
    mask = np.isin(weak_labels, np.unique(weak_labels[mask]))
    mask = ndimage.binary_fill_holes(ndimage.binary_closing(mask, iterations=3))
    drift = float((np.abs(a - b).max(axis=2) > CHANGED)[~ndimage.binary_dilation(mask, iterations=6)].mean())
    ys, xs = np.nonzero(mask)
    l, t, r, btm = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
    rgb, alpha = a[t:btm, l:r].astype(float), mask[t:btm, l:r].astype(float)
    if r - l > w or btm - t > h:
        # Shrunk with the alpha premultiplied, so no colour of the room around the object bleeds into its edge.
        s = min(w / (r - l), h / (btm - t))
        size = (max(1, round((r - l) * s)), max(1, round((btm - t) * s)))
        shrink = lambda ch: np.asarray(Image.fromarray(ch.astype(np.float32), "F").resize(size, Image.LANCZOS)).astype(float)
        alpha = np.clip(shrink(alpha), 0, 1)
        rgb = np.dstack([shrink(rgb[..., c] * mask[t:btm, l:r]) for c in range(3)]) / np.maximum(alpha, 1e-3)[..., None]
    obj = Image.fromarray(np.dstack([np.clip(rgb, 0, 255), np.where(alpha >= 0.5, 255, 0)]).astype(np.uint8), "RGBA")
    ox, oy = (w - obj.width) // 2, h - obj.height if how == "stand" else 0
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.alpha_composite(obj, (ox, oy))
    arr = np.asarray(out).copy()
    arr[arr[..., 3] == 0] = 0
    return Image.fromarray(arr, "RGBA"), drift, edit


def choices():
    path = os.path.join(HERE, "choices.json")
    return json.load(open(path)) if os.path.exists(path) else {}


def build(only):
    chosen, sheet_rows = choices(), []
    for slot in only or list(SLOTS):
        all_takes = takes(slot)
        if not all_takes:
            continue
        take = chosen.get(slot, all_takes[-1])
        obj, drift, edit = key(slot, take)
        room, n = slot.split("/")
        meta = lambda t: json.load(open(os.path.join(HERE, "gen", name(slot), t, "meta.json")))
        print(f"{slot:20} take {take} of {len(all_takes)}  room outside the object moved {drift:.1%}" + ("  NO OBJECT FOUND" if obj is None else ""))
        if obj is None:
            continue
        os.makedirs(os.path.join(MASTERS, room), exist_ok=True)
        obj.save(os.path.join(MASTERS, room, f"{n}.png"))
        prov_path = os.path.join(MASTERS, room, "provenance.json")
        prov = json.load(open(prov_path)) if os.path.exists(prov_path) else {"room": room, "model": "nano-banana-pro", "frames": {}}
        prov["frames"][n] = {
            "object": SLOTS[slot][0], "prompt": open(os.path.join(HERE, "gen", name(slot), take, "prompt.txt")).read(),
            "meshy_task_id": meta(take)["task_id"], "credits": meta(take)["credits"],
            "crop": f"docs/design/live-room/unlocks/crops/{name(slot)}.png", "room_outside_moved": round(drift, 3),
            "rejected_takes": [{"meshy_task_id": meta(t)["task_id"], "credits": meta(t)["credits"]} for t in all_takes if t != take],
        }
        prov["frames"] = dict(sorted(prov["frames"].items()))
        json.dump(prov, open(prov_path, "w"), indent=1)
        sheet_rows.append((slot, crop_box(slot)[0], edit, obj))
    if not only:
        sheet(sheet_rows)


def sheet(rows):
    """Each slot as the crop, the edit and the object on a neutral ground, at three times plate density."""
    cell, z = 3 * 168, 3
    out = Image.new("RGB", (cell * 3 * 2, cell * ((len(rows) + 1) // 2)), (232, 226, 214))
    for i, (_, square, edit, obj) in enumerate(rows):
        ox, oy = (i % 2) * cell * 3, (i // 2) * cell
        for j, im in enumerate([square, edit]):
            im = im.resize((cell, cell), Image.NEAREST)
            out.paste(im, (ox + j * cell, oy))
        big = obj.resize((obj.width * z, obj.height * z), Image.NEAREST)
        out.paste(big, (ox + 2 * cell + (cell - big.width) // 2, oy + (cell - big.height) // 2), big)
    out.save(os.path.join(HERE, "gen", "sheet.png"))


if __name__ == "__main__":
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "balance":
        print(balance())
    elif cmd == "gen":
        assert args[0] in SLOTS, f"unknown slot {args[0]}"
        print(*gen(args[0], " ".join(args[1:])), flush=True)
    elif cmd == "prompt":
        print(prompt(args[0]))
    else:
        build(args)
