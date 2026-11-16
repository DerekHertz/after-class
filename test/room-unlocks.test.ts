import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SceneId } from "../src/app/appearance";
import { layoutRoom } from "../src/app/room/layout";
import { ProgressPanel, progressRows } from "../src/app/room/progress-panel";
import { onRecordChange } from "../src/app/api";
import type { AppApi } from "../src/app/api";
import { ROOM_IDS, deriveProgress, slotIds } from "../src/app/room/progress";
import { drawnUnlocks, roomRecord } from "../src/app/room/room-record";
import type { RoomRecord } from "../src/app/room/room-record";
import { RecordScreen } from "../src/app/record";
import { SavedNotes } from "../src/app/review";
import type { UnlockId } from "../src/app/room/progress";
import { buildScene } from "../src/app/room/scene";
import { ROOM_LAYER_ART, UNLOCK_ART } from "../src/app/room/art";
import { UNLOCK_SLOTS } from "../src/app/room/unlocks";
import type { Observation, RecordView, RecordedStatus } from "../src/shared/domain";
import { stableId } from "../src/shared/ids";
import type { ArtEntry } from "../scripts/build-art";
import manifestJson from "../art/manifest.json";

const manifest = manifestJson as ArtEntry[];

const rooms = ROOM_IDS as readonly SceneId[];

describe("unlock slots", () => {
  test("each room has its fixed slots, in the order progress opens them", () => {
    for (const room of ROOM_IDS) expect(UNLOCK_SLOTS[room].map((s) => s.id)).toEqual([...slotIds(room)]);
  });
});

let n = 0;
function obs(status: RecordedStatus, review = "r1"): Observation {
  n += 1;
  const reviewId = stableId("rvw", review);
  const threadId = stableId("thr", `t${n}`);
  return {
    id: stableId("obs", reviewId, threadId), reviewId, threadId, claimIds: [stableId("clm", `c${n}`)], conceptIds: [stableId("cpt", `topic-${n}`)],
    proposed: "independent", status, clampedFrom: null, dispute: { kind: "none" }, corrections: [],
    facts: { threadId, firstSubstantiveAnswerSeq: null, firstHelpSeq: null, endedBySkip: false, saidDontKnowOnly: false, learnerTurns: [], helpTurns: [] },
  } as Observation;
}

/** Six topics explained on your own in two reviews: two objects open in every room. */
const twoOpen = deriveProgress([
  obs("independent"), obs("independent"), obs("independent"), obs("partial"), obs("looks_fine"),
  obs("independent", "r2"), obs("independent", "r2"), obs("independent", "r2"), obs("after_help", "r2"), obs("disputed", "r2"),
]);
const art = (ids: readonly UnlockId[]) => Object.fromEntries(ids.map((id) => [id, `/assets/unlocks/${id.replace("/", "-")}.webp`]));

describe("the stage does not draw unlocked objects for now", () => {
  test("every room's plate already shows the mockup's grown objects, so the draw list holds the plate and nothing for a slot", () => {
    for (const scene of rooms) {
      const layout = layoutRoom(scene, { width: 1440, height: 900 }, "full");
      const srcs = buildScene(scene, layout, null, null).draws.flatMap((d) => ("src" in d ? [d.src] : []));
      expect(srcs.every((src) => src === ROOM_LAYER_ART[scene].plate)).toBe(true);
      expect(srcs.some((src) => Object.values(UNLOCK_ART).includes(src))).toBe(false);
    }
  });

  test("every slot has its painted picture, shipped at its box in plate pixels, kept for when unlocks are decided again", () => {
    const shipped = new Map(manifest.map((e) => [e.ship, e]));
    const sizes = rooms.flatMap((scene) => UNLOCK_SLOTS[scene].map((slot) => {
      const ship = `unlock-objects/${slot.id}.webp`;
      const entry = shipped.get(ship);
      return { id: slot.id, drawn: UNLOCK_ART[slot.id]?.endsWith(ship), size: entry && [entry.width, entry.height] };
    }));
    expect(sizes).toEqual(rooms.flatMap((scene) => UNLOCK_SLOTS[scene].map((slot) => ({ id: slot.id, drawn: true, size: [slot.width, slot.height] }))));
  });
});

