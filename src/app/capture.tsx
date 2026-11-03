import { useEffect, useRef, useState } from "react";
import { randomId } from "../shared/ids";
import type { CaptureId, ReviewId } from "../shared/ids";
import type { ReviewOptions, StartChoice } from "../shared/domain";
import type { AppApi } from "./api";
import { formatClock, inspectBundle, optionsScreen, sourceTitles, sourceVideos } from "./core";
import type { OptionsScreen, SourceTitles, StartOffer } from "./core";
import { BundleInspector, ErrorNote, EvidencePane, Link, navigate, useAsync } from "./ui";

const POLL_MS = 3000;

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
        <section>
          <h2>Ready to review</h2>
          <p>{screen.supportedClaims} claim{screen.supportedClaims === 1 ? "" : "s"} supported by the lecture evidence.</p>
          <Partial items={screen.partial} />
          <Offers offers={screen.offers} busy={busy} onStart={onStart} />
        </section>
      );
    case "processing":
      return (
        <section>
          <h2>Processing</h2>
          <p>
            {screen.pendingChunks} section{screen.pendingChunks === 1 ? " is" : "s are"} still being prepared.
            {screen.estimate !== null && <> Estimated time left: {screen.estimate}.</>}
          </p>
          {screen.estimate === null && <p className="muted">No reliable time estimate yet.</p>}
          {screen.ready && (
            <>
              <p>{screen.ready.supportedClaims} claim{screen.ready.supportedClaims === 1 ? " is" : "s are"} ready now.</p>
              <Partial items={screen.ready.partial} />
            </>
          )}
          <Offers offers={screen.offers} busy={busy} onStart={onStart} />
          <p className="muted">This page checks again every few seconds.</p>
        </section>
      );
    case "nothing":
      return (
        <section>
          <h2>Nothing to review yet</h2>
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

function Partial({ items }: { readonly items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="note">
      <strong>This review is partial.</strong>
      <ul>{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
    </div>
  );
}

function Offers({ offers, busy, onStart }: { readonly offers: readonly StartOffer[]; readonly busy: boolean; readonly onStart: (c: StartChoice) => void }) {
  return (
    <div className="actions">
      {offers.map((o) => (
        <div key={o.choice}>
          <button type="button" disabled={busy} onClick={() => onStart(o.choice)}>{o.label}</button>
          <span className="muted"> {o.note}</span>
        </div>
      ))}
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
  const capture = useAsync(() => api.captureView(captureId), [api, captureId]);
  const options = useAsync(() => api.reviewOptions(captureId), [api, captureId]);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [refused, setRefused] = useState<ReviewOptions | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  // One id per choice until the start settles, so a retried start is the same review.
  const pendingIds = useRef(new Map<StartChoice, ReviewId>());

  const processing = options.data?.kind === "processing";
  const { reload } = options;
  useEffect(() => {
    if (!processing) return;
    const timer = setTimeout(reload, POLL_MS);
    return () => clearTimeout(timer);
  }, [processing, options.data, reload]);

  const titles = sourceTitles(capture.data?.capture ?? null);
  const videos = sourceVideos(capture.data?.capture ?? null);
  const shown = refused ?? options.data;

  async function start(choice: StartChoice) {
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
      setStarting(false);
    }
  }

  async function answer(kind: "later" | "wait") {
    try {
      await api.answerInvite(captureId, kind);
      capture.reload();
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main>
      <h1>Review</h1>
      <ErrorNote error={capture.error} retry={capture.reload} />
      {capture.data && (
        <p className="muted">
          {capture.data.capture.sources.map((s) => s.title).join("; ") || "No source yet"} · capture {capture.data.capture.status.state} ·{" "}
          {formatClock(capture.data.capture.watchedSeconds)} watched · captions {capture.data.capture.transcript.replaceAll("_", " ")}
        </p>
      )}
      <ErrorNote error={options.error} retry={options.reload} />
      <ErrorNote error={startError} />
      {shown && (
        <OptionsView
          screen={optionsScreen(shown, titles, videos)}
          busy={starting}
          onStart={start}
          onRetry={() => {
            setRefused(null);
            setStarting(true);
            void checkAgain(api, captureId, { reload: options.reload, onError: setStartError }).finally(() => setStarting(false));
          }}
          api={api}
          titles={titles}
        />
      )}
      {shown?.kind === "ready" && (
        <p>
          <button type="button" onClick={() => answer("later")}>Later</button> <span className="muted">Keeps preparing; you will be invited again at the next boundary.</span>
        </p>
      )}
      {shown?.kind === "processing" && (
        <p>
          <button type="button" onClick={() => answer("wait")}>Wait</button> <span className="muted">Stay here until it is ready.</span>
        </p>
      )}
      <section>
        <h2>Capture evidence</h2>
        <button type="button" onClick={() => setShowEvidence((v) => !v)}>{showEvidence ? "Hide" : "Inspect"} evidence bundle</button>
        {showEvidence && <CaptureEvidence api={api} captureId={captureId} titles={titles} />}
      </section>
      <p><Link to={{ page: "usage" }}>Usage</Link> · <Link to={{ page: "record", reviewId: null }}>Saved record</Link></p>
    </main>
  );
}

function CaptureEvidence({ api, captureId, titles }: { readonly api: AppApi; readonly captureId: CaptureId; readonly titles: SourceTitles }) {
  const bundle = useAsync(() => api.evidence({ captureId }), [api, captureId]);
  if (bundle.error !== null) return <ErrorNote error={bundle.error} retry={bundle.reload} />;
  if (bundle.data === null) return <p className="muted">Loading...</p>;
  return <BundleInspector report={inspectBundle(bundle.data, titles)} />;
}
