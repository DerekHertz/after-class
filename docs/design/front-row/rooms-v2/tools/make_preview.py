"""Writes preview.html from manifest.json. The page composes each room from its layers with CSS only.

Run: python3 tools/make_preview.py
"""
import json, os

OUT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
M = json.load(open(os.path.join(OUT, "manifest.json")))
S = M["assetPixelsPerPlatePixel"]
PW, PH = M["plate"]["width"], M["plate"]["height"]
UNDER = M["deskCoversBackground"]
SIZES = [(1440, 900), (1470, 1270), (1100, 1300), (1920, 1080), (2560, 1080)]
APP = "../../../../src/app/assets"

# Ink and control colours copied from FRONT_ROW_ROOMS in src/app/front-row.tsx, for the sample text only.
INK = {
    "rail": dict(board="#f6efd9", boardSoft="#c9e6cf", mat="#1e2b45", matSoft="#4b5468", field="#fffaf3", fieldInk="#1e2b45", fieldBorder="#2f4f86", accent="#2d5aa8", accentInk="#ffffff", quiet="#f4e8d2", quietInk="#2a2620", bar="#1a2b3b", barInk="#f6ecd8", align="start"),
    "harbor": dict(board="#fbf6e6", boardSoft="#dff3e6", mat="#22252e", matSoft="#4f4a40", field="#fffaf0", fieldInk="#22252e", fieldBorder="#5b5240", accent="#0f6b5d", accentInk="#ffffff", quiet="#fbefd8", quietInk="#2a2620", bar="#1d3f7a", barInk="#fdf6e4", align="center"),
    "canal": dict(board="#191d42", boardSoft="#3b3f63", mat="#f8ead0", matSoft="#d9cdb5", field="#1f2a4b", fieldInk="#f8ead0", fieldBorder="#d9cdb5", accent="#f2b648", accentInk="#24180a", quiet="#2c3a61", quietInk="#f8ead0", bar="#1f2340", barInk="#f3e3c3", align="start"),
}


def u(n):
    return f"calc(var(--u) * {n})"


def length(v):
    return v if isinstance(v, str) else u(v)


def nine(e):
    s = e["slice"]
    w = " ".join(u(s[k] / S) for k in ("top", "right", "bottom", "left"))
    return (f"border-style: solid; border-width: {w}; "
            f"border-image: url('{e['file']}') {s['top']} {s['right']} {s['bottom']} {s['left']} fill / {w} / 0 {e.get('repeat', 'stretch')};")


