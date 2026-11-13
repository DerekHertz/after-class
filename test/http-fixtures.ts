import { afterAll, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../src/backend/db";
import { createEvidence } from "../src/backend/evidence";
import { serve } from "../src/backend/http";
import type { Preparation } from "../src/backend/preparation";
import { createLedger } from "../src/backend/providers/ledger";
import type { Task } from "../src/backend/providers/memo";
import { createMemo } from "../src/backend/providers/memo";
import { createRecord } from "../src/backend/record";
import type { Reviews } from "../src/backend/review";
import { createReviews } from "../src/backend/review";
import type { TutorInput, TutorOutput } from "../src/backend/review/tutor";
import { nextThreadId } from "../src/backend/review/tutor";
import type { Segmentation } from "../src/backend/segmentation";
import type { AssessableClaim, ChunkPrep, ChunkRevision, Claim, ClaimStatus, EvidenceBundle, Gap, InviteAnswer, InviteState, LearnerAct, Passage, Seq, SubjectLinkSuggestion, } from "../src/shared/domain";
import type { CaptureId, ChunkId, ChunkRevisionId, ClaimId, EvidenceId, IdPart, ReviewId, TurnId } from "../src/shared/ids";
import { randomId, stableId } from "../src/shared/ids";
import type { Interval } from "../src/shared/time";
import { Material, interval } from "../src/shared/time";
import { recordViewResponse, saveResponse, tutorStreamEvent } from "../src/shared/wire";
import type { FakeStep } from "./fakes";
import { fakeTask, ok, testDb } from "./fakes";

export const TOKEN = "tok-9f3a1c77e0b24d5aa8c1";

export const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";

export const PAGE = "https://evil.test";

export const CAP = stableId("cap", "http-test");

const scratch: string[] = [];

const servers: { stop(force?: boolean): void | Promise<void> }[] = [];

export function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

export function fixtureApp(): string {
  const dir = scratchDir("afterclass-app-");
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><html><head><meta name="afterclass-token" content="" /><title>t</title><script type="module" src="/app/main.js"></script></head><body><div id="root"></div></body></html>',
  );
  writeFileSync(join(dir, "main.js"), "console.log('app');");
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "nested", "a.css"), "body{}");
  return dir;
}

function evidenceOn(db: Db) {
  return createEvidence(db, scratchDir("afterclass-data-"), {
    lookupFrameChange: (input) => ({ kind: "missing", key: stableId("key", input.after.frame.id) }),
    runFrameChange: async () => undefined,
    frameChangeKey: (input) => stableId("key", input.after.frame.id),
    onChange: () => {},
  });
}

/** The real evidence module on an in-memory db; reviews is a fake whose invite state a test sets. */
export function world() {
  const db = testDb();
  const evidence = evidenceOn(db);
  const invite = { state: { state: "none" } as InviteState, answers: [] as InviteAnswer[] };
  const reviews = {
    invite: () => invite.state,
    answerInvite: (_input: unknown, a: InviteAnswer) => {
      invite.answers.push(a);
      if (a === "later") invite.state = { state: "later" };
      return invite.state;
    },
  } as unknown as Reviews;
  const stored = () => db.sql.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM capture_facts").get()!.n;
  return { db, evidence, reviews, invite, stored };
}

export function start(appDir = fixtureApp(), extra: { maxBodyBytes?: number } = {}) {
  const w = world();
  const server = serve({
    modules: { ledger: createLedger(w.db), evidence: w.evidence, reviews: w.reviews },
    auth: { port: 0, extensionId: EXT_ID, token: TOKEN }, appDir, ...extra,
  });
  servers.push(server);
  return { server, port: server.port as number, base: `http://127.0.0.1:${server.port}`, ...w };
}

type Raw = { status: number; headers: Headers; body: string };

