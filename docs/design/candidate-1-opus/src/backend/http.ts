/**
 * Bun.serve routes. Thin shell: authenticate → parse (shared/wire.ts) → call one
 * module method → serialize. No business logic here.
 *
 * Auth: Bun.serve binds 127.0.0.1:4317 (Windows Chrome reaches WSL via localhost
 * forwarding). Every mutating route requires `Authorization: Bearer <pairing token>`
 * (~/.config/afterclass/pairing-token, 0600, pasted once into the extension
 * options) AND an Origin of chrome-extension://<id> or the app's own origin.
 * Any other web page that tries localhost gets 403. The review app receives the
 * token in its served HTML (same-origin only).
 *
 *   POST /ingest                         extension facts           → evidence.ingest
 *   GET  /captures/:id                   CaptureView + InviteState
 *   POST /captures/:id/invite            { answer }                → reviews.answerInvite
 *   GET  /captures/:id/review-options                              → reviews.options
 *   POST /captures/:id/reviews           { choice, clientRequestId } → reviews.start
 *   POST /reviews/:id/turns              { clientTurnId, act }      → NDJSON stream of TutorStreamEvent
 *   GET  /reviews/:id                                              → reviews.view
 *   POST /reviews/:id/save                                         → record.save
 *   GET  /evidence?material=…            EvidenceBundle (inspection)
 *   GET  /frames/:evidenceId                                       → image/jpeg
 *   GET  /trace/captures/:id             window inputs, judgments, routes (acceptance 2)
 *   GET  /memo/:key                      exact provider input/output
 *   GET  /usage                          UsageSummary
 *   PATCH/POST /record/...               user edits, link decisions, dispute resolution, deletion
 *   GET  /app/*                          React review app (Bun HTML import)
 *   GET  /events                         SSE: processing/invite changes for the app
 */
import type { EvidenceStore } from "./evidence";
import type { Reviews } from "./review";
import type { LearningRecord } from "./record";
import type { Segmentation } from "./segmentation";
import type { Ledger } from "./providers/ledger";
import type { Memo } from "./providers/memo";

export type Modules = {
  readonly evidence: EvidenceStore;
  readonly segmentation: Segmentation;
  readonly reviews: Reviews;
  readonly record: LearningRecord;
  readonly ledger: Ledger;
  readonly memo: Memo;
};

export function routes(m: Modules, auth: { token: string; extensionOrigin: string }): Parameters<typeof Bun.serve>[0] {
  throw new Error("not implemented");
}