def room_css(key, r):
    c = f".room-{key}"
    bg, board, desk, mat = r["background"], r["board"], r["desk"], r["mat"]
    bl, dl, ml, L = bg["layout"], desk["layout"], mat["layout"], board["layout"]
    x = {"right": "right: 0;", "left": "left: 0;", "center": f"left: calc((100cqw - var(--b) * {PW}) / 2);"}[bl["anchorX"]]
    wall_l = f"calc(var(--b) * {bl['wallFrom']})" if bl["anchorX"] == "left" else "0px"
    wall_r = f"calc(100cqw - var(--b) * {PW - bl['wallTo']})" if bl["anchorX"] == "right" else "100cqw"
    out = [f"""
{c} {{ --wall-l: {wall_l}; --wall-r: {wall_r}; --desk-top: calc(100cqh - var(--u) * {dl['height']});
  --board-top: {L['top']}; --board-h0: calc(var(--desk-top) - var(--u) * {L['gapAboveDesk']} - var(--board-top));
  --board-w: min(calc(var(--wall-r) - var(--wall-l) - var(--u) * {2 * L['sideMargin']}), calc(var(--board-h0) * {L['maxAspect']}));
  --board-h: {('min(var(--board-h0), calc(var(--board-w) / %s))' % L['minAspect']) if L.get('minAspect') else 'var(--board-h0)'};
  --board-l: calc(var(--wall-l) + (var(--wall-r) - var(--wall-l) - var(--board-w)) / 2); }}
{c} .bg {{ background-image: url('{bg['file']}'); {x} top: min(0px, calc((100cqh - var(--b) * {PH}) * {bl['anchorY']})); }}
{c} .board-art {{ {nine(board)} }}
{c} .desk {{ height: {u(desk['size']['height'] / S)}; top: var(--desk-top); {nine(desk)} }}
{c} .mat {{ width: min(calc(100cqw - var(--u) * {2 * ml['sideReserve']}), {u(ml['maxWidth'])}); top: calc(var(--desk-top) + var(--u) * {ml['top']}); bottom: {u(ml['bottom'])}; {nine(mat)} }}"""]
    ink = INK[key]
    out.append(f"{c} .board-text {{ color: {ink['board']}; --soft: {ink['boardSoft']}; text-align: {ink['align']}; inset: {' '.join(u(board['slice'][k] / S + 14) for k in ('top', 'right', 'bottom', 'left'))}; }}")
    out.append(f"{c} .mat {{ color: {ink['mat']}; --soft: {ink['matSoft']}; --field: {ink['field']}; --field-ink: {ink['fieldInk']}; --field-border: {ink['fieldBorder']}; --accent: {ink['accent']}; --accent-ink: {ink['accentInk']}; --quiet: {ink['quiet']}; --quiet-ink: {ink['quietInk']}; }}")
    out.append(f"{c} .chip {{ background: color-mix(in srgb, {ink['bar']} 86%, transparent); color: {ink['barInk']}; border-color: color-mix(in srgb, {ink['barInk']} 45%, transparent); }}")
    for name, e in r.items():
        if not isinstance(e, dict) or "file" not in e or name in ("background", "board", "desk", "mat"):
            continue
        l = e["layout"]
        pos = "; ".join(f"{k}: {length(l[k])}" for k in ("left", "right", "top", "bottom") if k in l)
        extra = f" transform: {l['transform']};" if "transform" in l else ""
        out.append(f"{c} .x-{name} {{ background-image: url('{e['file']}'); width: {u(e['size']['width'] / S)}; height: {u(e['size']['height'] / S)}; {pos}; z-index: {l.get('z', 3)};{extra} }}")
    for name in ("companion", "notebook"):
        l = r[name]["layout"]
        if name == "companion":
            out.append(f"{c} .companion {{ {l['side']}: {l['inset']}; bottom: {u(l['bottom'])}; width: {u(l['size'])}; height: {u(l['size'])}; }}")
        else:
            out.append(f"{c} .notebook {{ {l['side']}: {l['inset']}; bottom: {u(l['bottom'])}; width: {u(l['width'])}; height: {u(l['width'] * 0.75)}; }}")
            out.append(f"{c} .folio {{ {l['side']}: calc({l['inset']} + var(--u) * {l['width'] * 0.1}); bottom: {u(l['bottom'] + l['width'] * 0.75 + 8)}; width: {u(l['width'] * 0.8)}; height: {u(l['width'] * 0.6)}; }}")
    return "\n".join(out)


def room_html(key, r, w, h):
    def extras(on):
        return "".join("".join(f'<div class="layer extra x-{n}" style="left:{c}"></div>' for c in e["layout"]["copies"]) if "copies" in e["layout"] else f'<div class="layer extra x-{n}"></div>' for n, e in r.items()
                       if isinstance(e, dict) and "file" in e and n not in ("background", "board", "desk", "mat") and e["layout"].get("on", "room") == on)
    return f"""
<figure id="{key}-{w}x{h}">
  <figcaption>{r['name']} at {w}x{h}</figcaption>
  <div class="frame" style="width:{w}px;height:{h}px"><div class="room room-{key}">
    <div class="layer bg"></div>
    {extras('room')}
    <div class="board">
      <div class="layer board-art"></div>
      {extras('board')}
      <div class="board-text"><p class="eyebrow">Sampling distributions</p><p class="question">Why does a larger sample give a narrower confidence interval, and what does not change when it does?</p><p class="line">Sample text, to judge the composition only.</p></div>
    </div>
    <div class="layer desk"></div>
    {extras('desk')}
    <div class="layer mat"><div class="mat-text"><p class="label">Your thinking <span>Ctrl+Enter to share</span></p><div class="field">The standard error shrinks as the sample grows, so the interval around the mean gets tighter.</div><p class="buttons"><b>Share my thinking</b><i>Hint</i><i>I don't know</i></p></div></div>
    <div class="layer companion"></div><div class="layer folio"></div><div class="layer notebook"></div>
    <div class="chips"><span class="chip">After Class</span><span class="chip">Lecture title · Review</span><span class="chip">Room &amp; companion</span></div>
  </div></div>
</figure>"""


