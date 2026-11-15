import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EarlierReviews, loadEarlierReviews } from "../src/app/capture";
import { earlierReviewsNote, routePath } from "../src/app/core";
import type { LectureReview } from "../src/app/home";
import { stableId } from "../src/shared/ids";
import { Material, interval } from "../src/shared/time";
import { captureId, parsedReview, src } from "./app-fixtures";

const titles = new Map([[src, "Cell respiration"]]);
const first = stableId("rvw", "split-first");
const second = stableId("rvw", "split-second");
const row = (reviewId: LectureReview["reviewId"], over: Partial<LectureReview> = {}): LectureReview => ({
  reviewId, startedMs: Date.UTC(2026, 10, 14, 15), phase: "active", saved: "unsaved", mainQuestions: 2, ...over,
});
const early = Material.of([[src, [interval(0, 258)]]]);

describe("a lecture split across reviews", () => {
  test("the page says how much is already in an earlier review and why it is not in the new one", () => {
    const note = earlierReviewsNote([{ review: row(first), material: early }]);
    expect(note?.body).toBe(
      "Part of this lecture is in a review you already started, 4:18 of what you watched. It is not in the review below, because a review keeps the material it started with. The review below covers the rest.",
    );
  });

  test("two earlier reviews add their time once, and an unreadable scope leaves the length out", () => {
    const later = Material.of([[src, [interval(200, 300)]]]);
    expect(earlierReviewsNote([{ review: row(first), material: early }, { review: row(second), material: later }])?.body).toContain("2 reviews you already started, 5:00 of");
    expect(earlierReviewsNote([{ review: row(first), material: early }, { review: row(second), material: null }])?.body).toStartWith("Part of this lecture is in 2 reviews you already started. It is not");
    expect(earlierReviewsNote([])).toBeNull();
  });

  test("the earlier review is listed with a link that opens it", () => {
    const html = renderToStaticMarkup(createElement(EarlierReviews, { earlier: [{ review: row(first), material: early }], titles }));
    expect(html).toContain("4:18 of what you watched");
    expect(html).toContain(`href="${routePath({ page: "review", id: first })}"`);
    expect(html).toContain("Continue review");
    expect(html).toContain("Cell respiration, 0:00 to 4:18");
  });

  test("a lecture with no earlier review shows nothing", () => {
    expect(renderToStaticMarkup(createElement(EarlierReviews, { earlier: [], titles }))).toBe("");
  });

  test("the reviews come from the lecture list and their time from each review's scope, oldest first", async () => {
    const view = parsedReview();
    const api = {
      lectures: async () => ({ lectures: [{ captureId, sourceTitles: [], sourceIds: [], firstSeq: 0, videos: 1, watchedSeconds: 1066, status: { state: "capturing" as const }, reviews: [row(second, { startedMs: 2 }), row(first, { startedMs: 1 })] }] }),
      review: async (id: string) => {
        if (id === second) throw new Error("gone");
        return { ...view, scope: { ...view.scope, material: early } };
      },
    };
    const got = await loadEarlierReviews(api as never, captureId);
    expect(got.map((e) => e.review.reviewId)).toEqual([first, second]);
    expect(got[0]!.material).toBe(early);
    expect(got[1]!.material).toBeNull();
  });
});
