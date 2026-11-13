# Module map

Each workstream owns its files and nothing else. Everything in the "Frozen" column is a contract: other workstreams build against it now, so a change goes through W10. Bodies marked `throw new Error("not implemented")` are yours to fill in. Keep the exported signatures.

| Module | Owner | Owned files | Owned tables | Frozen exports |
| --- | --- | --- | --- | --- |
| Kernel | W10 | `src/shared/*`, `src/backend/db.ts`, `src/backend/migrations.ts`, `src/backend/migrations-record.ts`, `src/backend/pg.ts`, `src/backend/pg-schema.ts`, `src/backend/providers/memo.ts`, `scripts/dev/pg.sh`, `test/fakes.ts`, `test/pg-fixtures.ts`, `test/boundaries.test.ts`, `test/{ids,time,wire,db,memo,rules,pg,pg-schema}.test.ts` | `schema_migrations`, `seq_counter`, `users` | everything in `shared/` (`domain.ts` types, `ids.ts`, `time.ts`, `wire.ts` schemas, `parse*`, `ROUTES`, `Route`, `routeUrl`, `matchRoute`, `encodeMaterial`, `decodeMaterial`), `Db`, `UserDb`, `openDb`, `scopeDb`, `ensureLocalUser`, `LOCAL_USER`, `TABLE_SCOPES`, `asSeq`, `MIGRATIONS`, `tableOwners`, `PgDb`, `UserPgDb`, `Tx`, `Param`, `openPgDb`, `scopePgDb`, `ensurePgUser`, `PG_MIGRATIONS`, `Task`, `Lookup`, `LookupFn`, `Memo`, `UsageReport`, `ProviderError`, `ReplayMiss`, `appliesBefore`, `createMemo` |
| Composition | W10 (after W1 to W9) | `src/backend/http.ts`, `src/backend/main.ts`, `src/backend/scheduler.ts` | none | `WorkItem`, `Scheduler`, `Modules`, `AuthConfig`, `authorize` |
| Playback and frames | W1 | `src/extension/content/capture.ts`, `src/extension/content/frames.ts` | none | `Emit`, `ControlMessage`, `ContentSignal`, `PlaybackTracker`, `AdSignals`, `isAdShowing`, `FrameSamplerConfig`, `FrameSampler`, `normalizedSize` |
| Transcripts, worker, popup, build | W2 | `src/extension/content/transcript.ts`, `src/extension/content/main-world.ts`, `src/extension/content/content-entry.ts`, `src/extension/content/stream-id.ts`, `src/extension/worker/*`, `src/extension/popup/*`, `src/extension/manifest.json`, `scripts/build-extension.ts` | none (IndexedDB outbox, `chrome.storage.session`) | `TranscriptResult`, `TabCaptureState`, `PopupRequest`, `transition` |
| Evidence | W3 | `src/backend/evidence/*` | `capture_facts`, `frames`, `evidence_snapshots`, `evidence_deletions`, `capture_owners` | `WatchedPassage`, `WatchOrder`, `EvidenceStore`, `createEvidence` |
| Segmentation | W4 | `src/backend/segmentation/*` | `chunk_revisions` (has `user_id`) | `SegmentationConfig`, `SEGMENTATION_DEFAULTS`, `Segmentation` (now with `heldByAnotherUser(captureId)`), `WindowTrace`, `createSegmentation` (takes a `UserDb`), `buildWindows`, `planChunks` |
| Providers | W5 | `src/backend/providers/{ledger,jev,jev-tasks,claude,claude-api}.ts` | `memo_inputs`, `memo`, `memo_failures`, `usage_events` (written only by `memo.ts`), `voice_usage_events` (written only by `elevenlabs.ts`); all five have `user_id` | `Ledger`, `JevClient`, `JevRequest`, `JevAnswer`, `BoundaryInput`, `FrameChangeInput`, `ClaimSupportInput`, `toVerdict`, the three Jev task factories, `ClaudeCli`, `ClaudeRequest`, `claudeArgs`, `createClaudeApi`, `MemoRunOptions` |
| Preparation | W6 | `src/backend/preparation/*` | `claim_index`, `concept_index`, `prep_controls`, `prep_inputs`; all four have `user_id` | `Preparation`, `createPreparation` (takes a `UserDb`), `PreparationTasks`, `InterpretationInput`, `InterpretationOutput`, `RevisionInput`, `ResourceSearchInput` |
| Review lifecycle | W7 | `src/backend/review/index.ts`, `src/backend/review/core.ts` | `invite_answers`, `reviews`, `review_turns`; all three have `user_id` | `Reviews` (now with `heldByAnotherUser(reviewId)`), `createReviews` (takes a `UserDb`) |
| Tutor and record | W8 | `src/backend/review/tutor.ts`, `src/backend/review/clamp.ts`, `src/backend/review/detour.ts`, `src/backend/record/*` | `notes`, `note_edits`, `note_deletions`, `note_evidence`, `observations`, `observation_decisions`, `link_suggestions`, `link_decisions`, `saved_reviews`, `save_failures`; all ten have `user_id` | `TutorInput`, `TutorOutput`, `WrapUpInput`, `WrapUpOutput`, `parseMoveHeader`, `validateMove`, `allowedMoves`, `reviewState`, `clampStatus`, `isLearningGap`, `LearningRecord` (now with `saveState(reviewId)`), `createRecord` (takes a `UserDb`; every query is user-scoped), `RecordBundle` |
| Review app | W9 | `src/app/*` | none (IndexedDB holding unsent turns) | `Api`, `createApi` |
| Diagrams | review app PR | `src/backend/diagram/*` | none (the summary is a `diagram_summary` memo entry) | `Diagrams`, `createDiagrams`, `diagramSummaryTask`, `DiagramSummaryInput`, `DiagramSummaryOutput` |

