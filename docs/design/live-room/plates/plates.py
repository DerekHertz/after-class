# Wide empty room plates: a Meshy nano-banana-pro clean pass per room, then one side pass per side (16:9 tile whose outer part is the
# plate's edge and whose far part is blank), pasting back only the new strip. Meshy takes 16:9 at the widest, so each side is its own pass.
# usage: python3 plates.py gen <room> clean|left|right [hint]   one more take (about 9 credits)
#        python3 plates.py build <room>                          compose {room}-wide.png from the chosen takes (choices.json)
#        python3 plates.py previews                              16:10, 16:9 and 2:1 centre crops of each plate
#        python3 plates.py balance
import json
import os
import subprocess
import sys
import time

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
MOCK = os.path.join(HERE, "../mockup")
MESHY = ["npm", "exec", "--yes", "--package=meshy-cli@0.4.0", "--", "meshy"]
FLAGS = ["--output-schema", "v1", "--format", "json", "--no-update-check"]
ROOMS = {"rail": "live-room.png", "harbor": "harbor-room.png", "canal": "canal-room.png"}
LIGHT = {"rail": "warm sunlight from the window on the right", "harbor": "bright sunny seaside daylight",
         "canal": "dim blue rainy evening light with warm glow from lanterns"}
W, H = 1586, 992          # plate size; the wide plate keeps the height
TILE_W = 1764             # 16:9 at height 992
WIDE_W = 2314             # 21:9 at height 992
STRIP = (WIDE_W - W) // 2  # new pixels each side
BLANK = 400               # blank part of a side tile, more than STRIP so the model has room to continue
SEAM = 24
GRAY = (128, 128, 128)

CLEAN = ("Edit the reference image, a cosy painted HD pixel-art room. It has grey bars on its left and right edges: keep the grey bars exactly as they are. "
         "Remove ONLY these: the small companion character, the speech balloon with a question mark, any floating petals or leaves in the air, "
         "and any floating dust specks or sparkles. Paint what would be behind them (desk, wall, window) so it looks natural and empty. "
         "Keep every other object, all the furniture, the window view, the light and the colours exactly the same. No new objects, no text, no people, no characters.")
SIDE = ("Edit the reference image, a cosy painted HD pixel-art room. The {side} {pct}% of the picture is blank flat grey. Continue the room into the grey area "
        "so the picture becomes a wider room: extend the wall, floor, desk, shelf and trim straight across from the existing room, with the same perspective, "
        "same painted soft HD pixel-art style, resolution, dark outlines, colours and lighting ({light}). Show the room beyond the {side} edge: more of the same wall, "
        "desk or furniture, and some new plain furniture or decor that fits the room. Keep every pixel of the existing room exactly the same. "
        "Seen straight on from the front. No characters, no people, no text, no letters, no floating particles, no balloons.")


def meshy(args, cwd):
    out = subprocess.run(["nice"] + MESHY + args + FLAGS, capture_output=True, text=True, cwd=cwd)
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "error": out.stderr[-300:]}


def balance():
    out = subprocess.run(["nice"] + MESHY + ["api", "GET", "/balance", "--no-update-check"], capture_output=True, text=True, cwd=HERE)
    return json.loads(out.stdout)


def plate(room):
    """The mockup at 1586x992 (harbor is one pixel short, its last column repeated)."""
    im = Image.open(os.path.join(MOCK, ROOMS[room])).convert("RGB")
    if im.width < W:
        im = im.resize((W, H), Image.LANCZOS) if im.width < W - 4 else Image.fromarray(np.pad(np.asarray(im), ((0, 0), (0, W - im.width), (0, 0)), mode="edge"))
    return im


def clean_plate(room):
    p = os.path.join(HERE, "gen", room, "cleaned.png")
    return Image.open(p).convert("RGB") if os.path.exists(p) else plate(room)


