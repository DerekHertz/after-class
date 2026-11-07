/**
 * Notebook observation rows (#112): each row names its topic and shows the question, the learner's answer, the
 * tutor's assessment and reasons, and the sources it cited before any control that changes it. Deterministic
 * fixtures only; nothing here touches a network, a browser or a model.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";
import { stableId } from "../src/shared/ids";
import type { Observation, ReviewView } from "../src/shared/domain";
import type { AppApi } from "../src/app/api";
import { DISPUTE_CHOICES, observationContext, observationRow } from "../src/app/core";
import type { ObservationContext } from "../src/app/core";
import { reviewViewz } from "../src/app/decode";
import { ObservationItem, RecordBody } from "../src/app/record";

const reviewId = stableId("rvw", "obs-review");
const captureId = stableId("cap", "obs-capture");
const src = stableId("src", "obs-source");
const crv = stableId("crv", "obs-chunk");
const ev = [stableId("ev", "obs-a"), stableId("ev", "obs-b"), stableId("ev", "obs-c")] as const;
const topics = [
  { id: stableId("cpt", "circular-wait"), label: "Circular wait", claim: stableId("clm", "circular-wait"), thread: stableId("thr", "circular-wait") },
  { id: stableId("cpt", "lock-ordering"), label: "Lock ordering", claim: stableId("clm", "lock-ordering"), thread: stableId("thr", "lock-ordering") },
] as const;

let seq = 0;
const turn = (actor: "learner" | "tutor", threadId: string, rest: Record<string, unknown>) => {
  seq += 1;
  return { id: stableId("turn", `obs-${seq}`), reviewId, seq, atMs: seq * 1000, actor, threadId, ...rest };
};

const turns = [
  turn("tutor", topics[0].thread, { move: { kind: "ask_main", threadId: topics[0].thread, claimIds: [topics[0].claim] }, say: "Two threads wait on each other. How could that happen?" }),
  turn("learner", topics[0].thread, { act: { kind: "answer", text: "Each holds one lock and wants the other's.", modality: "text" } }),
  turn("tutor", topics[0].thread, { move: { kind: "diagnose", threadId: topics[0].thread, hypothesis: "You named hold-and-wait but not the cycle.", evidence: [ev[0]] }, say: "Close." }),
  turn("learner", topics[0].thread, { act: { kind: "dispute", text: "The cycle is what I described." } }),
  turn("tutor", topics[0].thread, { move: { kind: "answer_dispute", threadId: topics[0].thread, evidence: [ev[1]], settled: false }, say: "The lecture separates the cycle from holding a lock." }),
  turn("tutor", topics[1].thread, { move: { kind: "ask_main", threadId: topics[1].thread, claimIds: [topics[1].claim] }, say: "Why does a global lock order prevent deadlock?" }),
  turn("learner", topics[1].thread, { act: { kind: "answer", text: "No thread can wait on a lower-ordered lock.", modality: "speech" } }),
  turn("learner", topics[1].thread, { act: { kind: "dispute", text: "That is the lecture's argument." } }),
  turn("tutor", topics[1].thread, { move: { kind: "answer_dispute", threadId: topics[1].thread, evidence: [ev[2]], settled: false }, say: "The lecture adds that every thread must follow it." }),
];

const observationJson = (i: 0 | 1, rest: Record<string, unknown> = {}) => {
  const t = topics[i];
  const learnerTurns = turns.filter((x) => x.actor === "learner" && x.threadId === t.thread).map((x) => x.id);
  return {
    id: stableId("obs", t.label), reviewId, threadId: t.thread, claimIds: [t.claim], conceptIds: [t.id], proposed: "partial", status: "disputed",
    clampedFrom: null, dispute: { kind: "unsettled" }, corrections: [],
    facts: { threadId: t.thread, firstSubstantiveAnswerSeq: 2, firstHelpSeq: null, endedBySkip: false, saidDontKnowOnly: false, learnerTurns, helpTurns: [] },
    ...rest,
  };
};

const reviewJson = (observations: readonly unknown[]) => ({
  reviewId, captureId,
  topics: topics.map((t) => ({ id: t.id, label: t.label, summary: "" })),
  scope: { chunkRevisions: [crv], material: [[src, [[0, 600]]]], claimsAtStart: topics.map((t) => t.claim), partial: [], frozenAtSeq: 1 },
  state: { reviewId, phase: "ended", mainQuestions: 2, quickChecks: 0, fuzzy: [], openThread: null, lastLearnerAct: null, detour: { kind: "none" }, openDispute: null, corrections: [], activeSeconds: 120, softTargetS: 600, softTargetOffered: false, wrapUpRequested: false },
  turns, owesMove: false, observations, saved: "saved",
});
const review: ReviewView = reviewViewz.parse(reviewJson([observationJson(0), observationJson(1)]));
const [first, second] = review.observations as [Observation, Observation];
const observationAt = (i: 0 | 1, rest: Record<string, unknown>): Observation => reviewViewz.parse(reviewJson([observationJson(i, rest)])).observations[0]!;

const api = {} as AppApi;
const run = async () => {};

describe("observation context", () => {
  test("two disputed topics each carry their own topic, question, answer, dispute, reasons and sources", () => {
    expect(observationContext(first, review)).toEqual({
      topic: "Circular wait", kind: "Question", question: "Two threads wait on each other. How could that happen?",
      answers: ["Each holds one lock and wants the other's."], dispute: "The cycle is what I described.", assessed: "Partial",
      reasoning: { label: "The tutor's reply to your dispute", text: "The lecture separates the cycle from holding a lock." },
      evidence: [ev[0], ev[1]],
    });
    expect(observationContext(second, review)).toMatchObject({
      topic: "Lock ordering", question: "Why does a global lock order prevent deadlock?", answers: ["No thread can wait on a lower-ordered lock."],
      dispute: "That is the lecture's argument.", reasoning: { text: "The lecture adds that every thread must follow it." }, evidence: [ev[2]],
    });
  });

  test("without the review the row still renders, unnamed and without invented context", () => {
    expect(observationContext(first, null)).toEqual({ topic: null, kind: "Question", question: null, answers: [], dispute: null, assessed: "Partial", reasoning: null, evidence: [] });
  });
});

describe("observation rows", () => {
  const render = (o: Observation, index = 0, context: ObservationContext | null = observationContext(o, review)) =>
    renderToStaticMarkup(createElement(ObservationItem, { api, observation: o, index, context, run }));

  test("each disputed row names its topic, quotes the answer and reasons, and offers sources before the decision", () => {
    const a = render(first, 0);
    const b = render(second, 1);
    expect(a).toContain("<h3");
    expect(a).toContain("Circular wait");
    expect(a).toContain("Each holds one lock and wants the other&#x27;s.");
    expect(a).toContain("The cycle is what I described.");
    expect(a).toContain("The lecture separates the cycle from holding a lock.");
    expect(a).toContain("Show sources (2)");
    expect(a).toContain('aria-label="Correct status: Circular wait"');
    expect(a).toContain("Settle the dispute about Circular wait");
    expect(a).not.toContain("Lock ordering");
    expect(b).toContain("Lock ordering");
    expect(b).toContain("No thread can wait on a lower-ordered lock.");
    expect(b).toContain("Show sources (1)");
    expect(b).not.toContain("Circular wait");
    // The context comes before the controls that change it.
    for (const html of [a, b]) {
      expect(html.indexOf("Your answer")).toBeLessThan(html.indexOf("Correct status"));
      expect(html.indexOf("Show sources")).toBeLessThan(html.indexOf("Settle the dispute"));
    }
  });

  test("resolution is offered in neutral words, keeping it unresolved is explicit and selected, and nothing is saved until chosen", () => {
    const html = render(first);
    expect(html).toContain("Keep unresolved");
    expect(html).toContain("My explanation was supported");
    expect(html).toContain("I want to revisit this");
    expect(html).not.toMatch(/tutor was wrong|my gap/i);
    expect(html.match(/type="radio"[^>]*checked=""/g)?.length).toBe(1);
    expect(html).toMatch(/<input type="radio"[^>]*checked=""[^>]*\/><span>Keep unresolved<\/span>/);
    expect(html).toMatch(/<button type="button" disabled="">Save decision<\/button>/);
    expect(html).toContain("Status: Disputed");
    expect(html).toContain("not counted as a learning gap");
  });

  test("the neutral choices map onto the existing dispute semantics", () => {
    expect(DISPUTE_CHOICES.map((c) => [c.label, c.outcome])).toEqual([
      ["Keep unresolved", null],
      ["My explanation was supported", "learner_was_right"],
      ["I want to revisit this", "it_was_my_gap"],
    ]);
  });

  test("a settled dispute shows its resulting status and meaning, and no longer offers resolution", () => {
    const supported = observationAt(0, { status: "partial", dispute: { kind: "resolved_by_learner", outcome: "learner_was_right" } });
    expect(observationRow(supported).note).toBe("You marked your explanation as supported. The tutor's assessment is kept for reference and is not counted as a learning gap.");
    const html = render(supported);
    expect(html).toContain("Status: Partial");
    expect(html).not.toContain("Settle the dispute");
    const revisit = observationAt(0, { proposed: "independent", status: "unresolved", clampedFrom: "independent", dispute: { kind: "resolved_by_learner", outcome: "it_was_my_gap" } });
    expect(observationRow(revisit).note).toBe('The tutor proposed "Independent"; recorded as "Unresolved" because you chose to revisit this topic.');
  });

  test("an undisputed row with no cited source says so instead of offering an empty source button", () => {
    const plain = observationAt(1, { status: "partial", dispute: { kind: "none" } });
    const html = render(plain, 0, { ...observationContext(plain, review), evidence: [] });
    expect(html).toContain("The tutor cited no lecture source on this question.");
    expect(html).not.toContain("Show sources");
    expect(html).not.toContain("Settle the dispute");
  });

  test("while the review loads, the row keeps a numbered heading and its controls", () => {
    const html = render(first, 1, null);
    expect(html).toContain("Observation 2");
    expect(html).toContain("The question and your answer are not loaded yet.");
    expect(html).toContain("Correct status");
  });

  test("the notebook shows a loading note for topics while observation context is fetched", () => {
    const html = renderToStaticMarkup(createElement(RecordBody, { api, data: { notes: [], observations: [first, second], links: [], unavailableEvidence: [] }, run }));
    expect(html).toContain("Loading topics and answers...");
    expect(html).toContain("Observation 1");
    expect(html).toContain("Observation 2");
  });
});
