import { RecordScreen } from "./record";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Ref } from "react";
import { Material } from "../shared/time";
import type { ConceptId, EvidenceId, ReviewId } from "../shared/ids";
import type { Concept } from "../shared/domain";
import type { AppApi } from "./api";
import { useAppearance, useSceneActivity } from "./appearance";
import { FrontRowScene, reserveNavSpace } from "./front-row";
import { reactToCompanion } from "./companion-reaction";
import { createReviewController, needsChecklist, resumeOnce } from "./controller";
import type { SessionState } from "./controller";
import {
  ACTION_LABEL, END_CONFIRM_TEXT, composerActions, INITIAL_SOURCE_OPEN, currentExchange, endFlow, shouldAutoSendSpeech, shouldStopListening, stepStartHandoff, turnStatus, availableActions, conversationLines, currentEvidenceIds, inspectBundle, liveText, MOVE_LABEL, NEEDS_TEXT, observationRow,
  softTargetPrompt, sourceTitles, sourceVideos, formatClock, formatInterval, lectureHeading, toAct, unansweredLearnerTurn, owedLearnerTurn, selectedEvidenceIds, shouldSubmitAnswer,
} from "./core";
import type { ActionId, EndEvent, EndStep, Heard, Line, Live, SourceSelection, StartHandoff, TurnStatus } from "./core";
import type { Speaker, SpeechInput } from "./speech";
import type { UnsentStore } from "./unsent";
import { BundleInspector, ErrorNote, EvidencePane, useAsync } from "./ui";
import { CompletionPanel } from "./completion";
import { DiagramPanel, ShowDiagramButton, useDiagrams } from "./diagram";
import { currentQuestionTopic } from "./diagram-view";

export type ReviewDeps = { readonly api: AppApi; readonly speaker: Speaker; readonly speech: SpeechInput; readonly unsent: UnsentStore };

/**
 * The review is a front-row seat in the learner's room: the current question is written on the board, the response
 * field lies on the desk, and the lecture source and earlier conversation open below the room on demand.
 */
