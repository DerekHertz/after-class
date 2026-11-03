/**
 * Pure invite policy, scope freezing and corrections (W7). Importable only by review/ and test/.
 */
import { canonicalJson } from "../../shared/ids";
import type { ChunkRevisionId, ClaimId, EvidenceId, ReviewId } from "../../shared/ids";
import type {
  AssessableClaim, ChunkPrep, ChunkProvenance, ChunkRevision, Correction, EvidenceBundle, FrozenScope, InviteAnswer, InviteState,
  NonEmpty, PartialReason, Seq,
} from "../../shared/domain";
import { Material } from "../../shared/time";

export type InviteEvent =
  | { readonly kind: "chunk_closed"; readonly seq: Seq; readonly provenance: ChunkProvenance; readonly chunk: ChunkRevisionId; readonly watchedS: number }
  | { readonly kind: "answer"; readonly seq: Seq; readonly answer: InviteAnswer; readonly watchedS: number }
  | { readonly kind: "review_started"; readonly seq: Seq };

/**
 * Flow C invite policy as a fold.
 *   boundary close                          → invited; mark = watchedS
 *   time close, watchedS − mark ≥ 900       → invited; mark = watchedS
 *   boundary_revised / session_end          → unchanged (SYNTHESIS open question 5: no invite on session end)
 *   later                                   → "later"; mark = watchedS (next invite at next boundary close)
 *   wait                                    → "waiting"
 *   review_now / stop_early / review_started → "none"
 */
export function foldInvites(events: readonly InviteEvent[], timeInviteGapS: number): InviteState {
  let state: InviteState = { state: "none" };
  let mark = 0;
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    switch (e.kind) {
      case "chunk_closed":
        if (e.provenance === "boundary" || (e.provenance === "time" && e.watchedS - mark >= timeInviteGapS)) {
          state = { state: "invited", atChunk: e.chunk };
          mark = e.watchedS;
        }
        break;
      case "answer":
        if (e.answer === "later") {
          state = { state: "later" };
          mark = e.watchedS;
        } else if (e.answer === "wait") {
          state = { state: "waiting" };
        } else {
          state = { state: "none" };
        }
        break;
      case "review_started":
        state = { state: "none" };
        break;
    }
  }
  return state;
}

/**
 * Flow C: "Freeze review scope = prepared chunks now".
 * unreviewed = current closed revisions whose material is not contained in the
 * union of earlier reviews' scope material.
 */
export function unreviewed<T extends { readonly material: Material }>(chunks: readonly T[], reviewed: Material): T[] {
  return chunks.filter((c) => !Material.contains(reviewed, c.material));
}

/**
 * Flow C: "Freeze review scope = prepared chunks now".
 * Only finished chunks enter the scope; the rest are reported as still preparing.
 * R10: "A review never starts with zero supported claims in scope."
 * Returns null when no supported claim exists; FrozenScope.claimsAtStart is NonEmpty.
 */
export function freezeScope(
  candidates: readonly { readonly rev: ChunkRevision; readonly prep: ChunkPrep }[],
  assessable: (m: Material) => readonly AssessableClaim[],
  gaps: (m: Material) => EvidenceBundle["gaps"],
  seq: Seq,
): FrozenScope | null {
  const finished = candidates.filter((c) => c.prep.finished).sort((a, b) => a.rev.ordinal - b.rev.ordinal);
  const [firstChunk, ...otherChunks] = finished;
  if (!firstChunk) return null;

  const material = finished.reduce((m, c) => Material.union(m, c.rev.material), Material.empty);
  const claimIds = [...new Set(assessable(material).map((c) => c.id))];
  const [firstClaim, ...otherClaims] = claimIds;
  if (!firstClaim) return null;

  const unverified = new Set(finished.flatMap((c) => c.prep.claims.filter((cl) => cl.status === "unverified").map((cl) => cl.id)));
  const preparing = candidates.length - finished.length;
  const partial: PartialReason[] = [
    ...gaps(material).map((gap): PartialReason => ({ kind: "capture_gap", gap })),
    ...(unverified.size > 0 ? [{ kind: "unverified_claims", count: unverified.size } as const] : []),
    ...(preparing > 0 ? [{ kind: "chunks_still_preparing", count: preparing } as const] : []),
  ];
  return {
    chunkRevisions: [firstChunk.rev.id, ...otherChunks.map((c) => c.rev.id)],
    material,
    claimsAtStart: [firstClaim, ...otherClaims] as NonEmpty<ClaimId>,
    partial,
    frozenAtSeq: seq,
  };
}