## Working rules

- Tests go in `test/<module>.test.ts` and use `fakeTask` from `test/fakes.ts`. No live Jev or Claude call outside Derek's five approved experiments. When you write the real test for a rule, delete its `test.todo` line in `test/rules.test.ts` in the same commit.
- Pure logic goes in your module's `core.ts`. Only your module and `test/` may import it.
- To change your tables, append a migration to your own array in `MIGRATIONS` (`src/backend/migrations.ts`). Never edit an applied migration; `openDb` refuses one whose text changed. That array is the only line range of a kernel file you may touch. `migrations.ts` is at the 1000-line lint limit, so the record's `004-user-id` text lives in `migrations-record.ts` and is the last entry of the `record` array.
- Write SQL only against tables your row lists. `test/boundaries.test.ts` fails otherwise.
- Quote Derek's rules as `Rn: "<exact text>"` wherever code enforces one. `test/rules.test.ts` fails on any wording that differs from `docs/flows/after-class.md`.
- Every provider call is `memo.run(task, input)`. Derivations read `memo.lookup` and apply results only through `appliesBefore(lookup, cutoff)`.

## PostgreSQL kernel

Every module moves from `UserDb` (`db.ts`, SQLite) to `UserPgDb` (`pg.ts`, PostgreSQL on `Bun.sql`) in one wave. SQLite stays only until that wave lands. The interface:

