import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { COMPANIONS } from "../src/app/appearance";
import type { CompanionActivity, CompanionId } from "../src/app/appearance";
import { AIR_DROP, GESTURES, companionAt, companionDraw, restsFrom } from "../src/app/room/companion";
import type { CompanionCue, Frame, Idle } from "../src/app/room/companion";
import { COMPANION_ART } from "../src/app/room/companion-art";
import { layoutRoom } from "../src/app/room/layout";
import { REACTION_MS } from "../src/app/room/reaction-store";
import { GESTURES as GESTURE_NAMES } from "../src/app/room/reactions";
import type { Gesture } from "../src/app/room/reactions";
import { buildScene } from "../src/app/room/scene";

const REPO = join(import.meta.dir, "..");
const ids = Object.keys(COMPANIONS) as CompanionId[];
const idle: Idle = { since: 0, seed: 7 };
const cue = (id: CompanionId, gesture: Gesture | null, at = 1000, activity: CompanionActivity = "idle"): CompanionCue =>
  ({ id, activity, gesture: gesture === null ? null : { name: gesture, at } });
/** The frames shown from `from` until `until`, following each `next` the animator gives, as [time, frame, lift]. */
function play(c: CompanionCue, from: number, until: number, clock: Idle = idle): [number, Frame, number][] {
  const out: [number, Frame, number][] = [];
  for (let t: number | null = from; t !== null && t < until;) {
    const shown = companionAt(c, clock, t);
    out.push([t, shown.frame, shown.lift]);
    t = shown.next;
  }
  return out;
}

describe("a gesture plays its painted frames on stepped timing, then the companion rests", () => {
  test("a nod is nod, idle, nod, and each change is scheduled for the moment it happens", () => {
    expect(play(cue("pip", "nod"), 1000, 1700)).toEqual([[1000, "nod", 0], [1260, "idle", 0], [1420, "nod", 0], [1680, "idle", 0]]);
  });

  test("talking opens and closes the mouth three times", () => {
    expect(play(cue("yun", "talk"), 1000, 1690).map(([, frame]) => frame)).toEqual(["talk", "idle", "talk", "idle", "talk"]);
  });

  test("a hop crouches, lifts the air frame by its drop plus the hop, and lands", () => {
    for (const id of ["pip", "mote"] as const) {
      expect(play(cue(id, "hop"), 1000, 1580)).toEqual([[1000, "hop-crouch", 0], [1180, "hop-air", 90 + AIR_DROP[id]], [1440, "hop-crouch", 0]]);
    }
  });

  test("every gesture of every companion ends within the reaction's hold, so the store never cuts one short", () => {
    for (const id of ids) for (const name of GESTURE_NAMES) {
      const shown = play(cue(id, name, 0, "paused"), 0, 10_000);
      expect({ id, name, ends: shown.at(-1)![0] <= REACTION_MS }).toEqual({ id, name, ends: true });
    }
  });

  test("the frames of each gesture are the ones it names", () => {
    const frames = (id: CompanionId, name: Gesture) => [...new Set(play(cue(id, name, 0, "paused"), 0, REACTION_MS).map(([, f]) => f))].sort();
    expect(frames("pip", "blink")).toEqual(["blink", "idle"]);
    expect(frames("pip", "look-board")).toEqual(["look-board"]);
    expect(frames("pip", "look-mat")).toEqual(["look-mat"]);
    expect(frames("pip", "think")).toEqual(["think"]);
    expect(frames("pip", "cheer")).toEqual(["cheer"]);
    expect(frames("pip", "draw")).toEqual(["draw"]);
    expect(frames("pip", "read")).toEqual(["read"]);
  });

  test("Lumi has no cheer frame (#283), so her cheer is a hop, and no companion is ever given a frame it lacks", () => {
    expect(play(cue("lumi", "cheer"), 1000, 1580).map(([, f]) => f)).toEqual(["hop-crouch", "hop-air", "hop-crouch"]);
    const box = { left: 0, top: 0, width: 200, height: 200 };
    for (const id of ids) for (const name of GESTURE_NAMES) for (const [, frame, lift] of play(cue(id, name, 0), 0, 20_000)) {
      expect(() => companionDraw(id, { frame, lift, next: null }, box, 1)).not.toThrow();
      const { draw } = companionDraw(id, { frame, lift, next: null }, box, 1);
      expect(draw.src).toBeTruthy();
    }
  });
});

