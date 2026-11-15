# Painted companion frames: Meshy nano-banana-pro image-to-image edits of each companion's idle cell, then keyed to the master's cell.
# usage: python3 frames.py gen <companion> [frame ...]    submit edits (9 credits each), skip frames already downloaded
#        python3 frames.py build <companion>             write <companion>/<frame>.png, frames.png, loop.gif, provenance.json
import concurrent.futures as cf
import json
import os
import subprocess
import sys
import time

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "../../../.."))
MESHY = ["npm", "exec", "--yes", "--package=meshy-cli@0.4.0", "--", "meshy"]
FLAGS = ["--output-schema", "v1", "--format", "json", "--no-update-check"]
CELL = 724
MAGENTA = (255, 0, 255)

COMPANIONS = {
    "pip": "a small eraser-shaped mascot with tiny hands and dark blue feet",
    "mote": "a fluffy moth mascot in a blue jacket with a brown satchel",
    "mote-moonlit": "a fluffy moth mascot with a navy scarf",
    "mote-pagewing": "a fluffy moth mascot with a green satchel",
    "lumi": "a friendly brass desk-lamp mascot whose lamp shade is its face",
    "yun": "a small cloud-lamb mascot curled on a green cloud, with a red scarf",
}

FRAMES = {
    "blink": "close both eyes, drawn as two short gently curved dark lines, as in a blink",
    "look-board": "turn the eyes up and to the right, as if reading a chalkboard above and to the right, with a small curious open mouth",
    "look-mat": "move both eye dots to the lower right, glancing down and to the right at the desk, attentive",
    "nod": "a happy nod: the whole character tips forward slightly, eyes closed in two upward-curved smiling arcs, small smile",
    "hop-crouch": "squash down a little as if about to hop: slightly shorter and wider, eyes squeezed shut happily",
    "hop-air": "stretched a little taller and narrower as at the top of a happy hop, with a joyful open smile; keep it standing in the same place",
    "think": "thinking: move both eye dots up and to the left, make the mouth a small flat line, and add one tiny sweat drop beside the head",
    "cheer": "cheering: both small hands raised up beside the head, a big open happy smile and light blush marks, still sitting",
    "talk": "talking: the same pose with a small open rounded mouth, as if saying something",
}

OVERRIDES = {
    "mote": {"cheer": "cheering: both wings lifted and spread a little higher, a big open happy smile and light blush marks, still sitting"},
    "mote-moonlit": {"cheer": "cheering: both wings lifted and spread a little higher, a big open happy smile and light blush marks, still sitting"},
    "mote-pagewing": {"cheer": "cheering: both wings lifted and spread a little higher, a big open happy smile and light blush marks, still sitting"},
    "lumi": {
        "nod": "a happy nod: the lamp shade tips forward and down slightly on its arm, eyes closed in two upward-curved smiling arcs",
        "hop-crouch": "squash down as if about to hop: the arm folds lower so the shade sits lower, eyes squeezed shut happily",
        "hop-air": "the arm stretched a little straighter and taller as at the top of a happy hop, the shade raised, joyful open smile; keep the base in the same place",
        "cheer": "cheering: the arm stretched up so the shade is raised high, a big open happy smile, light blush marks and a few small warm sparkles around the shade",
        "think": "thinking: the shade tilts slightly to the left, eyes look up and to the left, the mouth is a small flat line, one tiny sweat drop beside the shade",
    },
    "yun": {"cheer": "cheering: the lamb sits up taller on its cloud with a big open happy smile and light blush marks, the cloud puffing up a little"},
}

BASE = ("Edit the reference image, {who}, a painted pixel-art-style mascot on a flat magenta background. Make ONLY this change: {c}. "
        "Keep everything else exactly the same: the same character, the same soft painted HD pixel-art style and resolution, the same "
        "dark outlines, colours, shading and highlights, the same size and position in the frame, and the same flat solid magenta "
        "#ff00ff background. No text, no extra objects, no shadow.")


def prompt(cid, frame):
    return BASE.format(who=COMPANIONS[cid], c=OVERRIDES.get(cid, {}).get(frame, FRAMES[frame]))


def idle(cid):
    return Image.open(os.path.join(ROOT, "art/masters/companions-v3", f"{cid}.png")).convert("RGBA").crop((0, 0, CELL, CELL))


def reference(cid):
    path = os.path.join(HERE, "gen", cid, "idle-on-magenta.png")
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        bg = Image.new("RGBA", (CELL, CELL), MAGENTA + (255,))
        bg.alpha_composite(idle(cid))
        bg.convert("RGB").save(path)
    return path


def meshy(args, cwd):
    out = subprocess.run(MESHY + args + FLAGS, capture_output=True, text=True, cwd=cwd)
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "error": out.stderr[-300:]}


