# Architecture decision: After Class as a hosted, multi-user product

Status: written 2026-11-13 against `master` at `476d2a4`. Derek approved the recommendation as written on 2026-11-13, and said he will pay for model calls within a cap. Whether Jev stays is under review in `docs/architecture/jev.md`. Nothing was built, installed, deployed or signed up for. The approved stack in `docs/flows/after-class.md` is unchanged until Derek approves an amendment. Each new dependency still needs his approval by name, version and reason.

## What Derek asked for

Derek's words, as given in the brief for this document:

- "consider this as a shippable application that maybe 10 users use tomorrow and then 100 users use next week, whatever. Just we should develop with scalability in mind."
- "weigh out the architectural decisions related to client, server, storage, load balancing, all of the above."
- "I'm really not convinced that Supabase is something that we should be using. I don't think that's a standard database system that is used. I don't need to make an enterprise level application but I would like the stack to be recognizable for tech professionals as I'm making this for a resume project."

The product stays a Chrome extension plus a web app.

## How to read this document

- Each area lists the options, compares them, recommends one, and says what would change the recommendation.
- Rules are quoted verbatim from `docs/flows/after-class.md` as `Rn: "<text>"`. This document proposes no new rule. Where a new rule may be needed, the text says so and leaves the wording to Derek.
- Every price names its source and the date it was read. "Fetched" means the public pricing page was fetched on 2026-11-13 and the number was in the page text. "Unverified" means the page did not render its table or was not fetched, and the number must be checked before anyone relies on it. Monthly figures use 730 hours and are my arithmetic, not a quote.
- User counts of 10, 100 and 1,000 are registered users. No usage data exists for more than one user, so every sizing below is an assumption that the first real users will correct.
- Nothing here claims anything about model accuracy or learning effectiveness.

## What exists today, and what stops it from serving two users

Read from the code at `476d2a4`.

| Today | Where | Why it blocks a second user or a second server |
| --- | --- | --- |
| One pairing token, minted on first boot and pasted into the extension options. The review app reads it from a `<meta>` tag in the served HTML. | `src/backend/main.ts`, `src/backend/http.ts`, `src/extension/worker/service-worker.ts` | One token means one identity. No table has an owner column. |
| `authorize` accepts only `Host: 127.0.0.1:<port>` or `localhost:<port>`, and the server binds `127.0.0.1`. | `src/backend/http.ts` | The server refuses every request that arrives through a public hostname. |
| One SQLite file through synchronous `bun:sqlite`. `Db.tx` is synchronous and "every command is one `tx`, so writers serialize without locks". About 86 SQL call sites. | `src/backend/db.ts` | A second server process cannot share the file. Every Postgres driver is asynchronous, so every call site changes. |
| One global fact sequence, `seq_counter`, that orders facts against results. | `src/backend/db.ts`, `appliesBefore` in `src/backend/providers/memo.ts` | Correct only while one process writes. |
| The scheduler has no job table. Demand is derived from facts plus the memo, and `running` is an in-process map with limits of 4 Jev and 2 Claude calls. | `src/backend/scheduler.ts` | Two processes would each run the same work and each count its own limit. |
| The memo's single-flight is an in-process `inflight` map. | `src/backend/providers/memo.ts` | Two processes can make the same paid call at the same time. |
| One running turn per review is an in-process `guard.inFlight` map. | `src/backend/http.ts` | A resend that lands on another server cannot join or be refused. |
| Frames are files under `<dataDir>/frames/<sourceId>/<evidenceId>.jpg`. Snapshots are hard links. | `src/backend/evidence/index.ts` | A container's disk is not shared and is lost on redeploy. |
| The extension hardcodes `http://127.0.0.1:4317` in code and in `host_permissions`. | `src/extension/manifest.json`, `service-worker.ts`, `control.ts`, `popup.ts` | It cannot reach a hosted API. |
| Claude defaults to `claude -p` on Derek's subscription. `AFTERCLASS_CLAUDE_BACKEND=api` runs every Claude task on the Messages API since #172. | `src/backend/providers/claude.ts`, `claude-api.ts` | A subscription login cannot serve other people. The hosted product must use the API backend. |
| `usage_events` has no user column. | `src/backend/db.ts` | Spend cannot be attributed or capped per user. |

What already fits a hosted product, and should be kept:

- `ROUTES` in `src/shared/wire.ts` is one typed list of routes with zod schemas, shared by the server, the review app and the extension.
- `POST /ingest` is idempotent on `(captureId, clientSeq)` and the extension has an IndexedDB outbox, so capture already tolerates an unreliable network.
- `POST /reviews/:reviewId/turns` is idempotent on `turnId`: the same `turnId` joins and replays, and a different one answers 409.
- Every provider call goes through `memo.run`, keyed by a hash of the provider, purpose, version, model and exact input. Every attempt writes a usage event in the same transaction as its result or failure.
- Demand is a pure function of facts and the memo, so a crashed worker loses no state.
- Replay mode runs the whole product with no keys, which is a ready-made test environment.

## 1. Clients

### Roles

The extension captures and nothing else: watched intervals, caption passages, frame candidates, capture controls and the review invite. It must keep working when the API is slow or unreachable, which the outbox already handles. The web app holds everything a learner reads or types: review, record, usage and account settings.

Keep this split. The alternative, moving review into an extension side panel, would tie review to Chrome and put learner answers inside the extension's storage. Nothing asks for that.

### How the web app is served

| Option | For | Against |
| --- | --- | --- |
| The API server keeps serving `/app/*` as today | No change. One origin, so no CORS for the app. | Every static file request costs API capacity. A deploy of the app is a deploy of the API. |
| Static bundle in object storage behind a CDN, on `app.<domain>`, with the API on `api.<domain>` | Standard. The bundle from `scripts/build-app.ts` is already static. Cheap and cacheable. App and API deploy separately. | The app becomes cross-origin to the API, so CORS must allow it. The extension is cross-origin already, and `http.ts` already has an allow-list CORS path. |
| A hosted front-end platform such as Vercel, Netlify or Cloudflare Pages | Least setup, preview deploys per PR. | One more vendor. Little to gain for a static bundle once the CDN exists. |
| Rewrite the app in Next.js | The most recognisable React framework name. | The app is a signed-in single-page app with no SEO need. A rewrite buys nothing the product needs. |

Recommendation: static bundle in S3 behind CloudFront on `app.<domain>`, API on `api.<domain>` straight to the load balancer. The streaming turn route does not pass through the CDN, so no CDN timeout applies to it.

Change it if a public marketing site with search traffic is wanted. That site can be separate static pages. It is still not a reason to move the review app.

### How the extension authenticates

