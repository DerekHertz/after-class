/**
 * Pure evidence derivations (W3). Importable only by evidence/ and test/.
 *
 * Everything here is a fold over one capture's facts. Facts are ordered by
 * `clientSeq` (the extension's event order), never by arrival order, so a
 * resent or reordered batch folds to the same projection.
 */
import { stableId } from "../../shared/ids";
import type { CaptureId, EvidenceId, SourceId } from "../../shared/ids";
import type {
  AdRecord, CaptureFact, CaptureStatus, CaptureView, Channel, ChannelHealth, Frame, Gap, GapReason, Passage, Seq, Source, TranscriptSegment,
} from "../../shared/domain";
import { IntervalSet, Material, interval } from "../../shared/time";
import type { Interval } from "../../shared/time";
import type { WatchedPassage } from "./index";

type SpanFact = Extract<CaptureFact, { kind: "span" }>;
type TranscriptFact = Extract<CaptureFact, { kind: "transcript" }>;
type FrameFact = Extract<CaptureFact, { kind: "frame" }>;

export const sourceIdOf = (videoId: string): SourceId => stableId("src", "youtube", videoId);

const byClientSeq = (a: { readonly clientSeq: number }, b: { readonly clientSeq: number }) => a.clientSeq - b.clientSeq;
const sortedFacts = (facts: readonly CaptureFact[]): CaptureFact[] => [...facts].sort(byClientSeq);

/** Latest non-null duration per source, so a span is judged against what the capture later learned. */
export function durationLookup(facts: readonly CaptureFact[]): (sourceId: SourceId) => number | null {
  const out = new Map<SourceId, number>();
  for (const f of sortedFacts(facts)) {
    if (f.kind === "source" && f.durationS !== null) out.set(sourceIdOf(f.videoId), f.durationS);
  }
  return (id) => out.get(id) ?? null;
}

/**
 * R2: "Ad time never becomes evidence."
 * Defence in depth against an extension ad-detection race. A span is
 * implausible, and adds no material, when:
 *   end > sourceDurationS + 1                                   (ad media or the wrong video)
 *   (end - start) > rate * wallDurationMs / 1000 * 1.25 + 1.5   (media grew faster than wall time)
 * Implausible spans are reported as `implausible_span` gaps, never silently dropped.
 */
export function spanPlausible(span: SpanFact, sourceDurationS: number | null): boolean {
  if (!(span.end > span.start) || !(span.rate > 0)) return false;
  if (sourceDurationS !== null && span.end > sourceDurationS + 1) return false;
  return span.end - span.start <= (span.rate * span.wallDurationMs) / 1000 * 1.25 + 1.5;
}

export type SpanVerdict = "counted" | "implausible" | "outside_capture";
export type ClassifiedSpan = { readonly fact: SpanFact; readonly sourceId: SourceId; readonly verdict: SpanVerdict };

/**
 * R1: "Evidence only comes from intervals I actually watched while capture was on."
 * A span is counted only inside an active control period of this capture: after
 * `start` or `resume`, before `pause` or `stop`, in clientSeq order.
 */
export function classifySpans(facts: readonly CaptureFact[], durationOf: (sourceId: SourceId) => number | null): ClassifiedSpan[] {
  let active = false;
  const out: ClassifiedSpan[] = [];
  for (const f of sortedFacts(facts)) {
    if (f.kind === "control") {
      active = f.action === "start" || f.action === "resume";
    } else if (f.kind === "span") {
      const sourceId = sourceIdOf(f.videoId);
      const verdict: SpanVerdict = !active ? "outside_capture" : spanPlausible(f, durationOf(sourceId)) ? "counted" : "implausible";
      out.push({ fact: f, sourceId, verdict });
    }
  }
  return out;
}

const spanInterval = (s: SpanFact): Interval => ({ start: s.start, end: s.end });

