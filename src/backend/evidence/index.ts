/**
 * Evidence store (W3). Owns: capture_facts, frames (bytes on disk at
 * <dataDir>/frames/<userId>/<sourceId>/<evidenceId>.jpg, snapshots at <dataDir>/snapshots/<userId>/<evidenceId>.jpg; rows written before
 * per-user paths keep their old path), evidence_snapshots, evidence_deletions.
 *
 * One store serves one user (the `UserDb` it is built on): every query reads or writes with that user_id. A capture id
 * belongs to the first user that ingests it (capture_owners, kept after expiry), and another user's batch for it is refused, so a frame's evidence id and its
 * file path (both derived from the capture id) are unique across users. Passage evidence ids are derived from the transcript
 * and are the same for two users who watch the same interval, so the tables that key by evidence id key by (user_id, evidence_id).
 *
 * Facts in, evidence out. The capture projection (watched material, gaps,
 * health, status) is a fold over this capture's facts (core.ts), rebuilt from
 * capture_facts on demand and cached until the next write.
 *
 *   const ack = evidence.ingest(parsed);                 // POST /ingest
 *   const view = evidence.captureView(captureId);        // popup + app
 *   const order = evidence.watchOrder(captureId);         // segmentation input
 *   const bundle = evidence.bundle(chunk.material);       // interpretation input, evidence panel
 *   const probe = evidence.captureBundle(captureId);      // capture probe: JSON for Derek to inspect
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stableId } from "../../shared/ids";
import type { CaptureId, EvidenceId, MemoKey, SourceId, TranscriptRevId } from "../../shared/ids";
import type {
  AdRecord, CaptureFact, CaptureStatus, CaptureView, DeletedEvidence, Evidence, EvidenceBundle, Frame, FrameTeaching, Gap, Passage, Seq,
  TranscriptOrigin, Verdict,
} from "../../shared/domain";
import { Material } from "../../shared/time";
import type { MediaSeconds } from "../../shared/time";
import { asSeq } from "../db";
import type { UserDb } from "../db";
import type { WorkItem } from "../scheduler";
import type { Lookup } from "../providers/memo";
import type { FrameChangeInput } from "../providers/jev-tasks";
import { adInside, bundleToJson, clipGap, dedupeGaps, foldCapture, frameInside, selectScope } from "./core";
import type { EvidenceBundleJson, FrameEntry, Projection, StoredFact } from "./core";

/** Newly watched material in WATCH order (not media order): what segmentation windows over. */
export type WatchedPassage = { readonly passage: Passage; readonly firstWatchedAtSeq: Seq; readonly sourceIndex: number };

export type WatchOrder = {
  readonly passages: readonly WatchedPassage[];
  readonly frameCandidates: readonly Frame[]; // watched, visible-tab, in watch order
  readonly status: CaptureStatus;
  readonly stoppedAtSeq: Seq | null;
  readonly watchedSeconds: number;
};

