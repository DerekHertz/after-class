# After Class MVP: candidate 1, "facts in, derivations out, memoized calls"

Sketch files mirror the proposed tree under `src/` and `test/`. Every body is `throw new Error("not implemented")` or pseudocode in a `TODO` comment. The sketch typechecks against the repo's real `tsconfig.json` and `node_modules` (TS 7.0.2, `tsc --noEmit` clean).

## Problem

After Class has to turn noisy browser observations (playback that pauses, seeks, speeds up, gets interrupted by ads, goes to a background tab, and moves on to the next video) into evidence that is honest about what Derek actually watched. On top of that evidence it runs three asynchronous model stages: Jev boundary and frame judgments while he watches, Claude interpretation plus a Jev claim check and a single revision after a chunk closes, and a Claude tutor during review. Three things make the shape hard to get right:

1. **Many writers, many lifecycles.** The extension, the user (both in the popup and in the review app), Jev, and Claude all produce state, and they do it concurrently. Seventeen rules constrain how that state can combine. Eleven of them are temporal, `[TLC]` rules: cancelled or outdated results must not apply, Later must not cancel anything, review scope must never grow, capture and review must stay independent, and a detour needs consent first.
2. **Boundaries can be revised.** A chunk that already closed can change after interpretation has run, and even while that chunk is in an active review. Only the affected claims may be reprocessed.
3. **Every paid call is metered, cached, and inspectable.** Usage gets recorded even when cost is unknown. Repeat viewings reuse earlier judgments. The acceptance demo requires "inspectable Jev preprocessing inputs, judgments, routing".

These constraints come from the grounding and the design has to honor them. Keys stay in the backend only. Chrome runs on Windows and the backend runs in WSL, connected over localhost. Claude is reached only through `claude -p`. The runtime dependencies are zod, react, and react-dom and nothing else. Live calls are limited to five named experiments, so every test has to run offline. The flow already has a TLA+ model (`docs/flows/model/Preparation.tla`) whose state names this design reuses.

## Usage (caller's view)

**Quickstart (README):**

```text
bun install --frozen-lockfile
bun run build:ext                 # Bun.build → dist/extension (load unpacked in Windows Chrome)
bun run dev                       # Bun.serve on 127.0.0.1:4317; prints the pairing token once
# Extension options: paste token. On a YouTube watch page: popup → Start capture.
# Watch. Popup shows source, caption status, frame health, and invites.
# Review now → opens http://localhost:4317/app/review/<id>. Speak or type.
AFTERCLASS_MODE=replay bun run dev --db samples/strang-18.06-l1.sqlite   # labelled replay, no keys
```

**Call site 1, the extension content script.** It only observes. The service worker owns control state and sequence numbers.

```ts
const port = chrome.runtime.connect({ name: "capture" });
const emit: Emit = (fact) => port.postMessage(fact);
const tracker = createPlaybackTracker(video, player, emit, () => currentVideoId);
const sampler = createFrameSampler(video, emit, () => currentVideoId, FRAME_DEFAULTS);
port.onMessage.addListener((m: ControlMessage) => {
  if (m.type === "observe") { tracker.setObserving(m.on); sampler.setObserving(m.on); }
  if (m.type === "read_transcript") readTranscriptPanel(currentVideoId, video.duration).then(emit);
});
```

**Call site 2, a backend route.** It parses the request, makes one call, and serializes the result. Everything else happens through derivation.

```ts
"/ingest": async (req) => {
  const batch = parseIngestBatch(await req.json());          // zod → domain, the only trust boundary
  const { ackedThroughSeq } = evidence.ingest(batch);         // idempotent on (captureId, clientSeq); pumps scheduler
  return Response.json({ ackedThroughSeq, invite: reviews.invite(batch.captureId), capture: … } satisfies IngestAck);
}
```

**Call site 3, the review app.**

