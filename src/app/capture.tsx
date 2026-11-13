import { useCallback, useRef, useState } from "react";
import { randomId } from "../shared/ids";
import type { CaptureId, ReviewId } from "../shared/ids";
import type { ReviewOptions, StartChoice } from "../shared/domain";
import type { AppApi } from "./api";
import { formatClock, inspectBundle, lectureHeading, optionsScreen, sourceTitles, sourceVideos } from "./core";
import type { OptionsScreen, ScopeSummary, SourceTitles, StartOffer } from "./core";
import { usePolled } from "./poll";
import { objectFrame } from "./room-object";
import { BundleInspector, ErrorNote, EvidencePane, Link, navigate, useAsync } from "./ui";


const POLL_MS = 3000;
const isProcessing = (options: ReviewOptions): boolean => options.kind === "processing";

export type OptionsViewProps = {
  readonly screen: OptionsScreen;
  readonly busy: boolean;
  readonly onStart: (c: StartChoice) => void;
  /** Ask the backend for fresh review options. */
  readonly onRetry: () => void;
  readonly api: AppApi;
  readonly titles: SourceTitles;
};

export function OptionsView({ screen, busy, onStart, onRetry, api, titles }: OptionsViewProps) {
  switch (screen.kind) {
    case "ready":
      return (
        <section className="invitation-paper" aria-labelledby="invitation-heading">
          <p className="page-kicker">A little space to think</p>
          <h2 id="invitation-heading">Ready to review</h2>
          <ScopeDetails scope={screen.scope} />
          <Offers offers={screen.offers} busy={busy} onStart={onStart} />
        </section>
      );
    case "processing":
      return (
        <section className="invitation-paper" aria-labelledby="invitation-heading">
          <p className="page-kicker">Getting your lecture ready</p>
          <h2 id="invitation-heading">{screen.ready ? "Some topics are ready" : "Preparing your lecture"}</h2>
          <p>
            {screen.pendingChunks} {screen.ready ? "more " : ""}section{screen.pendingChunks === 1 ? " is" : "s are"} still being prepared.
            {screen.ready && <> {screen.pendingChunks === 1 ? "It is" : "They are"} not in a review you start now.</>}
            {screen.estimate !== null && <> Estimated time left: {screen.estimate}.</>}
          </p>
          {screen.estimate === null && <p className="muted">No reliable time estimate yet.</p>}
          {screen.ready && <ScopeDetails scope={screen.ready} />}
          <Offers offers={screen.offers} busy={busy} onStart={onStart} />
          <p className="muted">This page checks again every few seconds.</p>
        </section>
      );
    case "nothing":
      return (
        <section className="invitation-paper" aria-labelledby="invitation-heading">
          <p className="page-kicker">Only what the source supports</p>
          <h2 id="invitation-heading">Nothing to review yet</h2>
          <p>No claim from this capture has passed the evidence check, so there is nothing fair to ask you about.</p>
          {screen.gaps.length > 0 && (
            <>
              <h3>Capture gaps</h3>
              <ul>{screen.gaps.map((g, i) => <li key={i}>{g.where}: {g.reason}</li>)}</ul>
            </>
          )}
          {screen.unverified.length > 0 && (
            <>
              <h3>Claims the source did not confirm</h3>
              <ul>
                {screen.unverified.map((u, i) => (
                  <li key={i}>
                    {u.text} <span className="muted">({u.status})</span>
                    {u.evidence.length > 0 ? <EvidencePane api={api} ids={u.evidence} titles={titles} /> : <p className="muted">It cited no source passage or frame.</p>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {screen.rewatch.length > 0 && (
            <>
              <h3>Rewatch to fill in</h3>
              <ul>
                {screen.rewatch.map((r, i) => (
                  <li key={i}>
                    {r.href === null ? r.where : <a href={r.href} target="_blank" rel="noopener noreferrer">{r.where}</a>}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p>
            <button type="button" disabled={busy} onClick={onRetry}>Check again</button> <span className="muted">Looks for claims that have passed the evidence check since.</span>
          </p>
        </section>
      );
  }
}

/** The named topics, the watched stretches they come from, and the limits of this review. A claim count stands in only when no topic has a name. */
function ScopeDetails({ scope }: { readonly scope: ScopeSummary }) {
  return (
    <>
      <h3>Topics in this review</h3>
      {scope.topics.length > 0
        ? <ul className="scope-topics">{scope.topics.map((t, i) => <li key={i}>{t}</li>)}</ul>
        : <p>Topic names are not available for this material. It has {scope.supportedClaims} claim{scope.supportedClaims === 1 ? "" : "s"} that passed the evidence check.</p>}
      {scope.covered.length > 0 && <p className="muted">From {scope.covered.join("; ")}.</p>}
      {scope.limits.length > 0 && (
        <div className="note partial-notice">
          <strong>Limits of this review</strong>
          <ul>{scope.limits.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      )}
    </>
  );
}

/** The first offer is the usual start. The rest sit behind a disclosure, each with what it gives up. */
function Offers({ offers, busy, onStart }: { readonly offers: readonly StartOffer[]; readonly busy: boolean; readonly onStart: (c: StartChoice) => void }) {
  const [usual, ...others] = offers;
  if (usual === undefined) return null;
  return (
    <div className="invitation-offers">
      <div className="invitation-offer">
        <button className="page-primary" type="button" disabled={busy} onClick={() => onStart(usual.choice)}>{usual.label}</button>
        {usual.note !== "" && <span className="muted"> {usual.note}</span>}
      </div>
      {others.length > 0 && (
        <details className="invitation-more">
          <summary>Other ways to start</summary>
          {others.map((o) => (
            <p key={o.choice}>
              <button type="button" disabled={busy} onClick={() => onStart(o.choice)}>{o.label}</button> <span className="muted">{o.note}</span>
            </p>
          ))}
        </details>
      )}
    </div>
  );
}

/** "Check again": ask the backend to re-queue preparation, then look at the options once more even if that ask failed. */
export async function checkAgain(
  api: AppApi,
  captureId: CaptureId,
  hooks: { readonly reload: () => void; readonly onError: (message: string | null) => void },
): Promise<void> {
  hooks.onError(null);
  try {
    await api.retryPreparation(captureId);
  } catch (e) {
    hooks.onError(e instanceof Error ? e.message : String(e));
  }
  hooks.reload();
}

export function CaptureScreen({ api, captureId }: { readonly api: AppApi; readonly captureId: CaptureId }) {
  const capture = useAsync(useCallback(() => api.captureView(captureId), [api, captureId]));
  const options = usePolled(useCallback(() => api.reviewOptions(captureId), [api, captureId]), isProcessing, POLL_MS);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [refused, setRefused] = useState<ReviewOptions | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const actionPending = useRef(false);
  // One id per choice until the start settles, so a retried start is the same review.
  const pendingIds = useRef(new Map<StartChoice, ReviewId>());

  const titles = sourceTitles(capture.data?.capture ?? null);
  const videos = sourceVideos(capture.data?.capture ?? null);
  const shown = refused ?? options.data;

  async function start(choice: StartChoice) {
    if (actionPending.current) return;
    actionPending.current = true;
    const reviewId = pendingIds.current.get(choice) ?? randomId("rvw");
    pendingIds.current.set(choice, reviewId);
    setStarting(true);
    setStartError(null);
    try {
      const result = await api.startReview(captureId, choice, reviewId);
      if (result.kind === "started") navigate({ page: "review", id: result.reviewId });
      else {
        pendingIds.current.delete(choice);
        setRefused(result);
      }
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      actionPending.current = false;
      setStarting(false);
    }
  }

  async function answer(kind: "later" | "wait") {
    if (actionPending.current) return;
    actionPending.current = true;
    setStarting(true);
    setStartError(null);
    try {
      await api.answerInvite(captureId, kind);
      capture.reload();
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      actionPending.current = false;
      setStarting(false);
    }
  }

  return (
    <main className="notebook-page capture-page room-paper" {...objectFrame("source")}>
      <header className="page-heading">
        <div><p className="page-kicker">After Class</p><h1>Your lecture</h1></div>
        <nav aria-label="Capture navigation"><Link to={{ page: "record", reviewId: null }}>My notebook</Link> <Link to={{ page: "usage" }}>Usage</Link></nav>
      </header>
      <ErrorNote error={capture.error} retry={capture.reload} />
      {capture.data && (
        <p className="capture-summary">
          {summaryTitle(capture.data.capture.sources.map((s) => s.title))} · capture {capture.data.capture.status.state} ·{" "}
          {formatClock(capture.data.capture.watchedSeconds)} watched · captions {capture.data.capture.transcript.replaceAll("_", " ")}
        </p>
      )}
      <ErrorNote error={options.error} retry={options.reload} />
      <ErrorNote error={startError} />
      {options.data === null && options.error === null && <p className="page-loading" role="status">Looking for prepared lecture material...</p>}
      {starting && <p className="page-loading" role="status">Saving your choice...</p>}
      {shown && (
        <OptionsView
          screen={optionsScreen(shown, titles, videos)}
          busy={starting}
          onStart={start}
          onRetry={() => {
            if (actionPending.current) return;
            actionPending.current = true;
            setRefused(null);
            setStarting(true);
            void checkAgain(api, captureId, { reload: options.reload, onError: setStartError }).finally(() => { actionPending.current = false; setStarting(false); });
          }}
          api={api}
          titles={titles}
        />
      )}
      {shown?.kind === "ready" && (
        <p>
          <button type="button" disabled={starting} onClick={() => answer("later")}>Later</button> <span className="muted">Keeps preparing; you will be invited again at the next boundary.</span>
        </p>
      )}
      {shown?.kind === "processing" && (
        <p>
          <button type="button" disabled={starting} onClick={() => answer("wait")}>Wait</button> <span className="muted">Stay here until it is ready.</span>
        </p>
      )}
      <section className="capture-source-paper" aria-labelledby="capture-evidence-heading">
        <h2 id="capture-evidence-heading">Capture evidence</h2>
        <p className="muted">Inspect the watched intervals, source material, and any missing coverage.</p>
        <button type="button" aria-expanded={showEvidence} aria-controls="capture-evidence" onClick={() => setShowEvidence((v) => !v)}>{showEvidence ? "Hide" : "Inspect"} evidence bundle</button>
        <div id="capture-evidence" hidden={!showEvidence}>{showEvidence && <CaptureEvidence api={api} captureId={captureId} titles={titles} />}</div>
      </section>
    </main>
  );
}

function summaryTitle(titles: readonly string[]): string {
  if (titles.length === 0) return "No source yet";
  const h = lectureHeading(titles);
  return h.detail === null ? h.title : `${h.title} (${h.detail})`;
}

function CaptureEvidence({ api, captureId, titles }: { readonly api: AppApi; readonly captureId: CaptureId; readonly titles: SourceTitles }) {
  const bundle = useAsync(useCallback(() => api.evidence({ captureId }), [api, captureId]));
  if (bundle.error !== null) return <ErrorNote error={bundle.error} retry={bundle.reload} />;
  if (bundle.data === null) return <p className="muted">Loading...</p>;
  return <BundleInspector report={inspectBundle(bundle.data, titles)} />;
}