| Option | For | Against |
| --- | --- | --- |
| Paste a token into the options page, as today | Already built. | Poor first-run experience for anyone who is not Derek. |
| `chrome.identity.launchWebAuthFlow` with OAuth and PKCE against the auth provider | Standard OAuth in an extension. | The MV3 service worker must refresh short-lived tokens while it sleeps and wakes. Ties the extension to one provider's OAuth details. |
| The auth provider's own extension SDK | Least code if it works. | Ties the extension build to that vendor. Not evaluated here, so its behaviour in an MV3 worker is unverified. |
| Device token handoff through the web app | Provider-independent. The extension keeps sending `Authorization: Bearer <token>` exactly as today. Tokens are per device, scoped and revocable. | Two small new routes and a settings list of connected devices. |

Recommendation: the device token handoff.

1. The popup opens `https://app.<domain>/connect-extension`.
2. The learner signs in to the web app if needed and confirms "Connect this browser".
3. The page sends a one-time code to the extension with `chrome.runtime.sendMessage(<extension id>, ...)`. The manifest lists `https://app.<domain>/*` under `externally_connectable`.
4. The worker exchanges the code at the API for an opaque token. The API stores only its hash, with the user, a device label, a scope limited to ingest, capture state and invite routes, and a last-used time.
5. The worker stores the token where it stores the pairing token today, readable by trusted contexts only.
6. The settings page lists devices and revokes any of them. A revoked token gets 401, and the outbox already treats 401 and 403 as "stop and tell the learner".

The server keeps checking `Origin: chrome-extension://<pinned id>` for extension tokens. A published Chrome Web Store item has a fixed id. The backend URL becomes a build-time setting so a local backend still works.

Change it if the auth provider's extension SDK proves to work in the MV3 worker and saves real code.

## 2. Server

### Runtime: keep Bun or move to Node

| | Bun 1.4.3, as today | Node LTS |
| --- | --- | --- |
| Rewrite cost | None. | `Bun.serve`, `Bun.build`, `bun test` across the whole suite, `Bun.CryptoHasher` in `stableId`, the build scripts. |
| Postgres, S3, Redis clients | Built in. `typeof Bun.sql`, `Bun.s3` and `Bun.redis` are all defined on the pinned 1.4.3, checked locally 2026-11-13. None was exercised against a real server. | Each is a package to propose and pin. |
| Recognisability | Known to most TypeScript developers. Less common in production than Node. | The default answer. |
| Library risk | Some Node libraries assume Node internals. The queue library and any tracing agent need a compatibility spike. | Lowest. |
| Hosting | Runs in a container from the official image on any platform below. | Same. |

Recommendation: keep Bun. The code is TypeScript against web-standard `Request` and `Response`, so a later move to Node is bounded: the server shell, the test runner and the build scripts. Moving now would spend weeks to change a resume keyword.

Change it if the compatibility spike in the plan finds that the chosen queue library or the Postgres driver misbehaves on Bun, or if a required platform feature needs Node.

### Framework

| Option | For | Against |
| --- | --- | --- |
| Keep the hand-written shell over `Bun.serve` and `ROUTES` | 614 lines, thin, fully tested. `authorize` is a pure function that is the natural place for the new identity check. No new dependency. | Middleware such as request ids and rate limits is hand-written. Not a framework name. |
| Hono | Small, typed, runs on Bun, Node and edge runtimes, has auth, CORS and streaming helpers. | A new dependency, and the route table would be expressed twice unless `ROUTES` is adapted to it. |
| Fastify or Express | The most recognised Node names. | Node-first. Their request model differs from the `Request` and `Response` the code uses. |
| NestJS | Recognised in larger teams. | A second architecture on top of one that already has module boundaries and a boundary test. |

Recommendation: keep the current shell. Generate an OpenAPI document from `ROUTES` with zod 4's built-in JSON Schema output, so the API is described in the format professionals expect without a new package.

Change it if hand-written middleware grows past a few functions. Hono is then the smallest move.

### API style

| Option | For | Against |
| --- | --- | --- |
| REST with the existing zod wire schemas | Built. Three clients already share one typed contract, and `test/wire.test.ts` fails when a client calls a missing route. Idempotency by client-chosen id is already designed in. Works with any load balancer, CDN and tool. | No query flexibility, which nothing needs. |
| tRPC | End-to-end types with less boilerplate. | The types are already end to end. It would replace working code, and it fits an MV3 worker and an NDJSON stream less directly. |
| GraphQL | Flexible reads for many client shapes. | There is one web app and one extension, both written here. Adds a resolver layer, a schema and caching questions for no client need. |

Recommendation: keep REST with `ROUTES`.

Change it if third parties or a mobile client need the API. Publishing the OpenAPI document is the first step. GraphQL is not.

### Streaming tutor turns across many servers

Today the turn route streams NDJSON from the process that runs the model call, and `guard.inFlight` enforces one running turn per review inside that process.

| Option | For | Against |
| --- | --- | --- |
| Sticky sessions at the load balancer | No code. | A resend after a dropped connection or a deploy can land elsewhere. It does not give single-flight. |
| The receiving server runs the call. A lease row in Postgres replaces the map. A resend on another server waits and replays. | No new infrastructure. The stored turn is already the source of truth, and replay of a finished `turnId` already works. | A resend that lands on another server while the turn still runs gets the text when the turn finishes, not delta by delta. |
| Workers run the call and publish deltas to Redis. Any API server subscribes and relays. | A resend resumes mid-stream from any server. The turn survives an API restart. | Needs Redis and a more complex turn path, for a case that happens only on a reconnect during a running turn. |
| WebSockets or server-sent events | Familiar names. | The NDJSON stream over one POST already does the job and already has tests. Server-sent events cannot carry a POST body without a second request. |

Recommendation: the lease row.

- `review_turn_leases` holds one row per review with the `turnId`, the owning instance and an expiry that the owner renews while it streams.
- A post with the same `turnId` on the owner joins as today. On another server, it polls the stored turn until the turn finishes or the lease expires, then replays.
- A post with a different `turnId` while the lease is live answers 409, as today.
- If the owner dies, the lease expires and the resend runs the turn again. The memo key is the same input, so a finished call is reused and an unfinished one is paid again and recorded again.
- The stream sends a heartbeat line every 15 seconds, so a quiet model does not trip an idle timeout between the browser and the server.

Change it if reconnects during a running turn become common in real use. Redis Streams is then the upgrade, and section 7 lists it as one of the triggers for Redis.

## 3. Compute and hosting

### Options

