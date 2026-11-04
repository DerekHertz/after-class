/**
 * M10: the whole product, end to end, on REPLAY DATA. `main` boots in replay mode on a temp dir with port 0 and a scratch
 * config dir; the model tasks are the real task objects (real keys, versions, decoders) whose `attempt` is a scripted
 * fake with a fake price. No Jev or Claude call is made: the providers the tasks were built over are spies that fail
 * the test if touched, and fetch, Bun.spawn and sockets are trapped for the whole file.
 *
 * Everything below drives the backend over HTTP only, with the headers the extension (chrome-extension origin) and the
 * review app (its own origin) would send. The sqlite file is read, never written, to count rows.
 *
 * Retro 1, classes 1 and 4 (retries and stale ids): the script is run, then the same recorded requests are sent once
 * more against a fresh copy of the data dir. No table may gain a row, no task may run again, the record must not change.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import net from "node:net";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaimDraft, Cost, Observation, RecordView, TutorMove, TutorMoveKind } from "../src/shared/domain";
import type { CaptureId, EvidenceId, ReviewId, TurnId } from "../src/shared/ids";
import { stableId } from "../src/shared/ids";
import {
  captureResponse, encodeMaterial, evidenceBundleResponse, ingestAckResponse, recordViewResponse, reviewOptionsResponse, reviewViewResponse, saveResponse,
  startReviewResponse, tutorStreamEvent, usageResponse,
} from "../src/shared/wire";
import type { TutorStreamEvent } from "../src/shared/wire";
import { main } from "../src/backend/main";
import type { Running, TaskSet } from "../src/backend/main";
import type { AttemptContext, Task, UsageReport } from "../src/backend/providers/memo";
import { boundaryTask, claimSupportTask, frameChangeTask } from "../src/backend/providers/jev-tasks";
import type { JevClient } from "../src/backend/providers/jev";
import type { ClaudeCli } from "../src/backend/providers/claude";
import { interpretTask, resourceSearchTask, reviseTask } from "../src/backend/preparation/tasks";
import { nextThreadId, tutorTask, wrapUpTask } from "../src/backend/review/tutor";
import type { TutorInput } from "../src/backend/review/tutor";
import { isLearningGap } from "../src/backend/review/clamp";

const CAP = stableId("cap", "e2e-replay") as CaptureId;
const REVIEW = stableId("rvw", "e2e-replay") as ReviewId;
const turnId = (n: number) => stableId("turn", "e2e-replay", n) as TurnId;
const VIDEO = "dQw4w9WgXcQ";
const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const realFetch = globalThis.fetch;

// ───────────────────────────── no live call, anywhere ─────────────────────────────

/** Everything that would reach a model or the network. The test fails if this is not empty at the end. */
const live: string[] = [];
const saved = { spawn: Bun.spawn, spawnSync: Bun.spawnSync, connect: Bun.connect, socketConnect: net.Socket.prototype.connect, path: process.env.PATH };
const scratch: string[] = [];
const running: Running[] = [];
let claudeMarker = "";

