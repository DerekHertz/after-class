import { RecordScreen } from "./record";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { MutableRefObject } from "react";
import { Material } from "../shared/time";
import type { EvidenceId, ReviewId } from "../shared/ids";
import type { AppApi } from "./api";
import { useAppearance, useSceneActivity } from "./appearance";
import { RoomTools } from "./room-tools";
import { reactToCompanion } from "./companion-reaction";
import { beginOnce, createReviewController } from "./controller";
import type { SessionState } from "./controller";
import {
  ACTION_LABEL, END_CONFIRM_TEXT, INITIAL_SOURCE_OPEN, endFlow, shouldAutoSendSpeech, turnStatus, availableActions, conversationLines, currentEvidenceIds, inspectBundle, liveText, MOVE_LABEL, NEEDS_TEXT, observationRow,
  softTargetPrompt, sourceTitles, sourceVideos, formatClock, formatInterval, lectureHeading, toAct, unansweredLearnerTurn, selectedEvidenceIds, shouldSubmitAnswer,
} from "./core";
import type { ActionId, EndEvent, EndStep, Heard, Line, Live, SourceSelection, TurnStatus } from "./core";
import type { Speaker, SpeechInput } from "./speech";
import type { UnsentStore } from "./unsent";
import { BundleInspector, ErrorNote, EvidencePane, Link, useAsync } from "./ui";

export type ReviewDeps = { readonly api: AppApi; readonly speaker: Speaker; readonly speech: SpeechInput; readonly unsent: UnsentStore };

