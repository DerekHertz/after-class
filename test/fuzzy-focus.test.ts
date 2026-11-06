/**
 * Fuzzy focus (flow D, approved 2026-11-06): the learner marks the topics they are fuzzy on, main questions go there
 * first, then at most 3 quick checks on unmarked topics. R18: a quick check is never recorded as understood.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stableId } from "../src/shared/ids";
import type { ClaimId, ConceptId, EvidenceId, ReviewId, ThreadId, TurnId } from "../src/shared/ids";
import type { AssessableClaim, Concept, EvidenceBundle, FrozenScope, LearnerAct, Turn, TutorMove, TutorMoveKind } from "../src/shared/domain";
import { Material } from "../src/shared/time";
import { allowedMoves, nextThreadId, reviewState, tutorPrompt, validateMove } from "../src/backend/review/tutor";
import type { TutorInput } from "../src/backend/review/tutor";
import { clampStatus, quickCheckThreads, threadFacts } from "../src/backend/review/clamp";
import { buildBundle } from "../src/backend/record/core";
import { testSeq } from "./fakes";

const ROOT = join(import.meta.dir, "..");
const DOC = readFileSync(join(ROOT, "docs/flows/after-class.md"), "utf8");

describe("flow doc: the approved lines are byte-identical", () => {
  test("section D opens with the checklist lines, replacing the single open-recall line", () => {
    const lines = [
      "[code]  Show the topics in the frozen scope as a checklist.",
      "[user]  Mark the topics I'm fuzzy on (or none), optionally add a note on what feels fuzzy.",
      "[agent] Main questions go to the fuzzy topics first; follow-ups as needed.",
      "[agent] Then quick checks on the rest: one short recall question each, on a sample",
      "        of at most 3 unmarked topics. A clear answer moves on; a shaky one becomes",
      "        a main question if any are left.",
      "[agent] No topics marked → today's behavior (open recall question, no recap first).",
      "[user] Speak/type an answer, skip, \"I don't know\", hint, explain-it, pause, end.",
    ].join("\n");
    expect(DOC).toContain(`\`\`\`text\n${lines}`);
    expect(DOC).not.toContain("[agent] Open recall question on the frozen scope (no recap first).");
    expect(DOC).toContain("[agent] Up to 3 main questions; follow-ups as needed. Evidence shown beside.");
  });

  test("R18 follows R17, byte for byte", () => {
    const r17 = "- R17 `[test]` Every paid call records a usage event; unknown cost is stored as unknown, not zero.\n";
    const r18 = "- R18 `[test]` A quick check I pass only shows the topic looks fine; it's never recorded as understood the way a main question is.\n";
    expect(DOC).toContain(r17 + r18);
    expect(DOC).toContain("R18 was drafted by the agent and approved by Derek as written on 2026-11-06.");
  });

  test("the amendment quotes Derek's request and approval verbatim", () => {
    expect(DOC).toContain("Amendment (2026-11-06), Derek: \"I was also thinking it's probably easier if I also state like, here are the areas that like I'm a little bit fuzzy on, and those are the areas that we focus, but then the tutor kind of just checks very quickly that the other areas are good as well.\"");
    expect(DOC).toContain("Derek replied \"Approve as written\"");
  });
});

const REVIEW = stableId("rvw", "fuzzy") as ReviewId;
const claimId = (n: number) => stableId("clm", n) as ClaimId;
const concept = (n: number) => stableId("cpt", n) as ConceptId;
const ev = (n: number) => stableId("ev", "passage", n) as EvidenceId;
const claim = (n: number): AssessableClaim => ({ id: claimId(n), conceptId: concept(n), text: `claim ${n}`, evidence: [ev(n)], assumptions: [] }) as unknown as AssessableClaim;
const CLAIMS = [1, 2, 3, 4, 5].map(claim);

function log() {
  const turns: Turn[] = [];
  let n = 0;
  const base = () => (n += 1, { id: stableId("turn", n) as TurnId, reviewId: REVIEW, seq: testSeq(n), atMs: n * 1000 });
  const api = {
    turns,
    learner(act: LearnerAct) { turns.push({ ...base(), actor: "learner", threadId: null, act }); return api; },
    tutor(move: TutorMove) { turns.push({ ...base(), actor: "tutor", threadId: "threadId" in move ? move.threadId : null, move, say: "ok" }); return api; },
  };
  return api;
}

const answer: LearnerAct = { kind: "answer", text: "an ordering", modality: "text" };
const begin = (...fuzzy: number[]): LearnerAct => ({ kind: "begin", fuzzy: fuzzy.map(concept) });
const stateOf = (turns: readonly Turn[]) => reviewState(REVIEW, turns, [], 600, 1_000_000);
const allowed = (turns: readonly Turn[], claims = CLAIMS): TutorMoveKind[] => [...allowedMoves(stateOf(turns), { turns, claims })].sort();
const nextId = (turns: readonly Turn[]): ThreadId => nextThreadId(stateOf(turns));
const main = (turns: readonly Turn[], ...claims: number[]): TutorMove => ({ kind: "ask_main", threadId: nextId(turns), claimIds: claims.map(claimId) as [ClaimId, ...ClaimId[]] });
const quick = (turns: readonly Turn[], ...claims: number[]): TutorMove => ({ kind: "quick_check", threadId: nextId(turns), claimIds: claims.map(claimId) as [ClaimId, ...ClaimId[]] });
const close = (threadId: ThreadId): TutorMove => ({ kind: "close_thread", threadId });

const SCOPE = { chunkRevisions: [stableId("crv", "c")], material: Material.empty, claimsAtStart: [claimId(1)], partial: [], frozenAtSeq: testSeq(1) } as unknown as FrozenScope;
const BUNDLE = { material: Material.empty, passages: [], frames: [], gaps: [], ads: [] } as unknown as EvidenceBundle;
function verdict(turns: readonly Turn[], move: TutorMove, claims = CLAIMS) {
  const state = stateOf(turns);
  const input: TutorInput = { state, allowed: [...allowedMoves(state, { turns, claims })], scope: SCOPE, claims, evidence: BUNDLE, turns, priorObservations: [], repairNote: null };
  return validateMove(move, input);
}

/** The log after the fuzzy topic (concept 2) got its main question, was answered and closed. */
function afterFuzzy() {
  const l = log().learner(begin(2));
  l.tutor(main(l.turns, 2));
  const t = l.turns.at(-1) as Extract<Turn, { actor: "tutor" }>;
  l.learner(answer).tutor(close((t.move as { threadId: ThreadId }).threadId));
  return l;
}