```ts
const opts = await api.reviewOptions(captureId);              // ready | processing | nothing_to_review
const start = await api.startReview(captureId, opts.kind === "processing" ? "stop_early" : "prepared_only");
for await (const ev of api.sendTurn(reviewId, { kind: "answer", text, modality: "speech" })) {
  if (ev.type === "sentence") speak(ev.text);
}
const saved = await api.save(reviewId);                        // save_failed → show pending, Retry = same call
```

**Call site 4, the rule-level unit tests.** These are pure functions with no database.

```ts
expect(clampStatus("independent", factsWithHintBeforeAnswer).status).toBe("after_help");     // R12
expect(deriveClaimStatus({ originalCheck: no, revision: hit, revisionCheck: uncertain }, null)).toBe("unverified"); // R4
expect(route("yes", "no")).toBe("flag_recheck");
```

## Shape

### Three kinds of state (the load-bearing decision)

| Kind | What | Owner (sole writer) | Examples |
| --- | --- | --- | --- |
| **Fact** | Immutable and append-only, stamped with a global `Seq` | One actor each | extension `CaptureFact`s; user invite answers, stop-early/retry, learner turns, note edits, link decisions, dispute resolutions; provider results in the **memo** |
| **Derivation** | A pure function of facts, recomputed and never stored as truth | Nobody, it's computed | watched `Material`, `Passage`s, gaps, windows, chunk plan, `ClaimStatus`, `ChunkPrep`, `InviteState`, `ReviewState`, allowed tutor moves, clamped `ObservationStatus` |
| **Snapshot** | A derivation frozen at a user-visible moment, stored under a content-derived ID | The module that freezes it | `ChunkRevision`, `FrozenScope`, the saved `RecordBundle`, evidence snapshots |

The design follows **separate-before-serializing-shared-state**: no two actors write the same row. When the question is "what if the tutor and Derek both edit the note?", the answer is "nothing happens", because the two edits live in different tables and get merged when read (`userEdit ?? generated`).

### The memo is the call path (`providers/memo.ts`)

The only way to reach Jev or Claude is `memo.run(task, input)`. The key is `stableId("key", purpose, version, model, canonicalInput(input))`. Evidence IDs are content hashes, so the canonical input hashes IDs and never needs to hash text. This one mechanism does five jobs:

- **Cache reuse.** A rewatched window, or a re-closed chunk with the same evidence, has the same key, so no new call is made. Flow B's "reuse cached judgment" and flow C's "valid cache hit" are both just the call path.
- **R8 "outdated" holds by construction.** A result is stored under the key of the input it was computed from. Derivations look up the key for the current input, so an outdated result is never selected because nothing ever asks for it.
- **R8 "cancelled" is ordering.** Stop early is a fact with a `Seq`. `deriveClaimStatus` counts a result only if `result.atSeq < cutoff`. Late results are still stored ("logged, never applied").
- **R17.** The usage event is written in the same transaction as the result or the failure. No other exported path calls a provider, and a boundary test enforces that.
- **Inspectability and replay.** `memo.inspect(key)` returns the exact input and output. Replay mode throws on a cache miss, which turns any recorded database into a labelled replay sample.

Because demand is derived, **there is no job table.** `scheduler.pump()` asks each module for the work it still needs: windows without judgments, frames without judgments, chunks without interpretation, claims without checks or revisions, and supported concepts without resource searches. It then runs those items with per-provider limits and pumps again when each one finishes. Running it twice demands the same keys, and `memo.run` is single-flight per key. After a crash it just pumps again. Later (R5) and resource state (R6) can't affect demand or readiness because those modules don't import `review/`.

### Data flow

