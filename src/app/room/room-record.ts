/**
 * The saved record as the review room holds it: the progress from the last read that succeeded, and how current that
 * progress is. Reads go through here and nowhere else, so the panel and the room's objects can never disagree about it.
 *
 * - `current`: the latest read succeeded and nothing has changed the record since.
 * - `refreshing`: something changed the record (a correction in Saved notes, a saved review) and the read it started is out.
 * - `stale`: the latest read failed.
 *
 * Every state carries the progress from the last good read. Only a read that succeeds replaces it.
 */
import { onRecordChange } from "../api";
import type { AppApi } from "../api";
import { deriveProgress } from "./progress";
import type { Progress, RoomId, UnlockId } from "./progress";

export type Freshness = "current" | "refreshing" | "stale";

/** Null until a read first succeeds: with no counts there is nothing to show. */
export type RoomStanding = { readonly freshness: Freshness; readonly progress: Progress } | null;

export type RoomRecord = {
  /** `api` with every call that changes the record reading it again once it settles. Saved notes mounts this one. */
  readonly api: AppApi;
  /** Reads the record again. Only the latest read's answer counts. */
  read(): void;
  subscribe(listener: () => void): () => void;
  getState(): RoomStanding;
};

export function roomRecord(api: AppApi): RoomRecord {
  let state: RoomStanding = null;
  let latest = 0;
  const listeners = new Set<() => void>();
  const set = (next: RoomStanding) => {
    state = next;
    for (const listener of listeners) listener();
  };
  function read() {
    const id = ++latest;
    if (state?.freshness === "current") set({ ...state, freshness: "refreshing" });
    api.record({}).then(
      (record) => { if (id === latest) set({ freshness: "current", progress: deriveProgress(record.observations) }); },
      () => { if (id === latest && state !== null) set({ ...state, freshness: "stale" }); },
    );
  }
  return {
    api: onRecordChange(api, read),
    read,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
  };
}

/** The objects the room draws: those of the last good read, whatever its freshness, so a slow or failed read never makes them flicker. */
export function drawnUnlocks(standing: RoomStanding, room: RoomId): readonly UnlockId[] {
  return standing?.progress.unlocks[room] ?? [];
}
