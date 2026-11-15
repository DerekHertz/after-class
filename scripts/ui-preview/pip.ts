/**
 * Dev page: plays Pip's gesture frames over the harbor room, so a person can judge them animated. It is not part of the app.
 * `?gesture=blink` plays one gesture on a loop, `?gesture=all` (the default) plays every one in turn, `?still=nod` shows a single frame.
 * The frames are the shipped large files. This page does the timing and the hop's lift, as the stage in #222 will.
 */
import background from "../../src/app/assets/front-row-v2/harbor-background.webp";
import desk from "../../src/app/assets/front-row-v2/harbor-desk.webp";
import blink from "../../src/app/assets/companion-frames/pip/blink.webp";
import lookBoard from "../../src/app/assets/companion-frames/pip/look-board.webp";
import lookMat from "../../src/app/assets/companion-frames/pip/look-mat.webp";
import nod from "../../src/app/assets/companion-frames/pip/nod.webp";
import hopCrouch from "../../src/app/assets/companion-frames/pip/hop-crouch.webp";
import hopAir from "../../src/app/assets/companion-frames/pip/hop-air.webp";
import think from "../../src/app/assets/companion-frames/pip/think.webp";
import cheer from "../../src/app/assets/companion-frames/pip/cheer.webp";
import talk from "../../src/app/assets/companion-frames/pip/talk.webp";
import idleSheet from "../../src/app/assets/companions-v3/pip.webp";

const CELL = 724;
/** The hop-air frame is drawn this many cell pixels below the ground line (measured in test/companion-frames.test.ts). */
const AIR_DROP = 54;
const frames = { blink, "look-board": lookBoard, "look-mat": lookMat, nod, "hop-crouch": hopCrouch, "hop-air": hopAir, think, cheer, talk } as const;
type Frame = keyof typeof frames | "idle";
/** One step: the frame, how long it shows in ms, and a lift in cell pixels. */
type Step = readonly [Frame, number, number?];
const GESTURES: Record<string, readonly Step[]> = {
  blink: [["idle", 900], ["blink", 120], ["idle", 600]],
  "look-board": [["idle", 400], ["look-board", 1400], ["idle", 400]],
  "look-mat": [["idle", 400], ["look-mat", 1400], ["idle", 400]],
  nod: [["idle", 300], ["nod", 260], ["idle", 160], ["nod", 260], ["idle", 400]],
  hop: [["idle", 300], ["hop-crouch", 180], ["hop-air", 260, -90 - AIR_DROP], ["hop-crouch", 140], ["idle", 500]],
  think: [["idle", 300], ["think", 1800], ["idle", 400]],
  cheer: [["idle", 300], ["cheer", 1200], ["idle", 400]],
  talk: [["idle", 200], ["talk", 150], ["idle", 120], ["talk", 150], ["idle", 120], ["talk", 150], ["idle", 300]],
};

const pip = document.getElementById("pip") as HTMLImageElement;
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
  sheet.src = idleSheet;
});
const urlOf = (frame: Frame) => (frame === "idle" ? idleUrl : frames[frame]);
await Promise.all(Object.values(frames).map((u) => new Promise((r) => { const i = new Image(); i.onload = i.onerror = r; i.src = u; })));

function show(frame: Frame, lift = 0) {
  pip.src = urlOf(frame);
  pip.style.transform = `translateY(${(lift / CELL) * 100}%)`;
}

const params = new URLSearchParams(location.search);
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
