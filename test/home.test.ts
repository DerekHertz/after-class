import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EMPTY_HOME, FIRST_CAPTURE_STEPS, HomeBody, OpenById, ResumeTopicLine, loadResumeTopic, resumable, reviewAction, reviewTarget } from "../src/app/home";
import type { ResumeApi } from "../src/app/home";
import { createFixture, ids } from "../scripts/ui-preview/fixtures";
import { EndConfirm } from "../src/app/review";
import { END_CONFIRM_TEXT, endFlow } from "../src/app/core";
import type { EndStep } from "../src/app/core";
import { stableId } from "../src/shared/ids";
import type { LecturesResponse } from "../src/shared/wire";

const cap = stableId("cap", "home-a");
const cap2 = stableId("cap", "home-b");
const [rActive, rEnded, rSaved] = [stableId("rvw", "a"), stableId("rvw", "b"), stableId("rvw", "c")];
const noReads: ResumeApi = {
  review: () => Promise.reject(new Error("static render reads nothing")),
  diagrams: () => Promise.reject(new Error("static render reads nothing")),
};

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
    const html = renderToStaticMarkup(createElement(HomeBody, { api: noReads, data }));
    expect(html).toContain(`href="/app/capture/${cap}"`);
    expect(html).toContain(`href="/app/capture/${cap2}"`);
    expect(html).toContain("Operating Systems");
    expect(html).toContain("2 videos");
    expect(html).toContain("30 min watched");
    expect(html).toContain("Semaphores");
    expect(html).toContain("1 video");
    expect(html).toContain("Capturing");
    expect(html.indexOf("Operating Systems")).toBeLessThan(html.indexOf("Semaphores"));
    expect(html).toContain("In progress · 1 question");
    expect(html).toContain("Ended, not saved <span class=\"muted\">0 questions");
    expect(html).toContain(">Open saved notes</a> <span class=\"muted\">3 questions");
  });

  test("an open review gets a Continue review action named with its lecture, above the lecture list", () => {
    const html = renderToStaticMarkup(createElement(HomeBody, { api: noReads, data }));
    const cont = html.indexOf("Pick up where you left off");
    expect(cont).toBeGreaterThanOrEqual(0);
    expect(cont).toBeLessThan(html.indexOf("Your lectures"));
    const card = html.slice(cont, html.indexOf("Your lectures"));
    expect(card).toContain("Review in progress");
    expect(card).toContain("Operating Systems");
    expect(card).toContain(`href="/app/review/${rActive}">Continue review<span class="visually-hidden">: Operating Systems</span></a>`);
    expect(card).not.toContain(rSaved);
    expect(card).not.toContain(rEnded);
  });

  test("a paused review is offered as Continue review too, newest open review first, and ended ones never are", () => {
    const [p1, p2] = [stableId("rvw", "p1"), stableId("rvw", "p2")];
    const two: LecturesResponse = { lectures: [
      { ...data.lectures[1]!, reviews: [{ reviewId: p1, startedMs: 5, phase: "paused", saved: "unsaved", mainQuestions: 2 }] },
      { ...data.lectures[0]!, reviews: [{ reviewId: p2, startedMs: 9, phase: "active", saved: "unsaved", mainQuestions: 0 }, data.lectures[0]!.reviews[2]!] },
    ] };
    expect(resumable(two).map((x) => x.review.reviewId)).toEqual([p2, p1]);
    const html = renderToStaticMarkup(createElement(HomeBody, { api: noReads, data: two }));
    expect(html).toContain("Paused review");
    expect(html.indexOf(`href="/app/review/${p2}"`)).toBeLessThan(html.indexOf(`href="/app/review/${p1}"`));
    expect(resumable({ lectures: [{ ...data.lectures[0]!, reviews: [data.lectures[0]!.reviews[1]!, data.lectures[0]!.reviews[2]!] }] })).toEqual([]);
  });

  test("a resume card names the current topic, says plainly when there is none yet, and keeps Continue when the topic can't load", () => {
    const line = (props: Parameters<typeof ResumeTopicLine>[0]) => renderToStaticMarkup(createElement(ResumeTopicLine, props));
    expect(line({ topic: { kind: "topic", label: "Circular wait" }, failed: false })).toBe("<p>Current topic: <strong>Circular wait</strong></p>");
    expect(line({ topic: { kind: "no_question" }, failed: false })).toContain("No topic yet. The first question hasn&#x27;t been asked.");
    expect(line({ topic: { kind: "unmatched" }, failed: false })).toContain("topic isn&#x27;t available");
    expect(line({ topic: null, failed: true })).toContain("Couldn&#x27;t load the current topic. Continue review still works.");
    expect(line({ topic: null, failed: false })).toBe("");
    const html = renderToStaticMarkup(createElement(HomeBody, { api: noReads, data }));
    expect(html).toContain(`href="/app/review/${rActive}">Continue review`);
  });

  test("before the first question the topic list isn't read, and a question whose claims match no topic says so", async () => {
    const setup = createFixture("home-setup").api;
    let topicReads = 0;
    expect(await loadResumeTopic({ review: setup.review, diagrams: (id) => { topicReads++; return setup.diagrams(id); } }, ids.review)).toEqual({ kind: "no_question" });
    expect(topicReads).toBe(0);
    const active = createFixture("home").api;
    expect(await loadResumeTopic({ review: active.review, diagrams: async () => [] }, ids.review)).toEqual({ kind: "unmatched" });
  });

  test("with no open review there is no Continue section", () => {
    const html = renderToStaticMarkup(createElement(HomeBody, { api: noReads, data: { lectures: [data.lectures[1]!] } }));
    expect(html).not.toContain("Pick up where you left off");
    expect(html).not.toContain("Continue review");
  });

  test("an active review links to the review, a saved ended one to its record, an unsaved ended one is plain text", () => {
    const html = renderToStaticMarkup(createElement(HomeBody, { api: noReads, data }));
    expect(html).toContain(`href="/app/review/${rActive}"`);
    expect(html).toContain(`href="/app/record/${rSaved}"`);
    expect(html).not.toContain(rEnded);
    expect(reviewTarget({ reviewId: rEnded, phase: "ended", saved: "unsaved" })).toBeNull();
    expect(reviewTarget({ reviewId: rEnded, phase: "ended", saved: "save_pending" })).toBeNull();
    expect(reviewTarget({ reviewId: rActive, phase: "paused", saved: "unsaved" })).toEqual({ page: "review", id: rActive });
  });

  test("each row is named for what it opens, and its link always goes where reviewTarget says", () => {
    const states = [
      { phase: "active", saved: "unsaved", label: "Continue review" },
      { phase: "paused", saved: "unsaved", label: "Continue review" },
      { phase: "ended", saved: "saved", label: "Open saved notes" },
      { phase: "ended", saved: "save_pending", label: "Notes not saved yet" },
      { phase: "ended", saved: "unsaved", label: "Ended, not saved" },
    ] as const;
    for (const { phase, saved, label } of states) {
      const r = { reviewId: rActive, phase, saved };
      expect(reviewAction(r)).toEqual({ label, target: reviewTarget(r) });
    }
  });

  test("with no captures it lists the first capture steps and says only what it knows about the connection", () => {
    const html = renderToStaticMarkup(createElement(HomeBody, { api: noReads, data: { lectures: [] } }));
    expect(html).toContain("No lectures captured yet. Start capture from the extension while watching a lecture.");
    expect(EMPTY_HOME).toBe("No lectures captured yet. Start capture from the extension while watching a lecture.");
    for (const step of FIRST_CAPTURE_STEPS) expect(html).toContain(step);
    expect(html).toContain("Start capture");
    expect(html).toContain("can&#x27;t tell whether the extension is connected");
    expect(html).toContain("Save and test");
    expect(html).not.toContain("Continue review");
  });

  test("opening a capture by ID sits in a closed troubleshooting disclosure", () => {
    const html = renderToStaticMarkup(createElement(OpenById));
    expect(html.startsWith("<details")).toBe(true);
    expect(html).not.toContain("open=");
    expect(html).toContain("<summary>Troubleshooting: open a capture by ID</summary>");
    expect(html).toContain("disabled");
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
    expect(END_CONFIRM_TEXT).toBe("End this review? You can't reopen it.");
    expect(html).toContain("End this review? You can&#x27;t reopen it.");
    expect(html).toContain(">End review<");
    expect(html).toContain(">Keep reviewing<");
  });
});