```ts
type Param = string | number | boolean | null | object;   // an object or array is stored as jsonb
type Tx = {
  all<R>(strings: TemplateStringsArray, ...values: Param[]): Promise<R[]>;          // t.all<Row>`SELECT a, b FROM t WHERE id = ${id}`
  get<R>(strings: TemplateStringsArray, ...values: Param[]): Promise<R | null>;     // first row or null
  run(strings: TemplateStringsArray, ...values: Param[]): Promise<{ changes: number }>;
  nextSeq(userId?: UserId): Promise<Seq>;     // the locked user's next Seq; name the user when several are locked
  lockUsers(...userIds: UserId[]): Promise<void>;
  holdsUserLock(userId: UserId): boolean;
  heldUserLocks(): readonly UserId[];
  tx<T>(fn: (t: Tx) => Promise<T>): Promise<T>;   // savepoint
};
type PgDb = {
  tx<T>(fn: (t: Tx) => Promise<T>): Promise<T>;                       // no lock
  command<T>(userId: UserId, fn: (t: Tx) => Promise<T>): Promise<T>;  // locks userId first
  read<T>(fn: (t: Tx) => Promise<T>): Promise<T>;                     // read only, one snapshot, no lock
  close(): Promise<void>;
};
type UserPgDb = { userId: UserId; command<T>(fn: (t: Tx) => Promise<T>): Promise<T>; read<T>(fn: (t: Tx) => Promise<T>): Promise<T> };
openPgDb(url: string, opts?: { max?: number; idleInTransactionMs?: number }): Promise<PgDb>;   // runs pending migrations
scopePgDb(db: PgDb, userId: UserId): Promise<UserPgDb>;
ensurePgUser(db: PgDb, userId: UserId, createdMs: number): Promise<void>;
```

Rules for every module:

- Every command starts with `udb.command(async (t) => …)`. The lock comes first, then every read the command decides on. A user's commands run one at a time, and different users never wait on each other. Reads that decide nothing go through `udb.read`.
- A command over several users, such as the expiry sweep, finds its candidate users, then opens `db.tx`, calls `t.lockUsers(...all of them)` once, reads again under the locks, and deletes. Never delete a user's rows without that user's lock: on PostgreSQL the R16 trigger cannot see an uncommitted review, so the lock is what keeps an unsaved review's evidence (`test/pg.test.ts`, "R16 needs the lock").
- Statements run only through the handle `t`. `PgDb` and `UserPgDb` have no statement methods. A helper that touches the database takes `t: Tx` as a parameter. Calling `command`, `tx` or `read` while your own transaction is open throws.
- No non-database await inside a transaction: no model call, `fetch`, file read or timer. Load inputs in one command, call the model outside any transaction, then write the result in a new command that checks again, under the lock, the state it relies on. The server ends a transaction idle for 10 s, and its commit fails.
- Explicit column lists in every `SELECT` and `INSERT`. No `SELECT *`.
- `INSERT OR IGNORE` becomes `INSERT … ON CONFLICT (key columns) DO NOTHING`. SQLite's `OR IGNORE` also swallowed CHECK and NOT NULL failures, and PostgreSQL raises them.
- A failed statement poisons its handle, and a transaction whose body caught a failure does not commit. A statement you expect may fail and want to recover from goes inside `t.tx(async (sp) => …)`.
- Seqs are per user. Take them with `t.nextSeq()` inside a command. A user's Seqs commit in the order they were taken. Seqs of two users are not comparable, and every Seq column is unique per `(user_id, seq)`.

Dialect, each line checked in `test/pg.test.ts` or `test/pg-schema.test.ts`:

- Values go in `${…}` and are always bound parameters. A nullable filter needs a type: `${x}::text IS NULL OR col = ${x}`.
- `*_json` columns are `jsonb`. Bind the value itself, never `JSON.stringify(value)`, which stores a JSON string. Rows come back parsed, so drop `JSON.parse`. jsonb reorders keys and respells numbers, so hash a value with `canonicalJson`, never the text read back.
- `json_each(col)` becomes `jsonb_array_elements_text(col)`, and `json_extract(col, '$.k')` becomes `col ->> 'k'`. A list of ids binds as one value: `id IN (SELECT jsonb_array_elements_text(${ids}))`.
- `bigint` columns and `COUNT(*)` arrive as numbers. `SUM` is `numeric` and arrives as a string, so write `SUM(x)::bigint`. `EXISTS (…)` is `true` or `false`, not 1 or 0, and `SUM(boolean)` becomes `COUNT(*) FILTER (WHERE …)`.
- Text sorts by bytes as on SQLite, because every text column is `COLLATE "C"`.
- Trigger refusals keep their SQLite messages (`R16: …`, `R17: …`, `… is append-only`) and reject with a `PostgresError`. Every append-only table also refuses `TRUNCATE`.

