/**
 * Stable, content-derived identifiers.
 *
 * Every backend ID is a pure function of what it names, so a retried save
 * recomputes the same IDs and an upsert overwrites instead of duplicating.
 * R15: "Retrying a save never creates a duplicate record."
 *
 * The only random IDs are the client-minted kinds: `cap` (the extension, once per
 * Start), `rvw` and `turn` (the review app, once per user act, so a resent
 * request is recognised as the same request).
 *
 * `stableId` hashes with Bun.CryptoHasher and is backend-only. The extension and
 * the app mint `randomId` and never call `stableId` (test/boundaries.test.ts).
 */

declare const IdBrand: unique symbol;

export type Id<K extends IdKind> = string & { readonly [IdBrand]: K };

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
  "rvw", // review (random, app-minted)
  "thr", // question thread inside a review
  "obs", // learning observation
  "note", // note
  "turn", // review turn (app-minted for learner turns, derived for tutor and code turns)
  "res", // supplemental resource connection
  "use", // usage event
  "key", // provider memo key
  "usr", // user (derived: the local app's one user is stableId("usr", "local"))
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
export type UserId = Id<"usr">;

export type ClientMintedKind = "cap" | "rvw" | "turn";

/** A JSON value used as an ID part. Objects are canonicalised (sorted keys). */
export type IdPart = string | number | boolean | null | readonly IdPart[] | { readonly [k: string]: IdPart };

const BODY_LENGTH = 26;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const KIND_SET: ReadonlySet<string> = new Set(ID_KINDS);

/**
 * Sorted keys, no whitespace. Rejects values JSON would silently change
 * (undefined, NaN, Infinity) so two different inputs can never share a key.
 */
export function canonicalJson(value: IdPart): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number ${value}`);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map((v: IdPart) => canonicalJson(v)).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as { readonly [k: string]: IdPart };
    const keys = Object.keys(obj).sort();
    return `{${keys
      .map((k) => {
        const v = obj[k];
        if (v === undefined) throw new TypeError(`canonicalJson: undefined at key "${k}"`);
        return `${JSON.stringify(k)}:${canonicalJson(v)}`;
      })
      .join(",")}}`;
  }
  throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
}

function base32(bytes: Uint8Array, length: number): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
    if (out.length === length) break;
  }
  return out;
}

/** `${kind}_${base32(sha256(canonicalJson([kind, ...parts])))[0..26]}`: 130 bits. */
export function stableId<K extends IdKind>(kind: K, ...parts: IdPart[]): Id<K> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonicalJson([kind, ...parts]));
  return `${kind}_${base32(hasher.digest(), BODY_LENGTH)}` as Id<K>;
}

export function randomId<K extends ClientMintedKind>(kind: K): Id<K> {
  const bytes = new Uint8Array(17);
  crypto.getRandomValues(bytes);
  return `${kind}_${base32(bytes, BODY_LENGTH)}` as Id<K>;
}

const SHAPES = new Map<string, RegExp>(ID_KINDS.map((k) => [k, new RegExp(`^${k}_[a-z2-7]{${BODY_LENGTH}}$`)]));

/** Boundary parse: checks prefix and shape, returns the brand or null. */
export function parseId<K extends IdKind>(kind: K, raw: unknown): Id<K> | null {
  if (typeof raw !== "string" || !KIND_SET.has(kind)) return null;
  return SHAPES.get(kind)!.test(raw) ? (raw as Id<K>) : null;
}