function materialOf(spans: readonly ClassifiedSpan[], keep: (s: ClassifiedSpan) => boolean): Material {
  const bySource = new Map<SourceId, Interval[]>();
  for (const s of spans) {
    if (!keep(s)) continue;
    const list = bySource.get(s.sourceId) ?? [];
    list.push(spanInterval(s.fact));
    bySource.set(s.sourceId, list);
  }
  return Material.of(bySource);
}

/**
 * Fold control + span facts into watched material.
 * R1: "Evidence only comes from intervals I actually watched while capture was on."
 * A span counts only inside an active control period of this capture (double
 * gate: the extension also stops emitting when paused) and only if spanPlausible.
 * R2: "Ad time never becomes evidence."
 * Reads only `span` facts; `ad` facts are a different kind and can't reach here.
 */
export function watchedMaterial(facts: readonly CaptureFact[], sourceDurationS: (sourceId: SourceId) => number | null): Material {
  return materialOf(classifySpans(facts, sourceDurationS), (s) => s.verdict === "counted");
}

/**
 * The ONLY constructor of Passage.
 * R1: "Evidence only comes from intervals I actually watched while capture was on."
 * Strict (SYNTHESIS open question 4): a segment is a passage iff watched covers
 * it wholly. A partly watched segment becomes a `partially_watched_segment` gap.
 */
export function clipToWatched(
  sourceId: SourceId, transcriptRevId: Passage["transcriptRevId"], origin: Passage["origin"],
  segments: readonly TranscriptSegment[], watched: Material,
): { readonly passages: Passage[]; readonly partial: Gap[] } {
  const passages: Passage[] = [];
  const partial: Gap[] = [];
  const seen = new Set<EvidenceId>();
  const set = Material.get(watched, sourceId);
  for (const seg of segments) {
    const span: Interval = { start: seg.start, end: seg.end };
    if (!(seg.end > seg.start)) continue;
    if (set.covers(span)) {
      const id = stableId("ev", transcriptRevId, seg.start, seg.end);
      if (seen.has(id)) continue;
      seen.add(id);
      passages.push({ kind: "passage", id, sourceId, transcriptRevId, interval: span, text: seg.text, origin } as Passage);
    } else if (set.overlapFraction(span) > 0) {
      partial.push({ sourceId, interval: span, channel: "transcript", reason: "partially_watched_segment" });
    }
  }
  return { passages, partial };
}

type TranscriptInfo = {
  readonly transcript: TranscriptFact | null;
  readonly unavailable: boolean;
  readonly choice: "accept_asr" | "continue_with_gap" | null;
};

function transcriptInfo(sorted: readonly CaptureFact[]): Map<string, TranscriptInfo> {
  const out = new Map<string, TranscriptInfo>();
  const get = (v: string): TranscriptInfo => out.get(v) ?? { transcript: null, unavailable: false, choice: null };
  for (const f of sorted) {
    if (f.kind === "transcript" && f.segments.length > 0) out.set(f.videoId, { ...get(f.videoId), transcript: f });
    else if (f.kind === "transcript_unavailable") out.set(f.videoId, { ...get(f.videoId), unavailable: true });
    else if (f.kind === "transcription_choice") out.set(f.videoId, { ...get(f.videoId), choice: f.choice });
  }
  return out;
}

function transcriptGapReason(info: TranscriptInfo | undefined): "no_transcript" | "transcript_declined" | null {
  if (!info || info.transcript) return null;
  if (info.choice === "continue_with_gap") return "transcript_declined";
  if (info.unavailable && info.choice !== "accept_asr") return "no_transcript";
  return null;
}

const FRAME_STALL_S = 3;

/**
 * Gaps for a source: watched intervals with no transcript (no_transcript /
 * transcript_declined), with tabVisible=false (hidden_tab, frames channel),
 * with no frame sample for > 3 s while visible (frame_stall), channel
 * failures, implausible spans, and spans emitted while capture was off
 * (capture_paused). Ad time is deliberately not a gap (flow A).
 */
