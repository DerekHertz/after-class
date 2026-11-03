// app/screens.tsx -- screen-level components (prop contracts only). Layout/visual design is explicitly NOT decided here (PRD: UX remains open);
// these are the data seams. Each screen takes ONE view model from shared/api/views and callbacks; none computes domain facts.
import type { ReactElement } from "react";
import type { ReviewId } from "../shared/domain/ids";
import type { ChunkInspectView, PrepView, RecordView, ReviewStartView, UsageView } from "../shared/api/views";

/** conversation beside evidence: transcript passages and frames the tutor cited (view.shownEvidence), tombstones rendered as "evidence deleted" */
export function ReviewScreen(p: { readonly reviewId: ReviewId }): ReactElement { throw new Error("not implemented"); }
/** "Processing" with wait / Stop early; estimate shown only when estimateMs != null (reliable) */
export function ProcessingPanel(p: { readonly start: Extract<ReviewStartView, { kind: "processing" }>; readonly onWait: () => void; readonly onStopEarly: () => void }): ReactElement { throw new Error("not implemented"); }
/** gaps + unverified claims WITH their evidence, rewatch-interval and retry actions */
export function NothingToReview(p: { readonly start: Extract<ReviewStartView, { kind: "nothing_to_review" }>; readonly onRetry: () => void }): ReactElement { throw new Error("not implemented"); }
/** inspect / edit / accept-correct links / revisit / delete; learner vs tutor authorship shown on every note; disputed observations flagged */
export function RecordScreen(p: { readonly record: RecordView }): ReactElement { throw new Error("not implemented"); }
/** per-chunk Jev inputs, probabilities, routed row, uncertain outcomes (PRD acceptance demo #2) */
export function ChunkInspector(p: { readonly view: ChunkInspectView; readonly prep: PrepView }): ReactElement { throw new Error("not implemented"); }
/** "$X known + N calls of unknown cost"; notional (subscription) shown separately from measured money */
export function UsageScreen(p: { readonly usage: UsageView }): ReactElement { throw new Error("not implemented"); }