def reference(room, kind):
    """The 16:9 image sent to Meshy, and its prompt."""
    tile = Image.new("RGB", (TILE_W, H), GRAY)
    if kind == "clean":
        tile.paste(plate(room), ((TILE_W - W) // 2, 0))
        return tile, CLEAN
    src = clean_plate(room)
    keep = TILE_W - BLANK
    if kind == "right":
        tile.paste(src.crop((W - keep, 0, W, H)), (0, 0))
    else:
        tile.paste(src.crop((0, 0, keep, H)), (BLANK, 0))
    return tile, SIDE.format(side=kind, pct=round(100 * BLANK / TILE_W), light=LIGHT[room])


def name(room, kind):
    return os.path.join(HERE, "gen", room, kind)


def takes(room, kind):
    d = name(room, kind)
    return sorted((t for t in os.listdir(d) if os.path.exists(os.path.join(d, t, "image_0.png"))), key=int) if os.path.isdir(d) else []


def gen(room, kind, hint=""):
    root = name(room, kind)
    os.makedirs(root, exist_ok=True)
    take = str(len(os.listdir(root)) + 1)
    d = os.path.join(root, take)
    os.makedirs(d)
    ref, text = reference(room, kind)
    text += f" {hint}" if hint else ""
    ref.save(os.path.join(d, "reference.png"))
    open(os.path.join(d, "prompt.txt"), "w").write(text)
    for _ in range(60):
        sub = meshy(["image-to-image", "create", "--ai-model", "nano-banana-pro", "--prompt", text, "--reference-image-urls", "reference.png", "--aspect-ratio", "16:9", "--async"], d)
        if sub.get("ok") or "rate_limit" not in str(sub.get("error")):
            break
        time.sleep(30)
    if not sub.get("ok"):
        return room, kind, take, f"failed {sub.get('error')}", 0
    tid = sub["result"]["submission"]["task_id"]
    proj = meshy(["project", "init", "--root", d, "--name", take, "--task-id", tid, "--task-type", "image-to-image", "--workspace", d], d)["result"]["project_dir"]
    task = (meshy(["image-to-image", "wait", tid, "--timeout", "900", "--project", proj, "--workspace", d], d).get("result") or {}).get("task") or {}
    meshy(["download", "--task-json", os.path.join(proj, f"task_{tid}.json"), "--kind", "image", "--output-dir", d, "--project", proj, "--workspace", d], d)
    json.dump({"task_id": tid, "status": task.get("status"), "credits": task.get("consumed_credits")}, open(os.path.join(d, "meta.json"), "w"))
    return room, kind, take, task.get("status"), task.get("consumed_credits")


def choices():
    p = os.path.join(HERE, "choices.json")
    return json.load(open(p)) if os.path.exists(p) else {}


def take_image(room, kind):
    t = choices().get(f"{room}/{kind}", (takes(room, kind) or [None])[-1])
    return Image.open(os.path.join(name(room, kind), t, "image_0.png")).convert("RGB").resize((TILE_W, H), Image.LANCZOS)


def build_clean(room):
    """Cleaned plate: the middle of the clean take, with the model's drift outside the picture discarded."""
    out = take_image(room, "clean").crop(((TILE_W - W) // 2, 0, (TILE_W + W) // 2, H))
    out.save(os.path.join(HERE, "gen", room, "cleaned.png"))


def ramp(n, horizontal_ascending):
    r = np.linspace(0, 1, n)
    return r if horizontal_ascending else r[::-1]


def build(room):
    if "clean" in os.listdir(os.path.join(HERE, "gen", room)):
        build_clean(room)
    mid = np.asarray(clean_plate(room)).astype(float)
    canvas = np.zeros((H, WIDE_W, 3))
    canvas[:, STRIP:STRIP + W] = mid
    keep = TILE_W - BLANK
    # Right: the tile's plate part is the plate's right `keep` columns, the new strip follows it.
    r = np.asarray(take_image(room, "right")).astype(float)
    new = r[:, keep - SEAM:keep + STRIP]
    a = np.ones(new.shape[1]); a[:SEAM] = ramp(SEAM, True)
    x0 = STRIP + W - SEAM
    canvas[:, x0:x0 + new.shape[1]] = canvas[:, x0:x0 + new.shape[1]] * (1 - a[None, :, None]) + new * a[None, :, None]
    # Left: the new strip is the tile's first BLANK columns, mirrored seam on its right edge.
    l = np.asarray(take_image(room, "left")).astype(float)
    new = l[:, BLANK - STRIP:BLANK + SEAM]
    a = np.ones(new.shape[1]); a[-SEAM:] = ramp(SEAM, False)
    canvas[:, :new.shape[1]] = canvas[:, :new.shape[1]] * (1 - a[None, :, None]) + new * a[None, :, None]
    Image.fromarray(np.clip(canvas, 0, 255).astype(np.uint8)).save(os.path.join(HERE, f"{room}-wide.png"))


def previews():
    for room in ROOMS:
        p = os.path.join(HERE, f"{room}-wide.png")
        if not os.path.exists(p):
            continue
        im = Image.open(p)
        os.makedirs(os.path.join(HERE, "previews"), exist_ok=True)
        for tag, (w, h) in {"16x10": (1586, 992), "16x9": (1764, 992), "2x1": (1984, 992)}.items():
            im.crop(((im.width - w) // 2, 0, (im.width + w) // 2, h)).save(os.path.join(HERE, "previews", f"{room}-{tag}.png"))
        # 2:1 at 2580x1290 as asked: the 1984x992 centre slice at 1.3x.
        im.crop(((im.width - 1984) // 2, 0, (im.width + 1984) // 2, 992)).resize((2580, 1290), Image.LANCZOS).save(os.path.join(HERE, "previews", f"{room}-2x1.png"))


if __name__ == "__main__":
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "balance":
        print(balance())
    elif cmd == "gen":
        print(*gen(args[0], args[1], " ".join(args[2:])), flush=True)
    elif cmd == "build":
        build(args[0])
    elif cmd == "previews":
        previews()
