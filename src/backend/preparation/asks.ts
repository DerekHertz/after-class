/**
 * The ask record, flow C as amended 2026-11-18, built to docs/flows/model/Preparation.tla: one prep_asks row per ask. Review now or Wait
 * opens one unless the lecture has one open. An ask is open until it ends one of two ways: a review starts from it, which closes it with
 * that review's id in the review's own transaction, or nothing can answer it any more, which closes it with no review (exhausted). A
 * lecture with any ask is prepared.
 */
import type { CaptureId, ReviewId } from "../../shared/ids";
import type { LectureAsk, Seq } from "../../shared/domain";
import { asSeq } from "../db";
import type { UserDb } from "../db";

export type Asks = {
  /** The learner asked for this lecture's review (Review now or Wait). Opens an ask unless one is open already, and returns the open ask's seq. */
  ask(captureId: CaptureId): Seq;
  /** Whether the lecture was ever asked for, so its preparation runs. */
  asked(captureId: CaptureId): boolean;
  /** The lecture's latest ask, or null when nobody asked. */
  latestAsk(captureId: CaptureId): LectureAsk | null;
  /** A review of this lecture started: close its open ask, if any, with that review. Call inside the transaction that stores the review. */
  closeAsk(captureId: CaptureId, reviewId: ReviewId): void;
  /** Nothing can answer the lecture's open ask any more: end it exhausted. Does nothing when no ask is open, so it can run on every derivation. */
  exhaust(captureId: CaptureId): void;
  /** The day's review limit refused the review the open ask asked for: end it refused. Does nothing when no ask is open. */
  refuse(captureId: CaptureId): void;
};

export function createAsks(db: UserDb): Asks {
  const { userId } = db;
  const q = {
    latest: db.sql.query<{ seq: number; closed_ms: number | null; review_id: string | null; refused: number }, [string, string]>(
      `SELECT seq, closed_ms, review_id, refused FROM prep_asks WHERE user_id = ? AND capture_id = ? ORDER BY seq DESC LIMIT 1`,
    ),
    open: db.sql.query(`INSERT INTO prep_asks (user_id, seq, capture_id, at_ms) VALUES (?, ?, ?, ?)`),
    close: db.sql.query(`UPDATE prep_asks SET closed_ms = ?, review_id = ?, refused = ? WHERE user_id = ? AND capture_id = ? AND closed_ms IS NULL`),
  };

  function latestAsk(captureId: CaptureId): LectureAsk | null {
    const row = q.latest.get(userId, captureId);
    if (row === null) return null;
    const seq = asSeq(row.seq);
    if (row.closed_ms === null) return { state: "open", seq };
    if (row.refused === 1) return { state: "refused", seq };
    // An ask closed with no review is exhausted, as is a lecture asked under the old flow (004-prep-asks).
    return row.review_id === null ? { state: "exhausted", seq } : { state: "started", seq, reviewId: row.review_id as ReviewId };
  }

  return {
    // The unique index on open asks backs this check: a lecture never has two.
    ask: (captureId) => db.tx(() => {
      const latest = latestAsk(captureId);
      if (latest?.state === "open") return latest.seq;
      const seq = db.nextSeq();
      q.open.run(userId, seq, captureId, Date.now());
      return seq;
    }),
    asked: (captureId) => latestAsk(captureId) !== null,
    latestAsk,
    closeAsk: (captureId, reviewId) => void q.close.run(Date.now(), reviewId, 0, userId, captureId),
    exhaust: (captureId) => void q.close.run(Date.now(), null, 0, userId, captureId),
    refuse: (captureId) => void q.close.run(Date.now(), null, 1, userId, captureId),
  };
}
