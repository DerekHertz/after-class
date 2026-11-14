/**
 * Composition root (M6). The only file that knows every module.
 *
 *   keys     ~/.config/afterclass/keys.env, mode 0600 or the backend refuses to start. Only this file reads it; the
 *            value of TYPESAFE_API_KEY goes to the Jev client and nowhere else (not a log line, not a response, not a child env).
 *            ELEVENLABS_API_KEY (optional) goes to the ElevenLabs voice and nowhere else, the same way.
 *            AFTERCLASS_ANTHROPIC_API_KEY (optional) goes to the Claude Messages API adapter and nowhere else, the same way. It is
 *            read only when AFTERCLASS_CLAUDE_BACKEND=api, and it never reaches the `claude` child.
 *   claude   AFTERCLASS_CLAUDE_BACKEND=cli | api. Default cli: every Claude task runs through `claude -p` on the subscription.
 *            api: EVERY Claude task calls the Messages API (paid, priced from usage), so no `claude` binary is needed. api with no key
 *            refuses to start. Replay mode builds no Claude adapter, so the setting does nothing there.
 *   tutor    AFTERCLASS_TUTOR_MODEL=opus | sonnet, the model of the tutor turn and the wrap-up. Unset: sonnet when hosted, opus
 *            locally. Sonnet is a cost choice (experiment 8), not a judgment on its tutoring. With api, an idle review's cached
 *            tutor prompt is kept warm (review/keepalive.ts); each keep-alive is a paid call with its own usage event.
 *   voice    Tutor speech from ElevenLabs through POST /voice/speech, local live mode with a key only; otherwise GET /voice says
 *            unavailable and the app speaks with Chrome's voice. Hosted mode ignores the key: voice is not budgeted. AFTERCLASS_ELEVENLABS_VOICE_ID, AFTERCLASS_ELEVENLABS_MODEL.
 *   token    ~/.config/afterclass/pairing-token (0600), created on first boot, printed with "listening on 127.0.0.1:<port>".
 *   data     $AFTERCLASS_DATA (default ./data): afterclass.sqlite, frames/
 *   mode     AFTERCLASS_MODE=live | replay. Unset: live when a keys file exists, replay otherwise.
 *   budget   Live mode only; replay never touches it. Every paid request reserves against this month's (UTC) per-user and total
 *            budgets as it is sent (providers/budget.ts), and boot settles what a previous process left. AFTERCLASS_BUDGET_USER_USD and AFTERCLASS_BUDGET_TOTAL_USD set them in dollars.
 *            Hosted (AFTERCLASS_AUTH=clerk, or AFTERCLASS_HOST not loopback) defaults to 5 and 50; local has no cap unless set.
 *            Stop switch: AFTERCLASS_STOP_PAID_CALLS=1, or a file named stop-paid-calls in the config dir, which is looked for
 *            before every request (create it to stop new paid requests, delete it to resume; requests already sent finish).
 *   hosted   The container image sets AFTERCLASS_HOST=0.0.0.0, AFTERCLASS_HEALTH_ANY_HOST=1, AFTERCLASS_BUILD_APP=0 and
 *            AFTERCLASS_CONFIG_DIR. Unset, the backend binds 127.0.0.1 and every route keeps the localhost Host check.
 *            AFTERCLASS_HEALTH_ANY_HOST=1 relaxes the Host check for GET /health only, for the load balancer's health check.
 *   sign-in  AFTERCLASS_AUTH=local | clerk. Unset or local: the pairing token and the one local user, as above. clerk
 *            (`mainHosted`): Clerk session tokens, one user per Clerk account, no pairing token, and the app and API on
 *            AFTERCLASS_PUBLIC_ORIGIN (a bare origin, e.g. https://afterclass.example). Also required:
 *            AFTERCLASS_CLERK_ISSUER (the instance's Frontend API URL), AFTERCLASS_CLERK_JWKS_URL (its
 *            /.well-known/jwks.json) and AFTERCLASS_CLERK_PUBLISHABLE_KEY. Who may sign up is Clerk's setting
 *            (restricted mode or the allowlist in Clerk's dashboard), not ours. The extension connects with a device
 *            token (`devices.ts`), so AFTERCLASS_EXTENSION_ID must name the Chrome Web Store item.
 *
 * Each user's modules sit on that user's `UserDb` (`wire`), built at boot for every known user and on first sign-in for
 * a new one. The Jev and Claude clients and the scheduler are shared, so provider limits hold across users.
 *
 * Replay mode builds no Jev client and no `claude` adapter. Its providers refuse every call, and the memo is in replay
 * mode, so a lookup that misses throws ReplayMiss before any task runs: nothing opens a socket or spawns a process,
 * and nothing is recorded in the ledger. A caller may inject recorded or fake tasks (`options.tasks`); those are the
 * only way work runs in replay mode, and they are refused in live mode.
 *
 * Wiring order: db → memo → ledger → evidence → segmentation → preparation → reviews → record → scheduler → serve.
 * Every fact write schedules scheduler.pump(); a 24 h timer runs evidence.sweepExpired.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildApp } from "../../scripts/build-app";
import { stableId } from "../shared/ids";
import type { CaptureId, EvidenceId, UserId } from "../shared/ids";
import type { AssessableClaim, BoundaryJudgment, BoundaryWindow, Evidence, Frame, Passage, Verdict } from "../shared/domain";
import { heldMessage } from "../shared/allowance";
import { LOCAL_USER, ensureLocalUser, openDb, scopeDb, signedInUsers, userForIdentity } from "./db";
import type { Db, UserDb } from "./db";
import { clerkScriptUrl, createClerkVerifier, frontendApiOf } from "./clerk";
import { createDevices, isDeviceToken } from "./devices";
import type { Devices } from "./devices";
import type { ClerkConfig, Rejection, Verifier } from "./clerk";
import { createMemo, ProviderError } from "./providers/memo";
import type { Memo, MemoMode, Task } from "./providers/memo";
import { createBudget } from "./providers/budget";
import type { BudgetLimits } from "./providers/budget";
import { createLedger } from "./providers/ledger";
import type { Ledger } from "./providers/ledger";
import { createJevClient } from "./providers/jev";
import type { JevClient } from "./providers/jev";
import { createClaudeCli } from "./providers/claude";
import type { ClaudeCli, SpawnFn } from "./providers/claude";
import { createClaudeApi } from "./providers/claude-api";
import type { ApiClient } from "./providers/claude-api";
import { claimSupportTask, productBoundaryTask, productFrameChangeTask } from "./providers/jev-tasks";
import type { BoundaryInput, FrameChangeInput } from "./providers/jev-tasks";
import { createEvidence } from "./evidence";
import type { EvidenceStoreWithProbe } from "./evidence";
import { PRODUCT_JEV_SETUP } from "./jev-setup";
import { createSegmentation } from "./segmentation";
import type { Segmentation } from "./segmentation";
import { createPreparation } from "./preparation";
import type { Preparation } from "./preparation";
import { interpretTask, resourceSearchTask, reviseTask } from "./preparation/tasks";
import type { FrameBytes, PreparationTasks } from "./preparation/tasks";
import { createReviews } from "./review";
import type { Reviews } from "./review";
import { tutorTask, wrapUpTask } from "./review/tutor";
import type { TutorInput, TutorModel, TutorOutput, WrapUpInput, WrapUpOutput } from "./review/tutor";
import { keepAliveFor } from "./review/keepalive";
import type { KeepAlive } from "./review/keepalive";
import { createDiagrams } from "./diagram";
import type { Diagrams, DiagramSummaryInput, DiagramSummaryOutput } from "./diagram";
import { diagramSummaryTask } from "./diagram/tasks";
import { createRecord } from "./record";
import type { LearningRecord } from "./record";
import { DEFAULT_LIMITS, createScheduler } from "./scheduler";
import type { Scheduler, WorkItem } from "./scheduler";
import { DEFAULT_PORT, serve } from "./http";
import type { HostedAuth, ServedModules } from "./http";
import { DEFAULT_VOICE_ID, DEFAULT_VOICE_MODEL, checkVoiceSettings, createVoice, unavailableVoice } from "./providers/elevenlabs";
import type { Voice } from "./providers/elevenlabs";

const ROOT = resolve(import.meta.dir, "../..");
const RETENTION_DAYS = 30;

export type Mode = "live" | "replay";

/** Every task the product runs, bound to a provider. Tests inject fakes; replay mode otherwise binds refusing providers. */
export type TaskSet = {
  readonly boundary: Task<BoundaryInput, BoundaryJudgment>;
  readonly frameChange: Task<FrameChangeInput, Verdict>;
  readonly preparation: PreparationTasks;
  readonly tutor: Task<TutorInput, TutorOutput>;
  readonly wrapUp: Task<WrapUpInput, WrapUpOutput>;
  readonly diagramSummary: Task<DiagramSummaryInput, DiagramSummaryOutput>;
};

