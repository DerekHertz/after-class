/**
 * #116: finishing a review. The completion summary comes only from what the backend persisted, shows unassessed and
 * disputed items as such, and never appears before the save succeeds. Deterministic UI fixtures only: no providers.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createReviewController } from "../src/app/controller";
import type { SessionState } from "../src/app/controller";
import { completionOf, NOT_REACHED } from "../src/app/completion-view";
import { SaveBanner } from "../src/app/review";
import { createMemoryUnsent } from "../src/app/unsent";
import type { Observation, ReviewView } from "../src/shared/domain";
import { createFixture, ids } from "../scripts/ui-preview/fixtures";
import type { Fixture, Scenario } from "../scripts/ui-preview/fixtures";

const speaker = { beginTurn() {}, speak() {}, stop() {} };

async function load(scenario: Scenario) {
  const fixture = createFixture(scenario);
  const controller = createReviewController({ api: fixture.api, reviewId: ids.review, speaker, unsent: createMemoryUnsent() });
  await controller.load();
  return { fixture, controller };
}

const banner = (state: SessionState) => renderToStaticMarkup(createElement(SaveBanner, { state, onRetry() {}, reviewId: ids.review, onSource() {} }));

/** The saved record view of the fixture, with its observations swapped for these. */
async function savedWith(fixture: Fixture, observations: (o: Observation) => readonly Observation[]): Promise<ReviewView> {
  const saved = await fixture.api.review(ids.earlierReview);
  return { ...saved, observations: saved.observations.flatMap(observations) };
}

describe("completion summary from saved observations", () => {
  test("each saved observation lands in its group, and a topic with none is listed as not reached, not as not assessed", async () => {
    const { fixture } = await load("record");
    const view = await savedWith(fixture, (o) => (o.threadId === ids.thread ? [o] : []));
    const outcome = completionOf(view);
    expect(outcome.groups.map((g) => g.group)).toEqual(["disputed", "not_reached"]);
    expect(outcome.groups[0]!.items).toEqual([expect.objectContaining({ label: "Circular wait", status: "Disputed" })]);
    expect(outcome.groups[1]).toMatchObject({ heading: NOT_REACHED, items: [expect.objectContaining({ label: "Resource ordering", status: "", evidence: [] })] });
    expect(outcome.topicsAsked).toBe(1);
    expect(outcome.topicsInScope).toBe(2);
    expect(outcome.disputed).toBe(1);
    expect(outcome.revisit).toEqual([]);
  });

  test("source links come from evidence the tutor cited in that question's thread", async () => {
    const { fixture } = await load("record");
    const outcome = completionOf(await savedWith(fixture, (o) => [o]));
    const circular = outcome.groups.flatMap((g) => g.items).find((i) => i.label === "Circular wait")!;
    expect([...circular.evidence].sort()).toEqual([ids.frame, ids.passage].sort());
    const ordering = outcome.groups.flatMap((g) => g.items).find((i) => i.label === "Resource ordering")!;
    expect(ordering.evidence).toEqual([]);
  });

  test("help, partial and unresolved items are named as the place to start next time; independent ones are not", async () => {
    const { fixture } = await load("record");
    const statuses = ["after_help", "unresolved"] as const;
    let n = 0;
    const outcome = completionOf(await savedWith(fixture, (o) => [{ ...o, status: statuses[n++]!, dispute: { kind: "none" } }]));
    expect(outcome.groups.map((g) => [g.group, g.items.map((i) => i.status)])).toEqual([["with_help", ["After help"]], ["unresolved", ["Unresolved"]]]);
    expect(outcome.revisit).toEqual(["Resource ordering", "Circular wait"]);
  });

  test("a gap status the learner settled as supported is shown as the tutor's assessment and is not named for revisit", async () => {
    const { fixture } = await load("record");
    const statuses = ["partial", "unresolved"] as const;
    let n = 0;
    const view = await savedWith(fixture, (o) => [{ ...o, status: statuses[n++]!, dispute: { kind: "resolved_by_learner", outcome: "learner_was_right" } }]);
    const outcome = completionOf(view);
    expect(outcome.groups.map((g) => g.group)).toEqual(["supported"]);
    expect(outcome.groups[0]!.items.map((i) => [i.label, i.status, i.resolution])).toEqual([
      ["Circular wait", "The tutor assessed it as Partial", "You marked your explanation as supported"],
      ["Resource ordering", "The tutor assessed it as Unresolved", "You marked your explanation as supported"],
    ]);
    expect(outcome.revisit).toEqual([]);
    expect(outcome.disputed).toBe(0);
    const html = banner({ view, loadError: null, live: null, unsent: [], storageDegraded: false, busy: false, sendError: null, saving: false, saveError: null, savedSummary: null });
    expect(html).toContain("You marked your explanation as supported (2)");
    expect(html).not.toContain("Next time, start with");
    expect(html).not.toContain("Still unresolved");
  });

  test("a gap status the learner chose to revisit stays in its group and is named for revisit", async () => {
    const { fixture } = await load("record");
    const statuses = ["partial", "unresolved"] as const;
    let n = 0;
    const view = await savedWith(fixture, (o) => [{ ...o, status: statuses[n++]!, dispute: { kind: "resolved_by_learner", outcome: "it_was_my_gap" } }]);
    const outcome = completionOf(view);
    expect(outcome.groups.map((g) => [g.group, g.items.map((i) => [i.status, i.resolution])])).toEqual([
      ["with_help", [["Partial", "You chose to revisit this"]]],
      ["unresolved", [["Unresolved", "You chose to revisit this"]]],
    ]);
    expect(outcome.revisit).toEqual(["Resource ordering", "Circular wait"]);
  });

  test("the disputed prompt offers the neutral choices and never assigns fault", async () => {
    const { controller } = await load("review");
    await controller.send({ kind: "end" });
    const html = banner(controller.getState());
    expect(html).toContain("For each one, you can mark your explanation as supported, choose to revisit it, or leave it disputed for now.");
    expect(html).not.toMatch(/tutor was wrong|your gap/i);
  });

  test("with no saved observations every topic reads as not reached and the panel says so", async () => {
    const { fixture } = await load("record");
    const view = await savedWith(fixture, () => []);
    const outcome = completionOf(view);
    expect(outcome.groups).toEqual([{ group: "not_reached", heading: NOT_REACHED, items: expect.any(Array) }]);
    expect(outcome.groups[0]!.items.map((i) => i.status)).toEqual(["", ""]);
    const html = banner({ view, loadError: null, live: null, unsent: [], storageDegraded: false, busy: false, sendError: null, saving: false, saveError: null, savedSummary: null });
    expect(html).toContain("The tutor saved no observations for this review, so nothing here is assessed.");
  });
});

