/**
 * What one capture's demand reads that a write to another capture can change, as keys. A derivation records every key its
 * stores report reading, and a write reports every key it changed, so the pump wakes a sleeping capture exactly when
 * something it read has changed. A store that reads across captures records the key where it reads, so no list of wake
 * cases has to be kept up to date beside it.
 */
import type { CaptureId, MemoKey, SourceId } from "../shared/ids";

export type Dep = string & { readonly __dep: unique symbol };

/** A memo entry: a hit stored, a terminal failure recorded, a failure cleared. */
export const memoDep = (key: MemoKey): Dep => `memo:${key}` as Dep;
/** Facts of one capture. */
export const captureDep = (captureId: CaptureId): Dep => `capture:${captureId}` as Dep;
/** Facts about one source in any capture: an evidence bundle gathers them across captures that watched it. */
export const sourceDep = (sourceId: SourceId): Dep => `source:${sourceId}` as Dep;
/** The user's deletions and the retention sweep, which remove evidence from every capture that held it. */
export const REMOVALS = "removals" as Dep;
/** One frozen input slot, shared by every capture that reaches the same claim or concept. */
export const slotDep = (kind: string, subject: string): Dep => `slot:${kind}:${subject}` as Dep;

/** Reports a read. Absent where nothing listens. */
export type ReadDep = (dep: Dep) => void;
