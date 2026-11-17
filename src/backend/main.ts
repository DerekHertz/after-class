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
 *            locally. Sonnet is a cost choice (experiment 8), not a judgment on its tutoring.
 *   voice    Tutor speech from ElevenLabs through POST /voice/speech, local live mode with a key only; otherwise GET /voice says
 *            unavailable and the app speaks with Chrome's voice. Hosted mode ignores the key: voice is not budgeted. AFTERCLASS_ELEVENLABS_VOICE_ID, AFTERCLASS_ELEVENLABS_MODEL.
 *   token    ~/.config/afterclass/pairing-token (0600), created on first boot, printed with "listening on 127.0.0.1:<port>".
 *   data     $AFTERCLASS_DATA (default ./data): afterclass.sqlite, frames/
 *   mode     AFTERCLASS_MODE=live | replay. Unset: live when a keys file exists, replay otherwise.
 *   budget   Live mode only; replay never touches it. Every paid request reserves against this month's (UTC) per-user and total
 *            budgets as it is sent (providers/budget.ts), and boot settles what a previous process left. AFTERCLASS_BUDGET_USER_USD and AFTERCLASS_BUDGET_TOTAL_USD set them in dollars. AFTERCLASS_BUDGET_UNCAPPED_USERS lists Clerk user ids, comma separated, that skip the caps (env, or keys.env).
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
 * An upload schedules scheduler.pump() on a short timer, so its reply goes out first and a burst of uploads shares one pump;
 * stop early and retry pump at once. A pump derives only the captures that can have demand (`UserGraph.live`).
 * A 24 h timer runs evidence.sweepExpired.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildApp } from "../../scripts/build-app";
import { parseExtensionIds } from "../shared/extension-ids";
import { stableId } from "../shared/ids";
import type { CaptureId, EvidenceId, ReviewId, UserId } from "../shared/ids";
import { memoDep } from "./deps";
import type { Dep, ReadDep } from "./deps";
import type { AssessableClaim, BoundaryJudgment, BoundaryWindow, Evidence, Frame, Passage, Verdict } from "../shared/domain";
import { heldMessage } from "../shared/allowance";
import { LOCAL_USER, ensureLocalUser, openDb, scopeDb, signedInUsers, userForIdentity } from "./db";
import type { Db, UserDb } from "./db";
import { clerkScriptUrl, clerkUiScriptUrl, createClerkVerifier, frontendApiOf } from "./clerk";
import { createDevices, isDeviceToken } from "./devices";
import type { Devices } from "./devices";
import type { ClerkConfig, Rejection, Verifier } from "./clerk";
import { createMemo, ProviderError } from "./providers/memo";
import type { LookupFn, Memo, MemoMode, Task } from "./providers/memo";
import { createBudget } from "./providers/budget";
import type { BudgetLimits } from "./providers/budget";
import { createLedger } from "./providers/ledger";
import type { Ledger } from "./providers/ledger";
import { createJevClient } from "./providers/jev";
import type { JevClient } from "./providers/jev";
import { createClaudeCli } from "./providers/claude";
import type { ClaudeCli, SpawnFn } from "./providers/claude";
import { cliStreamEstimateUsd, createClaudeApi } from "./providers/claude-api";
import type { ApiClient } from "./providers/claude-api";
import { claimSupportTask, productBoundaryTask, productFrameChangeTask } from "./providers/jev-tasks";
import type { BoundaryInput, FrameChangeInput } from "./providers/jev-tasks";
import { createEvidence } from "./evidence";
import { readVolume, startDiskWatch } from "./evidence/disk-watch";
import { resolveIngestLimits } from "./evidence/ingest-limits";
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
import { tutorCache, tutorTask, wrapUpInput, wrapUpTask } from "./review/tutor";
import type { TutorCache, TutorInput, TutorModel, TutorOutput, WrapUpInput, WrapUpOutput } from "./review/tutor";
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
/** How long an upload may wait for the pump it triggers. Uploads arrive every 3 to 5 s per watcher, so a burst of them shares one pump. */
const INGEST_PUMP_MS = 100;

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
  /** Defaults to process.env. Read: AFTERCLASS_MODE, AFTERCLASS_CLAUDE_BACKEND, AFTERCLASS_DATA, AFTERCLASS_PORT, AFTERCLASS_HOST, AFTERCLASS_HEALTH_ANY_HOST, AFTERCLASS_BUILD_APP, AFTERCLASS_CONFIG_DIR, AFTERCLASS_EXTENSION_ID, AFTERCLASS_ELEVENLABS_VOICE_ID, AFTERCLASS_ELEVENLABS_MODEL, AFTERCLASS_TUTOR_MODEL, the budget settings AFTERCLASS_BUDGET_USER_USD, AFTERCLASS_BUDGET_TOTAL_USD, AFTERCLASS_BUDGET_UNCAPPED_USERS, AFTERCLASS_STOP_PAID_CALLS, and the sign-in settings AFTERCLASS_AUTH (also hosted or not, for the budget), AFTERCLASS_CLERK_ISSUER, AFTERCLASS_CLERK_JWKS_URL, AFTERCLASS_CLERK_PUBLISHABLE_KEY, AFTERCLASS_PUBLIC_ORIGIN. */
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
  /** How long an upload may wait for the pump it triggers. Default INGEST_PUMP_MS; a test widens it to see the order. */
  readonly ingestPumpMs?: number;
  /** How long an unanswered frame waits for its caption window. Default FRAME_HOLD_MS; a test shortens it. */
  readonly frameHoldMs?: number;
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
export type Keys = {
  readonly TYPESAFE_API_KEY?: string;
  readonly ELEVENLABS_API_KEY?: string;
  readonly AFTERCLASS_ANTHROPIC_API_KEY?: string;
  /** Not a secret, but the beta keeps it in Parameter Store out of the public repo, so it arrives the way the keys do. See `resolveUncappedUsers`. */
  readonly AFTERCLASS_BUDGET_UNCAPPED_USERS?: string;
};