| Option | Recognisability | What the platform gives | Operational load for one developer | Lock-in |
| --- | --- | --- | --- | --- |
| AWS ECS on Fargate, behind an Application Load Balancer | Highest. The names appear in most job descriptions. | Containers without servers to patch, a real load balancer, autoscaling, private networking, IAM. | Highest of the managed options. A VPC, subnets, security groups, a load balancer, task definitions, IAM roles, a registry, logs and DNS must each exist. Written once as Terraform. | Low for the app, which is a container. Medium for the wiring. |
| AWS App Runner | Medium. | Container in, HTTPS URL out, autoscaling. | Low. | Medium. It has no separate worker type, and background work outside a request is throttled. |
| AWS Lambda | High. | Scale to zero, per-request billing. | Medium. | High for this code. A streaming turn of up to 5 minutes and a long-running worker loop do not fit the function model without a redesign. |
| Google Cloud Run | High. Second only to AWS names. | Container in, HTTPS and load balancing included, scale to zero, streaming responses. | Low. | Low for the app. |
| Fly.io | Medium. Known to developers, rarely named in job descriptions. | Containers as small VMs, built-in proxy and TLS, volumes. | Low. | Low. |
| Render or Railway | Medium to low. | Git push deploys, managed Postgres and Redis beside the service. | Lowest. | Low. |
| Kubernetes, on EKS or GKE | High as a keyword. | Everything, including what is not needed. | Highest. A control plane to pay for and upgrade, plus manifests, ingress and node management. | Low in theory. |

### Prices read on 2026-11-13

| Item | Price | Source |
| --- | --- | --- |
| Fargate Linux ARM, US East (N. Virginia) | $0.0000089944 per vCPU-second and $0.0000009889 per GB-second | Fetched from aws.amazon.com/fargate/pricing. The numbers come from the page's worked examples because its rate table did not render. |
| Fargate Linux x86, same region | $0.000011244 per vCPU-second and $0.000001235 per GB-second | Same page, same caveat. |
| Fargate Spot | "up to 70%" discount, no rate | Same page. The Spot table did not render. |
| Application Load Balancer, US East | $0.0225 per hour and $0.008 per LCU-hour | Fetched from aws.amazon.com/elasticloadbalancing/pricing. From the page's worked examples. The rate table did not render. |
| App Runner, US East | $0.007 per GB-hour provisioned, plus $0.064 per vCPU-hour while active | Fetched from aws.amazon.com/apprunner/pricing. |
| Cloud Run | Unverified | cloud.google.com/run/pricing returned no table text to the fetch. |
| Fly.io Machines, `iad` | shared-cpu-1x: $2.19 a month at 256 MB, $3.69 at 512 MB, $6.70 at 1 GB. performance-1x with 2 GB: $33.00 a month. | Fetched from docs.fly.io/about/pricing. |
| Railway | Hobby $5 a month and Pro $20 a month per workspace, each with the same amount of included usage. About $20 per vCPU-month and $10 per GB-month of memory. | Fetched from railway.com/pricing. |
| Render | Unverified | render.com/pricing returned no prices to the fetch. |
| EKS control plane, NAT gateway, Lambda | Unverified | Not fetched. |

My arithmetic from the fetched Fargate rates: one ARM task with 0.25 vCPU and 0.5 GB costs about $7.21 a month, and one with 0.5 vCPU and 1 GB about $14.42. The load balancer costs about $16.43 a month before LCU charges.

### Estimated compute cost by size

These are assumptions, not measurements. They cover compute and the load balancer only. The database is in section 4, and model spend is in section 10.

| Registered users | Assumed shape on Fargate | Fargate plus ALB, per month |
| --- | --- | --- |
| 10 | 1 API task and 1 worker task, each 0.25 vCPU and 0.5 GB | about $31 |
| 100 | 2 API tasks and 1 worker task, each 0.5 vCPU and 1 GB | about $60 |
| 1,000 | 4 API tasks and 4 worker tasks, each 0.5 vCPU and 1 GB | about $132, plus LCU charges that depend on traffic |

On Fly.io the same task counts on shared-cpu-1x machines would cost about $7, about $20 and about $54 at the fetched machine prices, with no separate load balancer charge. A shared-cpu-1x machine is not the same size as a Fargate task, so this compares price floors, not equal capacity. Cloud Run and Render could not be compared because their rates were not readable today.

One AWS cost to avoid by design: a NAT gateway has an hourly charge (unverified) that can exceed the compute bill at this size. The plan puts tasks in public subnets with security groups that admit only the load balancer, so no NAT gateway is needed.

### Recommendation

AWS ECS on Fargate, one container image run as two services, `api` and `worker`, behind an Application Load Balancer, in one region.

Why:

- It is the stack a technical reader recognises without explanation, which is the stated purpose.
- The product needs exactly what it provides and little more: a load balancer that holds a streaming response, a long-running worker, private access to Postgres and object storage.
- The app stays a plain container. Leaving AWS later means rewriting Terraform, not code.
- The cost difference against the cheaper platforms is tens of dollars a month at these sizes. Section 10 shows that one Opus review costs about a dollar, so hosting is the smaller bill once people use it.

The honest cost of this choice is setup and upkeep. Cloud Run would give the same container, HTTPS, load balancing and scale to zero for a fraction of the configuration, and it is the runner-up.

Rejected for now:

- Lambda, because the 5-minute streaming turn and the worker loop do not fit it without a redesign.
- App Runner, because it has no worker type.
- Kubernetes, because nothing here needs it and one developer would spend more time on the cluster than on the product.

Change it if the AWS setup has not produced a working deploy within the time Derek budgets for it, or if the fixed monthly floor matters more than the names. Move to Cloud Run then. The container, the database choice and every line of application code carry over.

## 4. Database

### Derek's concern about Supabase

Part of the concern is wrong and part is right.

- The database Supabase runs is standard PostgreSQL. A Supabase project can be reached with any Postgres driver and dumped with `pg_dump` and restored anywhere. In that sense it is as standard as a database gets.
- What is not standard is the Supabase way of building an app: the browser talks to the database through an auto-generated REST layer, access control lives in row-level security policies, and Supabase Auth, Storage and Edge Functions replace a backend. That is a backend-as-a-service architecture.
- After Class has a real backend that enforces Derek's rules in code. It would use none of that. Supabase would be a Postgres host and nothing more, and other hosts do that job with less to explain.
- On a resume, "Supabase" can read as "no backend was written", which is the opposite of what this project shows. "PostgreSQL on AWS RDS" needs no explanation and invites no such doubt.

So the recommendation is not Supabase, for the resume reason Derek gave and because its extra features would go unused. The reason is not that its database is non-standard.

### Options

| Option | For | Against |
| --- | --- | --- |
| PostgreSQL on AWS RDS | The most recognised managed database. In the same VPC as the servers. Automated backups and point-in-time restore. Multi-AZ when wanted. | A fixed monthly cost with no scale to zero. One more thing in Terraform. |
| PostgreSQL on Google Cloud SQL | The same, on Google Cloud. | Only sensible with Cloud Run. |
| PostgreSQL on Neon | Standard Postgres, scale to zero, a free plan, database branches for previews. | Outside the VPC, so traffic crosses the public internet under TLS. Less known than RDS outside newer teams. |
| Supabase | Standard Postgres plus auth, storage and realtime. | See above. |
| SQLite per user, on Turso or Cloudflare Durable Objects | Keeps the synchronous single-writer model the code was built on. Per-user isolation is physical. Deleting a user is deleting a file. | The shared lecture cache and the cost ledger are cross-user data and need a second store. Durable Objects means the Workers runtime, so no `bun:sqlite` and no long worker loop. Each user's database must be migrated separately. Least recognisable. |

