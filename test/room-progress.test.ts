import { describe, expect, test } from "bun:test";
import type { Observation, RecordedStatus } from "../src/shared/domain";
import { stableId } from "../src/shared/ids";
import { ROOM_IDS, TOPICS_PER_UNLOCK, UNLOCKS_PER_ROOM, deriveProgress } from "../src/app/room/progress";

const ALL: readonly RecordedStatus[] = ["independent", "partial", "after_help", "unresolved", "not_assessed", "looks_fine", "disputed"];

let n = 0;
function obs(status: RecordedStatus, over: { review?: string; concept?: string | null; concepts?: readonly string[] } = {}): Observation {
  n += 1;
  const reviewId = stableId("rvw", over.review ?? "r1");
  const threadId = stableId("thr", `t${n}`);
  return {
    id: stableId("obs", reviewId, threadId), reviewId, threadId,
    claimIds: [stableId("clm", `c${n}`)],
    conceptIds: over.concepts !== undefined ? over.concepts.map((c) => stableId("cpt", c)) : over.concept === null ? [] : [stableId("cpt", over.concept ?? `topic-${n}`)],
    proposed: "independent", status, clampedFrom: null, dispute: { kind: "none" }, corrections: [],
    facts: { threadId, firstSubstantiveAnswerSeq: null, firstHelpSeq: null, endedBySkip: false, saidDontKnowOnly: false, learnerTurns: [], helpTurns: [] },
  } as Observation;
}
const understood = (o: readonly Observation[]) => deriveProgress(o).understood.value;
const open = (o: readonly Observation[]) => deriveProgress(o).unlocks["last-desk"].length;

describe("rules", () => {
  test('R12: "If the tutor helped before my answer, it can\'t count as independent." Help-assisted answers are effort only', () => {
    const p = deriveProgress([obs("after_help"), obs("partial")]);
    expect(p.understood.value).toBe(0);
    expect(p.effort.value).toBe(2);
  });
  test('R13: "A skipped or unanswered question is never counted as understood."', () => {
    expect(understood([obs("unresolved"), obs("not_assessed")])).toBe(0);
    expect(deriveProgress([obs("unresolved"), obs("not_assessed")]).effort.value).toBe(0);
  });
  test('R14: "A disputed assessment is never counted as a learning gap unless I resolve it that way." It also earns no understanding', () => {
    const p = deriveProgress([obs("disputed")]);
    expect(p.understood.value).toBe(0);
    expect(p.effort.value).toBe(0);
  });
  test('R18: "A quick check I pass only shows the topic looks fine; it\'s never recorded as understood the way a main question is."', () => {
    expect(understood([obs("looks_fine")])).toBe(0);
  });
  test("only independent grows understanding, whatever the other statuses", () => {
    for (const s of ALL) expect(understood([obs(s)])).toBe(s === "independent" ? 1 : 0);
  });
  test("a topic explained independently twice counts once; a nothing-status on it does not cancel it", () => {
    expect(understood([obs("independent", { concept: "a" }), obs("independent", { concept: "a", review: "r2" }), obs("partial", { concept: "a" })])).toBe(1);
  });
  test("an independent observation with no topic awards nothing and unlocks nothing", () => {
    const topicless = Array.from({ length: TOPICS_PER_UNLOCK }, () => obs("independent", { concept: null }));
    expect(understood(topicless)).toBe(0);
    expect(open(topicless)).toBe(0);
    expect(understood([...topicless, obs("independent", { concept: "a" })])).toBe(1);
  });
  test("one observation covering several topics counts each of them", () => {
    expect(understood([obs("independent", { concepts: ["a", "b", "c"] })])).toBe(3);
    expect(open([obs("independent", { concepts: ["a", "b", "c"] })])).toBe(1);
  });
});

