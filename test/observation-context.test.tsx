/**
 * Notebook observation rows (#112): each row names its topic, question, answer, the tutor's judgment and evidence, and
 * nothing about it can be changed until that context has loaded. Deterministic UI fixtures only: no providers.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { canChangeObservation, changeObservation, loadReviewContext, observationContext } from "../src/app/observation-view";
import type { ObservationContext, ReviewContext } from "../src/app/observation-view";
import { ObservationItem } from "../src/app/record";
import type { Observation, Turn } from "../src/shared/domain";
import { stableId } from "../src/shared/ids";
import { createFixture, ids } from "../scripts/ui-preview/fixtures";
import type { Fixture } from "../scripts/ui-preview/fixtures";

const run = async (action: () => Promise<void>) => { await action(); };
const noop = () => {};

async function disputes(fixture: Fixture = createFixture("record-disputes")) {
  const record = await fixture.api.record({});
  const review = await loadReviewContext(fixture.api, ids.review);
  return { fixture, record, review, observations: record.observations };
}

function item(fixture: Fixture, observation: Observation, context: ObservationContext, number = 1, deleted: ReadonlySet<string> = new Set()) {
  return renderToStaticMarkup(createElement(ObservationItem, { api: fixture.api, observation, number, context, deleted, retry: noop, run }));
}

const calls = (fixture: Fixture) => fixture.requestLedger.snapshot().split("\n").filter((line) => line.startsWith("dispute.") || line.startsWith("observation."));

describe("observation context", () => {
  test("two disputed topics each carry their own topic, question, answer, dispute, judgment and evidence", async () => {
    const { review, observations } = await disputes();
    expect(observations.map((o) => o.status)).toEqual(["disputed", "disputed"]);
    const [first, second] = observations.map((o) => observationContext(o, review));
    expect(first).toEqual({ kind: "ready", details: {
      topic: "Circular wait", kind: "Question", question: "Two threads are waiting on each other. How could that happen?",
      answers: ["One holds lock A and wants B. The other holds B and wants A."],
      dispute: "I did name circular wait: each thread holds one lock and waits for the other.",
      proposed: "Partial",
      reasoning: "Your answer described the waiting but not why neither thread can release its lock, which the lecture names as the condition.",
      evidence: [ids.frame, ids.passage],
    } });
    expect(second).toEqual({ kind: "ready", details: {
      topic: "Resource ordering", kind: "Question", question: "How does taking locks in one global order prevent a deadlock?",
      answers: ["If every thread takes A before B, nobody holds B while waiting for A."],
      dispute: "That is the global order the lecture gave.",
      proposed: "Unresolved",
      reasoning: "The order is right, but the answer did not say that it removes the circular wait.",
      evidence: [ids.laterPassage],
    } });
  });

  test("the reasoning is the tutor's recorded diagnosis, not its spoken text or a later explanation", async () => {
    const fixture = createFixture("record");
    const [o] = (await fixture.api.record({})).observations;
    const review = await loadReviewContext(fixture.api, ids.review);
    if (review.state !== "ready" || o === undefined) throw new Error("fixture review should load");
    expect(observationContext(o, review)).toMatchObject({ kind: "ready", details: { reasoning: null } });
    const help = review.view.turns.findIndex((t) => t.actor === "tutor" && t.move.kind === "explain");
    const explain = review.view.turns[help]!;
    if (explain.actor !== "tutor") throw new Error("fixture thread should have an explanation");
    const hypothesis = "Treats each thread waiting as enough for deadlock, without either one holding what the other needs.";
    const diagnosis: Turn = { ...explain, id: stableId("turn", "diagnosis"), move: { kind: "diagnose", threadId: ids.thread, hypothesis, evidence: [ids.passage] }, say: "Nearly." };
    const turns = [...review.view.turns.slice(0, help), diagnosis, ...review.view.turns.slice(help)];
    expect(observationContext(o, { state: "ready", view: { ...review.view, turns } })).toMatchObject({ kind: "ready", details: { reasoning: hypothesis } });
  });

  test("pending, failed and incomplete reviews give a row no usable context", async () => {
    const { review, observations } = await disputes();
    const o = observations[0]!;
    expect(observationContext(o, undefined)).toEqual({ kind: "loading" });
    expect(observationContext(o, { state: "loading" })).toEqual({ kind: "loading" });
    expect(observationContext(o, { state: "failed", error: "503" })).toEqual({ kind: "failed", error: "503" });
    if (review.state !== "ready") throw new Error("fixture review should load");
    const noTopic: ReviewContext = { state: "ready", view: { ...review.view, topics: [] } };
    const noQuestion: ReviewContext = { state: "ready", view: { ...review.view, turns: review.view.turns.filter((t) => t.actor !== "tutor" || t.move.kind !== "ask_main") } };
    expect(observationContext(o, noTopic)).toEqual({ kind: "incomplete", missing: ["topic"] });
    expect(observationContext(o, noQuestion)).toEqual({ kind: "incomplete", missing: ["question"] });
    for (const c of [undefined, { state: "loading" } as const, { state: "failed", error: "x" } as const, noTopic, noQuestion]) expect(canChangeObservation(observationContext(o, c))).toBe(false);
  });

  test("one failed review leaves the other reviews' context intact, and its retry succeeds", async () => {
    const fixture = createFixture("record-context-error");
    const record = await fixture.api.record({});
    expect(new Set(record.observations.map((o) => o.reviewId))).toEqual(new Set([ids.earlierReview, ids.review]));
    const [failing, healthy] = await Promise.all([loadReviewContext(fixture.api, ids.earlierReview), loadReviewContext(fixture.api, ids.review)]);
    expect(failing).toEqual({ state: "failed", error: "Fixture review lookup failed. Retry is available." });
    expect(healthy.state).toBe("ready");
    const rows = record.observations.map((o) => observationContext(o, o.reviewId === ids.review ? healthy : failing));
    expect(rows.map((r) => r.kind)).toEqual(["failed", "failed", "ready", "ready"]);
    const retried = await loadReviewContext(fixture.api, ids.earlierReview);
    expect(record.observations.filter((o) => o.reviewId === ids.earlierReview).map((o) => observationContext(o, retried)).map((r) => r.kind === "ready" && r.details.topic)).toEqual(["Circular wait", "Resource ordering"]);
  });

  test("no correction or dispute decision is sent while a row's context is unavailable", async () => {
    const { fixture, review, observations } = await disputes();
    const o = observations[1]!;
    if (review.state !== "ready") throw new Error("fixture review should load");
    const unavailable: ObservationContext[] = [{ kind: "loading" }, { kind: "failed", error: "503" }, { kind: "incomplete", missing: ["topic"] }];
    for (const context of unavailable) {
      expect(await changeObservation(context, run, () => fixture.api.resolveDispute(o.id, "it_was_my_gap"))).toBe(false);
      expect(await changeObservation(context, run, () => fixture.api.overrideObservation(o.id, "partial"))).toBe(false);
    }
    expect(calls(fixture)).toEqual([]);
    expect(await changeObservation(observationContext(o, review), run, () => fixture.api.resolveDispute(o.id, "it_was_my_gap"))).toBe(true);
    expect(calls(fixture)).toEqual([`dispute.resolve ${o.id} it_was_my_gap`]);
  });

  test("R14: settling one dispute leaves the other disputed", async () => {
    const { fixture, observations } = await disputes();
    const [circular, ordering] = observations;
    await fixture.api.resolveDispute(ordering!.id, "learner_was_right");
    const after = await fixture.api.record({});
    expect(after.observations.find((o) => o.id === circular!.id)).toMatchObject({ status: "disputed", dispute: { kind: "unsettled" } });
    expect(after.observations.find((o) => o.id === ordering!.id)?.dispute).toEqual({ kind: "resolved_by_learner", outcome: "learner_was_right" });
  });
});

describe("observation rows", () => {
  test("a ready row names its topic and shows answer, judgment and evidence before the neutral decision", async () => {
    const { fixture, review, observations } = await disputes();
    const html = item(fixture, observations[1]!, observationContext(observations[1]!, review), 2);
    expect(html).toContain(">Resource ordering</h5>");
    expect(html).toContain("Status: Disputed");
    expect(html).toContain("not counted as a learning gap");
    const order = ["How does taking locks in one global order prevent a deadlock?", "If every thread takes A before B", "That is the global order the lecture gave.", "Proposed &quot;Unresolved&quot;.", "Show lecture evidence (1)", "Correct status", "Settle the dispute about Resource ordering", "Keep unresolved", "My explanation was supported", "I want to revisit this", "Save decision"];
    for (let i = 1; i < order.length; i++) expect(html.indexOf(order[i - 1]!)).toBeLessThan(html.indexOf(order[i]!));
    expect(html).toContain('aria-label="Correct status for Resource ordering"');
    expect(html).not.toContain("The tutor was wrong");
    expect(html).not.toContain("It was my gap");
    expect(html).toContain('checked="" value="keep"');
    expect(html).toMatch(/<button type="button" disabled="">Save decision/);
    expect(html).not.toContain('<select aria-label="Correct status for Resource ordering" disabled=""');
    expect(html).not.toMatch(/<fieldset class="dispute-decision" disabled=""/);
  });

  test("a row whose evidence was deleted says so instead of offering it", async () => {
    const { fixture, review, observations } = await disputes();
    const html = item(fixture, observations[1]!, observationContext(observations[1]!, review), 2, new Set([ids.laterPassage]));
    expect(html).not.toContain("Show lecture evidence");
    expect(html).toContain("You deleted the evidence the tutor cited here.");
  });

  for (const [name, context] of [["loading", { kind: "loading" }], ["failed", { kind: "failed", error: "Fixture review lookup failed." }], ["incomplete", { kind: "incomplete", missing: ["question"] }]] as const) {
    test(`a ${name} row disables every change and says why`, async () => {
      const { fixture, observations } = await disputes();
      const html = item(fixture, observations[1]!, context, 2);
      expect(html).toContain(">Observation 2</h5>");
      expect(html).toContain('<select aria-label="Correct status for Observation 2" disabled=""');
      expect(html).toMatch(/<fieldset class="dispute-decision" disabled="">/);
      expect(html).toContain("You can change this observation once its topic, question and answer are shown.");
      if (name === "failed") expect(html).toContain('Fixture review lookup failed. <button type="button">Retry</button>');
      else expect(html).not.toContain(">Retry</button>");
      if (name === "loading") expect(html).toContain("Loading the topic, question and your answer...");
      if (name === "incomplete") expect(html).toContain("no longer shows the question for this observation");
    });
  }

  test("a resolved dispute keeps its status and meaning visible and offers no decision", async () => {
    const { fixture, review, observations } = await disputes();
    await fixture.api.resolveDispute(observations[0]!.id, "it_was_my_gap");
    const resolved = (await fixture.api.record({})).observations[0]!;
    const html = item(fixture, resolved, observationContext(resolved, review));
    expect(html).toContain("Status: Partial");
    expect(html).toContain("You chose to revisit this topic, so it counts as a learning gap.");
    expect(html).not.toContain("Settle the dispute");
  });
});
