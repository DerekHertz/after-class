/**
 * Preparation, flow C (W6). Owns: claim_index, concept_index, prep_controls, prep_inputs.
 *
 * Claims are keyed by EVIDENCE, not by chunk revision. A chunk revision's claims
 * are the claims of this capture whose cited evidence lies inside the revision's
 * material. When a boundary moves:
 *   - a claim whose evidence is unchanged keeps its ID and its check results
 *     (the check key is a function of claim + cited evidence);
 *   - a claim whose evidence now straddles chunks belongs to neither;
 *   - material the chunk gained goes through a DELTA interpretation that sees
 *     the existing claims as context.
 * That is flow D's "reprocess affected claims only", derived rather than tracked,
 * and it keeps R4 true across boundary moves (the TLC break).
 *
 * Inputs that later facts could change are frozen in prep_inputs: an
 * interpretation when it first runs, a claim's revision slot when its original
 * check settles. A frame judged later or a retried check never re-keys them.
 *
 * R5: "Choosing Later never cancels preparation."
 * This module and the scheduler never import review/, so invite answers are
 * not an input to demand() (test/boundaries.test.ts).
 *
 *   const prep = preparation.prep(chunkRevisionId);   // { finished, supportedCount, claims }
 *   preparation.stopEarly(captureId, ids);             // a fact; cancels by derivation
 *   const usable = preparation.assessableIn(captureId, scope.material);
 */
import { stableId } from "../../shared/ids";
import type { CaptureId, ChunkId, ChunkRevisionId, ClaimId, ConceptId, EvidenceId, MemoKey } from "../../shared/ids";
import type {
  AssessableClaim, CheckOutcome, ChunkPrep, ChunkRevision, Claim, ClaimDraft, Concept, EvidenceBundle, InterpretationState, Passage,
  PossibleConfusion, Provider, Purpose, ResourceConnection, ResourceSearchState, Seq, SubjectLinkSuggestion,
} from "../../shared/domain";
import { Material } from "../../shared/time";
import { appliesBefore } from "../providers/memo";
import type { Lookup, Task } from "../providers/memo";
import type { ClaimSupportInput } from "../providers/jev-tasks";
import { asSeq } from "../db";
import type { UserDb } from "../db";
import type { WorkItem } from "../scheduler";
import { assessable, checkVerdict, claimInside, cutoffFor, deriveClaimStatus, isFinished, locate, normalizeLabel, validateDraft } from "./core";
import type { Check, ControlFact, Located } from "./core";
import type { InterpretationInput, InterpretationOutput, PreparationTasks, ResourceSearchInput, RevisionInput } from "./tasks";

export type Preparation = {
  prep(chunkRevisionId: ChunkRevisionId): ChunkPrep;
  /** Interpretation, claim checks, revisions, rechecks, resource searches still needed. Excludes cancelled scope. */
  demand(captureId: CaptureId): readonly WorkItem[];
  /** Flow C Stop early: one fact. Pending work in these chunks stops being demanded; late results are ignored. */
  stopEarly(captureId: CaptureId, chunkRevisionIds: readonly ChunkRevisionId[]): Seq;
  /** Flow C retry: one fact + memo.clearFailures for these chunks' keys. Re-demands dropped claims. */
  retry(captureId: CaptureId, chunkRevisionIds: readonly ChunkRevisionId[]): Seq;
  claimsIn(captureId: CaptureId, material: Material): readonly Claim[];
  /** The ONLY producer of AssessableClaim outside core.ts. */
  assessableIn(captureId: CaptureId, material: Material): readonly AssessableClaim[];
  concepts(ids: readonly ConceptId[]): readonly Concept[];
  confusions(conceptIds: readonly ConceptId[]): readonly PossibleConfusion[];
  linkSuggestions(conceptIds: readonly ConceptId[]): readonly SubjectLinkSuggestion[];
  /**
   * R6: "A pending resource search never blocks a review that is otherwise ready."
   * A separate query; nothing in prep() or readiness reads it.
   */
  resources(conceptId: ConceptId): { readonly state: ResourceSearchState; readonly connections: readonly ResourceConnection[] };
};