const KEY_NAMES = ["TYPESAFE_API_KEY", "ELEVENLABS_API_KEY", "AFTERCLASS_ANTHROPIC_API_KEY", "AFTERCLASS_BUDGET_UNCAPPED_USERS"] as const;

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
const refusingAdapter: ClaudeCli = {
  structured: () => Promise.reject(refused("Claude")),
  streamText: () => Promise.reject(refused("Claude")),
};
const refusingClaude: ClaudeLanes = { preparation: refusingAdapter, interactive: refusingAdapter };

export type ClaudeBackend = "cli" | "api";

export function resolveClaudeBackend(requested: string | undefined): ClaudeBackend {
  if (requested === undefined || requested === "") return "cli";
  if (requested === "cli" || requested === "api") return requested;
  throw new Error(`AFTERCLASS_CLAUDE_BACKEND must be "cli" or "api", got "${requested}"`);
}

/**
 * Two Claude adapters, so each has its own concurrency limit. Preparation fills its lane for minutes at a time; a tutor turn, the wrap-up
 * or a diagram summary has a learner waiting and must never queue behind it. Both lanes still reserve every request in `admit()` (R17).
 */
export type ClaudeLanes = { readonly preparation: ClaudeCli; readonly interactive: ClaudeCli };

/** Requests the interactive lane runs at once. Hosted, one process serves every friend's tutor turns. */
export const INTERACTIVE_CLAUDE_LIMIT = 4;

export const claudeLanes = (adapter: (maxConcurrent: number) => ClaudeCli): ClaudeLanes => ({
  preparation: adapter(DEFAULT_LIMITS.claude),
  interactive: adapter(INTERACTIVE_CLAUDE_LIMIT),
});

