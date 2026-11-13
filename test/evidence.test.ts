import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createEvidence } from "../src/backend/evidence";
import { FRAME_STALL_S, clipToWatched, sourceIdOf, spanPlausible } from "../src/backend/evidence/core";
import { FRAME_DEFAULTS } from "../src/extension/content/frames";
import type { CaptureFact } from "../src/shared/domain";
import { randomId, stableId } from "../src/shared/ids";
import { Material, interval, media } from "../src/shared/time";
import { JPEG, OTHER, SRC, VIDEO, exceptStalls, harness, keyOf, stream, textsOf } from "./evidence-fixtures";

describe("R1: evidence only from intervals watched while capture was on", () => {
  test("a passage exists only for a segment wholly inside watched time; a partly watched one is a gap", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.source();
    s.transcript([[2, 4, "inside"], [8, 12, "straddles the end of a span"], [14, 16, "never watched"], [22, 25, "inside second span"]]);
    s.span(0, 10);
    s.span(20, 30);
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });

    const order = h.evidence.watchOrder(s.captureId);
    expect(textsOf(order.passages.map((w) => w.passage))).toEqual(["inside", "inside second span"]);
    const bundle = h.evidence.captureBundle(s.captureId);
    expect(bundle.gaps).toContainEqual({ sourceId: SRC, start: 8, end: 12, channel: "transcript", reason: "partially_watched_segment" });
    expect(bundle.gaps.filter((g) => g.reason === "partially_watched_segment")).toHaveLength(1);
  });

  test("a segment covered only by two adjacent spans together is a passage", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.transcript([[8, 12, "joined"]]);
    s.span(0, 10);
    s.span(10, 20);
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    expect(textsOf(h.evidence.watchOrder(s.captureId).passages.map((w) => w.passage))).toEqual(["joined"]);
  });

  test("clipToWatched is strict and never yields a passage from a partial overlap", () => {
    const watched = Material.of([[SRC, [interval(0, 10)]]]);
    const rev = stableId("trv", "x");
    const { passages, partial } = clipToWatched(
      SRC, rev, "panel",
      [
        { start: media(0), end: media(10), text: "exact" },
        { start: media(9.5), end: media(10.5), text: "edge" },
        { start: media(11), end: media(12), text: "outside" },
      ],
      watched,
    );
    expect(textsOf(passages)).toEqual(["exact"]);
    expect(partial.map((g) => [Number(g.interval.start), Number(g.interval.end), g.reason])).toEqual([[9.5, 10.5, "partially_watched_segment"]]);
  });

  test("spans outside an active control period add no material, and are reported rather than dropped", () => {
    const h = harness();
    const s = stream();
    s.span(0, 5); // before start
    s.control("start");
    s.span(10, 15);
    s.control("pause", "left_watch_page");
    s.span(20, 25); // while paused
    s.control("resume");
    s.span(30, 35);
    s.control("stop");
    s.span(40, 45); // after stop
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });

    const watched = h.evidence.watchedMaterial(s.captureId);
    expect(Material.canonical(watched)).toEqual([[SRC, [[10, 15], [30, 35]]]]);
    const paused = h.evidence.captureBundle(s.captureId).gaps.filter((g) => g.reason === "capture_paused");
    expect(paused.map((g) => g.start)).toEqual([0, 20, 40]);
  });

  test("reordered delivery folds by clientSeq, not arrival order", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.control("pause");
    s.control("resume");
    s.span(0, 10);
    const [start, pause, resume, span] = s.facts;
    h.evidence.ingest({ captureId: s.captureId, facts: [span!, resume!] });
    h.evidence.ingest({ captureId: s.captureId, facts: [pause!, start!] });
    expect(Material.canonical(h.evidence.watchedMaterial(s.captureId))).toEqual([[SRC, [[0, 10]]]]);
  });

  test("a frame is evidence only where the viewer watched with the tab visible", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.span(0, 10);
    s.span(20, 30, { visible: false });
    s.frame("f-in", 5);
    s.frame("f-out", 15);
    s.frame("f-hidden", 25);
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    const frames = h.evidence.watchOrder(s.captureId).frameCandidates;
    expect(frames.map((f) => Number(f.mediaS))).toEqual([5]);
    expect(h.evidence.frameBytes(stableId("ev", s.captureId, "f-out"))).not.toBeNull(); // stored, but not evidence
    expect(h.evidence.get([stableId("ev", s.captureId, "f-out")]).size).toBe(0);
  });

  test("watch order follows what was watched first, not media order, across sources", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.source();
    s.source({ video: OTHER });
    s.transcript([[0, 4, "a-early"], [50, 54, "a-late"]]);
    s.transcript([[0, 4, "b-early"]], { video: OTHER });
    s.span(50, 60);
    s.span(0, 10, { video: OTHER });
    s.span(0, 10);
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    const order = h.evidence.watchOrder(s.captureId);
    expect(textsOf(order.passages.map((w) => w.passage))).toEqual(["a-late", "b-early", "a-early"]);
    expect(order.passages.map((w) => w.sourceIndex)).toEqual([0, 1, 0]);
    const seqs = order.passages.map((w) => w.firstWatchedAtSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});

