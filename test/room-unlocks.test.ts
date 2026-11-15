import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SceneId } from "../src/app/appearance";
import { layoutRoom } from "../src/app/room/layout";
import type { FullRoomLayout, Rect, Size, UnlockLayer } from "../src/app/room/layout";
import { readyDraws } from "../src/app/room/paint";
import type { PictureState } from "../src/app/room/paint";
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
import type { Draw } from "../src/app/room/scene";
import { UNLOCK_ART, UNLOCK_SLOTS } from "../src/app/room/unlocks";
import type { Observation, RecordView, RecordedStatus } from "../src/shared/domain";
import { stableId } from "../src/shared/ids";

const rooms = ROOM_IDS as readonly SceneId[];
const full = (scene: SceneId, window: Size): FullRoomLayout => {
  const layout = layoutRoom(scene, window, "full");
  if (layout.composition !== "full") throw new Error("a full window lays out the full room");
  return layout;
};
const right = (r: Rect) => r.left + r.width;
const bottom = (r: Rect) => r.top + r.height;
const clip = (a: Rect, b: Rect): Rect | null => {
  const [l, t, r, d] = [Math.max(a.left, b.left), Math.max(a.top, b.top), Math.min(right(a), right(b)), Math.min(bottom(a), bottom(b))];
  return r > l && d > t ? { left: l, top: t, width: r - l, height: d - t } : null;
};

/** Desktop windows from the smallest full room to about 4K, in 40 px steps, as test/room-layout.test.ts walks them. */
const windows: Size[] = [];
for (let width = 900; width <= 3840; width += 40) for (let height = 560; height <= 2160; height += 40) windows.push({ width, height });

/**
 * The navigation chips' band across the top: one row from 1360 px wide, two rows below that (front-row.css). The browser
 * test e2e/room-unlocks.spec.ts measures the real chips.
 */
const navBand = ({ width }: Size): Rect => ({ left: 0, top: 0, width, height: width >= 1360 ? 64 : 120 });

/** What of a slot shows: inside the window, and above the desk's far edge for anything drawn behind the desk. */
function shown(slot: UnlockLayer, layout: FullRoomLayout): Rect | null {
  const inWindow = clip(slot.rect, { left: 0, top: 0, ...layout.window });
  return inWindow && slot.z < 5 ? clip(inWindow, { left: 0, top: 0, width: layout.window.width, height: layout.layers.desk.rect.top }) : inWindow;
}

