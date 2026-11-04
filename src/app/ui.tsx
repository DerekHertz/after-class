import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { EvidenceId } from "../shared/ids";
import type { TranscriptOrigin } from "../shared/domain";
import type { AppApi } from "./api";
import { formatClock, formatInterval, routePath, watchUrl } from "./core";
import type { BundleReport, Route, SourceTitles, SourceVideos } from "./core";

// ───────────────────────────── Navigation ───────────────────────────────────

const NAV_EVENT = "afterclass:navigate";

export function navigate(route: Route): void {
  history.pushState(null, "", routePath(route));
  window.dispatchEvent(new Event(NAV_EVENT));
}

export function usePathname(): string {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener("popstate", listener);
      window.addEventListener(NAV_EVENT, listener);
      return () => {
        window.removeEventListener("popstate", listener);
        window.removeEventListener(NAV_EVENT, listener);
      };
    },
    () => location.pathname,
    () => "/app/",
  );
}

export function Link({ to, children }: { readonly to: Route; readonly children: ReactNode }) {
  return (
    <a
      href={routePath(to)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

// ───────────────────────────── Loading ──────────────────────────────────────

export type Async<T> = { readonly data: T | null; readonly error: string | null; readonly loading: boolean; readonly reload: () => void };

/** Keeps the last data while reloading, so polling never blanks the screen. */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): Async<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    load().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (e: unknown) => live && setState((s) => ({ data: s.data, error: e instanceof Error ? e.message : String(e), loading: false })),
    );
    return () => {
      live = false;
    };
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

export function ErrorNote({ error, retry }: { readonly error: string | null; readonly retry?: () => void }) {
  if (error === null) return null;
  return (
    <p className="note note-error" role="alert">
      {error} {retry && <button type="button" onClick={retry}>Retry</button>}
    </p>
  );
}

// ───────────────────────────── Evidence ─────────────────────────────────────

export function FrameImage({ api, id }: { readonly api: AppApi; readonly id: EvidenceId }) {
  const [image, setImage] = useState<{ id: EvidenceId; src: string | null; failed: boolean }>({ id, src: null, failed: false });
  useEffect(() => {
    let url: string | null = null;
    let live = true;
    setImage({ id, src: null, failed: false });
    api.frameImage(id).then(
      (blob) => {
        if (!live) return;
        url = URL.createObjectURL(blob);
        setImage({ id, src: url, failed: false });
      },
      () => live && setImage({ id, src: null, failed: true }),
    );
    return () => {
      live = false;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [api, id]);
  if (image.id === id && image.failed) return <p className="muted">Frame not available.</p>;
  return image.id !== id || image.src === null ? <p className="muted">Loading frame...</p> : <img className="frame" src={image.src} alt="Lecture frame" />;
}

/** The source evidence for a set of ids: transcript passages and frames. An id the backend does not return is shown as unavailable. */
const TRANSCRIPT_ORIGIN: Readonly<Record<TranscriptOrigin, string>> = {
  panel: "YouTube transcript panel",
  caption_intercept: "YouTube player captions",
  asr: "Opt-in transcription",
};

type EvidenceProps = { readonly api: AppApi; readonly ids: readonly EvidenceId[]; readonly titles: SourceTitles; readonly videos?: SourceVideos };

export function EvidencePane(props: EvidenceProps) {
  return <EvidenceContents key={props.ids.join(",")} {...props} />;
}

function EvidenceContents({ api, ids, titles, videos }: EvidenceProps) {
  const key = ids.join(",");
  const bundle = useAsync(() => (ids.length === 0 ? Promise.resolve(null) : api.evidence({ ids })), [api, key]);
  if (ids.length === 0) return <p className="muted">Source evidence appears here when the tutor explains or checks something.</p>;
  if (bundle.error !== null) return <ErrorNote error={bundle.error} retry={bundle.reload} />;
  if (bundle.data === null) return <p className="muted">Loading evidence...</p>;
  const { passages, frames } = bundle.data;
  const found = new Set<string>([...passages.map((p) => p.id), ...frames.map((f) => f.id)]);
  const missing = ids.filter((id) => !found.has(id));
  return (
    <div className="evidence">
      {frames.map((f) => (
        <figure key={f.id}>
          <FrameImage api={api} id={f.id} />
          <figcaption className="muted">Captured frame · {titles.get(f.sourceId) ?? "Lecture"} at {formatClock(f.mediaS)}
            {videos?.has(f.sourceId) && <> · <a href={watchUrl(videos.get(f.sourceId)!, f.mediaS)} target="_blank" rel="noreferrer">Open in YouTube ↗</a></>}
          </figcaption>
        </figure>
      ))}
      {passages.map((p) => (
        <blockquote key={p.id}>
          <p>{p.text}</p>
          <footer className="muted">{TRANSCRIPT_ORIGIN[p.origin]} · {titles.get(p.sourceId) ?? "Lecture"}, {formatInterval(p.interval)}
            {videos?.has(p.sourceId) && <> · <a href={watchUrl(videos.get(p.sourceId)!, p.interval.start)} target="_blank" rel="noreferrer">Open in YouTube ↗</a></>}
          </footer>
        </blockquote>
      ))}
      {missing.length > 0 && <p className="muted">{missing.length} evidence item{missing.length === 1 ? " is" : "s are"} no longer available.</p>}
    </div>
  );
}

/** Capture evidence-bundle inspector: watched intervals, passages, frames, gaps, ads, and watched time with neither evidence nor a gap. */
export function BundleInspector({ report }: { readonly report: BundleReport }) {
  return (
    <div className="inspector">
      <h4>Watched intervals</h4>
      {report.watched.length === 0 ? <p className="muted">Nothing watched yet.</p> : (
        <ul>
          {report.watched.map((w) => (
            <li key={w.source}>{w.source}: {w.intervals.join(", ")} ({formatClock(w.seconds)} total)</li>
          ))}
        </ul>
      )}
      <h4>Evidence</h4>
      <p>
        {report.passages} caption passage{report.passages === 1 ? "" : "s"}; {report.frames.total} frame{report.frames.total === 1 ? "" : "s"} (
        {report.frames.kept} kept, {report.frames.uncertain} uncertain).
      </p>
      <h4>Gaps</h4>
      {report.gaps.length === 0 ? <p className="muted">No logged gaps.</p> : (
        <ul>
          {report.gaps.map((g, i) => (
            <li key={i}>{g.where}: {g.reason} ({g.channel})</li>
          ))}
        </ul>
      )}
      <h4>Watched time with neither evidence nor a logged gap</h4>
      {report.uncovered.length === 0 ? <p className="muted">None.</p> : (
        <ul className="warn">
          {report.uncovered.map((u, i) => (
            <li key={i}>{u.source}: {u.interval}</li>
          ))}
        </ul>
      )}
      <h4>Ads (never evidence)</h4>
      {report.ads.length === 0 ? <p className="muted">None logged.</p> : (
        <ul>
          {report.ads.map((a, i) => (
            <li key={i}>{a.where} ({a.seconds.toFixed(0)} s)</li>
          ))}
        </ul>
      )}
    </div>
  );
}
