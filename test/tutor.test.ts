import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { stableId } from "../src/shared/ids";
import type { ClaimId, ConceptId, EvidenceId, ResourceId, ReviewId, SourceId, ThreadId, TurnId } from "../src/shared/ids";
import type {
  AssessableClaim, CodeNotice, Correction, EvidenceBundle, Frame, FrozenScope, LearnerAct, Passage, Turn, TutorMove, TutorMoveKind,
} from "../src/shared/domain";
import { Material, interval } from "../src/shared/time";
import { allowedMoves, nextThreadId, parseMoveHeader, reviewState, tutorPrompt, tutorRequest, tutorTask, validateMove, wrapUpTask } from "../src/backend/review/tutor";
import type { TutorInput, WrapUpOutput } from "../src/backend/review/tutor";
import type { ClaudeCli, ClaudeRequest } from "../src/backend/providers/claude";
import { createMemo } from "../src/backend/providers/memo";
import { testUserDb, testSeq, usage } from "./fakes";

const REVIEW = stableId("rvw", "review-1") as ReviewId;
const SRC = stableId("src", "youtube", "abcdefghijk") as SourceId;
const thread = (n: number) => nextThreadId({ reviewId: REVIEW, mainQuestions: n - 1 });
const ev = (n: number) => stableId("ev", "passage", n) as EvidenceId;
const claimId = (n: number) => stableId("clm", n) as ClaimId;
const concept = (n: number) => stableId("cpt", n) as ConceptId;

function claim(n: number): AssessableClaim {
  return { id: claimId(n), conceptId: concept(n), text: `claim ${n}`, evidence: [ev(n)], assumptions: [] } as unknown as AssessableClaim;
}

function passage(n: number, start: number, end: number): Passage {
  return { kind: "passage", id: ev(n), sourceId: SRC, transcriptRevId: stableId("trv", "t"), interval: interval(start, end), text: `passage ${n}`, origin: "panel" } as unknown as Passage;
}

/** Scope is [0, 600) on SRC. ev(99) lies outside it. */
const SCOPE: FrozenScope = {
  chunkRevisions: [stableId("crv", "c1")],
  material: Material.of([[SRC, [interval(0, 600)]]]),
  claimsAtStart: [claimId(1)],
  partial: [],
  frozenAtSeq: testSeq(1),
};
const BUNDLE: EvidenceBundle = {
  material: Material.of([[SRC, [interval(0, 900)]]]),
  passages: [passage(1, 10, 20), passage(2, 30, 40), passage(99, 700, 710)],
  frames: [],
  gaps: [],
  ads: [],
};

/** A turn log builder: seq and atMs advance one step (1 s) per turn. */
function log() {
  const turns: Turn[] = [];
  let n = 0;
  const base = () => {
    n += 1;
    return { id: stableId("turn", n) as TurnId, reviewId: REVIEW, seq: testSeq(n), atMs: n * 1000 };
  };
  const api = {
    turns,
    learner(act: LearnerAct, threadId: ThreadId | null = null) {
      turns.push({ ...base(), actor: "learner", threadId, act });
      return api;
    },
    tutor(move: TutorMove, say = "") {
      const threadId = "threadId" in move ? move.threadId : null;
      turns.push({ ...base(), actor: "tutor", threadId, move, say });
      return api;
    },
    code(notice: CodeNotice) {
      turns.push({ ...base(), actor: "code", threadId: null, notice });
      return api;
    },
  };
  return api;
}

const askMain = (n: number, claims: ClaimId[] = [claimId(1)]): TutorMove => ({ kind: "ask_main", threadId: thread(n), claimIds: claims as [ClaimId, ...ClaimId[]] });
const answer = (text: string): LearnerAct => ({ kind: "answer", text, modality: "text" });

function stateOf(turns: readonly Turn[], corrections: readonly Correction[] = [], nowMs = 1_000_000) {
  return reviewState(REVIEW, turns, corrections, 600, nowMs);
}

const USABLE = [claim(1), claim(2)];

function allowed(turns: readonly Turn[], corrections: readonly Correction[] = [], claims: readonly AssessableClaim[] = USABLE): TutorMoveKind[] {
  return [...allowedMoves(stateOf(turns, corrections), { turns, claims })].sort();
}