def gen(cid, frame):
    d = os.path.join(HERE, "gen", cid, frame)
    if os.path.exists(os.path.join(d, "image_0.png")):
        return frame, "exists", 0
    os.makedirs(d, exist_ok=True)
    text = prompt(cid, frame)
    open(os.path.join(d, "prompt.txt"), "w").write(text)
    ref = os.path.relpath(reference(cid), d)
    for _ in range(60):
        sub = meshy(["image-to-image", "create", "--ai-model", "nano-banana-pro", "--prompt", text, "--reference-image-urls", ref, "--aspect-ratio", "1:1", "--async"], d)
        if sub.get("ok") or "rate_limit" not in str(sub.get("error")):
            break
        time.sleep(30)
    if not sub.get("ok"):
        return frame, f"failed {sub.get('error')}", 0
    tid = sub["result"]["submission"]["task_id"]
    proj = meshy(["project", "init", "--root", d, "--name", frame, "--task-id", tid, "--task-type", "image-to-image", "--workspace", d], d)["result"]["project_dir"]
    task = (meshy(["image-to-image", "wait", tid, "--timeout", "900", "--project", proj, "--workspace", d], d).get("result") or {}).get("task") or {}
    meshy(["download", "--task-json", os.path.join(proj, f"task_{tid}.json"), "--kind", "image", "--output-dir", d, "--project", proj, "--workspace", d], d)
    json.dump({"task_id": tid, "status": task.get("status"), "credits": task.get("consumed_credits")}, open(os.path.join(d, "meta.json"), "w"))
    return frame, task.get("status"), task.get("consumed_credits")


def key(img):
    """Magenta to transparent; halve the magenta spill left on edge pixels."""
    a = np.asarray(img.convert("RGB").resize((CELL, CELL), Image.LANCZOS)).astype(float)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mag = np.clip((np.minimum(r, b) - g) / 255, 0, 1)
    out = np.dstack([a, np.where(mag > 0.45, 0, 255)])
    spill = (mag > 0) & (mag <= 0.45)
    out[..., 0] = np.where(spill, r - mag * 255 / 2, r)
    out[..., 2] = np.where(spill, b - mag * 255 / 2, b)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA")


def build(cid):
    out = os.path.join(HERE, cid)
    os.makedirs(out, exist_ok=True)
    base = idle(cid)
    base.save(os.path.join(out, "idle.png"))
    flat = lambda im: np.asarray(Image.alpha_composite(Image.new("RGBA", im.size, MAGENTA + (255,)), im).convert("RGB")).astype(int)
    ba = flat(base)
    frames, prov = {"idle": base}, {}
    for f in FRAMES:
        d = os.path.join(HERE, "gen", cid, f)
        if not os.path.exists(os.path.join(d, "image_0.png")):
            continue
        im = key(Image.open(os.path.join(d, "image_0.png")))
        im.save(os.path.join(out, f"{f}.png"))
        frames[f] = im
        changed = (np.abs(flat(im) - ba).sum(axis=2) > 48).mean()
        meta = json.load(open(os.path.join(d, "meta.json")))
        prov[f] = {"prompt": open(os.path.join(d, "prompt.txt")).read(), "meshy_task_id": meta["task_id"], "credits": meta["credits"], "changed_vs_idle": round(float(changed), 3)}
    json.dump({"companion": cid, "master": f"art/masters/companions-v3/{cid}.png", "cell": CELL, "model": "nano-banana-pro", "frames": prov}, open(os.path.join(out, "provenance.json"), "w"), indent=1)

    names = list(frames)
    sheet = Image.new("RGBA", (CELL // 2 * len(names), CELL // 2), (232, 226, 214, 255))
    for i, n in enumerate(names):
        sheet.alpha_composite(frames[n].resize((CELL // 2, CELL // 2), Image.LANCZOS), (CELL // 2 * i, 0))
    sheet.convert("RGB").save(os.path.join(out, "frames.png"))
    seq = [n for n in ["idle", "blink", "idle", "look-board", "look-board", "idle", "look-mat", "idle", "talk", "idle", "talk", "idle", "think", "think",
                       "idle", "nod", "idle", "hop-crouch", "hop-air", "hop-crouch", "idle", "cheer", "cheer", "idle"] if n in frames]
    lift = {"hop-air": 36}
    gif = []
    for n in seq:
        c = Image.new("RGBA", (CELL // 2, CELL // 2 + 20), (232, 226, 214, 255))
        c.alpha_composite(frames[n].resize((CELL // 2, CELL // 2), Image.LANCZOS), (0, 20 - lift.get(n, 0) // 2))
        gif.append(c.convert("RGB"))
    gif[0].save(os.path.join(out, "loop.gif"), save_all=True, append_images=gif[1:], duration=[700 if n == "idle" else 450 for n in seq], loop=0)
    for f, p in prov.items():
        print(f"{cid} {f:11} changed {p['changed_vs_idle']:.1%}")


if __name__ == "__main__":
    cmd, cid, only = sys.argv[1], sys.argv[2], sys.argv[3:]
    assert cid in COMPANIONS, f"unknown companion {cid}"
    if cmd == "gen":
        with cf.ThreadPoolExecutor(max_workers=4) as ex:
            for r in ex.map(lambda f: gen(cid, f), only or list(FRAMES)):
                print(cid, *r, flush=True)
    else:
        build(cid)