beforeAll(() => {
  const trap = (name: string) => () => {
    live.push(name);
    throw new Error(`${name} must not be called in a replay-data test`);
  };
  const shim = mkdtempSync(join(tmpdir(), "afterclass-e2e-bin-"));
  scratch.push(shim);
  claudeMarker = join(shim, "claude-ran");
  writeFileSync(join(shim, "claude"), `#!/bin/sh\ntouch ${claudeMarker}\nexit 1\n`, { mode: 0o755 });
  process.env.PATH = `${shim}:${process.env.PATH}`;
  globalThis.fetch = trap("fetch") as unknown as typeof fetch;
  (Bun as { spawn: unknown }).spawn = trap("Bun.spawn");
  (Bun as { spawnSync: unknown }).spawnSync = trap("Bun.spawnSync");
  (Bun as { connect: unknown }).connect = trap("Bun.connect");
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    live.push("net.Socket.connect");
    return (saved.socketConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  (Bun as { spawn: unknown }).spawn = saved.spawn;
  (Bun as { spawnSync: unknown }).spawnSync = saved.spawnSync;
  (Bun as { connect: unknown }).connect = saved.connect;
  net.Socket.prototype.connect = saved.socketConnect;
  process.env.PATH = saved.path;
  for (const r of running.splice(0)) await r.stop();
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const dir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
};

// ───────────────────────────── fake tasks: real task objects, scripted attempts, fake prices ─────────────────────────────

/** Providers the real tasks are built over. Any call is a live call. */
const spyJev: JevClient = { ask: () => (live.push("jev.ask"), Promise.reject(new Error("live Jev call"))) };
const spyClaude: ClaudeCli = {
  structured: () => (live.push("claude.structured"), Promise.reject(new Error("live Claude call"))),
  streamText: () => (live.push("claude.streamText"), Promise.reject(new Error("live Claude call"))),
};

const price = (cost: Cost, model: string): UsageReport => ({ model, inputTokens: 100, outputTokens: 5, cacheReadTokens: null, cost });
const FAKE_JEV = price({ kind: "measured", usd: 0.001 }, "fake-jev (replay data)");
const FAKE_TUTOR = price({ kind: "notional", usd: 0.04, basis: "claude_subscription" }, "fake-claude (replay data)");
const FAKE_UNKNOWN = price({ kind: "unknown", reason: "replay data: the fake reports no cost" }, "fake-claude (replay data)");

type Faked<I, O> = Task<I, O> & { readonly calls: I[] };

function faked<I, O>(real: Task<I, O>, answer: (input: I, ctx: AttemptContext) => { output: O; usage: UsageReport }): Faked<I, O> {
  const calls: I[] = [];
  return {
    ...real,
    calls,
    async attempt(input, ctx) {
      calls.push(input);
      return answer(input, ctx);
    },
  };
}

const ids = <T extends { id: EvidenceId }>(xs: readonly T[]) => xs.map((x) => x.id);

function fakeTasks() {
  const unexpected: string[] = [];

  // Window 1 (30 to 60 s) is a boundary: it closes chunk 0 and so raises the review invite. Every other window continues.
  const boundary = faked(boundaryTask(spyJev), (i) => ({
    output: {
      windowId: i.window.id, newConcept: i.window.ordinal === 1 ? "yes" : "no", stoppingPoint: i.window.ordinal === 1 ? "yes" : "no",
      pNewConcept: 0.5, pStoppingPoint: 0.5, questionVersion: "fake",
    } as const,
    usage: FAKE_JEV,
  }));
  const frameChange = faked(frameChangeTask(spyJev), () => ({ output: "yes" as const, usage: FAKE_JEV }));
  const checkClaim = faked(claimSupportTask(spyJev), () => ({ output: { verdict: "yes" as const, p: 0.9 }, usage: FAKE_JEV }));

  const interpret = faked(interpretTask(spyClaude, () => null), (i) => {
    const ps = i.newMaterial.passages;
    const at = (s: number) => ps.find((p) => p.interval.start === s)!.id;
    const draft = (text: string, evidence: [EvidenceId], visualDependent = false): ClaimDraft => ({ text, evidence, visualDependent, assumptions: [] });
    if (ps.some((p) => p.interval.start === 0)) {
      return {
        output: { concepts: [{ label: "Alpha", summary: "How the lecture opens", claims: [draft("Alpha: the lecture opens by naming its topic.", [at(10)])], confusions: [] }], links: [], supersedes: [] },
        usage: FAKE_UNKNOWN,
      };
    }
    const slide = i.newMaterial.frames.find((f) => f.mediaS === 50)!;
    return {
      output: {
        concepts: [
          { label: "Beta", summary: "What the slide shows", claims: [draft("Beta: the slide at fifty seconds shows the main diagram.", [slide.id], true)], confusions: [] },
          { label: "Gamma", summary: "How the lecture ends", claims: [draft("Gamma: the lecture closes by restating the topic.", [at(80)])], confusions: [] },
        ],
        links: [{ fromLabel: "Beta", toLabel: "Gamma", type: "prerequisite_of" as const, evidence: [at(60)], rationale: "The diagram comes before the closing restatement." }],
        supersedes: [],
      },
      usage: FAKE_UNKNOWN,
    };
  });
  const revise = faked(reviseTask(spyClaude, () => null), () => (unexpected.push("revise"), { output: undefined as never, usage: FAKE_UNKNOWN }));
  const searchResources = faked(resourceSearchTask(spyClaude), () => ({ output: [], usage: FAKE_UNKNOWN }));

  // The tutor. Code has already decided which moves are allowed; this picks one, as a scripted Claude would.
  const tutor = faked(tutorTask(spyClaude), (input, ctx) => {
    const { move, say } = tutorReply(input);
    const header = JSON.stringify(move);
    ctx.streamTo?.(`${header.slice(0, 20)}`);
    ctx.streamTo?.(`${header.slice(20)}\n`);
    ctx.streamTo?.(say);
    return { output: { move, say }, usage: FAKE_TUTOR };
  });
  const wrapUp = faked(wrapUpTask(spyClaude), (input) => {
    const label = (conceptId: string) => input.claims.find((c) => c.conceptId === conceptId)!.text.split(":")[0]!;
    const concepts = [...new Set(input.claims.map((c) => c.conceptId))];
    return {
      // The scripted wrap-up is generous on purpose: it proposes "independent" or "partial" everywhere, so the clamps are what the test sees.
      output: {
        observations: input.threads.map((threadId, n) => ({ threadId, proposed: n === 2 ? ("partial" as const) : ("independent" as const), rationale: "scripted replay data" })),
        notes: concepts.map((conceptId) => ({
          conceptId,
          tutorSummary: `Replay-data summary of ${label(conceptId)}.`,
          evidence: input.claims.filter((c) => c.conceptId === conceptId).flatMap((c) => [...c.evidence]),
        })),
      },
      usage: FAKE_UNKNOWN,
    };
  });

  const tasks: TaskSet = { boundary, frameChange, preparation: { interpret, revise, checkClaim, searchResources }, tutor, wrapUp };
  const all = { boundary, frameChange, interpret, revise, checkClaim, searchResources, tutor, wrapUp };
  const callCounts = () => Object.fromEntries(Object.entries(all).map(([k, t]) => [k, t.calls.length]));
  return { tasks, callCounts, unexpected, all };
}

const QUESTIONS = ["Alpha", "Beta", "Gamma"] as const;

function tutorReply(input: TutorInput): { move: TutorMove; say: string } {
  const { state } = input;
  const act = state.lastLearnerAct?.act.kind;
  const allows = (k: TutorMoveKind) => input.allowed.includes(k);
  const thread = state.openThread!;
  const followedUp = input.turns.some((t) => t.actor === "tutor" && t.move.kind === "ask_followup" && t.move.threadId === thread);

  if (allows("hint") && act === "hint_request") return { move: { kind: "hint", threadId: thread }, say: "Here is a hint. Think about how the lecture opened." };
  if (allows("answer_dispute")) {
    const cited = input.evidence.passages[0]!.id;
    return { move: { kind: "answer_dispute", threadId: state.openDispute!, evidence: [cited], settled: false }, say: "I rechecked that passage. It does not settle this. What do you make of it?" };
  }
  if (allows("wrap_up")) return { move: { kind: "wrap_up" }, say: "That is the end of this review." };
  if (allows("ask_main")) {
    const claim = input.claims.find((c) => c.text.startsWith(QUESTIONS[state.mainQuestions]!))!;
    return { move: { kind: "ask_main", threadId: nextThreadId(state), claimIds: [claim.id] }, say: `Explain ${QUESTIONS[state.mainQuestions]} in your own words.` };
  }
  if (act === "answer" && !followedUp && allows("ask_followup")) return { move: { kind: "ask_followup", threadId: thread }, say: "Can you say more about that?" };
  return { move: { kind: "close_thread", threadId: thread }, say: "Let us leave that question there." };
}

// ───────────────────────────── the fixture capture ─────────────────────────────

const frame = (mediaS: number, frameId: string) => ({
  kind: "frame", videoId: VIDEO, frameId, mediaS, width: 640, height: 360, trigger: "change_settled", diff: 0.4, jpegBase64: JPEG.toString("base64"),
});
const span = (start: number, end: number, wallDurationMs: number) => ({ kind: "span", videoId: VIDEO, start, end, rate: 1, tabVisible: true, wallDurationMs });

const PAUSED_TEXT = "WHILE PAUSED: this must never become evidence.";
const AD_TEXT = "AD MEDIA: this must never become evidence.";

/** A 120 s watch of a 600 s lecture, with a pause (and a span that leaked into it), an ad (and its media leaking as a span). */
const FACTS: Record<string, unknown>[] = [
  { kind: "control", action: "start", reason: "user" },
  { kind: "source", videoId: VIDEO, title: "Replay lecture", channelName: "Replay Prof", url: `https://www.youtube.com/watch?v=${VIDEO}`, durationS: 600 },
  {
    kind: "transcript", videoId: VIDEO, origin: "panel", language: "en", autoGenerated: false,
    segments: Array.from({ length: 40 }, (_, i) => ({
      start: i * 10, end: i * 10 + 10, text: i === 20 ? PAUSED_TEXT : i === 30 ? AD_TEXT : `Statement ${i + 1} of the replay lecture, at ${i * 10} seconds.`,
    })),
  },
  span(0, 40, 40_000),
  frame(5, "f0"),
  { kind: "control", action: "pause", reason: "user" },
  span(200, 210, 10_000),
  { kind: "control", action: "resume", reason: "user" },
  span(40, 60, 20_000),
  frame(50, "f1"),
  { kind: "ad", videoId: VIDEO, atContentS: 60, wallDurationMs: 15_000, signals: ["dom_class"] },
  span(300, 330, 15_000),
  span(60, 120, 60_000),
  frame(100, "f2"),
  { kind: "control", action: "stop", reason: "user" },
].map((f, clientSeq) => ({ ...f, clientSeq, wallMs: 1000 + clientSeq }));

const BATCHES = [FACTS.slice(0, 4), FACTS.slice(4, 11), FACTS.slice(11)];

// ───────────────────────────── driving the backend over HTTP ─────────────────────────────

type Origin = "extension" | "app";
type Req = { readonly name: string; readonly origin: Origin; readonly method: "GET" | "POST" | "PATCH" | "DELETE"; readonly path: string; readonly body?: unknown };
type Reply = { readonly status: number; readonly json: any; readonly events: TutorStreamEvent[]; readonly bytes: Uint8Array | null };
type Session = { r: Running; base: string; configDir: string; dataDir: string };

async function bootOn(dataDir: string, configDir: string, tasks: TaskSet): Promise<Session> {
  const r = await main({
    port: 0, buildApp: false, configDir, tasks, log: () => {}, error: (t) => void errors.push(t),
    env: { AFTERCLASS_DATA: dataDir, AFTERCLASS_MODE: "replay", AFTERCLASS_EXTENSION_ID: EXT_ID },
  });
  running.push(r);
  return { r, base: `http://127.0.0.1:${r.port}`, configDir, dataDir };
}

const errors: string[] = [];

async function stop(s: Session): Promise<void> {
  await s.r.stop();
  running.splice(running.indexOf(s.r), 1);
}

async function call(s: Session, req: Req): Promise<Reply> {
  const res = await realFetch(`${s.base}${req.path}`, {
    method: req.method,
    headers: {
      Authorization: `Bearer ${s.r.token}`, "Content-Type": "application/json",
      Origin: req.origin === "extension" ? `chrome-extension://${EXT_ID}` : s.base,
    },
    ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
  });
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("jpeg")) return { status: res.status, json: null, events: [], bytes: new Uint8Array(await res.arrayBuffer()) };
  const text = await res.text();
  if (type.includes("ndjson")) {
    return { status: res.status, json: null, events: text.split("\n").filter(Boolean).map((l) => tutorStreamEvent.parse(JSON.parse(l))), bytes: null };
  }
  return { status: res.status, json: text === "" ? null : JSON.parse(text), events: [], bytes: null };
}

const until = async (done: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(25);
  }
};