describe("idle blinks at irregular intervals, the same ones for the same seed", () => {
  /** When each blink starts, a double blink counted once. */
  const blinks = (clock: Idle, activity: CompanionActivity = "idle") => {
    const frames = play(cue("pip", null, 0, activity), 0, 600_000, clock).filter(([, f]) => f === "blink").map(([t]) => t);
    return frames.filter((t, i) => i === 0 || t - frames[i - 1]! > 500);
  };

  test("over ten minutes the gaps between blinks vary between 2.4 and 7.6 seconds", () => {
    const starts = blinks(idle);
    expect(starts.length).toBeGreaterThan(80);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2400);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(7600);
    expect(new Set(gaps.map((g) => Math.round(g / 100))).size).toBeGreaterThan(20);
  });

  test("some blinks are double blinks", () => {
    const sequence = play(cue("pip", null, 0), 0, 600_000).map(([, f]) => f).join(" ");
    expect(sequence).toContain("blink idle blink");
    expect(sequence).toContain("idle blink idle");
  });

  test("a seed gives the same blinks every time, and another seed other ones", () => {
    expect(blinks(idle)).toEqual(blinks({ ...idle }));
    expect(blinks({ since: 0, seed: 8 })).not.toEqual(blinks(idle));
  });

  test("between blinks nothing changes until the next one, so the stage sleeps until then", () => {
    const shown = companionAt(cue("pip", null), idle, 100);
    expect(shown.frame).toBe("idle");
    expect(shown.next).toBeGreaterThan(100);
    expect(companionAt(cue("pip", null), idle, shown.next! - 1).frame).toBe("idle");
    expect(companionAt(cue("pip", null), idle, shown.next!).frame).toBe("blink");
  });

  test("a reaction clearing from the cue does not move the blinks, once the stage keeps when it ended", () => {
    const nod = cue("pip", "nod", 50_000);
    const kept = { ...idle, since: Math.max(idle.since, restsFrom(nod)) };
    for (let t = 50_680; t < 70_000; t += 37) expect(companionAt(cue("pip", null), kept, t)).toEqual(companionAt(nod, idle, t));
  });

  test("a gesture cut short still wakes the stage, at the moment it would have ended, so blinking resumes", () => {
    const think = cue("pip", "think", 50_000);
    const kept = { ...idle, since: Math.max(idle.since, restsFrom(think)) };
    const cleared = companionAt(cue("pip", null), kept, 50_100);
    expect(cleared.frame).toBe("idle");
    expect(cleared.next).toBe(51_050);
    const blinked = play(cue("pip", null), 50_100, 70_000, kept).filter(([, f]) => f === "blink");
    expect(blinked.length).toBeGreaterThan(0);
  });

  test("blinks count from the end of the last gesture", () => {
    const after = companionAt(cue("pip", "nod", 50_000), idle, 50_680);
    expect(after.frame).toBe("idle");
    expect(after.next! - 50_680).toBeGreaterThanOrEqual(0);
    expect(after.next! - 50_680).toBeLessThanOrEqual(2600);
  });

  test("a paused companion does not blink and asks for no frame", () => {
    expect(blinks(idle, "paused")).toEqual([]);
    expect(companionAt(cue("pip", null, 0, "paused"), idle, 10_000).next).toBeNull();
  });
});

describe("the companion rests toward what the review is doing", () => {
  test("toward the mat while the learner answers and toward the board while the tutor is thinking", () => {
    const rest = (activity: CompanionActivity) => companionAt(cue("pip", null, 0, activity), { since: 0, seed: 1 }, 1).frame;
    expect([rest("idle"), rest("listening"), rest("waiting"), rest("paused"), rest("saving")]).toEqual(["idle", "look-mat", "look-board", "idle", "idle"]);
  });
});

describe("with motion off the companion holds the reaction's pose and asks for no frame", () => {
  test("each reaction is one still frame, with no lift, until it ends", () => {
    const still = (id: CompanionId, name: Gesture | null) => companionAt(cue(id, name), idle, null);
    expect(still("pip", "nod")).toEqual({ frame: "nod", lift: 0, next: null });
    expect(still("pip", "look-board")).toEqual({ frame: "look-board", lift: 0, next: null });
    expect(still("pip", "hop")).toEqual({ frame: "idle", lift: 0, next: null });
    expect(still("lumi", "cheer")).toEqual({ frame: "idle", lift: 0, next: null });
    expect(still("pip", null)).toEqual({ frame: "idle", lift: 0, next: null });
  });
});

