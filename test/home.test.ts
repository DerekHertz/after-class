import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EMPTY_HOME, HomeBody, reviewTarget } from "../src/app/home";
import { EndConfirm } from "../src/app/review";
import { END_CONFIRM_TEXT, endFlow } from "../src/app/core";
import type { EndStep } from "../src/app/core";
import { stableId } from "../src/shared/ids";
import type { LecturesResponse } from "../src/shared/wire";

const cap = stableId("cap", "home-a");
const cap2 = stableId("cap", "home-b");
const [rActive, rEnded, rSaved] = [stableId("rvw", "a"), stableId("rvw", "b"), stableId("rvw", "c")];

const data: LecturesResponse = {
  lectures: [
    {
      captureId: cap, sourceTitles: ["Locks - Operating Systems", "Deadlock - Operating Systems"], videos: 2, watchedSeconds: 1800, status: { state: "stopped" },
      reviews: [
        { reviewId: rActive, startedMs: 3, phase: "active", saved: "unsaved", mainQuestions: 1 },
        { reviewId: rEnded, startedMs: 2, phase: "ended", saved: "unsaved", mainQuestions: 0 },
        { reviewId: rSaved, startedMs: 1, phase: "ended", saved: "saved", mainQuestions: 3 },
      ],
    },
    { captureId: cap2, sourceTitles: ["Semaphores"], videos: 1, watchedSeconds: 30, status: { state: "capturing" }, reviews: [] },
  ],
};

describe("the home page", () => {
  test("lists each lecture with a link to its capture page, and its reviews underneath", () => {
    const html = renderToStaticMarkup(createElement(HomeBody, { data }));
    expect(html).toContain(`href="/app/capture/${cap}"`);
    expect(html).toContain(`href="/app/capture/${cap2}"`);
    expect(html).toContain("Operating Systems");
    expect(html).toContain("2 videos");
    expect(html).toContain("30 min watched");
    expect(html).toContain("Semaphores");
    expect(html).toContain("1 video");
    expect(html).toContain("Capturing");
    expect(html.indexOf("Operating Systems")).toBeLessThan(html.indexOf("Semaphores"));
    expect(html).toContain("In progress");
    expect(html).toContain("Ended, not saved · 0 questions");
    expect(html).toContain("Ended, saved · 3 questions");
  });

  test("an active review links to the review, a saved ended one to its record, an unsaved ended one is plain text", () => {
    const html = renderToStaticMarkup(createElement(HomeBody, { data }));
    expect(html).toContain(`href="/app/review/${rActive}"`);
    expect(html).toContain(`href="/app/record/${rSaved}"`);
    expect(html).not.toContain(rEnded);
    expect(reviewTarget({ reviewId: rEnded, phase: "ended", saved: "unsaved" })).toBeNull();
    expect(reviewTarget({ reviewId: rEnded, phase: "ended", saved: "save_pending" })).toBeNull();
    expect(reviewTarget({ reviewId: rActive, phase: "paused", saved: "unsaved" })).toEqual({ page: "review", id: rActive });
  });

  test("with no captures it says how to start one", () => {
    const html = renderToStaticMarkup(createElement(HomeBody, { data: { lectures: [] } }));
    expect(html).toContain("No lectures captured yet. Start capture from the extension while watching a lecture.");
    expect(EMPTY_HOME).toBe("No lectures captured yet. Start capture from the extension while watching a lecture.");
  });
});

describe("ending a review asks first", () => {
  test("pressing End sends nothing; only the confirm step does, once", () => {
    const pressed = endFlow("idle", "press_end");
    expect(pressed).toEqual({ step: "confirming", send: false });
    expect(endFlow(pressed.step, "confirm")).toEqual({ step: "confirming", send: true });
  });

  test("Keep reviewing goes back without sending, and a confirm that was never asked for sends nothing", () => {
    expect(endFlow("confirming", "cancel")).toEqual({ step: "idle", send: false });
    for (const step of ["idle"] as EndStep[]) expect(endFlow(step, "confirm").send).toBe(false);
  });

  test("the confirm step reads as the spec says and offers both buttons", () => {
    const html = renderToStaticMarkup(createElement(EndConfirm, { disabled: false, onConfirm() {}, onCancel() {} }));
    // #116: the learner sees what stops (the conversation) and what stays (the notebook record and a read-only review).
    expect(END_CONFIRM_TEXT).toBe("Finish and save this review? The conversation ends and can't be continued. Your notes and results stay in your notebook, and you can reread this review.");
    expect(html).toContain("The conversation ends and can&#x27;t be continued.");
    expect(html).toContain('aria-label="Finish and save this review?"');
    expect(html).toContain(">Finish &amp; save<");
    expect(html).toContain(">Keep reviewing<");
  });
});