describe("allowedMoves: fuzzy topics first", () => {
  test("no topics marked: today's behaviour, main questions up to 3 then wrap up, never a quick check", () => {
    const l = log().learner({ kind: "begin" });
    expect(allowed(l.turns)).toEqual(["ask_main"]);
    for (let i = 0; i < 3; i++) {
      l.tutor(main(l.turns, i + 1)).learner(answer);
      expect(allowed(l.turns)).toEqual(["ask_followup", "close_thread", "diagnose", "propose_detour"]);
      l.tutor(close(nextThreadIdOfLast(l.turns)));
    }
    expect(allowed(l.turns)).toEqual(["wrap_up"]);
    expect(allowed(log().learner(begin()).turns)).toEqual(["ask_main"]);
  });

  test("marked topics get the main questions first: a main question on an unmarked topic is refused", () => {
    const l = log().learner(begin(2));
    expect(allowed(l.turns)).toEqual(["ask_main"]);
    expect(verdict(l.turns, main(l.turns, 1)).ok).toBe(false);
    expect(verdict(l.turns, main(l.turns, 2)).ok).toBe(true);
    expect(verdict(l.turns, main(l.turns, 1, 2)).ok).toBe(true);
    expect(verdict(l.turns, quick(l.turns, 1)).ok).toBe(false);
  });

  test("quick checks come only after the fuzzy topics are covered", () => {
    const l = log().learner(begin(2, 3));
    l.tutor(main(l.turns, 2)).learner(answer).tutor(close(nextThreadIdOfLast(l.turns)));
    // concept 3 is marked and still unasked
    expect(allowed(l.turns)).toEqual(["ask_main"]);
    expect(verdict(l.turns, quick(l.turns, 1)).ok).toBe(false);
    l.tutor(main(l.turns, 3)).learner(answer).tutor(close(nextThreadIdOfLast(l.turns)));
    expect(allowed(l.turns)).toEqual(["quick_check"]);
    expect(verdict(l.turns, quick(l.turns, 1)).ok).toBe(true);
  });

  test("a quick check goes on one unmarked topic that has not been asked or checked", () => {
    const l = afterFuzzy();
    expect(verdict(l.turns, quick(l.turns, 2)).ok).toBe(false); // marked and already asked
    expect(verdict(l.turns, quick(l.turns, 1, 3)).ok).toBe(false); // two topics
    expect(verdict(l.turns, quick(l.turns, 1)).ok).toBe(true);
    l.tutor(quick(l.turns, 1)).learner(answer).tutor(close(nextThreadIdOfLast(l.turns)));
    expect(verdict(l.turns, quick(l.turns, 1)).ok).toBe(false); // already checked
    expect(verdict(l.turns, quick(l.turns, 3)).ok).toBe(true);
  });

  test("at most 3 quick checks, then wrap up", () => {
    const l = afterFuzzy();
    for (const c of [1, 3, 4]) {
      expect(allowed(l.turns)).toEqual(["quick_check"]);
      l.tutor(quick(l.turns, c)).learner(answer).tutor(close(nextThreadIdOfLast(l.turns)));
    }
    expect(stateOf(l.turns).quickChecks).toBe(3);
    expect(allowed(l.turns)).toEqual(["wrap_up"]);
    expect(verdict(l.turns, quick(l.turns, 5)).ok).toBe(false);
  });

  test("quick checks are not main questions and get their own thread ids", () => {
    const l = afterFuzzy();
    const before = stateOf(l.turns);
    l.tutor(quick(l.turns, 1));
    const after = stateOf(l.turns);
    expect(after.mainQuestions).toBe(before.mainQuestions);
    expect(after.quickChecks).toBe(1);
    expect(nextId(l.turns)).not.toBe((l.turns.at(-1) as Extract<Turn, { actor: "tutor" }>).threadId!);
  });

  test("a clear answer closes the quick check; a shaky one may become a main question on that topic only while fewer than 3 were asked", () => {
    const l = afterFuzzy();
    l.tutor(quick(l.turns, 1)).learner(answer);
    expect(allowed(l.turns)).toEqual(["ask_main", "close_thread"]);
    expect(verdict(l.turns, main(l.turns, 1)).ok).toBe(true);
    expect(verdict(l.turns, main(l.turns, 3)).ok).toBe(false); // not the quick-checked topic
    // three main questions already asked: only close
    const full = log().learner(begin(1, 2, 3));
    for (const c of [1, 2, 3]) full.tutor(main(full.turns, c)).learner(answer).tutor(close(nextThreadIdOfLast(full.turns)));
    full.tutor(quick(full.turns, 4)).learner(answer);
    expect(stateOf(full.turns).mainQuestions).toBe(3);
    expect(allowed(full.turns)).toEqual(["close_thread"]);
    expect(verdict(full.turns, main(full.turns, 4)).ok).toBe(false);
  });

  test("a quick check cannot be followed up, diagnosed or detoured", () => {
    const l = afterFuzzy();
    l.tutor(quick(l.turns, 1)).learner(answer);
    expect(allowed(l.turns)).not.toContain("ask_followup");
    expect(allowed(l.turns)).not.toContain("diagnose");
    expect(allowed(l.turns)).not.toContain("propose_detour");
  });

  test("quick checks use only usable claims (R3)", () => {
    const l = afterFuzzy();
    expect(verdict(l.turns, quick(l.turns, 1), CLAIMS.filter((c) => c.id !== claimId(1))).ok).toBe(false);
  });

  test("marked topics with no usable claim: behave as today and never quick-check", () => {
    const usable = [claim(1), claim(3)];
    const l = log().learner(begin(2));
    expect(allowed(l.turns, usable)).toEqual(["ask_main"]);
    expect(verdict(l.turns, main(l.turns, 1), usable).ok).toBe(true);
    expect(verdict(l.turns, quick(l.turns, 1), usable).ok).toBe(false);
    for (const c of [1, 3]) l.tutor(main(l.turns, c)).learner(answer).tutor(close(nextThreadIdOfLast(l.turns)));
    expect(allowed(l.turns, usable)).toEqual(["ask_main"]);
  });

  test("the prompt names the marked topics, the learner's note and the quick-check budget", () => {
    const l = log().learner({ kind: "begin", fuzzy: [concept(2)], note: "the ordering part" });
    const topics: Concept[] = [{ id: concept(2), label: "Vector clocks", summary: "s" }];
    const state = stateOf(l.turns);
    const prompt = tutorPrompt({ state, allowed: ["ask_main"], topics, scope: SCOPE, claims: CLAIMS, evidence: BUNDLE, turns: l.turns, priorObservations: [], repairNote: null });
    expect(prompt).toContain("Vector clocks");
    expect(prompt).toContain("the ordering part");
    expect(prompt).toContain("Quick checks asked: 0 of 3");
  });
});