```text
extension (observer) ─facts─▶ SW outbox (clientSeq, IndexedDB) ─POST /ingest─▶ evidence.ingest
                                                                                   │ fold
   capture facts ──▶ watchedMaterial ──▶ clipToWatched ──▶ Passage (R1)          ▼
                     (spans only; ads are another fact kind, R2)          WatchOrder
                                                                                   │
   segmentation.sync: buildWindows ─▶ memo.lookup(boundaryTask) ─▶ planChunks ─▶ reconcile ─▶ ChunkRevision (append on change)
                                                                                   │
   preparation: interpret(delta) ─▶ claims (keyed by evidence) ─▶ claimSupport ─▶ revise(original) ─▶ claimSupport
                 deriveClaimStatus(lookups, cutoff) ─▶ ChunkPrep ─▶ assessable() ─▶ AssessableClaim (R3)
                                                                                   │
   reviews: foldInvites · options · freezeScope (NonEmpty, R10) ─▶ FrozenScope (written once, R7)
            turn: append learner turn ─▶ reviewState ─▶ allowedMoves ─▶ memo.run(tutorTask, streamTo) ─▶ validateMove ─▶ append tutor turn
                                                                                   │
   record.save: memo(wrapUpTask) ─▶ buildBundle ─▶ clampStatus ─▶ upsert by stable IDs + evidence.snapshotInTx (R15, R16)
```

### Module map (each module writes only its own tables)

| Module | Public surface | Owns tables | Hides |
| --- | --- | --- | --- |
| `shared/ids.ts` | `stableId`, `randomId`, `parseId`, branded ID types | n/a | hashing, canonical JSON |
| `shared/time.ts` | `MediaSeconds`, `Interval`, `IntervalSet`, `Material` | n/a | normalization (sorted, disjoint) |
| `shared/domain.ts` | every domain type | n/a | n/a |
| `shared/wire.ts` | zod schemas, `parseIngestBatch`, `parseTurnRequest`, `IngestAck`, `TutorStreamEvent` | n/a | wire shapes (domain modules never import it) |
| `extension/content/*` | `createPlaybackTracker`, `createFrameSampler`, `readTranscriptPanel`, `awaitInterceptedCaptions` | n/a | YouTube DOM, ad classes, media-time span logic, pixel diff |
| `extension/worker/*` | popup messages, `transition`, `enqueueFact`, `flushOutbox` | `chrome.storage.session` control state, IndexedDB outbox | sequencing, retry, pairing token |
| `backend/evidence` | `ingest`, `captureView`, `watchOrder`, `bundle`, `get`, `frameBytes`, `frameDemand`, `snapshotInTx`, `deleteByUser`, `sweepExpired` | capture_facts, sources, transcript_revisions, frames (+ files), evidence_snapshots | watched folding, clipping, gap derivation, frame teaching status, retention |
| `backend/segmentation` | `sync`, `current`, `revision`, `history`, `trace` | chunk_revisions | windowing, routing table, flag cut-back, reconsider rule, time cap |
| `backend/preparation` | `prep`, `demand`, `stopEarly`, `retry`, `claimsIn`, `assessableIn`, `concepts`, `confusions`, `linkSuggestions`, `resources` | claim_index, prep_controls | Claude prompts, delta interpretation, claim lineage, status derivation, cancellation cutoff |
| `backend/review` | `invite`, `answerInvite`, `options`, `start`, `turn`, `view` | invite_answers, reviews, review_turns | invite policy, scope freezing, corrections, the allowed-moves state machine, tutor prompt and repair |
| `backend/record` | `save`, `view`, `editNote`, `deleteNote`, `decideLink`, `resolveDispute`, `overrideObservation` | notes, note_edits, note_evidence, observations, observation_decisions, link_suggestions, link_decisions, saved_reviews | bundle building, clamping at read, per-actor merge |
| `backend/providers` | `createMemo`, `createLedger`, `boundaryTask`, `frameChangeTask`, `claimSupportTask`, `createJevClient`, `createClaudeCli` | memo, memo_failures, usage_events | HTTP and CLI transport, single-flight, retries, verdict thresholds, cost kinds |
| `backend/scheduler.ts` | `pump`, `inflight`, `estimateSeconds` | none (in-memory inflight only) | concurrency, priority, aborting work that's no longer demanded |
| `backend/http.ts`, `main.ts` | routes, composition | n/a | auth (token + Origin), NDJSON streaming, SSE |
| `app/*` | React review app, `createApi` | IndexedDB holding unsent turns | speech in (Web Speech API), TTS fallback, layout |