export function deriveGaps(facts: readonly CaptureFact[], watched: Material): Gap[] {
  const sorted = sortedFacts(facts);
  const spans = classifySpans(sorted, durationLookup(sorted));
  const gaps: Gap[] = [];
  const add = (sourceId: SourceId, i: Interval, channel: Channel, reason: GapReason) => {
    if (i.end > i.start) gaps.push({ sourceId, interval: i, channel, reason });
  };

  for (const s of spans) {
    if (s.verdict === "implausible") add(s.sourceId, spanInterval(s.fact), "playback", "implausible_span");
    if (s.verdict === "outside_capture") add(s.sourceId, spanInterval(s.fact), "playback", "capture_paused");
  }

  const visible = materialOf(spans, (s) => s.verdict === "counted" && s.fact.tabVisible);
  const hidden = materialOf(spans, (s) => s.verdict === "counted" && !s.fact.tabVisible);
  for (const [sourceId, set] of Material.subtract(hidden, visible)) {
    for (const i of set.intervals()) add(sourceId, i, "frames", "hidden_tab");
  }

  const samples = new Map<SourceId, number[]>();
  for (const f of sorted) {
    if (f.kind !== "frame") continue;
    const id = sourceIdOf(f.videoId);
    samples.set(id, [...(samples.get(id) ?? []), f.mediaS]);
  }
  for (const [sourceId, set] of visible) {
    const times = (samples.get(sourceId) ?? []).sort((a, b) => a - b);
    for (const i of set.intervals()) {
      const marks = [i.start as number, ...times.filter((t) => t > i.start && t < i.end), i.end as number];
      for (let k = 1; k < marks.length; k++) {
        const from = marks[k - 1]!;
        const to = marks[k]!;
        if (to - from > FRAME_STALL_S) add(sourceId, interval(from, to), "frames", "frame_stall");
      }
    }
  }

  const verdictOf = new Map<CaptureFact, SpanVerdict>(spans.map((s) => [s.fact, s.verdict]));
  const failing = new Map<Channel, { readonly videoId: string | null; readonly atMediaS: number | null; readonly stalled: boolean }>();
  for (const f of sorted) {
    if (f.kind === "channel") {
      if (f.health === "ok") failing.delete(f.channel);
      else failing.set(f.channel, { videoId: f.videoId, atMediaS: f.atMediaS, stalled: f.health === "stalled" });
    } else if (f.kind === "span") {
      if (verdictOf.get(f) !== "counted") continue;
      for (const [channel, state] of failing) {
        if (state.videoId !== null && state.videoId !== f.videoId) continue;
        const from = state.atMediaS !== null && f.start < state.atMediaS && state.atMediaS < f.end ? state.atMediaS : f.start;
        add(sourceIdOf(f.videoId), { start: from as Interval["start"], end: f.end }, channel, state.stalled && channel === "frames" ? "frame_stall" : "channel_failed");
      }
    }
  }

  const info = transcriptInfo(sorted);
  const knownVideos = new Set<string>();
  for (const f of sorted) if ("videoId" in f && f.videoId !== null) knownVideos.add(f.videoId);
  for (const videoId of knownVideos) {
    const sourceId = sourceIdOf(videoId);
    const reason = transcriptGapReason(info.get(videoId));
    if (reason === null) continue;
    for (const i of Material.get(watched, sourceId).intervals()) add(sourceId, i, "transcript", reason);
  }

  return dedupeGaps(gaps);
}

const gapKey = (g: Gap) => `${g.sourceId}|${g.interval.start}|${g.interval.end}|${g.channel}|${g.reason}`;

export function dedupeGaps(gaps: readonly Gap[]): Gap[] {
  const unique = new Map<string, Gap>();
  for (const g of gaps) unique.set(gapKey(g), g);
  return [...unique.values()].sort((a, b) =>
    a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : a.interval.start - b.interval.start || a.interval.end - b.interval.end || (gapKey(a) < gapKey(b) ? -1 : 1));
}