describe("R2: ad time never becomes evidence", () => {
  test("ad facts add no material, no passage and no gap, and are listed as ads", () => {
    const withAd = stream();
    const without = stream();
    for (const s of [withAd, without]) {
      s.control("start");
      s.source();
      s.transcript([[0, 4, "before"], [40, 44, "after"], [28, 32, "spans the ad point"]]);
      s.span(0, 30);
      if (s === withAd) s.ad(30, 20_000);
      s.span(30, 60);
    }
    const a = harness();
    const b = harness();
    a.evidence.ingest({ captureId: withAd.captureId, facts: withAd.facts });
    b.evidence.ingest({ captureId: without.captureId, facts: without.facts });

    const bundleA = a.evidence.captureBundle(withAd.captureId);
    const bundleB = b.evidence.captureBundle(without.captureId);
    expect(bundleA.watched).toEqual(bundleB.watched);
    expect(bundleA.passages.map((p) => p.text)).toEqual(bundleB.passages.map((p) => p.text));
    expect(exceptStalls(bundleA.gaps)).toEqual([]);
    expect(bundleA.ads).toEqual([{ sourceId: SRC, atContentS: 30, wallDurationMs: 20_000, signals: ["dom_class"] }]);
    expect(a.evidence.bundle(a.evidence.watchedMaterial(withAd.captureId)).ads).toHaveLength(1);
  });

  test("a span the extension should not have emitted (past the duration, or faster than wall time) adds no material", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.source({ durationS: 100 });
    s.transcript([[2, 4, "real"], [200, 204, "ad media"], [60, 64, "too fast"]]);
    s.span(0, 10);
    s.span(190, 220); // beyond a 100 s video: ad media or the wrong video
    s.span(50, 80, { wallMs: 2000 }); // 30 s of media in 2 s of wall time at 1x
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });

    expect(Material.canonical(h.evidence.watchedMaterial(s.captureId))).toEqual([[SRC, [[0, 10]]]]);
    const bundle = h.evidence.captureBundle(s.captureId);
    expect(bundle.passages.map((p) => p.text)).toEqual(["real"]);
    expect(bundle.gaps.filter((g) => g.reason === "implausible_span").map((g) => [g.start, g.end, g.channel])).toEqual([
      [50, 80, "playback"],
      [190, 220, "playback"],
    ]);
  });

  test("span plausibility boundaries", () => {
    const span = (start: number, end: number, rate: number, wallDurationMs: number) =>
      ({ captureId: randomId("cap"), clientSeq: 0, wallMs: 0, kind: "span", videoId: VIDEO, start: media(start), end: media(end), rate, tabVisible: true, wallDurationMs }) as Extract<CaptureFact, { kind: "span" }>;
    expect(spanPlausible(span(0, 20, 2, 10_000), 100)).toBe(true); // 2x speed
    expect(spanPlausible(span(0, 30, 2, 10_000), 100)).toBe(false); // 3x on a 2x player
    expect(spanPlausible(span(90, 101, 1, 11_000), 100)).toBe(true); // within the +1 s slack
    expect(spanPlausible(span(90, 102, 1, 12_000), 100)).toBe(false);
    expect(spanPlausible(span(0, 5, 1, 0), null)).toBe(false);
    expect(spanPlausible(span(0, 1, 1, 0), null)).toBe(true); // 1.5 s startup slack
  });
});