type FrozenKind = "interpretation" | "revision" | "resource_search";
type Freeze = { readonly kind: FrozenKind; readonly subject: string; readonly json: unknown };

/** An interpretation job: the chunk it was cut from, the material it reads, and where each piece of its evidence sits. */
type Unit = {
  readonly chunkId: ChunkId;
  readonly material: Material;
  readonly input: InterpretationInput;
  readonly where: ReadonlyMap<EvidenceId, Located>;
};

type UnitView = {
  readonly unit: Unit;
  readonly lookup: Lookup<InterpretationOutput>;
  readonly state: InterpretationState;
  /** Present only when the result counts (stored before any covering stop-early). */
  readonly applied: { readonly output: InterpretationOutput; readonly atSeq: Seq } | null;
};

/** Remaining work, with its task's types erased behind `start`. */
type Need = {
  readonly key: MemoKey;
  readonly purpose: Purpose;
  readonly provider: Provider;
  readonly start: (signal: AbortSignal) => Promise<unknown>;
  readonly freeze: Freeze | null;
};

type ClaimView = {
  readonly claim: Claim;
  readonly concept: Concept;
  readonly origin: UnitView;
  readonly ordinal: number;
  readonly cited: readonly EvidenceId[];
  readonly failedKeys: readonly MemoKey[];
  readonly next: Need | null;
};

type View = {
  readonly controls: readonly ControlFact[];
  readonly units: readonly UnitView[];
  readonly claims: readonly ClaimView[];
  readonly covered: Material;
};

type CheckStep =
  | { readonly kind: "invalid_refs" }
  | { readonly kind: "check"; readonly lookup: Lookup<Check>; readonly input: ClaimSupportInput };

type StoredBundle = Omit<EvidenceBundle, "material"> & { readonly material: ReturnType<typeof Material.canonical> };
type StoredUnit = {
  readonly chunkId: ChunkId;
  readonly material: ReturnType<typeof Material.canonical>;
  readonly input: Omit<InterpretationInput, "newMaterial"> & { readonly newMaterial: StoredBundle };
};

const open = (l: Lookup<unknown>): boolean => l.kind === "missing" || l.kind === "inflight";
const conceptIdOf = (label: string): ConceptId => stableId("cpt", normalizeLabel(label));

function encodeUnit(u: Unit): StoredUnit {
  const b = u.input.newMaterial;
  return { chunkId: u.chunkId, material: Material.canonical(u.material), input: { ...u.input, newMaterial: { ...b, material: Material.canonical(b.material) } } };
}

function decodeUnit(json: string): Unit {
  const s = JSON.parse(json) as StoredUnit;
  const newMaterial: EvidenceBundle = { ...s.input.newMaterial, material: Material.fromCanonical(s.input.newMaterial.material) };
  const input: InterpretationInput = { ...s.input, newMaterial };
  return { chunkId: s.chunkId, material: Material.fromCanonical(s.material), input, where: locate(newMaterial) };
}