export function ReviewScreen({ api, speaker, speech, unsent, reviewId }: ReviewDeps & { readonly reviewId: ReviewId }) {
  const { appearance, voice, activity } = useAppearance();
  const history = useRef<HTMLDivElement>(null);
  const board = useRef<HTMLElement>(null);
  const currentQuestion = useRef<HTMLElement>(null);
  const sourceHeading = useRef<HTMLHeadingElement>(null);
  const sourceToggle = useRef<HTMLButtonElement>(null);
  const sourceOrigin = useRef<HTMLButtonElement | null>(null);
  const historyHeading = useRef<HTMLHeadingElement>(null);
  const historyToggle = useRef<HTMLButtonElement>(null);
  const diagramSection = useRef<HTMLDivElement>(null);
  const followHistory = useRef(true);
  const [selection, setSelection] = useState<SourceSelection>({ kind: "automatic" });
  const [sourceOpen, setSourceOpen] = useState(INITIAL_SOURCE_OPEN);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [notebookOpen, setNotebookOpen] = useState(false);
  const [diagramTopic, setDiagramTopic] = useState<ConceptId | null>(null);
  const diagrams = useDiagrams(api, reviewId);
  const [listening, setListening] = useState(false);
  const [handoff, setHandoff] = useState<StartHandoff>("none");
  const startStatus = useRef<HTMLParagraphElement>(null);
  const questionLine = useRef<HTMLLIElement>(null);
  const controller = useMemo(() => createReviewController({ api, reviewId, speaker, unsent }), [api, reviewId, speaker, unsent]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  useEffect(() => {
    void controller.load();
  }, [controller]);
  // Flow D: the learner starts the review from the topic checklist; nothing begins by itself.
  const resume = useMemo(() => resumeOnce(controller), [controller]);
  useEffect(() => { resume(state); }, [resume, state]);
  const checklist = needsChecklist(state);
  const question = state.live === null && (state.view?.turns.some((t) => t.actor === "tutor" && t.say.trim() !== "") ?? false);
  useEffect(() => {
    const active = document.activeElement;
    const next = stepStartHandoff(handoff, { checklist, question, focusFree: active === null || active === document.body || active === startStatus.current });
    if (next.focus === "status") startStatus.current?.focus();
    else if (next.focus === "question") questionLine.current?.focus();
    if (next.step !== handoff) setHandoff(next.step);
  }, [handoff, checklist, question]);

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
  }, [historyOpen, state.view?.turns.length, state.live?.deltaText, state.live?.sentences.length]);
  useSceneActivity(state.saving ? "saving" : listening ? "listening" : state.view?.state.phase === "paused" ? "paused" : state.live?.status === "streaming" ? "waiting" : "idle");

  function openSource(ids: readonly EvidenceId[], label: string, origin: HTMLButtonElement) {
    sourceOrigin.current = origin;
    setSelection({ kind: "pinned", ids, label });
    if (!sourceOpen) reactToCompanion("draw");
    setSourceOpen(true);
    requestAnimationFrame(() => sourceHeading.current?.focus());
  }

  /** Flow D: Ask "show me the diagram" on a topic, any time in the review. The conversation stays where it is. */
  function showDiagram(topicId: ConceptId) {
    setDiagramTopic(topicId);
    if (!sourceOpen) reactToCompanion("draw");
    setSourceOpen(true);
    requestAnimationFrame(() => diagramSection.current?.focus());
    const known = diagrams.topics?.find((t) => t.topicId === topicId);
    if (known === undefined || known.summary.state === "not_requested") void diagrams.request(topicId);
    else diagrams.reload();
  }

  function closeSource() {
    setSelection({ kind: "automatic" });
    setSourceOpen(false);
    const origin = sourceOrigin.current;
    if (origin?.closest(".source-stand")) sourceToggle.current?.focus();
    else (origin?.isConnected ? origin : sourceToggle.current)?.focus();
  }

  function toggleHistory() {
    if (historyOpen) {
      setHistoryOpen(false);
      historyToggle.current?.focus();
      return;
    }
    followHistory.current = true;
    setHistoryOpen(true);
    requestAnimationFrame(() => historyHeading.current?.focus());
  }

  /** Where a panel stacks under the scene, this brings the question and the response field back without closing it. */
  function returnToQuestion() {
    const target = currentQuestion.current ?? board.current;
    target?.scrollIntoView({ block: "start" });
    target?.focus({ preventScroll: true });
  }

  const view = state.view;
  if (view === null) {
    return (
      <main className="review review-loading">
        <h1>Review</h1>
        <ErrorNote error={state.loadError} retry={() => void controller.load()} />
        {state.loadError === null && <p className="muted">Loading...</p>}
      </main>
    );
  }

  const lines = currentExchange(conversationLines(view.turns, view.topics));
  const live = state.live && state.live.status !== "complete" ? state.live : null;
  const questionKey = lines.current.findLast((l) => l.speaker === "tutor")?.key;
  const questionTopic = currentQuestionTopic(view, diagrams.topics ?? []);
  const shownDiagram = diagrams.topics?.find((t) => t.topicId === diagramTopic) ?? null;
  const soft = softTargetPrompt(view.turns);
  const actions = availableActions(view.state, soft !== null);
  const streaming = state.live?.status === "streaming";
  const evidenceIds = selectedEvidenceIds(selection, automaticIds);
  const videos = sourceVideos(capture.data?.capture ?? null);
  const unanswered = unansweredLearnerTurn(view.turns);
  const heading = lectureHeading([...titles.values()]);
  const scopeSeconds = Material.sources(view.scope.material).reduce((sum, id) => sum + Material.get(view.scope.material, id).intervals().reduce((s, i) => s + (i.end - i.start), 0), 0);
  const canRetry = !streaming && (state.unsent.length > 0 || unanswered !== null || owedLearnerTurn(view) !== null || state.live?.status === "failed");

  const questionMarker = view.state.mainQuestions > 0 ? `Question ${view.state.mainQuestions}` : null;
  const hasHistory = lines.earlier.length > 0 || view.topics.length > 0 || view.observations.length > 0;

  const boardContent = <>
    {(lines.current.length > 0 || live !== null) && (
      <section ref={currentQuestion} className="current-exchange" aria-labelledby="current-exchange-heading" tabIndex={-1}>
        <div className="front-row-heading">
          <h2 id="current-exchange-heading" className="front-row-eyebrow"><span className="visually-hidden">Current question: </span>{questionTopic?.label ?? questionMarker ?? "Current question"}</h2>
          {questionTopic !== null && <ShowDiagramButton topic={{ id: questionTopic.topicId, label: questionTopic.label }} onShow={showDiagram} />}
        </div>
        <ol className="lines">
          {lines.current.map((l) => <LineItem key={l.key} line={l} onSource={openSource} {...(l.key === questionKey ? { focusRef: questionLine } : {})} />)}
          {live !== null && (
            <li className="line tutor" data-question="">
              <strong>{live.move ? MOVE_LABEL[live.move.kind] : "Tutor"}</strong>
              <p>{liveText(live) || "..."}</p>
              {live.status === "failed" && <p className="note note-error">{live.error}</p>}
            </li>
          )}
        </ol>
      </section>
    )}
    {handoff !== "none" && <p ref={startStatus} className="note" role="status" tabIndex={-1}>{canRetry ? "Your review has started, but the tutor's first question has not arrived." : "Your review has started. Waiting for the tutor's first question."}</p>}
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
  </>;

  const deskContent = <Composer
    actions={actions.filter((a) => !["continue", "wrap_up", "pause", "resume", "end"].includes(a))}
    disabled={streaming || state.unsent.length > 0}
    sendError={state.sendError}
    speech={speech}
    showSpeak={voice}
    onSpeaking={controller.learnerSpeaking}
    onListeningChange={setListening}
    live={state.live}
    send={(id, text, modality) => controller.send(toAct(id, text, modality))}
  />;

  const setupForm = <TopicChecklist topics={view.topics} disabled={streaming} onStart={(fuzzy, note) => {
    setHandoff("submitted");
    void controller.send({ kind: "begin", fuzzy, ...(note === "" ? {} : { note }) }).then((sent) => { if (!sent) setHandoff("none"); });
  }} />;

  return (
    <main className="review front-row" data-panels={sourceOpen || historyOpen ? "open" : "closed"}>
      {notebookOpen && <dialog className="room-notebook-dialog" ref={node => { if (node && !node.open) node.showModal(); }} onClose={() => setNotebookOpen(false)}><button onClick={() => setNotebookOpen(false)}>Close notebook</button><RecordScreen api={api} reviewId={null} /></dialog>}
      <header ref={reserveNavSpace} className="review-header front-row-bar">
        <div className="front-row-title">
          <h1>{heading.title}</h1>
          <p className="review-scope-line">Reviewing {heading.detail ?? "this lecture"} · {formatClock(scopeSeconds)} of lecture</p>
        </div>
        <div className="review-navigation">
          <span className="review-phase">{questionMarker === null ? view.state.phase : `${questionMarker} · ${view.state.phase}`}</span>
          {!checklist && hasHistory && <button ref={historyToggle} type="button" aria-expanded={historyOpen} aria-controls="review-history" onClick={toggleHistory}>{historyOpen ? "Hide earlier" : "Earlier in this review"}</button>}
          {!checklist && <button ref={sourceToggle} type="button" aria-expanded={sourceOpen} aria-controls="review-source" onClick={(e) => {
            if (sourceOpen) closeSource();
            else {
              sourceOrigin.current = e.currentTarget;
              reactToCompanion("draw");
              setSourceOpen(true);
              requestAnimationFrame(() => sourceHeading.current?.focus());
            }
          }}>{sourceOpen ? "Close source" : "Open source"}</button>}
          <Actions ids={actions.filter(id => id === "pause" || id === "resume" || id === "end")} disabled={streaming || state.unsent.length > 0} send={id => void controller.send(toAct(id, "", "text"))} />
        </div>
      </header>
      <div className="front-row-notices">
        <SaveBanner state={state} onRetry={() => void controller.save()} reviewId={reviewId} onSource={openSource} />
        <ErrorNote error={state.loadError} retry={() => void controller.load()} />
      </div>
      <div className="front-row-layout">
        <FrontRowScene
          scene={appearance.scene}
          appearance={appearance}
          activity={activity}
          onNotebook={() => setNotebookOpen(true)}
          boardRef={board}
          layout={checklist ? { kind: "setup", form: setupForm } : { kind: "review", board: boardContent, desk: deskContent }}
        />
        <div className="front-row-panels">
          <section id="review-history" className="front-row-panel front-row-history" aria-labelledby="conversation-history-heading" hidden={!historyOpen}>
            <div className="front-row-panel-head">
              <h2 ref={historyHeading} tabIndex={-1} id="conversation-history-heading">Earlier in this review</h2>
              <button type="button" onClick={toggleHistory}>Hide earlier</button>
            </div>
            {lines.earlier.length > 0
              ? <div ref={history} onScroll={() => {
                const el = history.current;
                if (el) followHistory.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              }} className="conversation-history" role="region" aria-labelledby="conversation-history-heading" tabIndex={0}>
                <ol className="lines">
                  {lines.earlier.map((l) => <LineItem key={l.key} line={l} onSource={openSource} />)}
                </ol>
              </div>
              : <p className="muted">Nothing earlier yet. The current question is on the board.</p>}
            {view.topics.length > 0 && (
              <details className="review-topics">
                <summary>Topics in this review</summary>
                <ul>
                  {view.topics.map((t) => <li key={t.id}>{t.label} <ShowDiagramButton topic={t} onShow={showDiagram} /></li>)}
                </ul>
              </details>
            )}
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
            <button type="button" className="source-return" onClick={returnToQuestion}>Back to the question</button>
          </section>
          <aside id="review-source" className="source-stand front-row-panel" aria-labelledby="source-heading" hidden={!sourceOpen}>
            <div className="source-heading">
              <p className="eyebrow">From the lecture</p>
              <h2 ref={sourceHeading} tabIndex={-1} id="source-heading">Lecture evidence</h2>
              <p className="source-selection-label">{selection.kind === "pinned" ? selection.label : "From the current tutor explanation or check"}</p>
              <button type="button" onClick={closeSource}>Close source</button>
              {selection.kind === "pinned" && <button type="button" onClick={() => setSelection({ kind: "automatic" })}>Follow current reply</button>}
            </div>
            <EvidencePane key={evidenceIds.join(",")} api={api} ids={evidenceIds} titles={titles} videos={videos} grouped shownFrame={shownDiagram?.frame ?? null} />
            {diagramTopic !== null && <div ref={diagramSection} tabIndex={-1} className="tutor-diagram">{shownDiagram
              ? <DiagramPanel key={shownDiagram.topicId} api={api} topic={shownDiagram} error={diagrams.error} onRequest={() => void diagrams.request(diagramTopic)} onCite={openSource} onClose={() => setDiagramTopic(null)} />
              : <div className="diagram-panel">{diagrams.error !== null ? <ErrorNote error={diagrams.error} retry={diagrams.reload} /> : <p className="muted" role="status">Loading the diagram...</p>}<button type="button" onClick={() => setDiagramTopic(null)}>Close diagram</button></div>}</div>}
            <ScopeEvidence api={api} view={view} titles={titles} onSource={openSource} />
            <button type="button" className="source-return" onClick={returnToQuestion}>Back to the question</button>
          </aside>
        </div>
      </div>
    </main>
  );
}

