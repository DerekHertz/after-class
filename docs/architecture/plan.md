# Migration plan: from the local app to the hosted stack

Status: written 2026-11-13 against `master` at `476d2a4`; Derek approved `decision.md` as written on 2026-11-13 and asked for Phase 0 and Phase 1 to start in parallel. It follows `docs/architecture/decision.md` and assumes that document's recommendations. If Derek changes a recommendation, the phase that implements it changes and the others mostly stand.

No phase starts before Derek approves it. No dependency is added before Derek approves its name, exact version and reason. Nothing deploys without Derek's explicit authorization.

## Principles

- The local product keeps working after every PR. `bun run typecheck` and `bun test` pass on every PR, and replay mode keeps running with no keys.
- Change one thing at a time. Tenancy comes before the engine change. The move to asynchronous transactions comes before Postgres. The process split comes after both.
- Each phase is a few PRs, each small enough for the usual worker and verifier loop in `docs/trail/handoff-1.md`.
- Derek's rules R1 to R19 are unchanged by this plan. Where the hosted product may need a new rule, the plan says so and Derek writes it.
- Flow changes go to Derek as amendments to `docs/flows/after-class.md`, and the TLA+ models are rerun when a flow line changes.

## What is reused and what is rebuilt

| Part | Reused as it is | Changed | Rebuilt |
| --- | --- | --- | --- |
| `src/shared/*`: domain types, ids, time, `ROUTES` and wire schemas | Yes | A few routes are added for devices, account and budget | |
| Pure logic in each module's `core.ts`, the tutor, the clamp, the detour | Yes | | |
| TLA+ models and the rules tests | Yes | Rerun on any flow amendment | |
| Tests with `fakeTask` and the replay end-to-end test | Yes | They gain a second user and a Postgres run | |
| Extension capture, frames, transcript, outbox | Yes | Backend URL and token source | The options page pairing step becomes "Connect" |
| Review app | Yes | `createApi` gets its token from the sign-in session | Sign-in screen, device list, budget notice |
| `memo.ts`: keying, `Task`, retries, usage events, `appliesBefore` | The design | User attribution, cache scope, leases, budget reserve | The in-process `inflight` map |
| `claude-api.ts`, `jev.ts`, `elevenlabs.ts`, `ledger.ts` | Yes | Ledger queries filter by user | |
| `claude.ts`, the `claude -p` path | Local development only | | Not used in the hosted product |
| `scheduler.ts`: demand sources, priorities, the resource-search slot rule | Yes | Runs per capture inside a queue handler | The single-process pump loop and timers |
| `http.ts`: routing, parsing, NDJSON, limits | Yes | `authorize`, CORS origins, heartbeat lines | Host check, pairing token, `guard.inFlight`, serving `/app/*` |
| `db.ts`: migration runner, table ownership | The runner and the ownership test | Asynchronous `Db`, user scope | Every migration's SQL in the Postgres dialect, all 86 call sites |
| `evidence/index.ts` frame files | | Reads and writes go through a frame store interface | The filesystem code becomes one of two implementations |
| `main.ts` | Wiring order | Configuration from the environment | Split into an `api` entry and a `worker` entry |
| CI in `.github/workflows/ci.yml` | Yes | Adds a Postgres service | A deploy workflow is new |

## Phase 0: decisions and spikes

Goal: settle what blocks everything else, and remove the largest unknowns cheaply.

- Derek reviews `decision.md` and marks each recommendation approved, changed or parked.
- The agent drafts, and Derek approves, an amendment to the Stack section and the Live-call scope section of `docs/flows/after-class.md`. Today that section limits live calls to named experiments, so a hosted product that calls Claude and Jev for other people is outside it.
- Spike 1, no new dependency: run the kernel tests of `db.ts` against Postgres in a local container through `Bun.sql`. Report what in the SQLite dialect does not carry over.
- Spike 2, in a scratch directory outside the repo and only with Derek's OK for the package: pg-boss on Bun 1.4.3. Report its exact version, its dependency tree, whether it needs install scripts, and whether enqueue, dedupe, schedule and a worker loop behave.
- Spike 3, reading only: confirm from current provider documentation the items that `decision.md` lists as from memory, and re-read the unverified prices for the chosen services.

Leaves the repo unchanged except for a results note under `docs/architecture/`.

## Phase 1: tenancy inside the local app

Goal: the code knows about users while it is still one process on SQLite. All of it is testable with the existing suite and no infrastructure.

1. Add `UserId` to `src/shared/ids.ts` and a `users` table. The local app has one user, created on first boot.
2. Add `user_id` to every per-user table by appended migrations, one PR per owning module in the order of `src/MODULES.md`. Check each `stableId` kind for cross-user collisions and widen primary keys where needed.
3. Make the `Db` handle that modules receive user-scoped. Extend `test/boundaries.test.ts` to fail on SQL that reads or writes a per-user table without `user_id`.
4. Add an ownership test per route: a second user who presents another user's `captureId`, `reviewId`, `evidenceId`, `noteId` or `linkId` gets 404.
5. Add `user_id` and `capture_id` to `usage_events` by a rebuild migration of the kind `db.ts` already contains. The R17 triggers carry over. `GET /usage` reports the caller's usage only.