css = f"""
@font-face {{ font-family: 'After Class Pixel'; src: url('{APP}/fonts-v2/pixelify-sans.ttf') format('truetype'); font-weight: 400 700; }}
body {{ margin: 0; padding: 24px; background: #15171c; color: #e8e4da; font: 16px/1.5 system-ui, sans-serif; }}
h1 {{ font-size: 22px; margin: 0 0 4px; }} h2 {{ margin: 40px 0 8px; font-size: 18px; }} p.note {{ max-width: 80ch; margin: 0 0 12px; color: #b9b3a6; }}
figure {{ margin: 0 0 28px; }} figcaption {{ margin: 0 0 6px; color: #b9b3a6; }}
.frame {{ container-type: size; position: relative; overflow: hidden; background: #000; }}
/* b: background scale. u: object scale. Both are screen pixels per plate pixel; see manifest.json "units". */
.room {{ position: absolute; inset: 0; overflow: hidden; font-family: 'After Class Pixel', system-ui, sans-serif;
  --u0: min(calc(1.12 * 100cqh / {PH}), calc(1.25 * 100cqw / {PW}));
  --b: max(calc(100cqw / {PW}), calc((100cqh - var(--u0) * {UNDER}) / {PH}));
  --u: min(var(--b), var(--u0)); }}
.layer {{ position: absolute; box-sizing: border-box; image-rendering: pixelated; background-repeat: no-repeat; background-size: 100% 100%; }}
.bg {{ width: calc(var(--b) * {PW}); height: calc(var(--b) * {PH}); }}
.board {{ position: absolute; left: var(--board-l); top: var(--board-top); width: var(--board-w); height: var(--board-h); z-index: 2; }}
.board-art {{ inset: 0; }}
.board-text {{ position: absolute; overflow: hidden; z-index: 4; }}
.board-text p {{ margin: 0; }}
.eyebrow {{ color: var(--soft); font: 600 clamp(.9rem, 1.25cqw, 1.2rem)/1.2 'After Class Pixel'; letter-spacing: .14em; text-transform: uppercase; margin-bottom: 10px !important; }}
.question {{ font: 600 clamp(1.4rem, 2.7cqw, 2.7rem)/1.28 'After Class Pixel'; letter-spacing: .01em; }}
.line {{ color: var(--soft); font: 500 clamp(1.05rem, 1.45cqw, 1.35rem)/1.4 'After Class Pixel'; margin-top: .5em !important; }}
.desk {{ left: 0; right: 0; z-index: 5; }}
.mat {{ left: 50%; transform: translateX(-50%); z-index: 6; }}
.mat-text {{ position: absolute; inset: calc(var(--u) * 4) calc(var(--u) * 14); display: grid; grid-template-rows: auto 1fr auto; gap: 6px; }}
.mat-text p {{ margin: 0; }}
.label {{ font: 600 clamp(1.1rem, 1.7cqw, 1.6rem)/1.15 'After Class Pixel'; }} .label span {{ color: var(--soft); font: 400 .9rem/1.3 'After Class Pixel'; margin-left: 12px; }}
.field {{ min-height: 0; overflow: hidden; padding: 8px 14px; border: 3px solid var(--field-border); background: var(--field); color: var(--field-ink); box-shadow: inset 3px 3px 0 #0000001a; font: 500 max(1rem, min(1.25cqw, 1.2rem))/1.5 'After Class Pixel'; }}
.buttons {{ display: flex; gap: 8px; }} .buttons > * {{ padding: 7px 12px; border: 2px solid currentColor; font: 500 1rem/1.15 'After Class Pixel'; }}
.buttons b {{ background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }} .buttons i {{ background: var(--quiet); color: var(--quiet-ink); font-style: normal; }}
.extra {{ z-index: 3; }}
.companion {{ z-index: 7; background-image: url('{APP}/companions-v3/pip.png'); background-size: 300% 100%; background-position: 0 0; }}
.notebook {{ z-index: 7; background-image: url('{APP}/room-objects/review-notebook.png'); }}
.folio {{ z-index: 7; background-image: url('{APP}/room-objects/source-folio.png'); }}
.chips {{ position: absolute; z-index: 9; left: 12px; right: 12px; top: 8px; display: flex; gap: 8px; }}
.chip {{ display: flex; align-items: center; min-height: 44px; padding: 0 12px; border: 2px solid; box-shadow: 0 3px 0 #00000040; font: 500 1.05rem/1 'After Class Pixel'; }}
.chip:last-child {{ margin-left: auto; }}
"""
css += "\n".join(room_css(k, r) for k, r in M["rooms"].items())

body = """<h1>Rooms v2: layered preview</h1>
<p class="note">Static page. Each room is composed from its layers with CSS only, using the anchors in manifest.json. The companion (Pip, idle), the review notebook, the source folio and the font are today's app assets, read from src/app/assets, and are not part of this delivery. All text is sample text.</p>"""
for k, r in M["rooms"].items():
    body += f"<h2>{r['name']}</h2>" + "".join(room_html(k, r, w, h) for w, h in SIZES)

open(os.path.join(OUT, "preview.html"), "w").write(
    f"<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Rooms v2 preview</title>\n<style>{css}\n</style></head>\n<body>\n{body}\n</body></html>\n")
print("wrote preview.html")
