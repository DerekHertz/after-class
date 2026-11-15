/**
 * Dev page: plays a companion's gesture frames over the harbor room, so a person can judge them animated. It is not part of the app.
 * `?companion=mote` picks the companion (pip, mote, mote-moonlit, mote-pagewing, lumi or yun, default pip).
 * `?gesture=blink` plays one gesture on a loop, `?gesture=all` (the default) plays every one in turn, `?still=nod` shows a single frame.
 * The frames are the shipped large files, served by scripts/preview-ui.ts. This page does the timing and the hop's lift, as the stage in #222 will.
 */
import background from "../../src/app/assets/front-row-v2/harbor-background.webp";
import desk from "../../src/app/assets/front-row-v2/harbor-desk.webp";

const CELL = 724;
/** How many cell pixels below the ground line each companion's hop-air frame is drawn (measured in test/companion-frames.test.ts). */
const AIR_DROPS: Record<string, number> = { pip: 54, mote: 38, "mote-moonlit": 46, "mote-pagewing": 61, lumi: 0, yun: 39 };
/** Frames a companion has no shipped file for, because they failed the mechanical checks and wait on Derek. */
const MISSING: Record<string, readonly string[]> = { lumi: ["cheer"] };
const params = new URLSearchParams(location.search);
const companion = params.get("companion") ?? "pip";
if (!(companion in AIR_DROPS)) throw new Error(`unknown companion ${companion}`);
const AIR_DROP = AIR_DROPS[companion]!;
const FRAMES = ["blink", "look-board", "look-mat", "nod", "hop-crouch", "hop-air", "think", "cheer", "talk"].filter((f) => !MISSING[companion]?.includes(f));
type Frame = string;
/** One step: the frame, how long it shows in ms, and a lift in cell pixels. */
type Step = readonly [Frame, number, number?];
const ALL_GESTURES: Record<string, readonly Step[]> = {
  blink: [["idle", 900], ["blink", 120], ["idle", 600]],
  "look-board": [["idle", 400], ["look-board", 1400], ["idle", 400]],
  "look-mat": [["idle", 400], ["look-mat", 1400], ["idle", 400]],
  nod: [["idle", 300], ["nod", 260], ["idle", 160], ["nod", 260], ["idle", 400]],
  hop: [["idle", 300], ["hop-crouch", 180], ["hop-air", 260, -90 - AIR_DROP], ["hop-crouch", 140], ["idle", 500]],
  think: [["idle", 300], ["think", 1800], ["idle", 400]],
  cheer: [["idle", 300], ["cheer", 1200], ["idle", 400]],
  talk: [["idle", 200], ["talk", 150], ["idle", 120], ["talk", 150], ["idle", 120], ["talk", 150], ["idle", 300]],
};

const GESTURES = Object.fromEntries(Object.entries(ALL_GESTURES).filter(([, steps]) => steps.every(([frame]) => frame === "idle" || FRAMES.includes(frame))));

const pip = document.getElementById("pip") as HTMLImageElement;
pip.alt = companion;
(document.getElementById("bg") as HTMLImageElement).src = background;
(document.getElementById("desk") as HTMLImageElement).src = desk;

// Idle is the first cell of the approved sheet, drawn through a canvas so every frame is an <img> of one square cell.
const idleUrl = await new Promise<string>((resolve) => {
  const sheet = new Image();
  sheet.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = CELL;
    canvas.getContext("2d")!.drawImage(sheet, 0, 0, CELL, CELL, 0, 0, CELL, CELL);
    resolve(canvas.toDataURL("image/png"));
  };
  sheet.src = `/assets/companions-v3/${companion}.webp`;
});
const frames: Record<string, string> = Object.fromEntries(FRAMES.map((f) => [f, `/assets/companion-frames/${companion}/${f}.webp`]));
const urlOf = (frame: Frame) => (frame === "idle" ? idleUrl : frames[frame]!);
await Promise.all(Object.values(frames).map((u) => new Promise((r) => { const i = new Image(); i.onload = i.onerror = r; i.src = u; })));

function show(frame: Frame, lift = 0) {
  pip.src = urlOf(frame);
  pip.style.transform = `translateY(${(lift / CELL) * 100}%)`;
}

const still = params.get("still");
let token = 0;
/** Plays one gesture, or every gesture in turn when `names` has several, until another choice bumps the token. */
async function play(names: readonly string[], loop: boolean) {
  const mine = ++token;
  do for (const name of names) for (const [frame, ms, lift] of GESTURES[name]!) {
    if (mine !== token) return;
    show(frame, lift ?? 0);
    await new Promise((r) => setTimeout(r, ms));
  } while (loop);
}

const bar = document.getElementById("bar")!;
const choose = (name: string) => { for (const b of bar.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.name === name)); void play(name === "all" ? Object.keys(GESTURES) : [name], true); };
for (const name of ["all", ...Object.keys(GESTURES)]) {
  const button = document.createElement("button");
  button.textContent = name; button.dataset.name = name; button.setAttribute("aria-pressed", "false");
  button.onclick = () => choose(name);
  bar.append(button);
}
if (still !== null) show(still as Frame);
else choose(params.get("gesture") ?? "all");
