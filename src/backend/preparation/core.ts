/**
 * Pure preparation (W6). Importable only by preparation/ and test/.
 */
import type { EvidenceId, SourceId } from "../../shared/ids";
import type { AssessableClaim, ChunkPrep, Claim, ClaimDraft, ClaimStatus, EvidenceBundle, Seq, Verdict } from "../../shared/domain";
import { Material, contains } from "../../shared/time";
import type { Interval, MediaSeconds } from "../../shared/time";
import { appliesBefore } from "../providers/memo";
import type { Lookup } from "../providers/memo";

/** Code-side validity before any Jev call: refs exist, lie in the chunk, visual ⇒ cites a frame. */
export function validateDraft(draft: ClaimDraft, chunk: EvidenceBundle): { readonly ok: true } | { readonly ok: false; readonly why: string } {
  const passages = new Set<EvidenceId>(chunk.passages.map((p) => p.id));
  const frames = new Set<EvidenceId>(chunk.frames.map((f) => f.id));
  const unknown = draft.evidence.filter((id) => !passages.has(id) && !frames.has(id));
  if (unknown.length > 0) return { ok: false, why: `cites evidence outside the chunk: ${unknown.join(", ")}` };
  if (draft.visualDependent && !draft.evidence.some((id) => frames.has(id))) return { ok: false, why: "visual-dependent claim cites no frame" };
  return { ok: true };
}

export type Check = { readonly verdict: Verdict; readonly p: number | null };
type CheckLookup = Lookup<Check> | { readonly kind: "invalid_refs" };

export type CheckLookups = {
  readonly originalCheck: CheckLookup;
  readonly revision: Lookup<ClaimDraft> | null; // null until originalCheck is terminal-and-not-yes
  readonly revisionCheck: CheckLookup | null;
  /** Non-null once a later delta interpretation marks this claim superseded: the passing draft is checked again. */
  readonly supersessionCheck: Lookup<Check> | null;
};

/** A terminal check lookup read as a verdict. A failed check is never "no": it is uncertain. */
export function checkVerdict(l: CheckLookup): Check | null {
  if (l.kind === "invalid_refs") return { verdict: "no", p: null };
  if (l.kind === "hit") return l.value;
  if (l.kind === "failed") return { verdict: "uncertain", p: null };
  return null;
}

/**
 * R3: "A claim can be used to judge my answers only if it passed the evidence check."
 * R4: "A claim gets at most one revision; after that it's unverified."
 * R8: "Results from cancelled or outdated jobs never overwrite current preparation or my notes."
 *
 * `cutoff` = Seq of the latest stop-early covering this claim's chunk that is
 * not followed by a covering retry (null if none). A result counts only if
 * memo.appliesBefore(result, cutoff).
 *
 *   pending(next) = cutoff ? "dropped" : next
 *   c1 = originalCheck            (invalid_refs counts as verdict "no", no Jev call made)
 *   !counts(c1)                    → pending("awaiting_check")
 *   c1 yes                         → "supported_by_check"
 *   rv = revision                  (input is ALWAYS the original draft + c1)
 *   !counts(rv)                    → pending("awaiting_revision")
 *   rv failed                      → "unverified"   (no second revision attempt)
 *   c2 = revisionCheck(rv.value)
 *   !counts(c2)                    → pending("awaiting_recheck")
 *   c2 yes ? "supported_by_check" : "unverified"   (no / uncertain / failed ⇒ unverified)
 *   superseded ∧ supported: !counts(sc) → pending("awaiting_recheck"); sc yes ? supported : unverified
 */
