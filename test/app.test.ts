import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppApi } from "../src/app/api";
import { ApiError } from "../src/app/api";
import { OptionsView, checkAgain } from "../src/app/capture";
import { availableActions, conversationLines, coveredLines, currentEvidenceIds, estimateText, formatClock, groupGaps, inspectBundle, lectureHeading, liveText, noteView, observationRow, optionsScreen, parseRoute, partialLines, reduceLive, routePath, softTargetPrompt, startLive, toAct, unansweredLearnerTurn, usageRows } from "../src/app/core";
import { evidenceBundlez, reviewOptionsz, reviewViewz } from "../src/app/decode";
import { UsageTable } from "../src/app/record";
import { BundleInspector, EvidencePane } from "../src/app/ui";
import type { ScopePreview, TurnEvent, UsageSummary } from "../src/shared/domain";
import { stableId } from "../src/shared/ids";
import { Material, interval } from "../src/shared/time";
import { captureId, claimJson, clm, cpt, crv, ev1, ev2, findElements, learnerAnswer, parsedReview, reviewId, reviewJson, sentence, src, stored, thr, tid, turnJson, tutorAsk } from "./app-fixtures";

// ───────────────────────────── Pure view logic ──────────────────────────────

describe("review options screens", () => {
  const titles = new Map([[src, "Lamport clocks"]]);

  const scopeOf = (over: Partial<ScopePreview> = {}): ScopePreview =>
    ({ chunkRevisions: [crv], supportedClaims: 1, topics: [], material: Material.of([[src, [interval(0, 600)]]]), partial: [], ...over });
  const topic = (label: string) => ({ id: stableId("cpt", label), label, summary: "" });

  test("ready offers one start, names the topics and covered time, and says what each capture gap leaves out", () => {
    const screen = optionsScreen(
      { kind: "ready", scope: scopeOf({ supportedClaims: 5, topics: [topic("Logical clocks"), topic("Happened-before")], partial: [{ kind: "unverified_claims", count: 2 }, { kind: "capture_gap", gap: { sourceId: src, interval: interval(120, 180), channel: "frames", reason: "hidden_tab" } }] }) },
      titles,
    );
    expect(screen).toMatchObject({ kind: "ready", offers: [{ choice: "prepared_only", label: "Start review" }] });
    if (screen.kind !== "ready") throw new Error("unreachable");
    expect(screen.scope.topics).toEqual(["Logical clocks", "Happened-before"]);
    expect(screen.scope.covered).toEqual(["Lamport clocks, 0:00 to 10:00"]);
    expect(screen.scope.limits[0]).toBe("2 claims were not confirmed by the source and will not be used to assess you.");
    expect(screen.scope.limits[1]).toBe("Tab was hidden, so frames stalled in Lamport clocks, 2:00 to 3:00. No frames from this stretch are in the evidence. Its transcript text, if captured, still is.");
  });

  test("covered time names one stretch exactly and sums several", () => {
    expect(coveredLines(Material.of([[src, [interval(0, 60), interval(120, 300)]]]), titles)).toEqual(["Lamport clocks, 2 stretches, 4:00 in all"]);
    expect(coveredLines(Material.empty, titles)).toEqual([]);
  });

  test("a scope with no topic names says so and falls back to its claim count, never calling claims topics", () => {
    const out = html({ kind: "ready", scope: scopeOf({ supportedClaims: 3 }) });
    expect(out).toContain("Topic names are not available for this material. It has 3 claims that passed the evidence check.");
    expect(out).not.toMatch(/3 topics/);
    const named = html({ kind: "ready", scope: scopeOf({ supportedClaims: 3, topics: [topic("Logical clocks")] }) });
    expect(named).toContain("<li>Logical clocks</li>");
    expect(named).not.toContain("claims that passed");
  });

  test("many capture gaps of one kind in one video become one line, in the place the first held", () => {
    const gap = (start: number, end: number, reason: "partially_watched_segment" | "hidden_tab" = "partially_watched_segment", channel: "transcript" | "frames" = "transcript") =>
      ({ kind: "capture_gap", gap: { sourceId: src, interval: interval(start, end), channel, reason } }) as const;
    const screen = optionsScreen(
      { kind: "ready", scope: scopeOf({ partial: [gap(0, 2), { kind: "unverified_claims", count: 1 }, gap(10, 13), gap(20, 25), gap(30, 90, "hidden_tab", "frames")] }) },
      titles,
    );
    if (screen.kind !== "ready") throw new Error("unreachable");
    expect(screen.scope.limits).toEqual([
      "Caption line only partly watched, so not used in Lamport clocks, 3 places, 0:10 in all. No transcript text from this stretch is in the evidence. Any frames saved from it still are.",
      "Tab was hidden, so frames stalled in Lamport clocks, 0:30 to 1:30. No frames from this stretch are in the evidence. Its transcript text, if captured, still is.",
      "1 claim was not confirmed by the source and will not be used to assess you.",
    ]);
    expect(groupGaps([gap(0, 2).gap, gap(5, 6).gap], titles)).toEqual([{ where: "Lamport clocks, 2 places, 0:03 in all", reason: "Caption line only partly watched, so not used", count: 2, channel: "transcript" }]);
  });

  test("a channel failure names only the channel that failed, so a failed transcript never claims the frames are gone", () => {
    const failed = (start: number, end: number, channel: "transcript" | "frames") => ({ sourceId: src, interval: interval(start, end), channel, reason: "channel_failed" }) as const;
    const lines = partialLines([failed(0, 10, "transcript"), failed(20, 30, "frames"), failed(40, 50, "transcript")].map((g) => ({ kind: "capture_gap", gap: g }) as const), titles);
    expect(lines).toEqual([
      "A capture channel failed in Lamport clocks, 2 places, 0:20 in all. No transcript text from this stretch is in the evidence. Any frames saved from it still are.",
      "A capture channel failed in Lamport clocks, 0:20 to 0:30. No frames from this stretch are in the evidence. Its transcript text, if captured, still is.",
    ]);
  });

  test("a lecture heading names the shared course instead of every video title", () => {
    expect(lectureHeading([])).toEqual({ title: "Review", detail: null });
    expect(lectureHeading(["Intro - Georgia Tech - AOS"])).toEqual({ title: "Intro - Georgia Tech - AOS", detail: null });
    expect(lectureHeading(["Intro - Georgia Tech - AOS", "GSM Basics - Georgia Tech - AOS", "Conclusion - Georgia Tech - AOS"])).toEqual({ title: "Georgia Tech - AOS", detail: "3 videos" });
    expect(lectureHeading(["Lamport clocks", "Vector clocks"])).toEqual({ title: "Lamport clocks and 1 more", detail: "2 videos" });
  });

  test("processing shows an estimate only when the backend gave a usable one", () => {
    const processing = (estimateS: number | null) => optionsScreen({ kind: "processing", readyNow: null, pendingChunks: 2, estimateS });
    expect(processing(null)).toMatchObject({ estimate: null });
    expect(processing(0)).toMatchObject({ estimate: null });
    expect(processing(Number.NaN)).toMatchObject({ estimate: null });
    expect(processing(45)).toMatchObject({ estimate: "under a minute" });
    expect(processing(300)).toMatchObject({ estimate: "about 5 min" });
    expect(estimateText(-3)).toBeNull();
  });

  test("processing offers a start only when something is ready, and both ways of starting then", () => {
    const none = optionsScreen({ kind: "processing", readyNow: null, pendingChunks: 1, estimateS: null });
    expect(none.kind === "processing" && none.offers).toEqual([]);
    const some = optionsScreen({ kind: "processing", readyNow: scopeOf({ supportedClaims: 3, partial: [{ kind: "chunks_still_preparing", count: 1 }] }), pendingChunks: 1, estimateS: 120 });
    expect(some.kind === "processing" && some.offers.map((o) => o.choice)).toEqual(["prepared_only", "stop_early"]);
    // The pending section has its own sentence on this screen, so it is not listed again as a limit.
    expect(some.kind === "processing" && some.ready?.limits).toEqual([]);
  });

  test("processing makes starting with ready topics the usual path and puts stopping behind a disclosure that says what it cancels", () => {
    const out = html({ kind: "processing", readyNow: scopeOf({ topics: [topic("Logical clocks")] }), pendingChunks: 2, estimateS: null });
    expect(out).toContain("Some topics are ready");
    expect(out).toContain("2 more sections are still being prepared. They are not in a review you start now.");
    expect(out).toContain("<li>Logical clocks</li>");
    expect(out).toMatch(/class="page-primary"[^>]*>Start with ready topics</);
    expect(out).toContain("The other 2 sections keep preparing for a later review.");
    const more = out.slice(out.indexOf("<details"));
    expect(more).toContain("<summary>Other ways to start</summary>");
    expect(more).toContain(">Stop preparing and start</button>");
    expect(more).toContain("Cancels the preparation still running for 2 sections.");
    expect(out.indexOf("Stop preparing and start")).toBeGreaterThan(out.indexOf("<details"));
    const waiting = html({ kind: "processing", readyNow: null, pendingChunks: 1, estimateS: null });
    expect(waiting).toContain("Preparing your lecture");
    expect(waiting).toContain("1 section is still being prepared.");
    expect(waiting).not.toContain("<button");
  });

  test("nothing to review lists gaps, unverified claims with their status, and a watch link per rewatch interval", () => {
    const options = { kind: "nothing_to_review", gaps: [], unverified: [], rewatch: [{ sourceId: src, interval: interval(120, 180) }] } as const;
    expect(optionsScreen(options, titles, new Map([[src, "QgWz_s7uugE"]]))).toEqual({
      kind: "nothing", gaps: [], unverified: [],
      rewatch: [{ where: "Lamport clocks, 2:00 to 3:00", href: "https://www.youtube.com/watch?v=QgWz_s7uugE&t=120s" }],
    });
    expect(optionsScreen(options, titles)).toMatchObject({ rewatch: [{ where: "Lamport clocks, 2:00 to 3:00", href: null }] });
  });

  const fakeApi = {} as AppApi;
  const view = (o: Parameters<typeof optionsScreen>[0], onRetry: () => void = () => {}, videos = new Map([[src, "QgWz_s7uugE"]])) =>
    createElement(OptionsView, { screen: optionsScreen(o, titles, videos), busy: false, onStart: () => {}, onRetry, api: fakeApi, titles });
  const html = (o: Parameters<typeof optionsScreen>[0]) => renderToStaticMarkup(view(o));
  const nothing = { kind: "nothing_to_review", gaps: [], unverified: [], rewatch: [{ sourceId: src, interval: interval(120, 180) }] } as const;

  test("the rendered screens carry the content", () => {
    expect(html({ kind: "processing", readyNow: null, pendingChunks: 2, estimateS: null })).toContain("No reliable time estimate yet.");
    expect(html({ kind: "processing", readyNow: null, pendingChunks: 2, estimateS: 300 })).toContain("about 5 min");
    expect(html({ kind: "ready", scope: scopeOf({ supportedClaims: 4 }) })).toContain("Start review");
    expect(html({ kind: "nothing_to_review", gaps: [], unverified: [], rewatch: [] })).toContain("Nothing to review yet");
  });

  test("Flow C: nothing to review offers a retry and each rewatch interval as a link that opens the video at that time", () => {
    const out = html(nothing);
    expect(out).toContain('href="https://www.youtube.com/watch?v=QgWz_s7uugE&amp;t=120s"');
    expect(out).toContain("Lamport clocks, 2:00 to 3:00");
    expect(out).toContain("Check again");
    let retried = 0;
    const button = findElements(OptionsView({ screen: optionsScreen(nothing, titles), busy: false, onStart: () => {}, onRetry: () => retried++, api: fakeApi, titles }), (e) => e.type === "button");
    expect(button.map((b) => (b.props as { children?: unknown }).children)).toEqual(["Check again"]);
    (button[0]!.props as { onClick: () => void }).onClick();
    expect(retried).toBe(1);
  });

  test("Check again asks the backend to retry preparation, then reloads the options; a failed retry is reported and still reloads", async () => {
    const order: string[] = [];
    const api = { retryPreparation: async (id: string) => void order.push(`retry ${id}`) } as unknown as AppApi;
    const errors: (string | null)[] = [];
    await checkAgain(api, captureId, { reload: () => order.push("reload"), onError: (m) => errors.push(m) });
    expect(order).toEqual([`retry ${captureId}`, "reload"]);
    expect(errors).toEqual([null]);

    order.length = 0;
    errors.length = 0;
    const failing = { retryPreparation: async () => { throw new ApiError("backend down", 503); } } as unknown as AppApi;
    await checkAgain(failing, captureId, { reload: () => order.push("reload"), onError: (m) => errors.push(m) });
    expect(order).toEqual(["reload"]);
    expect(errors).toEqual([null, "backend down"]);
  });

  test("an unverified claim shows the evidence it cited, in the evidence pane", () => {
    const o = reviewOptionsz.parse({ kind: "nothing_to_review", gaps: [], unverified: [claimJson("unverified")], rewatch: [] });
    const panes = findElements(OptionsView({ screen: optionsScreen(o, titles), busy: false, onStart: () => {}, onRetry: () => {}, api: fakeApi, titles }), (e) => e.type === EvidencePane);
    expect(panes.map((p) => (p.props as { ids: unknown }).ids)).toEqual([[ev1]]);
    expect(renderToStaticMarkup(view(o))).toContain("Loading evidence...");
  });
});

