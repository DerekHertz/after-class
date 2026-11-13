/**
 * Topic diagrams (flow D "show me the diagram"): frame selection, R19 enforcement, the one-call-per-evidence-set
 * summary task with its memo and usage events, the diagram module, and the migration that lets the ledger name the
 * new purpose. FakeClaude only: no live call.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { AssessableClaim, DiagramLine, EvidenceBundle, Frame, FrameTeaching, Passage, Source } from "../src/shared/domain";
import { stableId } from "../src/shared/ids";
import type { CaptureId, ClaimId, ConceptId, EvidenceId, ReviewId, SourceId } from "../src/shared/ids";
import { Material, interval, media } from "../src/shared/time";
import { LOCAL_USER, MIGRATIONS, openDb } from "../src/backend/db";
import { createMemo, ProviderError } from "../src/backend/providers/memo";
import type { Task } from "../src/backend/providers/memo";
import { createLedger } from "../src/backend/providers/ledger";
import type { ClaudeCli, ClaudeRequest } from "../src/backend/providers/claude";
import { enforceCitations, pickFrame, summaryEvidence, MAX_SUMMARY_FRAMES } from "../src/backend/diagram/core";
import type { CitingClaim } from "../src/backend/diagram/core";
import { createDiagrams } from "../src/backend/diagram";
import { DIAGRAM_SYSTEM, diagramSummaryTask } from "../src/backend/diagram/tasks";
import type { DiagramSummaryInput, DiagramSummaryOutput } from "../src/backend/diagram/tasks";
import { testUserDb, usage } from "./fakes";

// ───────────────────────────── builders ─────────────────────────────

const SRC = stableId("src", "yt", "VIDEO000001") as SourceId;
const OTHER_SRC = stableId("src", "yt", "VIDEO000002") as SourceId;
const CAP = stableId("cap", "diagram") as CaptureId;
const REVIEW = stableId("rvw", "diagram") as ReviewId;
const TOPIC = stableId("cpt", "clocks") as ConceptId;
const EMPTY_TOPIC = stableId("cpt", "empty") as ConceptId;

const ev = (name: string) => stableId("ev", name) as EvidenceId;
const clm = (name: string) => stableId("clm", name) as ClaimId;

function passage(name: string, start: number, end: number, sourceId = SRC): Passage {
  return { kind: "passage", id: ev(name), sourceId, transcriptRevId: stableId("trv", "t"), interval: { start: media(start), end: media(end) }, text: `Text of ${name}.`, origin: "panel" } as unknown as Passage;
}
function frame(name: string, mediaS: number, teaching: FrameTeaching = "kept", sourceId = SRC): Frame {
  return { kind: "frame", id: ev(name), sourceId, mediaS: media(mediaS), width: 640, height: 360, teaching } as unknown as Frame;
}
const cites = (id: string, ...evidence: string[]): CitingClaim => ({ id: clm(id), text: `Claim ${id}.`, evidence: evidence.map(ev) });
const bundleOf = (passages: Passage[], frames: Frame[]): Pick<EvidenceBundle, "passages" | "frames"> => ({ passages, frames });

// ───────────────────────────── frame selection ─────────────────────────────

describe("flow D: the frame a topic shows", () => {
  test("the frame cited by the most claims wins", () => {
    const frames = [frame("early", 10), frame("popular", 50), frame("late", 90)];
    const claims = [cites("a", "early", "popular"), cites("b", "popular"), cites("c", "late", "popular", "early")];
    expect(pickFrame(claims, bundleOf([], frames))?.id).toBe(ev("popular"));
  });

  test("a tie goes to the earliest frame", () => {
    const frames = [frame("late", 90), frame("early", 10), frame("middle", 50)];
    const claims = [cites("a", "late", "early", "middle")];
    expect(pickFrame(claims, bundleOf([], frames))?.id).toBe(ev("early"));
  });

  test("one claim citing a frame twice counts once", () => {
    const frames = [frame("a", 10), frame("b", 20)];
    expect(pickFrame([cites("x", "a", "a", "a"), cites("y", "b"), cites("z", "b")], bundleOf([], frames))?.id).toBe(ev("b"));
  });

  test("a cited frame outside the review's scope is never shown (R7)", () => {
    const inScope = frame("inside", 30);
    // "outside" is cited by every claim but is not in the scope's bundle
    const claims = [cites("a", "outside", "inside"), cites("b", "outside")];
    expect(pickFrame(claims, bundleOf([], [inScope]))?.id).toBe(ev("inside"));
  });

  test("with no cited frame, a frame captured during a cited passage is used, nearest to the passage start", () => {
    const p = passage("p1", 100, 160);
    const frames = [frame("far", 150), frame("near", 104), frame("before", 90), frame("after", 160)];
    expect(pickFrame([cites("a", "p1")], bundleOf([p], frames))?.id).toBe(ev("near"));
  });

  test("a kept frame is preferred over a nearer uncertain or unjudged one", () => {
    const p = passage("p1", 100, 160);
    const frames = [frame("uncertain-near", 101, "uncertain"), frame("unjudged-near", 102, "unjudged"), frame("kept-far", 140, "kept")];
    expect(pickFrame([cites("a", "p1")], bundleOf([p], frames))?.id).toBe(ev("kept-far"));
  });

  test("the nearest start is measured per passage, across all cited passages", () => {
    const frames = [frame("in-second", 203), frame("in-first", 118)];
    const passages = [passage("p1", 100, 160), passage("p2", 200, 260)];
    expect(pickFrame([cites("a", "p1", "p2")], bundleOf(passages, frames))?.id).toBe(ev("in-second"));
  });

  test("a frame of another source, or during an uncited passage, is not a fallback", () => {
    const cited = passage("cited", 100, 160);
    const uncited = passage("uncited", 300, 360);
    const frames = [frame("other-source", 110, "kept", OTHER_SRC), frame("in-uncited", 310)];
    expect(pickFrame([cites("a", "cited")], bundleOf([cited, uncited], frames))).toBeNull();
  });

  test("a cited frame beats the passage fallback", () => {
    const p = passage("p1", 100, 160);
    const frames = [frame("during", 101), frame("cited", 400)];
    expect(pickFrame([cites("a", "p1", "cited")], bundleOf([p], frames))?.id).toBe(ev("cited"));
  });

  test("no cited frame and no frame during the passages gives none", () => {
    expect(pickFrame([cites("a", "p1")], bundleOf([passage("p1", 100, 160)], [frame("elsewhere", 500)]))).toBeNull();
    expect(pickFrame([], bundleOf([], [frame("any", 5)]))).toBeNull();
  });
});

describe("what a summary may see and cite", () => {
  test("the cited passages and frames, with the shown frame first and nothing else", () => {
    const p1 = passage("p1", 0, 10);
    const p2 = passage("p2", 10, 20);
    const shown = frame("during", 3);
    const cited = frame("cited", 40);
    const unrelated = frame("unrelated", 70);
    const e = summaryEvidence([cites("a", "p1", "cited")], bundleOf([p1, p2], [cited, shown, unrelated]), shown);
    expect(e.passages.map((p) => p.id)).toEqual([ev("p1")]);
    expect(e.frames.map((f) => f.id)).toEqual([ev("during"), ev("cited")]);
  });

  test("at most MAX_SUMMARY_FRAMES frames, the shown one always kept", () => {
    const many = Array.from({ length: 10 }, (_, i) => frame(`f${i}`, i * 10));
    const claims = [cites("a", ...many.map((_, i) => `f${i}`))];
    const shown = many[9]!;
    const e = summaryEvidence(claims, bundleOf([], many), shown);
    expect(e.frames).toHaveLength(MAX_SUMMARY_FRAMES);
    expect(e.frames[0]!.id).toBe(shown.id);
  });
});

// ───────────────────────────── R19 ─────────────────────────────

describe('R19: "Every line of a diagram summary cites something I watched; a line without a citation is never shown."', () => {
  const allowed = new Set<string>([ev("p1"), ev("f1")]);

  test("a line without a citation is dropped", () => {
    expect(enforceCitations([{ text: "Uncited.", evidence: [] }], allowed)).toEqual([]);
  });

  test("a line citing evidence outside the topic's evidence is dropped whole", () => {
    expect(enforceCitations([{ text: "Foreign.", evidence: [ev("elsewhere")] }, { text: "Mixed.", evidence: [ev("p1"), ev("elsewhere")] }], allowed)).toEqual([]);
  });

  test("a blank line is dropped even when it cites", () => {
    expect(enforceCitations([{ text: "   ", evidence: [ev("p1")] }], allowed)).toEqual([]);
  });

  test("cited lines are kept in order, text untouched, repeated citations collapsed", () => {
    const lines = enforceCitations(
      [{ text: "Clock A reads 5.", evidence: [ev("p1"), ev("p1")] }, { text: "Uncited.", evidence: [] }, { text: "Board shows the arrow.", evidence: [ev("f1")] }],
      allowed,
    );
    expect(lines).toEqual([{ text: "Clock A reads 5.", evidence: [ev("p1")] }, { text: "Board shows the arrow.", evidence: [ev("f1")] }]);
  });
});

// ───────────────────────────── the task, its memo and its usage events ─────────────────────────────

type Reply = { title: string; lines: { text: string; evidence: string[] }[] };

function fakeClaude(reply: (req: ClaudeRequest, n: number) => Reply | Error): ClaudeCli & { readonly requests: ClaudeRequest[] } {
  const requests: ClaudeRequest[] = [];
  return {
    requests,
    async structured<O>(req: ClaudeRequest, schema: z.ZodType<O>) {
      requests.push(req);
      const r = reply(req, requests.length);
      if (r instanceof Error) throw new ProviderError(r.message, usage(), true);
      return { output: schema.parse(r), usage: usage() };
    },
    async streamText() {
      throw new Error("not used");
    },
  };
}

const INPUT = (): DiagramSummaryInput => ({
  topic: { id: TOPIC, label: "Lamport clocks" },
  claims: [{ id: clm("a"), text: "Clocks order events." }],
  passages: [passage("p1", 10, 20), passage("p2", 20, 30)],
  frames: [frame("f1", 12)],
});

describe("the diagram summary task", () => {
  test("lines that cite nothing or something outside the evidence it was shown are dropped before they are stored (R19)", async () => {
    const claude = fakeClaude(() => ({
      title: "How do clocks order events?",
      lines: [
        { text: "Event a at t=3 sends to b.", evidence: [ev("p1")] },
        { text: "Made up without a source.", evidence: [] },
        { text: "Cites something never shown.", evidence: [ev("never-shown")] },
        { text: "The board shows the arrow.", evidence: [ev("f1")] },
      ],
    }));
    const task = diagramSummaryTask(claude, () => null);
    const memo = createMemo(testUserDb(), "live", { retryDelayMs: () => 0 });
    const result = await memo.run(task, INPUT());
    expect(result.kind).toBe("hit");
    const value = (result as { value: DiagramSummaryOutput }).value;
    expect(value.title).toBe("How do clocks order events?");
    expect(value.lines.map((l) => l.text)).toEqual(["Event a at t=3 sends to b.", "The board shows the arrow."]);
    // the stored output is the filtered one
    const stored = memo.inspect(memo.key(task, INPUT()))!.output as { lines: unknown[] };
    expect(stored.lines).toHaveLength(2);
  });

  test("when no line survives the call fails and is tried once more", async () => {
    const claude = fakeClaude(() => ({ title: "t", lines: [{ text: "Uncited.", evidence: [] }] }));
    const memo = createMemo(testUserDb(), "live", { retryDelayMs: () => 0 });
    const result = await memo.run(diagramSummaryTask(claude, () => null), INPUT());
    expect(result.kind).toBe("failed");
    expect(claude.requests).toHaveLength(2);
  });

  test("the prompt names only the evidence given, forbids filling gaps, and attaches the frame image", async () => {
    const claude = fakeClaude(() => ({ title: "t", lines: [{ text: "x", evidence: [ev("p1")] }] }));
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 1]);
    const task = diagramSummaryTask(claude, (id) => (id === ev("f1") ? jpeg : null));
    await createMemo(testUserDb(), "live").run(task, INPUT());
    const req = claude.requests[0]!;
    expect(req.system).toBe(DIAGRAM_SYSTEM);
    expect(req.system).toContain("Never fill a gap");
    expect(req.system).toContain("concrete values and specifics first");
    expect(req.webTools).toBe(false);
    expect(req.prompt).toContain(`${ev("p1")} [10.0s-20.0s] Text of p1.`);
    expect(req.prompt).toContain(`${ev("f1")} at 12.0s (image attached`);
    expect(req.prompt).toContain("Clocks order events.");
    expect(req.images.map((i) => i.label)).toEqual([ev("f1")]);
  });

  test("memoized: the same topic and evidence set is one call, the second request makes none", async () => {
    const claude = fakeClaude(() => ({ title: "t", lines: [{ text: "x", evidence: [ev("p1")] }] }));
    const task = diagramSummaryTask(claude, () => null);
    const memo = createMemo(testUserDb(), "live");
    await memo.run(task, INPUT());
    const again = await memo.run(task, INPUT());
    expect(again.kind).toBe("hit");
    expect(claude.requests).toHaveLength(1);
  });

  test("a different evidence set is a different call", async () => {
    const claude = fakeClaude(() => ({ title: "t", lines: [{ text: "x", evidence: [ev("p1")] }] }));
    const task = diagramSummaryTask(claude, () => null);
    const memo = createMemo(testUserDb(), "live");
    await memo.run(task, INPUT());
    await memo.run(task, { ...INPUT(), passages: [passage("p1", 10, 20)] });
    expect(claude.requests).toHaveLength(2);
  });

  test("R17: each call records a usage event under the diagram_summary purpose, unknown cost stored as unknown", async () => {
    const db = testUserDb();
    const claude = fakeClaude((_r, n) => (n === 1 ? new Error("flaky") : { title: "t", lines: [{ text: "x", evidence: [ev("p1")] }] }));
    const memo = createMemo(db, "live", { retryDelayMs: () => 0 });
    const task = diagramSummaryTask(claude, () => null);
    await memo.run(task, INPUT());
    await memo.run(task, INPUT());
    const events = createLedger(db).list({ memoKey: memo.key(task, INPUT()), limit: 10 });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.outcome).sort()).toEqual(["error", "ok"]);
    expect(events.every((e) => e.purpose === "diagram_summary" && e.provider === "claude")).toBe(true);
    expect(events.every((e) => e.cost.kind === "unknown")).toBe(true);
    expect(createLedger(db).summary().byPurpose.diagram_summary).toEqual({ calls: 2, errors: 1, unknownCost: 2 });
  });
});

// ───────────────────────────── the diagram module ─────────────────────────────

function world(opts: { frames?: Frame[]; claimsFor?: (topic: ConceptId) => AssessableClaim[] } = {}) {
  const p1 = passage("p1", 100, 160);
  const p2 = passage("p2", 200, 260);
  const frames = opts.frames ?? [frame("board", 110)];
  const bundle = { material: Material.of([[SRC, [interval(0, 400)]]]), passages: [p1, p2], frames, gaps: [], ads: [] } as unknown as EvidenceBundle;
  const claim = (id: string, conceptId: ConceptId, ...evidence: string[]): AssessableClaim =>
    ({ id: clm(id), conceptId, text: `Claim ${id}.`, evidence: evidence.map(ev), assumptions: [] }) as unknown as AssessableClaim;
  const claims = opts.claimsFor ? opts.claimsFor : (topic: ConceptId) => (topic === TOPIC ? [claim("a", TOPIC, "p1"), claim("b", TOPIC, "p2")] : []);
  const source: Source = { id: SRC, videoId: "VIDEO000001", title: "Lecture 4", url: "https://www.youtube.com/watch?v=VIDEO000001", channelName: "Prof", durationS: 900 };
  const topics = [{ id: TOPIC, label: "Lamport clocks", summary: "" }, { id: EMPTY_TOPIC, label: "Nothing usable", summary: "" }];
  return {
    review: (id: ReviewId) => (id === REVIEW ? { captureId: CAP, scope: { material: bundle.material } as never, topics } : null),
    usable: () => topics.flatMap((t) => claims(t.id)),
    bundle: () => bundle,
    sources: () => [source],
  };
}

function setup(opts: Parameters<typeof world>[0] = {}, reply?: (n: number) => Reply | Error) {
  const claude = fakeClaude((_r, n) => reply?.(n) ?? { title: "What changes?", lines: [{ text: "Clock A: 5 to 6.", evidence: [ev("p1")] }, { text: "Rule: receive follows send.", evidence: [ev("p2"), ev("board")] }] });
  const task = diagramSummaryTask(claude, () => null);
  const db = testUserDb();
  const memo = createMemo(db, "live", { retryDelayMs: () => 0 });
  const diagrams = createDiagrams({ ...world(opts), task, memo });
  return { claude, task, memo, db, diagrams };
}

describe("the diagram module", () => {
  test("lists every topic with its frame, link data and summary state, and makes no model call", () => {
    const { diagrams, claude } = setup();
    const list = diagrams.list(REVIEW)!;
    expect(list.map((d) => d.label)).toEqual(["Lamport clocks", "Nothing usable"]);
    expect(list[0]!.frame).toEqual({ id: ev("board"), mediaS: media(110), sourceId: SRC, videoId: "VIDEO000001", title: "Lecture 4" });
    expect(list[0]!.summary).toEqual({ state: "not_requested" });
    expect(list[0]!.claimIds).toEqual([clm("a"), clm("b")]);
    expect(claude.requests).toHaveLength(0);
  });

  test("a topic with no usable claim says so and cannot start a call", async () => {
    const { diagrams, claude } = setup();
    const empty = diagrams.list(REVIEW)![1]!;
    expect(empty.summary).toEqual({ state: "no_claims" });
    expect(empty.frame).toBeNull();
    const started = diagrams.request(REVIEW, EMPTY_TOPIC)!;
    await started.settled;
    expect(started.diagram.summary).toEqual({ state: "no_claims" });
    expect(claude.requests).toHaveLength(0);
  });

  test("an unknown review or a topic outside the review is null", () => {
    const { diagrams } = setup();
    expect(diagrams.list(stableId("rvw", "nope") as ReviewId)).toBeNull();
    expect(diagrams.request(stableId("rvw", "nope") as ReviewId, TOPIC)).toBeNull();
    expect(diagrams.request(REVIEW, stableId("cpt", "not-in-scope") as ConceptId)).toBeNull();
  });

  test("a topic with no frame shows the summary alone", async () => {
    const { diagrams } = setup({ frames: [] }, () => ({ title: "t", lines: [{ text: "Only text.", evidence: [ev("p1")] }] }));
    const started = diagrams.request(REVIEW, TOPIC)!;
    await started.settled;
    const topic = diagrams.list(REVIEW)![0]!;
    expect(topic.frame).toBeNull();
    expect(topic.summary.state).toBe("ready");
  });

  test("a request answers 'preparing' while the call runs, then the list shows the lines; the second request makes no call", async () => {
    const { diagrams, claude } = setup();
    const first = diagrams.request(REVIEW, TOPIC)!;
    expect(first.diagram.summary).toEqual({ state: "preparing" });
    expect(diagrams.list(REVIEW)![0]!.summary).toEqual({ state: "preparing" });
    await first.settled;
    const ready = diagrams.list(REVIEW)![0]!.summary;
    expect(ready).toEqual({
      state: "ready",
      title: "What changes?",
      lines: [{ text: "Clock A: 5 to 6.", evidence: [ev("p1")] }, { text: "Rule: receive follows send.", evidence: [ev("p2"), ev("board")] }],
    });
    const second = diagrams.request(REVIEW, TOPIC)!;
    await second.settled;
    expect(second.diagram.summary.state).toBe("ready");
    expect(claude.requests).toHaveLength(1);
  });

  test("the summary is asked for only the topic's evidence: its cited passages and the shown frame", async () => {
    const { diagrams, claude } = setup({ claimsFor: (topic) => (topic === TOPIC ? [{ id: clm("a"), conceptId: TOPIC, text: "Claim a.", evidence: [ev("p1")], assumptions: [] } as unknown as AssessableClaim] : []) });
    await diagrams.request(REVIEW, TOPIC)!.settled;
    const prompt = claude.requests[0]!.prompt;
    expect(prompt).toContain(ev("p1"));
    expect(prompt).not.toContain(ev("p2"));
    expect(prompt).toContain(ev("board"));
  });

  test("a failed call shows as failed, and asking again retries it", async () => {
    const { diagrams, claude } = setup({}, (n) => (n <= 2 ? new Error("claude unavailable") : { title: "t", lines: [{ text: "Retried.", evidence: [ev("p1")] }] }));
    await diagrams.request(REVIEW, TOPIC)!.settled;
    const failed = diagrams.list(REVIEW)![0]!.summary;
    expect(failed.state).toBe("failed");
    expect(claude.requests).toHaveLength(2);
    const retry = diagrams.request(REVIEW, TOPIC)!;
    expect(retry.diagram.summary).toEqual({ state: "preparing" });
    await retry.settled;
    expect(diagrams.list(REVIEW)![0]!.summary.state).toBe("ready");
    expect(claude.requests).toHaveLength(3);
  });

  test("R19 at read time: a stored line that is uncited or cites outside the topic's evidence is never listed", () => {
    // a task whose stored output is bad, as an older version of the task or a hand-edited database could leave it
    const bad: DiagramSummaryOutput = {
      title: "t",
      lines: [
        { text: "Fine.", evidence: [ev("p1")] },
        { text: "Uncited.", evidence: [] as unknown as DiagramLine["evidence"] },
        { text: "Outside the topic.", evidence: [ev("p-other-topic")] as unknown as DiagramLine["evidence"] },
      ],
    };
    const stub: Task<DiagramSummaryInput, DiagramSummaryOutput> = {
      provider: "claude", purpose: "diagram_summary", model: "opus", version: "stub", maxAttempts: 1,
      canonicalInput: (i) => ({ topic: i.topic.id }),
      attempt: async () => ({ output: bad, usage: usage() }),
      decode: (s) => s as DiagramSummaryOutput,
    };
    const memo = createMemo(testUserDb(), "live");
    const diagrams = createDiagrams({ ...world(), task: stub, memo });
    return diagrams.request(REVIEW, TOPIC)!.settled.then(() => {
      const summary = diagrams.list(REVIEW)![0]!.summary;
      expect(summary.state).toBe("ready");
      expect((summary as unknown as { lines: DiagramLine[] }).lines.map((l) => l.text)).toEqual(["Fine."]);
    });
  });

  test("R19 at read time: a stored output with no valid line reads as failed, never as an empty ready page", async () => {
    const stub: Task<DiagramSummaryInput, DiagramSummaryOutput> = {
      provider: "claude", purpose: "diagram_summary", model: "opus", version: "stub2", maxAttempts: 1,
      canonicalInput: (i) => ({ topic: i.topic.id }),
      attempt: async () => ({ output: { title: "t", lines: [{ text: "Uncited.", evidence: [] as unknown as DiagramLine["evidence"] }] }, usage: usage() }),
      decode: (s) => s as DiagramSummaryOutput,
    };
    const diagrams = createDiagrams({ ...world(), task: stub, memo: createMemo(testUserDb(), "live") });
    await diagrams.request(REVIEW, TOPIC)!.settled;
    expect(diagrams.list(REVIEW)![0]!.summary.state).toBe("failed");
  });

  test("replay mode: no model is called and nothing is stored", async () => {
    const claude = fakeClaude(() => new Error("must not be called"));
    const task = diagramSummaryTask(claude, () => null);
    const diagrams = createDiagrams({ ...world(), task, memo: createMemo(testUserDb(), "replay") });
    await diagrams.request(REVIEW, TOPIC)!.settled;
    expect(claude.requests).toHaveLength(0);
    expect(diagrams.list(REVIEW)![0]!.summary.state).toBe("not_requested");
  });
});

// ───────────────────────────── the migration ─────────────────────────────

describe("migration 003-diagram-purpose", () => {
  test("keeps every memo and usage row, still enforces its checks and triggers, and now accepts diagram_summary", () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/afterclass-migration-${crypto.randomUUID()}.sqlite`;
    const old = { ...MIGRATIONS, providers: MIGRATIONS.providers.filter((m) => !m.id.startsWith("003") && !m.id.startsWith("004")) };
    let db = openDb(path, old);
    db.sql.run("INSERT INTO memo_inputs VALUES ('k1','claude','tutor_turn','v','m','{}',1)");
    db.sql.run("INSERT INTO memo VALUES ('k1','{}',1,1)");
    db.sql.run("INSERT INTO memo_failures VALUES ('k1',1,'e',2,0)");
    db.sql.run("INSERT INTO usage_events VALUES ('u1','k1',1,'claude','m','tutor_turn','ok',1,1,1,'unknown',NULL,NULL,'x',1,1)");
    expect(() => db.sql.run("INSERT INTO memo_inputs VALUES ('k0','claude','diagram_summary','v','m','{}',1)")).toThrow();
    db.close();

    db = openDb(path);
    expect(db.sql.query("SELECT COUNT(*) AS n FROM memo_inputs").get()).toEqual({ n: 1 });
    expect(db.sql.query("SELECT COUNT(*) AS n FROM memo").get()).toEqual({ n: 1 });
    expect(db.sql.query("SELECT COUNT(*) AS n FROM memo_failures").get()).toEqual({ n: 1 });
    expect(db.sql.query("SELECT COUNT(*) AS n FROM usage_events").get()).toEqual({ n: 1 });
    expect(db.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.sql.run(`INSERT INTO memo_inputs (user_id, key, provider, purpose, version, model, input_json, first_seen_ms) VALUES ('${LOCAL_USER}','k2','claude','diagram_summary','v','m','{}',1)`);
    db.sql.run(`INSERT INTO usage_events (id, user_id, memo_key, attempt_no, provider, model, purpose, outcome, input_tokens, output_tokens, cache_read_tokens, cost_kind, cost_usd, cost_basis, cost_reason, started_ms, duration_ms)
      VALUES ('u2','${LOCAL_USER}','k2',1,'claude','m','diagram_summary','ok',1,1,1,'unknown',NULL,NULL,'x',1,1)`);
    expect(() => db.sql.run("UPDATE usage_events SET model = 'y'")).toThrow(/R17/);
    expect(() => db.sql.run("DELETE FROM usage_events")).toThrow(/R17/);
    expect(() => db.sql.run("UPDATE memo SET output_json = '1'")).toThrow(/R8/);
    expect(() =>
      db.sql.run(`INSERT INTO usage_events (id, user_id, memo_key, attempt_no, provider, model, purpose, outcome, input_tokens, output_tokens, cache_read_tokens, cost_kind, cost_usd, cost_basis, cost_reason, started_ms, duration_ms)
        VALUES ('u3','${LOCAL_USER}','missing-key',1,'claude','m','tutor_turn','ok',1,1,1,'unknown',NULL,NULL,'x',1,1)`),
    ).toThrow(/FOREIGN KEY/);
    expect(() => db.sql.run(`INSERT INTO memo_inputs (user_id, key, provider, purpose, version, model, input_json, first_seen_ms) VALUES ('${LOCAL_USER}','k3','claude','nonsense','v','m','{}',1)`)).toThrow(/CHECK/);
    db.close();
  });
});
