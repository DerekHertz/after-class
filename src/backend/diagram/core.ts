/**
 * Pure logic for topic diagrams (flow D, "show me the diagram"): which frame a topic shows, which evidence its
 * summary may cite, and the rule that decides which summary lines are ever shown.
 */
import type { ClaimId, EvidenceId } from "../../shared/ids";
import type { DiagramLine, EvidenceBundle, Frame, NonEmpty, Passage } from "../../shared/domain";

export type CitingClaim = { readonly id: ClaimId; readonly text: string; readonly evidence: readonly EvidenceId[] };

/** Most images one summary call attaches. The chosen frame always comes first. */
export const MAX_SUMMARY_FRAMES = 6;

const byTime = (a: Frame, b: Frame) => a.mediaS - b.mediaS || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The frames in scope that the claims cite, with how many citations each has. */
function citedFrames(claims: readonly CitingClaim[], frames: readonly Frame[]): Map<EvidenceId, number> {
  const inScope = new Set<EvidenceId>(frames.map((f) => f.id));
  const counts = new Map<EvidenceId, number>();
  for (const claim of claims) for (const id of new Set(claim.evidence)) if (inScope.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

/** The passages in scope that the claims cite. */
export function citedPassages(claims: readonly CitingClaim[], passages: readonly Passage[]): Passage[] {
  const cited = new Set<EvidenceId>(claims.flatMap((c) => c.evidence));
  return passages.filter((p) => cited.has(p.id));
}

/**
 * The frame a topic shows. Flow D: "Show the frame that topic's claims cite (or, if none, the frame captured
 * during its cited passages), with its time and a link to that moment."
 *  1. the frame cited by the most usable claims of the topic; a tie goes to the earliest;
 *  2. else a frame captured during one of its cited passages, nearest to that passage's start, a kept frame
 *     before an uncertain or unjudged one;
 *  3. else none.
 * Only frames inside the review's scope are candidates (R7).
 */
export function pickFrame(claims: readonly CitingClaim[], bundle: Pick<EvidenceBundle, "passages" | "frames">): Frame | null {
  const counts = citedFrames(claims, bundle.frames);
  if (counts.size > 0) {
    const ranked = bundle.frames.filter((f) => counts.has(f.id)).sort((a, b) => counts.get(b.id)! - counts.get(a.id)! || byTime(a, b));
    return ranked[0]!;
  }
  const passages = citedPassages(claims, bundle.passages);
  let best: { readonly frame: Frame; readonly rank: number; readonly distance: number } | null = null;
  for (const frame of bundle.frames) {
    for (const p of passages) {
      if (p.sourceId !== frame.sourceId || frame.mediaS < p.interval.start || frame.mediaS >= p.interval.end) continue;
      const candidate = { frame, rank: frame.teaching === "kept" ? 0 : 1, distance: frame.mediaS - p.interval.start };
      if (best === null || candidate.rank < best.rank || (candidate.rank === best.rank && (candidate.distance < best.distance || (candidate.distance === best.distance && byTime(frame, best.frame) < 0)))) best = candidate;
    }
  }
  return best?.frame ?? null;
}

export type SummaryEvidence = { readonly passages: readonly Passage[]; readonly frames: readonly Frame[] };

/**
 * Everything one summary call may see and cite: the passages and frames the topic's usable claims cite, plus the
 * frame shown for the topic. Nothing outside the review's scope gets in (R7). This set is both what the model is
 * shown and what R19 allows a line to cite.
 */
export function summaryEvidence(claims: readonly CitingClaim[], bundle: Pick<EvidenceBundle, "passages" | "frames">, shown: Frame | null): SummaryEvidence {
  const counts = citedFrames(claims, bundle.frames);
  const frames = bundle.frames.filter((f) => counts.has(f.id) && f.id !== shown?.id).sort((a, b) => counts.get(b.id)! - counts.get(a.id)! || byTime(a, b));
  const all = shown === null ? frames : [shown, ...frames];
  return { passages: citedPassages(claims, bundle.passages), frames: all.slice(0, MAX_SUMMARY_FRAMES) };
}

export const evidenceIdsOf = (e: SummaryEvidence): Set<EvidenceId> => new Set<EvidenceId>([...e.passages.map((p) => p.id), ...e.frames.map((f) => f.id)]);

export type RawLine = { readonly text: string; readonly evidence: readonly string[] };

/**
 * R19: "Every line of a diagram summary cites something I watched; a line without a citation is never shown."
 * A line with no citation, or with any citation outside `allowed` (evidence of this topic inside the review's scope),
 * is dropped whole. Citations are never trimmed or swapped, and the text is never edited.
 */
export function enforceCitations(lines: readonly RawLine[], allowed: ReadonlySet<string>): DiagramLine[] {
  return lines.flatMap((line) => {
    const text = line.text.trim();
    if (text === "" || line.evidence.length === 0 || !line.evidence.every((id) => allowed.has(id))) return [];
    return [{ text, evidence: [...new Set(line.evidence)] as unknown as NonEmpty<EvidenceId> }];
  });
}