### Prices read on 2026-11-13

| Item | Price | Source |
| --- | --- | --- |
| RDS for PostgreSQL instance hours and storage | Unverified | aws.amazon.com/rds/postgresql/pricing did not render its rate tables. The page text did say T4g CPU credits cost $0.075 per vCPU-hour above baseline, and that new customers get 750 hours a month of selected Single-AZ instances plus 20 GB for one year. Whether that free tier applies to Derek's account is unverified. |
| Cloud SQL | Unverified | cloud.google.com/sql/pricing returned no table text. |
| Neon | Free plan: 100 CU-hours and 1 GB per project, compute stops after 5 minutes idle. Launch: $0.106 per CU-hour and $0.35 per GB-month, no monthly minimum. Scale: $0.222 per CU-hour. | Fetched from neon.com/pricing. |
| Supabase | Free: 500 MB database, paused after 1 week of inactivity. Pro: from $25 a month with 8 GB disk and $10 of compute credit. Compute add-ons from $10 a month for 1 GB of RAM. | Fetched from supabase.com/pricing. |
| Fly.io Managed Postgres | $38 a month for the Basic plan, storage $0.28 per GB-month | Fetched from docs.fly.io/about/pricing. |
| Turso, Durable Objects | Unverified | Not fetched. |

### Recommendation

PostgreSQL on AWS RDS: the smallest Graviton burstable instance, Single-AZ, automated backups on, in private subnets reachable only from the two services.

Why:

- It is the standard answer and the one that reads best on a resume.
- Cross-user data, which is the shared lecture cache, the ledger and the quotas, lives in the same database as per-user data, under one transaction.
- The queue in section 6 can live in it.

The cost of this choice is the largest single piece of work in the migration. `Db.tx` is synchronous today, and derivations call `memo.lookup` synchronously. Every Postgres driver is asynchronous. All 86 SQL call sites change, and each transaction body gains `await` points that did not exist. SQLite per user would avoid that rewrite entirely, which makes this one of the closest decisions in the document. Postgres wins because the product now has cross-user data, and because a per-user-file design is the hardest of all the options to explain to the readers Derek is writing for.

Change it if the fixed RDS cost is unwelcome while there are fewer than about 10 users. Neon's free or Launch plan runs the same schema and the same SQL, so starting on Neon and moving to RDS later is a `pg_dump` and a connection string. Change to Multi-AZ when an hour of downtime would hurt real users.

### Schema and tenancy

| Option | For | Against |
| --- | --- | --- |
| Shared tables with a `user_id` column | Standard. One migration run. Cross-user queries for the ledger are plain SQL. | A missing `WHERE user_id` leaks data, so it needs enforcement. |
| One schema per user | Stronger separation. | Migrations run once per user. Painful at 1,000. |
| One database per user | Strongest separation. | See SQLite per user above. |

Recommendation: shared tables with `user_id`, enforced three ways.

1. A `users` table with an internal id. The auth provider's subject id is a column, not the key, so the provider can change.
2. `user_id` on every per-user table. Primary keys become `(user_id, id)` wherever the id is a `stableId` content hash, because two learners with identical content would otherwise collide. Which ids hash user-specific input needs a per-kind check during the work. This document did not check each kind.
3. The `Db` handle that modules receive is scoped to one user, so module code cannot issue a per-user query without it. `test/boundaries.test.ts` already parses each module's SQL to enforce table ownership. Extend it to fail on SQL that touches a per-user table without `user_id`.

Add Postgres row-level security as a second barrier before the product holds data for people Derek does not know personally. Row-level security is a standard Postgres feature, not a Supabase one.

Three details of today's design need a deliberate Postgres equivalent:

- Writer serialization. Today one process and one synchronous transaction per command mean no two commands interleave. In Postgres, each command transaction first takes `pg_advisory_xact_lock` on the user's id. One user's commands still run one at a time across all servers, and different users run in parallel. This keeps the "state checked then used later" failure class from `docs/trail/handoff-1.md` closed.
- The fact sequence. `seq_counter` becomes one counter row per user, incremented inside the command transaction under that lock. `appliesBefore` then compares sequence numbers that are totally ordered per user, which is what R8 needs. R8: "Results from cancelled or outdated jobs never overwrite current preparation or my notes."
- SQLite specifics. `STRICT` tables become typed columns, JSON text becomes `jsonb`, the append-only and R16 and R17 triggers become PL/pgSQL triggers, and `INSERT OR IGNORE` becomes `ON CONFLICT DO NOTHING`.

### Migrations and query tooling

| Option | For | Against |
| --- | --- | --- |
| Plain SQL migrations with the existing runner, queries as SQL through `Bun.sql` | The runner already hashes each migration and refuses one whose text changed. The boundary test reads SQL text. No new dependency. Raw SQL is the most portable skill of all. | Query results are typed by hand, as today. |
| Drizzle | Popular, typed schema in TypeScript, generated migrations. A recognisable name. | A new dependency. Every query is rewritten into its builder on top of the sync-to-async rewrite. The boundary test would need a new way to see table access. |
| Prisma | The most recognised TypeScript ORM. | A generated client and its own migration engine. Its install and generate steps need checking against the no-install-scripts policy. The largest rewrite. |
| Kysely | A typed query builder that stays close to SQL, no code generation. | A new dependency. A smaller rewrite than an ORM but still a rewrite. |

Recommendation: plain SQL migrations with the existing runner, and SQL through the built-in `Bun.sql` client. The rewrite to asynchronous Postgres is already large. Changing how every query is written in the same step doubles the risk for a keyword.

Change it if hand-typed rows cause real bugs after the move. Kysely is then the smallest step. If Derek wants an ORM name on the resume, Drizzle is the one to propose, as a separate change after the move is stable.

## 5. Object storage and CDN

### Object storage for frames

| Option | For | Against |
| --- | --- | --- |
| Amazon S3 | The standard. Same cloud and IAM as the servers. Encryption at rest by default. | Charges for data sent to the internet. |
| Cloudflare R2 | S3-compatible API, no egress charge. | A second vendor and a second set of credentials. |
| Google Cloud Storage | The standard on Google Cloud. | Only sensible with Cloud Run. |
| Supabase Storage | Bundled with Supabase. | Not used otherwise. |
| A volume on the server | No change to the code. | Not shared between tasks. Fargate has no persistent local volume. |