describe("unlock slots", () => {
  test("each room has its fixed slots, in the order progress opens them", () => {
    for (const room of ROOM_IDS) expect(UNLOCK_SLOTS[room].map((s) => s.id)).toEqual([...slotIds(room)]);
  });

  test("no slot crowds the board's text, Your thinking, the companion, the folio, the notebook, the Your room panel or the navigation", () => {
    for (const scene of rooms) for (const window of windows) {
      const layout = full(scene, window);
      const keepClear: Record<string, Rect> = {
        boardText: layout.text.board, deskText: layout.text.desk, mat: layout.layers.mat.rect, companion: layout.companion.box,
        source: layout.objects.source, history: layout.objects.history, progress: layout.progress, nav: navBand(window),
      };
      const hits = layout.layers.unlocks.flatMap((slot) => {
        const seen = shown(slot, layout);
        if (seen === null) return [];
        const others = layout.layers.unlocks.filter((o) => o !== slot && o.z === slot.z).map((o) => [o.id, shown(o, layout)] as const);
        return [
          ...Object.entries(keepClear).filter(([, zone]) => clip(seen, zone) !== null).map(([name]) => `${slot.id} on ${name}`),
          ...others.filter(([, rect]) => rect !== null && clip(seen, rect) !== null).map(([id]) => `${slot.id} on ${id}`),
        ];
      });
      expect({ scene, window, hits }).toEqual({ scene, window, hits: [] });
    }
  });

  test("on common desktop windows every slot shows at least 90% of its box", () => {
    const common: Size[] = [[1440, 900], [1280, 720], [1280, 800], [1366, 768], [1536, 864], [1600, 900], [1920, 1080], [1920, 1200], [2560, 1440]].map(([width, height]) => ({ width: width!, height: height! }));
    for (const scene of rooms) for (const window of common) {
      const layout = full(scene, window);
      const hidden = layout.layers.unlocks.filter((slot) => {
        const seen = shown(slot, layout);
        return (seen === null ? 0 : seen.width * seen.height) < 0.9 * slot.rect.width * slot.rect.height;
      }).map((slot) => slot.id);
      expect({ scene, window, hidden }).toEqual({ scene, window, hidden: [] });
    }
  });

  test("the Your room panel's corner keeps off the board's visible part, Your thinking, the folio and the notebook", () => {
    for (const scene of rooms) for (const window of windows) {
      const layout = full(scene, window);
      const board = layout.layers.board.rect;
      // The board's legs may run behind the desk. Only the part above the desk's far edge shows.
      const visibleBoard = clip(board, { left: 0, top: 0, width: window.width, height: layout.layers.desk.rect.top });
      const zones = { board: visibleBoard, boardText: layout.text.board, mat: layout.layers.mat.rect, deskText: layout.text.desk, source: layout.objects.source, history: layout.objects.history };
      const hits = Object.entries(zones).filter(([, zone]) => zone !== null && clip(layout.progress, zone) !== null).map(([name]) => name);
      expect({ scene, window, hits, width: layout.progress.width > 0 }).toEqual({ scene, window, hits: [], width: true });
    }
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
const unlockDraws = (draws: readonly Draw[]) => draws.filter((d) => d.kind === "image" && d.unlock !== undefined);

describe("the stage draws unlocked objects", () => {
  const window = { width: 1440, height: 900 };

  test("nothing is drawn for a slot with no picture, however far the learner has come", () => {
    expect(UNLOCK_ART).toEqual({});
    for (const scene of rooms) {
      const layout = full(scene, window);
      expect(unlockDraws(buildScene(scene, layout, null, null, slotIds(scene)).draws)).toEqual([]);
    }
  });

  test("an open slot with a picture is drawn in its box, and a closed one is not, even with a picture", () => {
    const layout = full("last-desk", window);
    const draws = unlockDraws(buildScene("last-desk", layout, null, null, twoOpen.unlocks["last-desk"], art(slotIds("last-desk"))).draws);
    const drawn = Object.fromEntries(draws.map((d) => [d.kind === "image" ? d.unlock : "", d.rect]));
    expect(drawn).toEqual(Object.fromEntries(layout.layers.unlocks.slice(0, 2).map((s) => [s.id, s.rect])));
  });

  test("each object is drawn at its depth: on the desk between the desk and the mat, on the sill behind the board", () => {
    const layout = full("last-desk", window);
    const names = buildScene("last-desk", layout, null, null, slotIds("last-desk"), art(slotIds("last-desk"))).draws
      .map((d) => (d.kind === "image" && d.unlock !== undefined ? d.unlock : d.src.split("/").pop()!.replace(/\.webp$/, "")));
    const before = (a: string, b: string) => names.indexOf(a) < names.indexOf(b);
    expect([before("rail-background", "last-desk/2"), before("last-desk/2", "rail-board")]).toEqual([true, true]);
    expect([before("rail-board", "last-desk/4"), before("last-desk/4", "rail-desk")]).toEqual([true, true]);
    expect([before("rail-desk", "last-desk/1"), before("last-desk/1", "rail-mat")]).toEqual([true, true]);
  });

  test("an object's picture never holds the room back, while a layer's picture does", () => {
    const layout = full("last-desk", window);
    const { draws } = buildScene("last-desk", layout, null, null, ["last-desk/1"], art(["last-desk/1"]));
    const object = unlockDraws(draws)[0]!.src;
    const states = (objectState: PictureState, layerState: PictureState = "decoded") => (src: string) => (src === object ? objectState : layerState);
    expect(readyDraws(draws, states("pending"))?.map((d) => d.src)).toEqual(draws.filter((d) => d.src !== object).map((d) => d.src));
    expect(readyDraws(draws, states("failed"))?.some((d) => d.src === object)).toBe(false);
    expect(readyDraws(draws, states("decoded"))?.some((d) => d.src === object)).toBe(true);
    expect(readyDraws(draws, states("decoded", "pending"))).toBeNull();
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

  test("it starts closed behind one labelled button, with effort set apart from what counts as understood", () => {
    const html = renderToStaticMarkup(createElement(ProgressPanel, { standing: { freshness: "current", progress: twoOpen }, room: "study-bench", rect: undefined, retry: () => {} }));
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Your room<\/button>/);
    expect(html).toMatch(/class="room-progress-body" hidden=""/);
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
  const panel = (room: RoomRecord) => renderToStaticMarkup(createElement(ProgressPanel, { standing: room.getState()!, room: "last-desk", rect: undefined, retry: room.read }));
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
