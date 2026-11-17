import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BUBBLE_MODES, PLACES, STEPS, capturePlace, clampStep, clearSeen, homePlace, placeBubble, readSeen, selectSteps, stepsFor, tutorialKey, writeSeen } from "../src/app/tutorial-view";
import type { Place, SeenStorage } from "../src/app/tutorial-view";
import { ShowTutorialAgain, TutorialBubble, TutorialProvider } from "../src/app/tutorial";

/** A storage that keeps its values, with a switch that makes every call throw as a blocked browser does. */
function storage(): SeenStorage & { values: Map<string, string>; broken: boolean } {
  const values = new Map<string, string>();
  const self = {
    values, broken: false,
    getItem(key: string) { if (self.broken) throw new Error("denied"); return values.get(key) ?? null; },
    setItem(key: string, value: string) { if (self.broken) throw new Error("denied"); values.set(key, value); },
    removeItem(key: string) { if (self.broken) throw new Error("denied"); values.delete(key); },
  };
  return self;
}

describe("tutorial steps", () => {
  test("every place has steps, every step has text and selectors", () => {
    for (const place of PLACES) {
      expect(STEPS[place].length).toBeGreaterThan(0);
      for (const step of STEPS[place]) {
        expect(step.text.length).toBeGreaterThan(10);
        expect(step.target.every((s) => s.length > 0)).toBe(true);
      }
    }
  });

  test("copy follows the writing rules: short sentences, none of the banned punctuation", () => {
    for (const step of Object.values(STEPS).flat()) {
      expect(step.text).not.toMatch(/[—–;()]/);
      expect(step.text).not.toMatch(/\.\.\./);
      for (const sentence of step.text.split(/(?<=[.?!])\s+/)) expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(25);
      expect(step.text.split(/(?<=[.?!])\s+/).length).toBeLessThanOrEqual(3);
    }
  });

  test("step ids are unique within a place", () => {
    for (const place of PLACES) expect(new Set(STEPS[place].map((s) => s.id)).size).toBe(STEPS[place].length);
  });

  test("the lecture page's steps follow what the page offers", () => {
    expect(stepsFor({ place: "capture", variant: "ready" }).map((s) => s.id)).toEqual(["watched", "choose-ready"]);
    expect(stepsFor({ place: "capture", variant: "processing_partial" }).map((s) => s.id)).toEqual(["watched", "choose-partial"]);
    expect(stepsFor({ place: "capture", variant: "processing" }).map((s) => s.id)).toEqual(["watched", "choose-wait"]);
    expect(stepsFor({ place: "capture" }).map((s) => s.id)).toEqual(["watched"]);
    expect(stepsFor({ place: "question" })).toHaveLength(4);
  });
});

describe("which steps show", () => {
  const none = new Set<Place>();
  test("an unseen place shows its steps", () => {
    expect(selectSteps({ place: "checklist" }, none, true)?.map((s) => s.id)).toEqual(["topics", "start"]);
  });
  test("a seen place shows nothing, and other places still show", () => {
    const seen = new Set<Place>(["home_connect"]);
    expect(selectSteps({ place: "home_connect" }, seen, true)).toBeNull();
    expect(selectSteps({ place: "home_capture" }, seen, true)).not.toBeNull();
  });
  test("a tutorial that is off, or a page with no place, shows nothing", () => {
    expect(selectSteps({ place: "notebook" }, none, false)).toBeNull();
    expect(selectSteps(null, none, true)).toBeNull();
  });
  test("the step index stays inside the steps", () => {
    expect(clampStep(-1, 3)).toBe(0);
    expect(clampStep(1, 3)).toBe(1);
    expect(clampStep(5, 3)).toBe(2);
  });
});

describe("where home and the lecture page say the learner is", () => {
  test("home teaches only while no lecture is captured", () => {
    expect(homePlace({ lectures: 2, hosted: false, connected: null })).toBeNull();
    expect(homePlace({ lectures: 2, hosted: true, connected: false })).toBeNull();
  });
  test("local home goes straight to capturing", () => {
    expect(homePlace({ lectures: 0, hosted: false, connected: null })).toEqual({ place: "home_capture" });
  });
  test("hosted home waits to know whether a browser is connected, then picks connect or capture", () => {
    expect(homePlace({ lectures: 0, hosted: true, connected: null })).toBeNull();
    expect(homePlace({ lectures: 0, hosted: true, connected: false })).toEqual({ place: "home_connect" });
    expect(homePlace({ lectures: 0, hosted: true, connected: true })).toEqual({ place: "home_capture" });
  });
  test("the lecture page teaches when it has a review to offer, and says which kind", () => {
    expect(capturePlace({ kind: "ready", offers: [{}] })).toEqual({ place: "capture", variant: "ready" });
    expect(capturePlace({ kind: "processing", offers: [{}, {}] })).toEqual({ place: "capture", variant: "processing_partial" });
    expect(capturePlace({ kind: "processing", offers: [] })).toEqual({ place: "capture", variant: "processing" });
    expect(capturePlace({ kind: "nothing" })).toBeNull();
  });
});