describe("finishing a review in the deterministic fixtures", () => {
  test("Finish & save shows the summary only after the backend reports saved, with the notebook link and the disputed and unassessed items", async () => {
    const { controller } = await load("review");
    expect(banner(controller.getState())).not.toContain("Review saved");
    await controller.send({ kind: "end" });
    const state = controller.getState();
    expect(state.view?.saved).toBe("saved");
    const html = banner(state);
    expect(html).toContain("Review saved");
    expect(html).toContain("Saved 1 note and 1 observation.");
    expect(html).toContain("Disputed, waiting for you to settle (1)");
    expect(html).toContain("Not reached in this review (1)");
    expect(html).toContain("<details");
    expect(html).not.toContain("Not assessed (1)");
    expect(html).toContain("Questions covered 1 of 2 topics in this review.");
    expect(html).toContain("Settle the disputed item in your notebook");
    expect(html).toContain(`href="/app/record/${ids.review}"`);
    expect(html).toContain(">Open this review in my notebook<");
    expect(html).toContain("Lecture source · 2 items");
  });

  test("a delayed save shows Saving and no summary until it finishes", async () => {
    const { fixture, controller } = await load("saving");
    const saving = controller.save();
    await Promise.resolve();
    const during = banner(controller.getState());
    expect(controller.getState().saving).toBe(true);
    expect(during).toContain("Saving this review to your notebook...");
    expect(during).not.toContain("Review saved");
    fixture.continueFixture();
    await saving;
    expect(banner(controller.getState())).toContain("Review saved");
  });

  test("a failed save keeps Retry and no summary; the retry that succeeds shows the summary", async () => {
    const { controller } = await load("save-failure");
    await controller.save();
    const failed = banner(controller.getState());
    expect(failed).toContain("This review is not saved yet: Fixture disk write failed.");
    expect(failed).toContain(">Retry save<");
    expect(failed).not.toContain("Review saved");
    await controller.save();
    const retried = banner(controller.getState());
    expect(retried).not.toContain("Retry save");
    expect(retried).toContain("Review saved");
  });

  test("reopening a saved review shows the summary without a fresh save count", async () => {
    const fixture = createFixture("record");
    const controller = createReviewController({ api: fixture.api, reviewId: ids.review, speaker, unsent: createMemoryUnsent() });
    await controller.load();
    const html = banner(controller.getState());
    expect(controller.getState().savedSummary).toBeNull();
    expect(html).toContain("Review saved");
    expect(html).not.toContain("Saved 1 note");
  });
});
