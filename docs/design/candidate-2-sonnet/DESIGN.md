# After Class MVP: candidate 2 design package

Shape in one line: **a pure, typed decision core (state-machine reducers whose return types forbid the forbidden) under thin IO shells, over a content-addressed evidence/preparation store with one writer per table, fed by an append-only capture log from the extension.**

The sketch compiles (`tsc --noEmit` clean under the repo's strict tsconfig, TypeScript 7.0.2) and `bun test` passes the 12 architecture rules; the 24 per-rule tests are `test.todo` with named enforcement sites. Paths inside the sketch's header comments drop the `shared/` and `backend/` prefix (e.g. "core/review" is `src/shared/core/review.ts`).

## Problem

Capture a YouTube lecture from Windows Chrome into a faithful, media-time evidence log; cut it into semantic chunks with Jev's narrow judgments plus code-owned routing; prepare evidence-checked claims in the background; run a source-grounded Socratic review; save a record that never overstates what the learner showed. The shape is non-obvious for four reasons found in the grounding docs:

1. Seventeen approved rules (R1-R17), eleven of them model-checked invariants. Most are "X can never happen", which is cheapest to guarantee by making X unrepresentable, then re-checking by property test against the same reducers the TLA+ model abstracts.
2. Many writers touch one conceptual thing: the extension (spans), the boundary stage (chunks), job results (claims), the learner (notes, disputes), retention (evidence). Each must own its own data and be merged at the read boundary.
3. Slow, paid, cancellable jobs race with user choices (Later, Stop early, boundary revision). R8 requires stale results to be inert.
4. Windows Chrome MV3 extension talking to a WSL backend: ephemeral service worker, JSON-only runtime messaging, cross-origin localhost, hidden-tab throttling, YouTube SPA navigation, ad media reusing the same `<video>`.

Constraints honored: TypeScript 7, Bun 1.4.3 (`Bun.serve`, `bun:sqlite`, `bun test`, `Bun.build`), zod 4.6.7, React 19.3.1, **no other dependency** (Claude via `claude -p`; `@anthropic-ai/sdk` from the flow's package table is not used, see Open questions). Existing script `dev` runs `src/backend/main.ts`, so the tree uses `src/backend/`.

## Usage (caller's view)

Written before the types; the sketch was reconciled to it.

**Review app** (React): one typed client generated from one route table.

```ts
const r = await api["review.begin"]({ captureId, reviewId: newId(), mode: "now" });   // "Review now" is always callable
if (r.kind === "started") {
  for await (const ev of api["review.turn"]({ reviewId: r.reviewId, turnId: newId(), kind: "continue", text: "", viaSpeech: false }))
    if (ev.tag === "say_delta") speech.push(ev.text); else if (ev.tag === "tutor_turn") append(ev.turn);
} else if (r.kind === "processing") show(<ProcessingPanel start={r} .../>);        // estimate only if estimateMs != null
else show(<NothingToReview start={r} .../>);                                        // gaps + unverified claims with evidence
```

The browser allocates `reviewId` and `turnId` before sending, so a retried request is the same request. There is no "create then fill" API.

**Extension** (content script drives pure reducers; the service worker is a durable relay):

```ts
let s = initialTracker; const out: CaptureEventBody[] = [];
for (const sample of playbackSamples) { const t = trackerStep(s, sample, policy); s = t.state; out.push(...t.commands); }
// content -> SW:  { type: "emit", captureId, bodies }   SW assigns seq, persists to chrome.storage.local, drains to POST /api/capture/events
```

**Tests / replay sample / the HTTP server all drive the same `Engine`:**

```ts
const store = openStore({ dataDir: tmp, clock });
const engine = await createEngine({ store, clock, cfg, providers: replayProviders(cassette, store.usage, clock) });
await engine["capture.ingest"]({ events });         // fabricated or recorded CaptureEvents
await engine.settle();                                // boundary stage idle, job queue empty
const prep = await engine["prep.status"]({ captureId });
```

**Pure core, as a reviewer or agent would call it:**

```ts
const t = stepTimeline(timeline, { tag: "window_judged", window, newConcept, stoppingPoint, firstViewSeq, lastViewSeq }, policy);
const g = acceptTutorMove(reviewState, tutorProposal);            // { ok:true, turn } | { ok:false, reason }
const c = clampObservation(proposal, turnLog);                    // { status, clampedBy }
```

## Shape

### Module map and ownership

```
src/
  shared/                       runtime-neutral (extension, backend and app import it); no node:/bun: imports
    domain/   ids time capture evidence judgment chunk claim job review record usage     -- types + zod, the contract
    core/     transition intervals coverage windowing routing invite prep claimMachine review clamp clock   -- PURE logic
    api/      contract.ts (route table -> Engine, Client)   views.ts (read models)
  backend/                      Bun/WSL only
    store/    db capture timeline jobs review usage index          -- sole importers of bun:sqlite; one writer per table
    providers/ ports metered index replay  jev/{questions wire images client}  claude/{cli schemas prompts adapter}
    pipeline/ boundary frames jobs prepare                         -- IO shells around core
    review/   session record                                       -- IO shell around core/review + core/clamp
    server/   http auth        engine.ts config.ts deps.ts ids.ts main.ts
  extension/  manifest.json messages.ts  content/{spanTracker adGuard frameGaps frameSampler player transcript controller}
              background/{sw outbox}  popup/popup.ts
  app/        api speech useReviewSession screens main
scripts/build-extension.ts      test/architecture.test.ts  test/rules.test.ts
```

### Data structures first, with their dominant access patterns

| Structure | Pattern it serves | How it is traced |
| --- | --- | --- |
| `capture_events(captureId, seq)` append-only log | extension ingest (high frequency, idempotent, retried) | `INSERT OR IGNORE` on the key; ack = high-water mark; the log is the only extension-written state |
| `watched_spans(spanId)`, never merged in storage | coverage queries, R1/R2 | coverage = union of plausible spans, recomputed on read (hundreds of rows). Per-actor state, merge at read boundary |
| `evidence` with natural `EvidenceId` and `viewSeq` | window cutting in viewing order; rewatch dedupe; citations | `INDEX(capture_id, view_seq)`; rewatch re-derives the same ids so `materializeEvidence` is a no-op |
| `ChunkId` slot + immutable `ChunkRevision{contentKey}` | prep, cache, boundary revision, stale-job detection | `ContentKey = hash(evidence ids + text hashes + kept frames + PROCESSING_VERSION)`. Same content, same key, cache hit; revised boundary, new key, old jobs are outdated by derivation |
| `open_chunk` (the one mutable row) | boundary stage only | single writer, serialized per capture; JSON with optimistic `judged_through` check |
| `claims.versions` as a 1-or-2 tuple + `ClaimStatus` | R3, R4 | the type has no third version; `revising` has one inbound edge |
| `invite_log` append-only, state = `foldInvites(log)` | two actors (pipeline closes, learner chooses) | no row to race on |
| `review_turns` append-only, `TurnId` allocated by the app | review resume, R12/R13 clamp, retry safety | clamp is a pure function of this log |
| natural `ObservationId/NoteId/LinkId`; `Note{generated, userText}` | R15, learner edits vs retries | `ON CONFLICT DO UPDATE` writes `generated` only |
| `usage_events` + `Cost` as a 4-variant union | R17, "unknown is not zero" | `CHECK ((cost_kind='unknown') = (cost_usd IS NULL))`; `CostTotal{knownUsd, unknownCalls}` cannot be summed into one number |

Nothing in the table needs "an index or cache later".

### Flow of data, by signatures alone

`CaptureEvent` (extension) -> `CaptureRepo.append` (one tx: log, spans, `materializeEvidence`) -> `TranscriptEvidence`/`FrameEvidence` -> `judgeFrameCandidates` (Jev: keep/drop) -> `nextWindow` -> `JevPort.judgeBoundary` (cached) -> `stepTimeline` -> `TimelineRepo.commit` (one tx: judgment + timeline + `ChunkRevision` + invite entry + `interpret` job) -> `JobRunner` leases -> `ClaudePort.interpret` -> `JobRepo.applyResult` (the R8 fence; `claimStep`) -> `claim_check` (Jev) -> maybe `claim_revise` -> `supported_by_check | unverified` -> `reviewReadiness` (derived) -> `startReview` (frozen `ReviewScope`, `NonEmpty<SupportedClaim>`) -> `reviewTurn` (tutor proposes, `acceptTutorMove` gates) -> `clampObservation` -> `commitRecord` (natural ids, idempotent).

### The rules, encoded structurally (R-number, tag, mechanism, where)

| Rule | Mechanism | Backstop |
| --- | --- | --- |
| R1 `[test]` evidence only from watched | `materializeEvidence` is the only `INSERT INTO evidence`; takes `selectCoveredSegments(track, watchedCoverage)`; the extension cannot assert evidence, only observe | architecture rule "single writer per table"; property test over arbitrary event streams |
| R2 `[test]` ads never evidence | an ad is a *point* (`ad_break{at}`), never an interval; `spanTracker` opens/extends nothing while `adShowing`; `isAdShowing` = DOM class OR duration mismatch (fail closed); backend `spanPlausible` quarantines spans that grow faster than wall time or exceed duration | tracker table tests; quarantine test |
| R3 `[TLC]` only checked claims judge | `SupportedClaim`/`SupportedClaimId` minted only by `asSupported`; `ReviewState.claims`, `acceptTutorMove` take only them; model's claim id string is looked up in the state, never trusted | architecture rule "brand minting"; `@ts-expect-error` type test |
| R4 `[TLC]` one revision | `ClaimVersions = [v] | [v, v]`; claim machine has one edge into `revising`; job target `version: 1 | 2` | property test on `claimStep` |
| R5 `[TLC]` Later never cancels | `chooseLater/chooseWait: Transition<InviteState, never>`; `CancelScope` is only constructible in `chooseStopEarly` | type test; e2e |
| R6 `[TLC]` resources never block | `reviewReadiness(chunks)` has no resource input; `resource_search` is a separate job kind outside prep inputs | architecture rule bans the word `resource` in `prep.ts`/`review.ts` code |
| R7 `[TLC]` scope never grows | `ReviewScope` frozen, `evidence` is a ceiling; `askableClaims` filters `claim.evidence ⊆ scope.evidence`; no `extend` function exists; corrections swap claims per `ContentKey` | property test on `applyCorrection` |
| R8 `[TLC]` stale results inert | one fence, `JobRepo.applyResult`: `cancelled_at` null, job `running`, target still current (derived from `ContentKey`); otherwise `stale_results`. Claims are written by no other path; jobs have no FK to notes | fence tests incl. boundary revision |
| R9 `[TLC]` capture and review independent | separate aggregates, no shared event/command types; `core/review` cannot import capture-side modules | architecture rule "R9" |
| R10 `[TLC]` no empty review | `ReviewStart.started.claims: NonEmpty<SupportedClaim>` | type |
| R11 `[TLC]` detour needs yes | `DetourConsent` branded, minted only from a *learner* `accept_detour` turn; tutor output can only produce `DetourState.proposed` | architecture rule; unit |
| R12 `[test]` help before answer | `clampObservation` derives the ceiling from the code-written turn log (`isHelp(turn)` before the cited answer caps at `after_help`); model proposes, code clamps | property test |
| R13 `[test]` skip never understood | no learner `answer` turn => `not_assessed` for every proposal; questions the model omits default to `not_assessed` | property test |
| R14 `[TLC]` disputes | `DisputeState.resolved.by` is only `"learner"`; `countsAsGap` excludes `open`/`unsettled` | unit |
| R15 `[test]` retry no duplicate | natural IDs (`observationIdFor(review, question)`, `noteIdFor(review, subject)`); `ON CONFLICT DO UPDATE` on `generated` only; pending draft is stored and retried verbatim, never rebuilt | row-count test |
| R16 `[TLC]` cited evidence not expired | DB trigger `BEFORE DELETE ON evidence WHEN live citation EXISTS -> ABORT`; expiry SQL also says `NOT EXISTS`; user deletion is a separate function that flips citations to `deleted` (tombstone) first; no route exposes expiry | trigger test |
| R17 `[test]` usage recorded; unknown != 0 | `metered()` appends in `finally` on every path; `Cost` has an `unknown` variant and no optional number; schema CHECK | architecture rule bans `usd?:` |

TLC note: the model file `docs/flows/model/Preparation.tla` lets a result from an *outdated* job land on a claim (`ALateResultArrives`). R8 says outdated results never overwrite current preparation, and this design fences both cancelled and outdated. The model should be amended to match R8 before its R8 property is relied on.

### Tricky logic, where the pseudocode lives

| Problem | File |
| --- | --- |
| watched spans under pause/seek/speed/replay/ad/navigation | `extension/content/spanTracker.ts` |
| ad detection: DOM class OR duration mismatch | `extension/content/adGuard.ts` |
| hidden tab / stalled decode => frame gap, never invented frames | `extension/content/frameGaps.ts` |
| frame candidates: settle-then-send diff, max-wait for continuous handwriting, periodic floor | `extension/content/frameSampler.ts` |
| panel transcript first, caption interception fallback, usable-track test | `extension/content/transcript.ts` |
| plausible spans and R1 coverage | `shared/core/coverage.ts` |
| windows in viewing order, rewatch yields no new window | `shared/core/windowing.ts` |
| 2x2 routing, soft pause, pending boundary (one-window recheck), time-cap cut at the soft pause, carry-over | `shared/core/routing.ts` |
| invite fold, "15 min since last invite or Later" | `shared/core/invite.ts` |
| claim machine and draft validation | `shared/core/claimMachine.ts` |
| the R8 fence | `backend/store/jobs.ts` |
| tutor gate; header-first streaming so nothing is spoken before the gate passes | `shared/core/review.ts`, `backend/providers/ports.ts` (`TutorEvent`), `backend/review/session.ts` |
| observation clamp | `shared/core/clamp.ts` |
| metering on every path | `backend/providers/metered.ts` |

### Extension capture

- **Content script** (`controller.ts`) owns DOM listeners and three pure reducers (`trackerStep`, `frameHealthStep`, `samplerStep`). Time is `MediaMs` (zod brand); `WallMs` is a different brand, so wall-clock cannot flow into evidence by type.
- **Spans** are re-sent with the same `spanId` as they grow (heartbeat, `open: true`) and once with `open: false`; ingest takes `max(end)`, so a lost or duplicated message is harmless.
- **Ads**: close the span, record `ad_break{at}`, ignore ticks until the ad ends, then open a *new* span. Both signals (DOM class, duration mismatch) close the first-tick race.
- **Hidden tab**: captions keep flowing (they come from the panel/track, not rendering); frames log a `gap{channel:"frames", reason:"tab_hidden"}` interval.
- **Frame candidates**: 64x36 luma thumbnail each ~1 s of media time; send when changed *and settled*, or after a max wait, or periodically. Encoded JPEG is capped at 1280 px longest side so it satisfies Jev's 280-1568 px/side and pixel bounds (Bun has no resizer, so bounds are met at capture; `jevImageEligible` double-checks and omits, never fails the request).
- **Transcript**: panel rows -> `rowsToSegments`; fallback is a MAIN-world hook that forwards the player's own `/api/timedtext` response (it carries the token the page computed). Whole track is sent as "available"; the backend decides what is evidence. Unusable => `transcript_unusable` event => popup offers opt-in transcription; the choice is itself an event.
- **Service worker** is a relay with a durable outbox in `chrome.storage.local`: seq is allocated there (monotone across content-script reloads), frames go bytes-first (base64 over JSON-only runtime messaging, decoded before the binary `PUT`), drained with backoff, acked by high-water mark, idempotent by `(captureId, seq)`. Only the SW talks to the backend, so content scripts never hit CORS/Private Network Access.

### Backend

- `Engine = Handlers` derived from `api/contract.routes`. The HTTP server is generic over the table (no per-route code); client, server and engine cannot disagree. Requests are zod-validated; responses are `z.custom<T>()` typed (our own code produces them).
- **Concurrency without locks**: extension and boundary stage and job results and review turns each write their own tables; the only mutable row (`open_chunk`) has one writer (a per-capture async queue); invites are a fold; stale jobs are fenced in SQL.
- **Jobs** (`interpret`, `claim_check`, `claim_revise`, `resource_search`) have natural `JobKey` (UNIQUE; enqueue is `INSERT OR IGNORE`), bounded attempts, leases with crash recovery. Boundary and frame judgments are *not* jobs: they are ordered, cheap, cached by input hash, and re-derived from the cursor after a crash, so they need no fence.
- **Providers**: `JevPort` and `ClaudePort` take and return domain types. Wire shapes (`jev/wire.ts`) and the CLI transport (`claude/cli.ts`) are importable only inside `providers/` (architecture rule). `metered()` ledgers every call, including failures and aborts. Jev failure is an `uncertain` `Answer` (so routing's "uncertain/error => continue" has one coercion, `asYes`), cost `unknown` always. Claude cost is `notional` from the CLI result when present, else `unknown`. `replayProviders` serves the labelled public sample from a cassette and fails loudly on a miss.
- **Review**: the tutor model proposes (`TutorProposal`), `acceptTutorMove` disposes (claim askable, budget, evidence inside scope, phase, detour only as *proposed*). Gate rejection triggers one silent re-ask, then a code-authored fallback, so the model cannot wedge a review. Learner barge-in aborts the HTTP request, which kills the `claude` child.
- **Security**: the backend is reachable from any web page, so `authorize()` requires Host match (anti DNS-rebinding), Origin allow-list, and a pairing token; no CORS `*`.

### Interface depth

- `CaptureRepo.append(batch)` hides dedupe, spans, plausibility, coverage, materialization, view ordering, frame pending/covered logic. One call.
- `JobRepo.applyResult` hides the fence, the claim machine, and follow-up enqueue. Callers never see claim status transitions.
- `TimelineRepo.commit` hides a five-table transaction (judgment, timeline, revisions, invite, enqueue).
- `ClaudePort`/`JevPort` hide transport, wire, schema parsing, concurrency, metering. Nine methods in total.
- `Engine` is wider (22 routes) but each is a product verb; it is the surface the spec names. It has no pass-through layer: handlers call store/pipeline/review directly (route -> engine -> one shell -> core: three files).
- What stays exposed to callers: policies (passed as arguments), and the `Transition`/command vocabulary. That is deliberate: it is what makes the shells thin and the rules testable.

## Synthesis decision

*Filled in by arena.*

## Tradeoffs accepted

- We accept **two caption stores' worth of data** (full track kept as "available" plus materialized evidence) in exchange for R1 being a property of one function rather than a filter every reader must remember.
- We accept **content-addressed preparation** (new key on any evidence change) in exchange for automatic rewatch cache hits and derived staleness; a boundary revision recomputes claims for that chunk.
- We accept **recomputing coverage from spans on every read** in exchange for no shared merged row and no ingest race; the cost is trivial at this scale.
- We accept **boundary and frame judgments running inline** (not as fenced jobs) in exchange for fewer concepts; they cannot be "outdated" because they only read immutable evidence.
- We accept **a wide-ish `Engine`** in exchange for one list of operations from which server, client and tests derive; adding a route is one table row plus one handler.
- We accept **`z.custom<T>()` responses** (typed, not validated at runtime) because the sender is our own code; requests, SQLite JSON columns and CLI/HTTP provider outputs are all zod-parsed.
- We accept **JPEG frames at 1280 px** which may soften fine equation detail; PNG is a one-line switch if the probe shows it matters (Jev limit 16 MiB).
- We accept **frame bytes as base64 through runtime messaging** (33% overhead) because MV3 messaging is JSON-only; the alternative (content-script `fetch` to localhost) needs CORS/PNA and exposes the token path to the page.
- We accept **tutor streaming with header-first schema** (needs a small incremental JSON extractor) so the gate runs before any word is spoken. If the spike shows structured-output deltas are unavailable, fallback is whole-turn delivery; voice is parked anyway.
- Things that look like oversights but are not: no `insertEvidence`, no `Store.update*Claim`, no scope `extend`, no `cost?: number`, no Jev call as a job, no resource field in readiness. Their absence is the encoding.

## Alternatives considered

1. **Full event sourcing** (every fact an event, all state a projection). Rejected: forces projection/rebuild machinery for fully derivable things; we keep event logs exactly where an actor boundary exists (capture, turns, invites) and derive the rest. Hides more, but exposes projection versioning to every module.
2. **Layered CRUD services plus a central orchestrator holding job state.** Rejected: split ownership (orchestrator and DB both hold status), R8 becomes ad hoc checks in each handler, and each rule is prose. Exposes status-juggling to callers.
3. **Vertical feature modules, each owning logic and tables, no shared core.** Attractive for parallel work, rejected: R3/R7/R8/R9 cut across features and need single decision points. We keep the parallelism by giving each worker whole files of one layer instead.
4. **Send every frame to the backend and diff there.** Rejected: bandwidth at 1 fps, and Bun cannot decode images without a dependency. Pixel diff on a 64x36 luma thumbnail in the page is cheap and the backend stays decode-free.
5. **Mutable chunk rows updated on boundary revision.** Rejected: stale-job detection becomes a version counter that every job must remember to check; content addressing derives it.
6. **Jobs for every Jev call.** Rejected: boundary judgments are ordered per capture and cacheable; a job row adds a state machine with nothing to fence.
7. **Review app keeps the conversation and POSTs a bundle at the end.** Rejected: a crash loses the session and "pending save" semantics blur. The backend persists each turn; the "pending save" is only the final record commit.
8. **WebSocket instead of HTTP + SSE.** Rejected: more moving parts inside an ephemeral MV3 service worker, no benefit at this message rate.

## Open questions and risks

1. What are the exact envelope fields of `claude -p --output-format json` when `--json-schema` is used, and does `stream-json` expose partial structured-output deltas (and need `--verbose`/`--include-partial-messages`)? The adapter parses defensively and the tutor has a whole-turn fallback, but this needs a one-call spike inside the approved live-call scope.
2. Is a frame candidate that arrives after its chunk closed acceptable to leave out of that chunk? Proposal: yes (chunks are immutable revisions), but the boundary stage may wait one outbox grace period before cutting. Is a few seconds of added latency acceptable?
3. Where should the cut go when a recheck resolves ("cut where the new concept began")? This design cuts at the flagged passage start; the flow does not say. Confirm or give a rule.
4. R12 only sees help the tutor *declares* (`hint`, `explain`, `correction_disclosure`). A follow-up that leaks the answer is invisible. Should a narrow Jev judgment "does this tutor message reveal claim X's content?" run on tutor turns that precede the first answer?
5. Machine transcription has no selected provider. The design records the choice and keeps the gap visible; `machine_transcription` provenance is reserved. Which provider (or none for the MVP)?
6. Fixed port 4417 and extension-id pinning for the Origin allow-list: acceptable? Does the user's WSL networking mode forward `localhost`, or is `0.0.0.0` plus token needed?
7. `@anthropic-ai/sdk` 1.3.0 appears in the flow's stack table but the brief and `package.json` say no other dependency and `claude -p`. This design does not use the SDK. Confirm the table is stale.
8. The TLA model lets outdated results land (see TLC note). Amend the model, or is R8 meant to cover only cancelled jobs?
9. Watched-ratio floor for a caption segment partly watched (default 0.5): is a half-watched caption evidence of watching?
10. Resource-search job is a typed stub (`resource_search` kind, `ResourcesOut` schema, handler comment). Build order is after the core path.

## Next implementation step

Promote this package to `src/`, implement the foundation pieces that every worker needs (`store/db.ts`, `store/index.ts` migration discovery, `backend/ids.ts`, `shared/core/transition.ts`), and commit; then fan out the ten workstreams below.

## Parallel workstreams

**W0, foundation commit (orchestrator, before fan-out; not a worker):** promote `src/shared/domain/**`, `src/shared/api/**` (types, route table), every `ports`/repo interface, `core/transition`, `core/clock`, `backend/ids.ts`, `store/db.ts`, `store/index.ts`, `test/architecture.test.ts`, `test/rules.test.ts`. After W0, every file below has exactly one owner and every cross-worker dependency is a frozen type signature, so all ten start at once and test against fakes. Contract edits (anything in `shared/domain`, `shared/api`, `ports.ts`, repo interfaces) go through the orchestrator.

| # | Workstream | Owns (disjoint) | Done when | Depends on (frozen types only) |
| --- | --- | --- | --- | --- |
| W1 | ext-media | `extension/content/{spanTracker,adGuard,frameGaps,frameSampler,player}.ts` + tests | reducer tables for pause/seek/rate/replay/ad/hidden/navigation; pixel-diff fixtures; invariants R2 (no span while ad) | `domain/capture` |
| W2 | ext-shell + transcript | `extension/content/{transcript,controller}.ts`, `extension/background/*`, `popup/*`, `messages.ts`, `manifest.json`, `scripts/build-extension.ts` | extension builds; outbox survives SW kill and backend downtime; transcript parsers pass fixtures; popup renders views | W1 reducer signatures, `api/contract` client |
| W3 | evidence-store | `shared/core/{intervals,coverage}.ts`, `backend/store/capture.ts` (CaptureRepo + RetentionRepo), frame files, image header parse | R1, R2 (quarantine), R16 (trigger, tombstone) tests green on `:memory:` | `store/db` |
| W4 | boundary | `shared/core/{windowing,routing,invite}.ts`, `backend/store/timeline.ts`, `backend/pipeline/{boundary,frames}.ts` | routing table + time cap + carry-over property tests; crash-resume at cursor; frame keep/drop | `JevPort`, `CaptureRepo` types |
| W5 | prep | `shared/core/{claimMachine,prep}.ts`, `backend/store/jobs.ts`, `backend/pipeline/{jobs,prepare}.ts` | R4, R8 fence tests; Stop early cancels and aborts; restart recovers leases | `ClaudePort`, `JevPort`, `TimelineRepo` types |
| W6 | jev + ledger | `backend/providers/{metered,index,replay}.ts`, `providers/jev/*`, `backend/store/usage.ts` | R17 on every outcome incl. abort; Jev request/response against recorded fixtures; image eligibility; cassette record/replay | `ports`, `ClaudePort` factory signature |
| W7 | claude | `backend/providers/claude/*` | argv builder, envelope parse, zod outputs, stream extractor tested on chunked fixtures; kill-on-abort; concurrency semaphore | `ports`, `metered` signature |
| W8 | review | `shared/core/{review,clamp}.ts`, `backend/store/review.ts`, `backend/review/*` | R3, R7, R10-R15 tests; gate rejection fallback; pending-save retry idempotent | `ClaudePort`, `Readiness` types |
| W9 | backend shell + integration | `backend/{engine,config,deps,main}.ts`, `backend/server/*`, `shared/api` client implementation, e2e replay sample + cassette harness | HTTP server generic over route table; auth tests; e2e: fabricated event stream through to saved record with replay providers | everything (integrates last) |
| W10 | review app | `src/app/*` | screens render all view variants from fixtures; barge-in aborts request; pending-save banner; speech interfaces | `api/views`, `api/contract` |

Integration milestones follow the spec's delivery order, not worker count: **M1** real capture path to evidence on Windows Chrome (W1, W2, W3, W9; no paid calls); **M2** inspectable Jev preprocessing (W4, W6; live calls only inside the five approved experiments); **M3** preparation (W5, W7); **M4** review, record, app (W8, W10). No worker needs a live key: tests use fakes and replay.