The schema is `src/backend/pg-schema.ts`, one append-only array per owner as in `migrations.ts`. Append to your own array to change your tables. `test/pg-schema.test.ts` holds it to the SQLite schema until SQLite is removed. Tests reach PostgreSQL through `AFTERCLASS_TEST_PG_URL` and use `pgDatabases()` from `test/pg-fixtures.ts`, which gives each test its own database. Locally, `scripts/dev/pg.sh start` runs the one shared container, and `export AFTERCLASS_TEST_PG_URL="$(scripts/dev/pg.sh url)"` points the tests at it. Without the variable the PostgreSQL test files skip and say so.

## Users in the providers module

- `createMemo`, `createLedger` and `createVoice` take a `UserDb` and read and write only its `userId`'s rows. A memo is per user: its rows are keyed by (`user_id`, `key`), and the key stays a hash of the call alone. A `MemoKey` is therefore unique only within one user, so a module that stores one beside its own rows reads it back through that user's memo.
- `memo.run` takes an optional `captureId`, stored on the call's usage events. `main.ts` passes it for boundary calls; the other callers do not know the capture yet and leave `usage_events.capture_id` null.

## Users in segmentation

- `createSegmentation` takes a `UserDb` and reads and writes only its `userId`'s chunk revisions. A chunk id derives from the capture id and a revision id from the chunk and its material, so two users who hold one capture id make identical ids. The table is keyed by (`user_id`, `id`) and unique on (`user_id`, `chunk_id`, `revision_no`), and `supersedes` is a composite foreign key to the same user's revision. The derivations are unchanged, so every stored id, scope and memo key stays valid.
- `Segmentation.heldByAnotherUser(captureId)` is true when another user has chunks of the capture and the caller has none. `POST /captures/:captureId/retry-preparation` answers 404 then. A capture nobody holds keeps its 204 no-op.

## Users in preparation

- `createPreparation` takes a `UserDb`, and every statement carries its `userId`. Claim ids hash the interpretation's memo key, concept ids hash a label, and a frozen input's subject is a chunk revision, claim or concept id, so two users who watch one lecture derive identical ids. All four tables therefore key by (`user_id`, id) and the derivations stay.
- A frozen input (`prep_inputs`, one row per user, kind and subject) is first-writer-wins per user. Another user's row never holds a slot, so one user's job is never dropped as outdated because the other froze a different input, and a stop early or retry fact (`prep_controls`) reaches only its own user's derivation (R8).
- `prep_inputs.memo_key` is read back through the same user's memo. It has no foreign key to `memo_inputs`, because a frozen input is written before the job's memo row exists.
- Preparation has no route of its own that takes an id. `retry-preparation` is guarded through `Segmentation.heldByAnotherUser`.

## Wire contract

`ROUTES` in `src/shared/wire.ts` is the only list of HTTP routes. The extension worker and `createApi` call nothing outside it, and `http.ts` serves exactly it. Each entry has a method, a `:param` path, optional query and request schemas, and a reply (`json` schema, `ndjson` event, `jpeg`, or `empty` for 204). Add a route there first; `test/wire.test.ts` fails if a client calls one that is missing.