export function createPreparation(db: UserDb, deps: {
  chunk(id: ChunkRevisionId): ChunkRevision | null;
  currentChunks(captureId: CaptureId): readonly ChunkRevision[];
  bundle(material: Material): EvidenceBundle;
  lookup<I, O>(task: Task<I, O>, input: I): Lookup<O>;
  run<I, O>(task: Task<I, O>, input: I, signal: AbortSignal): Promise<Lookup<O>>;
  clearFailures: (keys: readonly Lookup<unknown>["key"][]) => void;
  tasks: PreparationTasks;
  /** Frame JPEG bytes for claim checks. Absent ⇒ a check citing a frame fails, so its claim ends unverified. */
  frameBytes?: (id: EvidenceId) => Uint8Array | null;
}): Preparation {
  const { tasks } = deps;
  const { userId } = db;
  // Every statement carries the handle's user as its first parameter. Ids that two users can derive alike (a claim id
  // from the interpretation's memo key, a concept id from a label, a subject id from a chunk revision) are keyed with it.
  const q = {
    frozenOf: db.sql.query<{ input_json: string }, [string, string, FrozenKind]>(`SELECT input_json FROM prep_inputs WHERE user_id = ? AND capture_id = ? AND kind = ? ORDER BY seq`),
    frozen: db.sql.query<{ memo_key: string; input_json: string }, [string, FrozenKind, string]>(`SELECT memo_key, input_json FROM prep_inputs WHERE user_id = ? AND kind = ? AND subject_id = ?`),
    unitByKey: db.sql.query<{ input_json: string }, [string, string]>(`SELECT input_json FROM prep_inputs WHERE user_id = ? AND kind = 'interpretation' AND memo_key = ?`),
    freeze: db.sql.query(`INSERT INTO prep_inputs (user_id, kind, subject_id, capture_id, memo_key, input_json, seq) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    controls: db.sql.query<{ seq: number; action: ControlFact["action"]; chunk_revision_id: string }, [string, string]>(
      `SELECT seq, action, chunk_revision_id FROM prep_controls WHERE user_id = ? AND capture_id = ? ORDER BY seq`,
    ),
    control: db.sql.query(`INSERT INTO prep_controls (user_id, seq, capture_id, action, chunk_revision_id, at_ms) VALUES (?, ?, ?, ?, ?, ?)`),
    claimIndexed: db.sql.query<{ n: number }, [string, string]>(`SELECT 1 AS n FROM claim_index WHERE user_id = ? AND id = ?`),
    indexClaim: db.sql.query(
      `INSERT INTO claim_index (user_id, id, capture_id, source_chunk_id, interpretation_key, ordinal, concept_id, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    conceptIndexed: db.sql.query<{ n: number }, [string, string]>(`SELECT 1 AS n FROM concept_index WHERE user_id = ? AND id = ?`),
    indexConcept: db.sql.query(`INSERT INTO concept_index (user_id, id, label, summary, seq) VALUES (?, ?, ?, ?, ?)`),
    concept: db.sql.query<{ id: string; label: string; summary: string }, [string, string]>(`SELECT id, label, summary FROM concept_index WHERE user_id = ? AND id = ?`),
    keysForConcept: db.sql.query<{ interpretation_key: string }, [string, string]>(`SELECT DISTINCT interpretation_key FROM claim_index WHERE user_id = ? AND concept_id = ?`),
  };

  function need<I, O>(task: Task<I, O>, input: I, key: MemoKey, freeze: Freeze | null = null): Need {
    return { key, purpose: task.purpose, provider: task.provider, start: (signal) => deps.run(task, input, signal), freeze };
  }

  /** True when `key` is (now) the frozen input for its slot; false when an earlier freeze holds a different one. */
  function freezeOnce(captureId: CaptureId, key: MemoKey, f: Freeze): boolean {
    return db.tx(() => {
      const prior = q.frozen.get(userId, f.kind, f.subject);
      if (prior) return prior.memo_key === key;
      q.freeze.run(userId, f.kind, f.subject, captureId, key, JSON.stringify(f.json), db.nextSeq());
      return true;
    });
  }

  function workItem(captureId: CaptureId, n: Need): WorkItem {
    return {
      key: n.key,
      purpose: n.purpose,
      provider: n.provider,
      run: async (signal) => (n.freeze === null || freezeOnce(captureId, n.key, n.freeze) ? n.start(signal) : null),
    };
  }

  // ───────────────────────── derivation ─────────────────────────

  function controlsOf(captureId: CaptureId): ControlFact[] {
    return q.controls.all(userId, captureId).map((r) => ({
      seq: asSeq(r.seq),
      action: r.action,
      material: deps.chunk(r.chunk_revision_id as ChunkRevisionId)?.material ?? Material.empty,
    }));
  }

  function viewUnit(unit: Unit, controls: readonly ControlFact[]): UnitView {
    const lookup = deps.lookup(tasks.interpret, unit.input);
    const cutoff = cutoffFor((m) => Material.contains(m, unit.material), controls);
    const counts = appliesBefore(lookup, cutoff);
    const applied = counts && lookup.kind === "hit" ? { output: lookup.value, atSeq: lookup.atSeq } : null;
    const state: InterpretationState = counts ? (lookup.kind === "hit" ? "done" : "failed") : cutoff !== null ? "cancelled" : "pending";
    return { unit, lookup, state, applied };
  }

  function supportInput(draft: ClaimDraft, bundle: EvidenceBundle, extra: readonly Passage[] = []): ClaimSupportInput {
    const cited = new Set<EvidenceId>(draft.evidence);
    const passages = [...bundle.passages.filter((p) => cited.has(p.id)), ...extra.filter((p) => !cited.has(p.id))];
    const frames = bundle.frames.filter((f) => cited.has(f.id)).map((frame) => ({
      frame,
      bytes: () => {
        const b = deps.frameBytes?.(frame.id) ?? null;
        if (b === null) throw new Error(`frame bytes unavailable for ${frame.id}`);
        return b;
      },
    }));
    return { claim: draft, passages, frames };
  }

  function checkStep(draft: ClaimDraft, unit: Unit): CheckStep {
    if (!validateDraft(draft, unit.input.newMaterial).ok) return { kind: "invalid_refs" };
    const input = supportInput(draft, unit.input.newMaterial);
    return { kind: "check", lookup: deps.lookup(tasks.checkClaim, input), input };
  }

  const stepLookup = (s: CheckStep) => (s.kind === "invalid_refs" ? s : s.lookup);
  const checkNeed = (s: CheckStep | null): Need | null => (s?.kind === "check" && open(s.lookup) ? need(tasks.checkClaim, s.input, s.lookup.key) : null);

  function outcome(s: CheckStep, cutoff: Seq | null, origin: UnitView): CheckOutcome | null {
    if (s.kind === "invalid_refs") return { verdict: "no", p: null, reason: "invalid_refs", memoKey: origin.lookup.key, atSeq: origin.applied!.atSeq };
    const l = s.lookup;
    if (!appliesBefore(l, cutoff)) return null;
    const v = checkVerdict(l)!;
    return { verdict: v.verdict, p: v.p, reason: l.kind === "hit" ? "jev" : "error", memoKey: l.key, atSeq: l.atSeq };
  }

  /**
   * R4: "A claim gets at most one revision; after that it's unverified."
   * The slot is taken the first time the original check settles not-yes and is
   * never rewritten, so a retried check or a cached revision can't key a second one.
   */
  function revisionSlot(captureId: CaptureId, id: ClaimId, original: ClaimDraft, c1: Check | null, unit: Unit): RevisionInput | null {
    const prior = q.frozen.get(userId, "revision", id);
    const check = prior ? (JSON.parse(prior.input_json) as { readonly check: Check }).check : c1 && c1.verdict !== "yes" ? c1 : null;
    if (check === null) return null;
    const input: RevisionInput = { original, check, evidence: unit.input.newMaterial };
    if (!prior) freezeOnce(captureId, deps.lookup(tasks.revise, input).key, { kind: "revision", subject: id, json: { check } });
    return input;
  }

  function viewClaim(captureId: CaptureId, id: ClaimId, ordinal: number, concept: Concept, original: ClaimDraft, origin: UnitView, controls: readonly ControlFact[], supersededBy: readonly UnitView[]): ClaimView {
    const unit = origin.unit;
    // The claim's home chunk is where its original evidence lies; that chunk's stop-early covers it.
    const cutoff = cutoffFor((m) => claimInside(m, original.evidence, unit.where), controls);
    const c1 = checkStep(original, unit);
    const c1v = c1.kind === "invalid_refs" || appliesBefore(c1.lookup, cutoff) ? checkVerdict(stepLookup(c1)) : null;
    const revInput = revisionSlot(captureId, id, original, c1v, unit);
    const rv = revInput ? deps.lookup(tasks.revise, revInput) : null;
    const revised = rv?.kind === "hit" ? rv.value : null;
    const c2 = revised ? checkStep(revised, unit) : null;
    const cited = [...new Set<EvidenceId>([...original.evidence, ...(revised?.evidence ?? [])])];

    const passing = c1v?.verdict === "yes" ? original : c2 && checkVerdict(stepLookup(c2))?.verdict === "yes" ? revised : null;
    const recheck = supersededBy.length > 0 && passing
      ? supportInput(passing, unit.input.newMaterial, supersededBy.flatMap((u) => u.unit.input.newMaterial.passages))
      : null;
    const sc = recheck ? deps.lookup(tasks.checkClaim, recheck) : null;

    const status = deriveClaimStatus(
      { originalCheck: stepLookup(c1), revision: rv, revisionCheck: c2 ? stepLookup(c2) : null, supersessionCheck: sc },
      cutoff,
    );
    const claim: Claim = {
      id,
      sourceChunkId: unit.chunkId,
      conceptId: concept.id,
      original,
      originalCheck: outcome(c1, cutoff, origin),
      revision: rv && revised && appliesBefore(rv, cutoff) ? revised : null,
      revisionCheck: c2 ? outcome(c2, cutoff, origin) : null,
      status,
    };

    const next =
      status === "awaiting_check" ? checkNeed(c1)
      : status === "awaiting_revision" ? (rv && revInput && open(rv) ? need(tasks.revise, revInput, rv.key) : null)
      : status === "awaiting_recheck" ? checkNeed(c2) ?? (sc && recheck && open(sc) ? need(tasks.checkClaim, recheck, sc.key) : null)
      : null;
    const failedKeys = [c1.kind === "check" ? c1.lookup : null, rv, c2?.kind === "check" ? c2.lookup : null, sc].flatMap((l) => (l?.kind === "failed" ? [l.key] : []));
    return { claim, concept, origin, ordinal, cited, failedKeys, next };
  }

  function view(captureId: CaptureId): View {
    const controls = controlsOf(captureId);
    const units = q.frozenOf.all(userId, captureId, "interpretation").map((r) => viewUnit(decodeUnit(r.input_json), controls));
    const supersededBy = new Map<ClaimId, UnitView[]>();
    for (const u of units) for (const s of u.applied?.output.supersedes ?? []) supersededBy.set(s.claimId, [...(supersededBy.get(s.claimId) ?? []), u]);

    const claims: ClaimView[] = [];
    for (const u of units) {
      if (!u.applied) continue;
      let ordinal = 0;
      for (const c of u.applied.output.concepts) {
        const concept: Concept = { id: conceptIdOf(c.label), label: c.label, summary: c.summary };
        for (const draft of c.claims) {
          const id = stableId("clm", u.lookup.key, ordinal);
          claims.push(viewClaim(captureId, id, ordinal++, concept, draft, u, controls, supersededBy.get(id) ?? []));
        }
      }
    }
    index(captureId, units, claims);
    return { controls, units, claims, covered: units.reduce((m, u) => Material.union(m, u.unit.material), Material.empty) };
  }

  /** Records applied interpretations, which stay applied: any later stop-early has a larger Seq. */
  function index(captureId: CaptureId, units: readonly UnitView[], claims: readonly ClaimView[]): void {
    const concepts = units.flatMap((u) => u.applied?.output.concepts ?? []).filter((c) => !q.conceptIndexed.get(userId, conceptIdOf(c.label)));
    const fresh = claims.filter((c) => !q.claimIndexed.get(userId, c.claim.id));
    if (concepts.length === 0 && fresh.length === 0) return;
    db.tx(() => {
      for (const c of concepts) if (!q.conceptIndexed.get(userId, conceptIdOf(c.label))) q.indexConcept.run(userId, conceptIdOf(c.label), c.label, c.summary, db.nextSeq());
      for (const c of fresh) q.indexClaim.run(userId, c.claim.id, captureId, c.claim.sourceChunkId, c.origin.lookup.key, c.ordinal, c.claim.conceptId, db.nextSeq());
    });
  }

  const overlapping = (v: View, m: Material) => v.units.filter((u) => !Material.isEmpty(Material.intersect(u.unit.material, m)));
  const inside = (c: ClaimView, m: Material) => claimInside(m, c.cited, c.origin.unit.where);

  /** The part of a chunk revision no interpretation covers yet: what its delta job reads. */
  function residual(v: View, rev: ChunkRevision): { readonly state: InterpretationState | null; readonly need: Need | null } {
    const material = Material.subtract(rev.material, v.covered);
    if (Material.isEmpty(material)) return { state: null, need: null };
    const bundle = deps.bundle(material);
    if (bundle.passages.length === 0 && bundle.frames.length === 0) return { state: "done", need: null };
    if (cutoffFor((m) => Material.contains(m, material), v.controls) !== null) return { state: "cancelled", need: null };
    // A delta waits for the jobs it extends, so the claims it may supersede are in its context.
    if (overlapping(v, rev.material).some((u) => u.state === "pending")) return { state: "pending", need: null };
    const input: InterpretationInput = {
      chunkRevisionId: rev.id,
      newMaterial: bundle,
      existingClaims: v.claims.filter((c) => inside(c, rev.material)).map((c) => ({ id: c.claim.id, text: (c.claim.revision ?? c.claim.original).text })),
      gaps: bundle.gaps,
    };
    const unit: Unit = { chunkId: rev.chunkId, material, input, where: locate(bundle) };
    const key = deps.lookup(tasks.interpret, input).key;
    return { state: "pending", need: need(tasks.interpret, input, key, { kind: "interpretation", subject: rev.id, json: encodeUnit(unit) }) };
  }

  function resourceNeeds(v: View, current: readonly ChunkRevision[]): Need[] {
    const byConcept = new Map<ConceptId, { readonly concept: Concept; readonly claims: AssessableClaim[] }>();
    for (const c of v.claims) {
      const a = assessable(c.claim);
      if (!a || !current.some((r) => inside(c, r.material))) continue;
      const entry = byConcept.get(c.concept.id) ?? { concept: c.concept, claims: [] };
      entry.claims.push(a);
      byConcept.set(c.concept.id, entry);
    }
    return [...byConcept.values()].flatMap(({ concept, claims }) => {
      const prior = q.frozen.get(userId, "resource_search", concept.id);
      const input: ResourceSearchInput = prior ? (JSON.parse(prior.input_json) as ResourceSearchInput) : { concept, supportedClaims: claims };
      const l = deps.lookup(tasks.searchResources, input);
      return open(l) ? [need(tasks.searchResources, input, l.key, prior ? null : { kind: "resource_search", subject: concept.id, json: input })] : [];
    });
  }

  function prep(chunkRevisionId: ChunkRevisionId): ChunkPrep {
    const rev = deps.chunk(chunkRevisionId);
    if (!rev) throw new Error(`prep: unknown chunk revision ${chunkRevisionId}`);
    const v = view(rev.captureId);
    const states = [...overlapping(v, rev.material).map((u) => u.state), residual(v, rev).state];
    const interpretation: InterpretationState =
      states.includes("pending") ? "pending" : states.includes("failed") ? "failed" : states.includes("cancelled") ? "cancelled" : "done";
    const claims = v.claims.filter((c) => inside(c, rev.material)).map((c) => c.claim);
    const partial = { chunkRevisionId, interpretation, claims, supportedCount: claims.filter((c) => c.status === "supported_by_check").length };
    return { ...partial, finished: isFinished(partial) };
  }

  function demand(captureId: CaptureId): readonly WorkItem[] {
    const v = view(captureId);
    const current = deps.currentChunks(captureId);
    const needs: Need[] = [
      ...v.units.flatMap((u) => (u.state === "pending" && open(u.lookup) ? [need(tasks.interpret, u.unit.input, u.lookup.key)] : [])),
      ...current.flatMap((r) => residual(v, r).need ?? []),
      ...v.claims.flatMap((c) => (c.next && current.some((r) => inside(c, r.material)) ? [c.next] : [])),
      ...resourceNeeds(v, current),
    ];
    const seen = new Set<MemoKey>();
    return needs.filter((n) => !seen.has(n.key) && !!seen.add(n.key)).map((n) => workItem(captureId, n));
  }

  function control(captureId: CaptureId, action: ControlFact["action"], ids: readonly ChunkRevisionId[]): Seq {
    return db.tx(() => {
      const seq = db.nextSeq();
      const at = Date.now();
      for (const id of new Set(ids)) q.control.run(userId, seq, captureId, action, id, at);
      return seq;
    });
  }

  function retry(captureId: CaptureId, ids: readonly ChunkRevisionId[]): Seq {
    const v = view(captureId);
    const materials = ids.flatMap((id) => deps.chunk(id)?.material ?? []);
    const unitKeys = materials.flatMap((m) => overlapping(v, m)).flatMap((u) => (u.lookup.kind === "failed" ? [u.lookup.key] : []));
    const claimKeys = v.claims.filter((c) => materials.some((m) => inside(c, m))).flatMap((c) => c.failedKeys);
    deps.clearFailures([...new Set([...unitKeys, ...claimKeys])]);
    return control(captureId, "retry", ids);
  }

  function claimsOf(captureId: CaptureId, material: Material): readonly ClaimView[] {
    return view(captureId).claims.filter((c) => inside(c, material));
  }

  /** Applied interpretation outputs that produced claims for these concepts (claim_index holds only applied ones). */
  function outputsFor(conceptIds: readonly ConceptId[]): InterpretationOutput[] {
    const keys = new Set(conceptIds.flatMap((id) => q.keysForConcept.all(userId, id).map((r) => r.interpretation_key)));
    return [...keys].flatMap((key) => {
      const row = q.unitByKey.get(userId, key);
      const l = row ? deps.lookup(tasks.interpret, decodeUnit(row.input_json).input) : null;
      return l?.kind === "hit" ? [l.value] : [];
    });
  }

  return {
    prep,
    demand,
    stopEarly: (captureId, ids) => control(captureId, "stop_early", ids),
    retry,
    claimsIn: (captureId, material) => claimsOf(captureId, material).map((c) => c.claim),
    assessableIn: (captureId, material) => claimsOf(captureId, material).flatMap((c) => assessable(c.claim) ?? []),
    concepts: (ids) => ids.flatMap((id) => {
      const r = q.concept.get(userId, id);
      return r ? [{ id: r.id as ConceptId, label: r.label, summary: r.summary }] : [];
    }),
    confusions: (conceptIds) => {
      const wanted = new Set(conceptIds);
      return outputsFor(conceptIds).flatMap((o) => o.concepts.flatMap((c) => {
        const conceptId = conceptIdOf(c.label);
        return wanted.has(conceptId) ? c.confusions.map((x) => ({ conceptId, text: x.text, evidence: x.evidence })) : [];
      }));
    },
    linkSuggestions: (conceptIds) => {
      const wanted = new Set(conceptIds);
      const out = new Map<string, SubjectLinkSuggestion>();
      for (const l of outputsFor(conceptIds).flatMap((o) => o.links)) {
        const from = conceptIdOf(l.fromLabel);
        const to = conceptIdOf(l.toLabel);
        if (from === to || !(wanted.has(from) || wanted.has(to))) continue;
        const id = stableId("lnk", from, to, l.type);
        if (!out.has(id)) out.set(id, { id, from, to, type: l.type, evidence: l.evidence, rationale: l.rationale });
      }
      return [...out.values()];
    },
    resources: (conceptId) => {
      const prior = q.frozen.get(userId, "resource_search", conceptId);
      if (!prior) return { state: "not_started", connections: [] };
      const l = deps.lookup(tasks.searchResources, JSON.parse(prior.input_json) as ResourceSearchInput);
      if (l.kind === "hit") return { state: "found", connections: l.value };
      return { state: l.kind === "failed" ? "failed" : "searching", connections: [] };
    },
  };
}