/**
 * Quiet means nothing in flight and no memo, frozen-input or usage row added for 300 ms. The scheduler debounces 50 ms
 * before it starts work, so an empty in-flight list alone can mean "about to start": CI once ran a restarted copy with
 * one fewer preparation task than the plain run because the counts were taken in that window.
 */
const settled = async (s: Session): Promise<void> => {
  const rows = () => (s.r.modules.db.sql.query("SELECT (SELECT COUNT(*) FROM memo) + (SELECT COUNT(*) FROM prep_inputs) + (SELECT COUNT(*) FROM usage_events) AS n").get() as { n: number }).n;
  let last = -1;
  let since = 0;
  await until(() => {
    const n = rows();
    if (s.r.modules.scheduler.inflight().length > 0 || n !== last) {
      last = n;
      since = Date.now();
      return false;
    }
    return Date.now() - since >= 300;
  });
};

const get = (name: string, path: string, origin: Origin = "app"): Req => ({ name, origin, method: "GET", path });
const post = (name: string, path: string, body?: unknown, origin: Origin = "app"): Req => ({ name, origin, method: "POST", path, ...(body === undefined ? {} : { body }) });

/** The learner's side of the review. `at` is the turn number; the comment says what the tutor script answers. */
const ACTS: readonly { readonly act: unknown }[] = [
  { act: { kind: "resume" } }, //                                   1  asks Alpha (thread 1)
  { act: { kind: "hint_request" } }, //                             2  hint, BEFORE any answer (R12)
  { act: { kind: "answer", text: "It opens by naming the topic.", modality: "text" } }, //    3  follow-up
  { act: { kind: "answer", text: "And it says why the topic matters.", modality: "text" } }, // 4  closes thread 1
  { act: { kind: "resume" } }, //                                   5  asks Beta (thread 2)
  { act: { kind: "skip" } }, //                                     6  closes thread 2 (R13)
  { act: { kind: "resume" } }, //                                   7  asks Gamma (thread 3)
  { act: { kind: "answer", text: "It ends with a new topic.", modality: "text" } }, //     8  follow-up
  { act: { kind: "dispute", text: "I think the lecture did say that at the end." } }, //     9  answer_dispute, unsettled (R14)
  { act: { kind: "wrap_up" } }, //                                  10 wrap_up
];
const RESTART_AFTER_TURN = 4;