Prices read on 2026-11-13: R2 storage is $0.015 per GB-month with 10 GB free and no egress charge, fetched from developers.cloudflare.com/r2/pricing. The S3 storage and transfer tables did not render, so S3's per-GB rates are unverified. The S3 page text did state $0.0004 per 1,000 GET requests and 100 GB a month of free transfer out across AWS services.

How many bytes a lecture's frames take is in the capture probe data and was not read for this document, so no storage cost per user is estimated.

Recommendation: one private S3 bucket.

- Keys are `frames/<user_id>/<source_id>/<evidence_id>.jpg`. The bucket blocks all public access.
- Frames keep arriving through `POST /ingest`, so the server still applies the watched-interval checks before anything is stored. R1: "Evidence only comes from intervals I actually watched while capture was on."
- The server writes the object, then the row. An object with no row is an orphan that a sweeper removes after a grace period. This also closes the "frame files are written before the DB transaction" backlog item.
- `GET /frames/:evidenceId` keeps its place in `ROUTES`. After the ownership check it answers with a redirect to a presigned URL that expires in 5 minutes. The image bytes then flow from S3, not through the API.
- Expiry stays in application code. `sweepExpired` decides from the database what to delete, then deletes the object. No S3 lifecycle rule ever expires evidence, because the bucket cannot know what a saved note cites. R16: "Evidence cited by a saved note is only deleted when I delete it, never by expiry."
- Evidence snapshots, which are hard links today, become rows that point at the same immutable object.

Change it if transfer charges become visible on the bill. R2 speaks the same API, so the move is a credential and an endpoint. Change the upload path to presigned direct uploads if ingest bandwidth through the API becomes the bottleneck.

### CDN

Recommendation: CloudFront in front of the static app bundle only. Frames are private, per user and fetched a few times, so a CDN adds signed-URL complexity for no measurable gain. The API is not behind the CDN.

Change it if lecture frames become shared across users, see section 10, or if users far from the region report slow API calls.

## 6. Background jobs

### What today's scheduler is

The scheduler is not a job queue. It has no job table by design. Each pump collects demand from every capture, dispatches items whose memo key is not running, aborts running items that are no longer demanded, and pumps again on each completion. The memo owns retries, failures and usage. A crash loses nothing because the next pump recomputes demand.

The move to several processes needs three things, and only three:

1. A durable signal that a capture has new facts, delivered to exactly one worker at a time.
2. Single-flight on a memo key across processes.
3. Provider concurrency limits that hold across processes.

### Options

| Option | For | Against |
| --- | --- | --- |
| A Postgres-backed queue, pg-boss or graphile-worker | No new infrastructure. A job can be enqueued in the same transaction as the fact that causes it. Deduplication by key, priorities, scheduled jobs. Local development and CI need only Postgres. | Queue traffic shares the database. Each is a new dependency that needs a Bun compatibility spike. Autoscaling on queue depth needs a custom metric. |
| BullMQ with Redis | Widely known in the Node world. Rate limiting and priorities built in. | Needs Redis from day one. Enqueue is not transactional with the database. Bun compatibility unverified. |
| Amazon SQS | The most recognised queue name. Managed, cheap, native autoscaling signal. | No priorities without several queues. Not transactional with the database. Local development needs an emulator. |
| Google Cloud Tasks | Managed, HTTP push. | Google Cloud only. |
| A hand-written claim table with `FOR UPDATE SKIP LOCKED` | No dependency. A well-known Postgres pattern. Matches the "no job table" design most closely. | Retries, backoff, stuck-job recovery and monitoring are all hand-written. |

SQS and Redis prices were not fetched and are unverified. At these sizes the queue's own cost is not what decides this.

### Recommendation

pg-boss on the same Postgres, used as a signal and not as the system of record.

- The job is "pump capture C", deduplicated per capture. It is not one job per model call. The handler runs the existing demand and dispatch loop for that capture, so priorities, the resource-search slot rule and abort-when-no-longer-demanded stay as written. R5: "Choosing Later never cancels preparation." R6: "A pending resource search never blocks a review that is otherwise ready."
- Ingest and the other fact-writing commands enqueue the job in the same transaction as the fact. A completed model call enqueues the next pump.
- A lost or duplicated job is harmless, because demand is derived from facts. A scheduled reconcile job re-pumps any capture with unmet demand.
- The memo's `inflight` map becomes a `memo_leases` table: a row per running key with an owner and an expiry that the owner renews. `Lookup.kind = "inflight"` reads it. A worker that dies lets its lease expire.
- `sweepExpired` becomes a scheduled job, once a day as today.
- Per-provider limits become the worker count times a per-worker limit while there are one or two workers. Section 7 says when that stops being enough.

pg-boss is named here as the candidate. Its exact version, its behaviour on Bun and its install footprint under the repo's dependency policy are unverified and belong to the spike in the plan. If the spike fails or Derek declines the dependency, the hand-written claim table is the fallback, because the needs above are narrow.

Change it if queue traffic shows up in database load, or if workers must autoscale on queue depth. SQS is then the move. Because jobs are idempotent signals, the change is confined to the enqueue call and the worker's receive loop.

## 7. Caching and rate limiting

What needs shared, fast, short-lived state:

| Need | Without Redis | With Redis |
| --- | --- | --- |
| Request rate limit per user and per device token | A counter table in Postgres with a fixed window, or a rule at the load balancer's firewall | A token bucket per key |
| Provider concurrency and rate limits across workers | A static share per worker | One shared token bucket, with priority for tutor turns |
| Single-flight leases for memo keys and turns | Rows in Postgres | Keys with a time to live |
| Stream resume across servers | Wait and replay | Redis Streams |
| Caching reads | Not needed. The memo is the cache, and it is durable in Postgres. | Not needed |

Recommendation: no Redis at launch. Postgres carries every item above at 10 and at 100 users, and one fewer service is one fewer thing to secure, pay for and explain.

Add Redis when any one of these is true:

- There are more than about three workers or API tasks, so static shares of a provider's rate limit waste capacity or overshoot it.
- Reconnects during a running turn are common enough that wait-and-replay is felt.
- Rate-limit counters or leases appear in the database's slowest or most frequent queries.

When that day comes, Amazon ElastiCache (price unverified) keeps it inside the VPC. Upstash is the pay-per-use alternative: free up to 500,000 commands a month, then $0.20 per 100,000 commands, fetched from upstash.com/pricing/redis on 2026-11-13. `Bun.redis` is built in, so the client is not a new dependency.

## 8. Load balancing and scaling

What the Application Load Balancer gives: TLS termination with a managed certificate, health checks against `GET /health`, spreading requests across API tasks in two availability zones, and connection draining on deploy.

What the application must do so the load balancer can do its job:

- Stateless API tasks. After sections 2, 4 and 6, the three in-process maps are gone: `guard.inFlight`, the memo's `inflight` and the scheduler's `running`. No request needs to return to the server that handled the previous one, so sticky sessions stay off.
- Long-lived streaming responses. The load balancer's idle timeout must exceed the longest silence in a turn. The default is 60 seconds and it is configurable, as I remember the AWS documentation, which was not re-read today. Time to first text reached 12 seconds in experiment 8's one review. The heartbeat line every 15 seconds keeps the connection active whatever the model does. The 5-minute turn deadline in `http.ts` stays.
- Deploys during a turn. A rolling deploy starts new tasks, stops routing new requests to old ones, and gives old tasks a grace period before stopping them. Fargate caps that grace period at 120 seconds, as I remember it, unverified. A turn that outlives it is cut. The client's resend with the same `turnId` then replays or reruns it, which is the reason the lease design matters.
- Idempotent writes from clients. Ingest is idempotent on `(captureId, clientSeq)`. Turns are idempotent on `turnId`. Saves use stable ids, so a retry through a different server writes the same rows. R15: "Retrying a save never creates a duplicate record." In Postgres each of these is a primary key plus `ON CONFLICT`, checked inside the user's command lock.
- Health that means something. `GET /health` should fail when the task cannot reach Postgres, so the load balancer stops sending it traffic.

Autoscaling:

- API tasks scale on CPU or on requests per target. Streaming turns hold connections but little CPU, so a floor of two tasks matters more than the scaling rule at these sizes.
- Worker tasks do not need to scale on load until the providers' rate limits allow more parallel calls than one worker makes. Model calls are the bottleneck, not CPU. Adding workers without raising provider limits only produces 429 responses.
- At 10 users, one API task and one worker is honest. Two API tasks are worth their roughly $7 a month once a deploy or a crash must not interrupt a stranger's review.

Database connections:

- Each task holds a small pool, about 5 connections. Ten tasks then use 50. The smallest RDS instances allow on the order of 100 connections, a figure derived from instance memory that is unverified here.
- Add a pooler, RDS Proxy or PgBouncer, when task count times pool size nears the limit. The queue's listeners and the advisory locks need session-level connections or transaction-scoped locks, which is why the design above uses `pg_advisory_xact_lock` and not session locks.
- A read replica is not needed at 1,000 users for this workload. The heavy reads are per user and indexed by `user_id`.

## 9. Auth

| Option | For | Against |
| --- | --- | --- |
| Clerk | Hosted sign-in, sessions, account pages and Google sign-in with the least code. The backend only verifies a signed token against published keys. Well known in React teams. | The user list lives with a vendor. A front-end package to propose. |
| Auth0 | The most recognised name in identity. Enterprise single sign-on when wanted. | More configuration, and pricing rises sooner. Price unverified. |
| Amazon Cognito | All on AWS, recognised, cheap at small sizes. Price unverified. | The weakest developer experience of the list. Hosted pages are hard to make pleasant. |
| Better Auth | An open-source TypeScript library. Users live in your own Postgres. No vendor. | Newer. You operate sign-in yourself, including email delivery and account recovery. A security-sensitive dependency to keep patched. |
| Auth.js | Long-standing open-source option. | Built around Next.js. Awkward for a separate API and a static app. |
| Firebase Auth | Solid Google sign-in, generous free use. Price unverified. | Pulls in the Firebase SDK and console for one feature. |
| Supabase Auth | Bundled with Supabase. | Not used otherwise. |

Price read on 2026-11-13: Clerk's free plan includes 50,000 monthly retained users per app, and the Pro plan is $25 a month, fetched from clerk.com/pricing.

Recommendation: Clerk, with Google as the only sign-in method at launch.

Why:

- Every learner already has a Google account, because the product starts from YouTube in Chrome. No passwords are stored anywhere in the system.
- One developer should not operate account recovery and session security for other people's learning data.
- The lock-in is contained. The backend's contract is "verify a signed token and map its subject to a `users` row". The extension never talks to the provider. Changing provider later touches the web app's sign-in screen and one verification function.

Runner-ups: Cognito if "everything on AWS" matters more than the developer experience, and Better Auth if Derek prefers that no vendor holds the user list.

Change it if schools or teams need single sign-on, which points to Auth0, or if the vendor's price or terms change.

The extension sign-in flow is in section 1. In short: the web app signs in with Clerk, and the extension receives its own revocable device token from the After Class API.

## 10. Model gateway

Every provider call already passes through `memo.run`. That function is the gateway. No external gateway product is needed, and adding one would create a second ledger beside the one R17 already governs.

### What one review costs

One data point exists. Experiment 8, a live replay of one review on 2026-11-12, made 11 Messages API calls, 10 tutor turns and one wrap-up. Its estimated cost at list prices was $0.9993 on `claude-opus-5-5` and $0.4707 on `claude-sonnet-5-5`. That figure is an estimate from response usage and not a bill, it covers one review of one lecture, and it excludes preparation, Jev and voice. Source: `docs/experiments/08-api-tutor.md`.

It is enough to say that model spend per active user will be measured in dollars, and that open sign-up without caps would let anyone spend Derek's money. Nothing more should be read into one sample.

### Per-user quotas and spend caps

- Add `user_id` and `capture_id` to `usage_events`. The append-only and never-deleted triggers stay. R17: "Every paid call records a usage event; unknown cost is stored as unknown, not zero."
- Before each attempt, the gateway reserves a worst-case cost against the user's remaining budget for the period, and settles to the recorded cost after the call. The experiment 8 runner already implements this reserve-then-settle pattern for its cap, including the rule that an unknown cost keeps its reservation.
- A call with unknown cost counts against the cap at its reserved amount. Treating unknown as zero would break the cap in the same way R17 forbids for the ledger.
- A cap never cuts a turn in the middle. When the budget is spent, new preparation stops and a new review does not start, and the app says why.
- One global switch stops all paid calls, and one global monthly budget sits above the per-user caps. The Anthropic Console's own workspace spend limit is the last backstop. Whether Derek's account has that setting is unverified.
- Sign-up is by invitation until Derek decides who pays, which is on the list only he can decide.

### Organisation rate limits shared across servers

- Anthropic and TypeSafe each limit the whole organisation, not each server. Today's limiter is per process.
- Interactive calls, the tutor turn and the wrap-up, take priority over preparation. A reserved share of the Claude limit is held for them so a burst of preparation never delays a learner who is mid-review.
- A 429 or an overloaded response already surfaces as a retryable `ProviderError`. The gateway honours the provider's retry-after value instead of retrying at once.
- With one or two workers, each gets a static share. With more, the shared token bucket in Redis from section 7 replaces the shares.
- TypeSafe's rate limits, pricing and terms for serving other users are unknown. Jev cost is recorded as unknown today.

### A shared content-addressed cache

The memo key is already a hash of the exact input, so two learners whose inputs are byte-identical already compute the same key. Making that useful across users takes three decisions.