describe("seen state", () => {
  test("the local app has a fixed key and each signed-in user has their own", () => {
    expect(tutorialKey(null)).toBe(tutorialKey(null));
    expect(tutorialKey("user_a")).not.toBe(tutorialKey("user_b"));
    expect(tutorialKey("user_a")).toContain("user_a");
    expect(tutorialKey("user_a")).not.toBe(tutorialKey(null));
  });
  test("what is written is read back, per key", () => {
    const store = storage();
    expect(writeSeen(store, tutorialKey("a"), new Set<Place>(["home_connect", "notebook"]))).toBe(true);
    expect([...readSeen(store, tutorialKey("a"))].sort()).toEqual(["home_connect", "notebook"]);
    expect(readSeen(store, tutorialKey("b")).size).toBe(0);
  });
  test("unreadable values count as nothing seen, and unknown places are dropped", () => {
    const store = storage();
    for (const raw of ["{", "null", "42", '"x"', '{"a":1}']) {
      store.values.set("k", raw);
      expect(readSeen(store, "k").size).toBe(0);
    }
    store.values.set("k", JSON.stringify(["capture", "nope", 7, "__proto__"]));
    expect([...readSeen(store, "k")]).toEqual(["capture"]);
  });
  test("clearing forgets what was seen", () => {
    const store = storage();
    writeSeen(store, "k", new Set<Place>(["capture"]));
    expect(clearSeen(store, "k")).toBe(true);
    expect(readSeen(store, "k").size).toBe(0);
  });
  test("storage that throws, or none at all, never throws out of these functions", () => {
    const store = storage();
    writeSeen(store, "k", new Set<Place>(["capture"]));
    store.broken = true;
    expect(readSeen(store, "k").size).toBe(0);
    expect(writeSeen(store, "k", new Set<Place>(["notebook"]))).toBe(false);
    expect(clearSeen(store, "k")).toBe(false);
    expect(readSeen(null, "k").size).toBe(0);
    expect(writeSeen(null, "k", new Set())).toBe(false);
    expect(clearSeen(null, "k")).toBe(false);
  });
});

describe("where the bubble sits", () => {
  const window = { width: 1280, height: 800 };
  const size = { width: 288, height: 190 };
  const companion = { left: 36, top: 516, width: 227, height: 227 };

  test("the first spot is above the companion, with its tail pointing down at it", () => {
    const spot = placeBubble({ mode: "tall", size, window, companion, avoid: [] });
    expect(spot.tail).toBe(true);
    expect(spot.clear).toBe(true);
    expect(spot.top + size.height).toBeLessThan(companion.top + companion.height / 2);
    expect(spot.left).toBeLessThan(companion.left + companion.width);
  });
  test("a box under the spot makes it not clear, and the side spot is away from the companion", () => {
    const text = { left: 150, top: 300, width: 800, height: 90 };
    expect(placeBubble({ mode: "tall", size, window, companion, avoid: [text] }).clear).toBe(false);
    const side = placeBubble({ mode: "side", size, window, companion, avoid: [text] });
    expect(side.clear).toBe(true);
    expect(side.tail).toBe(false);
    expect(side.left + size.width).toBeLessThanOrEqual(window.width);
  });
  test("the bubble never leaves the window", () => {
    for (const mode of BUBBLE_MODES) {
      const spot = placeBubble({ mode, size, window: { width: 900, height: 560 }, companion: { left: 5, top: 10, width: 100, height: 100 }, avoid: [] });
      expect(spot.left).toBeGreaterThanOrEqual(0);
      expect(spot.top).toBeGreaterThanOrEqual(0);
      expect(spot.left + size.width).toBeLessThanOrEqual(900);
      expect(spot.top + size.height).toBeLessThanOrEqual(560);
    }
  });
  test("with no companion on screen the bubble sits at the top left", () => {
    const spot = placeBubble({ mode: "tall", size, window, companion: null, avoid: [] });
    expect(spot.tail).toBe(false);
    expect(spot.left).toBeLessThan(40);
  });
});

describe("the provider", () => {
  test("with storage that throws, it renders and shows nothing until a page reports a place", () => {
    const store = storage();
    store.broken = true;
    const html = renderToStaticMarkup(<TutorialProvider storageKey={tutorialKey(null)} storage={store}><TutorialBubble /><ShowTutorialAgain /></TutorialProvider>);
    expect(html).toContain("Show the tutorial again");
    expect(html).not.toContain("tutorial-bubble");
  });
  test("off, it draws neither the bubble nor the restart control", () => {
    const html = renderToStaticMarkup(<TutorialProvider storageKey={tutorialKey(null)} storage={storage()} enabled={false}><TutorialBubble /><ShowTutorialAgain /></TutorialProvider>);
    expect(html).toBe("");
  });
});