function inputFor(turns: readonly Turn[], opts: { corrections?: Correction[]; allowed?: TutorMoveKind[]; claims?: AssessableClaim[] } = {}): TutorInput {
  const state = stateOf(turns, opts.corrections ?? []);
  const claims = opts.claims ?? USABLE;
  return {
    state,
    allowed: opts.allowed ?? [...allowedMoves(state, { turns, claims })],
    scope: SCOPE,
    claims,
    evidence: BUNDLE,
    turns,
    priorObservations: [],
    repairNote: null,
  };
}

describe("parseMoveHeader", () => {
  const header = JSON.stringify(askMain(1));

  test("waits for the end of the header line", () => {
    expect(parseMoveHeader("").kind).toBe("pending");
    expect(parseMoveHeader(header.slice(0, 20)).kind).toBe("pending");
  });

  test("returns the move and the prose after the header line", () => {
    const r = parseMoveHeader(`${header}\nIn your own words, what does`);
    expect(r).toEqual({ kind: "header", move: askMain(1), rest: "In your own words, what does" });
  });

  test("rejects prose-first output before any newline, so nothing could be spoken", () => {
    expect(parseMoveHeader("Great question! Let").kind).toBe("invalid");
    expect(parseMoveHeader("```json\n").kind).toBe("invalid");
  });

  test("rejects a header that is not JSON or not a move", () => {
    expect(parseMoveHeader("{not json\nhello").kind).toBe("invalid");
    expect(parseMoveHeader(`${JSON.stringify({ kind: "ask_main", threadId: "thr_bad", claimIds: [] })}\nhello`).kind).toBe("invalid");
    expect(parseMoveHeader(`${JSON.stringify({ kind: "resolve_dispute", threadId: thread(1) })}\nhello`).kind).toBe("invalid");
  });
});

describe("allowedMoves", () => {
  test("opens with a main question only", () => {
    expect(allowed([])).toEqual(["ask_main"]);
  });

  test("inside a thread: follow up, diagnose, close, or propose a detour", () => {
    const l = log().tutor(askMain(1)).learner(answer("x"), thread(1));
    expect(allowed(l.turns)).toEqual(["ask_followup", "close_thread", "diagnose", "propose_detour"]);
  });

  test("at most 3 main questions, then wrap up", () => {
    const l = log();
    for (const n of [1, 2, 3]) l.tutor(askMain(n)).learner(answer("x"), thread(n)).tutor({ kind: "close_thread", threadId: thread(n) });
    l.learner(answer("more?"));
    expect(allowed(l.turns)).toEqual(["wrap_up"]);
    const forged = inputFor(l.turns, { allowed: ["ask_main"] });
    expect(validateMove({ kind: "ask_main", threadId: thread(4), claimIds: [claimId(1)] }, forged).ok).toBe(false);
  });

  test.each([
    ["hint_request", "hint"],
    ["explain_request", "explain"],
  ] as const)("a %s forces %s, once", (request, move) => {
    const l = log().tutor(askMain(1)).learner({ kind: request }, thread(1));
    expect(allowed(l.turns)).toEqual([move]);
    l.tutor(move === "hint" ? { kind: "hint", threadId: thread(1) } : { kind: "explain", threadId: thread(1), evidence: [] });
    l.learner(answer("ok"), thread(1));
    expect(allowed(l.turns)).toContain("ask_followup");
  });

  test("a dispute forces an answer to it", () => {
    const l = log().tutor(askMain(1)).learner(answer("x"), thread(1)).learner({ kind: "dispute", text: "the lecture said rows" }, thread(1));
    expect(allowed(l.turns)).toEqual(["answer_dispute"]);
    expect(stateOf(l.turns).openDispute).toBe(thread(1));
  });

  test("a pending correction is disclosed before anything else, then the review goes on", () => {
    const correction: Correction = { id: "cor-1", claimId: claimId(1), change: "text_changed", disclosed: false };
    const l = log().tutor(askMain(1)).learner({ kind: "hint_request" }, thread(1));
    expect(allowed(l.turns, [correction])).toEqual(["disclose_correction"]);
    l.tutor({ kind: "disclose_correction", correctionId: "cor-1", threadIds: [thread(1)], evidence: [ev(1)] });
    l.learner(answer("x"), thread(1));
    expect(allowed(l.turns, [correction])).toContain("ask_followup");
  });

  test("#137: a correction to a claim not yet asked about does not hold up the first question", () => {
    const correction: Correction = { id: "cor-2", claimId: claimId(2), change: "text_changed", disclosed: false };
    const l = log().learner({ kind: "begin" });
    expect(allowed(l.turns, [correction])).toEqual(["ask_main"]);
    l.tutor(askMain(1)).learner(answer("x"), thread(1));
    expect(allowed(l.turns, [correction])).not.toContain("disclose_correction");
  });

  test("#137: a correction applied silently stays applied once its claim is asked about", () => {
    const correction: Correction = { id: "cor-1", claimId: claimId(1), change: "text_changed", disclosed: false };
    const l = log()
      .learner({ kind: "begin" })
      .code({ kind: "correction_applied", correctionId: "cor-1", affectedClaims: [claimId(1)] })
      .tutor(askMain(1))
      .learner(answer("x"), thread(1));
    expect(stateOf(l.turns, [correction]).corrections).toMatchObject([{ id: "cor-1", disclosed: true }]);
    expect(allowed(l.turns, [correction])).not.toContain("disclose_correction");
  });

  test("#137: a correction to a claim already asked about is still disclosed, even after its thread closed", () => {
    const correction: Correction = { id: "cor-1", claimId: claimId(1), change: "text_changed", disclosed: false };
    const l = log().learner({ kind: "begin" }).tutor(askMain(1)).learner(answer("x"), thread(1)).tutor({ kind: "close_thread", threadId: thread(1) });
    expect(allowed(l.turns, [correction])).toEqual(["disclose_correction"]);
  });

  test("wrap up or end forces wrap_up; the tutor's wrap_up ends the review", () => {
    for (const act of ["wrap_up", "end"] as const) {
      const l = log().tutor(askMain(1)).learner({ kind: act });
      expect(allowed(l.turns)).toEqual(["wrap_up"]);
      l.tutor({ kind: "wrap_up" });
      expect(stateOf(l.turns).phase).toBe("ended");
      expect(allowed(l.turns)).toEqual([]);
    }
  });

  test("nothing while paused; active time excludes the pause", () => {
    const l = log().tutor(askMain(1)).learner({ kind: "pause" });
    expect(allowed(l.turns)).toEqual([]);
    // Turns land at 1 s, 2 s, 3 s. Paused from 2 s to 3 s, then active until 10 s.
    l.learner({ kind: "resume" });
    expect(stateOf(l.turns, [], 10_000).activeSeconds).toBe(1 + 7);
    expect(allowed(l.turns)).toContain("ask_followup");
  });

  test("ending a paused review leaves the pause so the tutor may only wrap up; the paused time stays out of active time (#136)", () => {
    const l = log().tutor(askMain(1)).learner({ kind: "pause" }).learner({ kind: "end" });
    // Turns land at 1 s, 2 s, 3 s. Active from 1 s to the pause at 2 s, and not after.
    expect(stateOf(l.turns, [], 10_000)).toMatchObject({ phase: "active", wrapUpRequested: true, activeSeconds: 1 });
    expect(allowed(l.turns)).toEqual(["wrap_up"]);
  });
});