describe("the Your room panel", () => {
  test("each line says what it counts, in progress.ts's words, with that count", () => {
    expect(progressRows(twoOpen, "last-desk", {})).toEqual({
      main: [
        { key: "understood", label: "Topics explained on your own", value: 6 },
        { key: "reviews", label: "Reviews with a saved question", value: 2 },
      ],
      effort: [{ key: "effort", label: "Questions answered with some help or only in part", value: 2 }],
    });
  });

  test("the count toward the next object shows only once that object has a picture", () => {
    expect(progressRows(twoOpen, "last-desk", art(["last-desk/2"])).main.map((r) => r.key)).toEqual(["understood", "reviews"]);
    expect(progressRows(twoOpen, "last-desk", art(["last-desk/3"])).main).toContainEqual({ key: "next", label: "More topics explained on your own for the next object", value: 3 });
    const allOpen = deriveProgress(Array.from({ length: 18 }, () => obs("independent")));
    expect(progressRows(allOpen, "last-desk", art(slotIds("last-desk"))).main.map((r) => r.key)).toEqual(["understood", "reviews"]);
  });

  test("it starts shut until the bar's menu opens it, with effort set apart from what counts as understood", () => {
    const panel = (open: boolean) => renderToStaticMarkup(createElement(ProgressPanel, { standing: { freshness: "current", progress: twoOpen }, room: "study-bench", open, close: () => {}, retry: () => {} }));
    expect(panel(false)).toMatch(/aria-label="Your room"[^>]*hidden=""/);
    expect(panel(true)).not.toMatch(/hidden=""/);
    const html = panel(true);
    expect(html).toContain("<dt>Topics explained on your own</dt><dd>6</dd>");
    expect(html).toMatch(/class="room-progress-effort"><div data-count="effort"><dt>Questions answered with some help or only in part<\/dt><dd>2<\/dd>/);
    expect(html.replace(/<[^>]*>/g, " ")).not.toMatch(/understood|mastered|learned/i);
  });
});

describe("the room reads the saved record again after any change made to it in the app", () => {
  const ok = async () => {};
  const calls = (): AppApi => ({
    editNote: ok, deleteNote: ok, decideLink: ok, resolveDispute: ok, overrideObservation: ok, deleteEvidence: ok,
    record: async () => ({}), lectures: async () => ({}),
  } as unknown as AppApi);

  test("each call that changes the record reads it again once it settles, and a read does not", async () => {
    let reads = 0;
    const api = onRecordChange(calls(), () => { reads += 1; });
    const changes = [
      () => api.editNote("note" as never, "text"), () => api.deleteNote("note" as never), () => api.decideLink("lnk" as never, "accepted" as never),
      () => api.resolveDispute("obs" as never, "it_was_my_gap"), () => api.overrideObservation("obs" as never, "after_help"), () => api.deleteEvidence([]),
    ];
    for (const [i, change] of changes.entries()) { await change(); expect(reads).toBe(i + 1); }
    await api.record({});
    await api.lectures();
    expect(reads).toBe(changes.length);
  });

  test("a change that fails still reads again, and still fails", async () => {
    let reads = 0;
    const api = onRecordChange({ ...calls(), overrideObservation: async () => { throw new Error("nope"); } }, () => { reads += 1; });
    await expect(api.overrideObservation("obs" as never, "after_help")).rejects.toThrow("nope");
    expect(reads).toBe(1);
  });

  test("a correction to after_help takes the topic out of the count and its object out of the room", () => {
    const independent = Array.from({ length: 3 }, () => obs("independent"));
    expect(deriveProgress(independent).unlocks["last-desk"]).toEqual(["last-desk/1"]);
    const corrected = deriveProgress([independent[0]!, independent[1]!, { ...independent[2]!, status: "after_help" }]);
    expect([corrected.understood.value, corrected.unlocks["last-desk"]]).toEqual([2, []]);
  });
});

