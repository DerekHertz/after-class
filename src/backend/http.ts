/**
 * Bun.serve routes (W10, composition phase). Thin shell: authorize → parse
 * (shared/wire.ts) → call one module method → serialize. No business logic here.
 *
 * The backend is reachable from every web page in the browser, so "localhost"
 * is not trusted (SYNTHESIS graft 5). `authorize` requires all of:
 *   1. Host is exactly 127.0.0.1:<port> or localhost:<port>        (blocks DNS rebinding)
 *   2. Origin absent (curl, tests) or in { chrome-extension://<pinned id>, http://127.0.0.1:<port> }
 *   3. Authorization: Bearer <pairing token> (~/.config/afterclass/pairing-token, 0600,
 *      pasted once into the extension options; the review app gets it in its served HTML)
 * CORS preflight answered only for allow-listed origins; never `*`.
 *
 *   POST /ingest                         IngestBatch                 → evidence.ingest
 *   GET  /captures/:id                   CaptureView + InviteState
 *   POST /captures/:id/invite            { answer }                  → reviews.answerInvite
 *   GET  /captures/:id/review-options                                → reviews.options
 *   POST /captures/:id/reviews           { reviewId, choice }        → reviews.start (reviewId app-minted)
 *   POST /reviews/:id/turns              { turnId, act }             → NDJSON TutorStreamEvent
 *   GET  /reviews/:id                                                → reviews.view
 *   POST /reviews/:id/save                                           → record.save
 *   GET  /evidence?material=…            EvidenceBundle (inspection)
 *   GET  /frames/:evidenceId                                         → image/jpeg
 *   GET  /trace/captures/:id             window inputs, judgments, routes (acceptance 2)
 *   GET  /memo/:key                      exact provider input/output
 *   GET  /usage                          UsageSummary
 *   PATCH/POST /record/...               edits, link decisions, dispute resolution, deletion
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

export type AuthConfig = { readonly port: number; readonly extensionId: string; readonly token: string };

/** Pure over request headers; unit-tested. */
export function authorize(headers: Headers, expected: AuthConfig): { readonly ok: true; readonly origin: "extension" | "review_app" | "none" } | { readonly ok: false; readonly status: 401 | 403 } {
  throw new Error("not implemented");
}

export function routes(m: Modules, auth: AuthConfig): Parameters<typeof Bun.serve>[0] {
  throw new Error("not implemented");
}