describe("R3: a claim being rechecked is out of assessment until it passes again", () => {
  const withdrawn: Correction = { id: "cor-w", claimId: claimId(1), change: "withdrawn", disclosed: false };
  const recheckLog = () => log().tutor(askMain(1)).learner(answer("x"), thread(1));
  const disclose: TutorMove = { kind: "disclose_correction", correctionId: "cor-w", threadIds: [thread(1)], evidence: [ev(1)] };
  const ALL: TutorMoveKind[] = ["ask_followup", "diagnose", "hint", "explain", "answer_dispute", "close_thread"];
  const onThread: TutorMove[] = [
    { kind: "ask_followup", threadId: thread(1) },
    { kind: "diagnose", threadId: thread(1), hypothesis: "h", evidence: [ev(2)] },
    { kind: "hint", threadId: thread(1) },
    { kind: "explain", threadId: thread(1), evidence: [ev(2)] },
  ];

  test("an open question on it pauses: the tutor says why, then may only close the thread", () => {
    const l = recheckLog();
    expect(allowed(l.turns, [withdrawn], [claim(2)])).toEqual(["disclose_correction"]);
    l.tutor(disclose).learner(answer("y"), thread(1));
    expect(allowed(l.turns, [withdrawn], [claim(2)])).toEqual(["close_thread"]);
  });

  test("a hint, explain or dispute request on the paused thread does not reopen it", () => {
    for (const act of [{ kind: "hint_request" }, { kind: "explain_request" }, { kind: "dispute", text: "no" }] as const) {
      const l = recheckLog().tutor(disclose).learner(act, thread(1));
      expect(allowed(l.turns, [withdrawn], [claim(2)])).toEqual(["close_thread"]);
    }
  });

  test("validateMove rejects any move on the paused thread but closing it, whatever the allowed set says", () => {
    const l = recheckLog().tutor(disclose).learner(answer("y"), thread(1));
    const input = inputFor(l.turns, { corrections: [withdrawn], claims: [claim(2)], allowed: ALL });
    for (const move of onThread) expect(validateMove(move, input).ok).toBe(false);
    expect(validateMove({ kind: "close_thread", threadId: thread(1) }, input).ok).toBe(true);
  });

  test("a claim that passes again puts the thread back in assessment", () => {
    const l = recheckLog().tutor(disclose).learner(answer("y"), thread(1));
    expect(allowed(l.turns, [], USABLE)).toContain("ask_followup");
    const input = inputFor(l.turns, { claims: USABLE, allowed: ALL });
    for (const move of onThread) expect(validateMove(move, input).ok).toBe(true);
  });
});

