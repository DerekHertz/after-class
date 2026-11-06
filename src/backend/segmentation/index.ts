/**
 * Boundary windows and chunks, flow B (W4). Owns: chunk_revisions.
 *
 * The chunk plan is a pure function (core.ts) of watch-ordered passages, frame
 * candidates, boundary judgments looked up in the memo, and the stop fact. It
 * is recomputed on every pump (~16 windows per 8 minutes). `sync` appends a
 * ChunkRevision only when a chunk's derived material differs from its latest
 * revision, under a content-derived ID, so running sync twice is a no-op.
 *
 *   const { closed, demand } = segmentation.sync(captureId);   // in scheduler.pump
 *   segmentation.current(captureId)                              // latest revision per chunk
 */
import type { CaptureId, ChunkId, ChunkRevisionId, WindowId } from "../../shared/ids";
import type { BoundaryJudgment, BoundaryWindow, ChunkProvenance, ChunkRevision, Route, Seq } from "../../shared/domain";
import { Material } from "../../shared/time";
import { asSeq } from "../db";
import type { Db } from "../db";
import type { WatchOrder } from "../evidence";
import type { BoundaryInput } from "../providers/jev-tasks";
import { appliesBefore } from "../providers/memo";
import type { Lookup } from "../providers/memo";
import { buildWindows, planChunks, reconcile, route, routeWithFraming } from "./core";
import type { RoutingOptions } from "./core";
export { routeWithFraming } from "./core";
export type { RoutingOptions } from "./core";

/** Re-exported so the experiment 2 lab measures the windowing and chunk planning the product runs, without importing core.ts. */
export { buildWindows, planChunks } from "./core";

/** Starting values (flow B: tune on held-out clips). The product runs PRODUCT_JEV_SETUP.segmentation (../jev-setup.ts); these defaults are the lab baseline. */
export type SegmentationConfig = {
  readonly windowNewS: number; // 30
  readonly contextS: number; // 120
  readonly timeCapS: number; // 480
  readonly maxFramesPerWindow: number; // 2
  /**
   * Off by default: a no/no right after a close usually means the NEW topic is
   * mid-explanation, not that the old one continued, so this would routinely
   * pull the next topic's first minute into the closed chunk. Jev lab measures it.
   */
  readonly reviseOnNextNoNo: boolean;
};

export const SEGMENTATION_DEFAULTS: SegmentationConfig = { windowNewS: 30, contextS: 120, timeCapS: 480, maxFramesPerWindow: 2, reviseOnNextNoNo: false };

export type WindowTrace = { readonly window: BoundaryWindow; readonly judgment: BoundaryJudgment | "pending" | "failed"; readonly route: Route | null; readonly note: string };

export type Segmentation = {
  /**
   * Derive the plan, append changed chunk revisions, return:
   *  - closed: revisions newly appended this call (invites and preparation react to these)
   *  - demand: windows needing a Jev judgment (memo missing or in flight), in watch order. In flight stays demanded: the scheduler aborts a running call that is not.
   */
  sync(captureId: CaptureId): { readonly closed: readonly ChunkRevision[]; readonly demand: readonly BoundaryInput[] };
  current(captureId: CaptureId): readonly ChunkRevision[];
  revision(id: ChunkRevision["id"]): ChunkRevision | null;
  /** All revisions of a chunk, oldest first (correction disclosure needs the diff). */
  history(chunkId: ChunkId): readonly ChunkRevision[];
  /** Inspectability: window inputs, judgments, route per window (PRD acceptance 2). */
  trace(captureId: CaptureId): readonly WindowTrace[];
};

type Row = {
  id: ChunkRevisionId; chunk_id: ChunkId; capture_id: CaptureId; ordinal: number; revision_no: number;
  material_json: string; windows_json: string; provenance: ChunkProvenance; closed_at_seq: number; supersedes: ChunkRevisionId | null;
};

function fromRow(r: Row): ChunkRevision {
  return {
    id: r.id,
    chunkId: r.chunk_id,
    captureId: r.capture_id,
    ordinal: r.ordinal,
    revisionNo: r.revision_no,
    material: Material.fromCanonical(JSON.parse(r.material_json)),
    windows: JSON.parse(r.windows_json) as WindowId[],
    provenance: r.provenance,
    closedAtSeq: asSeq(r.closed_at_seq),
    supersedes: r.supersedes,
  };
}