export function ReviewScreen({ api, speaker, speech, unsent, reviewId }: ReviewDeps & { readonly reviewId: ReviewId }) {
  const { appearance } = useAppearance();
  const speechToggle = useRef<(() => void) | null>(null);
  const history = useRef<HTMLDivElement>(null);
  const sourceHeading = useRef<HTMLHeadingElement>(null);
  const sourceSurface = useRef<HTMLElement>(null);
  const sourceColumn = useRef<HTMLDivElement>(null);
  const sourceToggle = useRef<HTMLButtonElement>(null);
  const sourceOrigin = useRef<HTMLButtonElement | null>(null);
  const followHistory = useRef(true);
  const [selection, setSelection] = useState<SourceSelection>({ kind: "automatic" });
  const [sourceOpen, setSourceOpen] = useState(INITIAL_SOURCE_OPEN);
  const [notebookOpen, setNotebookOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const controller = useMemo(() => createReviewController({ api, reviewId, speaker, unsent }), [api, reviewId, speaker, unsent]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const loaded = state.view !== null;
  useEffect(() => {
    const surface = sourceSurface.current;
    const column = sourceColumn.current;
    if (!loaded || appearance.scene !== "study-bench" || !surface || !column) return;
    let frame: number | null = null;
    const paint = () => {
      column.style.setProperty("--paper-feed", `${surface.scrollTop}px`);
      column.dataset.paperScrolled = String(surface.scrollTop > 0);
      frame = null;
    };
    const scroll = () => { if (frame === null) frame = requestAnimationFrame(paint); };
    paint();
    surface.addEventListener("scroll", scroll, { passive: true });
    return () => { surface.removeEventListener("scroll", scroll); if (frame !== null) cancelAnimationFrame(frame); };
  }, [loaded, appearance.scene, sourceOpen]);
  useEffect(() => {
    void controller.load();
  }, [controller]);
  // Flow D: the tutor opens with a recall question, so an empty active review sends `begin` once.
  const begin = useMemo(() => beginOnce(controller), [controller]);
  useEffect(() => { begin(state); }, [begin, state]);

  const captureId = state.view?.captureId ?? null;
  const capture = useAsync(() => (captureId === null ? Promise.resolve(null) : api.captureView(captureId)), [api, captureId]);
  const titles = sourceTitles(capture.data?.capture ?? null);

  const automaticIds = currentEvidenceIds(state.view?.turns ?? [], state.live);
  const automaticKey = automaticIds.join(",");
  useEffect(() => {
    if (automaticKey !== "") setSourceOpen(true);
  }, [automaticKey]);
  useEffect(() => {
    if (followHistory.current && history.current) history.current.scrollTop = history.current.scrollHeight;
  }, [state.view?.turns.length, state.live?.deltaText, state.live?.sentences.length]);
  useSceneActivity(state.saving ? "saving" : listening ? "listening" : state.view?.state.phase === "paused" ? "paused" : state.live?.status === "streaming" ? "waiting" : "idle");

  function openSource(ids: readonly EvidenceId[], label: string, origin: HTMLButtonElement) {
    sourceOrigin.current = origin;
    setSelection({ kind: "pinned", ids, label });
    if (!sourceOpen) reactToCompanion("draw");
    setSourceOpen(true);
    requestAnimationFrame(() => sourceHeading.current?.focus());
  }

  function closeSource() {
    setSelection({ kind: "automatic" });
    setSourceOpen(false);
    const origin = sourceOrigin.current;
    if (origin?.closest(".source-stand")) sourceToggle.current?.focus();
    else (origin?.isConnected ? origin : sourceToggle.current)?.focus();
  }

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
  const evidenceIds = selectedEvidenceIds(selection, automaticIds);
  const videos = sourceVideos(capture.data?.capture ?? null);
  const unanswered = unansweredLearnerTurn(view.turns);
  const heading = lectureHeading([...titles.values()]);
  const scopeSeconds = Material.sources(view.scope.material).reduce((sum, id) => sum + Material.get(view.scope.material, id).intervals().reduce((s, i) => s + (i.end - i.start), 0), 0);
  const canRetry = !streaming && (state.unsent.length > 0 || unanswered !== null || state.live?.status === "failed");

  return (
    <main className="review">
      {notebookOpen && <dialog className="room-notebook-dialog" ref={node => { if (node && !node.open) node.showModal(); }} onClose={() => setNotebookOpen(false)}><button onClick={() => setNotebookOpen(false)}>Close notebook</button><RecordScreen indexed api={api} reviewId={null} /></dialog>}
      <header className="review-header">
        <div>
          <h1>{heading.title}</h1>
          <p className="review-scope-line">Reviewing {heading.detail ?? "this lecture"} · {formatClock(scopeSeconds)} of lecture</p>
        </div>
        <div className="review-navigation">
          <span className="review-phase">{view.state.phase}</span>
          <button type="button" onClick={() => setNotebookOpen(true)}>My notebook</button>
          <Actions ids={actions.filter(id => id === "pause" || id === "resume" || id === "end")} disabled={streaming || state.unsent.length > 0} send={id => void controller.send(toAct(id, "", "text"))} />
        </div>
      </header>
      <SaveBanner state={state} onRetry={() => void controller.save()} reviewId={reviewId} />
      <ErrorNote error={state.loadError} retry={() => void controller.load()} />
      <div className={`review-workspace${sourceOpen ? "" : " source-closed"}`}>
        <section className="conversation-notebook" aria-labelledby="conversation-heading">
          <div className="notebook-heading">
            <h2 id="conversation-heading">Conversation</h2>
            <span className="question-marker">Question {view.state.mainQuestions}</span>
            <button type="button" onClick={() => {
              followHistory.current = true;
              if (history.current) history.current.scrollTop = history.current.scrollHeight;
            }}>Latest exchange</button>
            <button ref={sourceToggle} type="button" aria-expanded={sourceOpen} aria-controls="review-source" onClick={(e) => {
              if (sourceOpen) closeSource();
              else { sourceOrigin.current = e.currentTarget; reactToCompanion("draw"); setSourceOpen(true); }
            }}>{sourceOpen ? "Close source" : "Open source"}</button>
          </div>
          <div ref={history} onScroll={() => {
            const el = history.current;
            if (el) followHistory.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }} className="conversation-history" role="region" aria-label="Conversation history" tabIndex={0}>
          <ol className="lines">
            {lines.map((l) => <LineItem key={l.key} line={l} onSource={openSource} />)}
            {state.live && state.live.status !== "complete" && (
              <li className="line tutor">
                <strong>{state.live.move ? MOVE_LABEL[state.live.move.kind] : "Tutor"}</strong>
                <p>{liveText(state.live) || "..."}</p>
                {state.live.status === "failed" && <p className="note note-error">{state.live.error}</p>}
              </li>
            )}
          </ol>
          </div>
          {canRetry && (
            <UndeliveredNote
              unsent={state.unsent.length}
              failed={state.live?.status === "failed"}
              onRetry={() => void controller.retryTurn()}
              onDiscard={() => void controller.discardUnsent()}
            />
          )}
          {soft && (
            <div className="note">
              <p>You have been at this a while. Keep going, or wrap up and save?</p>
              <Actions ids={actions.filter((a) => a === "continue" || a === "wrap_up")} disabled={streaming} send={(id) => void controller.send(toAct(id, "", "text"))} />
            </div>
          )}
          <Composer
            actions={actions.filter((a) => !["continue", "wrap_up", "pause", "resume", "end"].includes(a))}
            disabled={streaming || state.unsent.length > 0}
            sendError={state.sendError}
            speech={speech}
            onSpeaking={controller.learnerSpeaking}
            onListeningChange={setListening}
            speechToggle={speechToggle}
            live={state.live}
            send={(id, text, modality) => controller.send(toAct(id, text, modality))}
          />
          {view.observations.length > 0 && (
            <details className="review-observations">
              <summary>What the tutor observed</summary>
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
            </details>
          )}
        </section>
        <div ref={sourceColumn} className="review-source-column" data-source-open={sourceOpen}>
        <RoomTools onNotebook={() => setNotebookOpen(true)} scene={appearance.scene} sourceOpen={sourceOpen} listening={listening} speechAvailable={speech.supported && actions.includes("answer")} onSpeak={() => { speechToggle.current?.(); }} onSource={(origin) => {
          sourceOrigin.current = origin ?? sourceToggle.current;
          if (sourceOpen) closeSource();
          else setSourceOpen(true);
        }} />
        <aside ref={sourceSurface} id="review-source" className="source-stand" aria-labelledby="source-heading" hidden={!sourceOpen}>
          <div className="source-heading">
            <p className="eyebrow">From the lecture</p>
            <h2 ref={sourceHeading} tabIndex={-1} id="source-heading">Lecture evidence</h2>
            <p className="source-selection-label">{selection.kind === "pinned" ? selection.label : "From the current tutor explanation or check"}</p>
            <button type="button" onClick={closeSource}>Close evidence</button>
            {selection.kind === "pinned" && <button type="button" onClick={() => setSelection({ kind: "automatic" })}>Follow current reply</button>}
          </div>
          <EvidencePane key={evidenceIds.join(",")} api={api} ids={evidenceIds} titles={titles} videos={videos} />
          <ScopeEvidence api={api} view={view} titles={titles} onSource={openSource} />
        </aside>
        </div>
      </div>
    </main>
  );
}

/** Discard is the way out of a message the backend refuses for good; End is offered again once it is gone. */
export function UndeliveredNote({ unsent, failed, onRetry, onDiscard }: { readonly unsent: number; readonly failed: boolean; readonly onRetry: () => void; readonly onDiscard: () => void }) {
  return (
    <p className="note">
      {unsent > 0 ? "Your last message was not delivered." : failed ? "The tutor's reply did not finish." : "The tutor has not replied to your last message."}{" "}
      <button type="button" onClick={onRetry}>Retry</button>
      {unsent > 0 && (
        <>
          {" "}
          <button type="button" onClick={onDiscard}>Discard message</button> <span className="muted">Drops it. It is not counted as an answer.</span>
        </>
      )}
    </p>
  );
}

function LineItem({ line, onSource }: { readonly line: Line; readonly onSource: (ids: readonly EvidenceId[], label: string, origin: HTMLButtonElement) => void }) {
  return (
    <li className={`line ${line.speaker}`}>
      <strong>{line.label}</strong>
      <p>{line.text}</p>
      {line.evidenceIds.length > 0 && <button type="button" className="citation" onClick={(e) => onSource(line.evidenceIds, `Source cited by this ${line.label.toLowerCase()}`, e.currentTarget)}>Lecture source · {line.evidenceIds.length} item{line.evidenceIds.length === 1 ? "" : "s"}</button>}
    </li>
  );
}

export function SaveBanner({ state, onRetry, reviewId }: { readonly state: SessionState; readonly onRetry: () => void; readonly reviewId: ReviewId }) {
  const pending = state.saveError !== null || state.view?.saved === "save_pending";
  return (
    <>
      {state.storageDegraded && (
        <p className="note note-error" role="alert">
          This browser is not keeping your unsent messages (local storage is unavailable). If you reload or close this page, a message that has not been delivered is lost.
        </p>
      )}
      {pending ? (
        <p className="note note-error" role="alert">
          This review is not saved yet{state.saveError ? `: ${state.saveError}` : ""}. Retrying never makes a duplicate.{" "}
          <button type="button" disabled={state.saving} onClick={onRetry}>{state.saving ? "Saving..." : "Retry save"}</button>
        </p>
      ) : (
        state.view?.saved === "saved" && (
          <p className="note">
            Saved. <Link to={{ page: "record", reviewId }}>Open the record</Link>
          </p>
        )
      )}
    </>
  );
}

function ScopeEvidence({ api, view, titles, onSource }: { readonly api: AppApi; readonly view: NonNullable<SessionState["view"]>; readonly titles: ReturnType<typeof sourceTitles>; readonly onSource: (ids: readonly EvidenceId[], label: string, origin: HTMLButtonElement) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Everything in this review's scope</summary>
      {open && <ScopeBundle api={api} view={view} titles={titles} onSource={onSource} />}
    </details>
  );
}

function ScopeBundle({ api, view, titles, onSource }: { readonly api: AppApi; readonly view: NonNullable<SessionState["view"]>; readonly titles: ReturnType<typeof sourceTitles>; readonly onSource: (ids: readonly EvidenceId[], label: string, origin: HTMLButtonElement) => void }) {
  const bundle = useAsync(() => api.evidence({ material: view.scope.material }), [api, view.reviewId]);
  if (bundle.error !== null) return <ErrorNote error={bundle.error} retry={bundle.reload} />;
  if (bundle.data === null) return <p className="muted">Loading...</p>;
  return <>
    <p>Browse captured material in the frozen scope. These items are not citations supporting the current question.</p>
    <div className="scope-source-list">
      {bundle.data.passages.map((p) => <button key={p.id} type="button" onClick={(e) => onSource([p.id], "Selected from this review’s scope", e.currentTarget)}>{titles.get(p.sourceId) ?? "Lecture"} · captions · {formatInterval(p.interval)}</button>)}
    </div>
    <BundleInspector report={inspectBundle(bundle.data, titles)} />
  </>;
}

export function EndConfirm({ disabled, onConfirm, onCancel }: { readonly disabled: boolean; readonly onConfirm: () => void; readonly onCancel: () => void }) {
  return (
    <span className="actions end-confirm" role="alertdialog" aria-label="End this review?">
      <span>{END_CONFIRM_TEXT}</span>
      <button type="button" data-action="end-confirm" disabled={disabled} onClick={onConfirm}>{ACTION_LABEL.end}</button>
      <button type="button" data-action="end-cancel" onClick={onCancel}>Keep reviewing</button>
    </span>
  );
}

function Actions({ ids, disabled, send }: { readonly ids: readonly ActionId[]; readonly disabled: boolean; readonly send: (id: ActionId) => void }) {
  const [endStep, setEndStep] = useState<EndStep>("idle");
  const step = (event: EndEvent) => {
    const next = endFlow(endStep, event);
    setEndStep(next.send ? "idle" : next.step);
    if (next.send) send("end");
  };
  return (
    <span className="actions">
      {ids.map((id) => id === "end" && endStep === "confirming"
        ? <EndConfirm key={id} disabled={disabled} onConfirm={() => step("confirm")} onCancel={() => step("cancel")} />
        : <button key={id} type="button" data-action={id} disabled={disabled} onClick={() => (id === "end" ? step("press_end") : send(id))}>{ACTION_LABEL[id]}</button>)}
    </span>
  );
}

/** Shows what is happening to the learner's turn; nothing when idle. */
export function TurnStatusNote({ status }: { readonly status: TurnStatus }) {
  if (status.kind === "idle") return null;
  return (
    <p className="turn-status" role="status" data-status={status.kind}>
      {status.text}
      {status.kind === "listening" && status.transcript !== "" && <q className="turn-status-heard"> {status.transcript}</q>}
    </p>
  );
}

export function Composer({
  actions, disabled, sendError, speech, onSpeaking, onListeningChange, speechToggle, live, send,
}: {
  readonly actions: readonly ActionId[];
  readonly disabled: boolean;
  readonly sendError: string | null;
  readonly speech: SpeechInput;
  readonly onSpeaking: () => void;
  readonly onListeningChange?: (listening: boolean) => void;
  readonly speechToggle?: MutableRefObject<(() => void) | null>;
  /** The tutor turn in flight, for the status line. */
  readonly live?: Live | null;
  readonly send: (id: ActionId, text: string, modality: "speech" | "text") => Promise<boolean>;
}) {
  const responseId = useId();
  const [draft, setDraft] = useState("");
  const [listening, setListening] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const modality = useRef<"speech" | "text">("text");
  const hasText = actions.includes("answer");
  const submitting = useRef(false);
  const [sending, setSending] = useState(false);
  const [transcript, setTranscript] = useState("");
  const heard = useRef<Heard | null>(null);
  /** The latest props, for speech callbacks that outlive the render that started them. */
  const latest = useRef({ allowed: false, send });
  latest.current = { allowed: hasText && !disabled, send };
  useEffect(() => { onListeningChange?.(listening); }, [listening, onListeningChange]);
  useEffect(() => () => { speech.stop(); }, [speech]);
  useEffect(() => {
    if (!hasText && listening) { speech.stop(); setListening(false); }
  }, [hasText, listening, speech]);

  function toggleListening() {
    if (listening) {
      speech.stop();
      return;
    }
    setSpeechError(null);
    setTranscript("");
    heard.current = null;
    setListening(true);
    speech.start({
      onSpeechStart: onSpeaking,
      onTranscript: (text, final) => {
        modality.current = "speech";
        heard.current = { text, final };
        setTranscript(text);
        setDraft(text);
      },
      onEnd: () => {
        setListening(false);
        const spoken = heard.current;
        heard.current = null;
        // A voice answer sends itself, through the same path as Send answer.
        if (spoken !== null && shouldAutoSendSpeech(spoken, latest.current.allowed)) void submit("answer", spoken.text, "speech");
      },
      onError: (m) => {
        heard.current = null;
        setSpeechError(m);
        setListening(false);
      },
    });
  }

  useEffect(() => {
    if (speechToggle) speechToggle.current = toggleListening;
    return () => { if (speechToggle) speechToggle.current = null; };
  }, [speechToggle, listening, speech, onSpeaking]);

  async function submit(id: ActionId, text: string, how: "speech" | "text") {
    if (submitting.current) return;
    submitting.current = true;
    setSending(true);
    try {
      const accepted = await latest.current.send(id, text.trim(), how);
      if (accepted && NEEDS_TEXT.has(id)) {
        setDraft("");
        setTranscript("");
        modality.current = "text";
      }
    } finally {
      submitting.current = false;
      setSending(false);
    }
  }

  async function fire(id: ActionId) {
    if (disabled || submitting.current || !actions.includes(id) || (NEEDS_TEXT.has(id) && draft.trim() === "")) return;
    await submit(id, draft, modality.current);
  }

  const status = turnStatus({ listening, transcript, submitting: sending, live: live ?? null });

  const empty = draft.trim() === "";
  return (
    <div className="composer">
      {sendError !== null && <p className="note note-error" role="alert">{sendError}</p>}
      {speechError && <p className="note note-error" role="alert">Speech input: {speechError}</p>}
      <TurnStatusNote status={status} />
      {hasText && (
        <>
          <label htmlFor={responseId}>Your response</label>
          <textarea
            id={responseId}
            value={draft}
            rows={3}
            onKeyDown={(e) => {
              if (shouldSubmitAnswer({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing, repeat: e.repeat }, hasText, disabled, draft)) {
                e.preventDefault();
                void fire("answer");
              }
            }}
            placeholder="Think it through, in your own words..."
            onChange={(e) => {
              modality.current = "text";
              setDraft(e.target.value);
            }}
          />
          <div className="actions">
            {speech.supported ? (
              <button type="button" aria-pressed={listening} onKeyDown={event => { if (event.repeat) event.preventDefault(); }} onClick={toggleListening}>{listening ? "Stop listening" : "Speak"}</button>
            ) : (
              <span className="muted">Speech input is not available in this browser.</span>
            )}
          </div>
        </>
      )}
      {hasText && <p className="composer-shortcut">Ctrl / ⌘ + Enter to share your thinking</p>}
      <div className="actions primary-actions">
        {actions.filter((id) => !["skip", "dont_know", "hint", "explain", "dispute"].includes(id)).map((id) => (
          <button key={id} type="button" className={id === "answer" ? "primary-action" : undefined} disabled={disabled || (NEEDS_TEXT.has(id) && empty)} onClick={() => void fire(id)}>
            {id === "answer" ? "Share my thinking" : ACTION_LABEL[id]}
          </button>
        ))}
      </div>
      {actions.some((id) => ["skip", "dont_know", "hint", "explain", "dispute"].includes(id)) && <details className="review-help">
        <summary>More ways to work through it</summary>
        <div className="actions">{actions.filter((id) => ["skip", "dont_know", "hint", "explain", "dispute"].includes(id)).map((id) => <button key={id} type="button" disabled={disabled || (NEEDS_TEXT.has(id) && empty)} onClick={() => void fire(id)}>{ACTION_LABEL[id]}</button>)}</div>
      </details>}
    </div>
  );
}
