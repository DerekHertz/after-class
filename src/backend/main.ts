/**
 * Composition root (M6). The only file that knows every module.
 *
 *   keys     ~/.config/afterclass/keys.env, mode 0600 or the backend refuses to start. Only this file reads it; the
 *            value of TYPESAFE_API_KEY goes to the Jev client and nowhere else (not a log line, not a response, not a child env).
 *            ELEVENLABS_API_KEY (optional) goes to the ElevenLabs voice and nowhere else, the same way.
 *            AFTERCLASS_ANTHROPIC_API_KEY (optional) goes to the Claude Messages API adapter and nowhere else, the same way. It is
 *            read only when AFTERCLASS_CLAUDE_BACKEND=api, and it never reaches the `claude` child.
 *   claude   AFTERCLASS_CLAUDE_BACKEND=cli | api. Default cli: every Claude task runs through `claude -p` on the subscription.
 *            api: ONLY the tutor turn and the wrap-up call the Messages API (paid, priced from usage); every other Claude task
 *            keeps the CLI. api with no key refuses to start. Replay mode builds no Claude adapter, so the setting does nothing there.
 *   voice    Tutor speech from ElevenLabs through POST /voice/speech, live mode with a key only; otherwise GET /voice says
 *            unavailable and the app speaks with Chrome's voice. AFTERCLASS_ELEVENLABS_VOICE_ID, AFTERCLASS_ELEVENLABS_MODEL.
 *   token    ~/.config/afterclass/pairing-token (0600), created on first boot, printed with "listening on 127.0.0.1:<port>".
 *   data     $AFTERCLASS_DATA (default ./data): afterclass.sqlite, frames/
 *   mode     AFTERCLASS_MODE=live | replay. Unset: live when a keys file exists, replay otherwise.
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
import type { CaptureId, EvidenceId } from "../shared/ids";
import type { AssessableClaim, BoundaryJudgment, BoundaryWindow, Evidence, Frame, Passage, Verdict } from "../shared/domain";
import { openDb } from "./db";
import type { Db } from "./db";
import { createMemo, ProviderError } from "./providers/memo";
import type { Memo, MemoMode, Task } from "./providers/memo";
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
import type { TutorInput, TutorOutput, WrapUpInput, WrapUpOutput } from "./review/tutor";
import { createDiagrams } from "./diagram";
import type { Diagrams, DiagramSummaryInput, DiagramSummaryOutput } from "./diagram";
import { diagramSummaryTask } from "./diagram/tasks";
import { createRecord } from "./record";
import type { LearningRecord } from "./record";
import { DEFAULT_LIMITS, createScheduler } from "./scheduler";
import type { Scheduler, WorkItem } from "./scheduler";
import { DEFAULT_PORT, serve } from "./http";
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
  /** Defaults to process.env. Read: AFTERCLASS_MODE, AFTERCLASS_CLAUDE_BACKEND, AFTERCLASS_DATA, AFTERCLASS_PORT, AFTERCLASS_EXTENSION_ID, AFTERCLASS_ELEVENLABS_VOICE_ID, AFTERCLASS_ELEVENLABS_MODEL. */
  readonly env?: Env;
  /** Holds keys.env and pairing-token. Defaults to ~/.config/afterclass. */
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
  readonly db: Db;
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

/** `tutorClaude` backs the tutor turn and the wrap-up only. It is the same adapter as `claude` unless the api backend is chosen. */
export function buildTasks(jev: JevClient, claude: ClaudeCli, frameBytes: FrameBytes, tutorClaude: ClaudeCli = claude): TaskSet {
  return {
    boundary: productBoundaryTask(jev),
    frameChange: productFrameChangeTask(jev),
    preparation: {
      interpret: interpretTask(claude, frameBytes),
      revise: reviseTask(claude, frameBytes),
      checkClaim: claimSupportTask(jev),
      searchResources: resourceSearchTask(claude),
    },
    tutor: tutorTask(tutorClaude),
    wrapUp: wrapUpTask(tutorClaude),
    diagramSummary: diagramSummaryTask(claude, frameBytes),
  };
}

const parsePort = (text: string | undefined): number | null => {
  if (text === undefined || text === "") return null;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`AFTERCLASS_PORT must be an integer from 0 to 65535, got "${text}"`);
  return n;
};

// ───────────────────────────── composition ─────────────────────────────

