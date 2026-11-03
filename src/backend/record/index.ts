/**
 * Local learning record (W8). Owns: notes (generated), note_edits (user),
 * note_deletions (user), note_evidence, observations (proposed status),
 * observation_decisions (user: dispute resolutions, overrides),
 * link_suggestions, link_decisions (user), saved_reviews.
 *
 * Per-actor tables, merged at read: the save writes only generated columns;
 * the user writes only *_edits / *_deletions / *_decisions.
 * R8: "Results from cancelled or outdated jobs never overwrite current preparation or my notes."
 * Nothing a job or the tutor produces can reach a user table.
 *
 * R15: "Retrying a save never creates a duplicate record."
 * Every row ID is stableId(...) of what it names; save is
 * INSERT … ON CONFLICT(id) DO UPDATE SET <generated columns only>, one
 * transaction, skipping tombstoned notes. A failed save keeps its bundle as
 * the pending save, and the retry writes that bundle verbatim. Across a
 * restart the pending bundle is rebuilt from durable inputs (turns, the
 * wrap-up memo), which gives the same bundle. Pending = no saved_reviews row.
 * While a review has no saved_reviews row, db.ts triggers hold its capture's
 * raw evidence (R16, pending saves count as citing).
 *
 *   const r = await record.save(reviewId);    // { kind: "saved" } | { kind: "save_failed", retryable }
 *   record.editNote(noteId, "my wording");
 *   record.resolveDispute(obsId, "it_was_my_gap");
 */
import type { ConceptId, EvidenceId, LinkId, NoteId, ObservationId, ReviewId, ThreadId } from "../../shared/ids";
import type {
  AssessableClaim, DeletedEvidence, DisputeState, LinkDecision, NoteSegment, Observation, ObservationStatus, RecordView, SaveResult,
  SubjectLinkSuggestion, ThreadFacts, Turn,
} from "../../shared/domain";
import type { WrapUpOutput } from "../review/tutor";
import { clampStatus, threadDispute } from "../review/clamp";
import type { Db } from "../db";
import { buildBundle, correctionsByThread } from "./core";
import type { RecordBundle } from "./core";

export type { RecordBundle } from "./core";

export type LearningRecord = {
  save(reviewId: ReviewId): Promise<SaveResult>;
  view(filter: { readonly reviewId?: ReviewId; readonly conceptId?: ConceptId }): RecordView;
  editNote(id: NoteId, text: string): void;
  /** Tombstone in note_deletions; the snapshot it cited becomes sweepable (R16 trigger). */
  deleteNote(id: NoteId): void;
  decideLink(id: LinkId, decision: LinkDecision): void;
  /**
   * R14: "A disputed assessment is never counted as a learning gap unless I resolve it that way."
   * The ONLY producer of resolved_by_learner.
   */
  resolveDispute(id: ObservationId, outcome: "learner_was_right" | "it_was_my_gap"): void;
  /** User correction of a status. Still clamped by clampStatus. */
  overrideObservation(id: ObservationId, status: ObservationStatus): void;
};