/** One HTTP/1.1 request with exactly the given path and headers (`null` omits a header). */
export function raw(port: number, path: string, headers: Record<string, string | null>, method = "GET"): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const lines = [`${method} ${path} HTTP/1.1`, ...Object.entries({ Host: `127.0.0.1:${port}`, ...headers }).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`), "Connection: close", "", ""];
    const chunks: Uint8Array[] = [];
    const sock = connect(port, "127.0.0.1", () => sock.write(lines.join("\r\n")));
    sock.on("data", (c: Uint8Array) => chunks.push(c));
    sock.on("error", reject);
    sock.on("close", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const split = text.indexOf("\r\n\r\n");
      const head = text.slice(0, split).split("\r\n");
      const h = new Headers();
      for (const l of head.slice(1)) h.append(l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim());
      resolve({ status: Number(head[0]!.split(" ")[1]), headers: h, body: text.slice(split + 4) });
    });
  });
}

export const bearer = { Authorization: `Bearer ${TOKEN}` };

// ───────────────────────────── M4: ingest ─────────────────────────────

export const VIDEO = "dQw4w9WgXcQ";

export const JSON_HEADERS = { ...bearer, "Content-Type": "application/json" };

/** A wire fact stream with consecutive clientSeqs from `from`: start, source, then one watched span per further seq. */
export function wireFacts(from: number, count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => {
    const clientSeq = from + i;
    const wallMs = 1000 + clientSeq;
    if (clientSeq === 0) return { kind: "control", action: "start", reason: "user", clientSeq, wallMs };
    if (clientSeq === 1) return { kind: "source", videoId: VIDEO, title: "Lecture", channelName: "Prof", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", durationS: 6000, clientSeq, wallMs };
    const start = (clientSeq - 2) * 5;
    return { kind: "span", videoId: VIDEO, start, end: start + 5, rate: 1, tabVisible: true, wallDurationMs: 5000, clientSeq, wallMs };
  });
}

export const post = (base: string, path: string, body: unknown, headers: Record<string, string> = JSON_HEADERS) =>
  fetch(`${base}${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

export const ingest = (base: string, facts: unknown[], captureId: string = CAP) => post(base, "/ingest", { captureId, facts });

type Ack = { ackedThroughSeq: number; invite: InviteState; capture: { captureId: string; watchedSeconds: number }; reviewAppUrl: string };

export const ackOf = async (r: Response) => (await r.json()) as Ack;

// ───────────────────────────── M7a: review routes ─────────────────────────────

export const SRC = stableId("src", "youtube", "lecture");

export const CONCEPT = stableId("cpt", "c");

const OTHER_CONCEPT = stableId("cpt", "other");

export const LINK: SubjectLinkSuggestion = {
  id: stableId("lnk", CONCEPT, OTHER_CONCEPT, "part_of"), from: CONCEPT, to: OTHER_CONCEPT, type: "part_of", evidence: [], rationale: "c is part of other",
};

type WorldClaim = { text: string; evidence: EvidenceId[]; status: ClaimStatus; checkedAt?: Seq };

/** What preparation would answer for one capture, from plain data (the review module's own tests use the same shape). */
class World {
  readonly captureId: CaptureId = randomId("cap");
  chunks: ChunkRevision[] = [];
  claims = new Map<ClaimId, WorldClaim>();
  evidence = new Map<EvidenceId, Interval>();
  gaps: Gap[] = [];
  pendingChunks = new Set<ChunkRevisionId>();
  revisions: ChunkRevision[] = [];

  constructor(readonly db: Db) {}

  close(ordinal: number, start: number, end: number): ChunkRevision {
    const rev: ChunkRevision = {
      id: stableId("crv", ordinal, start, end),
      chunkId: stableId("chk", this.captureId, ordinal),
      captureId: this.captureId,
      ordinal,
      revisionNo: 1,
      material: Material.of([[SRC, [interval(start, end)]]]),
      windows: [],
      provenance: "boundary",
      closedAtSeq: this.db.nextSeq(),
      supersedes: null,
    };
    this.chunks = [...this.chunks, rev];
    this.revisions.push(rev);
    return rev;
  }

  claim(n: number, start: number, end: number, status: ClaimStatus = "supported_by_check"): ClaimId {
    const id = stableId("clm", "k", n);
    const ev = stableId("ev", "w", n);
    this.evidence.set(ev, interval(start, end));
    this.claims.set(id, { text: `claim ${n}`, evidence: [ev], status });
    return id;
  }

  /** A check result lands: new status, stamped with the check's seq. */
  check(id: ClaimId, status: ClaimStatus): void {
    const c = this.claims.get(id)!;
    c.status = status;
    c.checkedAt = this.db.nextSeq();
  }

  private inside(material: Material, ids: readonly EvidenceId[]): boolean {
    return ids.every((e) => Material.covers(material, SRC, this.evidence.get(e)!));
  }

  readonly deps = {
    currentChunks: (_input: CaptureId): readonly ChunkRevision[] => this.chunks,
    chunkHistory: (chunkId: ChunkId): readonly ChunkRevision[] => this.revisions.filter((r) => r.chunkId === chunkId),
    prep: (id: ChunkRevisionId): ChunkPrep => {
      const rev = this.chunks.find((c) => c.id === id)!;
      const claims = [...this.claims].filter(([, c]) => this.inside(rev.material, c.evidence)).map(([cid, c]) => ({ id: cid, status: c.status }) as unknown as Claim);
      return {
        chunkRevisionId: id,
        interpretation: "done",
        claims,
        finished: !this.pendingChunks.has(id) && claims.every((c) => !c.status.startsWith("awaiting")),
        supportedCount: claims.filter((c) => c.status === "supported_by_check").length,
      };
    },
    stopEarly: (_input: CaptureId, ids: readonly ChunkRevisionId[]) => {
      for (const id of ids) {
        this.pendingChunks.delete(id);
        const rev = this.chunks.find((c) => c.id === id)!;
        for (const c of this.claims.values()) if (c.status.startsWith("awaiting") && this.inside(rev.material, c.evidence)) c.status = "dropped";
      }
      return this.db.nextSeq();
    },
    assessableIn: (_input: CaptureId, material: Material): readonly AssessableClaim[] =>
      [...this.claims]
        .filter(([, c]) => c.status === "supported_by_check" && this.inside(material, c.evidence))
        .map(([id, c]) => ({ id, conceptId: CONCEPT, text: c.text, evidence: c.evidence, assumptions: [] }) as unknown as AssessableClaim),
    claimsIn: (_input: CaptureId, material: Material): readonly Claim[] =>
      [...this.claims]
        .filter(([, c]) => this.inside(material, c.evidence))
        .map(([id, c]): Claim => ({
          id,
          sourceChunkId: stableId("chk", this.captureId, 0),
          conceptId: CONCEPT,
          original: { text: c.text, evidence: [c.evidence[0]!, ...c.evidence.slice(1)], visualDependent: false, assumptions: [] },
          originalCheck: c.checkedAt
            ? { verdict: c.status === "supported_by_check" ? "yes" : "no", p: null, reason: "jev", memoKey: stableId("key", id), atSeq: c.checkedAt }
            : null,
          revision: null,
          revisionCheck: null,
          status: c.status,
        })),
    bundle: (material: Material): EvidenceBundle => ({
      material,
      passages: [...this.evidence]
        .filter(([, i]) => Material.covers(material, SRC, i))
        .map(([id, i]) => ({ kind: "passage", id, sourceId: SRC, interval: i, text: `passage ${id}` }) as unknown as Passage),
      frames: [],
      gaps: this.gaps.filter((g) => Material.get(material, g.sourceId).overlapFraction(g.interval) > 0),
      ads: [],
    }),
    watchedSeconds: (_input: CaptureId) => this.chunks.reduce((s, c) => s + Material.duration(c.material), 0),
    runWrapUp: () => Promise.reject(new Error("the record owns wrap-up in these tests")),
    nextSeq: (): Seq => this.db.nextSeq(),
  };
}

type Script = (input: TutorInput, call: number) => TutorOutput | Promise<TutorOutput>;

/** A header line then prose, which the fake task streams in 9-character pieces so the header arrives split. A script that throws is a failed model call. */
function modelTask(script: Script) {
  return fakeTask<IdPart, TutorOutput>({
    purpose: "tutor_turn",
    provider: "claude",
    answer: async (input, call): Promise<FakeStep<TutorOutput>> => {
      try {
        const out = await script(input as unknown as TutorInput, call);
        return ok(out, { deltas: `${JSON.stringify(out.move)}\n${out.say}`.match(/[\s\S]{1,9}/g) ?? [] });
      } catch (e) {
        return { kind: "error", message: e instanceof Error ? e.message : String(e), retryable: false, usage: null };
      }
    },
  });
}

/** A tutor that always takes a legal move: disclose a pending correction, wrap up when it must, else ask, follow up, then close. */
export function pick(input: TutorInput): TutorOutput {
  const a = input.allowed;
  const open = input.state.openThread;
  if (a.includes("disclose_correction")) {
    const c = input.state.corrections.find((x) => !x.disclosed)!;
    return { move: { kind: "disclose_correction", correctionId: c.id, threadIds: [], evidence: [] }, say: "One question rested on a claim that did not hold up." };
  }
  if (a.includes("wrap_up")) return { move: { kind: "wrap_up" }, say: "Let's wrap up here." };
  if (a.includes("ask_main")) {
    const claim = input.claims[0]!;
    return { move: { kind: "ask_main", threadId: nextThreadId(input.state), claimIds: [claim.id] }, say: `In your own words, what is ${claim.text}? Take your time.` };
  }
  const followed = input.turns.some((t) => t.actor === "tutor" && t.move.kind === "ask_followup" && t.move.threadId === open);
  return followed
    ? { move: { kind: "close_thread", threadId: open! }, say: "Good. Let's leave that there." }
    : { move: { kind: "ask_followup", threadId: open! }, say: "And why does that hold?" };
}

export const count = (db: Db, sql: string) => db.sql.query<{ n: number }, []>(sql).get()!.n;

export const learnerRows = (db: Db) => count(db, "SELECT COUNT(*) AS n FROM review_turns WHERE actor = 'learner'");

export const tutorRows = (db: Db) => count(db, "SELECT COUNT(*) AS n FROM review_turns WHERE actor = 'tutor'");

export const reviewRows = (db: Db) => count(db, "SELECT COUNT(*) AS n FROM reviews");

export async function until(done: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!done()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const said = (words: string): LearnerAct => ({ kind: "answer", text: words, modality: "text" });

/**
 * The real review and record modules and the real HTTP server on one in-memory db. Preparation and segmentation are
 * answered from `world`; the tutor and wrap-up are scripted. `retries` records preparation.retry calls.
 */
export function reviewRig(script: Script = pick, extra: { turnDeadlineMs?: number } = {}) {
  const db = testDb();
  const world = new World(db);
  const model = modelTask(script);
  const memo = createMemo(db, "live", { retryDelayMs: () => 0 });
  const task: Task<TutorInput, TutorOutput> = {
    ...(model as unknown as Task<TutorInput, TutorOutput>),
    canonicalInput: (i) => ({ turns: i.turns.map((t) => t.id), repair: i.repairNote, claims: i.claims.map((c) => c.id) }),
  };
  const reviews = createReviews(db, {
    ...world.deps,
    runTutor: (input, streamTo, signal, onRetry) => memo.run(task, input, { signal, streamTo, onRetry }),
    clearFailures: memo.clearFailures,
    endedInTx: (reviewId) => record.markEndedInTx(reviewId),
  });
  const usable = (reviewId: ReviewId) => world.deps.assessableIn(world.captureId, reviews.view(reviewId).scope.material);
  const flags = { failSave: false };
  const snapshots: EvidenceId[][] = [];
  const record = createRecord(db, {
    links: () => [LINK],
    turns: (reviewId) => reviews.view(reviewId).turns,
    claims: usable,
    wrapUp: async (reviewId) => {
      const turns = reviews.view(reviewId).turns;
      const threads = turns.flatMap((t) => (t.actor === "tutor" && t.move.kind === "ask_main" ? [t.move.threadId] : []));
      return {
        observations: threads.map((threadId) => ({ threadId, proposed: "independent" as const, rationale: "explained it unaided" })),
        notes: [{ conceptId: CONCEPT, tutorSummary: "Covered the claims.", evidence: usable(reviewId).flatMap((c) => c.evidence) }],
      };
    },
    snapshotEvidenceInTx: (ids) => {
      if (flags.failSave) throw new Error("disk full");
      snapshots.push([...ids]);
    },
  });
  const retries: { captureId: CaptureId; ids: readonly ChunkRevisionId[] }[] = [];
  const preparation = {
    prep: world.deps.prep,
    retry: (captureId: CaptureId, ids: readonly ChunkRevisionId[]) => {
      retries.push({ captureId, ids });
      return db.nextSeq();
    },
  } as unknown as Preparation;
  const segmentation = { current: world.deps.currentChunks } as unknown as Segmentation;

  const evidence = evidenceOn(db);
  const server = serve({
    modules: { ledger: createLedger(db), evidence, reviews, record, preparation, segmentation },
    auth: { port: 0, extensionId: EXT_ID, token: TOKEN },
    appDir: fixtureApp(), ...extra,
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const capture = world.captureId;

  /** One chunk [0, 300) holding claims A and B, both supported. */
  const prepare = () => ({ rev: world.close(0, 0, 300), a: world.claim(1, 10, 20), b: world.claim(2, 30, 40) });

  const startReview = async (reviewId: ReviewId = randomId("rvw"), choice = "prepared_only", captureId: CaptureId = capture) => {
    const r = await post(base, `/captures/${captureId}/reviews`, { reviewId, choice });
    return { reviewId, status: r.status, body: (await r.json()) as Record<string, any> };
  };

  /** POST a turn and read its whole NDJSON stream. */
  const turn = async (reviewId: ReviewId, act: LearnerAct, turnId: TurnId = randomId("turn")) => {
    const r = await post(base, `/reviews/${reviewId}/turns`, { turnId, act });
    const body = await r.text();
    const lines = body.split("\n");
    const events = body === "" ? [] : lines.slice(0, -1).map((l) => tutorStreamEvent.parse(JSON.parse(l)));
    return { turnId, status: r.status, type: r.headers.get("content-type"), body, lines, events };
  };

  const view = async (reviewId: ReviewId) => {
    const r = await fetch(`${base}/reviews/${reviewId}`, { headers: bearer });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };

  return { db, world, model, base, flags, retries, snapshots, evidence, capture, prepare, startReview, turn, view };
}

type Rig = ReturnType<typeof reviewRig>;

export const moveOf = (events: readonly { type: string }[]) => (events.find((e) => e.type === "move") as { move: { kind: string } } | undefined)?.move.kind;

export const startedIn = async (rig: Rig) => {
  rig.prepare();
  const s = await rig.startReview();
  expect(s.body.kind).toBe("started");
  return s.reviewId;
};

/** Review `reviewId` through to a saved record: two threads, one note, one link. */
export async function savedRig() {
  const rig = reviewRig();
  const reviewId = await startedIn(rig);
  for (const act of [{ kind: "resume" }, said("lines meeting at a point"), said("because both equations hold there"), { kind: "skip" }, { kind: "wrap_up" }] as LearnerAct[]) await rig.turn(reviewId, act);
  expect(saveResponse.parse(await (await post(rig.base, `/reviews/${reviewId}/save`, {})).json()).kind).toBe("saved");
  const get = async (path: string) => {
    const r = await fetch(`${rig.base}${path}`, { headers: bearer });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const record = async (query = `?reviewId=${reviewId}`) => {
    const r = await get(`/record${query}`);
    expect(r.status).toBe(200);
    return recordViewResponse.parse(r.body);
  };
  return { ...rig, reviewId, get, record };
}

export const send = (base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = JSON_HEADERS) =>
  fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });

export function registerCleanup() {
  afterAll(async () => {
    for (const s of servers.splice(0)) await s.stop(true);
    for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
  });
}
