/**
 * Pure record bundle (W8). Importable only by record/ and test/.
 */
import { canonicalJson, stableId } from "../../shared/ids";
import type { ConceptId, EvidenceId, IdPart, ReviewId, ThreadId } from "../../shared/ids";
import type { AssessableClaim, NonEmpty, Note, NoteSegment, Observation, SubjectLinkSuggestion, Turn } from "../../shared/domain";
import type { WrapUpOutput } from "../review/tutor";
import { attributeTurns, moveThreads, threadFacts } from "../review/clamp";

export type RecordBundle = {
  readonly hash: string;
  readonly notes: readonly Omit<Note, "userEdit">[];
  /** `assessable`: every claim the thread asked about was still usable at save (R3). */
  readonly observations: readonly (Omit<Observation, "status" | "clampedFrom" | "dispute" | "corrections"> & { readonly assessable: boolean })[];
  readonly links: readonly SubjectLinkSuggestion[];
  readonly evidence: readonly EvidenceId[];
};

function sortedUnique<T extends string>(xs: Iterable<T>): T[] {
  return [...new Set(xs)].sort();
}

/**
 * R15: "Retrying a save never creates a duplicate record."
 * Same inputs, same bundle, same IDs, same hash.
 * Learner segments are VERBATIM learner turn text (author "learner", turnId
 * set); tutor segments come from the wrap-up summary (author "tutor"); cited
 * source passages are author "source". Attribution is structural, not something
 * the model labels.
 *
 * Per concept discussed (a concept of a claim some ask_main or quick_check named), in order:
 *   source   each discussed claim's evidence-checked text and its evidence IDs
 *   learner  answers and disputes in threads about that concept, verbatim, in turn order
 *   tutor    the wrap-up summary, citing only evidence the claims or tutor turns cited
 * Every thread gets an observation; a thread the wrap-up skipped is proposed not_assessed.
 */
export function buildBundle(reviewId: ReviewId, turns: readonly Turn[], claims: readonly AssessableClaim[], wrapUp: WrapUpOutput, links: readonly SubjectLinkSuggestion[] = []): RecordBundle {
  const ordered = attributeTurns(turns);
  const claimById = new Map(claims.map((c) => [c.id, c]));

  const threads: { readonly id: ThreadId; readonly claims: NonEmpty<AssessableClaim["id"]> }[] = [];
  for (const t of ordered) {
    if (t.actor !== "tutor" || (t.move.kind !== "ask_main" && t.move.kind !== "quick_check")) continue;
    const { threadId, claimIds } = t.move;
    if (!threads.some((x) => x.id === threadId)) threads.push({ id: threadId, claims: claimIds });
  }
  const conceptsOf = (claimIds: readonly AssessableClaim["id"][]): ConceptId[] => sortedUnique(claimIds.flatMap((id) => claimById.get(id)?.conceptId ?? []));

  const proposals = new Map<ThreadId, WrapUpOutput["observations"][number]["proposed"]>();
  for (const o of wrapUp.observations) if (!proposals.has(o.threadId)) proposals.set(o.threadId, o.proposed);

  const observations = threads.map((th) => ({
    id: stableId("obs", reviewId, th.id),
    reviewId,
    threadId: th.id,
    claimIds: th.claims,
    conceptIds: conceptsOf(th.claims),
    proposed: proposals.get(th.id) ?? "not_assessed",
    facts: threadFacts(th.id, ordered),
    assessable: th.claims.every((id) => claimById.has(id)),
  }));

  const known = new Set<string>(claims.flatMap((c) => c.evidence));
  for (const t of ordered) {
    if (t.actor === "tutor" && "evidence" in t.move) for (const id of t.move.evidence) known.add(id);
  }

  const concepts: ConceptId[] = [];
  for (const th of threads) for (const c of conceptsOf(th.claims)) if (!concepts.includes(c)) concepts.push(c);

  const notes = concepts.map((conceptId): Omit<Note, "userEdit"> => {
    const threadIds = new Set(observations.filter((o) => o.conceptIds.includes(conceptId)).map((o) => o.threadId));
    const discussed = sortedUnique(threads.filter((th) => threadIds.has(th.id)).flatMap((th) => th.claims))
      .flatMap((id) => claimById.get(id) ?? [])
      .filter((c) => c.conceptId === conceptId);
    const source: NoteSegment[] = discussed.map((c) => ({ author: "source", text: c.text, turnId: null, evidence: [...c.evidence] }));
    const learner: NoteSegment[] = ordered.flatMap((t): NoteSegment[] =>
      t.actor === "learner" && t.threadId !== null && threadIds.has(t.threadId) && (t.act.kind === "answer" || t.act.kind === "dispute")
        ? [{ author: "learner", text: t.act.text, turnId: t.id, evidence: [] }]
        : [],
    );
    const tutor: NoteSegment[] = wrapUp.notes
      .filter((n) => n.conceptId === conceptId)
      .map((n) => ({ author: "tutor", text: n.tutorSummary, turnId: null, evidence: sortedUnique(n.evidence.filter((id) => known.has(id))) as EvidenceId[] }));
    const generated = [...source, ...learner, ...tutor];
    return {
      id: stableId("note", reviewId, conceptId),
      reviewId,
      conceptId,
      generated,
      evidence: sortedUnique(generated.flatMap((s) => s.evidence)),
    };
  });

  const evidence = sortedUnique([...notes.flatMap((n) => n.evidence), ...links.flatMap((l) => l.evidence)]);
  const body = { notes, observations, links, evidence };
  const hash = new Bun.CryptoHasher("sha256").update(canonicalJson(body as unknown as IdPart)).digest("hex");
  return { hash, ...body };
}

/** Threads a tutor turn touched, for attributing corrections to observations at read time. */
export function correctionsByThread(turns: readonly Turn[]): ReadonlyMap<ThreadId, readonly string[]> {
  const out = new Map<ThreadId, string[]>();
  for (const t of [...turns].sort((a, b) => a.seq - b.seq)) {
    if (t.actor !== "tutor" || t.move.kind !== "disclose_correction") continue;
    for (const th of moveThreads(t.move)) out.set(th, [...(out.get(th) ?? []), t.move.correctionId]);
  }
  return out;
}