Each module's pure functions go in `<module>/core.ts`. Only that module and `test/` can import them, and `test/rules.test.ts` ("module boundaries") fails the build when anything else does. Call chains are at most three files deep: route → module → core/db.

### Data structures and access patterns

- **`Material = Map<SourceId, IntervalSet>`** is the common currency. Chunks own it, scopes freeze it, and a claim is admitted to a chunk or scope when the material **covers** that claim's evidence. Access pattern: "which claims can the tutor use?" becomes `claimsIn(captureId)` (a few hundred rows per capture) filtered by `Material.covers`. No index needs to be kept in sync.
- **Claims are keyed by evidence, not by chunk revision.** The claim ID is `stableId("clm", interpretationKey, ordinal)`, and membership is derived from containment. When a boundary moves, claims whose evidence didn't change keep their ID and their check results, because the check key is a function of the claim plus its cited evidence. Claims that now straddle two chunks belong to neither. Material a chunk gains goes through a *delta* interpretation call that sees the existing claims and can flag one as `supersedes` (that's where correction disclosure comes from). Flow D's "reprocess affected claims only" falls out of the derivation without anyone tracking it.
- **`ClaimLineage` has `original` plus a single `revision` slot (R4 is in the type).** The revision task's input is always the *original* draft plus its check, so the system can't express a second revision at all.
- **`AssessableClaim` is branded (R3).** `preparation.assessable()` is the only constructor, and it requires `supported_by_check`. The tutor input, `ask_main.claimIds` validation, and `Observation.claimIds` all go through it.
- **`FrozenScope` is written once and has a `NonEmpty` `claimsAtStart` (R7, R10).** No update function exists. During a review, the usable claims are the currently supported claims whose evidence lies inside `scope.material`. A correction can change claims inside the scope but can't add material.
- **Review state is a fold over `review_turns`.** Phase, main-question count, detour state, open dispute, active seconds, and pending corrections are all derived from it. `allowedMoves(state)` is the state machine. The tutor only picks from the set it's given, and the code validates the pick (R3, R7, R11, the cap of 3 main questions, forced hint/explain/dispute answers, disclosing a correction before anything else). The tutor can neither resolve a dispute (R14) nor start a detour (R11).

### Tricky logic (pseudocode lives in the sketch files)

| Logic | Where |
| --- | --- |
| Media-time spans, un-signalled seek detection, ads as a separate fact kind, hidden-tab visibility | `extension/content/capture.ts` `createPlaybackTracker` |
| Frame candidates: change measured against the *last kept* thumbnail (catches slow handwriting), wait for it to settle, then a keyframe; the normalization range Jev accepts | `extension/content/frames.ts` |
| Transcript panel read, json3 fallback, usability check | `extension/content/transcript.ts` |
| Auto-pause and resume on navigation, single control table | `extension/worker/service-worker.ts` `transition` |
| Flow B routing table; flag cut-back; the one-time reconsider rule (the first window after a boundary close returns no/no, which moves that boundary forward, matching TLA `ALaterWindowMovesABoundary`); time cap that cuts at the latest soft pause; session end | `backend/segmentation/index.ts` `route`, `planChunks` |
| Claim status with cancellation cutoff | `backend/preparation/index.ts` `deriveClaimStatus` |
| Invite policy (boundary close, or a time close after ≥ 15 min since the last invite or Later) | `backend/review/index.ts` `foldInvites` |
| Allowed tutor moves | `backend/review/tutor.ts` `allowedMoves` |
| Clamping and the learning-gap predicate | `backend/review/clamp.ts` |
| Verdict thresholds (0.7 / 0.3, tunable); every error maps to uncertain, never to no | `backend/providers/jev-tasks.ts` |
| `claude -p` auth/cost policy, stateless calls, images via stream-json input | `backend/providers/claude.ts` |

### Lifecycles (all derived, none stored)

