# Module map

Each workstream owns its files and nothing else. Everything in the "Frozen" column is a contract: other workstreams build against it now, so a change goes through W10. Bodies marked `throw new Error("not implemented")` are yours to fill in. Keep the exported signatures.

| Module | Owner | Owned files | Owned tables | Frozen exports |
| --- | --- | --- | --- | --- |
| Kernel | W10 | `src/shared/*`, `src/backend/db.ts`, `src/backend/providers/memo.ts`, `test/fakes.ts`, `test/boundaries.test.ts`, `test/{ids,time,wire,db,memo,rules}.test.ts` | `schema_migrations`, `seq_counter`, `users` | everything in `shared/` (`domain.ts` types, `ids.ts`, `time.ts`, `wire.ts` schemas, `parse*`, `ROUTES`, `Route`, `routeUrl`, `matchRoute`, `encodeMaterial`, `decodeMaterial`), `Db`, `UserDb`, `openDb`, `scopeDb`, `ensureLocalUser`, `LOCAL_USER`, `TABLE_SCOPES`, `asSeq`, `MIGRATIONS`, `tableOwners`, `Task`, `Lookup`, `LookupFn`, `Memo`, `UsageReport`, `ProviderError`, `ReplayMiss`, `appliesBefore`, `createMemo` |
| Composition | W10 (after W1 to W9) | `src/backend/http.ts`, `src/backend/main.ts`, `src/backend/scheduler.ts` | none | `WorkItem`, `Scheduler`, `Modules`, `AuthConfig`, `authorize` |
| Playback and frames | W1 | `src/extension/content/capture.ts`, `src/extension/content/frames.ts` | none | `Emit`, `ControlMessage`, `ContentSignal`, `PlaybackTracker`, `AdSignals`, `isAdShowing`, `FrameSamplerConfig`, `FrameSampler`, `normalizedSize` |
| Transcripts, worker, popup, build | W2 | `src/extension/content/transcript.ts`, `src/extension/content/main-world.ts`, `src/extension/content/content-entry.ts`, `src/extension/content/stream-id.ts`, `src/extension/worker/*`, `src/extension/popup/*`, `src/extension/manifest.json`, `scripts/build-extension.ts` | none (IndexedDB outbox, `chrome.storage.session`) | `TranscriptResult`, `TabCaptureState`, `PopupRequest`, `transition` |
| Evidence | W3 | `src/backend/evidence/*` | `capture_facts`, `frames`, `evidence_snapshots`, `evidence_deletions` | `WatchedPassage`, `WatchOrder`, `EvidenceStore`, `createEvidence` |
| Segmentation | W4 | `src/backend/segmentation/*` | `chunk_revisions` | `SegmentationConfig`, `SEGMENTATION_DEFAULTS`, `Segmentation`, `WindowTrace`, `createSegmentation`, `buildWindows`, `planChunks` |
| Providers | W5 | `src/backend/providers/{ledger,jev,jev-tasks,claude,claude-api}.ts` | `memo_inputs`, `memo`, `memo_failures`, `usage_events` (written only by `memo.ts`), `voice_usage_events` (written only by `elevenlabs.ts`); all five have `user_id` | `Ledger`, `JevClient`, `JevRequest`, `JevAnswer`, `BoundaryInput`, `FrameChangeInput`, `ClaimSupportInput`, `toVerdict`, the three Jev task factories, `ClaudeCli`, `ClaudeRequest`, `claudeArgs`, `createClaudeApi`, `MemoRunOptions` |
| Preparation | W6 | `src/backend/preparation/*` | `claim_index`, `concept_index`, `prep_controls` | `Preparation`, `createPreparation`, `PreparationTasks`, `InterpretationInput`, `InterpretationOutput`, `RevisionInput`, `ResourceSearchInput` |
| Review lifecycle | W7 | `src/backend/review/index.ts`, `src/backend/review/core.ts` | `invite_answers`, `reviews`, `review_turns` | `Reviews`, `createReviews` |
| Tutor and record | W8 | `src/backend/review/tutor.ts`, `src/backend/review/clamp.ts`, `src/backend/review/detour.ts`, `src/backend/record/*` | `notes`, `note_edits`, `note_deletions`, `note_evidence`, `observations`, `observation_decisions`, `link_suggestions`, `link_decisions`, `saved_reviews`, `save_failures` | `TutorInput`, `TutorOutput`, `WrapUpInput`, `WrapUpOutput`, `parseMoveHeader`, `validateMove`, `allowedMoves`, `reviewState`, `clampStatus`, `isLearningGap`, `LearningRecord` (now with `saveState(reviewId)`), `createRecord`, `RecordBundle` |
| Review app | W9 | `src/app/*` | none (IndexedDB holding unsent turns) | `Api`, `createApi` |
| Diagrams | review app PR | `src/backend/diagram/*` | none (the summary is a `diagram_summary` memo entry) | `Diagrams`, `createDiagrams`, `diagramSummaryTask`, `DiagramSummaryInput`, `DiagramSummaryOutput` |