describe("the companion's draw", () => {
  const box = { left: 40, top: 500, width: 220, height: 220 };

  test("every frame but the airborne one fills the same box, so a swap never shifts the companion", () => {
    const rects = new Set<string>();
    for (const frame of ["idle", "draw", "read", "blink", "look-board", "look-mat", "nod", "hop-crouch", "think", "cheer", "talk"] as const) {
      rects.add(JSON.stringify(companionDraw("pip", { frame, lift: 0, next: null }, box, 1).draw.rect));
    }
    expect([...rects]).toEqual([JSON.stringify(box)]);
  });

  test("a lift moves the frame up by whole plate pixels", () => {
    const { draw } = companionDraw("pip", { frame: "hop-air", lift: 144, next: null }, box, 1);
    // 144 cell pixels of 724 are 43.76 of the 220 plate pixels the companion is tall, so 44 plate pixels of 1 CSS px each.
    expect(draw.rect).toEqual({ ...box, top: box.top - 44 });
  });

  test("a gesture frame stands in the sheet's idle pose while it decodes", () => {
    const { draw } = companionDraw("pip", { frame: "blink", lift: 0, next: null }, box, 1);
    expect(draw.kind === "companion" && draw.standIn).toMatchObject({ frame: "idle", src: COMPANION_ART.pip.sheet.small, column: 0, columns: 3, rect: box });
  });

  test("the small files serve a companion drawn at up to 362 device pixels, the large ones above", () => {
    expect(companionDraw("pip", { frame: "nod", lift: 0, next: null }, box, 1.6).draw.src).toBe(COMPANION_ART.pip.frames.nod!.small);
    expect(companionDraw("pip", { frame: "nod", lift: 0, next: null }, box, 1.7).draw.src).toBe(COMPANION_ART.pip.frames.nod!.large);
    expect(companionDraw("pip", { frame: "idle", lift: 0, next: null }, box, 2).draw.src).toBe(COMPANION_ART.pip.sheet.large);
  });

  test("the room decodes ahead only the active companion's files, at the size it draws", () => {
    const layout = layoutRoom("last-desk", { width: 1440, height: 900 }, "full");
    const list = buildScene("last-desk", layout, 0, { cue: cue("lumi", null), idle, ratio: 1 });
    const { sheet, frames } = COMPANION_ART.lumi;
    expect([...list.ahead!].sort()).toEqual([sheet.small, ...Object.values(frames).map((f) => f.small)].sort());
    expect(list.draws.at(-1)).toMatchObject({ kind: "companion", frame: "idle" });
    expect(list.next).not.toBeNull();
    expect(buildScene("last-desk", layout, null, { cue: cue("lumi", null), idle, ratio: 1 }).next).toBeNull();
  });
});

describe("the frame table matches the art the pipeline shipped", () => {
  test("every shipped frame file of every companion is in the table, and nothing else", () => {
    for (const id of ids) {
      const shipped = readdirSync(join(REPO, "src/app/assets/companion-frames", id)).filter((f) => !f.endsWith("-small.webp")).map((f) => f.replace(/\.webp$/, "")).sort();
      expect({ id, frames: Object.keys(COMPANION_ART[id].frames).sort() }).toEqual({ id, frames: shipped });
    }
  });

  test("each companion's hop-air drop is the one its provenance records (#275)", () => {
    for (const id of ids) {
      const record = JSON.parse(readFileSync(join(REPO, "art/masters/companion-frames", id, "provenance.json"), "utf8")) as { groundRow: number; frames: Record<string, { bodyBottomRow: number }> };
      expect({ id, drop: AIR_DROP[id] }).toEqual({ id, drop: record.frames["hop-air"]!.bodyBottomRow - record.groundRow });
    }
  });

  test("every gesture the reactions name has frames and timing", () => {
    expect(Object.keys(GESTURES).sort()).toEqual([...GESTURE_NAMES].sort());
  });
});