describe("gaps", () => {
  test("no transcript, declined transcript, hidden tab, frame stall and channel failure are each logged", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.source();
    s.push({ kind: "transcript_unavailable", videoId: VIDEO, reason: "no_captions" });
    s.span(0, 100);
    s.frame("f1", 1);
    s.frame("f2", 50); // 49 s since f1 ⇒ stall; 50 s to the span end ⇒ stall
    s.span(100, 110, { visible: false });
    s.push({ kind: "channel", channel: "frames", health: "failed", videoId: VIDEO, atMediaS: media(115), detail: "capture threw" });
    s.span(115, 125);
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });

    const gaps = h.evidence.captureBundle(s.captureId).gaps;
    const has = (reason: string, start: number, end: number, channel?: string) =>
      gaps.some((g) => g.reason === reason && g.start === start && g.end === end && (channel === undefined || g.channel === channel));
    expect(has("no_transcript", 0, 110, "transcript")).toBe(true);
    expect(has("no_transcript", 115, 125)).toBe(true);
    expect(has("hidden_tab", 100, 110, "frames")).toBe(true);
    expect(has("frame_stall", 1, 50, "frames")).toBe(true);
    expect(has("frame_stall", 50, 100, "frames")).toBe(true);
    expect(has("channel_failed", 115, 125, "frames")).toBe(true);
  });

  test("a slide held between saved frames is quiet, not a frame stall", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.source();
    s.span(0, 130);
    // The extension's cadence for an unchanging slide: a keyframe every ~31 s, then one change that took the full settle wait.
    for (const [id, t] of [["k0", 0], ["k1", 31], ["k2", 62], ["k3", 93], ["c1", 129]] as const) s.frame(id, t);
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    expect(h.evidence.captureBundle(s.captureId).gaps.filter((g) => g.reason === "frame_stall")).toEqual([]);
  });

  test("the stall bar is a keyframe period plus the settle wait and two samples, and a longer silence is a stall", () => {
    const f = FRAME_DEFAULTS;
    expect(FRAME_STALL_S).toBe(f.keyframeEveryMediaS + f.maxSettleWaitMediaS + 2 * f.sampleEveryMediaS);
    const h = harness();
    const s = stream();
    s.control("start");
    s.source();
    s.span(0, 100);
    s.frame("a", 0);
    s.frame("b", 36); // exactly the bar: not a stall
    s.frame("c", 73); // 37 s: a stall
    s.frame("d", 100);
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    expect(h.evidence.captureBundle(s.captureId).gaps.filter((g) => g.reason === "frame_stall").map((g) => [g.start, g.end])).toEqual([[36, 73]]);
  });

  test("declining transcription is a transcript_declined gap; accepting ASR is not a gap while it runs", () => {
    const declined = harness();
    const a = stream();
    a.control("start");
    a.push({ kind: "transcript_unavailable", videoId: VIDEO, reason: "unusable" });
    a.push({ kind: "transcription_choice", videoId: VIDEO, choice: "continue_with_gap" });
    a.span(0, 10);
    declined.evidence.ingest({ captureId: a.captureId, facts: a.facts });
    expect(declined.evidence.captureBundle(a.captureId).gaps.map((g) => g.reason)).toContain("transcript_declined");
    expect(declined.evidence.captureView(a.captureId).transcript).toBe("gap_accepted");

    const asr = harness();
    const b = stream();
    b.control("start");
    b.push({ kind: "transcript_unavailable", videoId: VIDEO, reason: "unusable" });
    b.push({ kind: "transcription_choice", videoId: VIDEO, choice: "accept_asr" });
    b.span(0, 10);
    asr.evidence.ingest({ captureId: b.captureId, facts: b.facts });
    expect(asr.evidence.captureBundle(b.captureId).gaps.filter((g) => g.channel === "transcript")).toEqual([]);
    expect(asr.evidence.captureView(b.captureId).transcript).toBe("asr_running");
  });

  test("a hidden-tab interval that was also watched visibly is not a gap", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.span(0, 10, { visible: false });
    s.span(0, 10);
    s.frame("f", 5);
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    expect(h.evidence.captureBundle(s.captureId).gaps.filter((g) => g.reason === "hidden_tab")).toEqual([]);
  });
});