type Product = {
  readonly configDir: string;
  readonly dataDir: string;
  readonly fakes: ReturnType<typeof fakeTasks>;
  readonly sent: Req[];
  readonly replies: Map<string, Reply>;
  readonly record: RecordView;
  readonly counts: Record<string, number>;
  readonly boots: number;
};

/** Runs the whole script. `restartAfterTurn` stops the backend and boots it again on the same dir at that point. */
async function runProduct(opts: { restartAfterTurn: number | null }): Promise<Product> {
  const fakes = fakeTasks();
  const configDir = dir("afterclass-e2e-config-");
  const dataDir = dir("afterclass-e2e-data-");
  let s = await bootOn(dataDir, configDir, fakes.tasks);
  let boots = 1;
  const sent: Req[] = [];
  const replies = new Map<string, Reply>();
  const send = async (req: Req): Promise<Reply> => {
    sent.push(req);
    const reply = await call(s, req);
    replies.set(req.name, reply);
    return reply;
  };
  const peek = (req: Req) => call(s, req);

  // 1. the extension posts the capture, in batches
  for (const [n, facts] of BATCHES.entries()) {
    const reply = await send(post(`ingest ${n + 1}`, "/ingest", { captureId: CAP, facts }, "extension"));
    expect(reply.status).toBe(200);
    expect(ingestAckResponse.parse(reply.json).ackedThroughSeq).toBe(facts.at(-1)!.clientSeq as number);
  }

  // 2. the backend prepares it with the fake tasks: boundaries, frames, claims
  const optionsReq = get("review options", `/captures/${CAP}/review-options`);
  await until(async () => reviewOptionsResponse.parse((await peek(optionsReq)).json).kind === "ready");
  await settled(s);
  expect(reviewOptionsResponse.parse((await send(optionsReq)).json)).toMatchObject({ kind: "ready", scope: { supportedClaims: 3 } });

  // 3. the invite: chunk 0 closed at a boundary while the capture ran; the learner says yes
  const view = captureResponse.parse((await send(get("capture view", `/captures/${CAP}`))).json);
  expect(view.capture.status.state).toBe("stopped");
  expect(view.invite.state).toBe("invited");
  const invited = await send(post("invite answer", `/captures/${CAP}/invite`, { answer: "review_now" }, "extension"));
  expect(invited.status).toBe(200);

  // 4. the review: start, then ten turns streamed
  const started = startReviewResponse.parse((await send(post("start review", `/captures/${CAP}/reviews`, { reviewId: REVIEW, choice: "prepared_only" }))).json);
  expect(started.kind).toBe("started");

  for (const [n, { act }] of ACTS.entries()) {
    const reply = await send(post(`turn ${n + 1}`, `/reviews/${REVIEW}/turns`, { turnId: turnId(n + 1), act }));
    expect(reply.status).toBe(200);
    expect(reply.events.map((e) => e.type).filter((t) => t !== "say_delta" && t !== "sentence")).toEqual(["learner_turn_stored", "move", "turn_complete"]);
    if (opts.restartAfterTurn === n + 1) {
      await stop(s);
      s = await bootOn(dataDir, configDir, fakes.tasks);
      boots += 1;
    }
  }
  const reviewView = reviewViewResponse.parse((await send(get("review view", `/reviews/${REVIEW}`))).json);
  expect(reviewView.state.phase).toBe("ended");
  expect(reviewView.saved).toBe("unsaved");

  // 5. save, and read the record back
  const saveReq = post("save", `/reviews/${REVIEW}/save`);
  expect(saveResponse.parse((await send(saveReq)).json).kind).toBe("saved");
  const recordReq = get("record", `/record?reviewId=${REVIEW}`);
  const first = recordViewResponse.parse((await send(recordReq)).json);
  expect(first.notes).toHaveLength(3);

  // 6. the learner edits one note, deletes another, and decides a link
  const [kept, , dropped] = first.notes;
  expect((await send({ name: "edit note", origin: "app", method: "PATCH", path: `/record/notes/${kept!.id}`, body: { text: "My own wording of Alpha." } })).status).toBe(204);
  expect((await send({ name: "delete note", origin: "app", method: "DELETE", path: `/record/notes/${dropped!.id}` })).status).toBe(204);
  expect(first.links).toHaveLength(1);
  expect((await send(post("decide link", `/record/links/${first.links[0]!.id}`, { decision: "accepted" }))).status).toBe(204);

  // 7. evidence lookup, by capture, by ids, by material, and a frame image
  const bundle = evidenceBundleResponse.parse((await send(get("evidence by capture", `/evidence?captureId=${CAP}`))).json);
  const slide = bundle.frames.find((f) => f.mediaS === 50)!;
  await send(get("evidence by ids", `/evidence?ids=${bundle.passages.slice(0, 2).map((p) => p.id).join(",")}`));
  await send(get("evidence by material", `/evidence?material=${encodeURIComponent(encodeMaterial(bundle.material))}`));
  const image = await send(get("frame image", `/frames/${slide.id}`));
  expect(Buffer.from(image.bytes!)).toEqual(JPEG);

  // 8. the final record and the usage ledger
  const record = recordViewResponse.parse((await send(get("record final", `/record?reviewId=${REVIEW}`))).json);
  expect((await send(get("usage", "/usage", "extension"))).status).toBe(200);

  await stop(s);
  return { configDir, dataDir, fakes, sent, replies, record, counts: tableCounts(dataDir), boots };
}