Done when two users in one test database cannot see or change each other's data on any route.

## Phase 2: asynchronous storage, still on SQLite

Goal: separate the change in code shape from the change of engine.

1. Change `Db.tx` and every query helper to return promises, with `bun:sqlite` still underneath. One PR for the kernel, then one per module.
2. Replace synchronous `memo.lookup` inside derivations with "load the lookups this derivation needs, then run the pure function". `LookupFn` already exists so derivations can run against a map.
3. Add the per-user command lock as an interface, and call it at the start of every command. The Postgres spike in `docs/architecture/spike-postgres.md` showed that R16 fails on Postgres without it, so the lock is real from its first use there.
4. Review every transaction body for an `await` between a check and its use. This is the "state checked then used later" class from the retros, and it is the main risk of this phase.

Done when the suite passes with the asynchronous interface and no module imports `bun:sqlite` except the SQLite implementation of `Db`.

## Phase 3: Postgres and the frame store

Goal: the same tests pass on Postgres, and frames no longer need a local disk.

1. Port each module's migrations to the Postgres dialect as a second migration set, one PR per module: typed columns for `STRICT`, `jsonb`, PL/pgSQL versions of the append-only, R16 and R17 triggers, and `ON CONFLICT` for `INSERT OR IGNORE`.
2. Add the Postgres implementation of `Db` on `Bun.sql`, with the per-user advisory lock and the per-user sequence row.
3. Run the whole suite against Postgres in CI. Derek decided on 2026-11-13 that SQLite does not stay after the move, so local development and replay samples run on Postgres in a container, and the SQLite implementation of `Db` is removed once the suite passes on Postgres.
4. Introduce a frame store interface with two implementations: the current filesystem code, and S3 through `Bun.s3`. Write the object before the row, and add the orphan sweeper.
5. Change `GET /frames/:evidenceId` to redirect to a presigned URL when the S3 store is active.
6. Write a one-off importer from an existing `afterclass.sqlite` and its `frames/` directory into Postgres and the bucket, so Derek's own record moves with him.

Done when CI is green on Postgres and a local run with Postgres in a container and a local bucket emulator or the filesystem store completes the replay end-to-end test.

## Phase 4: a deployed skeleton

Goal: surface infrastructure problems before the application depends on them. This phase can run in parallel with phases 2 and 3 once Derek has an AWS account.

1. A `Dockerfile` for the Bun image, built for ARM in CI.
2. Terraform for the network, the load balancer with a certificate, the registry, one ECS service, the RDS instance, the frames bucket, the app bucket with CloudFront, the secrets, the log groups and the GitHub OIDC role. State in an S3 bucket.
3. A deploy workflow behind a protected GitHub environment that Derek approves: build, push, migrate, update the service.
4. Deploy the backend in replay mode with sign-in disabled and only `GET /health` and one replay turn reachable from Derek's address. Check that an NDJSON turn streams through the load balancer delta by delta, that a silence longer than the idle timeout survives with heartbeat lines, and what a deploy does to a turn in progress.

Done when a push to `master`, approved by Derek, replaces the running task with no manual step, and the three streaming checks have recorded results.

## Phase 5: sign-in and the extension

Goal: real identities replace the pairing token.

1. `authorize` gains a hosted mode: verify the auth provider's signed token against its published keys, map the subject to a `users` row, and drop the localhost Host check. The local mode stays for development.
2. The web app gains sign-in with Google through the provider, and `createApi` sends the session token. The token `<meta>` tag is removed in hosted mode.
3. Device tokens: the table, the connect and exchange routes in `ROUTES`, the `/connect-extension` page, the device list and revoke in settings.
4. The extension reads its backend URL from the build, replaces the hardcoded `127.0.0.1:4317` in `manifest.json`, `service-worker.ts`, `control.ts` and `popup.ts`, adds `externally_connectable`, and swaps the options page's paste field for "Connect".
5. An invitation list gates sign-up.
6. Account deletion and record export.

Done when a second Google account, invited by Derek, can install the extension build, connect it, capture in replay or live mode as approved, and see only its own data.

## Phase 6: API and worker as separate processes

Goal: more than one of each can run.

1. Split `main.ts` into an `api` entry and a `worker` entry that share the composition code.
2. Add the queue. Fact-writing commands enqueue "pump capture C" in their transaction. The worker handler runs the existing demand and dispatch loop for that capture. A scheduled job reconciles captures with unmet demand, and another runs `sweepExpired`.
3. Replace the memo's `inflight` map with `memo_leases`, with expiry and renewal.
4. Replace `guard.inFlight` with `review_turn_leases`, and add wait-and-replay for a resend that lands on another task. Add the heartbeat event to the turn stream's wire schema.
5. Handle `SIGTERM`: stop taking work, let running calls finish within the platform's grace period, release leases.
6. A test that runs two API instances and two workers against one Postgres and checks single-flight, the 409 on a second `turnId`, and replay of a finished turn from the other instance.