export function buildTasks(jev: JevClient, claude: ClaudeLanes, frameBytes: FrameBytes, tutorCache: TutorCache, tutorModel: TutorModel = "opus"): TaskSet {
  return {
    boundary: productBoundaryTask(jev),
    frameChange: productFrameChangeTask(jev),
    preparation: {
      interpret: interpretTask(claude.preparation, frameBytes),
      revise: reviseTask(claude.preparation, frameBytes),
      checkClaim: claimSupportTask(jev),
      searchResources: resourceSearchTask(claude.preparation),
    },
    tutor: tutorTask(claude.interactive, tutorCache, tutorModel),
    wrapUp: wrapUpTask(claude.interactive, tutorModel),
    diagramSummary: diagramSummaryTask(claude.interactive, frameBytes),
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

/**
 * Derek, 2026-11-14: "yes build the admin account too". The Clerk user ids, comma separated, whose calls skip both caps (budget.ts).
 * Ids, not emails: Clerk's session token carries the id, and the repo is public, so no id is in it. Spaces around an id and empty
 * entries are dropped, so an empty or unset setting lists nobody. An id with a space inside is a typo, so boot refuses it.
 */
export function resolveUncappedUsers(text: string | undefined): readonly string[] {
  const ids = (text ?? "").split(",").map((id) => id.trim()).filter((id) => id !== "");
  // The ids are private, so the error names the entry's position, never its value.
  const bad = ids.findIndex((id) => /\s/.test(id));
  if (bad !== -1) throw new Error(`AFTERCLASS_BUDGET_UNCAPPED_USERS lists Clerk user ids separated by commas, and entry ${bad + 1} has a space inside`);
  return [...new Set(ids)];
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

/** Hosted traffic uses HTTPS. Local development and fake identity services can use loopback HTTP. */
function httpsOrLoopback(text: string): boolean {
  try {
    const u = new URL(text);
    return u.protocol === "https:" || (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname));
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
  if (!httpsOrLoopback(publicOrigin)) throw new Error("AFTERCLASS_PUBLIC_ORIGIN requires HTTPS except on loopback");
  const jwksUrl = env.AFTERCLASS_CLERK_JWKS_URL!;
  if (!httpsOrLoopback(jwksUrl)) throw new Error(`AFTERCLASS_CLERK_JWKS_URL must be an https URL, got "${jwksUrl}"`);
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
  readonly diagrams: Diagrams;
  readonly voice: Voice;
  /**
   * The captures that can have demand. All of them at boot. A capture leaves when a pump finds no demand in it, and comes
   * back when ingest, retry or stop early touches it, or when anything its derivation read changes (`asleep`), so a pump
   * derives only what can have work.
   */
  readonly live: Set<CaptureId>;
  /** The captures that left `live`, each with the keys its last derivation read (`Dep`). A change to one of those keys wakes it. */
  readonly asleep: Map<CaptureId, ReadonlySet<Dep>>;
  /** Takes a capture out of `live` and files it under each key it read, so a change finds its sleepers without scanning them all. */
  readonly sleep: (captureId: CaptureId, keys: ReadonlySet<Dep>) => void;
  /** Runs `fn` and returns the keys its stores reported reading. */
  readonly reading: <T>(fn: () => T) => { readonly value: T; readonly keys: ReadonlySet<Dep> };
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
  const uncappedUsers = resolveUncappedUsers(keys.AFTERCLASS_BUDGET_UNCAPPED_USERS ?? env.AFTERCLASS_BUDGET_UNCAPPED_USERS);
  const ingestLimits = resolveIngestLimits(env, resolve(env.AFTERCLASS_DATA ?? "data"));
  const tutorModel = resolveTutorModel(env);
  const paidCallsStopped = stopSwitch(env, configDir);
  // Hosted mode has no pairing token: sign-in replaces it.
  const token = auth.kind === "local" ? loadPairingToken(join(configDir, "pairing-token")) : "";
  const port = options.port ?? parsePort(env.AFTERCLASS_PORT) ?? DEFAULT_PORT;
  // One id or a comma-separated list, first id primary. A malformed id stops startup.
  const extensionId = parseExtensionIds(env.AFTERCLASS_EXTENSION_ID).join(",");

  const dataDir = resolve(env.AFTERCLASS_DATA ?? "data");
  mkdirSync(dataDir, { recursive: true });
  const rawDb = openDb(join(dataDir, "afterclass.sqlite"));

  const liveClaude = (): ClaudeLanes => {
    if (claudeBackend === "api") {
      log("claude backend: api for every Claude task (paid, priced from usage); no claude binary is used");
      return claudeLanes((maxConcurrent) => createClaudeApi({ apiKey: anthropicKey!, maxConcurrent, ...(options.anthropic ? { client: options.anthropic } : {}) }));
    }
    const claudeCwd = join(dataDir, "claude-cwd");
    mkdirSync(claudeCwd, { recursive: true });
    // No provider key may reach the child: claude -p bills the subscription login, and the Jev, voice and Messages API keys are not its business.
    const { TYPESAFE_API_KEY: _jevKey, ELEVENLABS_API_KEY: _voiceKey, AFTERCLASS_ANTHROPIC_API_KEY: _messagesKey, ...childEnv } = env;
    return claudeLanes((maxConcurrent) => createClaudeCli({ bin: options.claudeBin ?? "claude", cwd: claudeCwd, maxConcurrent, env: childEnv, estimate: cliStreamEstimateUsd, ...(options.spawn ? { spawn: options.spawn } : {}) }));
  };
  // One client per provider for the whole process, so their concurrency limits hold across users.
  const providers: { readonly jev: JevClient; readonly claude: ClaudeLanes } =
    mode === "live" && !options.tasks
      ? { jev: createJevClient({ apiKey: apiKey!, ...(options.fetch ? { fetch: options.fetch } : {}) }), claude: liveClaude() }
      : { jev: refusingJev, claude: refusingClaude };

  // Injected tasks make no live call, so the memo may run them. Without them, replay never runs a task at all.
  const memoMode: MemoMode = mode === "replay" && !options.tasks ? "replay" : "live";
  // One budget for every user, on the raw db: the total cap sums all of them. Each user's memo reserves as its own user.
  const budget = mode === "live" ? createBudget(rawDb, { limits: budgetLimits, uncappedSubjects: uncappedUsers, stopped: paidCallsStopped }) : null;
  // Before any request: what a previous process left unsettled gets its usage event (R17) and counts at its price, or its reservation when unpriced.
  const interrupted = budget?.reconcileInterrupted() ?? 0;

  let alive = true;
  let scheduler: Scheduler | null = null;
  const runPump = () => {
    if (!alive) return;
    try {
      scheduler?.pump();
    } catch (e) {
      reportOnce("pump", e);
    }
  };
  /** After the current synchronous work, so a pump never runs inside the transaction that wrote the fact. */
  const pump = () => queueMicrotask(runPump);
  /**
   * What an upload triggers: a burst of facts shares one pump, run after the replies went out. A job that an upload stops
   * demanding is aborted up to INGEST_PUMP_MS later than a microtask pump would, and its result still applies only through
   * `appliesBefore`. Stop early and retry pump at once.
   */
  let ingestPump: ReturnType<typeof setTimeout> | null = null;
  const pumpSoon = () => {
    if (ingestPump !== null || !alive) return;
    ingestPump = setTimeout(() => {
      ingestPump = null;
      runPump();
    }, options.ingestPumpMs ?? INGEST_PUMP_MS);
    ingestPump.unref?.();
  };
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
    const tasks: TaskSet = options.tasks ?? buildTasks(providers.jev, providers.claude, frameBytes, tutorCache(db), tutorModel);
    const live = new Set<CaptureId>();
    const asleep = new Map<CaptureId, ReadonlySet<Dep>>();
    const sleepersOf = new Map<Dep, Set<CaptureId>>();
    const unfile = (captureId: CaptureId) => {
      const keys = asleep.get(captureId);
      if (keys === undefined) return;
      asleep.delete(captureId);
      for (const k of keys) {
        const sleepers = sleepersOf.get(k);
        sleepers?.delete(captureId);
        if (sleepers?.size === 0) sleepersOf.delete(k);
      }
    };
    const wake = (captureId: CaptureId) => {
      unfile(captureId);
      live.add(captureId);
    };
    const sleep = (captureId: CaptureId, keys: ReadonlySet<Dep>) => {
      unfile(captureId);
      live.delete(captureId);
      asleep.set(captureId, keys);
      for (const k of keys) {
        let sleepers = sleepersOf.get(k);
        if (!sleepers) sleepersOf.set(k, (sleepers = new Set()));
        sleepers.add(captureId);
      }
    };
    /**
     * A capture that sleeps keeps the keys its last derivation read, and every store reports a read where it makes one and
     * a write by the keys it changed. A write wakes the sleepers that read one of its keys, so a capture wakes whenever
     * any input its demand reads changes, whichever capture or job changed it, and no list of such inputs sits here.
     * Waking every capture of the user instead would derive every lecture on each job result and each upload.
     */
    const changed = (keys: readonly Dep[]): boolean => {
      const hit = new Set<CaptureId>();
      for (const k of keys) for (const captureId of sleepersOf.get(k) ?? []) hit.add(captureId);
      for (const captureId of hit) wake(captureId);
      return hit.size > 0;
    };
    let readDeps: Set<Dep> | null = null;
    const read: ReadDep = (dep) => {
      readDeps?.add(dep);
    };
    const reading = <T>(fn: () => T) => {
      const outer = readDeps;
      const keys = new Set<Dep>();
      readDeps = keys;
      try {
        return { value: fn(), keys };
      } finally {
        readDeps = outer;
      }
    };
    const memo = createMemo(db, memoMode, {
      ...(budget === null ? {} : { budget }),
      onChange(keys) {
        if (changed(keys.map(memoDep))) pumpSoon();
      },
    });
    const ledger = createLedger(db, budget);
    /** Per capture, the one timer for the earliest pump a waiting frame asked for, on the monotonic clock. */
    const wakes = new Map<CaptureId, { readonly at: number; readonly timer: ReturnType<typeof setTimeout> }>();
    const lookup: LookupFn = (task, input) => {
      const looked = memo.lookup(task, input);
      read(memoDep(looked.key));
      return looked;
    };
    const evidence: EvidenceStoreWithProbe = createEvidence(db, dataDir, {
      lookupFrameChange: (input) => lookup(tasks.frameChange, input),
      // The first frame of a source has nothing to compare with: evidence keeps it without a call, and so does this.
      runFrameChange: (input, signal) => (input.before === null ? Promise.resolve(null) : memo.run(tasks.frameChange, input, { signal })),
      frameChangeKey: (input) => memo.key(tasks.frameChange, input),
      read,
      limits: ingestLimits,
      ...(options.frameHoldMs === undefined ? {} : { frameHoldMs: options.frameHoldMs }),
      wakeIn(captureId, delayMs) {
        const at = performance.now() + delayMs;
        const set = wakes.get(captureId);
        if (set !== undefined && set.at <= at) return;
        if (set !== undefined) clearTimeout(set.timer);
        const timer = setTimeout(() => {
          wakes.delete(captureId);
          if (!alive) return;
          wake(captureId);
          pump();
        }, delayMs);
        timer.unref?.();
        wakes.set(captureId, { at, timer });
      },
      onChange(captureId, keys) {
        // A capture's first upload is the only way a capture enters the working set after boot.
        if (captureId !== null) wake(captureId);
        changed(keys);
        if (captureId === null) pump();
        else pumpSoon();
      },
    });
    for (const id of evidence.captures()) live.add(id);

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
        lookupBoundary: (input) => lookup(tasks.boundary, input),
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
      pin: evidence.pin,
      lookup,
      run: (task, input, signal) => memo.run(task, input, { signal }),
      clearFailures: memo.clearFailures,
      tasks: tasks.preparation,
      frameBytes: evidence.frameBytes,
      read,
      changed: (keys) => {
        if (changed(keys)) pumpSoon();
      },
    });
    // Stop early is a fact that cancels work by derivation; the pump is what aborts what is already running.
    const preparation: Preparation = { ...preparationBase, stopEarly: (captureId, ids) => {
      const seq = preparationBase.stopEarly(captureId, ids);
      wake(captureId);
      pump();
      return seq;
    }, retry: (captureId, ids) => {
      const seq = preparationBase.retry(captureId, ids);
      wake(captureId);
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
      runTutor: (input, streamTo, signal, onRetry) => memo.run(tasks.tutor, input, { signal, streamTo, onRetry, review: input.state.reviewId }),
      clearFailures: memo.clearFailures,
      startWrapUp(reviewId) {
        // Later, so reading the whole review to build the input never sits in front of the tutor's reply. The save reports a failure.
        setTimeout(() => void runWrapUp(reviewId).catch(() => {}), 0);
      },
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

    /**
     * The summary call. The review's end starts it while the tutor's closing line streams (#234), and the save that follows joins it
     * through the memo, which keys both on the same input (`wrapUpInput`). A failure stored before this run began, from the early call or
     * an earlier save, is cleared and asked once more; one stored while this run waited, which it joined, is returned as is. That needs
     * no state beyond the memo, so it holds across a restart. #251's six requests per review still bound the calls past a cap.
     * A hit is never cleared.
     */
    async function runWrapUp(reviewId: ReviewId): Promise<WrapUpOutput> {
      const asOf = db.nextSeq();
      const input = wrapUpInput(reviews.view(reviewId).turns, usableNow(reviewId));
      const run = { review: reviewId };
      let result = await memo.run(tasks.wrapUp, input, run);
      if (result.kind === "failed" && result.atSeq < asOf) {
        memo.clearFailures([result.key]);
        result = await memo.run(tasks.wrapUp, input, run);
      }
      if (result.kind === "hit") return result.value;
      throw new Error(result.kind === "failed" ? `wrap-up failed: ${result.lastError}` : result.kind === "held" ? heldMessage(result.hold) : `wrap-up ${result.kind}`);
    }

    const record = createRecord(db, {
      turns: (reviewId) => reviews.view(reviewId).turns,
      claims: usableNow,
      wrapUp: runWrapUp,
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

    const voice: Voice =
      voiceKey === undefined
        ? unavailableVoice
        : createVoice({ apiKey: voiceKey, voiceId, model: voiceModel, db, ...(options.fetch ? { fetch: options.fetch } : {}) });

    return { tasks, evidence, segmentation, preparation, reviews, record, ledger, memo, diagrams, voice, live, asleep, sleep, reading, db };
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

  /** Per capture, the three derivations that can ask for work. A failing one is reported and leaves the others running. */
  const DEMAND: readonly (readonly [string, (graph: UserGraph, captureId: CaptureId) => readonly WorkItem[]])[] = [
    ["segmentation", ({ segmentation, memo, tasks }, captureId) =>
      segmentation.sync(captureId).demand.map((input): WorkItem => ({
        key: memo.key(tasks.boundary, input),
        purpose: "boundary",
        provider: "jev",
        run: (signal) => memo.run(tasks.boundary, input, { signal, captureId }),
      }))],
    ["frame demand", ({ evidence }, captureId) => evidence.frameDemand(captureId)],
    ["preparation", ({ preparation }, captureId) => preparation.demand(captureId)],
  ];

  /**
   * Every user's demand over the captures that can have any, each item keyed by its user as well: memo keys hash the call
   * alone, so two users' identical calls share a key, and the scheduler would otherwise treat one user's run as the other's.
   * A capture with no demand leaves its user's live set. Its running jobs are not demanded either, so this same pump aborts them (R8).
   */
  const demand = (): readonly WorkItem[] =>
    [...graphs.values()].flatMap((graph) =>
      [...graph.live].flatMap((captureId) => {
        let failed = false;
        const { value: items, keys } = graph.reading(() =>
          DEMAND.flatMap(([where, derive]) => {
            try {
              return derive(graph, captureId).map((item) => ({ ...item, key: stableId("key", graph.db.userId, item.key) }));
            } catch (e) {
              failed = true;
              reportOnce(`${where} ${captureId}`, e);
              return [];
            }
          }),
        );
        if (items.length === 0 && !failed) {
          graph.sleep(captureId, keys);
        }
        return items;
      }),
    );

  scheduler = createScheduler(
    [demand],
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
    ledger: g.ledger, evidence: g.evidence, reviews: g.reviews, record: g.record, preparation: g.preparation, segmentation: g.segmentation, voice: g.voice, diagrams: g.diagrams,
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
          clerk: { scriptUrl: clerkScriptUrl(auth.frontendApi), uiScriptUrl: clerkUiScriptUrl(auth.frontendApi), publishableKey: auth.publishableKey },
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
  if (budget !== null) log(`budget per month (UTC): ${cap(budgetLimits.userUsd)} per user, ${cap(budgetLimits.totalUsd)} in total${uncappedUsers.length === 0 ? "" : `, ${uncappedUsers.length} uncapped account${uncappedUsers.length === 1 ? "" : "s"}`}; stop switch: ${join(configDir, STOP_FILE)}${paidCallsStopped() ? " (on)" : ""}`);
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

  // The free-space reading that the beta alarm watches (infra/beta/disk-alarm.tf).
  const stopDiskWatch = startDiskWatch({ read: readVolume(dataDir), minFreeBytes: ingestLimits.minFreeBytes, log, logError });

  pump();

  return {
    mode,
    port: boundPort,
    token,
    graphs: { get: graphFor },
    scheduler,
    async stop() {
      alive = false;
      stopDiskWatch();
      if (ingestPump !== null) clearTimeout(ingestPump);
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