1. Scope by purpose. Results whose input is lecture content only may be shared: `boundary`, `frame_change`, `claim_check`, `interpretation`, `claim_revision`, `resource_search` and `diagram_summary`. Results whose input contains a learner's words are never shared: `tutor_turn` and `wrap_up`. The shared `memo` table has no `user_id`. A per-user table records which keys each user's pipeline has used and at what sequence number, so `appliesBefore` still works per user. Each task's canonical input must be audited to confirm no learner text enters a shared purpose.
2. Charge the user who caused the call. The ledger records the paying call once, against the user whose demand triggered it. A cache hit records no usage event, as today.
3. Be honest about the hit rate. Exact-input sharing only hits when two learners' windows contain the same captions cut at the same points, and for frame tasks the same JPEG bytes. Windows are built from what each learner watched, about 45 seconds at a time, so different seek patterns give different keys, and two captures of the same frame are unlikely to be byte-identical. The hit rate is unmeasured and may be low.

Preparing a public lecture once for everyone therefore needs more than a shared table. It needs a canonical preparation per source, keyed by the video and its caption track and cut on fixed windows, with each learner's evidence then limited to the intersection with what that learner watched. That keeps R1 intact, but it changes flow section B, where windows are built from newly watched captions. It is a flow change that needs Derek's approval and the TLA+ model rerun. It is also a product change: the PRD lists "Cross-user source-cache sharing is not required" and places "shared learning from other users' confusion" outside the MVP.

Recommendation: ship item 1 and item 2 with the Postgres move, measure the hit rate with real users, and bring the canonical preparation to Derek as a flow amendment only if the measured spend on repeated lectures justifies it.

Two smaller notes. The `claude-api.ts` adapter already uses Anthropic's prompt cache with a 1-hour lifetime on the system block. That cache lives at the provider and works across servers with no change. Experiment 8 left open whether the 5-minute lifetime would be cheaper. And the API key for the hosted product must be an organisation key held in the secrets store, never Derek's subscription login.

## 11. Observability, delivery and secrets

### Observability

| Option | For | Against |
| --- | --- | --- |
| Structured JSON logs to stdout, collected by CloudWatch Logs, with CloudWatch metrics and alarms | Included with the platform. No dependency. | Searching logs is basic. |
| Sentry for errors in the API, the web app and the extension | Stack traces with release and user context. Recognised. A free tier exists, price unverified. | A new dependency in three places, and a vendor that receives error context. |
| OpenTelemetry traces to a hosted backend | The standard for tracing. | Bun support for the Node auto-instrumentation is unverified. More setup than the product needs at 100 users. |
| Datadog or New Relic | Everything in one place. | Cost and setup out of proportion here. Prices unverified. |

Recommendation: structured logs first, with a request id, the internal user id, the capture or review id, the route, the status and the duration on every line. Alarms on 5xx rate, on turn failures and on the health check. The usage ledger is already the cost dashboard. Propose Sentry as the first addition once strangers use the product.

Logs never contain learner answers, transcript text, tokens or keys. `claude-api.ts` already redacts and clips provider errors, and the same discipline applies to request logging.

### CI/CD and environments

- CI stays GitHub Actions. `ci.yml` already pins actions by commit and runs typecheck, tests, lint, both builds and the browser tests. It gains a Postgres service container so the storage tests run against the real engine.
- Delivery adds one workflow: build the image, push it to the registry, run migrations as a one-off task, then update the two services. GitHub authenticates to AWS with OpenID Connect and a role limited to that work, so no long-lived AWS key is stored in GitHub.
- Migrations run before the new code and must be compatible with the old code still running, because a rolling deploy runs both for a minute.
- Environments: local and production at launch. Local uses Postgres in a container and a filesystem implementation of the frame store. Replay mode already gives a no-key environment for end-to-end tests. Add a staging environment before the product has users whose reviews must not break, because a second environment roughly doubles the fixed cost.
- `docs/trail/handoff-1.md` records "No deploy or publish without explicit authorization". Production deploys run on Derek's approval through a protected GitHub environment.

### Infrastructure as code

| Option | For | Against |
| --- | --- | --- |
| Terraform, or its open fork OpenTofu | The most recognised tool. Works on any cloud. A plan shows the change before it happens. | Its own language and a state file to store safely. |
| AWS CDK | Written in TypeScript like the rest of the repo. | AWS only. Generates CloudFormation, which is slow to fail and to roll back. |
| Pulumi | TypeScript, any cloud. | Less common. A hosted state service by default. |
| None, click through the console | Fastest on day one. | Nothing is reproducible or reviewable, and there is nothing to show. |

Recommendation: Terraform, with state in an S3 bucket. The infrastructure then lives in the repo, changes arrive as PRs, and a move to another cloud starts from a readable description of what exists.

Change it only if Derek would rather stay in TypeScript and accepts AWS-only tooling. CDK is then the choice.

### Secrets

- Provider keys and the database password live in AWS Secrets Manager or SSM Parameter Store, and reach the tasks as environment variables through the task definition. Prices unverified.
- No secret is in the image, the repo, Terraform state in plain text, or a GitHub secret that a pull request from a fork can read. The repo is public.
- Only the worker and the API task roles can read provider keys. The key never reaches a browser or the extension, as today.
- `~/.config/afterclass/keys.env` stays as the local development path.
- Each key gets a documented rotation step. Experiment 8 already showed a key being replaced mid-trial.

## 12. Security and privacy basics

The product will hold what people watched, what they said about it and how well they explained it. That is personal data about learning, and it deserves care before the first stranger signs up.

- Ownership checks on every route. Every route takes a `captureId`, `reviewId`, `evidenceId` or similar. Moving from one user to many makes "user A reads user B's review by guessing an id" the main new risk. Each route resolves the resource through the user-scoped `Db` handle, and a test per route proves a second user gets 404.
- Transport and storage. HTTPS only, with HSTS. RDS and S3 encrypt at rest. Frames are never public. Presigned URLs expire in minutes.
- Tokens. Extension device tokens are stored hashed, scoped and revocable. Web sessions are short-lived signed tokens from the auth provider.
- Cost abuse. Invitation-only sign-up, per-user caps and the global switch from section 10. Request size limits already exist in `http.ts`.
- Untrusted content. Captions and web pages are input to models and can contain instructions. The existing rule in `claude-api.ts`, "Nothing the network sends is trusted", stays, and model output is validated against a schema before use, as today.
- Deletion and export. A learner can delete evidence today. A hosted product also needs "delete my account and everything in it" and "export my record". R16 governs evidence expiry and is unchanged. Whether account deletion needs its own rule is Derek's to write.
- Backups. Automated daily backups with point-in-time restore, and one practised restore before launch. A backup that has never been restored is unproven.
- Third parties that receive learner data: Anthropic receives evidence and answers, TypeSafe receives captions and frames, ElevenLabs receives tutor sentences, and Chrome's Web Speech API sends the learner's speech to the browser vendor's service. A privacy notice must say so in plain words.
- Chrome Web Store. Publishing requires a privacy policy and a declaration of what data the extension collects and why. The exact current requirements were not re-read and are unverified.
- Not legal advice, and for Derek to decide with someone qualified: storing captions and frames of third-party lectures on a server, and sharing preparation derived from them across users, raises copyright and platform-terms questions. The flow already notes that the Georgia Tech lecture is "Live only; not redistributable as a sample". Learners may be under 18, which brings child-privacy law into scope. Users in the EU or UK bring GDPR.

