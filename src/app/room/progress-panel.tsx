import { useId } from "react";
import { slotIds } from "./progress";
import type { Count, Progress, RoomId, UnlockId } from "./progress";
import type { Freshness, RoomStanding } from "./room-record";
import { UNLOCK_ART } from "./art";

/** One line of the panel: what a count counts, as progress.ts words it, and the count. */
export type ProgressRow = { readonly key: string; readonly label: string; readonly value: number };

/**
 * The panel's lines for `room`. `main` are the counts the room grows from and the reviews they came from. `effort` stands
 * apart and is shown smaller, since it never counts as understanding. The count toward the next object shows only when that
 * object has a picture (room/unlocks.ts), so the panel never promises something the room cannot show.
 */
export function progressRows(progress: Progress, room: RoomId, art: Readonly<Partial<Record<UnlockId, string>>> = UNLOCK_ART) {
  const row = (key: string, { label, value }: Count): ProgressRow => ({ key, label: label[0]!.toUpperCase() + label.slice(1), value });
  const next = slotIds(room)[progress.unlocks[room].length];
  const toNext = progress.toNextUnlock !== null && next !== undefined && art[next] !== undefined ? [row("next", progress.toNextUnlock)] : [];
  return {
    main: [row("understood", progress.understood), ...toNext, row("reviews", progress.reviews)],
    effort: [row("effort", progress.effort)],
  } as const;
}

/** What the panel says above the counts, for each freshness. Only `current` says they are counted from the saved reviews. */
const NOTICE = {
  current: "Counted from your saved reviews.",
  refreshing: "Updating from your saved reviews. These counts were read before your latest change.",
  stale: "These counts may be out of date. Your saved reviews could not be read again, so the room keeps what it last read.",
} as const satisfies Record<Freshness, string>;

/**
 * "Your room": the learner's counts from their saved reviews, in a panel the bar's menu opens (`open`). A full room floats it
 * under the bar at the right, and a phone stacks it below the desk. Close shuts it (`close`), and so does Escape, which the review
 * listens for.
 */
export function ProgressPanel({ standing: { freshness, progress }, room, open, close, retry }: {
  readonly standing: NonNullable<RoomStanding>; readonly room: RoomId; readonly open: boolean; readonly close: () => void; readonly retry: () => void;
}) {
  const noticeId = useId();
  const { main, effort } = progressRows(progress, room);
  const busy = freshness === "refreshing";
  return (
    <section
      className="room-progress" aria-label="Your room" aria-describedby={freshness === "current" ? undefined : noticeId} data-open={open} data-freshness={freshness} hidden={!open}
    >
      <div className="room-progress-body">
        {freshness === "current" ? <p>{NOTICE.current}</p>
          : freshness === "refreshing" ? <p id={noticeId} className="room-progress-notice" role="status">{NOTICE.refreshing}</p>
          : <p id={noticeId} className="room-progress-notice" role="alert">{NOTICE.stale} <button type="button" onClick={retry}>Retry</button></p>}
        <dl aria-busy={busy || undefined}>{main.map(({ key, label, value }) => <div key={key} data-count={key}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <dl className="room-progress-effort" aria-busy={busy || undefined}>{effort.map(({ key, label, value }) => <div key={key} data-count={key}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <button type="button" className="room-progress-close" onClick={close}>Close</button>
      </div>
    </section>
  );
}
