/**
 * Pure segmentation (W4). Importable only by segmentation/ and test/.
 */
import { stableId } from "../../shared/ids";
import type { CaptureId, EvidenceId, WindowId } from "../../shared/ids";
import type { BoundaryJudgment, BoundaryWindow, ChunkProvenance, ChunkRevision, NonEmpty, Passage, Route, Seq, Verdict } from "../../shared/domain";
import { Material, contains } from "../../shared/time";
import type { WatchOrder } from "../evidence";
import type { SegmentationConfig } from ".";

/** Flow B table. The ONLY place the four rows exist. */
export function route(newConcept: Verdict, stoppingPoint: Verdict): Route {
  if (newConcept === "yes" && stoppingPoint === "yes") return "close";
  if (newConcept === "no" && stoppingPoint === "yes") return "soft_pause";
  if (newConcept === "yes" && stoppingPoint === "no") return "flag_recheck";
  return "continue"; // no/no, and every uncertain combination (flow B: "Jev error/uncertain → treat as \"continue\"")
}

function materialOf(passages: readonly Passage[]): Material {
  return Material.of(passages.map((p) => [p.sourceId, [p.interval]] as const));
}

/**
 * Cut watch-ordered passages into windows of ~30 s NEW material.
 * Context = the preceding ≤120 s of watched passages in watch order (may cross
 * sources: "Video ends → do NOT close; the next clip's first window decides").
 * Frames = ≤2 frame candidates inside the window's new material, latest first,
 * each frame in at most one window.
 * A trailing partial window is emitted only once capture is stopped.
 * Window ID = stableId("win", newPassageIds, contextPassageIds, frameIds), no
 * captureId, so identical material in another session reuses the judgment.
 * Windows already emitted never change as more is watched, so a rewatch (no new
 * passages) yields no new window.
 */
export function buildWindows(captureId: CaptureId, order: WatchOrder, cfg: SegmentationConfig): BoundaryWindow[] {
  const seen = new Set<string>();
  const passages = order.passages.map((w) => w.passage).filter((p) => !seen.has(p.id) && Boolean(seen.add(p.id)));
  const stopped = order.status.state === "stopped";
  const windows: BoundaryWindow[] = [];
  const usedFrames = new Set<EvidenceId>();
  let watched: Material = Material.empty;

  const emit = (from: number, to: number): void => {
    const [first, ...rest] = passages.slice(from, to);
    const newPassages: NonEmpty<Passage> = [first!, ...rest];
    const newMaterial = materialOf(newPassages);

    let context: Material = Material.empty;
    let contextFrom = from;
    while (contextFrom > 0) {
      const next = Material.union(context, materialOf([passages[contextFrom - 1]!]));
      if (Material.duration(next) > cfg.contextS) break;
      context = next;
      contextFrom--;
    }
    const contextIds = passages.slice(contextFrom, from).map((p) => p.id);

    const frameIds = order.frameCandidates
      .filter((f) => !usedFrames.has(f.id) && Material.get(newMaterial, f.sourceId).intervals().some((i) => contains(i, f.mediaS)))
      .reverse()
      .slice(0, cfg.maxFramesPerWindow)
      .map((f) => f.id);
    for (const id of frameIds) usedFrames.add(id);

    const newIds = newPassages.map((p) => p.id) as unknown as NonEmpty<EvidenceId>;
    watched = Material.union(watched, newMaterial);
    windows.push({
      id: stableId("win", newIds, contextIds, frameIds),
      captureId,
      ordinal: windows.length,
      newPassages: newIds,
      contextPassages: contextIds,
      frames: frameIds,
      newMaterial,
      watchedSecondsAtEnd: Material.duration(watched),
    });
  };

  let start = 0;
  let acc: Material = Material.empty;
  for (let i = 0; i < passages.length; i++) {
    acc = Material.union(acc, materialOf([passages[i]!]));
    if (Material.duration(acc) >= cfg.windowNewS || (stopped && i === passages.length - 1)) {
      emit(start, i + 1);
      start = i + 1;
      acc = Material.empty;
    }
  }
  return windows;
}

export type PlannedChunk = {
  readonly ordinal: number;
  readonly windows: readonly WindowId[];
  readonly material: Material;
  readonly provenance: ChunkProvenance;
};
export type OpenChunk = Omit<PlannedChunk, "provenance">;
export type ChunkPlan = {
  readonly closed: readonly PlannedChunk[];
  readonly open: OpenChunk | null;
  readonly blockedOn: WindowId | null;
  /** What the fold did at each window it reached, for `trace`. */
  readonly notes: ReadonlyMap<WindowId, string>;
};

type Entry = { readonly w: BoundaryWindow; readonly soft: boolean; readonly flag: boolean };
type Closed = { windows: BoundaryWindow[]; provenance: ChunkProvenance };

const unionMaterial = (ws: readonly BoundaryWindow[]): Material => ws.reduce((m, w) => Material.union(m, w.newMaterial), Material.empty);
const unflagged = (entries: readonly Entry[]): Entry[] => entries.map((e) => ({ ...e, flag: false }));

/**
 * The fold. Processes windows in watch order and stops at the first window
 * whose judgment is "pending" (blockedOn). A "failed" lookup is uncertain/uncertain.
 *
 * Marks live on the open windows themselves (a soft pause, a yes/no flag), so a
 * cut that carries windows into the next chunk carries their marks with it.
 *
 * Boundary revision (flow D "later evidence revises a boundary"; TLA
 * ALaterWindowMovesABoundary): the FIRST window after a boundary close says
 * "continues, unfinished" (no/no) ⇒ the explanation was not finished at the
 * boundary, so the boundary moves forward through that window, once per
 * boundary. The closed chunk absorbs the windows that opened after the close
 * plus this one, so it stays contiguous. Not attempted after a flag cut-back or
 * a time close.
 */