Done when that test passes and the deployed environment runs two API tasks and two workers through a rolling deploy with a review in progress.

## Phase 7: the model gateway

Goal: Derek's spend is bounded and attributed before anyone else can trigger a paid call.

1. Budgets: a per-user period budget, a global monthly budget and a global stop switch, with reserve-then-settle around each attempt in `memo.ts`. Unknown cost keeps its reservation.
2. Budget states in the wire schemas and the app: what is left, and a clear message when preparation or a new review is held back.
3. Cache scope: the shared `memo` for lecture-only purposes, per-user use records, and an audit of each task's canonical input for learner text. `tutor_turn` and `wrap_up` stay per user.
4. Rate limits: honour retry-after, reserve a share of the Claude limit for interactive calls, and give each worker a static share of each provider's limit.
5. A usage page for Derek that totals spend by user, purpose and day from the ledger, and reports the shared cache's hit rate.

Done when a test user with a small budget is stopped at the cap without a turn being cut, and the ledger total matches the sum of the budget settlements.

## Phase 8: launch to 10 invited users

Goal: people other than Derek can use it safely.

1. Structured request logs, alarms on 5xx rate, turn failures and health, and a budget alarm on the AWS account.
2. One practised restore of the database from a backup into a scratch instance.
3. The privacy notice and terms, written or approved by Derek, linked from the app and the store listing.
4. The Chrome Web Store listing, unlisted at first, with the data-use declaration.
5. A short load run in replay mode: many simulated extensions ingesting and many replayed turns, to replace the assumed task and connection counts in `decision.md` with measured ones.
6. A runbook: deploy, roll back, rotate a key, stop all paid calls, restore, delete a user's data on request.

Done when Derek has invited the first users and the runbook's stop switch and rollback have each been exercised once.

## Later, when the triggers in `decision.md` fire

- Toward 100 users: a staging environment, row-level security, Sentry, two API tasks as the floor, Multi-AZ for the database.
- Toward 1,000 users: Redis for shared rate limits and stream resume, autoscaling rules, a connection pooler, SQS if queue load shows in the database.
- When measured spend on repeated lectures justifies it: the canonical per-source preparation, brought to Derek as a flow amendment with the TLA+ models rerun.

## Risks, in the order they are likely to bite

1. The asynchronous rewrite reopens "state checked then used later" bugs. Phase 2 isolates it from the engine change, and the per-user command lock is the structural guard.
2. A missing ownership check leaks one learner's data to another. Phase 1 puts the check in the `Db` handle and in a test per route before any second user exists.
3. An uncapped paid call path. Phase 7 lands before phase 8, and sign-up stays by invitation.
4. A library that misbehaves on Bun. Phase 0 spikes it, and the fallbacks are named in `decision.md`.
5. AWS setup takes longer than budgeted. Phase 4 starts early and in parallel, and Cloud Run is the stated fallback.
6. A provider's terms or limits do not allow serving other users. Only Derek can ask, and it is on the list below.

## Only Derek can do this

Accounts and billing:

- An AWS account with a payment method, a monthly budget alarm, and multi-factor sign-in on the root user.
- A domain name, and the choice of the name.
- An account with the auth provider, and a Google OAuth client with its consent screen.
- An Anthropic organisation API key for the hosted product, in its own workspace with a spend limit, and a rate-limit tier that fits the expected use.
- A conversation with TypeSafe about serving other users on `TYPESAFE_API_KEY`: terms, rate limits and price.
- An ElevenLabs plan decision after the 3 months Derek has, or the choice to fall back to Chrome's voice for other users.
- A Chrome Web Store developer account and the listing.
- GitHub repository settings: branch protection on `master`, the protected production environment, and its reviewers.

Keys:

- Putting each provider key into the secrets store. No key is pasted in chat, as today.
- Rotating any key that was used locally before it is used in production.

Approvals:

- Each recommendation in `decision.md`.
- The amendments to the Stack and Live-call scope sections of `docs/flows/after-class.md`.
- Each new dependency by name, exact version and reason. The candidates named so far are a queue library, the auth provider's web SDK and, later, an error reporter.
- Each production deploy, through the protected environment.
- Any flow change, including the canonical per-source preparation and any change to how windows are built.

Product and policy decisions:

- Who pays for model calls: decided 2026-11-13, Derek pays within a cap. The per-user and global budget amounts are still his to set.
- Who is invited, and when sign-up opens.
- Whether preparation may be shared across users at all, given that the PRD says cross-user source-cache sharing is not required.
- Retention for other people's data. The 30-day default for uncited raw captures was set for a local, single-user record.
- Any new rule in Derek's own sentences, for example on isolation between learners, spend caps or account deletion. The agent does not draft rule text unless Derek asks, and never numbers a rule he has not approved.
- The privacy notice and terms, and advice from someone qualified on storing third-party lecture content, on learners under 18 and on users in the EU or UK.
- Whether SQLite stays as a supported local mode after the move: decided 2026-11-13, Postgres only.