const STARTING_POINT_HEADING = "starting-point-heading";

/**
 * Flow D: "[code]  Show the topics in the frozen scope as a checklist."
 * "[user]  Mark the topics I'm fuzzy on (or none), optionally add a note on what feels fuzzy."
 * Starting sends one `begin` act carrying the marked concept IDs and the note. Starting with none marked is the None path,
 * so the learner can always start without choosing.
 */
export function TopicChecklist({ topics, disabled, onStart }: { readonly topics: readonly Concept[]; readonly disabled: boolean; readonly onStart: (fuzzy: readonly ConceptId[], note: string) => void }) {
  const [marked, setMarked] = useState<ReadonlySet<ConceptId>>(new Set());
  const [note, setNote] = useState("");
  const noteId = useId();
  const toggle = (id: ConceptId) => setMarked((m) => { const next = new Set(m); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return (
    <form className="topic-checklist" aria-labelledby={STARTING_POINT_HEADING} onSubmit={(e) => { e.preventDefault(); onStart(topics.filter((t) => marked.has(t.id)).map((t) => t.id), note.trim()); }}>
      <div className="setup-choices">
        <h2 id={STARTING_POINT_HEADING}>Choose a starting point</h2>
        <p className="muted">Mark any topic that feels fuzzy and the tutor starts there, then does a quick check on up to 3 of the others. Mark none and the tutor starts with open recall questions.</p>
        <fieldset disabled={disabled}>
          <legend>Topics that feel fuzzy (optional)</legend>
          {topics.length === 0 && <p className="muted">No topics to list for this review.</p>}
          <ul className="topic-list">
            {topics.map((t) => (
              <li key={t.id}>
                <label>
                  <input type="checkbox" checked={marked.has(t.id)} onChange={() => toggle(t.id)} /> <strong>{t.label}</strong>
                  {t.summary !== "" && <span className="muted"> {t.summary}</span>}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      </div>
      <div className="setup-start">
        <label htmlFor={noteId}>Anything in particular that feels fuzzy? (optional)</label>
        <textarea id={noteId} value={note} maxLength={2000} disabled={disabled} onChange={(e) => setNote(e.target.value)} />
        <p className="actions">
          <button type="submit" className="primary-action" disabled={disabled}>{marked.size === 0 ? "Start review" : `Start with ${marked.size} marked topic${marked.size === 1 ? "" : "s"}`}</button>
        </p>
      </div>
    </form>
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

function LineItem({ line, onSource, focusRef }: { readonly line: Line; readonly onSource: (ids: readonly EvidenceId[], label: string, origin: HTMLButtonElement) => void; readonly focusRef?: Ref<HTMLLIElement> }) {
  return (
    <li className={`line ${line.speaker}`} {...(focusRef === undefined ? {} : { ref: focusRef, tabIndex: -1, "data-question": "" })}>
      <strong>{line.label}</strong>
      <p>{line.text}</p>
      {line.evidenceIds.length > 0 && <button type="button" className="citation" onClick={(e) => onSource(line.evidenceIds, `Source cited by this ${line.label.toLowerCase()}`, e.currentTarget)}>Lecture source · {line.evidenceIds.length} item{line.evidenceIds.length === 1 ? "" : "s"}</button>}
    </li>
  );
}

/** The completion summary shows only when the backend reports the review saved; a pending or failed save shows Retry instead. */
export function SaveBanner({ state, onRetry, reviewId, onSource }: { readonly state: SessionState; readonly onRetry: () => void; readonly reviewId: ReviewId; readonly onSource?: (ids: readonly EvidenceId[], label: string, origin: HTMLButtonElement) => void }) {
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
      ) : state.view?.saved === "saved" ? (
        <CompletionPanel view={state.view} reviewId={reviewId} savedSummary={state.savedSummary} justSaved={state.savedSummary !== null} onSource={onSource} />
      ) : (
        state.saving && <p className="note" role="status">Saving this review to your notebook...</p>
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
    <span className="actions end-confirm" role="alertdialog" aria-label="Finish and save this review?">
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
  actions, disabled, sendError, speech, showSpeak = true, onSpeaking, onListeningChange, live, send,
}: {
  readonly actions: readonly ActionId[];
  readonly disabled: boolean;
  readonly sendError: string | null;
  readonly speech: SpeechInput;
  /** Whether to offer the Speak button. The review turns it off unless the voice setting is on. */
  readonly showSpeak?: boolean;
  readonly onSpeaking: () => void;
  readonly onListeningChange?: (listening: boolean) => void;
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
  latest.current = { allowed: hasText && !disabled && showSpeak, send };
  useEffect(() => { onListeningChange?.(listening); }, [listening, onListeningChange]);
  useEffect(() => () => { speech.stop(); }, [speech]);
  useEffect(() => {
    if (shouldStopListening(listening, hasText, showSpeak)) { speech.stop(); heard.current = null; setListening(false); }
  }, [hasText, showSpeak, listening, speech]);

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
  const placed = composerActions(actions);
  const button = (id: ActionId) => <button key={id} type="button" disabled={disabled || (NEEDS_TEXT.has(id) && empty)} onClick={() => void fire(id)}>{ACTION_LABEL[id]}</button>;
  return (
    <div className="composer">
      <div className="composer-status">
        {sendError !== null && <p className="note note-error" role="alert">{sendError}</p>}
        {speechError && <p className="note note-error" role="alert">Speech input: {speechError}</p>}
        <TurnStatusNote status={status} />
      </div>
      {hasText && (
        <>
          <label htmlFor={responseId}>Your thinking</label>
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
            {!showSpeak ? null : speech.supported ? (
              <button type="button" aria-pressed={listening} onKeyDown={event => { if (event.repeat) event.preventDefault(); }} onClick={toggleListening}>{listening ? "Stop listening" : "Speak"}</button>
            ) : (
              <span className="muted">Speech input is not available in this browser.</span>
            )}
          </div>
        </>
      )}
      {hasText && <p className="composer-shortcut">Ctrl / ⌘ + Enter to share your thinking</p>}
      <div className="actions primary-actions">
        {placed.primary.map((id) => (
          <button key={id} type="button" className={id === "answer" ? "primary-action" : undefined} disabled={disabled || (NEEDS_TEXT.has(id) && empty)} onClick={() => void fire(id)}>
            {id === "answer" ? "Share my thinking" : ACTION_LABEL[id]}
          </button>
        ))}
      </div>
      {placed.assist.length > 0 && <div className="assist-actions" role="group" aria-label="Help with this question">{placed.assist.map(button)}</div>}
      {placed.more.length > 0 && <details className="review-help">
        <summary>More ways to work through it</summary>
        <div className="actions">{placed.more.map(button)}</div>
      </details>}
    </div>
  );
}
