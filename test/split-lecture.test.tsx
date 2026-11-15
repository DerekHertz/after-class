import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EarlierReviews, loadLectureReviews } from "../src/app/capture";
import { earlierReviewsNote, routePath } from "../src/app/core";
import type { LectureReview } from "../src/app/home";
import type { ReviewOptions } from "../src/shared/domain";
import { stableId } from "../src/shared/ids";
import { Material, interval } from "../src/shared/time";
import { captureId, READY, src } from "./app-fixtures";
import { reviewOptionsz } from "../src/app/decode";

const titles = new Map([[src, "Cell respiration"]]);
const first = stableId("rvw", "split-first");
const second = stableId("rvw", "split-second");
const row = (reviewId: LectureReview["reviewId"], over: Partial<LectureReview> = {}): LectureReview => ({
  reviewId, startedMs: Date.UTC(2026, 10, 14, 15), phase: "active", saved: "unsaved", mainQuestions: 2, ...over,
});
const early = Material.of([[src, [interval(0, 258)]]]);
const later = Material.of([[src, [interval(200, 300)]]]);
const held = [{ reviewId: first, material: early }];
const withHeld = (options: ReviewOptions, heldBack: ReviewOptions["heldBack"]): ReviewOptions => ({ ...options, heldBack });
const ready = reviewOptionsz.parse(READY);
const processing: ReviewOptions = { kind: "processing", readyNow: null, pendingChunks: 2, estimateS: null, heldBack: held };
const nothing: ReviewOptions = { kind: "nothing_to_review", gaps: [], unverified: [], rewatch: [], heldBack: held };
const loaded = (data: readonly LectureReview[] | null, error: string | null = null) => ({ data, error, reload() {} });

describe("a lecture split across reviews", () => {
  test("the note says how much an earlier review keeps and why, and promises nothing about the rest unless a review is offered", () => {
    const base = "Part of this lecture is in a review you already started, 4:18 of what you watched. It is not offered in a new review, because a review keeps the material it started with.";
    expect(earlierReviewsNote(held, "ready")?.body).toBe(`${base} The review below is made from the rest.`);
    expect(earlierReviewsNote(held, "processing")?.body).toBe(`${base} The rest is still being prepared.`);
    expect(earlierReviewsNote(held, "nothing_to_review")?.body).toBe(`${base} There is nothing else to review yet.`);
  });

  test("two earlier reviews add their time once, and no held review means no note", () => {
    expect(earlierReviewsNote([...held, { reviewId: second, material: later }], "ready")?.body).toContain("2 reviews you already started, 5:00 of");
    expect(earlierReviewsNote([], "ready")).toBeNull();
  });

  test("a review holding everything shows its link and no promise of another review", () => {
    const html = renderToStaticMarkup(createElement(EarlierReviews, { options: nothing, reviews: loaded([row(first)]), titles }));
    expect(html).toContain("There is nothing else to review yet.");
    expect(html).not.toContain("The review below");
    expect(html).toContain(`href="${routePath({ page: "review", id: first })}"`);
    expect(html).toContain("Continue review");
    expect(html).toContain("Cell respiration, 0:00 to 4:18");
  });

  test("an ended review whose material is offered again is not listed, because the options hold nothing back", () => {
    expect(renderToStaticMarkup(createElement(EarlierReviews, { options: withHeld(ready, []), reviews: loaded([row(first, { phase: "ended" })]), titles }))).toBe("");
  });

  test("only the reviews the options hold back are listed", () => {
    const html = renderToStaticMarkup(createElement(EarlierReviews, { options: withHeld(ready, held), reviews: loaded([row(first), row(second)]), titles }));
    expect(html).toContain(routePath({ page: "review", id: first }));
    expect(html).not.toContain(routePath({ page: "review", id: second }));
  });

  test("the note still shows while the lecture list is loading", () => {
    expect(renderToStaticMarkup(createElement(EarlierReviews, { options: processing, reviews: loaded(null), titles }))).toContain("The rest is still being prepared.");
  });

  test("a lecture list that fails is said aloud with a retry, and an unrelated failure shows nothing", () => {
    const failed = renderToStaticMarkup(createElement(EarlierReviews, { options: processing, reviews: loaded(null, "Lecture list unavailable."), titles }));
    expect(failed).toContain("The earlier reviews could not be listed. Lecture list unavailable.");
    expect(failed).toContain("Retry");
    expect(renderToStaticMarkup(createElement(EarlierReviews, { options: withHeld(ready, []), reviews: loaded(null, "Lecture list unavailable."), titles }))).toBe("");
  });

  test("the rows come from the lecture list, which fails loudly instead of returning an empty list", async () => {
    const lectures = async () => ({ lectures: [{ captureId, sourceTitles: [], sourceIds: [], firstSeq: 0, videos: 1, watchedSeconds: 1066, status: { state: "capturing" as const }, reviews: [row(first)] }] });
    expect(await loadLectureReviews({ lectures } as never, captureId)).toEqual([row(first)]);
    await expect(loadLectureReviews({ lectures: async () => { throw new Error("offline"); } } as never, captureId)).rejects.toThrow("offline");
  });
});