export function deriveAds(facts: readonly CaptureFact[]): AdRecord[] {
  const out: AdRecord[] = [];
  for (const f of sortedFacts(facts)) {
    if (f.kind === "ad") out.push({ sourceId: sourceIdOf(f.videoId), atContentS: f.atContentS, wallDurationMs: f.wallDurationMs, signals: f.signals });
  }
  return out;
}

// ───────────────────────────── Capture projection ───────────────────────────

/** A stored fact. `hasBytes` is true when its frame row (and file) still exists. */
export type StoredFact = { readonly seq: Seq; readonly fact: CaptureFact; readonly hasBytes: boolean };

export type FrameEntry = {
  /** `teaching` is "unjudged" here: it derives from the memo at read time. */
  readonly frame: Frame;
  readonly captureId: CaptureId;
  readonly clientSeq: number;
  readonly seq: Seq;
  /** Nearest earlier candidate of the same source in media time, or null for the first. */
  readonly before: FrameEntry | null;
  /** Watched passages within ±15 s media. */
  readonly nearby: readonly Passage[];
};

export type Projection = {
  readonly captureId: CaptureId;
  readonly status: CaptureStatus;
  readonly stoppedAtSeq: Seq | null;
  readonly sources: readonly Source[];
  readonly currentSourceId: SourceId | null;
  readonly transcript: CaptureView["transcript"];
  readonly health: readonly ChannelHealth[];
  readonly watched: Material;
  readonly visible: Material;
  readonly passages: readonly WatchedPassage[];
  readonly frames: readonly FrameEntry[];
  readonly gaps: readonly Gap[];
  readonly ads: readonly AdRecord[];
};

const NEARBY_S = 15;

function holdsPoint(set: IntervalSet, p: number): boolean {
  return set.intervals().some((i) => i.start <= p && p <= i.end);
}

