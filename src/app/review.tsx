import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReviewId } from "../shared/ids";
import type { AppApi } from "./api";
import { createReviewController } from "./controller";
import type { SessionState } from "./controller";
import {
  ACTION_LABEL, availableActions, conversationLines, currentEvidenceIds, inspectBundle, liveText, MOVE_LABEL, NEEDS_TEXT, observationRow,
  softTargetPrompt, sourceTitles, toAct, unansweredLearnerTurn,
} from "./core";
import type { ActionId, Line } from "./core";
import type { Speaker, SpeechInput } from "./speech";
import type { UnsentStore } from "./unsent";
import { BundleInspector, ErrorNote, EvidencePane, Link, useAsync } from "./ui";

export type ReviewDeps = { readonly api: AppApi; readonly speaker: Speaker; readonly speech: SpeechInput; readonly unsent: UnsentStore };

export function ReviewScreen({ api, speaker, speech, unsent, reviewId }: ReviewDeps & { readonly reviewId: ReviewId }) {
  const controller = useMemo(() => createReviewController({ api, reviewId, speaker, unsent }), [api, reviewId, speaker, unsent]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  useEffect(() => {
    void controller.load();
  }, [controller]);

  const captureId = state.view?.captureId ?? null;
  const capture = useAsync(() => (captureId === null ? Promise.resolve(null) : api.captureView(captureId)), [api, captureId]);
  const titles = sourceTitles(capture.data?.capture ?? null);

  const view = state.view;
  if (view === null) {
    return (
      <main>
        <h1>Review</h1>
        <ErrorNote error={state.loadError} retry={() => void controller.load()} />
        {state.loadError === null && <p className="muted">Loading...</p>}
      </main>
    );
  }

  const lines = conversationLines(view.turns);
  const soft = softTargetPrompt(view.turns);
  const actions = availableActions(view.state, soft !== null);
  const streaming = state.live?.status === "streaming";
  const evidenceIds = currentEvidenceIds(view.turns, state.live);
  const unanswered = unansweredLearnerTurn(view.turns);
  const canRetry = !streaming && (state.unsent.length > 0 || unanswered !== null || state.live?.status === "failed");

  return (
    <main className="review">
      <header>
        <h1>Review</h1>
        <span className="muted">{view.state.phase}</span>
      </header>
      <SaveBanner state={state} onRetry={() => void controller.save()} reviewId={reviewId} />
      <ErrorNote error={state.loadError} retry={() => void controller.load()} />
      <div className="split">
        <aside>
          <h2>Source</h2>
          <EvidencePane api={api} ids={evidenceIds} titles={titles} />
          <ScopeEvidence api={api} view={view} titles={titles} />
        </aside>
        <section>
          <h2>Conversation</h2>
          <ol className="lines">
            {lines.map((l) => <LineItem key={l.key} line={l} />)}
            {state.live && state.live.status !== "complete" && (
              <li className="line tutor">
                <strong>{state.live.move ? MOVE_LABEL[state.live.move.kind] : "Tutor"}</strong>
                <p>{liveText(state.live) || "..."}</p>
                {state.live.status === "failed" && <p className="note note-error">{state.live.error}</p>}
              </li>
            )}
          </ol>
          {canRetry && (
            <p className="note">
              {state.unsent.length > 0
                ? "Your last message was not delivered."
                : state.live?.status === "failed"
                  ? "The tutor's reply did not finish."
                  : "The tutor has not replied to your last message."}{" "}
              <button type="button" onClick={() => void controller.retryTurn()}>Retry</button>
            </p>
          )}
          {soft && (
            <div className="note">
              <p>You have been at this a while. Keep going, or wrap up and save?</p>
              <Actions ids={actions.filter((a) => a === "continue" || a === "wrap_up")} disabled={streaming} send={(id) => void controller.send(toAct(id, "", "text"))} />
            </div>
          )}
          <Composer
            actions={actions.filter((a) => a !== "continue" && a !== "wrap_up")}
            disabled={streaming || state.unsent.length > 0}
            sendError={state.sendError}
            speech={speech}
            onSpeaking={controller.learnerSpeaking}
            send={(id, text, modality) => controller.send(toAct(id, text, modality))}
          />
          {view.observations.length > 0 && (
            <div>
              <h2>What the tutor observed</h2>
              <ul>
                {view.observations.map((o) => {
                  const row = observationRow(o);
                  return (
                    <li key={o.id}>
                      <strong>{row.status}</strong>
                      {row.note && <span className="muted"> {row.note}</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function LineItem({ line }: { readonly line: Line }) {
  return (
    <li className={`line ${line.speaker}`}>
      <strong>{line.label}</strong>
      <p>{line.text}</p>
    </li>
  );
}

function SaveBanner({ state, onRetry, reviewId }: { readonly state: SessionState; readonly onRetry: () => void; readonly reviewId: ReviewId }) {
  const pending = state.saveError !== null || state.view?.saved === "save_pending";
  if (pending) {
    return (
      <p className="note note-error" role="alert">
        This review is not saved yet{state.saveError ? `: ${state.saveError}` : ""}. Your turns are kept on this computer. Retrying never makes a duplicate.{" "}
        <button type="button" disabled={state.saving} onClick={onRetry}>{state.saving ? "Saving..." : "Retry save"}</button>
      </p>
    );
  }
  if (state.view?.saved === "saved") {
    return (
      <p className="note">
        Saved. <Link to={{ page: "record", reviewId }}>Open the record</Link>
      </p>
    );
  }
  return null;
}

function ScopeEvidence({ api, view, titles }: { readonly api: AppApi; readonly view: NonNullable<SessionState["view"]>; readonly titles: ReturnType<typeof sourceTitles> }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Everything in this review's scope</summary>
      {open && <ScopeBundle api={api} view={view} titles={titles} />}
    </details>
  );
}

function ScopeBundle({ api, view, titles }: { readonly api: AppApi; readonly view: NonNullable<SessionState["view"]>; readonly titles: ReturnType<typeof sourceTitles> }) {
  const bundle = useAsync(() => api.evidence({ material: view.scope.material }), [api, view.reviewId]);
  if (bundle.error !== null) return <ErrorNote error={bundle.error} retry={bundle.reload} />;
  if (bundle.data === null) return <p className="muted">Loading...</p>;
  return <BundleInspector report={inspectBundle(bundle.data, titles)} />;
}

function Actions({ ids, disabled, send }: { readonly ids: readonly ActionId[]; readonly disabled: boolean; readonly send: (id: ActionId) => void }) {
  return (
    <span className="actions">
      {ids.map((id) => (
        <button key={id} type="button" disabled={disabled} onClick={() => send(id)}>{ACTION_LABEL[id]}</button>
      ))}
    </span>
  );
}

function Composer({
  actions, disabled, sendError, speech, onSpeaking, send,
}: {
  readonly actions: readonly ActionId[];
  readonly disabled: boolean;
  readonly sendError: string | null;
  readonly speech: SpeechInput;
  readonly onSpeaking: () => void;
  readonly send: (id: ActionId, text: string, modality: "speech" | "text") => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const [listening, setListening] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const modality = useRef<"speech" | "text">("text");
  const hasText = actions.includes("answer");

  function toggleListening() {
    if (listening) {
      speech.stop();
      return;
    }
    setSpeechError(null);
    setListening(true);
    speech.start({
      onSpeechStart: onSpeaking,
      onTranscript: (text) => {
        modality.current = "speech";
        setDraft(text);
      },
      onEnd: () => setListening(false),
      onError: (m) => {
        setSpeechError(m);
        setListening(false);
      },
    });
  }

  async function fire(id: ActionId) {
    const text = draft.trim();
    const accepted = await send(id, text, modality.current);
    if (accepted && NEEDS_TEXT.has(id)) {
      setDraft("");
      modality.current = "text";
    }
  }

  const empty = draft.trim() === "";
  return (
    <div className="composer">
      {sendError !== null && <p className="note note-error" role="alert">{sendError}</p>}
      {hasText && (
        <>
          <textarea
            value={draft}
            rows={3}
            placeholder="Speak or type your answer"
            onChange={(e) => {
              modality.current = "text";
              setDraft(e.target.value);
            }}
          />
          <div className="actions">
            {speech.supported ? (
              <button type="button" aria-pressed={listening} onClick={toggleListening}>{listening ? "Stop listening" : "Speak"}</button>
            ) : (
              <span className="muted">Speech input is not available in this browser.</span>
            )}
            {speechError && <span className="note-error">Speech input: {speechError}</span>}
          </div>
        </>
      )}
      <div className="actions">
        {actions.map((id) => (
          <button key={id} type="button" disabled={disabled || (NEEDS_TEXT.has(id) && empty)} onClick={() => void fire(id)}>
            {ACTION_LABEL[id]}
          </button>
        ))}
      </div>
    </div>
  );
}
