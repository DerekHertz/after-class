/** The review app's diagram pieces: panel states, citations (R19), links, the illustrated record page. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppApi } from "../src/app/api";
import { DiagramPanel, DiagramSummaryView, IllustratedPageView, ShowDiagramButton } from "../src/app/diagram";
import { currentQuestionTopic, frameLink, lineSources, illustratedPages, NO_FRAME_NOTE, shouldPollDiagrams, SUMMARY_NOTE } from "../src/app/diagram-view";
import type { Observation, ReviewView, TopicDiagram, Turn } from "../src/shared/domain";
import { stableId } from "../src/shared/ids";
import type { ClaimId, ConceptId, EvidenceId, ObservationId, ReviewId, SourceId, ThreadId, TurnId } from "../src/shared/ids";
import { media } from "../src/shared/time";

const api = {} as AppApi;
const noop = () => {};
const id = <T,>(kind: string, name: string) => stableId(kind as never, name) as unknown as T;

const REVIEW = id<ReviewId>("rvw", "r");
const SRC = id<SourceId>("src", "s");
const T1 = id<ConceptId>("cpt", "clocks");
const T2 = id<ConceptId>("cpt", "locks");
const T3 = id<ConceptId>("cpt", "unasked");
const C1 = id<ClaimId>("clm", "c1");
const C2 = id<ClaimId>("clm", "c2");
const C3 = id<ClaimId>("clm", "c3");
const E1 = id<EvidenceId>("ev", "e1");
const E2 = id<EvidenceId>("ev", "e2");
const FRAME = id<EvidenceId>("ev", "frame");
const TH1 = id<ThreadId>("thr", "1");
const TH2 = id<ThreadId>("thr", "2");

const topic = (over: Partial<TopicDiagram> = {}): TopicDiagram => ({
  topicId: T1, label: "Lamport clocks", claimIds: [C1],
  frame: { id: FRAME, mediaS: media(125), sourceId: SRC, videoId: "VIDEO000001", title: "Lecture 4" },
  summary: { state: "ready", title: "How do clocks order events?", lines: [{ text: "Node P: local +1, global -1.", evidence: [E1] }, { text: "Rule: a receive follows its send.", evidence: [E1, E2] }] },
  ...over,
});

const panel = (t: TopicDiagram, extra: object = {}) => renderToStaticMarkup(createElement(DiagramPanel, { api, topic: t, error: null, onRequest: noop, onCite: noop, onClose: noop, ...extra }));

describe("the diagram panel", () => {
  test("shows the frame with its time and a link to that moment, then the title and the lines, sources hidden", () => {
    const html = panel(topic());
    expect(html).toContain("How do clocks order events?");
    expect(html).toContain("Loading frame...");
    expect(html).toContain("Captured frame · Lecture 4 at 2:05");
    expect(html).toContain('href="https://www.youtube.com/watch?v=VIDEO000001&amp;t=125s"');
    expect(html).toContain("Open in YouTube at that moment");
    expect(html).toContain("Node P: local +1, global -1.");
    expect(html).toContain("Close diagram");
    expect(html.indexOf("Captured frame")).toBeLessThan(html.indexOf("How do clocks order events?"));
    expect(html.indexOf("How do clocks order events?")).toBeLessThan(html.indexOf("Node P: local"));
  });

  test("citations are hidden by default; one toggle for the whole diagram, collapsed", () => {
    const html = panel(topic());
    expect(html).not.toContain("citation");
    expect(html).not.toContain("Sources (");
    expect(html).not.toContain("Evidence 1");
    expect(html.match(/diagram-sources-toggle/g)).toHaveLength(1);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Show sources");
  });

  test("with sources shown, each line has one Sources (n) button with its own count (R19 display only)", () => {
    const html = renderToStaticMarkup(createElement(DiagramSummaryView, { topic: topic(), onRequest: noop, onCite: noop, initialSources: true }));
    expect(html).toContain('aria-expanded="true"');
    const items = html.match(/<li>.*?<\/li>/g) ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]).toContain("Sources (1)");
    expect(items[1]).toContain("Sources (2)");
    for (const li of items) expect(li.match(/class="citation"/g)).toHaveLength(1);
    expect(html).not.toContain("Evidence 1");
  });

  test("the preparing state says how long it takes and keeps the frame", () => {
    const html = panel(topic({ summary: { state: "preparing" } }));
    expect(html).toContain("Writing the summary… this usually takes 20–30 seconds.");
    expect(html).toContain("Captured frame");
  });

  test("the diagram's frame and source column are never cropped by CSS", () => {
    const css = readFileSync(new URL("../src/app/review.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.source-stand:has\(\.diagram-panel\)\s*\{[^}]*max-height:\s*none[^}]*overflow:\s*visible/);
    expect(css).toMatch(/\.diagram-panel \.frame[^{]*\{[^}]*max-height:\s*none/);
    expect(panel(topic())).not.toMatch(/max-height|overflow/);
  });

  test("no frame: the summary alone, and it says so", () => {
    const html = panel(topic({ frame: null }));
    expect(html).toContain(NO_FRAME_NOTE);
    expect(html).not.toContain("Loading frame...");
    expect(html).toContain("Node P: local +1, global -1.");
  });

  test("a frame whose video is unknown has no link", () => {
    const html = panel(topic({ frame: { id: FRAME, mediaS: media(5), sourceId: SRC, videoId: null, title: null } }));
    expect(html).toContain("Captured frame · Lecture at 0:05");
    expect(html).not.toContain("youtube.com");
  });

  test("no usable claims: says so, offers no summary", () => {
    const html = panel(topic({ summary: { state: "no_claims" }, frame: null }));
    expect(html).toContain(SUMMARY_NOTE.no_claims);
    expect(html).not.toContain("Write the summary");
    expect(html).not.toContain('class="citation"');
  });

  test("loading: a status line, no lines, no citation buttons", () => {
    const html = panel(topic({ summary: { state: "preparing" } }));
    expect(html).toContain('role="status"');
    expect(html).toContain(SUMMARY_NOTE.preparing);
    expect(html).not.toContain('class="citation"');
  });

  test("not written yet: a button to write it", () => {
    const html = panel(topic({ summary: { state: "not_requested" } }));
    expect(html).toContain(SUMMARY_NOTE.not_requested);
    expect(html).toContain("Write the summary");
  });

  test("Claude failure: the error and a retry button; the frame stays", () => {
    const html = panel(topic({ summary: { state: "failed", error: "claude unavailable" } }));
    expect(html).toContain("The summary could not be written: claude unavailable");
    expect(html).toContain('role="alert"');
    expect(html).toContain(">Retry<");
    expect(html).toContain("Captured frame");
  });

  test("a request error is shown above the frame", () => {
    expect(panel(topic(), { error: "backend down" })).toContain("backend down");
  });
});

describe("show diagram buttons", () => {
  test("one per topic, named by the topic", () => {
    const html = renderToStaticMarkup(createElement(ShowDiagramButton, { topic: { id: T1, label: "Lamport clocks" }, onShow: noop }));
    expect(html).toContain("Show diagram");
    expect(html).toContain('aria-label="Show diagram: Lamport clocks"');
  });
});

describe("view logic", () => {
  test("frameLink opens the lecture at the frame's second", () => {
    expect(frameLink(topic().frame!)).toBe("https://www.youtube.com/watch?v=VIDEO000001&t=125s");
    expect(frameLink({ ...topic().frame!, videoId: null })).toBeNull();
  });

  test("lineSources gives one button per line, opening all its evidence", () => {
    expect(lineSources({ evidence: [E1, E2] }, 3)).toEqual({ ids: [E1, E2], label: "Sources (2)", aria: "Open the 2 sources cited by line 3" });
  });

  test("polling continues only while a summary is being written", () => {
    expect(shouldPollDiagrams(null)).toBe(false);
    expect(shouldPollDiagrams([topic()])).toBe(false);
    expect(shouldPollDiagrams([topic(), topic({ summary: { state: "preparing" } })])).toBe(true);
  });
});

// ───────────────────────────── the current question's topic ─────────────────────────────

let seq = 0;
const tutorQ = (kind: "ask_main" | "quick_check", threadId: ThreadId, claimId: ClaimId, say: string): Turn =>
  ({ id: id<TurnId>("turn", `t${++seq}`), reviewId: REVIEW, seq: seq as never, atMs: seq, actor: "tutor", threadId, move: { kind, threadId, claimIds: [claimId] }, say }) as Turn;
const learner = (act: Extract<Turn, { actor: "learner" }>["act"], threadId: ThreadId | null, tid: TurnId = id<TurnId>("turn", `l${++seq}`)): Turn =>
  ({ id: tid, reviewId: REVIEW, seq: seq as never, atMs: seq, actor: "learner", threadId, act }) as Turn;

const topics = [topic(), topic({ topicId: T2, label: "Locks", claimIds: [C2], frame: null, summary: { state: "not_requested" } }), topic({ topicId: T3, label: "Unasked", claimIds: [C3] })];

describe("the topic of the current question", () => {
  const q1 = tutorQ("ask_main", TH1, C1, "What do clocks give you?");
  const q2 = tutorQ("quick_check", TH2, C2, "Quick: what is a lock?");

  test("the open thread's question decides, even when a later question exists", () => {
    const view = { turns: [q1, q2], state: { openThread: TH1 } } as unknown as Pick<ReviewView, "turns" | "state">;
    expect(currentQuestionTopic(view, topics)?.label).toBe("Lamport clocks");
  });

  test("with no open thread the latest question decides", () => {
    const view = { turns: [q1, q2], state: { openThread: null } } as unknown as Pick<ReviewView, "turns" | "state">;
    expect(currentQuestionTopic(view, topics)?.label).toBe("Locks");
  });

  test("no question yet, or a claim no topic has, is no topic", () => {
    expect(currentQuestionTopic({ turns: [], state: { openThread: null } } as unknown as Pick<ReviewView, "turns" | "state">, topics)).toBeNull();
    const orphan = tutorQ("ask_main", TH1, id<ClaimId>("clm", "gone"), "?");
    expect(currentQuestionTopic({ turns: [orphan], state: { openThread: TH1 } } as unknown as Pick<ReviewView, "turns" | "state">, topics)).toBeNull();
  });
});

// ───────────────────────────── the record's illustrated pages ─────────────────────────────

const A1 = id<TurnId>("turn", "answer-1");
const obs = (threadId: ThreadId, conceptId: ConceptId, claimId: ClaimId, status: Observation["status"], learnerTurns: TurnId[]): Observation => ({
  id: id<ObservationId>("obs", String(threadId)), reviewId: REVIEW, threadId, claimIds: [claimId], conceptIds: [conceptId], proposed: "independent", status, clampedFrom: null,
  dispute: { kind: "none" }, corrections: [],
  facts: { threadId, firstSubstantiveAnswerSeq: null, firstHelpSeq: null, endedBySkip: false, saidDontKnowOnly: false, learnerTurns, helpTurns: [] },
}) as unknown as Observation;

describe("illustrated pages", () => {
  const q1 = tutorQ("ask_main", TH1, C1, "What do clocks give you?");
  const q2 = tutorQ("quick_check", TH2, C2, "Quick: what is a lock?");
  const turns = [q1, learner({ kind: "hint_request" }, TH1), learner({ kind: "answer", text: "An ordering of events.", modality: "text" }, TH1, A1), q2, learner({ kind: "skip" }, TH2)];
  const view = {
    turns,
    observations: [obs(TH1, T1, C1, "partial", [A1, turns[1]!.id]), obs(TH2, T2, C2, "looks_fine", [turns[4]!.id])],
  };

  test("one page per topic that was asked about, in scope order, none for a topic nobody asked about", () => {
    const pages = illustratedPages(view, topics);
    expect(pages.map((p) => p.topic.label)).toEqual(["Lamport clocks", "Locks"]);
  });

  test("a page holds the tutor's question, the learner's answer and the status", () => {
    const [first, second] = illustratedPages(view, topics);
    expect(first!.questions).toEqual([expect.objectContaining({ kind: "Question", question: "What do clocks give you?", answers: ["An ordering of events."], status: "Partial" })]);
    // a skip is shown as a skip; a quick check passed shows "Looks fine (quick check)"
    expect(second!.questions[0]).toMatchObject({ kind: "Quick check", question: "Quick: what is a lock?", answers: ["(skipped this question)"], status: "Looks fine (quick check)" });
  });

  test("rendered: question, frame, summary with citations, answer, status, in that order", () => {
    const html = renderToStaticMarkup(createElement(IllustratedPageView, { api, page: illustratedPages(view, topics)[0]!, onRequest: noop }));
    const at = (s: string) => html.indexOf(s);
    expect(at("What do clocks give you?")).toBeGreaterThan(-1);
    expect(at("Captured frame")).toBeGreaterThan(at("What do clocks give you?"));
    expect(at("Node P: local +1, global -1.")).toBeGreaterThan(at("Captured frame"));
    expect(at("Your answer: ")).toBeGreaterThan(at("Node P: local +1, global -1."));
    expect(at("Status: ")).toBeGreaterThan(at("Your answer: "));
    expect(html).toContain("An ordering of events.");
    expect(html).toContain("Partial");
    expect(html).toContain("Open in YouTube at that moment");
    expect(html).not.toContain('class="citation"');
    expect(html).toContain("Show sources");
  });

  test("rendered quick check passed: Looks fine, never 'understood'; no frame and no summary yet are both said", () => {
    const html = renderToStaticMarkup(createElement(IllustratedPageView, { api, page: illustratedPages(view, topics)[1]!, onRequest: noop }));
    expect(html).toContain("Looks fine (quick check)");
    expect(html).not.toContain("Independent");
    expect(html).toContain(NO_FRAME_NOTE);
    expect(html).toContain("Write the summary");
    expect(html).toContain("(skipped this question)");
  });

  test("an observation whose question is gone yields no page", () => {
    expect(illustratedPages({ turns: [], observations: [obs(TH1, T1, C1, "partial", [])] }, topics)).toEqual([]);
  });

  test("a topic with no usable claims still gets its page, and says so", () => {
    const empty = topics.map((t) => (t.topicId === T1 ? { ...t, summary: { state: "no_claims" } as const, frame: null } : t));
    const html = renderToStaticMarkup(createElement(IllustratedPageView, { api, page: illustratedPages(view, empty)[0]!, onRequest: noop }));
    expect(html).toContain(SUMMARY_NOTE.no_claims);
  });
});