describe("the room's counts say how current they are, and its objects change only on a good read", () => {
  /** An api whose record reads wait until the test answers them, each with the record as it was when asked, and whose changes succeed at once. */
  function heldReads(observations: readonly Observation[]) {
    const pending: { resolve: () => void; reject: (e: Error) => void }[] = [];
    let saved = observations;
    const api = {
      record: () => new Promise<RecordView>((resolve, reject) => {
        const asked = saved;
        pending.push({ resolve: () => resolve({ observations: asked } as unknown as RecordView), reject });
      }),
      overrideObservation: async (_: unknown, status: RecordedStatus) => { saved = [saved[0]!, saved[1]!, { ...saved[2]!, status }]; },
    } as unknown as AppApi;
    const settle = async () => { for (let i = 0; i < 3; i++) await Promise.resolve(); };
    return {
      api,
      answer: async () => { pending.shift()!.resolve(); await settle(); },
      answerLatest: async () => { pending.pop()!.resolve(); await settle(); },
      fail: async () => { pending.shift()!.reject(new Error("down")); await settle(); },
      outstanding: () => pending.length,
    };
  }
  const three = () => Array.from({ length: 3 }, () => obs("independent"));
  const panel = (room: RoomRecord) => renderToStaticMarkup(createElement(ProgressPanel, { standing: room.getState()!, room: "last-desk", open: true, close: () => {}, retry: room.read }));
  const seen = (room: RoomRecord) => {
    const state = room.getState()!;
    return [state.freshness, state.progress.understood.value, drawnUnlocks(state, "last-desk")];
  };

  test("a correction whose read is slow shows the last counts as updating, never as current, then the new counts", async () => {
    const held = heldReads(three());
    const room = roomRecord(held.api);
    room.read();
    expect(room.getState()).toBeNull();
    await held.answer();
    expect(seen(room)).toEqual(["current", 3, ["last-desk/1"]]);
    expect(panel(room)).toContain("Counted from your saved reviews.");

    await room.api.overrideObservation("obs" as never, "after_help");
    expect(held.outstanding()).toBe(1);
    expect(seen(room)).toEqual(["refreshing", 3, ["last-desk/1"]]);
    const updating = panel(room);
    expect(updating).toMatch(/role="status"[^>]*>Updating from your saved reviews\. These counts were read before your latest change\.</);
    expect(updating).toMatch(/aria-describedby="([^"]+)"[\s\S]*id="\1"/);
    expect(updating).toContain('aria-busy="true"');
    expect(updating).not.toContain("Counted from your saved reviews.");

    await held.answer();
    expect(seen(room)).toEqual(["current", 2, []]);
    expect(panel(room)).toContain("Counted from your saved reviews.");
  });

  test("a read that fails keeps the last counts and objects but says so, and Retry reads again", async () => {
    const held = heldReads(three());
    const room = roomRecord(held.api);
    room.read();
    await held.answer();
    await room.api.overrideObservation("obs" as never, "after_help");
    await held.fail();
    expect(seen(room)).toEqual(["stale", 3, ["last-desk/1"]]);
    const stale = panel(room);
    expect(stale).toMatch(/role="alert"[^>]*>These counts may be out of date\. Your saved reviews could not be read again, so the room keeps what it last read\. <button type="button">Retry<\/button>/);
    expect(stale).toMatch(/aria-describedby="([^"]+)"[\s\S]*id="\1"/);
    expect(stale).not.toContain("Counted from your saved reviews.");

    room.read();
    expect(seen(room)).toEqual(["stale", 3, ["last-desk/1"]]);
    await held.answer();
    expect(seen(room)).toEqual(["current", 2, []]);
  });

  test("only the latest read's answer counts, so an older answer arriving late never brings back old counts", async () => {
    const held = heldReads(three());
    const room = roomRecord(held.api);
    room.read();
    await room.api.overrideObservation("obs" as never, "after_help");
    await held.answerLatest();
    expect(seen(room)).toEqual(["current", 2, []]);
    await held.answer();
    expect(seen(room)).toEqual(["current", 2, []]);
  });

  test("Saved notes in the review edits the record through the room, so a correction there reads the counts again", async () => {
    const held = heldReads(three());
    const room = roomRecord(held.api);
    const dialog = SavedNotes({ room, close: () => {} });
    const notebook = (dialog.props as { children: ReactElement<{ api: AppApi }>[] }).children.find((child) => child.type === RecordScreen)!;
    expect(notebook.props.api).toBe(room.api);
    room.read();
    await held.answer();
    await notebook.props.api.overrideObservation("obs" as never, "after_help");
    expect(room.getState()?.freshness).toBe("refreshing");

    const review = readFileSync(new URL("../src/app/review.tsx", import.meta.url), "utf8");
    expect(review).toContain("<SavedNotes room={room} close={closeNotebook} />");
    expect(review).toContain("standing={roomStanding} retry={room.read}");
  });
});