export type Env = Readonly<Record<string, string | undefined>>;

export type MainOptions = {
  /** Defaults to process.env. Read: AFTERCLASS_MODE, AFTERCLASS_CLAUDE_BACKEND, AFTERCLASS_DATA, AFTERCLASS_PORT, AFTERCLASS_HOST, AFTERCLASS_HEALTH_ANY_HOST, AFTERCLASS_BUILD_APP, AFTERCLASS_CONFIG_DIR, AFTERCLASS_EXTENSION_ID, AFTERCLASS_ELEVENLABS_VOICE_ID, AFTERCLASS_ELEVENLABS_MODEL, AFTERCLASS_TUTOR_MODEL, the budget settings AFTERCLASS_BUDGET_USER_USD, AFTERCLASS_BUDGET_TOTAL_USD, AFTERCLASS_STOP_PAID_CALLS, and the sign-in settings AFTERCLASS_AUTH (also hosted or not, for the budget), AFTERCLASS_CLERK_ISSUER, AFTERCLASS_CLERK_JWKS_URL, AFTERCLASS_CLERK_PUBLISHABLE_KEY, AFTERCLASS_PUBLIC_ORIGIN. */
  readonly env?: Env;
  /** Holds keys.env and pairing-token. Defaults to AFTERCLASS_CONFIG_DIR, then ~/.config/afterclass. */
  readonly configDir?: string;
  /** Overrides AFTERCLASS_PORT; 0 binds a free port. */
  readonly port?: number;
  /** Replay mode only: recorded or fake tasks. They replace the providers, so the memo may run them. */
  readonly tasks?: TaskSet;
  /** Where the review app is built and served from. Default <repo>/dist/app. */
  readonly appDir?: string;
  /** False skips the app build (tests that do not serve the app). */
  readonly buildApp?: boolean;
  /** Live mode seams, so a test can watch the wiring without a network or a process. */
  readonly fetch?: typeof fetch;
  readonly spawn?: SpawnFn;
  readonly claudeBin?: string;
  /** AFTERCLASS_CLAUDE_BACKEND=api only: a fake Messages API client, so a test makes no network call. */
  readonly anthropic?: ApiClient;
  readonly log?:(text: string) => void;
  readonly error?: (text: string) => void;
};