export async function main(options: MainOptions = {}): Promise<Running> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((text: string) => console.log(text));
  const logError = options.error ?? ((text: string) => console.error(text));

  const configDir = options.configDir ?? join(homedir(), ".config", "afterclass");
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
  if (keys.ELEVENLABS_API_KEY !== undefined) checkVoiceSettings(voiceId, voiceModel);
  if (mode === "live" && apiKey === undefined) throw new Error(`${keysPath} has no TYPESAFE_API_KEY; refusing to start`);
  const claudeBackend = resolveClaudeBackend(env.AFTERCLASS_CLAUDE_BACKEND);
  const anthropicKey = keys.AFTERCLASS_ANTHROPIC_API_KEY;
  if (mode === "live" && claudeBackend === "api" && anthropicKey === undefined) {
    throw new Error(`AFTERCLASS_CLAUDE_BACKEND=api needs AFTERCLASS_ANTHROPIC_API_KEY in ${keysPath}; refusing to start`);
  }
  const token = loadPairingToken(join(configDir, "pairing-token"));
  const port = options.port ?? parsePort(env.AFTERCLASS_PORT) ?? DEFAULT_PORT;
  const extensionId = env.AFTERCLASS_EXTENSION_ID ?? "";

  const dataDir = resolve(env.AFTERCLASS_DATA ?? "data");
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(join(dataDir, "afterclass.sqlite"));

  // evidence is created after the tasks that need its bytes; the tasks only read it when a call runs
  const frameBytes: FrameBytes = (id) => evidence.frameBytes(id);
  const liveTasks = (): TaskSet => {
    const claudeCwd = join(dataDir, "claude-cwd");
    mkdirSync(claudeCwd, { recursive: true });
    // No provider key may reach the child: claude -p bills the subscription login, and the Jev, voice and Messages API keys are not its business.
    const { TYPESAFE_API_KEY: _jevKey, ELEVENLABS_API_KEY: _voiceKey, AFTERCLASS_ANTHROPIC_API_KEY: _messagesKey, ...childEnv } = env;
    const cli = createClaudeCli({ bin: options.claudeBin ?? "claude", cwd: claudeCwd, maxConcurrent: DEFAULT_LIMITS.claude, env: childEnv, ...(options.spawn ? { spawn: options.spawn } : {}) });
    // Only the tutor turn and the wrap-up take the API backend. Every other task keeps the CLI.
    const messagesApi = claudeBackend === "api"
      ? createClaudeApi({ apiKey: anthropicKey!, maxConcurrent: DEFAULT_LIMITS.claude, ...(options.anthropic ? { client: options.anthropic } : {}) })
      : cli;
    if (claudeBackend === "api") log("claude backend: api for the tutor turn and the wrap-up (paid, priced from usage); every other Claude task uses the CLI");
    return buildTasks(createJevClient({ apiKey: apiKey!, ...(options.fetch ? { fetch: options.fetch } : {}) }), cli, frameBytes, messagesApi);
  };
  const tasks: TaskSet = options.tasks ?? (mode === "live" ? liveTasks() : buildTasks(refusingJev, refusingClaude, frameBytes));

  // Injected tasks make no live call, so the memo may run them. Without them, replay never runs a task at all.
  const memoMode: MemoMode = mode === "replay" && !options.tasks ? "replay" : "live";
  const memo = createMemo(db, memoMode);
  const ledger = createLedger(db);

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
      throw new Error(result.kind === "failed" ? `wrap-up failed: ${result.lastError}` : `wrap-up ${result.kind}`);
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

  // Every capture that may still have work: those on disk now, plus any ingested since. A stopped capture keeps preparing.
  const captures = new Set<CaptureId>(db.sql.query<{ capture_id: string }, []>("SELECT DISTINCT capture_id FROM capture_facts").all().map((r) => r.capture_id as CaptureId));

  const perCapture = (where: string, items: (captureId: CaptureId) => readonly WorkItem[]) => (): readonly WorkItem[] =>
    [...captures].flatMap((captureId) => {
      try {
        return items(captureId);
      } catch (e) {
        reportOnce(`${where} ${captureId}`, e);
        return [];
      }
    });

  scheduler = createScheduler(
    [
      perCapture("segmentation", (captureId) =>
        segmentation.sync(captureId).demand.map((input): WorkItem => ({
          key: memo.key(tasks.boundary, input),
          purpose: "boundary",
          provider: "jev",
          run: (signal) => memo.run(tasks.boundary, input, { signal }),
        })),
      ),
      perCapture("frame demand", evidence.frameDemand),
      perCapture("preparation", preparation.demand),
    ],
    DEFAULT_LIMITS,
    {
      sweep: { run: () => void evidence.sweepExpired(Date.now(), RETENTION_DAYS) },
      onError: reportOnce,
    },
  );

  // The scheduler is the only holder of these; http gets the same store with ingest registering the capture first.
  const served: EvidenceStoreWithProbe = {
    ...evidence,
    ingest(batch) {
      captures.add(batch.captureId);
      return evidence.ingest(batch);
    },
  };

  const appDir = resolve(options.appDir ?? join(ROOT, "dist", "app"));
  if (options.buildApp !== false) {
    try {
      await buildApp(appDir);
    } catch (e) {
      logError(`backend: the review app was not built, so /app/ answers 503: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const voice: Voice =
    keys.ELEVENLABS_API_KEY === undefined
      ? unavailableVoice
      : createVoice({ apiKey: keys.ELEVENLABS_API_KEY, voiceId, model: voiceModel, db, ...(options.fetch ? { fetch: options.fetch } : {}) });

  const server = serve({ modules: { ledger, evidence: served, reviews, record, preparation, segmentation, voice, diagrams }, auth: { port, extensionId, token }, appDir });
  const boundPort = server.port as number;

  if (extensionId === "") logError("backend: AFTERCLASS_EXTENSION_ID is not set, so the extension's requests are refused (403) until it is");
  log(
    mode === "live"
      ? "mode: live (Jev with the key from keys.env; Claude through claude -p on your login)"
      : `mode: replay (${keysFile ? "AFTERCLASS_MODE=replay" : "no keys file"}: Jev unavailable, Claude unavailable, every live call is refused)`,
  );
  log(voice.available ? `voice: ElevenLabs (model ${voice.model}, voice ${voice.voiceId})` : "voice: unavailable (no ELEVENLABS_API_KEY in keys.env, or replay mode); the app speaks with Chrome's voice");
  log(`listening on 127.0.0.1:${boundPort}\npairing token: ${token}`);

  pump();

  return {
    mode,
    port: boundPort,
    token,
    modules: { evidence, segmentation, preparation, reviews, record, ledger, memo, scheduler, db },
    async stop() {
      alive = false;
      await scheduler?.stop();
      await server.stop(true);
      db.close();
    },
  };
}

if (import.meta.main) {
  const running = await main();
  const shutdown = () => void running.stop().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