describe("R11: detours", () => {
  const proposal: TutorMove = { kind: "propose_detour", topic: "row picture", reason: "seems unsure about rows", needsResource: null };

  test("detour_step is not allowed after a proposal, only after the learner accepts", () => {
    const l = log().tutor(askMain(1)).learner(answer("x"), thread(1)).tutor(proposal);
    expect(allowed(l.turns)).not.toContain("detour_step");
    expect(validateMove({ kind: "detour_step" }, inputFor(l.turns, { allowed: ["detour_step"] })).ok).toBe(false);
    l.learner({ kind: "detour_accept" });
    expect(allowed(l.turns)).toEqual(["detour_step"]);
    expect(validateMove({ kind: "detour_step" }, inputFor(l.turns)).ok).toBe(true);
  });

  test("a declined or ignored proposal never becomes a detour", () => {
    const declined = log().tutor(askMain(1)).tutor(proposal).learner({ kind: "detour_decline" });
    const ignored = log().tutor(askMain(1)).tutor(proposal).learner(answer("x"), thread(1)).learner({ kind: "detour_accept" });
    for (const l of [declined, ignored]) {
      expect(stateOf(l.turns).detour.kind).toBe("none");
      expect(allowed(l.turns)).not.toContain("detour_step");
    }
  });

  test("a learner accept with no proposal starts nothing", () => {
    const l = log().tutor(askMain(1)).learner({ kind: "detour_accept" });
    expect(allowed(l.turns)).not.toContain("detour_step");
  });

  test("a detour that needs a pending resource waits until it arrives or the learner continues without it", () => {
    const res = stableId("res", "r1") as ResourceId;
    const base = () => log().tutor(askMain(1)).tutor({ ...proposal, needsResource: res }).learner({ kind: "detour_accept" });
    const waiting = base().learner({ kind: "detour_wait" });
    expect(stateOf(waiting.turns).detour.kind).toBe("awaiting_resource");
    expect(allowed(waiting.turns)).not.toContain("detour_step");
    expect(stateOf(base().code({ kind: "resource_ready", resourceId: res }).turns).detour.kind).toBe("active");
    expect(stateOf(base().learner({ kind: "detour_continue_without_resource" }).turns).detour.kind).toBe("active");
  });

  test("returning to the lecture ends the detour", () => {
    const l = log().tutor(askMain(1)).tutor(proposal).learner({ kind: "detour_accept" }).tutor({ kind: "detour_step" }).learner(answer("y"), thread(1));
    expect(allowed(l.turns)).toContain("detour_step");
    l.tutor({ kind: "ask_followup", threadId: thread(1) });
    expect(stateOf(l.turns).detour.kind).toBe("none");
  });
});