/** Boots the backend on a fresh copy of a finished run's data dir, so a test never disturbs the dir another test reads. */
async function withCopy<T>(p: Product, use: (s: Session, copy: string) => Promise<T>): Promise<T> {
  const copy = dir("afterclass-e2e-copy-");
  cpSync(p.dataDir, copy, { recursive: true });
  const s = await bootOn(copy, p.configDir, p.fakes.tasks);
  try {
    return await use(s, copy);
  } finally {
    await stop(s);
  }
}

const idle = async (s: Session) => {
  await Bun.sleep(150);
  await settled(s);
};

/** Row count of every table in the sqlite file, listed from sqlite_master. */
function tableCounts(dataDir: string): Record<string, number> {
  const db = new Database(join(dataDir, "afterclass.sqlite"), { readonly: true });
  try {
    const names = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return Object.fromEntries(names.map(({ name }) => [name, db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${name}"`).get()!.n]));
  } finally {
    db.close();
  }
}

// The two full runs are shared by the tests below, so the file pays for each once.
let plain: Promise<Product> | null = null;
let restarted: Promise<Product> | null = null;
const plainRun = () => (plain ??= runProduct({ restartAfterTurn: null }));
const restartedRun = () => (restarted ??= runProduct({ restartAfterTurn: RESTART_AFTER_TURN }));

const byThread = (record: RecordView): readonly Observation[] => record.observations;

/** Plain JSON, so branded numbers and readonly arrays compare without casts. */
const plain_ = (x: unknown): unknown => JSON.parse(JSON.stringify(x));

/**
 * A record with the run-dependent numbers taken out: Seqs come from one global counter that background work shares, and
 * deletion times are the clock. What is left is what the learner would read.
 */
const durable = (x: unknown): unknown =>
  JSON.parse(JSON.stringify(x, (k, v) => (k === "deletedAtMs" ? "(time)" : k === "firstHelpSeq" || k === "firstSubstantiveAnswerSeq" ? (v === null ? null : "(seq)") : v)));

// ───────────────────────────── the product, start to finish ─────────────────────────────

describe("REPLAY DATA (fake tasks, no live call): capture to saved record over HTTP", () => {
  test("R12, R13, R14: the record's statuses follow the turns, whatever the scripted wrap-up proposed", async () => {
    const product = await plainRun();
    const { record } = product;
    const [help, skipped, disputed] = byThread(record);
    expect(record.observations).toHaveLength(3);

    // R12: "If the tutor helped before my answer, it can't count as independent."
    expect(help!.proposed).toBe("independent");
    expect(help!.status).toBe("after_help");
    expect(help!.clampedFrom).toBe("independent");
    expect(help!.facts.firstHelpSeq).not.toBeNull();
    expect(help!.facts.firstSubstantiveAnswerSeq).not.toBeNull();
    expect(help!.facts.firstHelpSeq!).toBeLessThan(help!.facts.firstSubstantiveAnswerSeq!);
    expect(help!.facts.learnerTurns).toHaveLength(3); // the hint request and two answers; the opener came before the thread was open

    // R13: "A skipped or unanswered question is never counted as understood."
    expect(skipped!.facts.endedBySkip).toBe(true);
    expect(skipped!.facts.firstSubstantiveAnswerSeq).toBeNull();
    expect(skipped!.proposed).toBe("independent");
    expect(skipped!.status).toBe("not_assessed");
    expect(skipped!.status).not.toBe("independent");

    // R14: "A disputed assessment is never counted as a learning gap unless I resolve it that way."
    expect(disputed!.proposed).toBe("partial");
    expect(disputed!.dispute.kind).toBe("unsettled");
    expect(disputed!.status).toBe("disputed");
    expect(isLearningGap(disputed!)).toBe(false);
    expect(record.observations.some((o) => isLearningGap(o))).toBe(false);

    // the learner's own words are saved verbatim and attributed to the learner
    const note = record.notes.find((n) => n.generated.some((g) => g.author === "learner" && g.text === "It opens by naming the topic."));
    expect(note).toBeDefined();
    expect(note!.generated.filter((g) => g.author === "learner").every((g) => g.turnId !== null)).toBe(true);
    await withCopy(product, async (s) => {
      expect(reviewViewResponse.parse((await call(s, get("x", `/reviews/${REVIEW}`))).json).saved).toBe("saved");
    });
  }, 30_000);

  test("R2: the ad and the pause produced no evidence", async () => {
    const product = await plainRun();
    // as the app read it
    const bundle = evidenceBundleResponse.parse(product.replies.get("evidence by capture")!.json);

    // R2: "Ad time never becomes evidence."
    expect(plain_(bundle.ads)).toEqual([{ sourceId: bundle.ads[0]!.sourceId, atContentS: 60, wallDurationMs: 15_000, signals: ["dom_class"] }]);
    const text = bundle.passages.map((p) => p.text).join("\n");
    expect(text).not.toContain(AD_TEXT);
    expect(text).not.toContain(PAUSED_TEXT);
    expect(bundle.passages).toHaveLength(12);
    expect(Math.max(...bundle.passages.map((p) => p.interval.end))).toBe(120);
    expect(bundle.frames.map((f) => Number(f.mediaS)).sort((a, b) => a - b)).toEqual([5, 50, 100]);

    await withCopy(product, async (s) => {
      // the ad media that slipped past the probe is reported as an implausible span, not counted (read from the store; the HTTP bundle holds only watched material)
      const all = s.r.modules.evidence.captureBundle(CAP);
      expect(all.gaps.filter((g) => g.reason === "implausible_span").map((g) => [g.start, g.end])).toEqual([[300, 330]]);
      const view = captureResponse.parse((await call(s, get("x", `/captures/${CAP}`))).json);
      expect(view.capture.watchedSeconds).toBe(120);
    });

    // nothing the saved record cites lies outside the watched material
    const known = new Set([...bundle.passages.map((p) => p.id), ...bundle.frames.map((f) => f.id)]);
    for (const n of product.record.notes) for (const e of n.evidence) expect(known.has(e)).toBe(true);
  }, 30_000);

  test("note edit and delete and the link decision reach the final record", async () => {
    const { record, replies } = await plainRun();
    expect(record.notes).toHaveLength(2);
    expect(record.notes.filter((n) => n.userEdit === "My own wording of Alpha.")).toHaveLength(1);
    expect(record.links.map((l) => l.decision)).toEqual(["accepted"]);
    expect(record.unavailableEvidence).toEqual([]);
    expect(replies.get("evidence by ids")!.json.passages).toHaveLength(2);
    expect(replies.get("evidence by material")!.json.passages.length).toBe(12);
  }, 30_000);

  test("R17: every fake call has a usage event; unknown cost is stored as unknown, never zero", async () => {
    const product = await plainRun();
    const { fakes } = product;
    const raw = (await withCopy(product, async (s) => (await call(s, get("x", "/usage", "extension"))).json)) as { byKind: { unknown: { usd: unknown } } };
    const usage = usageResponse.parse(raw);

    const calls = fakes.callCounts();
    const total = Object.values(calls).reduce((n, c) => n + c, 0);
    expect(Object.values(usage.byKind).reduce((n, k) => n + k.calls, 0)).toBe(total);
    expect(usage.byPurpose.tutor_turn.calls).toBe(ACTS.length);
    expect(usage.byPurpose.wrap_up.calls).toBe(1);
    expect(usage.byPurpose.interpretation.calls).toBe(2);

    // fake-priced: Jev measured, tutor notional, the rest unknown
    expect(usage.byKind.measured.calls).toBe(calls.boundary! + calls.frameChange! + calls.checkClaim!);
    expect(usage.byKind.measured.usd).toBeCloseTo(0.001 * usage.byKind.measured.calls, 6);
    expect(usage.byKind.notional).toEqual({ calls: ACTS.length, usd: expect.closeTo(0.04 * ACTS.length, 6) });
    expect(usage.byKind.unknown.calls).toBe(calls.interpret! + calls.wrapUp! + calls.searchResources!);
    expect(usage.byKind.unknown.calls).toBeGreaterThan(0);
    // R17: "Every paid call records a usage event; unknown cost is stored as unknown, not zero."
    expect(usage.byKind.unknown.usd).toBeNull();
    expect(raw.byKind.unknown.usd).toBeNull();
    expect(usage.byKind.estimated).toEqual({ calls: 0, usd: null });
    expect(usage.byPurpose.wrap_up.unknownCost).toBe(1);

    const db = new Database(join(product.dataDir, "afterclass.sqlite"), { readonly: true });
    try {
      const n = (sql: string) => db.query<{ n: number }, []>(sql).get()!.n;
      expect(n("SELECT COUNT(*) AS n FROM usage_events")).toBe(total);
      expect(n("SELECT COUNT(*) AS n FROM usage_events WHERE cost_kind = 'unknown'")).toBe(usage.byKind.unknown.calls);
      expect(n("SELECT COUNT(*) AS n FROM usage_events WHERE cost_kind = 'unknown' AND (cost_usd IS NOT NULL AND cost_usd = 0)")).toBe(0);
      expect(n("SELECT COUNT(*) AS n FROM usage_events WHERE cost_kind = 'unknown' AND cost_usd IS NOT NULL")).toBe(0);
    } finally {
      db.close();
    }
  }, 30_000);

  test("no live Jev or Claude call, no socket, no child process, and no unexpected task", async () => {
    const { fakes } = await plainRun();
    await restartedRun();
    expect(live).toEqual([]);
    expect(existsSync(claudeMarker)).toBe(false);
    expect(fakes.unexpected).toEqual([]);
    expect(fakes.all.revise.calls).toHaveLength(0);
    expect(errors.filter((e) => !e.includes("AFTERCLASS_EXTENSION_ID"))).toEqual([]);
  }, 30_000);
});

// ───────────────────────────── restart in the middle ─────────────────────────────

describe("REPLAY DATA (fake tasks, no live call): a restart in the middle changes nothing", () => {
  test("stopping the backend after turn 4 and booting on the same dir gives the same record, rows and task runs", async () => {
    const a = await plainRun();
    const b = await restartedRun();
    expect([a.boots, b.boots]).toEqual([1, 2]);
    expect(durable(b.record)).toEqual(durable(a.record));
    expect(b.counts).toEqual(a.counts);
    expect(b.fakes.callCounts()).toEqual(a.fakes.callCounts());
  }, 60_000);
});

// ───────────────────────────── retro 1: resend every request ─────────────────────────────

describe("REPLAY DATA (fake tasks, no live call): retro 1, resending every request adds nothing", () => {
  test("the same requests, sent again to a fresh copy of the data dir, add no row to any table, run no task, and leave the record identical", async () => {
    const product = await plainRun();
    const before = product.counts;
    const calledBefore = product.fakes.callCounts();

    await withCopy(product, async (s, copy) => {
      // the copy starts where the first run ended: same rows, and booting alone runs nothing
      expect(tableCounts(copy)).toEqual(before);
      await idle(s);
      expect(product.fakes.callCounts()).toEqual(calledBefore);

      const recordBefore = recordViewResponse.parse((await call(s, get("x", `/record?reviewId=${REVIEW}`))).json);
      const turnsBefore = reviewViewResponse.parse((await call(s, get("x", `/reviews/${REVIEW}`))).json).turns;

      const resent: Reply[] = [];
      for (const req of product.sent) resent.push(await call(s, req));
      await idle(s);

      const after = tableCounts(copy);
      expect(Object.keys(after)).toEqual(Object.keys(before));
      for (const table of Object.keys(before)) expect({ table, rows: after[table] }).toEqual({ table, rows: before[table] });
      expect(product.fakes.callCounts()).toEqual(calledBefore);

      // the comparison is not vacuous: the script filled every table the product writes in this flow
      expect(Object.keys(before).length).toBeGreaterThan(20);
      const filled = ["capture_facts", "frames", "memo", "memo_inputs", "usage_events", "chunk_revisions", "claim_index", "concept_index", "reviews", "review_turns", "invite_answers", "notes", "note_evidence", "observations", "saved_reviews", "link_suggestions", "link_decisions", "note_edits", "note_deletions", "evidence_snapshots"];
      for (const table of filled) expect({ table, filled: (before[table] ?? 0) > 0 }).toEqual({ table, filled: true });

      const recordAfter = recordViewResponse.parse((await call(s, get("x", `/record?reviewId=${REVIEW}`))).json);
      expect(plain_(recordAfter)).toEqual(plain_(recordBefore));
      expect(plain_(recordAfter)).toEqual(plain_(product.record));
      expect(reviewViewResponse.parse((await call(s, get("x", `/reviews/${REVIEW}`))).json).turns).toEqual(turnsBefore);

      // each resent turn replays the stored move and the same words, with no second model call
      const shape = (r: Reply) => ({
        moves: r.events.filter((e) => e.type === "move"),
        done: r.events.filter((e) => e.type === "turn_complete"),
        say: r.events.filter((e) => e.type === "say_delta").map((e) => (e as { text: string }).text).join("").trim(),
      });
      const turns = product.sent.flatMap((req, i) => (req.path.endsWith("/turns") ? [{ req, i }] : []));
      expect(turns).toHaveLength(ACTS.length);
      for (const { req, i } of turns) expect(shape(resent[i]!)).toEqual(shape(product.replies.get(req.name)!));
    });
    expect(live).toEqual([]);
  }, 60_000);

  const deleteSlide = (product: Product): Req => {
    const bundle = evidenceBundleResponse.parse(product.replies.get("evidence by capture")!.json);
    const slide = bundle.frames.find((f) => f.mediaS === 50)!;
    return post("delete evidence", "/record/evidence/delete", { evidenceIds: [slide.id] });
  };

  test("deleting evidence twice adds one row; the frame is gone and the record lists it as unavailable", async () => {
    const product = await plainRun();
    const del = deleteSlide(product);
    await withCopy(product, async (s, copy) => {
      expect((await call(s, del)).status).toBe(204);
      const once = tableCounts(copy);
      expect(once.evidence_deletions).toBe(product.counts.evidence_deletions! + 1);

      expect((await call(s, del)).status).toBe(204);
      const frameId = (del.body as { evidenceIds: string[] }).evidenceIds[0]!;
      expect((await call(s, get("x", `/frames/${frameId}`))).status).toBe(404);
      const record = recordViewResponse.parse((await call(s, get("x", `/record?reviewId=${REVIEW}`))).json);
      expect(record.unavailableEvidence.map((u) => u.id)).toEqual([frameId as EvidenceId]);
      expect(tableCounts(copy)).toEqual(once);
    });
  }, 30_000);

  test("re-saving after the learner deleted cited evidence runs no further wrap-up and adds no row to any table", async () => {
    const product = await plainRun();
    const del = deleteSlide(product);
    const save = product.sent.find((r) => r.name === "save")!;
    await withCopy(product, async (s, copy) => {
      expect((await call(s, del)).status).toBe(204);
      const calledBefore = product.fakes.callCounts();
      const before = tableCounts(copy);
      const first = saveResponse.parse(product.replies.get("save")!.json);
      const again = saveResponse.parse((await call(s, save)).json);
      await idle(s);
      expect(product.fakes.callCounts().wrapUp).toBe(calledBefore.wrapUp);
      expect(product.fakes.callCounts()).toEqual(calledBefore);
      expect(tableCounts(copy).memo).toBe(before.memo);
      expect(tableCounts(copy)).toEqual(before);
      expect(again).toEqual(first);
    });
  }, 30_000);
});