export function foldCapture(captureId: CaptureId, stored: readonly StoredFact[]): Projection {
  const rows = [...stored].sort((a, b) => byClientSeq(a.fact, b.fact));
  const facts = rows.map((r) => r.fact);
  const seqOf = new Map<CaptureFact, Seq>(rows.map((r) => [r.fact, r.seq]));
  const bytesOf = new Map<CaptureFact, boolean>(rows.map((r) => [r.fact, r.hasBytes]));

  const spans = classifySpans(facts, durationLookup(facts));
  const watched = materialOf(spans, (s) => s.verdict === "counted");
  const visible = materialOf(spans, (s) => s.verdict === "counted" && s.fact.tabVisible);

  const sourceFacts = new Map<string, Extract<CaptureFact, { kind: "source" }>>();
  const order = new Map<string, number>();
  let currentVideo: string | null = null;
  let status: CaptureStatus = { state: "stopped" };
  let stoppedAtSeq: Seq | null = null;
  for (const f of facts) {
    if ("videoId" in f && f.videoId !== null) {
      if (!order.has(f.videoId)) order.set(f.videoId, order.size);
      if (f.kind === "source" || f.kind === "span" || f.kind === "frame" || f.kind === "ad") currentVideo = f.videoId;
    }
    if (f.kind === "source") sourceFacts.set(f.videoId, f);
    if (f.kind === "control") {
      status =
        f.action === "pause" ? { state: "paused", reason: f.reason } : f.action === "stop" ? { state: "stopped" } : { state: "capturing" };
      if (f.action === "stop" && stoppedAtSeq === null) stoppedAtSeq = seqOf.get(f) ?? null;
    }
  }
  const durationOf = durationLookup(facts);
  const sources: Source[] = [...order.keys()].flatMap((videoId) => {
    const s = sourceFacts.get(videoId);
    if (!s) return [];
    const id = sourceIdOf(videoId);
    return [{ id, videoId, title: s.title, url: s.url, channelName: s.channelName, durationS: durationOf(id) }];
  });

  const info = transcriptInfo(facts);
  const countedBySource = new Map<SourceId, ClassifiedSpan[]>();
  for (const s of spans) if (s.verdict === "counted") countedBySource.set(s.sourceId, [...(countedBySource.get(s.sourceId) ?? []), s]);

  const passages: (WatchedPassage & { readonly order: number })[] = [];
  const partial: Gap[] = [];
  for (const [videoId, t] of info) {
    if (!t.transcript) continue;
    const sourceId = sourceIdOf(videoId);
    const { origin, language, segments } = t.transcript;
    const revId = stableId("trv", sourceId, origin, language, segments);
    const clipped = clipToWatched(sourceId, revId, origin, segments, watched);
    partial.push(...clipped.partial);
    const counted = countedBySource.get(sourceId) ?? [];
    for (const passage of clipped.passages) {
      const cover = firstCover(passage.interval, counted);
      if (!cover) continue;
      passages.push({ passage, firstWatchedAtSeq: seqOf.get(cover.fact)!, sourceIndex: order.get(videoId)!, order: cover.fact.clientSeq });
    }
  }
  passages.sort((a, b) => a.order - b.order || a.passage.interval.start - b.passage.interval.start);

  const allPassages = passages.map((p) => p.passage);
  const candidates: Omit<FrameEntry, "before" | "nearby">[] = [];
  for (const f of facts) {
    if (f.kind !== "frame" || !bytesOf.get(f)) continue;
    const sourceId = sourceIdOf(f.videoId);
    if (!holdsPoint(Material.get(visible, sourceId), f.mediaS)) continue;
    candidates.push({ frame: frameOf(captureId, sourceId, f), captureId, clientSeq: f.clientSeq, seq: seqOf.get(f)! });
  }
  const bySource = new Map<SourceId, typeof candidates>();
  for (const c of candidates) bySource.set(c.frame.sourceId, [...(bySource.get(c.frame.sourceId) ?? []), c]);
  const built = new Map<EvidenceId, FrameEntry>();
  for (const list of bySource.values()) {
    const media = [...list].sort((a, b) => a.frame.mediaS - b.frame.mediaS || a.clientSeq - b.clientSeq);
    let before: FrameEntry | null = null;
    for (const c of media) {
      const m = c.frame.mediaS;
      const nearby = allPassages.filter((p) => p.sourceId === c.frame.sourceId && p.interval.start < m + NEARBY_S && p.interval.end > m - NEARBY_S);
      const entry: FrameEntry = { ...c, before, nearby };
      built.set(c.frame.id, entry);
      before = entry;
    }
  }
  const frames = candidates.map((c) => built.get(c.frame.id)!);

  const health: ChannelHealth[] = (["transcript", "frames", "playback"] as const).map((channel) => {
    let latest: Extract<CaptureFact, { kind: "channel" }> | null = null;
    for (const f of facts) {
      if (f.kind === "channel" && f.channel === channel && (f.videoId === null || f.videoId === currentVideo)) latest = f;
    }
    return { channel, health: latest?.health ?? "unknown", detail: latest?.detail ?? "" };
  });

  return {
    captureId,
    status,
    stoppedAtSeq,
    sources,
    currentSourceId: currentVideo === null ? null : sourceIdOf(currentVideo),
    transcript: transcriptState(currentVideo === null ? undefined : info.get(currentVideo)),
    health,
    watched,
    visible,
    passages: passages.map(({ order: _order, ...p }) => p),
    frames,
    gaps: dedupeGaps([...deriveGaps(facts, watched), ...partial]),
    ads: deriveAds(facts),
  };
}

/** The first span, in watch order, after which the watched prefix covers `target` wholly. */
function firstCover(target: Interval, counted: readonly ClassifiedSpan[]): ClassifiedSpan | null {
  let acc = IntervalSet.empty;
  for (const s of counted) {
    if (s.fact.end <= target.start || s.fact.start >= target.end) continue;
    acc = acc.union(IntervalSet.of([spanInterval(s.fact)]));
    if (acc.covers(target)) return s;
  }
  return null;
}