describe("validateMove", () => {
  test("R3: ask_main may name only usable claims, on the thread code minted", () => {
    const input = inputFor([]);
    expect(validateMove(askMain(1, [claimId(1), claimId(2)]), input)).toEqual({ ok: true });
    expect(validateMove(askMain(1, [claimId(3)]), input).ok).toBe(false);
    expect(validateMove({ kind: "ask_main", threadId: thread(2), claimIds: [claimId(1)] }, input).ok).toBe(false);
  });

  test("a move outside the allowed set is rejected", () => {
    const input = inputFor([]);
    expect(validateMove({ kind: "wrap_up" }, input).ok).toBe(false);
  });

  test("R7: cited evidence must lie inside the frozen scope", () => {
    const l = log().tutor(askMain(1)).learner(answer("columns"), thread(1));
    const diagnose = (evidence: EvidenceId[]): TutorMove => ({ kind: "diagnose", threadId: thread(1), hypothesis: "mixes rows and columns", evidence });
    expect(validateMove(diagnose([ev(1)]), inputFor(l.turns)).ok).toBe(true);
    expect(validateMove(diagnose([ev(99)]), inputFor(l.turns)).ok).toBe(false);
    expect(validateMove(diagnose([stableId("ev", "never shown") as EvidenceId]), inputFor(l.turns)).ok).toBe(false);
  });

  test("R7: a frame exactly at the scope's end is outside the half-open scope", () => {
    const frame = (n: number, at: number) => ({ kind: "frame", id: stableId("ev", "frame", n), sourceId: SRC, mediaS: at, width: 1, height: 1 }) as unknown as Frame;
    const l = log().tutor(askMain(1)).learner({ kind: "explain_request" }, thread(1));
    const input = { ...inputFor(l.turns), evidence: { ...BUNDLE, frames: [frame(1, 599.5), frame(2, 600)] } };
    const explain = (n: number): TutorMove => ({ kind: "explain", threadId: thread(1), evidence: [stableId("ev", "frame", n) as EvidenceId] });
    expect(validateMove(explain(1), input).ok).toBe(true);
    expect(validateMove(explain(2), input).ok).toBe(false);
  });

  test("one source-grounded diagnostic question per thread", () => {
    const l = log().tutor(askMain(1)).learner(answer("columns"), thread(1));
    const diagnose: TutorMove = { kind: "diagnose", threadId: thread(1), hypothesis: "h", evidence: [ev(1)] };
    expect(validateMove({ ...diagnose, evidence: [] }, inputFor(l.turns)).ok).toBe(false);
    l.tutor(diagnose).learner(answer("rows?"), thread(1));
    expect(validateMove(diagnose, inputFor(l.turns)).ok).toBe(false);
  });

  test("a dispute answer rechecks the source on the disputed thread", () => {
    const l = log().tutor(askMain(1)).learner(answer("x"), thread(1)).learner({ kind: "dispute", text: "no" }, thread(1));
    const input = inputFor(l.turns);
    expect(validateMove({ kind: "answer_dispute", threadId: thread(1), evidence: [ev(1)], settled: false }, input).ok).toBe(true);
    expect(validateMove({ kind: "answer_dispute", threadId: thread(1), evidence: [], settled: false }, input).ok).toBe(false);
    expect(validateMove({ kind: "answer_dispute", threadId: thread(2), evidence: [ev(1)], settled: false }, input).ok).toBe(false);
  });

  test("follow-ups stay on the open thread", () => {
    const l = log().tutor(askMain(1)).learner(answer("x"), thread(1));
    expect(validateMove({ kind: "ask_followup", threadId: thread(1) }, inputFor(l.turns)).ok).toBe(true);
    expect(validateMove({ kind: "ask_followup", threadId: thread(2) }, inputFor(l.turns)).ok).toBe(false);
  });
});

/** A fake `claude -p` that replays scripted replies as stream deltas. No process, no network. */
function fakeClaude(replies: string[]) {
  const requests: ClaudeRequest[] = [];
  const cli: ClaudeCli = {
    async streamText(req, onText) {
      requests.push(req);
      const text = replies.shift() ?? "";
      for (const chunk of text.match(/.{1,7}/gs) ?? []) onText(chunk);
      return { text, usage: usage({ kind: "notional", usd: 0.01, basis: "claude_subscription" }) };
    },
    async structured<O>(req: ClaudeRequest, schema: z.ZodType<O>) {
      requests.push(req);
      return { output: schema.parse(JSON.parse(replies.shift() ?? "null")), usage: usage() };
    },
  };
  return { cli, requests };
}