describe("unlocks", () => {
  test("one object per TOPICS_PER_UNLOCK topics, not per review", () => {
    const one = Array.from({ length: TOPICS_PER_UNLOCK - 1 }, () => obs("independent"));
    expect(open(one)).toBe(0);
    expect(open([...one, obs("independent")])).toBe(1);
    const manyReviewsNoUnderstanding = Array.from({ length: 20 }, (_, i) => obs("partial", { review: `r${i}` }));
    expect(open(manyReviewsNoUnderstanding)).toBe(0);
  });
  test("ids are fixed per room, ordered, and capped", () => {
    const p = deriveProgress(Array.from({ length: TOPICS_PER_UNLOCK * (UNLOCKS_PER_ROOM + 3) }, () => obs("independent")));
    for (const room of ROOM_IDS) expect(p.unlocks[room].map(String)).toEqual(Array.from({ length: UNLOCKS_PER_ROOM }, (_, i) => `${room}/${i + 1}`));
    expect(p.toNextUnlock).toBeNull();
  });
  test("toNextUnlock counts the topics still needed", () => {
    expect(deriveProgress([obs("independent")]).toNextUnlock?.value).toBe(TOPICS_PER_UNLOCK - 1);
  });
});

describe("effort", () => {
  test("one mark per saved review that held effort, apart from understanding", () => {
    const p = deriveProgress([obs("partial", { review: "a" }), obs("after_help", { review: "a" }), obs("independent", { review: "b" }), obs("partial", { review: "c" })]);
    expect(p.effortMarks.map((m) => m.threads)).toEqual([2, 1]);
    expect(p.reviews.value).toBe(3);
    expect(p.understood.value).toBe(1);
  });
  test("a review is counted only when it has a saved question, and the label says so", () => {
    const p = deriveProgress([obs("independent", { review: "a" }), obs("partial", { review: "a" }), obs("unresolved", { review: "b" })]);
    expect(p.reviews.value).toBe(2);
    expect(p.reviews.label).toBe("reviews with a saved question");
    expect(deriveProgress([]).reviews.value).toBe(0);
  });
  test("every number is paired with the label of what it counts", () => {
    const p = deriveProgress([obs("independent", { concepts: ["a", "b"] }), obs("partial"), obs("after_help")]);
    expect([p.understood.value, p.understood.label]).toEqual([2, "topics explained on your own"]);
    expect([p.effort.value, p.effort.label]).toEqual([2, "questions answered with some help or only in part"]);
    expect(p.toNextUnlock).toEqual({ value: TOPICS_PER_UNLOCK - 2, label: "more topics explained on your own for the next object" });
  });
});

function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}
function randomRecord(r: () => number): Observation[] {
  return Array.from({ length: Math.floor(r() * 40) }, () => obs(ALL[Math.floor(r() * ALL.length)]!, { review: `r${Math.floor(r() * 6)}`, concepts: Array.from({ length: Math.floor(r() * 4) }, () => `k${Math.floor(r() * 12)}`) }));
}

describe("properties", () => {
  test("determinism, no loss when a review is added, and understood is the distinct union of independent concepts", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const rec = randomRecord(r);
      expect(deriveProgress(rec)).toEqual(deriveProgress([...rec]));
      const more = [...rec, ...randomRecord(r).map((o) => ({ ...o, reviewId: stableId("rvw", "later") }))];
      const a = deriveProgress(rec), b = deriveProgress(more);
      for (const room of ROOM_IDS) expect([...b.unlocks[room]].slice(0, a.unlocks[room].length)).toEqual([...a.unlocks[room]]);
      expect(b.understood.value).toBeGreaterThanOrEqual(a.understood.value);
      expect(b.effort.value).toBeGreaterThanOrEqual(a.effort.value);
      expect(b.reviews.value).toBeGreaterThanOrEqual(a.reviews.value);
      expect(a.understood.value).toBe(new Set(rec.filter((o) => o.status === "independent").flatMap((o) => o.conceptIds)).size);
      expect(deriveProgress(rec.filter((o) => o.status !== "independent")).understood.value).toBe(0);
    }
  });
});