describe("ingest is idempotent on (captureId, clientSeq)", () => {
  function rows(h: ReturnType<typeof harness>) {
    const count = (t: string) => h.db.sql.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${t}`).get()!.n;
    return { facts: count("capture_facts"), frames: count("frames") };
  }

  test("resending a batch changes no row, no view, and no frame file", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.source();
    s.transcript([[0, 4, "hello"]]);
    s.span(0, 10);
    s.frame("f1", 5);
    const batch = { captureId: s.captureId, facts: s.facts };

    expect(h.evidence.ingest(batch)).toEqual({ ackedThroughSeq: 4 });
    const before = { rows: rows(h), bundle: h.evidence.captureBundle(s.captureId), view: h.evidence.captureView(s.captureId), seq: h.db.nextSeq() };
    const files = readdirSync(join(h.dir, "frames"), { recursive: true });
    const changesBefore = h.changes.n;

    expect(h.evidence.ingest(batch)).toEqual({ ackedThroughSeq: 4 });
    expect(h.evidence.ingest({ captureId: s.captureId, facts: [s.facts[2]!, s.facts[4]!] })).toEqual({ ackedThroughSeq: 4 });
    expect(rows(h)).toEqual(before.rows);
    expect(h.evidence.captureBundle(s.captureId)).toEqual(before.bundle);
    expect(h.evidence.captureView(s.captureId)).toEqual(before.view);
    expect(readdirSync(join(h.dir, "frames"), { recursive: true })).toEqual(files);
    expect(h.changes.n).toBe(changesBefore);
    expect(h.db.nextSeq()).toBe((before.seq + 1) as typeof before.seq); // a resend burns no Seq
  });

  test("the ack is the highest contiguous clientSeq from 0, so a missing batch is asked for again", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    for (let i = 0; i < 5; i++) s.span(i * 10, i * 10 + 5);
    expect(h.evidence.ingest({ captureId: s.captureId, facts: s.facts.slice(3) })).toEqual({ ackedThroughSeq: -1 });
    expect(h.evidence.ingest({ captureId: s.captureId, facts: s.facts.slice(0, 2) })).toEqual({ ackedThroughSeq: 1 });
    expect(h.evidence.ingest({ captureId: s.captureId, facts: s.facts.slice(2, 3) })).toEqual({ ackedThroughSeq: 5 });
  });

  test("a batch holding another capture's fact is refused whole", () => {
    const h = harness();
    const a = stream();
    const b = stream();
    a.control("start");
    b.control("start");
    expect(() => h.evidence.ingest({ captureId: a.captureId, facts: [a.facts[0]!, b.facts[0]!] })).toThrow(RangeError);
    expect(rows(h)).toEqual({ facts: 0, frames: 0 });
  });

  test("frame bytes land on disk via temp+rename and read back; a non-JPEG is stored as a fact but never as a frame", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.span(0, 10);
    s.frame("good", 5);
    s.frame("bad", 6, { jpeg: Buffer.from("not a jpeg").toString("base64") });
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });

    const id = stableId("ev", s.captureId, "good");
    expect([...h.evidence.frameBytes(id)!]).toEqual([...Buffer.from(JPEG, "base64")]);
    expect(h.evidence.frameBytes(stableId("ev", s.captureId, "bad"))).toBeNull();
    const leftovers = (readdirSync(h.dir, { recursive: true }) as string[]).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
    expect(rows(h)).toEqual({ facts: 4, frames: 1 });
    expect(h.db.sql.query<{ body_json: string }, []>("SELECT body_json FROM capture_facts WHERE kind = 'frame'").all().every((r) => !r.body_json.includes(JPEG))).toBe(true);
  });

  test("a frame id that cannot escape the frames directory, whatever the extension sends", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.span(0, 10);
    s.frame("../../escape", 5);
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    expect(existsSync(join(h.dir, "escape.jpg"))).toBe(false);
    expect(h.evidence.frameBytes(stableId("ev", s.captureId, "../../escape"))).not.toBeNull();
  });

  test("state rebuilds from the facts: a new store over the same db and dir answers the same", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.source();
    s.transcript([[0, 4, "hello"]]);
    s.span(0, 10);
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    const reopened = createEvidence(h.db, h.dir, {
      lookupFrameChange: () => ({ kind: "missing", key: stableId("key", "x") }), runFrameChange: async () => undefined, frameChangeKey: keyOf, onChange: () => {},
    });
    expect(reopened.captureBundle(s.captureId)).toEqual(h.evidence.captureBundle(s.captureId));
  });
});

describe("capture view", () => {
  test("status follows control facts; activeCaptures lists only captures not stopped", () => {
    const h = harness();
    const live = stream();
    const done = stream();
    live.control("start");
    live.source();
    live.control("pause", "left_watch_page");
    done.control("start");
    done.control("stop");
    h.evidence.ingest({ captureId: live.captureId, facts: live.facts });
    h.evidence.ingest({ captureId: done.captureId, facts: done.facts });

    expect(h.evidence.captureView(live.captureId).status).toEqual({ state: "paused", reason: "left_watch_page" });
    expect(h.evidence.captureView(done.captureId).status).toEqual({ state: "stopped" });
    expect(h.evidence.activeCaptures()).toEqual([live.captureId]);
    expect(h.evidence.watchOrder(done.captureId).stoppedAtSeq).not.toBeNull();
    expect(h.evidence.watchOrder(live.captureId).stoppedAtSeq).toBeNull();

    live.control("resume");
    h.evidence.ingest({ captureId: live.captureId, facts: live.facts });
    expect(h.evidence.captureView(live.captureId).status).toEqual({ state: "capturing" });
  });

  test("sources, current source, channel health and watched seconds", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.source();
    s.span(0, 30);
    s.span(20, 40);
    s.source({ video: OTHER, durationS: null });
    s.span(0, 5, { video: OTHER });
    s.push({ kind: "channel", channel: "frames", health: "stalled", videoId: OTHER, atMediaS: media(2), detail: "no frames for 12 s" });
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    const view = h.evidence.captureView(s.captureId);
    expect(view.sources.map((x) => x.videoId)).toEqual([VIDEO, OTHER]);
    expect(view.currentSourceId).toBe(sourceIdOf(OTHER));
    expect(view.watchedSeconds).toBe(45);
    expect(view.health).toEqual([
      { channel: "transcript", health: "unknown", detail: "" },
      { channel: "frames", health: "stalled", detail: "no frames for 12 s" },
      { channel: "playback", health: "unknown", detail: "" },
    ]);
  });

  test("an unknown capture is stopped and empty", () => {
    const h = harness();
    const view = h.evidence.captureView(randomId("cap"));
    expect(view.status).toEqual({ state: "stopped" });
    expect(view.watchedSeconds).toBe(0);
  });
});

describe("a bundle describes only time inside its material", () => {
  const hiddenGaps = (b: { readonly gaps: readonly { readonly reason: string; readonly interval: { readonly start: number; readonly end: number } }[] }) =>
    b.gaps.filter((g) => g.reason === "hidden_tab").map((g) => [g.interval.start, g.interval.end]);

  test("gaps are clipped to the material, and a fragmented material clips each piece", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.source();
    s.span(0, 100, { visible: false });
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    expect(hiddenGaps(h.evidence.bundle(Material.of([[SRC, [interval(0, 5)]]])))).toEqual([[0, 5]]);
    expect(hiddenGaps(h.evidence.bundle(Material.of([[SRC, [interval(2, 4), interval(50, 60)]]])))).toEqual([[2, 4], [50, 60]]);
  });

  test("a gap that only touches the material's edge is not in the bundle", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.source();
    s.span(0, 10, { visible: false });
    s.span(10, 20);
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    expect(hiddenGaps(h.evidence.bundle(Material.of([[SRC, [interval(10, 20)]]])))).toEqual([]);
  });
});

describe("a channel failure is recorded whatever order its fact arrives in", () => {
  const failed = (s: ReturnType<typeof stream>, atMediaS: number | null, channel: "transcript" | "frames" = "transcript") =>
    s.push({ kind: "channel", channel, health: "failed", videoId: VIDEO, atMediaS: atMediaS === null ? null : media(atMediaS), detail: "late" });
  const failedGaps = (h: ReturnType<typeof harness>, s: ReturnType<typeof stream>) =>
    h.evidence.captureBundle(s.captureId).gaps.filter((g) => g.reason === "channel_failed").map((g) => [g.channel, g.start, g.end]);

  test("reported after the span it happened in, with no later span", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.source();
    s.span(0, 10);
    failed(s, 4);
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    expect(failedGaps(h, s)).toEqual([["transcript", 4, 10]]);
  });

  test("the same gap whether the failure arrives before or after its span", () => {
    const early = harness();
    const a = stream();
    a.control("start");
    a.source();
    failed(a, 4);
    a.span(0, 10);
    early.evidence.ingest({ captureId: a.captureId, facts: a.facts });
    const late = harness();
    const b = stream();
    b.control("start");
    b.source();
    b.span(0, 10);
    failed(b, 4);
    late.evidence.ingest({ captureId: b.captureId, facts: b.facts });
    expect(failedGaps(early, a)).toEqual([["transcript", 4, 10]]);
    expect(failedGaps(late, b)).toEqual(failedGaps(early, a));
  });

  test("a failure at a span's first second is inside that span, and one at its end belongs to the next (half-open)", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.source();
    s.span(0, 10);
    s.span(10, 20);
    failed(s, 10);
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    expect(failedGaps(h, s)).toEqual([["transcript", 10, 20]]);
  });

  test("a span after the next ok is not part of the failure", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.source();
    s.span(0, 10);
    failed(s, 4);
    s.push({ kind: "channel", channel: "transcript", health: "ok", videoId: VIDEO, atMediaS: null, detail: "" });
    s.span(10, 20);
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    expect(failedGaps(h, s)).toEqual([["transcript", 4, 10]]);
  });
});

describe("R1: a span counts only once the control facts before it have all arrived", () => {
  test("a span after a missing pause fact is not watched until the pause arrives", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.span(0, 5);
    s.control("pause");
    s.span(100, 105);
    h.evidence.ingest({ captureId: s.captureId, facts: [s.facts[0]!, s.facts[1]!, s.facts[3]!] });
    expect(Material.canonical(h.evidence.watchedMaterial(s.captureId))).toEqual([[SRC, [[0, 5]]]]);
    expect(h.evidence.captureBundle(s.captureId).gaps.some((g) => g.start === 100)).toBe(false);

    h.evidence.ingest({ captureId: s.captureId, facts: [s.facts[2]!] });
    expect(Material.canonical(h.evidence.watchedMaterial(s.captureId))).toEqual([[SRC, [[0, 5]]]]);
    expect(h.evidence.captureBundle(s.captureId).gaps).toContainEqual({ sourceId: SRC, start: 100, end: 105, channel: "playback", reason: "capture_paused" });
  });

  test("a span after a missing resume fact counts only once the resume arrives", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.control("pause");
    s.control("resume");
    s.span(0, 5);
    h.evidence.ingest({ captureId: s.captureId, facts: [s.facts[0]!, s.facts[1]!, s.facts[3]!] });
    expect(Material.isEmpty(h.evidence.watchedMaterial(s.captureId))).toBe(true);
    h.evidence.ingest({ captureId: s.captureId, facts: [s.facts[2]!] });
    expect(Material.canonical(h.evidence.watchedMaterial(s.captureId))).toEqual([[SRC, [[0, 5]]]]);
  });
});