function describeInput(w: BoundaryWindow): string {
  const material = Material.canonical(w.newMaterial)
    .map(([source, spans]) => `${source} ${spans.map(([a, b]) => `${a}-${b}s`).join(",")}`)
    .join("; ");
  return `new ${Math.round(Material.duration(w.newMaterial))}s (${material}), ${w.contextPassages.length} context passages, ${w.frames.length} frames`;
}

export function createSegmentation(db: Db, deps: {
  watchOrder(captureId: CaptureId): WatchOrder;
  lookupBoundary(input: BoundaryInput): Lookup<BoundaryJudgment>;
  boundaryInput(w: BoundaryWindow): BoundaryInput;
  nextSeq(): Seq;
}, cfg: SegmentationConfig, routing?: RoutingOptions): Segmentation {
  const insert = db.sql.query(
    `INSERT INTO chunk_revisions (id, chunk_id, capture_id, ordinal, revision_no, material_json, windows_json, provenance, closed_at_seq, supersedes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const byCapture = db.sql.query<Row, [CaptureId]>("SELECT * FROM chunk_revisions WHERE capture_id = ? ORDER BY ordinal, revision_no");
  const byChunk = db.sql.query<Row, [ChunkId]>("SELECT * FROM chunk_revisions WHERE chunk_id = ? ORDER BY revision_no");
  const byId = db.sql.query<Row, [ChunkRevisionId]>("SELECT * FROM chunk_revisions WHERE id = ?");

  const latestPerChunk = (captureId: CaptureId): ChunkRevision[] => {
    const latest = new Map<ChunkId, ChunkRevision>();
    for (const r of byCapture.all(captureId)) latest.set(r.chunk_id, fromRow(r));
    return [...latest.values()];
  };

  function derive(captureId: CaptureId) {
    const order = deps.watchOrder(captureId);
    const windows = buildWindows(captureId, order, cfg);
    const looked = windows.map((window) => {
      const input = deps.boundaryInput(window);
      return { window, input, lookup: deps.lookupBoundary(input) };
    });
    const judged = new Map<WindowId, BoundaryJudgment | "pending" | "failed">(
      looked.map(({ window, lookup }) => [window.id, !appliesBefore(lookup, null) ? "pending" : lookup.kind === "hit" ? lookup.value : "failed"]),
    );
    const plan = planChunks(windows, (w) => judged.get(w.id)!, order.status.state === "stopped", cfg, routing);
    return { looked, judged, plan };
  }

  return {
    sync(captureId) {
      return db.tx(() => {
        const { looked, plan } = derive(captureId);
        const closed = reconcile(captureId, plan, byCapture.all(captureId).map(fromRow), deps.nextSeq);
        for (const r of closed) {
          insert.run(r.id, r.chunkId, r.captureId, r.ordinal, r.revisionNo, JSON.stringify(Material.canonical(r.material)), JSON.stringify(r.windows), r.provenance, r.closedAtSeq, r.supersedes);
        }
        return { closed, demand: looked.filter((l) => l.lookup.kind === "missing" || l.lookup.kind === "inflight").map((l) => l.input) };
      });
    },

    current: latestPerChunk,

    revision(id) {
      const row = byId.get(id);
      return row ? fromRow(row) : null;
    },

    history(chunkId) {
      return byChunk.all(chunkId).map(fromRow);
    },

    trace(captureId) {
      const { looked, judged, plan } = derive(captureId);
      return looked.map(({ window }): WindowTrace => {
        const judgment = judged.get(window.id)!;
        const decided = judgment === "pending" ? null : judgment === "failed" ? route("uncertain", "uncertain") : routeWithFraming(judgment.newConcept, judgment.stoppingPoint, judgment.lessonFraming, routing);
        const why =
          plan.notes.get(window.id) ??
          (judgment === "pending" ? "awaiting Jev judgment" : `judged, not folded yet: waiting on window ${plan.blockedOn}`);
        return { window, judgment, route: decided, note: `${describeInput(window)}. ${why}` };
      });
    },
  };
}