describe("conversation", () => {
  test("lines label who spoke and what the tutor was doing", () => {
    const turns = reviewViewz.parse(reviewJson({ turns: [tutorAsk, learnerAnswer(), turnJson(3, "code", { notice: { kind: "soft_target_reached", elapsedS: 620 } })] })).turns;
    expect(conversationLines(turns).map((l) => [l.speaker, l.label, l.text])).toEqual([
      ["tutor", "Question", "What does a logical clock give you?"],
      ["you", "You", "An ordering of events."],
      ["system", "Note", "You have been reviewing for 10 min."],
    ]);
  });

  test("a correction applied silently is in the log but not in the conversation (#137)", () => {
    const applied = turnJson(1, "code", { notice: { kind: "correction_applied", correctionId: "corr_x", affectedClaims: [stableId("clm", 1)] } });
    const turns = reviewViewz.parse(reviewJson({ turns: [applied, tutorAsk] })).turns;
    expect(turns[0]).toMatchObject({ actor: "code", notice: { kind: "correction_applied" } });
    expect(conversationLines(turns).map((l) => l.label)).toEqual(["Question"]);
  });

  test("the soft-target prompt stands until the learner continues or wraps up, and never blocks answering", () => {
    const notice = turnJson(3, "code", { notice: { kind: "soft_target_reached", elapsedS: 600 } });
    const prompted = parsedReview({ turns: [tutorAsk, notice] });
    expect(softTargetPrompt(prompted.turns)).toEqual({ elapsedS: 600 });
    expect(availableActions(prompted.state, true)).toEqual(expect.arrayContaining(["continue", "wrap_up", "answer", "skip"]));
    const answered = parsedReview({ turns: [tutorAsk, notice, turnJson(4, "learner", { act: { kind: "continue_past_target" } })] });
    expect(softTargetPrompt(answered.turns)).toBeNull();
    expect(softTargetPrompt([])).toBeNull();
  });

  test("a stored learner turn the tutor never answered can be resent; pause and end do not count", () => {
    expect(unansweredLearnerTurn(parsedReview({ turns: [tutorAsk, learnerAnswer()] }).turns)?.id).toBe(stableId("turn", "l2"));
    expect(unansweredLearnerTurn(parsedReview({ turns: [tutorAsk, learnerAnswer(), turnJson(3, "tutor", { move: { kind: "close_thread", threadId: thr }, say: "Thanks." })] }).turns)).toBeNull();
    expect(unansweredLearnerTurn(parsedReview({ turns: [tutorAsk, turnJson(2, "learner", { act: { kind: "pause" } })] }).turns)).toBeNull();
  });

  test("which actions are offered follows the phase and the detour (R11: a detour waits for yes)", () => {
    const state = (o: Parameters<typeof reviewJson>[0]) => parsedReview(o).state;
    expect(availableActions(state({}), false)).toEqual(["answer", "skip", "dont_know", "hint", "explain", "dispute", "pause", "end"]);
    expect(availableActions(state({ phase: "paused" }), false)).toEqual(["resume", "end"]);
    expect(availableActions(state({ phase: "ended" }), false)).toEqual([]);
    const proposed = availableActions(state({ detour: { kind: "proposed", turnId: tid("d"), topic: "Partial orders", needsResource: null } }), false);
    expect(proposed).toEqual(["detour_accept", "detour_decline", "pause", "end"]);
    const waiting = availableActions(state({ detour: { kind: "awaiting_resource", resourceId: stableId("res", "r"), topic: "x" } }), false);
    expect(waiting).toEqual(["detour_wait", "detour_continue", "pause", "end"]);
  });

  test("toAct maps each button to the act the backend expects", () => {
    expect(toAct("answer", "x", "speech")).toEqual({ kind: "answer", text: "x", modality: "speech" });
    expect(toAct("hint", "", "text")).toEqual({ kind: "hint_request" });
    expect(toAct("explain", "", "text")).toEqual({ kind: "explain_request" });
    expect(toAct("detour_continue", "", "text")).toEqual({ kind: "detour_continue_without_resource" });
    expect(toAct("dispute", "that is wrong", "text")).toEqual({ kind: "dispute", text: "that is wrong" });
  });

  test("live text follows deltas, falls back to sentences for a replayed turn, and records failure", () => {
    let live = startLive("t");
    for (const e of [stored("t"), { type: "say_delta", text: "Hel" } as TurnEvent, { type: "say_delta", text: "lo." } as TurnEvent, sentence("Hello."), { type: "move", turnId: tid("t"), move: { kind: "wrap_up" } } as TurnEvent]) live = reduceLive(live, e);
    expect(live).toMatchObject({ stored: true, move: { kind: "wrap_up" }, status: "streaming" });
    expect(liveText(live)).toBe("Hello.");
    const replay = reduceLive(reduceLive(startLive("t"), sentence("One.")), sentence("Two."));
    expect(liveText(replay)).toBe("One. Two.");
    expect(reduceLive(live, { type: "turn_failed", error: "boom", retryable: true })).toMatchObject({ status: "failed", error: "boom", retryable: true });
  });

  test("evidence beside the conversation follows the tutor's move, and a main question shows none", () => {
    const explain = turnJson(3, "tutor", { move: { kind: "explain", threadId: thr, evidence: [ev1, ev2] }, say: "Here is why." });
    expect(currentEvidenceIds(parsedReview({ turns: [tutorAsk, learnerAnswer(), explain] }).turns, null)).toEqual([ev1, ev2]);
    expect(currentEvidenceIds(parsedReview({ turns: [explain, learnerAnswer(4), turnJson(5, "tutor", { move: { kind: "ask_main", threadId: thr, claimIds: [clm] }, say: "Next." })] }).turns, null)).toEqual([]);
    const live = reduceLive(startLive("t"), { type: "move", turnId: tid("t"), move: { kind: "diagnose", threadId: thr, hypothesis: "h", evidence: [ev2] } });
    expect(currentEvidenceIds([], live)).toEqual([ev2]);
  });
});