## Recommended stack

| Area | Recommendation | Runner-up | Change when |
| --- | --- | --- | --- |
| Extension | Chrome MV3, capture only, existing outbox | none | never asked for |
| Web app | Existing React single-page app, static bundle in S3 behind CloudFront on `app.<domain>` | served by the API as today | a public marketing site is wanted |
| Extension sign-in | Device token handoff through the web app | provider's extension SDK | the SDK proves itself in an MV3 worker |
| Runtime | Bun, in a container | Node LTS | a required library fails on Bun |
| Framework | Existing `Bun.serve` shell and `ROUTES` | Hono | middleware outgrows a few functions |
| API style | REST with the zod wire schemas, NDJSON streaming, OpenAPI generated from `ROUTES` | tRPC | third-party clients appear |
| Streaming across servers | Lease row in Postgres, wait and replay, heartbeat lines | Redis Streams | reconnects mid-turn are common |
| Compute | AWS ECS on Fargate, `api` and `worker` services from one image | Google Cloud Run | setup time or fixed cost is the constraint |
| Load balancing | Application Load Balancer, no sticky sessions | platform proxy on Cloud Run | with the compute choice |
| Database | PostgreSQL on AWS RDS | PostgreSQL on Neon | fixed cost matters below 10 users |
| Tenancy | Shared tables, `user_id`, user-scoped `Db` handle, row-level security before strangers | schema per user | never at this size |
| Migrations and queries | Plain SQL, existing hashed runner, built-in `Bun.sql` | Kysely, then Drizzle | hand-typed rows cause bugs |
| Object storage | Private S3 bucket, presigned URLs | Cloudflare R2 | transfer charges show on the bill |
| CDN | CloudFront for the app bundle only | none | frames become shared |
| Background jobs | pg-boss on the same Postgres, one deduplicated "pump capture" job | hand-written claim table, then SQS | queue load shows in the database |
| Cache and rate limits | Postgres only | Redis on ElastiCache or Upstash | more than about three tasks per tier |
| Auth | Clerk with Google sign-in | Cognito or Better Auth | single sign-on is needed |
| Model gateway | `memo.run` with user attribution, reserve-then-settle caps, shared cache for lecture-only purposes | external gateway product | never, while R17 lives in the memo |
| Observability | Structured logs and alarms in CloudWatch, then Sentry | OpenTelemetry | strangers use the product |
| CI/CD | GitHub Actions with OIDC to AWS | none | not expected |
| Infrastructure as code | Terraform | AWS CDK | Derek prefers TypeScript and AWS-only |
| Secrets | AWS Secrets Manager or Parameter Store | none | not expected |

## Diagram

```text
 Learner's Chrome
 +---------------------------+        +---------------------------+
 | Extension (MV3)           |        | Web app (React SPA)       |
 |  capture, outbox, invite  |        |  review, record, account  |
 |  device token             |        |  Clerk session token      |
 +-------------+-------------+        +------+-------------+------+
               |                             |             |
               | HTTPS, Bearer               | static      | HTTPS, Bearer
               | POST /ingest ...            | files       | REST + NDJSON turn stream
               |                             v             |
               |                   +------------------+    |
               |                   | CloudFront + S3  |    |
               |                   | app.<domain>     |    |
               |                   +------------------+    |
               v                                           v
        +-------------------------------------------------------+
        | Application Load Balancer   api.<domain>   TLS        |
        | health checks, no sticky sessions, heartbeat-safe     |
        +---------------------------+---------------------------+
                                    |
                 +------------------+------------------+
                 v                                     v
        +-----------------+                   +-----------------+
        | api task (Bun)  |   ...  N tasks    | api task (Bun)  |
        | ROUTES, authz,  |                   | stateless       |
        | tutor turn call |                   |                 |
        +---+--------+----+                   +--------+--------+
            |        |                                 |
            |        +-----------------+---------------+
            |                          v
            |          +-------------------------------------+
            |          | PostgreSQL (RDS)                    |
            |          |  per-user facts, record, sequences  |
            |          |  shared memo, usage ledger, quotas  |
            |          |  turn leases, memo leases           |
            |          |  pg-boss queue: "pump capture C"    |
            |          +----------+--------------------------+
            |                     ^
            |                     | claim job, read demand, write results
            |          +----------+----------+
            |          | worker task (Bun)   |  ...  M tasks
            |          | demand -> dispatch  |
            |          | memo.run = gateway  |
            |          +----+-----------+----+
            |               |           |
            v               v           v
     +-------------+   +---------+  +--------------------------+
     | S3 frames   |   | S3      |  | Providers                |
     | presigned   |   | frames  |  |  Anthropic Messages API  |
     | GET (302)   |   | read    |  |  TypeSafe Jev            |
     +-------------+   +---------+  |  ElevenLabs (via api)    |
                                    +--------------------------+

 Outside the request path: Clerk (sign-in, token keys), GitHub Actions (build,
 migrate, deploy by OIDC), Terraform (all of the above), CloudWatch (logs, alarms),
 Secrets Manager (provider keys, database password).
 Added later, when section 7's triggers fire: Redis.
```

## What was not verified

- Prices marked unverified above: Cloud Run, Cloud SQL, RDS instance and storage rates, S3 storage and transfer rates, Render, SQS, ElastiCache, NAT gateway, Secrets Manager, CloudWatch, Route 53, Auth0, Cognito, Firebase Auth, Sentry, Turso, Durable Objects, the domain and the Chrome Web Store fee.
- The Fargate and load balancer rates came from worked examples on the AWS pages, not from the rate tables.
- The load balancer's default idle timeout and Fargate's 120-second stop limit are from memory.
- `Bun.sql`, `Bun.s3` and `Bun.redis` exist on Bun 1.4.3 but were not run against a server. pg-boss on Bun was not tried.
- Which `stableId` kinds would collide across users was not checked per kind.
- No load test exists. Every task count and connection count above is an assumption.
- The shared cache's hit rate is unmeasured.
- TypeSafe's and ElevenLabs's terms, limits and prices for serving other users are unknown.
- The model cost figure is one review from experiment 8, estimated from usage and not billed.