## Working rules

- Tests go in `test/<module>.test.ts` and use `fakeTask` from `test/fakes.ts`. No live Jev or Claude call outside Derek's five approved experiments. When you write the real test for a rule, delete its `test.todo` line in `test/rules.test.ts` in the same commit.
- Pure logic goes in your module's `core.ts`. Only your module and `test/` may import it.
- To change your tables, append a migration to your own array in `MIGRATIONS` (`src/backend/db.ts`). Never edit an applied migration; `openDb` refuses one whose text changed. That array is the only line range of a kernel file you may touch.
- Write SQL only against tables your row lists. `test/boundaries.test.ts` fails otherwise.
- Quote Derek's rules as `Rn: "<exact text>"` wherever code enforces one. `test/rules.test.ts` fails on any wording that differs from `docs/flows/after-class.md`.
- Every provider call is `memo.run(task, input)`. Derivations read `memo.lookup` and apply results only through `appliesBefore(lookup, cutoff)`.

## Users in the providers module

- `createMemo`, `createLedger` and `createVoice` take a `UserDb` and read and write only its `userId`'s rows. A memo is per user: its rows are keyed by (`user_id`, `key`), and the key stays a hash of the call alone. A `MemoKey` is therefore unique only within one user, so a module that stores one beside its own rows reads it back through that user's memo.
- `memo.run` takes an optional `captureId`, stored on the call's usage events. `main.ts` passes it for boundary calls; the other callers do not know the capture yet and leave `usage_events.capture_id` null.

## Wire contract

`ROUTES` in `src/shared/wire.ts` is the only list of HTTP routes. The extension worker and `createApi` call nothing outside it, and `http.ts` serves exactly it. Each entry has a method, a `:param` path, optional query and request schemas, and a reply (`json` schema, `ndjson` event, `jpeg`, or `empty` for 204). Add a route there first; `test/wire.test.ts` fails if a client calls one that is missing.

- `clientSeq` starts at 0 per capture and rises by 1 per fact. `POST /ingest` is idempotent on (captureId, clientSeq) and returns `ackedThroughSeq`, the highest contiguous clientSeq stored, or -1 before clientSeq 0 has arrived.
- `POST /captures/:captureId/invite` returns the new `InviteState`. The extension reads it back; the app ignores it.
- The record commands (`PATCH`/`DELETE` notes, link decisions, dispute resolution, override, evidence delete) reply 204 with no body.
- `POST /captures/:captureId/retry-preparation` (`retryPreparation`) takes no body and replies 204. It re-queues the capture's chunks that are unfinished or have no supported claim; the app's "Check again" is its caller.
- `POST /reviews/:reviewId/turns` runs one turn per review: a second post with a different `turnId` while one runs answers 409; the same `turnId` joins and replays. A stream still open after 5 minutes ends with `turn_failed` (retryable) while the turn finishes; its resend replays it.
- `ReviewView.saved` is `LearningRecord.saveState(reviewId)`: `saved` once `saved_reviews` has the review, `save_pending` after a failed save with none since (`save_failures`, survives a restart), else `unsaved`.
- `GET /reviews/:reviewId/diagrams` lists every topic of the review's frozen scope with its frame and where its summary stands (`no_claims`, `not_requested`, `preparing`, `ready`, `failed`) and makes no model call. `POST /reviews/:reviewId/diagrams/:topicId` starts that topic's summary (one `diagram_summary` Claude call per topic and evidence set, memoized) and answers with the same shape; asking again after `failed` retries. R19 is enforced in the task and again when the summary is read.
- A `Material` crosses JSON as `Material.canonical` rows. Use `encodeMaterial` and `decodeMaterial`; the `GET /evidence?material=` value is `encodeURIComponent(encodeMaterial(m))`.
- Response schemas live in `wire.ts`. `src/app/decode.ts` re-exports them as aliases.
- Frozen exports that changed after the Tutor and record row was written: `RecordBundle.observations` carries `assessable` per observation, and `clampStatus(proposed, facts, dispute, assessable)` takes a fourth argument; when a thread's claim is not assessable at save, the status is `not_assessed` (R3).