describe("record view logic", () => {
  const observation = ({ facts, ...o }: Record<string, unknown>) => parsedReview({
    observations: [{
      id: stableId("obs", "o"), reviewId, threadId: thr, claimIds: [clm], conceptIds: [cpt], proposed: "independent", status: "independent",
      clampedFrom: null, dispute: { kind: "none" }, corrections: [],
      facts: { threadId: thr, firstSubstantiveAnswerSeq: null, firstHelpSeq: null, endedBySkip: false, saidDontKnowOnly: false, learnerTurns: [], helpTurns: [], ...(facts as object | undefined) },
      ...o,
    }],
  }).observations[0]!;

  test("a status the clamp lowered explains why in the learner's terms", () => {
    const afterHelp = observationRow(observation({ status: "after_help", clampedFrom: "independent", facts: { firstHelpSeq: 3, firstSubstantiveAnswerSeq: 5 } }));
    expect(afterHelp).toMatchObject({ status: "After help", note: 'The tutor proposed "Independent"; recorded as "After help" because the tutor helped before your answer.' });
    const skipped = observationRow(observation({ status: "not_assessed", clampedFrom: "partial", facts: { endedBySkip: true } }));
    expect(skipped.note).toContain("the question was skipped or left unanswered");
  });

  test("R14: a disputed observation reads as disputed and offers resolution, not as a gap", () => {
    const row = observationRow(observation({ status: "disputed", dispute: { kind: "unsettled" } }));
    expect(row).toMatchObject({ status: "Disputed", disputeOpen: true });
    expect(row.note).toContain("not counted as a learning gap");
    const resolved = observationRow(observation({ status: "unresolved", dispute: { kind: "resolved_by_learner", outcome: "it_was_my_gap" } }));
    expect(resolved).toMatchObject({ disputeOpen: false, note: "You chose to revisit this topic, so it counts as a learning gap." });
    const supported = observationRow(observation({ status: "partial", dispute: { kind: "resolved_by_learner", outcome: "learner_was_right" } }));
    expect(supported.note).toBe("You marked your explanation as supported, so this is not counted as a learning gap.");
  });

  test("a note keeps learner, tutor and source text apart, and your edit never replaces the generated text", () => {
    const view = noteView({
      id: stableId("note", "n"), reviewId, conceptId: cpt, userEdit: "my wording", evidence: [ev1],
      generated: [
        { author: "learner", text: "I said ordering.", turnId: tid("l2"), evidence: [] },
        { author: "tutor", text: "You were right.", turnId: tid("t3"), evidence: [] },
        { author: "source", text: "Lamport 1978.", turnId: null, evidence: [ev1] },
      ],
    });
    expect(view.segments.map((s) => [s.label, s.text])).toEqual([["You", "I said ordering."], ["Tutor", "You were right."], ["Lecture", "Lamport 1978."]]);
    expect(view.userEdit).toBe("my wording");
  });
});