export function deriveClaimStatus(lookups: CheckLookups, cutoff: Seq | null): ClaimStatus {
  const pending = (next: ClaimStatus): ClaimStatus => (cutoff === null ? next : "dropped");
  const counts = (l: CheckLookup | Lookup<unknown>): boolean => l.kind === "invalid_refs" || appliesBefore(l, cutoff);

  const base = ((): ClaimStatus => {
    const c1 = lookups.originalCheck;
    if (!counts(c1)) return pending("awaiting_check");
    if (checkVerdict(c1)?.verdict === "yes") return "supported_by_check";
    const rv = lookups.revision;
    if (rv === null || !counts(rv)) return pending("awaiting_revision");
    if (rv.kind === "failed") return "unverified";
    const c2 = lookups.revisionCheck;
    if (c2 === null || !counts(c2)) return pending("awaiting_recheck");
    return checkVerdict(c2)?.verdict === "yes" ? "supported_by_check" : "unverified";
  })();

  const sc = lookups.supersessionCheck;
  if (base !== "supported_by_check" || sc === null) return base;
  if (!counts(sc)) return pending("awaiting_recheck");
  return checkVerdict(sc)?.verdict === "yes" ? "supported_by_check" : "unverified";
}

/** The draft whose check passed: the original if its own check said yes, else the revision. */
export function passingDraft(claim: Pick<Claim, "original" | "originalCheck" | "revision">): ClaimDraft | null {
  return claim.originalCheck?.verdict === "yes" ? claim.original : claim.revision;
}

/**
 * R3: "A claim can be used to judge my answers only if it passed the evidence check."
 * The AssessableClaim constructor. Returns null unless status is supported_by_check.
 */
export function assessable(claim: Claim): AssessableClaim | null {
  if (claim.status !== "supported_by_check") return null;
  const draft = passingDraft(claim);
  if (draft === null) return null;
  return {
    id: claim.id,
    conceptId: claim.conceptId,
    text: draft.text,
    evidence: draft.evidence,
    assumptions: draft.assumptions,
  } as AssessableClaim;
}

const TERMINAL: ReadonlySet<ClaimStatus> = new Set<ClaimStatus>(["supported_by_check", "unverified", "dropped"]);

/** Interpretation terminal ∧ every member claim terminal (supported | unverified | dropped). */
export function isFinished(prep: Omit<ChunkPrep, "finished">): boolean {
  return prep.interpretation !== "pending" && prep.claims.every((c) => TERMINAL.has(c.status));
}

/** Where a piece of evidence sits on its source's media timeline: a passage spans, a frame is an instant. */
export type Located =
  | { readonly kind: "span"; readonly sourceId: SourceId; readonly interval: Interval }
  | { readonly kind: "instant"; readonly sourceId: SourceId; readonly at: MediaSeconds };

export function inside(m: Material, where: Located): boolean {
  if (where.kind === "span") return Material.covers(m, where.sourceId, where.interval);
  return Material.get(m, where.sourceId).intervals().some((i) => contains(i, where.at));
}

export function locate(bundle: EvidenceBundle): ReadonlyMap<EvidenceId, Located> {
  const out = new Map<EvidenceId, Located>();
  for (const p of bundle.passages) out.set(p.id, { kind: "span", sourceId: p.sourceId, interval: p.interval });
  for (const f of bundle.frames) out.set(f.id, { kind: "instant", sourceId: f.sourceId, at: f.mediaS });
  return out;
}

/**
 * Claims are keyed by evidence: a claim belongs to material when every piece of
 * evidence it cites (original and revision) lies inside it. A claim with no
 * evidence it can place belongs nowhere, rather than vacuously everywhere.
 */
export function claimInside(m: Material, cited: readonly EvidenceId[], where: ReadonlyMap<EvidenceId, Located>): boolean {
  const placed = cited.flatMap((id) => {
    const at = where.get(id);
    return at ? [at] : [];
  });
  return placed.length > 0 && placed.length === cited.length && placed.every((at) => inside(m, at));
}

export type ControlFact = { readonly seq: Seq; readonly action: "stop_early" | "retry"; readonly material: Material };

/**
 * The covering cutoff for work whose subject lies inside material where `within`
 * holds: the latest stop-early whose chunk contains it, unless a later retry also does.
 */
export function cutoffFor(within: (chunk: Material) => boolean, controls: readonly ControlFact[]): Seq | null {
  let stop: Seq | null = null;
  for (const c of controls) if (c.action === "stop_early" && (stop === null || c.seq > stop) && within(c.material)) stop = c.seq;
  if (stop === null) return null;
  const s = stop;
  return controls.some((c) => c.action === "retry" && c.seq > s && within(c.material)) ? null : s;
}

export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}