describe("tutorTask", () => {
  const opening = `${JSON.stringify(askMain(1))}\nWithout looking back, how would you describe the row picture?\n`;

  test("streams the reply and stores the validated move with its prose", async () => {
    const { cli, requests } = fakeClaude([opening]);
    const memo = createMemo(testUserDb(), "live", { retryDelayMs: () => 0 });
    let streamed = "";
    const r = await memo.run(tutorTask(cli), inputFor([]), { streamTo: (d) => (streamed += d) });
    expect(r.kind).toBe("hit");
    if (r.kind !== "hit") return;
    expect(r.value).toEqual({ move: askMain(1), say: "Without looking back, how would you describe the row picture?" });
    expect(streamed).toBe(opening);
    expect(requests[0]!.prompt).toContain(thread(1));
    expect(requests[0]!.system).toContain(claimId(1));
  });

  test("a resent turn at a later time hits the memo instead of calling again", async () => {
    const { cli, requests } = fakeClaude([opening, opening]);
    const memo = createMemo(testUserDb(), "live", { retryDelayMs: () => 0 });
    const l = log().learner({ kind: "resume" });
    const first = { ...inputFor(l.turns), state: stateOf(l.turns, [], 5_000) };
    const resent = { ...inputFor(l.turns), state: stateOf(l.turns, [], 90_000) };
    await memo.run(tutorTask(cli), first);
    const again = await memo.run(tutorTask(cli), resent);
    expect(again.kind).toBe("hit");
    expect(requests).toHaveLength(1);
  });

  test.each([
    ["prose before the header", "Sure! Let's start.\n"],
    ["a move that is not allowed", `${JSON.stringify({ kind: "wrap_up" })}\nThat's all.`],
    ["an unusable claim", `${JSON.stringify(askMain(1, [claimId(3)]))}\nTell me about it.`],
  ])("%s is never stored as the tutor's move", async (_, reply) => {
    const { cli } = fakeClaude([reply]);
    const db = testUserDb();
    const memo = createMemo(db, "live", { retryDelayMs: () => 0 });
    const r = await memo.run(tutorTask(cli), inputFor([]));
    expect(r.kind).toBe("failed");
    expect(db.sql.query("SELECT COUNT(*) AS n FROM memo").get()).toEqual({ n: 0 });
    expect(db.sql.query("SELECT outcome, cost_kind FROM usage_events").all()).toEqual([{ outcome: "error", cost_kind: "notional" }]);
  });
});

describe("wrapUpTask", () => {
  test("returns the parsed proposal", async () => {
    const proposal: WrapUpOutput = {
      observations: [{ threadId: thread(1), proposed: "partial", rationale: "mixed rows and columns" }],
      notes: [{ conceptId: concept(1), tutorSummary: "Rows meet at the solution.", evidence: [ev(1)] }],
    };
    const { cli } = fakeClaude([JSON.stringify(proposal)]);
    const memo = createMemo(testUserDb(), "live", { retryDelayMs: () => 0 });
    const r = await memo.run(wrapUpTask(cli), { turns: [], claims: [claim(1)], threads: [thread(1)] });
    expect(r.kind === "hit" && r.value).toEqual(proposal);
  });

  test("a proposal with a malformed thread id is rejected", async () => {
    const { cli } = fakeClaude([JSON.stringify({ observations: [{ threadId: "thread-1", proposed: "partial", rationale: "" }], notes: [] })]);
    const memo = createMemo(testUserDb(), "live", { retryDelayMs: () => 0 });
    expect((await memo.run(wrapUpTask(cli), { turns: [], claims: [claim(1)], threads: [thread(1)] })).kind).toBe("failed");
  });
});


describe("begin", () => {
  const begin: LearnerAct = { kind: "begin" };
  test("after the opening begin the allowed moves are those of an empty review", () => {
    expect(allowed(log().learner(begin).turns)).toEqual(allowed([]));
    expect(allowed(log().learner(begin).turns)).toEqual(["ask_main"]);
  });
  test("the prompt says the learner opened the review, with no empty-log text", () => {
    const prompt = tutorPrompt(inputFor(log().learner(begin).turns));
    expect(prompt).toContain("(learner opened the review)");
    expect(prompt).not.toContain("(no turns yet");
  });
});

describe("#135 prompt caching: stable material first, per-turn state last", () => {
  test("two turns send the same system text byte for byte and differ only in the per-turn prompt", () => {
    const first = log().learner({ kind: "begin" });
    const second = log().learner({ kind: "begin" }).tutor(askMain(1), "In your own words?").learner(answer("it orders events"), thread(1));
    const a = tutorRequest(inputFor(first.turns));
    const b = tutorRequest(inputFor(second.turns));
    expect(b.system).toBe(a.system);
    expect(b.prompt).not.toBe(a.prompt);
    for (const stable of ["claim 1", "claim 2", "passage 1", "passage 2"]) {
      expect(a.system).toContain(stable);
      expect(a.prompt).not.toContain(stable);
    }
    for (const perTurn of ["Allowed moves this turn", "Main questions asked", "Open thread", "Review so far"]) {
      expect(a.system).not.toContain(perTurn);
      expect(b.prompt).toContain(perTurn);
    }
  });
});
