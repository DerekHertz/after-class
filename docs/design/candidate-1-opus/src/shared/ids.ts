/**
 * Stable, content-derived identifiers.
 *
 * Every backend ID is a pure function of what it names (R15: retrying a save
 * recomputes the same IDs, so an upsert overwrites instead of duplicating).
 * The only random IDs in the system are `CaptureId` (minted once by the
 * extension when the user presses Start) and `ClientTurnId` (minted once per
 * learner act by the review app, so a resent turn is recognised).
 *
 * Shared by extension, backend, and app. Pure, no I/O.
 */

declare const IdBrand: unique symbol;

/** Branded string ID. `K` is the kind prefix that also appears in the string. */
export type Id<K extends IdKind> = string & { readonly [IdBrand]: K };

/** The one list of ID kinds. Adding a kind here is the only step needed. */
export const ID_KINDS = [
  "cap", // capture session (random, extension-minted)
  "src", // source (canonical video identity)
  "trv", // transcript revision of a source
  "ev", // evidence item (passage or frame)
  "win", // boundary window
  "chk", // chunk slot (capture + ordinal)
  "crv", // chunk revision (chunk + material hash)
  "clm", // claim lineage
  "cpt", // concept
  "lnk", // subject-graph link suggestion
  "rvw", // review
  "thr", // question thread inside a review
  "obs", // learning observation
  "note", // note
  "turn", // review turn (client-minted for learner turns)
  "res", // supplemental resource connection
  "use", // usage event
  "key", // provider memo key
] as const;
export type IdKind = (typeof ID_KINDS)[number];

export type CaptureId = Id<"cap">;
export type SourceId = Id<"src">;
export type TranscriptRevId = Id<"trv">;
export type EvidenceId = Id<"ev">;
export type WindowId = Id<"win">;
export type ChunkId = Id<"chk">;
export type ChunkRevisionId = Id<"crv">;
export type ClaimId = Id<"clm">;
export type ConceptId = Id<"cpt">;
export type LinkId = Id<"lnk">;
export type ReviewId = Id<"rvw">;
export type ThreadId = Id<"thr">;
export type ObservationId = Id<"obs">;
export type NoteId = Id<"note">;
export type TurnId = Id<"turn">;
export type ResourceId = Id<"res">;
export type UsageEventId = Id<"use">;
export type MemoKey = Id<"key">;

/** A JSON-serialisable value used as an ID part. Objects are canonicalised (sorted keys). */
export type IdPart = string | number | boolean | null | readonly IdPart[] | { readonly [k: string]: IdPart };

/**
 * Derive a stable ID: `${kind}_${base32(sha256(canonicalJson(parts)))[0..26]}`.
 * Same parts, same ID, on every machine and every retry.
 */
export function stableId<K extends IdKind>(kind: K, ...parts: IdPart[]): Id<K> {
  // TODO: canonicalJson (sorted keys, no whitespace) → Bun.CryptoHasher("sha256")
  //       in backend, crypto.subtle in extension (async variant below).
  throw new Error("not implemented");
}

/** Random ID for the two client-minted kinds only. */
export function randomId<K extends "cap" | "turn">(kind: K): Id<K> {
  throw new Error("not implemented");
}

/** Parse at a boundary: checks prefix and shape, returns the brand or null. */
export function parseId<K extends IdKind>(kind: K, raw: string): Id<K> | null {
  throw new Error("not implemented");
}