- `clientSeq` starts at 0 per capture and rises by 1 per fact. `POST /ingest` is idempotent on (captureId, clientSeq) and returns `ackedThroughSeq`, the highest contiguous clientSeq stored, or -1 before clientSeq 0 has arrived.
- `POST /captures/:captureId/invite` returns the new `InviteState`. The extension reads it back; the app ignores it.
- The record commands (`PATCH`/`DELETE` notes, link decisions, dispute resolution, override, evidence delete) reply 204 with no body.
- `POST /captures/:captureId/retry-preparation` (`retryPreparation`) takes no body and replies 204. It re-queues the capture's chunks that are unfinished or have no supported claim; the app's "Check again" is its caller.
- `POST /reviews/:reviewId/turns` runs one turn per review: a second post with a different `turnId` while one runs answers 409; the same `turnId` joins and replays. A stream still open after 5 minutes ends with `turn_failed` (retryable) while the turn finishes; its resend replays it.
- `ReviewView.saved` is `LearningRecord.saveState(reviewId)`: `saved` once `saved_reviews` has the review, `save_pending` after a failed save with none since (`save_failures`, survives a restart), else `unsaved`.
- `GET /reviews/:reviewId/diagrams` lists every topic of the review's frozen scope with its frame and where its summary stands (`no_claims`, `not_requested`, `preparing`, `ready`, `failed`) and makes no model call. `POST /reviews/:reviewId/diagrams/:topicId` starts that topic's summary (one `diagram_summary` Claude call per topic and evidence set, memoized) and answers with the same shape; asking again after `failed` retries. R19 is enforced in the task and again when the summary is read.
- Evidence is per user. `createEvidence` takes a `UserDb`, and every query carries its `userId`. `EvidenceStore` gains `capturedByAnotherUser(captureId)` and `heldByAnotherUser(ids)`, which `http.ts` uses to answer 404 for a capture or a frame that only another user holds. An id nobody holds keeps its old answer. `ingest` throws `RangeError` for a capture id another user already holds. The first ingest records the owner in `capture_owners` inside its transaction, and expiry never deletes it. New frame and snapshot files live under a per-user directory, and no file is unlinked while any row still points at it, so a capture id and the frame ids and file paths derived from it belong to one user. Passage evidence ids come from the transcript and are shared, so `evidence_snapshots`, `evidence_deletions` and `frames` key by `(user_id, evidence_id)`.
- Reviews are per user. `createReviews` takes a `UserDb`, and every query carries its `userId`. A review id is minted by the app and belongs to the first user that starts it: `reviews.id` stays the key, `reviews` never deletes a row, and `start` throws `RangeError` for an id another user holds, which `http.ts` answers with 404 (as it does for `GET /reviews/:reviewId`, the turn, save and record routes). Tutor and code turn ids, notes and observations derive from the review id, so they stay one user's. A turn id is minted by the app too and keys by (`user_id`, `id`) with a composite foreign key to the user's own review, so the same turn id from two users is two turns: neither replays, joins or blocks the other. The in-flight guard in `http.ts` is keyed by review id, which is unique across users. The R16 triggers on `capture_facts` and `frames` hold only for a review of the same user.
- The record is per user. `createRecord` takes a `UserDb`, and every query carries its `userId`. Every key leads with `user_id`, because a link id derives from concept ids that every user who watches a lecture shares; note and observation ids derive from a review id, which is one user's. `notes`, `observations` and `link_suggestions` carry an `ord` column (one past the user's highest) and are read in that order, in place of `rowid`. `http.ts` answers 404 for a note, link or observation the caller does not hold, and `GET /record?reviewId=` for a review only another user holds; an id nobody holds keeps its old answer (404 for a command, an empty view for the query). The R16 triggers match the same user: a note holds only its own user's snapshot of an evidence id both users hold, a tombstone releases only its maker's, and a review is saved by its own user's `saved_reviews` row.
- `test/ownership.test.ts` is plan step 4. `CASES` has an entry for every route in `ROUTES`, so a new route fails typecheck until it says how a second user is refused (404, or the documented no-op: evidence ids and material another user holds read as an empty bundle). A route with a path parameter may not be marked as taking no id.
- A `Material` crosses JSON as `Material.canonical` rows. Use `encodeMaterial` and `decodeMaterial`; the `GET /evidence?material=` value is `encodeURIComponent(encodeMaterial(m))`.
- Response schemas live in `wire.ts`. `src/app/decode.ts` re-exports them as aliases.
- Frozen exports that changed after the Tutor and record row was written: `RecordBundle.observations` carries `assessable` per observation, and `clampStatus(proposed, facts, dispute, assessable)` takes a fourth argument; when a thread's claim is not assessable at save, the status is `not_assessed` (R3).