| Lifecycle | States | Derived from |
| --- | --- | --- |
| Capture | capturing → paused(reason) ⇄ capturing → stopped | `control` facts. Pausing is gated twice: the extension stops emitting, and the backend counts a span only inside an active period (R1). |
| Chunk | open → closed(boundary \| time \| session_end) → revised(boundary_revised) | the chunk plan over judged windows. The snapshot gets appended when its material changes. |
| Claim | awaiting_check → supported_by_check \| awaiting_revision → awaiting_recheck → supported_by_check \| unverified; any pending state → dropped (stop early) | memo lookups + `prep_controls` cutoff |
| Chunk prep | interpreting / checking → finished (ready if ≥ 1 supported); cancelled | claim statuses + the interpretation lookup. Resources are excluded (R6). |
| Invite | none → invited → later \| waiting → none | chunk closes + invite answers |
| Review | active ⇄ paused → ended; save: unsaved → saved \| save_pending | turn log; `saved_reviews.bundle_hash` |
| Detour | none → proposed → active (only after a learner `detour_accept`) \| awaiting_resource | turn log |
| Dispute | none → open → unsettled \| resolved_by_learner | turn log + `observation_decisions` (written only by the user) |

### Derek's rules → mechanism

| Rule | Encoded by | Strength |
| --- | --- | --- |
| R1 | `Passage` is branded; `clipToWatched` is its only constructor; `watchedMaterial` reads spans only inside active control periods | type + single constructor |
| R2 | ads are their own `CaptureFact` kind that no derivation of material reads; the tracker closes the span before an ad | type |
| R3 | branded `AssessableClaim`; `validateMove` checks `ask_main.claimIds` | type + boundary check |
| R4 | `ClaimLineage` has a single revision slot; the revision input is always the original | type |
| R5 | `review/` is not an input to `preparation.demand` (import boundary test) | dependency |
| R6 | `ChunkPrep` has no resource field; readiness can't read resources | type + dependency |
| R7 | `FrozenScope` is readonly and written once; usable claims are filtered by `scope.material` | type |
| R8 | content-keyed memo (outdated results never get selected); `Seq` cutoff (cancelled results never get applied); user edits live in user-only tables | structure |
| R9 | `review/` ↔ `evidence` write APIs don't import each other | dependency |
| R10 | `FrozenScope.claimsAtStart: NonEmpty`; `freezeScope` returns null otherwise | type |
| R11 | `detour_step` is allowed only in `detour.kind === "active"`, which only a learner turn reaches | state machine |
| R12 | `clampStatus`, `HELP_MOVES` single list | pure function + test |
| R13 | `clampStatus`: no substantive answer ⇒ not_assessed | pure function + test |
| R14 | `isLearningGap`; `resolved_by_learner` is produced only by `record.resolveDispute` | type + single producer |
| R15 | stable IDs, upsert of generated columns only, saved_reviews hash | structure + test |
| R16 | snapshots get deleted only when no `note_evidence` row cites them (a live join, not a synced pin list) | structure + test |
| R17 | `memo.run` is the only path to a provider and writes the usage event in the same transaction; `Cost` "unknown" carries no number; SQL CHECK `(kind='unknown') = (usd IS NULL)` | type + SQL + boundary test |

### Interface depth

Callers see `ingest`, `sync`, `prep`, `options`/`start`/`turn`, and `save`. Behind those few calls sit media-time folding, clipping, gap logic, windowing, routing, boundary revision, delta interpretation, lineage, cancellation semantics, invite policy, the tutor state machine, clamping, idempotent persistence, caching, metering, and replay. No module exposes its pipeline stages. Nobody calls "check claim" or "revise claim", for example. Demand just asks for them. Transport shapes (Jev JSON, CLI stream-json, the extension wire format) stop at `providers/` and `wire.ts`.

### Deliberately not done