export type EvidenceStore = {
  /**
   * Idempotent on (captureId, clientSeq). Frame bytes go to disk via
   * temp+rename BEFORE the row commits; a crash leaves an orphan file (swept),
   * never a row without bytes. Returns the highest contiguous clientSeq stored
   * (counting from 0; -1 when clientSeq 0 has not arrived). Throws RangeError,
   * storing nothing, for a capture id another user already holds.
   */
  ingest(batch: { readonly captureId: CaptureId; readonly facts: readonly CaptureFact[] }): { readonly ackedThroughSeq: number };
  captureView(captureId: CaptureId): CaptureView;
  activeCaptures(): readonly CaptureId[];
  /** Every capture of this user that has stored facts, most recently captured first. Read-only. */
  captures(): readonly CaptureId[];
  /** True when another user owns this capture id, which they keep after its facts expire. The HTTP layer answers 404, as for an id that is not the caller's. */
  capturedByAnotherUser(captureId: CaptureId): boolean;
  /**
   * True when an id has a frame, snapshot or tombstone row for another user and nothing for this one. A passage id that this
   * user also holds is theirs, whatever another user did with it. An id nobody stored (or only another user's raw passage) is false.
   */
  heldByAnotherUser(ids: readonly EvidenceId[]): boolean;
  watchOrder(captureId: CaptureId): WatchOrder;
  /** Watched passages + kept/uncertain frames + gaps + ads inside `material`. User-deleted evidence is left out. */
  bundle(material: Material): EvidenceBundle;
  get(ids: readonly EvidenceId[]): ReadonlyMap<EvidenceId, Evidence | DeletedEvidence>;
  frameBytes(id: EvidenceId): Uint8Array | null;
  /** Frame-change judgments still needed (frames with teaching "unjudged"). */
  frameDemand(captureId: CaptureId): readonly WorkItem[];
  /**
   * Called by record.save inside the save transaction: copy cited evidence
   * (passage text + interval, frame file hard-link) into evidence_snapshots.
   * Insert-only and content-addressed, so a retried save is a no-op.
   */
  snapshotInTx(ids: readonly EvidenceId[]): void;
  /**
   * User command. One tx: tombstone in evidence_deletions, then delete the
   * snapshot and frame rows, then unlink files. Citing notes then show
   * "evidence deleted by you". The tombstone is what lets the R16 triggers pass.
   */
  deleteByUser(ids: readonly EvidenceId[], requestId: string): void;
  /**
   * R16: "Evidence cited by a saved note is only deleted when I delete it, never by expiry."
   * Daily sweep of this user's raw capture facts and frame files older than retentionDays (30).
   * The SQL says NOT EXISTS for live citations and for unsaved reviews of the
   * capture (pending saves count as citing); the db.ts triggers abort the
   * delete if this SQL is ever wrong. No route exposes it.
   */
  sweepExpired(nowMs: number, retentionDays: number): { readonly framesDeleted: number; readonly factsDeleted: number; readonly snapshotsDeleted: number };
};

/** What the capture probe needs on top of the frozen store. A superset, so every `EvidenceStore` consumer still type-checks. */
export type EvidenceStoreWithProbe = EvidenceStore & {
  /** Watched material of one capture. */
  watchedMaterial(captureId: CaptureId): Material;
  /** Everything one capture produced, as plain JSON: watched intervals, passages, all frames with teaching, gaps, ads. */
  captureBundle(captureId: CaptureId): EvidenceBundleJson;
};

type Raw = { readonly kind: "passage"; readonly passage: Passage } | { readonly kind: "frame"; readonly entry: FrameEntry };

type SnapshotRow = {
  evidence_id: string; kind: "passage" | "frame"; source_id: string; start_s: number; end_s: number; text: string | null;
  frame_path: string | null; transcript_rev_id: string | null; origin: string | null; width: number | null; height: number | null;
};

const DAY_MS = 86_400_000;
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

function writeAtomic(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${crypto.randomUUID()}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}

