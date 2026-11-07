/**
 * Runtime check of the UI preview fixtures (scripts/ui-preview). Every scenario is built and parsed through the wire
 * schemas, loaded through the review controller the page uses, and its data rendered, so schema drift fails here
 * instead of as a blank preview page. Fixtures only: no providers.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createReviewController, needsChecklist } from "../src/app/controller";
import { IllustratedPageView } from "../src/app/diagram";
import { HomeBody } from "../src/app/home";
import { illustratedPages } from "../src/app/diagram-view";
import { RecordBody } from "../src/app/record";
import { TopicChecklist } from "../src/app/review";
import { createMemoryUnsent } from "../src/app/unsent";
import type { LearnerAct } from "../src/shared/domain";
import { randomId } from "../src/shared/ids";
import type { ReviewId, TurnId } from "../src/shared/ids";
import { tutorStreamEvent } from "../src/shared/wire";
import type { TutorStreamEvent } from "../src/shared/wire";
import { createFixture, ids, scenarioFrom, scenarios } from "../scripts/ui-preview/fixtures";
import type { Fixture } from "../scripts/ui-preview/fixtures";

const speaker = { beginTurn() {}, speak() {}, stop() {} };
const noop = () => {};
const turnId = (): TurnId => randomId("turn");
const answer: LearnerAct = { kind: "answer", text: "One thread could release its lock first.", modality: "text" };

async function load(fixture: Fixture, reviewId: ReviewId = ids.review) {
  const controller = createReviewController({ api: fixture.api, reviewId, speaker, unsent: createMemoryUnsent() });
  await controller.load();
  return controller;
}

async function collect(stream: AsyncIterable<TutorStreamEvent>): Promise<TutorStreamEvent[]> {
  const events: TutorStreamEvent[] = [];
  for await (const ev of stream) events.push(tutorStreamEvent.parse(ev));
  return events;
}

/** Calls `read`, retrying once: the failure scenarios fail their first attempt on purpose. */
async function settle<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch {
    return read();
  }
}

