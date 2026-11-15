import { useId, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Rect } from "./layout";
import { slotIds } from "./progress";
import type { Count, Progress, RoomId, UnlockId } from "./progress";
import type { Freshness, RoomStanding } from "./room-record";
import { UNLOCK_ART } from "./unlocks";

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
 * "Your room": a button that opens the learner's counts from their saved reviews. Full rooms place it at `rect`, the desk's
 * corner around the companion, so it never covers the board or Your thinking. A phone stacks it below the desk.
 */
export function ProgressPanel({ standing: { freshness, progress }, room, rect, retry }: { readonly standing: NonNullable<RoomStanding>; readonly room: RoomId; readonly rect: Rect | undefined; readonly retry: () => void }) {
  const [open, setOpen] = useState(false);
  const body = useId();
  const noticeId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const { main, effort } = progressRows(progress, room);
  const style: CSSProperties | undefined = rect && { left: rect.left, top: rect.top, width: rect.width, maxHeight: rect.height };
  const busy = freshness === "refreshing";
  return (
    <section
      className="room-progress" aria-label="Your room" data-open={open} data-freshness={freshness} style={style}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
        toggle.current?.focus();
      }}
    >
      <button ref={toggle} type="button" aria-expanded={open} aria-controls={body} aria-describedby={freshness === "current" ? undefined : noticeId} onClick={() => setOpen(!open)}>Your room</button>
      <div id={body} className="room-progress-body" hidden={!open}>
        {freshness === "current" ? <p>{NOTICE.current}</p>
          : freshness === "refreshing" ? <p id={noticeId} className="room-progress-notice" role="status">{NOTICE.refreshing}</p>
          : <p id={noticeId} className="room-progress-notice" role="alert">{NOTICE.stale} <button type="button" onClick={retry}>Retry</button></p>}
        <dl aria-busy={busy || undefined}>{main.map(({ key, label, value }) => <div key={key} data-count={key}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <dl className="room-progress-effort" aria-busy={busy || undefined}>{effort.map(({ key, label, value }) => <div key={key} data-count={key}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      </div>
    </section>
  );
}