There's no durable job queue. Nothing stores `status` columns. There's no push channel to the MV3 worker: invites ride back on ingest acks. The tutor gets no Claude session resume and no tool use. No module validates domain objects internally, because zod runs only at `wire.ts` and when memo output is decoded. Opt-in ASR is reduced to the fact kinds (`transcription_choice`, origin `asr`) plus UI state. The capture path itself waits for the audio-feasibility probe. Resource search is defined as a task and as demand, and it gets scheduled at the lowest priority.

## Synthesis decision

*To be filled in by arena.*

## Tradeoffs accepted

- **We rederive the chunk plan, claim statuses, and review state on every pump, in exchange for having no state to sync.** Sizes are small: about 16 windows per 8 minutes and a few hundred claims per capture. If profiling ever shows a problem, the fix is memoizing the fold per `Seq`. A cache table would be the wrong fix.
- **The memo stores every provider input, in exchange for the acceptance demo's inspectability and free replay.** Frames are referenced by ID inside inputs, never by bytes.
- **A late result from a cancelled job *is* reused if Derek later presses Retry**, because the key is identical and so is the computation. We accept that in exchange for a cache that has one meaning. R8 forbids overwriting *current* preparation, and the result never does that.
- **No job table, so an attempt that's still in flight during a crash runs again.** That can pay for one call twice. The ledger shows both attempts.
- **Evidence snapshots duplicate cited passage text and hard-link frame files**, in exchange for a uniform 30-day sweep with no fact-level pinning. They can't diverge because evidence IDs are content hashes.
- **The tutor streams prose and then a `<<<MOVE>>>` JSON tail, which zod validates with one repair attempt.** We use this instead of `--json-schema` because speech has to start on the first sentence.
- **Boundary revision moves only forward, once per boundary**, plus the flag cut-back applied at close time. That's narrower than "any boundary may move", in exchange for determinism with no oscillation.

## Alternatives considered

- **A durable job queue with mutable status columns and fencing tokens (the classic shape).** Every writer has to compare an input revision before it updates, status lives in two places (the job and the claim), cache hits become a second way to "complete" a job, and crash recovery needs requeue logic. It exposes more to callers (job IDs, states, retries) and hides less. It lost on information leakage and on having two ways to do one task.
- **Full event sourcing with one event log and versioned projections for every view.** It gives the same guarantees but adds projection versioning and rebuild machinery for views that are cheap to recompute. We keep the useful half, facts plus pure folds, without a projection framework.
- **Claims keyed by chunk revision, so every boundary move re-runs interpretation and checks for the whole chunk.** That's simpler bookkeeping, but it violates "reprocess affected claims only", pays Jev again for unchanged evidence, and churns claim IDs inside an active review. That churn would make R7 corrections noisy.
- **A tutor agent with tools (`claude -p` plus MCP tools that read evidence and write observations).** The model would own state transitions, so R3, R11, and R14 would be enforced by the prompt. The spec says the tutor does not control state transitions.
- **A thick extension that segments in the service worker and calls Jev from it.** Keys would leave the backend, and MV3 worker lifetime would make in-flight calls fragile.

## Open questions and risks

1. **`--bare` vs. the subscription.** `claude --help` says `--bare` reads only `ANTHROPIC_API_KEY`/`apiKeyHelper`, never OAuth. Which should we use: `--bare` with an API key (cost *measured*), or subscription auth without `--bare` (cost *notional*, as in the live-call scope)? The arg builder has a single switch for this.
2. Should returning to a watch page after an automatic `left_watch_page` pause resume capture automatically, or wait for Derek?
3. Should "I don't know" with no later answer be `unresolved` (a gap worth revisiting) or `not_assessed`?
4. Is `after_help` a learning gap? The sketch says no and treats only unresolved/partial as gaps.
5. Should Derek's own status override also be clamped by R12/R13? The sketch says yes.
6. Does a tutor `diagnose` question count as help under R12? The sketch counts only `hint` and `explain`.
7. Should a caption segment count as evidence when 50% or more of it is inside watched time? R1 is strict, and partly watched segments are flagged `partiallyWatched`.
8. Should `session_end` closes send an invite? The flow doesn't say. The sketch sends none, and the popup shows Review now.
9. Concept identity across lectures is currently `stableId("cpt", normalizedLabel)`, which is global and naive. Is that acceptable for the MVP graph?
10. **Risk:** canvas `drawImage` readback of YouTube MSE video needs a probe on Windows Chrome. The fallback is `captureVisibleTab`. Background tabs stop decoding, which the design records as a frame gap.
11. **Risk:** Jev window frames are *candidates*, not teaching-judged frames, so that segmentation doesn't wait on frame judgments. Is that the right latency trade?
12. **Risk:** passing images to `claude -p` through `--input-format stream-json` content blocks is unprobed. The fallback is `--add-dir` plus the Read tool limited to the frames directory.