function unlinkQuiet(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

const isJpeg = (b: Uint8Array) => b.length > JPEG_MAGIC.length && JPEG_MAGIC.every((m, i) => b[i] === m);

export function createEvidence(db: UserDb, dataDir: string, deps: {
  /** Frame.teaching derives from this lookup: yes→kept, no→dropped, uncertain/failed→uncertain (kept). */
  lookupFrameChange(input: FrameChangeInput): Lookup<Verdict>;
  runFrameChange(input: FrameChangeInput, signal: AbortSignal): Promise<unknown>;
  frameChangeKey(input: FrameChangeInput): MemoKey;
  onChange(): void;
  /** Clock for received and created timestamps. Defaults to Date.now. */
  now?: () => number;
}): EvidenceStoreWithProbe {
  const now = deps.now ?? Date.now;
  const userId = db.userId;
  const abs = (rel: string) => join(dataDir, rel);

  let projections = new Map<CaptureId, Projection>();
  let captureIds: CaptureId[] | null = null;
  let rawIndex: Map<EvidenceId, Raw> | null = null;
  const invalidate = () => {
    projections = new Map();
    captureIds = null;
    rawIndex = null;
  };

  const loadFacts = db.sql.query<
    { seq: number; client_seq: number; wall_ms: number; body_json: string; has_bytes: number },
    [string, string]
  >(
    `SELECT c.seq, c.client_seq, c.wall_ms, c.body_json,
            CASE WHEN EXISTS (SELECT 1 FROM frames f WHERE f.user_id = c.user_id AND f.seq = c.seq) THEN 1 ELSE 0 END AS has_bytes
     FROM capture_facts c WHERE c.user_id = ? AND c.capture_id = ? ORDER BY c.client_seq`,
  );

  function project(captureId: CaptureId): Projection {
    const hit = projections.get(captureId);
    if (hit) return hit;
    const stored: StoredFact[] = loadFacts.all(userId, captureId).map((r) => {
      const { jpegOk, ...body } = JSON.parse(r.body_json) as { kind: CaptureFact["kind"]; jpegOk?: boolean };
      const fact = { captureId, clientSeq: r.client_seq, wallMs: r.wall_ms, ...body, ...(body.kind === "frame" ? { jpegBase64: "" } : {}) } as CaptureFact;
      return { seq: asSeq(r.seq), fact, hasBytes: r.has_bytes === 1, jpeg: jpegOk === true };
    });
    const p = foldCapture(captureId, stored);
    projections.set(captureId, p);
    return p;
  }

  function allCaptureIds(): CaptureId[] {
    captureIds ??= db.sql.query<{ capture_id: string }, [string]>("SELECT DISTINCT capture_id FROM capture_facts WHERE user_id = ?").all(userId).map((r) => r.capture_id as CaptureId);
    return captureIds;
  }

  const allProjections = () => allCaptureIds().map(project);

  function deleted(): ReadonlyMap<string, number> {
    return new Map(
      db.sql
        .query<{ evidence_id: string; deleted_ms: number }, [string]>("SELECT evidence_id, deleted_ms FROM evidence_deletions WHERE user_id = ?")
        .all(userId)
        .map((r) => [r.evidence_id, r.deleted_ms]),
    );
  }

  function raw(): Map<EvidenceId, Raw> {
    if (rawIndex) return rawIndex;
    const index = new Map<EvidenceId, Raw>();
    for (const p of allProjections()) {
      for (const w of p.passages) if (!index.has(w.passage.id)) index.set(w.passage.id, { kind: "passage", passage: w.passage });
      for (const entry of p.frames) if (!index.has(entry.frame.id)) index.set(entry.frame.id, { kind: "frame", entry });
    }
    rawIndex = index;
    return index;
  }

  const withBytes = (e: FrameEntry) => ({ frame: e.frame, bytes: (): Uint8Array => bytes(e.frame.id) ?? new Uint8Array() });

  /** Inputs carry teaching "unjudged" so they are a pure function of the evidence, not of memo state. */
  function inputOf(e: FrameEntry): FrameChangeInput {
    return { before: e.before ? withBytes(e.before) : null, after: withBytes(e), nearbyPassages: e.nearby };
  }

  /** "Uncertain visual → keep the frame." */
  function judge(e: FrameEntry): { readonly teaching: FrameTeaching; readonly input: FrameChangeInput | null } {
    if (!e.before) return { teaching: "kept", input: null };
    const input = inputOf(e);
    const found = deps.lookupFrameChange(input);
    if (found.kind === "hit") return { teaching: found.value === "yes" ? "kept" : found.value === "no" ? "dropped" : "uncertain", input };
    return { teaching: found.kind === "failed" ? "uncertain" : "unjudged", input };
  }

  const withTeaching = (e: FrameEntry): Frame => ({ ...e.frame, teaching: judge(e).teaching });

  const frameRow = db.sql.query<{ path: string }, [string, string]>("SELECT path FROM frames WHERE user_id = ? AND evidence_id = ?");
  const snapshotRow = db.sql.query<SnapshotRow, [string, string]>(
    `SELECT evidence_id, kind, source_id, start_s, end_s, text, frame_path, transcript_rev_id, origin, width, height
     FROM evidence_snapshots WHERE user_id = ? AND evidence_id = ?`,
  );
  const frameOf = (id: string) => frameRow.get(userId, id);
  const snapshotOf = (id: string) => snapshotRow.get(userId, id);

  function bytes(id: EvidenceId): Uint8Array | null {
    if (deleted().has(id)) return null;
    const path = frameOf(id)?.path ?? snapshotOf(id)?.frame_path ?? null;
    if (path === null || !existsSync(abs(path))) return null;
    return new Uint8Array(readFileSync(abs(path)));
  }

  function fromSnapshot(s: SnapshotRow): Evidence {
    const sourceId = s.source_id as SourceId;
    if (s.kind === "passage") {
      return {
        kind: "passage", id: s.evidence_id as EvidenceId, sourceId, transcriptRevId: s.transcript_rev_id as TranscriptRevId,
        interval: { start: s.start_s as MediaSeconds, end: s.end_s as MediaSeconds }, text: s.text!, origin: s.origin as TranscriptOrigin,
      } as Passage;
    }
    return {
      kind: "frame", id: s.evidence_id as EvidenceId, sourceId, mediaS: s.start_s as MediaSeconds, width: s.width!, height: s.height!, teaching: "kept",
    } as Frame;
  }

  function ackedThrough(captureId: CaptureId): number {
    const start = db.sql
      .query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM capture_facts WHERE user_id = ? AND capture_id = ? AND client_seq = 0")
      .get(userId, captureId);
    if (!start || start.n === 0) return -1;
    const end = db.sql
      .query<{ end: number }, [string, string]>(
        `SELECT MIN(a.client_seq) AS end FROM capture_facts a
         WHERE a.user_id = ? AND a.capture_id = ?
           AND NOT EXISTS (SELECT 1 FROM capture_facts b WHERE b.user_id = a.user_id AND b.capture_id = a.capture_id AND b.client_seq = a.client_seq + 1)`,
      )
      .get(userId, captureId);
    return end!.end;
  }

  const insertFact = db.sql.query(
    "INSERT INTO capture_facts (user_id, seq, capture_id, client_seq, wall_ms, kind, body_json, received_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertFrame = db.sql.query(
    `INSERT INTO frames (user_id, evidence_id, capture_id, source_id, frame_id, media_s, width, height, path, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  );
  const otherOwner = db.sql.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM capture_owners WHERE capture_id = ? AND user_id <> ?");
  const claimCapture = db.sql.query("INSERT INTO capture_owners (capture_id, user_id, claimed_ms) VALUES (?, ?, ?) ON CONFLICT DO NOTHING");

  const pathInUse = db.sql.query<{ n: number }, [string, string]>(
    "SELECT (SELECT COUNT(*) FROM frames WHERE path = ?) + (SELECT COUNT(*) FROM evidence_snapshots WHERE frame_path = ?) AS n",
  );
  /** Paths carry the user id, so two users never share one. This still refuses to unlink a file any row, of any user, points at. */
  const unlinkUnreferenced = (paths: readonly string[]) => {
    for (const p of paths) if (pathInUse.get(p, p)!.n === 0) unlinkQuiet(abs(p));
  };

  const store: EvidenceStoreWithProbe = {
    ingest(batch) {
      const { captureId } = batch;
      for (const f of batch.facts) {
        if (f.captureId !== captureId) throw new RangeError(`ingest: fact ${f.clientSeq} belongs to ${f.captureId}, not ${captureId}`);
      }
      // A read-only early refusal so no file is written for a capture that is not this user's. The claim itself is in the transaction below.
      if (store.capturedByAnotherUser(captureId)) throw new RangeError(`ingest: capture ${captureId} belongs to another user`);
      const have = new Set(
        db.sql
          .query<{ client_seq: number }, [string, string]>("SELECT client_seq FROM capture_facts WHERE user_id = ? AND capture_id = ?")
          .all(userId, captureId)
          .map((r) => r.client_seq),
      );
      const fresh: CaptureFact[] = [];
      for (const f of batch.facts) {
        if (have.has(f.clientSeq)) continue;
        have.add(f.clientSeq);
        fresh.push(f);
      }

      const dead = deleted();
      const frames = new Map<number, { readonly id: EvidenceId; readonly path: string; readonly stored: boolean; readonly jpeg: boolean }>();
      const claimed = new Set<EvidenceId>();
      for (const f of fresh) {
        if (f.kind !== "frame") continue;
        const sourceId = stableId("src", "youtube", f.videoId);
        const id = stableId("ev", captureId, f.frameId);
        const path = join("frames", userId, sourceId, `${id}.jpg`);
        const decoded = new Uint8Array(Buffer.from(f.jpegBase64, "base64"));
        const jpeg = isJpeg(decoded);
        // A resent frameId keeps the first bytes: the file is written only for an id with no row yet.
        const stored = jpeg && !dead.has(id) && !claimed.has(id) && frameOf(id) === null;
        if (stored) {
          claimed.add(id);
          writeAtomic(abs(path), decoded);
        }
        frames.set(f.clientSeq, { id, path, stored, jpeg });
      }

      const at = now();
      db.tx(() => {
        // The claim commits or rolls back with the rows. It outlives the capture's facts, so expiry never frees a capture id.
        claimCapture.run(captureId, userId, at);
        if (store.capturedByAnotherUser(captureId)) throw new RangeError(`ingest: capture ${captureId} belongs to another user`);
        for (const f of fresh) {
          const body: Record<string, unknown> = { ...f };
          delete body.captureId;
          delete body.clientSeq;
          delete body.wallMs;
          delete body.jpegBase64;
          if (f.kind === "frame") body.jpegOk = frames.get(f.clientSeq)!.jpeg;
          const seq = db.nextSeq();
          insertFact.run(userId, seq, captureId, f.clientSeq, f.wallMs, f.kind, JSON.stringify(body), at);
          const frame = frames.get(f.clientSeq);
          if (f.kind === "frame" && frame?.stored) {
            insertFrame.run(userId, frame.id, captureId, stableId("src", "youtube", f.videoId), f.frameId, f.mediaS, f.width, f.height, frame.path, seq);
          }
        }
      });
      if (fresh.length > 0) {
        invalidate();
        deps.onChange();
      }
      return { ackedThroughSeq: ackedThrough(captureId) };
    },

    captureView(captureId) {
      const p = project(captureId);
      return {
        captureId, status: p.status, sources: p.sources, currentSourceId: p.currentSourceId, transcript: p.transcript, health: p.health,
        watchedSeconds: Material.duration(p.watched),
      };
    },

    captures() {
      return db.sql
        .query<{ capture_id: string }, [string]>("SELECT capture_id FROM capture_facts WHERE user_id = ? GROUP BY capture_id ORDER BY MAX(seq) DESC")
        .all(userId)
        .map((r) => r.capture_id as CaptureId);
    },

    activeCaptures() {
      return db.sql
        .query<{ capture_id: string; body_json: string }, [string]>(
          `SELECT capture_id, body_json FROM capture_facts c
           WHERE user_id = ? AND kind = 'control'
             AND client_seq = (SELECT MAX(x.client_seq) FROM capture_facts x WHERE x.user_id = c.user_id AND x.capture_id = c.capture_id AND x.kind = 'control')
           ORDER BY capture_id`,
        )
        .all(userId)
        .filter((r) => (JSON.parse(r.body_json) as { action?: string }).action !== "stop")
        .map((r) => r.capture_id as CaptureId);
    },

    capturedByAnotherUser: (captureId) => otherOwner.get(captureId, userId)!.n > 0,

    heldByAnotherUser(ids) {
      const held = (table: string, id: string, op: "=" | "<>") =>
        db.sql.query<{ n: number }, [string, string]>(`SELECT COUNT(*) AS n FROM ${table} WHERE evidence_id = ? AND user_id ${op} ?`).get(id, userId)!.n > 0;
      const index = raw();
      return ids.some((id) => {
        const others = held("frames", id, "<>") || held("evidence_snapshots", id, "<>") || held("evidence_deletions", id, "<>");
        const mine = index.has(id) || held("frames", id, "=") || held("evidence_snapshots", id, "=") || held("evidence_deletions", id, "=");
        return others && !mine;
      });
    },

    watchOrder(captureId) {
      const p = project(captureId);
      const dead = deleted();
      return {
        passages: p.passages.filter((w) => !dead.has(w.passage.id)),
        frameCandidates: p.frames.filter((e) => !dead.has(e.frame.id)).map(withTeaching),
        status: p.status,
        stoppedAtSeq: p.stoppedAtSeq,
        watchedSeconds: Material.duration(p.watched),
      };
    },

    bundle(material) {
      const dead = deleted();
      const scope = selectScope(allProjections(), material);
      const passages = new Map<EvidenceId, Passage>();
      const frames = new Map<EvidenceId, Frame>();
      const ads = new Map<string, AdRecord>();
      const gaps: Gap[] = [];
      for (const p of scope) {
        for (const w of p.passages) {
          if (!dead.has(w.passage.id) && Material.covers(material, w.passage.sourceId, w.passage.interval)) passages.set(w.passage.id, w.passage);
        }
        for (const e of p.frames) {
          if (dead.has(e.frame.id) || frames.has(e.frame.id) || !frameInside(material, e.frame)) continue;
          const frame = withTeaching(e);
          if (frame.teaching === "kept" || frame.teaching === "uncertain") frames.set(frame.id, frame);
        }
        for (const g of p.gaps) gaps.push(...clipGap(material, g));
        for (const a of p.ads) if (adInside(material, a)) ads.set(`${a.sourceId}|${a.atContentS}|${a.wallDurationMs}`, a);
      }
      return {
        material,
        passages: [...passages.values()].sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : a.interval.start - b.interval.start)),
        frames: [...frames.values()].sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : a.mediaS - b.mediaS)),
        gaps: dedupeGaps(gaps),
        ads: [...ads.values()],
      };
    },

    get(ids) {
      const dead = deleted();
      const index = raw();
      const out = new Map<EvidenceId, Evidence | DeletedEvidence>();
      for (const id of ids) {
        const at = dead.get(id);
        if (at !== undefined) {
          out.set(id, { kind: "deleted", id, deletedAtMs: at });
          continue;
        }
        const hit = index.get(id);
        if (hit) {
          out.set(id, hit.kind === "passage" ? hit.passage : withTeaching(hit.entry));
          continue;
        }
        const snap = snapshotOf(id);
        if (snap) out.set(id, fromSnapshot(snap));
      }
      return out;
    },

    frameBytes: bytes,

    frameDemand(captureId) {
      const dead = deleted();
      const items: WorkItem[] = [];
      for (const e of project(captureId).frames) {
        if (dead.has(e.frame.id)) continue;
        const { teaching, input } = judge(e);
        if (teaching !== "unjudged" || input === null) continue;
        items.push({ key: deps.frameChangeKey(input), purpose: "frame_change", provider: "jev", run: (signal) => deps.runFrameChange(input, signal) });
      }
      return items;
    },

    snapshotInTx(ids) {
      db.tx(() => {
        const dead = deleted();
        for (const id of ids) {
          if (dead.has(id) || snapshotOf(id)) continue;
          const hit = raw().get(id);
          if (!hit) throw new RangeError(`snapshotInTx: no evidence ${id}`);
          if (hit.kind === "passage") {
            const p = hit.passage;
            db.sql.run(
              `INSERT INTO evidence_snapshots (user_id, evidence_id, kind, source_id, start_s, end_s, text, frame_path, created_ms, transcript_rev_id, origin)
               VALUES (?, ?, 'passage', ?, ?, ?, ?, NULL, ?, ?, ?) ON CONFLICT DO NOTHING`,
              [userId, id, p.sourceId, p.interval.start, p.interval.end, p.text, now(), p.transcriptRevId, p.origin],
            );
            continue;
          }
          const f = hit.entry.frame;
          const source = frameOf(id)!.path;
          const link = join("snapshots", userId, `${id}.jpg`);
          mkdirSync(dirname(abs(link)), { recursive: true });
          if (!existsSync(abs(link))) {
            try {
              linkSync(abs(source), abs(link));
            } catch {
              copyFileSync(abs(source), abs(link));
            }
          }
          db.sql.run(
            `INSERT INTO evidence_snapshots (user_id, evidence_id, kind, source_id, start_s, end_s, text, frame_path, created_ms, width, height)
             VALUES (?, ?, 'frame', ?, ?, ?, NULL, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
            [userId, id, f.sourceId, f.mediaS, f.mediaS, link, now(), f.width, f.height],
          );
        }
      });
    },

    deleteByUser(ids, requestId) {
      const files: string[] = [];
      const index = raw();
      const existing = new Set(ids.filter((id) => index.has(id) || frameOf(id) !== null || snapshotOf(id) !== null));
      db.tx(() => {
        const exists = db.sql.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM evidence_deletions WHERE user_id = ? AND evidence_id = ?");
        for (const id of ids) {
          if (!existing.has(id)) continue;
          if (exists.get(userId, id)!.n === 0) {
            db.sql.run("INSERT INTO evidence_deletions (user_id, evidence_id, request_id, deleted_ms, seq) VALUES (?, ?, ?, ?, ?)", [userId, id, requestId, now(), db.nextSeq()]);
          }
          const snapshots = db.sql.query<{ frame_path: string | null }, [string, string]>("DELETE FROM evidence_snapshots WHERE user_id = ? AND evidence_id = ? RETURNING frame_path");
          for (const r of snapshots.all(userId, id)) {
            if (r.frame_path !== null) files.push(r.frame_path);
          }
          for (const r of db.sql.query<{ path: string }, [string, string]>("DELETE FROM frames WHERE user_id = ? AND evidence_id = ? RETURNING path").all(userId, id)) files.push(r.path);
        }
      });
      unlinkUnreferenced(files);
      invalidate();
      deps.onChange();
    },

    sweepExpired(nowMs, retentionDays) {
      const cutoff = nowMs - retentionDays * DAY_MS;
      const files: string[] = [];
      let framesDeleted = 0;
      let factsDeleted = 0;
      let snapshotsDeleted = 0;
      db.tx(() => {
        const expired = db.sql
          .query<{ capture_id: string }, [string, number]>(
            `SELECT capture_id FROM capture_facts
             WHERE user_id = ?
             GROUP BY capture_id
             HAVING MAX(received_ms) < ?
               AND NOT EXISTS (
                 SELECT 1 FROM reviews r
                 WHERE r.user_id = capture_facts.user_id AND r.capture_id = capture_facts.capture_id
                   AND NOT EXISTS (SELECT 1 FROM saved_reviews s WHERE s.review_id = r.id))`,
          )
          .all(userId, cutoff);
        for (const { capture_id } of expired) {
          for (const r of db.sql.query<{ path: string }, [string, string]>("DELETE FROM frames WHERE user_id = ? AND capture_id = ? RETURNING path").all(userId, capture_id)) {
            files.push(r.path);
            framesDeleted++;
          }
          factsDeleted += db.sql.query<{ seq: number }, [string, string]>("DELETE FROM capture_facts WHERE user_id = ? AND capture_id = ? RETURNING seq").all(userId, capture_id).length;
        }
        const gone = db.sql
          .query<{ frame_path: string | null }, [string, number]>(
            `DELETE FROM evidence_snapshots
             WHERE user_id = ? AND created_ms < ?
               AND NOT EXISTS (
                 SELECT 1 FROM note_evidence ne
                 WHERE ne.evidence_id = evidence_snapshots.evidence_id
                   AND NOT EXISTS (SELECT 1 FROM note_deletions nd WHERE nd.note_id = ne.note_id))
             RETURNING frame_path`,
          )
          .all(userId, cutoff);
        snapshotsDeleted = gone.length;
        for (const r of gone) if (r.frame_path !== null) files.push(r.frame_path);
      });
      unlinkUnreferenced(files);

      // Files are one namespace for every user, so an orphan is a file no user's row points at. Filtering by this user
      // here would delete the other users' frames.
      const referenced = new Set<string>([
        ...db.sql.query<{ path: string }, []>("SELECT path FROM frames").all().map((r) => r.path),
        ...db.sql.query<{ p: string }, []>("SELECT frame_path AS p FROM evidence_snapshots WHERE frame_path IS NOT NULL").all().map((r) => r.p),
      ]);
      for (const root of ["frames", "snapshots"]) {
        if (!existsSync(abs(root))) continue;
        for (const rel of readdirSync(abs(root), { recursive: true }) as string[]) {
          const path = join(root, rel);
          if (!referenced.has(path) && statSync(abs(path)).isFile() && unlinkQuiet(abs(path))) framesDeleted++;
        }
      }
      invalidate();
      return { framesDeleted, factsDeleted, snapshotsDeleted };
    },

    watchedMaterial: (captureId) => project(captureId).watched,

    captureBundle(captureId) {
      const p = project(captureId);
      const dead = deleted();
      return bundleToJson(
        {
          material: p.watched,
          passages: p.passages.map((w) => w.passage).filter((x) => !dead.has(x.id)),
          frames: p.frames.filter((e) => !dead.has(e.frame.id)).map(withTeaching),
          gaps: p.gaps,
          ads: p.ads,
        },
        { captureId, status: p.status, fileOf: (id) => { const row = frameOf(id); return row ? abs(row.path) : null; } },
      );
    },
  };
  return store;
}

export type { EvidenceBundleJson };