export type Modules = {
  readonly evidence: EvidenceStoreWithProbe;
  readonly segmentation: Segmentation;
  readonly preparation: Preparation;
  readonly reviews: Reviews;
  readonly record: LearningRecord;
  readonly ledger: Ledger;
  readonly memo: Memo;
  readonly scheduler: Scheduler;
  readonly db: UserDb;
};

export type Running = {
  readonly mode: Mode;
  readonly port: number;
  readonly token: string;
  readonly modules: Modules;
  stop(): Promise<void>;
};

// ───────────────────────────── secrets and files ─────────────────────────────

/** A file holding a secret must be a regular file, ours, and exactly 0600. The message never contains file contents. */
function assertPrivateFile(path: string, what: string): void {
  const st = statSync(path);
  if (!st.isFile()) throw new Error(`${what} ${path} is not a regular file; refusing to start`);
  const mode = st.mode & 0o777;
  if (mode !== 0o600) throw new Error(`${what} ${path} has mode ${mode.toString(8).padStart(4, "0")}, not 0600; run chmod 600 on it. Refusing to start`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${what} ${path} is owned by another user; refusing to start`);
}

/** The secrets the backend reads from keys.env. Anything else in the file is ignored, never forwarded. */
export type Keys = { readonly TYPESAFE_API_KEY?: string; readonly ELEVENLABS_API_KEY?: string; readonly AFTERCLASS_ANTHROPIC_API_KEY?: string };

const KEY_NAMES = ["TYPESAFE_API_KEY", "ELEVENLABS_API_KEY", "AFTERCLASS_ANTHROPIC_API_KEY"] as const;

export function readKeys(path: string): Keys {
  assertPrivateFile(path, "keys file");
  const out: { -readonly [K in keyof Keys]?: string } = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const name = line.slice(0, eq).replace(/^export\s+/, "").trim();
    const known = KEY_NAMES.find((k) => k === name);
    if (known === undefined) continue;
    const value = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    if (value !== "") out[known] = value;
  }
  return out;
}

export function loadPairingToken(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    try {
      writeFileSync(path, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  assertPrivateFile(path, "pairing token file");
  const token = readFileSync(path, "utf8").trim();
  if (token === "") throw new Error(`pairing token file ${path} is empty; delete it to mint a new token. Refusing to start`);
  return token;
}

export function resolveMode(requested: string | undefined, keysFileExists: boolean): Mode {
  if (requested === undefined || requested === "") return keysFileExists ? "live" : "replay";
  if (requested === "live" || requested === "replay") return requested;
  throw new Error(`AFTERCLASS_MODE must be "live" or "replay", got "${requested}"`);
}

// ───────────────────────────── providers and tasks ─────────────────────────────

const refused = (what: string) => new ProviderError(`replay mode: a live ${what} call was refused`, null, false);

/** Replay mode's providers. They exist so a task can still be built; any call to them is a bug and says so. */
const refusingJev: JevClient = { ask: () => Promise.reject(refused("Jev")) };
const refusingClaude: ClaudeCli = {
  structured: () => Promise.reject(refused("Claude")),
  streamText: () => Promise.reject(refused("Claude")),
};

export type ClaudeBackend = "cli" | "api";

export function resolveClaudeBackend(requested: string | undefined): ClaudeBackend {
  if (requested === undefined || requested === "") return "cli";
  if (requested === "cli" || requested === "api") return requested;
  throw new Error(`AFTERCLASS_CLAUDE_BACKEND must be "cli" or "api", got "${requested}"`);
}

export function buildTasks(jev: JevClient, claude: ClaudeCli, frameBytes: FrameBytes, tutorModel: TutorModel = "opus", keepAlive: KeepAlive | null = null): TaskSet {
  return {
    boundary: productBoundaryTask(jev),
    frameChange: productFrameChangeTask(jev),
    preparation: {
      interpret: interpretTask(claude, frameBytes),
      revise: reviseTask(claude, frameBytes),
      checkClaim: claimSupportTask(jev),
      searchResources: resourceSearchTask(claude),
    },
    tutor: tutorTask(claude, tutorModel, keepAlive?.sent),
    wrapUp: wrapUpTask(claude, tutorModel),
    diagramSummary: diagramSummaryTask(claude, frameBytes),
  };
}

// ───────────────────────────── budgets ─────────────────────────────

/** Derek, 2026-11-13: "$5 per user and $50 total". */
export const HOSTED_LIMITS: BudgetLimits = { userUsd: 5, totalUsd: 50 };
export const STOP_FILE = "stop-paid-calls";

const LOOPBACK = new Set(["", "127.0.0.1", "localhost", "::1"]);

function usdSetting(name: string, text: string | undefined): number | null {
  if (text === undefined || text === "") return null;
  const usd = Number(text);
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`${name} must be a dollar amount of 0 or more, got "${text}"`);
  return usd;
}

/** Hosted means people other than the machine's owner can reach the backend. */
export function isHosted(env: Env): boolean {
  return env.AFTERCLASS_AUTH === "clerk" || !LOOPBACK.has(env.AFTERCLASS_HOST ?? "");
}

/** A hosted backend's calls are capped by default. */
export function resolveBudgetLimits(env: Env): BudgetLimits {
  const hosted = isHosted(env);
  const userUsd = usdSetting("AFTERCLASS_BUDGET_USER_USD", env.AFTERCLASS_BUDGET_USER_USD);
  const totalUsd = usdSetting("AFTERCLASS_BUDGET_TOTAL_USD", env.AFTERCLASS_BUDGET_TOTAL_USD);
  return hosted ? { userUsd: userUsd ?? HOSTED_LIMITS.userUsd, totalUsd: totalUsd ?? HOSTED_LIMITS.totalUsd } : { userUsd, totalUsd };
}

/** Derek, 2026-11-13: "We could definitely use Sonnet for the tutor." Hosted defaults to it; local keeps Opus. */
export function resolveTutorModel(env: Env): TutorModel {
  const requested = env.AFTERCLASS_TUTOR_MODEL ?? "";
  if (requested === "") return isHosted(env) ? "sonnet" : "opus";
  if (requested === "opus" || requested === "sonnet") return requested;
  throw new Error(`AFTERCLASS_TUTOR_MODEL must be "opus" or "sonnet", got "${requested}"`);
}

/** The stop switch: the environment at boot, or the file, which is looked for before every request. */
export function stopSwitch(env: Env, configDir: string): () => boolean {
  const flag = env.AFTERCLASS_STOP_PAID_CALLS ?? "";
  if (!["", "0", "1"].includes(flag)) throw new Error(`AFTERCLASS_STOP_PAID_CALLS must be 1 or 0, got "${flag}"`);
  const file = join(configDir, STOP_FILE);
  return flag === "1" ? () => true : () => existsSync(file);
}

const parsePort = (text: string | undefined): number | null => {
  if (text === undefined || text === "") return null;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`AFTERCLASS_PORT must be an integer from 0 to 65535, got "${text}"`);
  return n;
};

// ───────────────────────────── sign-in ─────────────────────────────

/** How callers prove who they are. Local: the pairing token, one user. Clerk: hosted sign-in, one user per Clerk account. */
export type Auth =
  | { readonly kind: "local" }
  | { readonly kind: "clerk"; readonly clerk: ClerkConfig; readonly publishableKey: string; readonly frontendApi: string; readonly publicOrigin: string };

const HOSTED_SETTINGS = ["AFTERCLASS_CLERK_ISSUER", "AFTERCLASS_CLERK_JWKS_URL", "AFTERCLASS_CLERK_PUBLISHABLE_KEY", "AFTERCLASS_PUBLIC_ORIGIN"] as const;

const originOf = (text: string): string | null => {
  try {
    return new URL(text).origin;
  } catch {
    return null;
  }
};

/** https, or http to a loopback host, which only a test's fake JWKS uses. */
function keysUrlOk(text: string): boolean {
  try {
    const u = new URL(text);
    return u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost"));
  } catch {
    return false;
  }
}

/** AFTERCLASS_AUTH: unset or "local" keeps the pairing token; "clerk" is hosted sign-in and needs every Clerk setting. */
export function resolveAuth(env: Env): Auth {
  const requested = env.AFTERCLASS_AUTH;
  if (requested === undefined || requested === "" || requested === "local") return { kind: "local" };
  if (requested !== "clerk") throw new Error(`AFTERCLASS_AUTH must be "local" or "clerk", got "${requested}"`);
  const missing = HOSTED_SETTINGS.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`AFTERCLASS_AUTH=clerk needs ${missing.join(", ")}; refusing to start`);
  const publicOrigin = env.AFTERCLASS_PUBLIC_ORIGIN!;
  if (originOf(publicOrigin) !== publicOrigin) throw new Error(`AFTERCLASS_PUBLIC_ORIGIN must be a bare origin such as https://afterclass.example, got "${publicOrigin}"`);
  const jwksUrl = env.AFTERCLASS_CLERK_JWKS_URL!;
  if (!keysUrlOk(jwksUrl)) throw new Error(`AFTERCLASS_CLERK_JWKS_URL must be an https URL, got "${jwksUrl}"`);
  const publishableKey = env.AFTERCLASS_CLERK_PUBLISHABLE_KEY!;
  const frontendApi = frontendApiOf(publishableKey);
  if (frontendApi === null) throw new Error("AFTERCLASS_CLERK_PUBLISHABLE_KEY is not a Clerk publishable key (pk_test_... or pk_live_...)");
  return { kind: "clerk", clerk: { issuer: env.AFTERCLASS_CLERK_ISSUER!, jwksUrl, authorizedParties: [publicOrigin] }, publishableKey, frontendApi, publicOrigin };
}

/** A session token's user: verified against Clerk's keys, then mapped to its `users` row, which its first sign-in creates. */
export function clerkUsers(verifier: Verifier, db: Db, onRefused: (reason: Rejection) => void = () => {}): (token: string) => Promise<UserId | null> {
  return async (token) => {
    const verdict = await verifier.verify(token);
    if (!verdict.ok) {
      onRefused(verdict.reason);
      return null;
    }
    return userForIdentity(db, { provider: "clerk", subject: verdict.subject });
  };
}

/** Every hosted bearer token: a device token by its shape, looked up hashed; anything else is a session token for Clerk. */
export function hostedCallers(sessionUser: (token: string) => Promise<UserId | null>, devices: Devices): HostedAuth["userFor"] {
  return async (token) => {
    if (isDeviceToken(token)) {
      const userId = devices.userFor(token);
      return userId === null ? null : { userId, bearer: "device" };
    }
    const userId = await sessionUser(token);
    return userId === null ? null : { userId, bearer: "session" };
  };
}

// ───────────────────────────── composition ─────────────────────────────

/** Everything one user's requests and background work run on. Built once per user and kept for the process's life. */
type UserGraph = Omit<Modules, "scheduler"> & {
  readonly tasks: TaskSet;
  readonly served: EvidenceStoreWithProbe;
  readonly diagrams: Diagrams;
  readonly voice: Voice;
  /** Every capture of this user that may still have work: those on disk at boot, plus any ingested since. */
  readonly captures: Set<CaptureId>;
  /** Null unless the Claude adapter can keep a cache warm. */
  readonly keepAlive: KeepAlive | null;
};

type Composed = {
  readonly mode: Mode;
  readonly port: number;
  readonly token: string;
  readonly graphs: { get(userId: UserId): UserGraph };
  readonly scheduler: Scheduler;
  stop(): Promise<void>;
};

async function compose(options: MainOptions, auth: Auth): Promise<Composed> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((text: string) => console.log(text));
  const logError = options.error ?? ((text: string) => console.error(text));

  const configDir = options.configDir ?? (env.AFTERCLASS_CONFIG_DIR || join(homedir(), ".config", "afterclass"));
  const keysPath = join(configDir, "keys.env");
  const keysFile = existsSync(keysPath);
  const mode = resolveMode(env.AFTERCLASS_MODE, keysFile);
  if (options.tasks && mode !== "replay") throw new Error("injected tasks are accepted only in replay mode");
  if (mode === "live" && !keysFile) throw new Error(`AFTERCLASS_MODE=live needs ${keysPath}`);

  // Everything that can refuse to start runs before a file is created or a port is bound.
  const keys = mode === "live" ? readKeys(keysPath) : {};
  const apiKey = keys.TYPESAFE_API_KEY;
  const voiceId = env.AFTERCLASS_ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
  const voiceModel = env.AFTERCLASS_ELEVENLABS_MODEL || DEFAULT_VOICE_MODEL;
  // Derek, 2026-11-13: "we can keep elevenlabs off for now". Voice runs outside the budget, so hosted mode never uses the key.
  const voiceIgnored = isHosted(env) && keys.ELEVENLABS_API_KEY !== undefined;
  const voiceKey = isHosted(env) ? undefined : keys.ELEVENLABS_API_KEY;
  if (voiceKey !== undefined) checkVoiceSettings(voiceId, voiceModel);
  if (mode === "live" && apiKey === undefined) throw new Error(`${keysPath} has no TYPESAFE_API_KEY; refusing to start`);
  const claudeBackend = resolveClaudeBackend(env.AFTERCLASS_CLAUDE_BACKEND);
  const anthropicKey = keys.AFTERCLASS_ANTHROPIC_API_KEY;
  if (mode === "live" && claudeBackend === "api" && anthropicKey === undefined) {
    throw new Error(`AFTERCLASS_CLAUDE_BACKEND=api needs AFTERCLASS_ANTHROPIC_API_KEY in ${keysPath}; refusing to start`);
  }
  const budgetLimits = resolveBudgetLimits(env);
  const tutorModel = resolveTutorModel(env);
  const paidCallsStopped = stopSwitch(env, configDir);
  // Hosted mode has no pairing token: sign-in replaces it.
  const token = auth.kind === "local" ? loadPairingToken(join(configDir, "pairing-token")) : "";
  const port = options.port ?? parsePort(env.AFTERCLASS_PORT) ?? DEFAULT_PORT;
  const extensionId = env.AFTERCLASS_EXTENSION_ID ?? "";

  const dataDir = resolve(env.AFTERCLASS_DATA ?? "data");
  mkdirSync(dataDir, { recursive: true });
  const rawDb = openDb(join(dataDir, "afterclass.sqlite"));

  const liveClaude = (): ClaudeCli => {
    if (claudeBackend === "api") {
      log("claude backend: api for every Claude task (paid, priced from usage); no claude binary is used");
      return createClaudeApi({ apiKey: anthropicKey!, maxConcurrent: DEFAULT_LIMITS.claude, ...(options.anthropic ? { client: options.anthropic } : {}) });
    }
    const claudeCwd = join(dataDir, "claude-cwd");
    mkdirSync(claudeCwd, { recursive: true });
    // No provider key may reach the child: claude -p bills the subscription login, and the Jev, voice and Messages API keys are not its business.
    const { TYPESAFE_API_KEY: _jevKey, ELEVENLABS_API_KEY: _voiceKey, AFTERCLASS_ANTHROPIC_API_KEY: _messagesKey, ...childEnv } = env;
    return createClaudeCli({ bin: options.claudeBin ?? "claude", cwd: claudeCwd, maxConcurrent: DEFAULT_LIMITS.claude, env: childEnv, ...(options.spawn ? { spawn: options.spawn } : {}) });
  };
  // One client per provider for the whole process, so their concurrency limits hold across users.
  const providers: { readonly jev: JevClient; readonly claude: ClaudeCli } =
    mode === "live" && !options.tasks
      ? { jev: createJevClient({ apiKey: apiKey!, ...(options.fetch ? { fetch: options.fetch } : {}) }), claude: liveClaude() }
      : { jev: refusingJev, claude: refusingClaude };

  // Injected tasks make no live call, so the memo may run them. Without them, replay never runs a task at all.
  const memoMode: MemoMode = mode === "replay" && !options.tasks ? "replay" : "live";
  // Only the Messages API can keep a cache warm; replay's refusing adapter and `claude -p` cannot, and injected tasks make no live call.
  const keepsWarm = !options.tasks && providers.claude.keepWarm !== undefined;
  // One budget for every user, on the raw db: the total cap sums all of them. Each user's memo reserves as its own user.
  const budget = mode === "live" ? createBudget(rawDb, { limits: budgetLimits, stopped: paidCallsStopped }) : null;
  // Before any request: what a previous process left unsettled gets its usage event (R17) and counts at its price, or its reservation when unpriced.
  const interrupted = budget?.reconcileInterrupted() ?? 0;

  let alive = true;
  let scheduler: Scheduler | null = null;
  /** After the current synchronous work, so a pump never runs inside the transaction that wrote the fact. */
  const pump = () =>
    queueMicrotask(() => {
      if (!alive) return;
      try {
        scheduler?.pump();
      } catch (e) {
        reportOnce("pump", e);
      }
    });
  const reported = new Set<string>();
  function reportOnce(where: string, error: unknown): void {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const line = `${where}: ${message}`;
    if (reported.has(line)) return;
    reported.add(line);
    logError(`backend: ${line}`);
  }

  /** One user's modules on that user's `UserDb`. The tasks read frame bytes through this user's evidence only. */
  function wire(db: UserDb): UserGraph {
    // evidence is created after the tasks that need its bytes; the tasks only read it when a call runs
    const frameBytes: FrameBytes = (id) => evidence.frameBytes(id);
    const memo = createMemo(db, memoMode, budget === null ? {} : { budget });
    const ledger = createLedger(db, budget);
    const keepAlive: KeepAlive | null = !keepsWarm
      ? null
      : keepAliveFor(providers.claude, tutorModel, {
        memo,
        // reviews is built below; a keep-alive only asks once a tutor request has been sent.
        ended: (reviewId) => reviews.view(reviewId).state.phase === "ended",
        onError: (reviewId, e) => reportOnce(`keep-alive ${reviewId}`, e),
      });
    const tasks: TaskSet = options.tasks ?? buildTasks(providers.jev, providers.claude, frameBytes, tutorModel, keepAlive);

    const evidence: EvidenceStoreWithProbe = createEvidence(db, dataDir, {
      lookupFrameChange: (input) => memo.lookup(tasks.frameChange, input),
      // The first frame of a source has nothing to compare with: evidence keeps it without a call, and so does this.
      runFrameChange: (input, signal) => (input.before === null ? Promise.resolve(null) : memo.run(tasks.frameChange, input, { signal })),
      frameChangeKey: (input) => memo.key(tasks.frameChange, input),
      onChange: pump,
    });

    const passageOf = (e: Evidence | { readonly kind: "deleted" } | undefined): e is Passage => e?.kind === "passage";
    const frameOf = (e: Evidence | { readonly kind: "deleted" } | undefined): e is Frame => e?.kind === "frame";

    function boundaryInput(window: BoundaryWindow): BoundaryInput {
      const found = evidence.get([...window.newPassages, ...window.contextPassages, ...window.frames]);
      const passages = (ids: readonly EvidenceId[]) => ids.map((id) => found.get(id)).filter(passageOf);
      return {
        window,
        newPassages: passages(window.newPassages),
        contextPassages: passages(window.contextPassages),
        frames: window.frames.map((id) => found.get(id)).filter(frameOf).map((frame) => ({
          frame,
          bytes: () => {
            const bytes = evidence.frameBytes(frame.id);
            if (bytes === null) throw new ProviderError(`frame bytes unavailable for ${frame.id}`, null, false);
            return bytes;
          },
        })),
      };
    }

    const segmentation = createSegmentation(
      db,
      {
        watchOrder: evidence.watchOrder,
        lookupBoundary: (input) => memo.lookup(tasks.boundary, input),
        boundaryInput,
        nextSeq: () => db.nextSeq(),
      },
      PRODUCT_JEV_SETUP.segmentation,
      PRODUCT_JEV_SETUP.routing,
    );

    const preparationBase = createPreparation(db, {
      chunk: segmentation.revision,
      currentChunks: segmentation.current,
      bundle: evidence.bundle,
      lookup: memo.lookup,
      run: (task, input, signal) => memo.run(task, input, { signal }),
      clearFailures: memo.clearFailures,
      tasks: tasks.preparation,
      frameBytes: evidence.frameBytes,
    });
    // Stop early is a fact that cancels work by derivation; the pump is what aborts what is already running.
    const preparation: Preparation = { ...preparationBase, stopEarly: (captureId, ids) => {
      const seq = preparationBase.stopEarly(captureId, ids);
      pump();
      return seq;
    }, retry: (captureId, ids) => {
      const seq = preparationBase.retry(captureId, ids);
      pump();
      return seq;
    } };

    const reviews = createReviews(db, {
      currentChunks: segmentation.current,
      chunkHistory: segmentation.history,
      prep: preparation.prep,
      stopEarly: preparation.stopEarly,
      assessableIn: preparation.assessableIn,
      claimsIn: preparation.claimsIn,
      concepts: preparation.concepts,
      bundle: evidence.bundle,
      watchedSeconds: (captureId) => evidence.captureView(captureId).watchedSeconds,
      runTutor: (input, streamTo, signal, onRetry) => memo.run(tasks.tutor, input, { signal, streamTo, onRetry }),
      clearFailures: memo.clearFailures,
      runWrapUp: (input) => memo.run(tasks.wrapUp, input),
      endedInTx: (reviewId) => record.markEndedInTx(reviewId),
      nextSeq: () => db.nextSeq(),
    });

    /** The claims usable now (R3, R7) inside the review's frozen material, not the ones it started with. */
    function usableNow(reviewId: Parameters<LearningRecord["save"]>[0]): readonly AssessableClaim[] {
      const { captureId, scope } = reviews.view(reviewId);
      const bundle = evidence.bundle(scope.material);
      const inScope = new Set<EvidenceId>([...bundle.passages.map((p) => p.id), ...bundle.frames.map((f) => f.id)]);
      return preparation.assessableIn(captureId, scope.material).filter((c) => c.evidence.every((e) => inScope.has(e)));
    }

    const record = createRecord(db, {
      turns: (reviewId) => reviews.view(reviewId).turns,
      claims: usableNow,
      async wrapUp(reviewId) {
        const turns = reviews.view(reviewId).turns;
        const threads = [...new Set(turns.flatMap((t) => (t.actor === "tutor" && (t.move.kind === "ask_main" || t.move.kind === "quick_check") ? [t.move.threadId] : [])))];
        const input = { turns, claims: usableNow(reviewId), threads };
        // A terminal failure stored before this request began answered an earlier save, so this retry clears it and asks once more.
        // A failure this request produced is returned as is. A hit is never cleared.
        const asOf = db.nextSeq();
        let result = await memo.run(tasks.wrapUp, input);
        if (result.kind === "failed" && result.atSeq < asOf) {
          memo.clearFailures([result.key]);
          result = await memo.run(tasks.wrapUp, input);
        }
        if (result.kind === "hit") return result.value;
        throw new Error(result.kind === "failed" ? `wrap-up failed: ${result.lastError}` : result.kind === "held" ? heldMessage(result.hold) : `wrap-up ${result.kind}`);
      },
      snapshotEvidenceInTx: evidence.snapshotInTx,
      links: preparation.linkSuggestions,
    });

    const diagrams: Diagrams = createDiagrams({
      review(reviewId) {
        try {
          const { captureId, scope, topics } = reviews.view(reviewId);
          return { captureId, scope, topics };
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("unknown review")) return null;
          throw e;
        }
      },
      usable: usableNow,
      bundle: evidence.bundle,
      sources: (captureId) => evidence.captureView(captureId).sources,
      task: tasks.diagramSummary,
      memo,
    });

    const captures = new Set<CaptureId>(evidence.captures());
    // The scheduler is the only holder of these; http gets the same store with ingest registering the capture first.
    const served: EvidenceStoreWithProbe = {
      ...evidence,
      ingest(batch) {
        captures.add(batch.captureId);
        return evidence.ingest(batch);
      },
    };

    const voice: Voice =
      voiceKey === undefined
        ? unavailableVoice
        : createVoice({ apiKey: voiceKey, voiceId, model: voiceModel, db, ...(options.fetch ? { fetch: options.fetch } : {}) });

    return { tasks, evidence, served, segmentation, preparation, reviews, record, ledger, memo, diagrams, voice, captures, db, keepAlive };
  }

  const graphs = new Map<UserId, UserGraph>();
  /** Synchronous, so two first requests from one user can never build two graphs. */
  const graphFor = (userId: UserId): UserGraph => {
    let graph = graphs.get(userId);
    if (graph === undefined) {
      graph = wire(scopeDb(rawDb, userId));
      graphs.set(userId, graph);
    }
    return graph;
  };
  // Before the scheduler, whose first sweep runs as it is created.
  if (auth.kind === "local") graphFor(ensureLocalUser(rawDb));
  else for (const userId of signedInUsers(rawDb)) graphFor(userId);

  /**
   * Every user's demand, each item keyed by its user as well: memo keys hash the call alone, so two users' identical
   * calls share a key, and the scheduler would otherwise treat one user's run as the other's.
   */
  const everyCapture = (where: string, items: (graph: UserGraph, captureId: CaptureId) => readonly WorkItem[]) => (): readonly WorkItem[] =>
    [...graphs.values()].flatMap((graph) =>
      [...graph.captures].flatMap((captureId) => {
        try {
          return items(graph, captureId).map((item) => ({ ...item, key: stableId("key", graph.db.userId, item.key) }));
        } catch (e) {
          reportOnce(`${where} ${captureId}`, e);
          return [];
        }
      }),
    );

  scheduler = createScheduler(
    [
      everyCapture("segmentation", ({ segmentation, memo, tasks }, captureId) =>
        segmentation.sync(captureId).demand.map((input): WorkItem => ({
          key: memo.key(tasks.boundary, input),
          purpose: "boundary",
          provider: "jev",
          run: (signal) => memo.run(tasks.boundary, input, { signal, captureId }),
        })),
      ),
      everyCapture("frame demand", ({ evidence }, captureId) => evidence.frameDemand(captureId)),
      everyCapture("preparation", ({ preparation }, captureId) => preparation.demand(captureId)),
    ],
    DEFAULT_LIMITS,
    {
      sweep: {
        run: () => {
          for (const graph of graphs.values()) {
            try {
              graph.evidence.sweepExpired(Date.now(), RETENTION_DAYS);
            } catch (e) {
              reportOnce(`sweepExpired ${graph.db.userId}`, e);
            }
          }
        },
      },
      onError: reportOnce,
    },
  );

  const appDir = resolve(options.appDir ?? join(ROOT, "dist", "app"));
  if (options.buildApp !== false && env.AFTERCLASS_BUILD_APP !== "0") {
    try {
      await buildApp(appDir);
    } catch (e) {
      logError(`backend: the review app was not built, so /app/ answers 503: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const served = (g: UserGraph): ServedModules => ({
    ledger: g.ledger, evidence: g.served, reviews: g.reviews, record: g.record, preparation: g.preparation, segmentation: g.segmentation, voice: g.voice, diagrams: g.diagrams,
    ...(g.keepAlive === null ? {} : { keepAlive: g.keepAlive }),
  });
  const hostname = env.AFTERCLASS_HOST || "127.0.0.1";
  const devices = createDevices(rawDb);
  const server =
    auth.kind === "local"
      ? serve({
        modules: served(graphFor(LOCAL_USER)),
        auth: { port, extensionId, token },
        appDir,
        hostname,
        healthAnyHost: env.AFTERCLASS_HEALTH_ANY_HOST === "1",
      })
      : serve({
        hosted: {
          publicOrigin: auth.publicOrigin,
          extensionId,
          clerk: { scriptUrl: clerkScriptUrl(auth.frontendApi), publishableKey: auth.publishableKey },
          userFor: hostedCallers(clerkUsers(createClerkVerifier(auth.clerk), rawDb, (reason) => reportOnce("sign-in", new Error(`a session token was refused (${reason})`))), devices),
          devices,
        },
        port,
        modulesFor: (userId) => served(graphFor(userId)),
        appDir,
        hostname,
      });
  const boundPort = server.port as number;

  if (auth.kind === "local" && extensionId === "") logError("backend: AFTERCLASS_EXTENSION_ID is not set, so the extension's requests are refused (403) until it is");
  log(
    mode === "live"
      ? "mode: live (Jev with the key from keys.env; Claude through claude -p on your login)"
      : `mode: replay (${keysFile ? "AFTERCLASS_MODE=replay" : "no keys file"}: Jev unavailable, Claude unavailable, every live call is refused)`,
  );
  const cap = (usd: number | null) => (usd === null ? "no cap" : `$${usd}`);
  if (mode === "live") log(`tutor and wrap-up model: ${tutorModel}`);
  if (keepsWarm) log("keep-alive: an idle review's cached prompt is kept warm for up to an hour");
  if (budget !== null) log(`budget per month (UTC): ${cap(budgetLimits.userUsd)} per user, ${cap(budgetLimits.totalUsd)} in total; stop switch: ${join(configDir, STOP_FILE)}${paidCallsStopped() ? " (on)" : ""}`);
  if (interrupted > 0) log(`budget: ${interrupted} call(s) a previous process left unfinished are recorded at unknown cost and count at their reservation`);
  log(
    voiceKey !== undefined
      ? `voice: ElevenLabs (model ${voiceModel}, voice ${voiceId})`
      : voiceIgnored
        ? "voice: ELEVENLABS_API_KEY is ignored in hosted mode, where ElevenLabs stays off; the app speaks with Chrome's voice"
        : "voice: unavailable (no ELEVENLABS_API_KEY in keys.env, or replay mode); the app speaks with Chrome's voice",
  );
  if (auth.kind === "clerk") log(`sign-in: Clerk for ${auth.publicOrigin}; the extension connects through ${auth.publicOrigin}/app/connect-extension`);
  if (auth.kind === "clerk" && extensionId === "") logError("backend: AFTERCLASS_EXTENSION_ID is not set, so no extension can connect until it is");
  // The token is printed only for a loopback bind. A hosted container's log goes to CloudWatch, which is not a place for a secret.
  log(hostname === "127.0.0.1" && auth.kind === "local" ? `listening on 127.0.0.1:${boundPort}\npairing token: ${token}` : `listening on ${hostname}:${boundPort}`);

  pump();

  return {
    mode,
    port: boundPort,
    token,
    graphs: { get: graphFor },
    scheduler,
    async stop() {
      alive = false;
      for (const graph of graphs.values()) graph.keepAlive?.stop();
      await scheduler?.stop();
      await server.stop(true);
      rawDb.close();
    },
  };
}

/** Local mode: the pairing token and the one local user. Refuses hosted settings, which `mainHosted` serves. */
export async function main(options: MainOptions = {}): Promise<Running> {
  const auth = resolveAuth(options.env ?? process.env);
  if (auth.kind !== "local") throw new Error("AFTERCLASS_AUTH=clerk is served by mainHosted, not main");
  const c = await compose(options, auth);
  const { evidence, segmentation, preparation, reviews, record, ledger, memo, db } = c.graphs.get(LOCAL_USER);
  return { mode: c.mode, port: c.port, token: c.token, modules: { evidence, segmentation, preparation, reviews, record, ledger, memo, scheduler: c.scheduler, db }, stop: c.stop };
}

export type HostedRunning = {
  readonly mode: Mode;
  readonly port: number;
  /** A signed-in user's modules, built on first use. */
  modulesFor(userId: UserId): Modules;
  stop(): Promise<void>;
};

/** Hosted mode (AFTERCLASS_AUTH=clerk): Clerk sign-in, one user per Clerk account, the app and API on the public origin. */
export async function mainHosted(options: MainOptions = {}): Promise<HostedRunning> {
  const auth = resolveAuth(options.env ?? process.env);
  if (auth.kind !== "clerk") throw new Error("mainHosted needs AFTERCLASS_AUTH=clerk");
  const c = await compose(options, auth);
  return {
    mode: c.mode,
    port: c.port,
    modulesFor(userId) {
      const { evidence, segmentation, preparation, reviews, record, ledger, memo, db } = c.graphs.get(userId);
      return { evidence, segmentation, preparation, reviews, record, ledger, memo, scheduler: c.scheduler, db };
    },
    stop: c.stop,
  };
}

if (import.meta.main) {
  const running = resolveAuth(process.env).kind === "clerk" ? await mainHosted() : await main();
  const shutdown = () => void running.stop().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