## Next implementation step

W10 lands the kernel first: `shared/ids.ts`, `shared/time.ts` with `IntervalSet` property tests, `shared/domain.ts` frozen, `db.ts`, and `providers/memo.ts` with a `FakeTask` harness. Every other workstream builds and tests against that.

## Parallel workstreams (≤ 10 workers, disjoint files)

Contract freeze: `src/shared/**`, the `providers/memo.ts` `Task`/`Lookup`/`Memo` types, and every module's exported type are frozen once the kernel lands. Changes go through W10. All tests use `FakeTask` scripted answers. No worker makes live calls outside Derek's five approved experiments.

| # | Workstream | Owns (files) | Depends on | Done when |
| --- | --- | --- | --- | --- |
| W10 | **Kernel, then composition** (first, blocking, about half a day; then integration) | `src/shared/*`, `src/backend/db.ts`, `providers/memo.ts`, `test/fakes.ts`, later `http.ts`, `main.ts`, `scheduler.ts`, `test/boundaries.test.ts` | n/a | kernel tests green; then the end-to-end replay test passes |
| W1 | Extension playback + frames | `extension/content/capture.ts`, `frames.ts` | kernel | tracker tests (simulated video events: seek, rate, ad, hidden) and diff/normalize tests; manual probe on Windows Chrome |
| W2 | Extension transcripts, SW, popup, build | `extension/content/transcript.ts`, `main-world.ts`, `extension/worker/*`, `extension/popup/*`, `extension/manifest.json`, `scripts/build-extension.ts` | kernel | `transition` table tests, outbox idempotency, json3 parse, panel read on the acceptance lectures |
| W3 | Evidence store | `backend/evidence/*` | kernel | R1, R2, R16 tests; gaps; frames written to disk with temp+rename |
| W4 | Segmentation | `backend/segmentation/*` | kernel, W3 types | `planChunks` tests for every table row, flag cut-back, reconsider, time cap at soft pause, cross-source, session end |
| W5 | Providers | `providers/ledger.ts`, `jev.ts`, `jev-tasks.ts`, `claude.ts`, memo implementation | kernel | R17 tests, single-flight, replay mode, CLI arg builder, Jev error → uncertain |
| W6 | Preparation | `backend/preparation/*` (core + Claude task prompts) | kernel, W4 types | R3, R4, R6, R8 tests; delta interpretation; stop early/retry |
| W7 | Review lifecycle | `backend/review/index.ts` + `review/core.ts` (invites, freezeScope, corrections, turn plumbing) | kernel, W6 types | R5, R7, R9, R10 tests; idempotent start and turn |
| W8 | Tutor + record | `backend/review/tutor.ts`, `review/clamp.ts`, `backend/record/*` | kernel, W7 types | R11–R15 tests; `validateMove`; attribution in notes |
| W9 | Review app | `src/app/*` | `shared/wire.ts` | review flow against a fake backend; speech in; streaming sentences; Processing / partial / nothing-to-review states; record inspector; usage view |

The dependency arrows in this table point at *types* only. All of them are frozen in the kernel, so W1–W9 run concurrently. The integration risk is concentrated in W10's composition and in the replay end-to-end test, which drives the pipeline from a recorded fact log with memoized provider outputs.