export function planChunks(
  windows: readonly BoundaryWindow[],
  judgment: (w: BoundaryWindow) => BoundaryJudgment | "pending" | "failed",
  stopped: boolean,
  cfg: SegmentationConfig,
): ChunkPlan {
  const closed: Closed[] = [];
  const notes = new Map<WindowId, string>();
  const note = (w: BoundaryWindow, text: string): void => void notes.set(w.id, notes.has(w.id) ? `${notes.get(w.id)}; ${text}` : text);
  let open: Entry[] = [];
  let reconsiderable: number | null = null; // index in `closed` of a boundary no window has followed yet
  let blockedOn: WindowId | null = null;

  const close = (entries: readonly Entry[], provenance: ChunkProvenance): number => closed.push({ windows: entries.map((e) => e.w), provenance }) - 1;

  for (const w of windows) {
    const j = judgment(w);
    if (j === "pending") {
      blockedOn = w.id;
      break;
    }
    const newConcept: Verdict = j === "failed" ? "uncertain" : j.newConcept;
    const stoppingPoint: Verdict = j === "failed" ? "uncertain" : j.stoppingPoint;
    const r = route(newConcept, stoppingPoint);
    const label = j === "failed" ? "judgment failed, read as uncertain/uncertain" : `${newConcept}/${stoppingPoint}`;

    const reconsider = reconsiderable;
    reconsiderable = null;
    if (cfg.reviseOnNextNoNo && reconsider !== null && newConcept === "no" && stoppingPoint === "no") {
      const target = closed[reconsider]!;
      target.windows.push(...open.map((e) => e.w), w);
      target.provenance = "boundary_revised";
      open = [];
      note(w, `${label}: boundary of chunk ${reconsider} moved forward through this window`);
      continue;
    }

    if (r === "close" && open.length > 0) {
      const flagged = open.findIndex((e) => e.flag);
      const cutAt = flagged > 0 ? flagged : open.length;
      const ordinal = close(open.slice(0, cutAt), "boundary");
      const rest = unflagged(open.slice(cutAt));
      open = [...rest, { w, soft: false, flag: false }];
      if (rest.length === 0) reconsiderable = ordinal;
      note(w, `${label}: closed chunk ${ordinal} at boundary${rest.length > 0 ? ", cut back to the flagged window" : ""}`);
    } else if (r === "flag_recheck") {
      open.push({ w, soft: false, flag: true });
      note(w, `${label}: not closed, flagged for recheck on the next window`);
    } else if (r === "soft_pause") {
      open = [...unflagged(open), { w, soft: true, flag: false }];
      note(w, `${label}: soft pause inside the topic`);
    } else {
      open = [...(newConcept === "no" ? unflagged(open) : open), { w, soft: false, flag: false }];
      note(w, r === "close" ? `${label}: nothing open to close, this window opens a chunk` : `${label}: continue`);
    }

    while (open.length > 0 && Material.duration(unionMaterial(open.map((e) => e.w))) >= cfg.timeCapS) {
      const lastSoft = open.findLastIndex((e) => e.soft);
      const cut = lastSoft >= 0 ? lastSoft + 1 : open.length;
      const ordinal = close(open.slice(0, cut), "time");
      open = open.slice(cut);
      reconsiderable = null;
      note(w, `time cap reached: closed chunk ${ordinal} ${lastSoft >= 0 ? "at the latest soft pause" : "at this window"}`);
    }
  }

  if (stopped && blockedOn === null && open.length > 0) {
    const last = open[open.length - 1]!.w;
    note(last, `session end: closed chunk ${close(open, "session_end")}`);
    open = [];
  }

  const planned = closed.map((c, ordinal): PlannedChunk => ({ ordinal, windows: c.windows.map((w) => w.id), material: unionMaterial(c.windows), provenance: c.provenance }));
  return {
    closed: planned,
    open: open.length === 0 ? null : { ordinal: closed.length, windows: open.map((e) => e.w.id), material: unionMaterial(open.map((e) => e.w)) },
    blockedOn,
    notes,
  };
}

/**
 * Compare plan to stored revisions; return rows to append.
 * New revision iff no revision for that ordinal, or Material differs from the
 * latest one. Never deletes or updates (chunk_revisions rejects UPDATE); the new
 * row names the revision it supersedes.
 * R7: "Once a review starts, its scope never grows; corrections can change claims inside it but can't add material."
 * A scope names the revision it froze, and that row is never touched, so a
 * later boundary move appends a new revision instead of growing the frozen one.
 */
export function reconcile(captureId: CaptureId, plan: ChunkPlan, stored: readonly ChunkRevision[], seq: () => Seq): ChunkRevision[] {
  const out: ChunkRevision[] = [];
  for (const c of plan.closed) {
    const chunkId = stableId("chk", captureId, c.ordinal);
    const prior = stored.filter((r) => r.chunkId === chunkId).sort((a, b) => a.revisionNo - b.revisionNo);
    const latest = prior[prior.length - 1] ?? null;
    if (latest && Material.equals(latest.material, c.material)) continue;
    const revisionNo = (latest?.revisionNo ?? 0) + 1;
    const canonical = Material.canonical(c.material);
    // A plan that returns to older material would reuse that row's content-derived ID.
    const plain = stableId("crv", chunkId, canonical);
    out.push({
      id: prior.some((r) => r.id === plain) ? stableId("crv", chunkId, canonical, revisionNo) : plain,
      chunkId,
      captureId,
      ordinal: c.ordinal,
      revisionNo,
      material: c.material,
      windows: c.windows,
      provenance: c.provenance,
      closedAtSeq: seq(),
      supersedes: latest?.id ?? null,
    });
  }
  return out;
}
