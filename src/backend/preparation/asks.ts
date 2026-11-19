/**
 * The ask record, flow C as amended 2026-11-18: one prep_asks row per ask. Review now or Wait opens one unless the lecture has one
 * open, and the review that starts from it closes it with that review's id, in the review's own transaction. A lecture with any ask
 * is prepared; one with an open ask gets a review once a prepared chunk has a supported claim.
 */
import type { CaptureId, ReviewId } from "../../shared/ids";
import type { LectureAsk } from "../../shared/domain";
import { asSeq } from "../db";
import type { UserDb } from "../db";

export type Asks = {
  /** The learner asked for this lecture's review (Review now or Wait). Opens an ask unless one is open already. */
  ask(captureId: CaptureId): void;
  /** Whether the lecture was ever asked for, so its preparation runs. */
  asked(captureId: CaptureId): boolean;
  /** The lecture's latest ask, or null when nobody asked. */
  latestAsk(captureId: CaptureId): LectureAsk | null;
  /** A review of this lecture started: close its open ask, if any, with that review. Call inside the transaction that stores the review. */
  closeAsk(captureId: CaptureId, reviewId: ReviewId): void;
};

export function createAsks(db: UserDb): Asks {
  const { userId } = db;
  const q = {
    latest: db.sql.query<{ seq: number; closed_ms: number | null; review_id: string | null }, [string, string]>(
      `SELECT seq, closed_ms, review_id FROM prep_asks WHERE user_id = ? AND capture_id = ? ORDER BY seq DESC LIMIT 1`,
    ),
    open: db.sql.query(`INSERT INTO prep_asks (user_id, seq, capture_id, at_ms) VALUES (?, ?, ?, ?)`),
    close: db.sql.query(`UPDATE prep_asks SET closed_ms = ?, review_id = ? WHERE user_id = ? AND capture_id = ? AND closed_ms IS NULL`),
  };

  function latestAsk(captureId: CaptureId): LectureAsk | null {
    const row = q.latest.get(userId, captureId);
    if (row === null) return null;
    return row.closed_ms === null ? { state: "open", seq: asSeq(row.seq) } : { state: "closed", seq: asSeq(row.seq), reviewId: row.review_id as ReviewId | null };
  }

  return {
    // The unique index on open asks backs this check: a lecture never has two.
    ask: (captureId) => db.tx(() => {
      if (latestAsk(captureId)?.state !== "open") q.open.run(userId, db.nextSeq(), captureId, Date.now());
    }),
    asked: (captureId) => latestAsk(captureId) !== null,
    latestAsk,
    closeAsk: (captureId, reviewId) => void q.close.run(Date.now(), reviewId, userId, captureId),
  };
}
