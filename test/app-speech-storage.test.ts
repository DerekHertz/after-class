import { describe, expect, test } from "bun:test";
import type { RecognitionLike } from "../src/app/speech";
import { createSpeechInput, createSynthSpeaker } from "../src/app/speech";
import { createIndexedDbUnsent, createMemoryUnsent } from "../src/app/unsent";
import type { LearnerAct } from "../src/shared/domain";
import type { ReviewId } from "../src/shared/ids";
import { randomId } from "../src/shared/ids";
import { fakeIdb, reviewId, tid } from "./app-fixtures";

// ───────────────────────────── Speech ───────────────────────────────────────

describe("speech", () => {
  function fakeSynth() {
    const spoken: string[] = [];
    let cancels = 0;
    return {
      synth: { speak: (u: SpeechSynthesisUtterance) => void spoken.push(u.text), cancel: () => void cancels++ },
      spoken,
      cancels: () => cancels,
    };
  }
  const utterance = (text: string) => ({ text }) as SpeechSynthesisUtterance;

  test("the tutor stops when the learner starts speaking, and stays quiet until the next turn", () => {
    const { synth, spoken, cancels } = fakeSynth();
    const speaker = createSynthSpeaker(synth, utterance);
    speaker.beginTurn();
    speaker.speak("First.");
    speaker.stop();
    speaker.speak("Second, from the same turn.");
    expect(spoken).toEqual(["First."]);
    expect(cancels()).toBe(1);
    speaker.beginTurn();
    speaker.speak("Next turn.");
    expect(spoken).toEqual(["First.", "Next turn."]);
  });

  test("blank sentences are not spoken", () => {
    const { synth, spoken } = fakeSynth();
    createSynthSpeaker(synth, utterance).speak("   ");
    expect(spoken).toEqual([]);
  });

  class FakeRecognition implements RecognitionLike {
    static last: FakeRecognition;
    lang = "";
    interimResults = false;
    continuous = true;
    onspeechstart: (() => void) | null = null;
    onresult: RecognitionLike["onresult"] = null;
    onerror: RecognitionLike["onerror"] = null;
    onend: (() => void) | null = null;
    started = false;
    constructor() {
      FakeRecognition.last = this;
    }
    start() {
      this.started = true;
    }
    stop() {
      this.onend?.();
    }
  }

  test("speech input reports speech start, interim and final transcripts, and the end", () => {
    const input = createSpeechInput(FakeRecognition);
    const log: string[] = [];
    input.start({
      onSpeechStart: () => log.push("start"),
      onTranscript: (t, final) => log.push(`${final ? "final" : "interim"}:${t}`),
      onEnd: () => log.push("end"),
      onError: (m) => log.push(`error:${m}`),
    });
    const rec = FakeRecognition.last;
    expect(rec).toMatchObject({ started: true, lang: "en-US", interimResults: true });
    rec.onspeechstart?.();
    rec.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: "an order" }], { isFinal: false })] });
    rec.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: "an ordering " }], { isFinal: false }), Object.assign([{ transcript: "of events" }], { isFinal: true })] });
    rec.onerror?.({ error: "no-speech" });
    input.stop();
    expect(log).toEqual(["start", "interim:an order", "final:an ordering of events", "error:no-speech", "end"]);
  });

  test("a browser with no Web Speech API reports it is unsupported", () => {
    expect(createSpeechInput(undefined).supported).toBe(false);
  });
});

// ───────────────────────────── Unsent turns ─────────────────────────────────

describe("unsent turns", () => {
  const turn = (n: number, review: ReviewId = reviewId) => ({ turnId: tid(`u${n}`), reviewId: review, act: { kind: "skip" } as LearnerAct, createdAtMs: n });

  test("the memory store returns a review's turns oldest first and forgets removed ones", async () => {
    const store = createMemoryUnsent();
    await store.put(turn(2));
    await store.put(turn(1));
    await store.put(turn(3, randomId("rvw")));
    expect((await store.forReview(reviewId)).map((t) => t.createdAtMs)).toEqual([1, 2]);
    await store.remove(tid("u1"));
    expect((await store.forReview(reviewId)).map((t) => t.createdAtMs)).toEqual([2]);
  });

  test("with no IndexedDB, or one that throws, the store keeps working in memory", async () => {
    const throwing = { open: () => { throw new Error("SecurityError"); } } as unknown as IDBFactory;
    for (const idb of [undefined, throwing]) {
      const store = createIndexedDbUnsent(idb);
      await store.put(turn(1));
      await store.put(turn(2));
      await store.remove(tid("u1"));
      expect((await store.forReview(reviewId)).map((t) => t.createdAtMs)).toEqual([2]);
      expect(store.degraded).toBe(true);
    }
  });
});

describe("IndexedDB unsent turns", () => {
  const turn = { turnId: tid("idb1"), reviewId, act: { kind: "skip" } as LearnerAct, createdAtMs: 1 };
  const tick = () => new Promise((r) => setTimeout(r, 5));

  test("a write resolves when its transaction completes, not when the request succeeds", async () => {
    const idb = fakeIdb();
    const store = createIndexedDbUnsent(idb.factory, 1000);
    let done = false;
    const put = store.put(turn).then(() => (done = true));
    await tick();
    expect(idb.rows.has(turn.turnId)).toBe(true);
    expect(done).toBe(false);
    idb.complete();
    await put;
    expect(store.degraded).toBe(false);
  });

  test("a transaction that aborts (quota, a closing database) degrades the store and loses nothing already accepted", async () => {
    const idb = fakeIdb();
    const store = createIndexedDbUnsent(idb.factory, 1000);
    const put = store.put(turn);
    await tick();
    idb.abort();
    await put;
    expect(store.degraded).toBe(true);
    expect((await store.forReview(reviewId)).map((t) => t.turnId)).toEqual([turn.turnId]);
  });

  test("a blocked open cannot hang the app: it times out into memory", async () => {
    const store = createIndexedDbUnsent(fakeIdb({ opens: false }).factory, 20);
    await store.put(turn);
    expect(store.degraded).toBe(true);
    expect((await store.forReview(reviewId)).map((t) => t.turnId)).toEqual([turn.turnId]);
  });

  test("a browser whose indexedDB getter throws still gets a working, degraded store", async () => {
    Object.defineProperty(globalThis, "indexedDB", { get() { throw new Error("SecurityError"); }, configurable: true });
    try {
      const store = createIndexedDbUnsent();
      await store.put(turn);
      expect(store.degraded).toBe(true);
      expect((await store.forReview(reviewId)).map((t) => t.turnId)).toEqual([turn.turnId]);
    } finally {
      delete (globalThis as { indexedDB?: unknown }).indexedDB;
    }
  });

  test("a transaction that never finishes times out into memory", async () => {
    const store = createIndexedDbUnsent(fakeIdb().factory, 20);
    await store.put(turn);
    expect(store.degraded).toBe(true);
    await store.remove(turn.turnId);
    expect(await store.forReview(reviewId)).toEqual([]);
  });
});