export function correctionId(reviewId: ReviewId, claimId: ClaimId, change: Correction["change"]): string {
  const hex = new Bun.CryptoHasher("sha256").update(canonicalJson([reviewId, claimId, change])).digest("hex");
  return `corr_${hex.slice(0, 26)}`;
}

/**
 * R7: "Once a review starts, its scope never grows; corrections can change claims inside it but can't add material."
 * Corrections inside a frozen scope: claims usable at start that no longer are,
 * claims whose text changed, new usable claims whose evidence is inside scope.material.
 * `evidenceInScope` is the evidence the frozen material contains. A claim citing
 * anything else is treated as not usable, so a dependency that ignores the
 * material it was given still cannot add material to the review.
 */
export function corrections(
  reviewId: ReviewId,
  scope: FrozenScope,
  usableNow: readonly AssessableClaim[],
  disclosedIds: ReadonlySet<string>,
  startTexts: ReadonlyMap<ClaimId, string>,
  evidenceInScope: ReadonlySet<EvidenceId>,
): Correction[] {
  const usable = usableInScope(usableNow, evidenceInScope);
  const atStart = new Set<ClaimId>(scope.claimsAtStart);
  const out: Correction[] = [];
  const add = (claimId: ClaimId, change: Correction["change"]) => {
    const id = correctionId(reviewId, claimId, change);
    out.push({ id, claimId, change, disclosed: disclosedIds.has(id) });
  };
  for (const id of scope.claimsAtStart) {
    const now = usable.get(id);
    if (!now) add(id, "withdrawn");
    else if (startTexts.has(id) && startTexts.get(id) !== now.text) add(id, "text_changed");
  }
  for (const id of usable.keys()) if (!atStart.has(id)) add(id, "new_in_scope");
  return out;
}

/** Usable claims, restricted to those that cite only evidence inside the frozen material. */
export function usableInScope(claims: readonly AssessableClaim[], evidenceInScope: ReadonlySet<EvidenceId>): Map<ClaimId, AssessableClaim> {
  return new Map(claims.filter((c) => c.evidence.every((e) => evidenceInScope.has(e))).map((c) => [c.id, c]));
}

/** Completed sentences in `buf`, and the unfinished remainder. A sentence ends at . ! or ? followed by whitespace. */
export function takeSentences(buf: string): { readonly sentences: string[]; readonly rest: string } {
  const sentences: string[] = [];
  let rest = buf;
  for (let m = /^([\s\S]*?[.!?]+["')\]]*)\s+/.exec(rest); m; m = /^([\s\S]*?[.!?]+["')\]]*)\s+/.exec(rest)) {
    const s = m[1]!.trim();
    if (s) sentences.push(s);
    rest = rest.slice(m[0].length);
  }
  return { sentences, rest };
}

type ScopeJson = Omit<FrozenScope, "material"> & { readonly material: ReturnType<typeof Material.canonical> };

/** The reviews row stores the scope plus the claim texts it was frozen with, so a later text change is detectable. */
export function encodeScope(scope: FrozenScope, claimTexts: ReadonlyMap<ClaimId, string>): string {
  const json: { scope: ScopeJson; claimTexts: Record<string, string> } = {
    scope: { ...scope, material: Material.canonical(scope.material) },
    claimTexts: Object.fromEntries(claimTexts),
  };
  return JSON.stringify(json);
}

export function decodeScope(text: string): { readonly scope: FrozenScope; readonly claimTexts: ReadonlyMap<ClaimId, string> } {
  const json = JSON.parse(text) as { scope: ScopeJson; claimTexts: Record<string, string> };
  return {
    scope: { ...json.scope, material: Material.fromCanonical(json.scope.material) },
    claimTexts: new Map(Object.entries(json.claimTexts) as [ClaimId, string][]),
  };
}