describe("evidence inspector", () => {
  const bundle = evidenceBundlez.parse({
    material: [[src, [[0, 120], [300, 420]]]],
    passages: [{ kind: "passage", id: ev1, sourceId: src, transcriptRevId: stableId("trv", "t"), interval: { start: 0, end: 60 }, text: "a", origin: "panel" }],
    frames: [
      { kind: "frame", id: ev2, sourceId: src, mediaS: 12, width: 1280, height: 720, teaching: "kept" },
      { kind: "frame", id: stableId("ev", "f2"), sourceId: src, mediaS: 40, width: 1280, height: 720, teaching: "uncertain" },
    ],
    gaps: [{ sourceId: src, interval: { start: 60, end: 120 }, channel: "transcript", reason: "no_transcript" }],
    ads: [{ sourceId: src, atContentS: 200, wallDurationMs: 30000, signals: ["dom_class"] }],
  });
  const titles = new Map([[src, "Lecture 1"]]);

  test("reports watched intervals, evidence counts, gaps and ads", () => {
    const report = inspectBundle(bundle, titles);
    expect(report.watched).toEqual([{ source: "Lecture 1", intervals: ["0:00 to 2:00", "5:00 to 7:00"], seconds: 240 }]);
    expect(report.passages).toBe(1);
    expect(report.frames).toEqual({ total: 2, kept: 1, uncertain: 1 });
    expect(report.gaps).toEqual([{ where: "Lecture 1, 1:00 to 2:00", channel: "transcript", reason: "No captions for this stretch" }]);
    expect(report.ads).toEqual([{ where: "Lecture 1, at 3:20", seconds: 30 }]);
  });

  test("flags watched time that has neither a passage nor a logged gap (capture-probe bar)", () => {
    const report = inspectBundle(bundle, titles);
    expect(report.uncovered).toEqual([{ source: "Lecture 1", interval: "5:00 to 7:00" }]);
    const html = renderToStaticMarkup(createElement(BundleInspector, { report }));
    expect(html).toContain("5:00 to 7:00");
    expect(html).toContain("neither evidence nor a logged gap");
  });
});