type NoteRow = { id: string; review_id: string; concept_id: string; generated_json: string; user_edit: string | null };
type ObservationRow = {
  id: string; review_id: string; thread_id: string; claim_ids_json: string; concept_ids_json: string; proposed: ObservationStatus;
  facts_json: string; resolution: "learner_was_right" | "it_was_my_gap" | null; override: ObservationStatus | null;
};
type LinkRow = { id: string; from_concept: string; to_concept: string; type: SubjectLinkSuggestion["type"]; evidence_json: string; rationale: string; decision_json: string | null };

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export function createRecord(db: Db, deps: {
  turns(reviewId: ReviewId): readonly Turn[];
  claims(reviewId: ReviewId): readonly AssessableClaim[];
  wrapUp(reviewId: ReviewId): Promise<WrapUpOutput>; // memo-backed; a retried save reuses the same proposal
  snapshotEvidenceInTx(ids: readonly EvidenceId[]): void;
  /** preparation.linkSuggestions over the review's concepts. Optional until composition wires it. */
  links?(conceptIds: readonly ConceptId[]): readonly SubjectLinkSuggestion[];
}): LearningRecord {
  const now = () => Date.now();
  const pending = new Map<ReviewId, RecordBundle>();

  const q = {
    tombstoned: db.sql.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM note_deletions WHERE note_id = ?`),
    upsertNote: db.sql.query(
      `INSERT INTO notes (id, review_id, concept_id, generated_json, saved_ms) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (id) DO UPDATE SET generated_json = excluded.generated_json`,
    ),
    // Add-only: a re-save never drops a citation, so it never releases evidence the note once held (R16).
    noteEvidence: db.sql.query(`INSERT OR IGNORE INTO note_evidence (note_id, evidence_id) VALUES (?, ?)`),
    upsertObservation: db.sql.query(
      `INSERT INTO observations (id, review_id, thread_id, claim_ids_json, concept_ids_json, proposed, facts_json, saved_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (id) DO UPDATE SET claim_ids_json = excluded.claim_ids_json, concept_ids_json = excluded.concept_ids_json,
         proposed = excluded.proposed, facts_json = excluded.facts_json`,
    ),
    upsertLink: db.sql.query(
      `INSERT INTO link_suggestions (id, review_id, from_concept, to_concept, type, evidence_json, rationale, saved_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (id) DO UPDATE SET evidence_json = excluded.evidence_json, rationale = excluded.rationale`,
    ),
    markSaved: db.sql.query(
      `INSERT INTO saved_reviews (review_id, bundle_hash, saved_ms) VALUES (?1, ?2, ?3)
       ON CONFLICT (review_id) DO UPDATE SET bundle_hash = excluded.bundle_hash, saved_ms = excluded.saved_ms`,
    ),
    editNote: db.sql.query(
      `INSERT INTO note_edits (note_id, text, edited_ms) VALUES (?1, ?2, ?3)
       ON CONFLICT (note_id) DO UPDATE SET text = excluded.text, edited_ms = excluded.edited_ms`,
    ),
    deleteNote: db.sql.query(`INSERT OR IGNORE INTO note_deletions (note_id, deleted_ms) VALUES (?, ?)`),
    decideLink: db.sql.query(
      `INSERT INTO link_decisions (link_id, decision_json, decided_ms) VALUES (?1, ?2, ?3)
       ON CONFLICT (link_id) DO UPDATE SET decision_json = excluded.decision_json, decided_ms = excluded.decided_ms`,
    ),
    decideObservation: db.sql.query(
      `INSERT INTO observation_decisions (observation_id, kind, value, decided_ms) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (observation_id, kind) DO UPDATE SET value = excluded.value, decided_ms = excluded.decided_ms`,
    ),
    notes: db.sql.query<NoteRow, [string | null, string | null]>(
      `SELECT n.id, n.review_id, n.concept_id, n.generated_json, e.text AS user_edit
       FROM notes n LEFT JOIN note_edits e ON e.note_id = n.id
       WHERE NOT EXISTS (SELECT 1 FROM note_deletions d WHERE d.note_id = n.id)
         AND (?1 IS NULL OR n.review_id = ?1) AND (?2 IS NULL OR n.concept_id = ?2)
       ORDER BY n.rowid`,
    ),
    noteEvidenceOf: db.sql.query<{ evidence_id: string }, [string]>(`SELECT evidence_id FROM note_evidence WHERE note_id = ? ORDER BY evidence_id`),
    deletedEvidence: db.sql.query<{ evidence_id: string; deleted_ms: number }, [string]>(
      `SELECT evidence_id, deleted_ms FROM evidence_deletions WHERE evidence_id IN (SELECT value FROM json_each(?)) ORDER BY evidence_id`,
    ),
    observations: db.sql.query<ObservationRow, [string | null, string | null]>(
      `SELECT o.id, o.review_id, o.thread_id, o.claim_ids_json, o.concept_ids_json, o.proposed, o.facts_json,
         (SELECT value FROM observation_decisions WHERE observation_id = o.id AND kind = 'dispute_resolution') AS resolution,
         (SELECT value FROM observation_decisions WHERE observation_id = o.id AND kind = 'override') AS override
       FROM observations o
       WHERE (?1 IS NULL OR o.review_id = ?1)
         AND (?2 IS NULL OR EXISTS (SELECT 1 FROM json_each(o.concept_ids_json) WHERE value = ?2))
       ORDER BY o.rowid`,
    ),
    links: db.sql.query<LinkRow, [string | null, string | null]>(
      `SELECT l.id, l.from_concept, l.to_concept, l.type, l.evidence_json, l.rationale, d.decision_json
       FROM link_suggestions l LEFT JOIN link_decisions d ON d.link_id = l.id
       WHERE (?1 IS NULL OR l.review_id = ?1) AND (?2 IS NULL OR l.from_concept = ?2 OR l.to_concept = ?2)
       ORDER BY l.rowid`,
    ),
  };

  async function bundleFor(reviewId: ReviewId): Promise<RecordBundle> {
    const held = pending.get(reviewId);
    if (held) return held;
    const turns = deps.turns(reviewId);
    const claims = deps.claims(reviewId);
    const wrapUp = await deps.wrapUp(reviewId);
    const concepts = [...new Set(claims.map((c) => c.conceptId))].sort();
    return buildBundle(reviewId, turns, claims, wrapUp, deps.links?.(concepts) ?? []);
  }

  function write(reviewId: ReviewId, b: RecordBundle): SaveResult {
    return db.tx(() => {
      const ms = now();
      let notes = 0;
      for (const n of b.notes) {
        if (q.tombstoned.get(n.id)!.n > 0) continue;
        q.upsertNote.run(n.id, n.reviewId, n.conceptId, JSON.stringify(n.generated), ms);
        for (const e of n.evidence) q.noteEvidence.run(n.id, e);
        notes += 1;
      }
      for (const o of b.observations) {
        q.upsertObservation.run(o.id, o.reviewId, o.threadId, JSON.stringify(o.claimIds), JSON.stringify(o.conceptIds), o.proposed, JSON.stringify(o.facts), ms);
      }
      for (const l of b.links) q.upsertLink.run(l.id, reviewId, l.from, l.to, l.type, JSON.stringify(l.evidence), l.rationale, ms);
      deps.snapshotEvidenceInTx(b.evidence);
      // Last, so the R16 hold on raw evidence lifts only once the snapshots exist.
      q.markSaved.run(reviewId, b.hash, ms);
      return { kind: "saved", notes, observations: b.observations.length, links: b.links.length } as const;
    });
  }

  async function save(reviewId: ReviewId): Promise<SaveResult> {
    let bundle: RecordBundle;
    try {
      bundle = await bundleFor(reviewId);
    } catch (err) {
      return { kind: "save_failed", error: errorMessage(err), retryable: true };
    }
    try {
      const result = write(reviewId, bundle);
      pending.delete(reviewId);
      return result;
    } catch (err) {
      pending.set(reviewId, bundle);
      return { kind: "save_failed", error: errorMessage(err), retryable: true };
    }
  }

  function view(filter: { readonly reviewId?: ReviewId; readonly conceptId?: ConceptId }): RecordView {
    const reviewId = filter.reviewId ?? null;
    const conceptId = filter.conceptId ?? null;

    const notes = q.notes.all(reviewId, conceptId).map((r) => ({
      id: r.id as NoteId,
      reviewId: r.review_id as ReviewId,
      conceptId: r.concept_id as ConceptId,
      generated: JSON.parse(r.generated_json) as NoteSegment[],
      userEdit: r.user_edit,
      evidence: q.noteEvidenceOf.all(r.id).map((e) => e.evidence_id as EvidenceId),
    }));

    const turnsByReview = new Map<ReviewId, readonly Turn[]>();
    const turnsOf = (id: ReviewId) => {
      let t = turnsByReview.get(id);
      if (!t) turnsByReview.set(id, (t = deps.turns(id)));
      return t;
    };
    const observations = q.observations.all(reviewId, conceptId).map((r): Observation => {
      const rid = r.review_id as ReviewId;
      const threadId = r.thread_id as ThreadId;
      const turns = turnsOf(rid);
      const fromTurns = threadDispute(threadId, turns);
      const dispute: DisputeState = fromTurns.kind !== "none" && r.resolution !== null ? { kind: "resolved_by_learner", outcome: r.resolution } : fromTurns;
      const facts = JSON.parse(r.facts_json) as ThreadFacts;
      const { status, clampedFrom } = clampStatus(r.override ?? r.proposed, facts, dispute);
      return {
        id: r.id as ObservationId,
        reviewId: rid,
        threadId,
        claimIds: JSON.parse(r.claim_ids_json) as Observation["claimIds"],
        conceptIds: JSON.parse(r.concept_ids_json) as ConceptId[],
        proposed: r.proposed,
        status,
        clampedFrom,
        dispute,
        corrections: correctionsByThread(turns).get(threadId) ?? [],
        facts,
      };
    });

    const links = q.links.all(reviewId, conceptId).map((r) => ({
      id: r.id as LinkId,
      from: r.from_concept as ConceptId,
      to: r.to_concept as ConceptId,
      type: r.type,
      evidence: JSON.parse(r.evidence_json) as EvidenceId[],
      rationale: r.rationale,
      decision: r.decision_json === null ? ("suggested" as const) : (JSON.parse(r.decision_json) as LinkDecision),
    }));

    const cited = [...new Set(notes.flatMap((n) => n.evidence))];
    const unavailableEvidence: DeletedEvidence[] = q.deletedEvidence
      .all(JSON.stringify(cited))
      .map((r) => ({ kind: "deleted", id: r.evidence_id as EvidenceId, deletedAtMs: r.deleted_ms }));

    return { notes, observations, links, unavailableEvidence };
  }

  return {
    save,
    view,
    editNote: (id, text) => void q.editNote.run(id, text, now()),
    deleteNote: (id) => void q.deleteNote.run(id, now()),
    decideLink: (id, decision) => void q.decideLink.run(id, JSON.stringify(decision), now()),
    resolveDispute: (id, outcome) => void q.decideObservation.run(id, "dispute_resolution", outcome, now()),
    overrideObservation: (id, status) => void q.decideObservation.run(id, "override", status, now()),
  };
}
