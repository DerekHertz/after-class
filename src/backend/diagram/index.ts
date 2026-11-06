/**
 * Topic diagrams (flow D: "Ask "show me the diagram" on a topic, any time in the review."). Owns no tables: the
 * summary is a memo entry of the diagram_summary task, so it is cached, single-flight and ledgered like every
 * other model call (R17).
 *
 *   const all = diagrams.list(reviewId);                    // frame + summary state of every topic, no model call
 *   const { diagram, settled } = diagrams.request(reviewId, topicId);   // starts the one call; `settled` resolves when it ends
 *
 * Scope comes only from the review's frozen scope (R7): the claims are those usable now (R3) whose evidence lies inside
 * it, and the evidence is what the review's material holds.
 */
import type { CaptureId, ConceptId, ReviewId, SourceId } from "../../shared/ids";
import type { AssessableClaim, Concept, DiagramFrame, DiagramSummary, EvidenceBundle, FrozenScope, Source, TopicDiagram } from "../../shared/domain";
import type { Material } from "../../shared/time";
import type { Memo } from "../providers/memo";
import type { Task } from "../providers/memo";
import { enforceCitations, evidenceIdsOf, pickFrame, summaryEvidence } from "./core";
import type { DiagramSummaryInput, DiagramSummaryOutput } from "./tasks";

export type { DiagramSummaryInput, DiagramSummaryOutput } from "./tasks";

export type Diagrams = {
  /** Null when there is no such review. */
  list(reviewId: ReviewId): readonly TopicDiagram[] | null;
  /**
   * Null when there is no such review or the topic is not in its scope. Starts the summary call unless one is cached
   * or running; a failed one is cleared and tried again. `diagram` is where things stand now (normally "preparing").
   */
  request(reviewId: ReviewId, topicId: ConceptId): { readonly diagram: TopicDiagram; readonly settled: Promise<void> } | null;
};

export type DiagramDeps = {
  review(reviewId: ReviewId): { readonly captureId: CaptureId; readonly scope: FrozenScope; readonly topics: readonly Concept[] } | null;
  /** The claims usable now inside the review's frozen scope. */
  usable(reviewId: ReviewId): readonly AssessableClaim[];
  bundle(material: Material): EvidenceBundle;
  sources(captureId: CaptureId): readonly Source[];
  task: Task<DiagramSummaryInput, DiagramSummaryOutput>;
  memo: Pick<Memo, "lookup" | "run" | "clearFailures">;
};

export function createDiagrams(deps: DiagramDeps): Diagrams {
  type Plan = { readonly topic: Concept; readonly claimIds: TopicDiagram["claimIds"]; readonly frame: DiagramFrame | null; readonly input: DiagramSummaryInput | null };

  function plansOf(reviewId: ReviewId): readonly Plan[] | null {
    const review = deps.review(reviewId);
    if (review === null) return null;
    const bundle = deps.bundle(review.scope.material);
    const sources = new Map<SourceId, Source>(deps.sources(review.captureId).map((s) => [s.id, s]));
    const usable = deps.usable(reviewId);
    return review.topics.map((topic): Plan => {
      const claims = usable.filter((c) => c.conceptId === topic.id);
      const shown = claims.length === 0 ? null : pickFrame(claims, bundle);
      const frame: DiagramFrame | null = shown === null ? null : {
        id: shown.id, mediaS: shown.mediaS, sourceId: shown.sourceId,
        videoId: sources.get(shown.sourceId)?.videoId ?? null, title: sources.get(shown.sourceId)?.title ?? null,
      };
      const evidence = summaryEvidence(claims, bundle, shown);
      const input: DiagramSummaryInput | null = claims.length === 0
        ? null
        : { topic: { id: topic.id, label: topic.label }, claims: claims.map((c) => ({ id: c.id, text: c.text })), passages: evidence.passages, frames: evidence.frames };
      return { topic, claimIds: claims.map((c) => c.id), frame, input };
    });
  }

  function summaryOf(plan: Plan): DiagramSummary {
    if (plan.input === null) return { state: "no_claims" };
    const found = deps.memo.lookup(deps.task, plan.input);
    switch (found.kind) {
      case "missing": return { state: "not_requested" };
      case "inflight": return { state: "preparing" };
      case "failed": return { state: "failed", error: found.lastError };
      case "hit": {
        // R19 again at read time: whatever was stored, only lines that cite this topic's evidence in scope are shown.
        const lines = enforceCitations(found.value.lines, evidenceIdsOf({ passages: plan.input.passages, frames: plan.input.frames }));
        return lines.length === 0 ? { state: "failed", error: "no summary line cites the topic's evidence" } : { state: "ready", title: found.value.title, lines };
      }
    }
  }

  const diagramOf = (plan: Plan): TopicDiagram => ({ topicId: plan.topic.id, label: plan.topic.label, claimIds: plan.claimIds, frame: plan.frame, summary: summaryOf(plan) });

  return {
    list(reviewId) {
      return plansOf(reviewId)?.map(diagramOf) ?? null;
    },
    request(reviewId, topicId) {
      const plan = plansOf(reviewId)?.find((p) => p.topic.id === topicId);
      if (plan === undefined) return null;
      let settled: Promise<void> = Promise.resolve();
      let started = false;
      if (plan.input !== null) {
        const input = plan.input;
        const current = deps.memo.lookup(deps.task, input);
        if (current.kind === "failed") deps.memo.clearFailures([current.key]);
        if (current.kind !== "hit") {
          started = true;
          settled = deps.memo.run(deps.task, input).then(() => undefined, () => undefined);
        }
      }
      const diagram = diagramOf(plan);
      return { diagram: started && diagram.summary.state !== "ready" ? { ...diagram, summary: { state: "preparing" } } : diagram, settled };
    },
  };
}