describe("usage view", () => {
  const summary = (byKind: Partial<UsageSummary["byKind"]>): UsageSummary => ({
    byKind: { measured: { calls: 0, usd: null }, notional: { calls: 0, usd: null }, estimated: { calls: 0, usd: null }, unknown: { calls: 0, usd: null }, ...byKind },
    byPurpose: {
      boundary: { calls: 3, errors: 1, unknownCost: 3 }, frame_change: { calls: 0, errors: 0, unknownCost: 0 }, claim_check: { calls: 0, errors: 0, unknownCost: 0 },
      interpretation: { calls: 0, errors: 0, unknownCost: 0 }, claim_revision: { calls: 0, errors: 0, unknownCost: 0 }, resource_search: { calls: 0, errors: 0, unknownCost: 0 },
      tutor_turn: { calls: 0, errors: 0, unknownCost: 0 }, wrap_up: { calls: 0, errors: 0, unknownCost: 0 }, diagram_summary: { calls: 0, errors: 0, unknownCost: 0 },
    },
  });

  test("R17: unknown cost shows as unknown, never $0, and kinds are not summed", () => {
    const rows = usageRows(summary({ unknown: { calls: 12, usd: null }, notional: { calls: 2, usd: 0.4321 } }));
    expect(rows).toEqual([
      { kind: "Measured", calls: 0, amount: "none" },
      { kind: "Notional (subscription)", calls: 2, amount: "$0.4321" },
      { kind: "Estimated", calls: 0, amount: "none" },
      { kind: "Unknown", calls: 12, amount: "unknown" },
    ]);
    const html = renderToStaticMarkup(createElement(UsageTable, { summary: summary({ unknown: { calls: 12, usd: null } }) }));
    expect(html).toContain("<td>unknown</td>");
    expect(html).not.toContain("$0");
  });

  test("a small non-zero amount never reads as $0.0000", () => {
    expect(usageRows(summary({ measured: { calls: 1, usd: 0.00002 } }))[0]!.amount).toBe("<$0.0001");
    expect(usageRows(summary({ measured: { calls: 1, usd: 0.0001 } }))[0]!.amount).toBe("$0.0001");
    expect(usageRows(summary({ measured: { calls: 1, usd: 0 } }))[0]!.amount).toBe("$0.0000");
  });

  test("a measured kind that arrives without an amount reads unknown, not zero", () => {
    expect(usageRows(summary({ measured: { calls: 1, usd: null } }))[0]!.amount).toBe("unknown");
    expect(usageRows(summary({ measured: { calls: 1, usd: 12.5 } }))[0]!.amount).toBe("$12.50");
  });
});