describe("UI preview fixtures", () => {
  test("an unknown or missing scenario falls back to review", () => {
    expect(scenarioFrom("")).toBe("review");
    expect(scenarioFrom("?scenario=nope")).toBe("review");
    expect(scenarioFrom("?scenario=diagram")).toBe("diagram");
  });

  for (const scenario of scenarios) {
    test(`${scenario}: parses against the wire schemas and loads without errors`, async () => {
      const fixture = createFixture(scenario);
      const controller = await load(fixture);
      const state = controller.getState();
      expect(state.loadError).toBeNull();
      expect(state.view?.topics.length).toBeGreaterThan(0);
      const { api } = fixture;
      await api.captureView(ids.capture);
      await api.reviewOptions(ids.capture);
      await settle(() => api.lectures());
      await api.usage();
      await settle(() => api.evidence({ captureId: ids.capture }));
      const record = await settle(() => api.record(fixture.recordReviewId === null ? {} : { reviewId: fixture.recordReviewId }));
      const diagrams = await api.diagrams(ids.review);
      expect(diagrams.length).toBe(2);
      renderToStaticMarkup(createElement(RecordBody, { api, data: record, run: async () => {} }));
      // Every review in the notebook has complete illustrated pages, so an empty page means a product failure, not a fixture gap.
      for (const reviewId of new Set(record.notes.map((n) => n.reviewId))) {
        const saved = await api.review(reviewId);
        expect(saved.saved).toBe("saved");
        const pages = illustratedPages(saved, diagrams);
        expect(pages.map((p) => p.topic.label)).toEqual(["Circular wait", "Resource ordering"]);
        for (const page of pages) {
          const html = renderToStaticMarkup(createElement(IllustratedPageView, { api, page, onRequest: noop }));
          expect(html).not.toContain("No answer recorded.");
        }
      }
    });
  }

  test("fuzzy-checklist: the checklist shows first and a begin act records the marked topics", async () => {
    const fixture = createFixture("fuzzy-checklist");
    const controller = await load(fixture);
    const view = controller.getState().view!;
    expect(needsChecklist(controller.getState())).toBe(true);
    const html = renderToStaticMarkup(createElement(TopicChecklist, { topics: view.topics, disabled: false, onStart: noop }));
    expect(html).toContain("Circular wait");
    expect(html).toContain("Resource ordering");
    expect(await controller.send({ kind: "begin", fuzzy: [ids.ordering], note: "Lock order" })).toBe(true);
    const after = controller.getState();
    expect(after.view?.state.fuzzy).toEqual([ids.ordering]);
    expect(after.view?.turns.at(-1)?.actor).toBe("tutor");
    expect(needsChecklist(after)).toBe(false);
  });

  test("home scenarios: the open review leads to the review page the preview loads, and the empty home shows the first steps", async () => {
    for (const [scenario, kicker] of [["home", "Review in progress"], ["home-paused", "Paused review"]] as const) {
      const html = renderToStaticMarkup(createElement(HomeBody, { data: await createFixture(scenario).api.lectures() }));
      expect(html).toContain(kicker);
      expect(html.indexOf(`href="/app/review/${ids.review}"`)).toBeLessThan(html.indexOf("Your lectures"));
      expect(html).toContain(`href="/app/record/${ids.earlierReview}"`);
    }
    const empty = renderToStaticMarkup(createElement(HomeBody, { data: await createFixture("home-empty").api.lectures() }));
    expect(empty).toContain("Capture your first lecture");
  });

  test("record-illustrated: the record is filtered to the saved review shown on the page", async () => {
    const fixture = createFixture("record-illustrated");
    expect(fixture.recordReviewId).toBe(ids.review);
    const record = await fixture.api.record({ reviewId: ids.review });
    expect(record.notes.every((n) => n.reviewId === ids.review)).toBe(true);
    expect(record.observations.map((o) => o.status).sort()).toEqual(["disputed", "independent"]);
  });

  test("diagram: a summary request fails once, then prepares until the fixture gate is released", async () => {
    const fixture = createFixture("diagram");
    const { api } = fixture;
    expect((await api.requestDiagram(ids.review, ids.ordering)).summary.state).toBe("failed");
    expect((await api.requestDiagram(ids.review, ids.ordering)).summary.state).toBe("preparing");
    expect((await api.diagrams(ids.review)).find((t) => t.topicId === ids.ordering)?.summary.state).toBe("preparing");
    fixture.continueFixture();
    await Promise.resolve();
    expect((await api.diagrams(ids.review)).find((t) => t.topicId === ids.ordering)?.summary.state).toBe("ready");
  });

  test("streaming: the reply waits at the gate until it is released", async () => {
    const fixture = createFixture("streaming");
    const events: TutorStreamEvent[] = [];
    const done = (async () => { for await (const ev of fixture.api.sendTurn(ids.review, turnId(), answer)) events.push(tutorStreamEvent.parse(ev)); })();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(events.map((e) => e.type)).toEqual(["learner_turn_stored", "move", "say_delta"]);
    fixture.continueFixture();
    await done;
    expect(events.at(-1)?.type).toBe("turn_complete");
  });

  test("failure scenarios fail their first attempt and succeed on retry", async () => {
    const failed = createFixture("failed-turn");
    const id = turnId();
    await expect(collect(failed.api.sendTurn(ids.review, id, answer))).rejects.toThrow("interrupted before delivery");
    expect((await collect(failed.api.sendTurn(ids.review, id, answer))).at(-1)?.type).toBe("turn_complete");

    const unfinished = createFixture("unfinished-reply");
    expect((await collect(unfinished.api.sendTurn(ids.review, id, answer))).at(-1)).toEqual({ type: "turn_failed", error: "Fixture reply interrupted after delivery.", retryable: true });
    expect((await collect(unfinished.api.sendTurn(ids.review, id, answer))).at(-1)?.type).toBe("turn_complete");

    const save = createFixture("save-failure");
    expect((await save.api.save(ids.review)).kind).toBe("save_failed");
    expect((await save.api.save(ids.review)).kind).toBe("saved");

    for (const scenario of ["record-error", "evidence-error", "home-error"] as const) {
      const f = createFixture(scenario);
      const read = scenario === "record-error" ? () => f.api.record({}) : scenario === "home-error" ? () => f.api.lectures() : () => f.api.evidence({ captureId: ids.capture });
      await expect(read()).rejects.toThrow("Retry is available");
      await read();
    }
  });
});