function frameOf(captureId: CaptureId, sourceId: SourceId, f: FrameFact): Frame {
  return {
    kind: "frame", id: stableId("ev", captureId, f.frameId), sourceId, mediaS: f.mediaS, width: f.width, height: f.height, teaching: "unjudged",
  } as Frame;
}

function transcriptState(info: TranscriptInfo | undefined): CaptureView["transcript"] {
  if (!info) return "unknown";
  if (info.transcript) return "available";
  if (info.choice === "accept_asr") return "asr_running";
  if (info.choice === "continue_with_gap") return "gap_accepted";
  return info.unavailable ? "unavailable_offer_asr" : "unknown";
}

// ───────────────────────────── Bundles ──────────────────────────────────────

/** Evidence of `material` from the captures that watched it. */
export function selectScope(projections: readonly Projection[], material: Material): readonly Projection[] {
  const touching = projections.filter((p) => !Material.isEmpty(Material.intersect(p.watched, material)));
  const containing = touching.filter((p) => Material.contains(p.watched, material));
  return containing.length > 0 ? containing : touching;
}

export function gapTouches(material: Material, g: Gap): boolean {
  return Material.get(material, g.sourceId).overlapFraction(g.interval) > 0;
}

export function adInside(material: Material, a: AdRecord): boolean {
  return holdsPoint(Material.get(material, a.sourceId), a.atContentS);
}

export function frameInside(material: Material, f: Frame): boolean {
  return holdsPoint(Material.get(material, f.sourceId), f.mediaS);
}

export type EvidenceBundleJson = {
  readonly captureId: string | null;
  readonly status: CaptureStatus | null;
  readonly watchedSeconds: number;
  readonly watched: readonly { readonly sourceId: string; readonly intervals: readonly (readonly [number, number])[] }[];
  readonly passages: readonly { readonly id: string; readonly sourceId: string; readonly start: number; readonly end: number; readonly text: string; readonly origin: string; readonly transcriptRevId: string }[];
  readonly frames: readonly { readonly id: string; readonly sourceId: string; readonly mediaS: number; readonly width: number; readonly height: number; readonly teaching: string; readonly file: string | null }[];
  readonly gaps: readonly { readonly sourceId: string; readonly start: number; readonly end: number; readonly channel: string; readonly reason: string }[];
  readonly ads: readonly { readonly sourceId: string; readonly atContentS: number; readonly wallDurationMs: number; readonly signals: readonly string[] }[];
};

export function bundleToJson(
  b: { readonly material: Material; readonly passages: readonly Passage[]; readonly frames: readonly Frame[]; readonly gaps: readonly Gap[]; readonly ads: readonly AdRecord[] },
  meta: { readonly captureId: string | null; readonly status: CaptureStatus | null; readonly fileOf: (id: EvidenceId) => string | null },
): EvidenceBundleJson {
  return {
    captureId: meta.captureId,
    status: meta.status,
    watchedSeconds: Material.duration(b.material),
    watched: Material.canonical(b.material).map(([sourceId, intervals]) => ({ sourceId, intervals })),
    passages: b.passages.map((p) => ({
      id: p.id, sourceId: p.sourceId, start: p.interval.start, end: p.interval.end, text: p.text, origin: p.origin, transcriptRevId: p.transcriptRevId,
    })),
    frames: b.frames.map((f) => ({ id: f.id, sourceId: f.sourceId, mediaS: f.mediaS, width: f.width, height: f.height, teaching: f.teaching, file: meta.fileOf(f.id) })),
    gaps: b.gaps.map((g) => ({ sourceId: g.sourceId, start: g.interval.start, end: g.interval.end, channel: g.channel, reason: g.reason })),
    ads: b.ads.map((a) => ({ sourceId: a.sourceId, atContentS: a.atContentS, wallDurationMs: a.wallDurationMs, signals: [...a.signals] })),
  };
}