describe("routes and clocks", () => {
  test("paths round-trip, with and without the /app prefix", () => {
    expect(parseRoute("/app/review/rvw_x")).toEqual({ page: "review", id: "rvw_x" });
    expect(parseRoute("/app/capture/cap_x")).toEqual({ page: "capture", id: "cap_x" });
    expect(parseRoute("/app/record")).toEqual({ page: "record", reviewId: null });
    expect(parseRoute("/app/record/rvw_x")).toEqual({ page: "record", reviewId: "rvw_x" });
    expect(parseRoute("/app/usage")).toEqual({ page: "usage" });
    expect(parseRoute("/app/")).toEqual({ page: "home" });
    expect(parseRoute("/")).toEqual({ page: "home" });
    expect(parseRoute("/app/review")).toEqual({ page: "home" });
    for (const r of [{ page: "review", id: "rvw_x" }, { page: "record", reviewId: null }, { page: "usage" }] as const) expect(parseRoute(routePath(r))).toEqual(r);
  });

  test("malformed percent-encoding routes to not-found instead of throwing", () => {
    expect(parseRoute("/app/review/%E0%A4%A")).toEqual({ page: "not_found" });
    expect(parseRoute("/app/capture/%")).toEqual({ page: "not_found" });
    expect(routePath({ page: "not_found" })).toBe("/app/");
  });

  test("formatClock", () => {
    expect([formatClock(0), formatClock(75), formatClock(3725), formatClock(-4)]).toEqual(["0:00", "1:15", "1:02:05", "0:00"]);
  });
});