/** The thread of the latest tutor turn. */
function nextThreadIdOfLast(turns: readonly Turn[]): ThreadId {
  const t = [...turns].reverse().find((x): x is Extract<Turn, { actor: "tutor" }> => x.actor === "tutor" && "threadId" in x.move)!;
  return (t.move as { threadId: ThreadId }).threadId;
}

describe("R18: a quick check is never recorded as understood", () => {
  const facts = (turns: readonly Turn[], thread: ThreadId) => threadFacts(thread, turns);

  test("a passed quick check is recorded as looks_fine, not independent, whatever the tutor proposed or the learner overrides", () => {
    const l = afterFuzzy();
    l.tutor(quick(l.turns, 1)).learner(answer);
    const thread = nextThreadIdOfLast(l.turns);
    expect(quickCheckThreads(l.turns).has(thread)).toBe(true);
    const f = facts(l.turns, thread);
    expect(clampStatus("independent", f, { kind: "none" }, true, true)).toEqual({ status: "looks_fine", clampedFrom: "independent" });
    // the same thread as a main question is independent
    expect(clampStatus("independent", f, { kind: "none" }, true, false).status).toBe("independent");
    // never anything that counts as understood
    for (const proposed of ["independent", "partial", "after_help", "unresolved", "not_assessed"] as const) {
      expect(clampStatus(proposed, f, { kind: "none" }, true, true).status).not.toBe("independent");
    }
  });

  test("a skipped quick check is still not assessed (R13) and a shaky one stays partial", () => {
    const l = afterFuzzy();
    l.tutor(quick(l.turns, 1)).learner({ kind: "skip" });
    const f = facts(l.turns, nextThreadIdOfLast(l.turns));
    expect(clampStatus("independent", f, { kind: "none" }, true, true).status).toBe("not_assessed");
    expect(clampStatus("partial", facts(afterAnswer().turns, nextThreadIdOfLast(afterAnswer().turns)), { kind: "none" }, true, true).status).toBe("partial");
  });

  test("the record bundle gives a quick-check thread its own observation", () => {
    const l = afterFuzzy();
    l.tutor(quick(l.turns, 1)).learner(answer);
    const thread = nextThreadIdOfLast(l.turns);
    const bundle = buildBundle(REVIEW, l.turns, CLAIMS, { observations: [{ threadId: thread, proposed: "independent", rationale: "r" }], notes: [] });
    const obs = bundle.observations.find((o) => o.threadId === thread)!;
    expect(obs.proposed).toBe("independent");
    expect(obs.conceptIds).toEqual([concept(1)]);
  });
});

function afterAnswer() {
  const l = afterFuzzy();
  l.tutor(quick(l.turns, 1)).learner(answer);
  return l;
}
