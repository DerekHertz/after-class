import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ConceptId, EvidenceId, NoteId, ReviewId } from "../shared/ids";
import type { DiagramFrame, EvidenceBundle, LinkDecision, LinkType, Note, Observation, ObservationStatus, RecordView, TopicDiagram, UsageSummary } from "../shared/domain";
import type { LecturesResponse } from "../shared/wire";
import type { AppApi } from "./api";
import { allowanceView, formatClock, formatInterval, noteView, observationRow, STATUS_LABEL, usageRows } from "./core";
import type { SourceTitles } from "./core";
import { canChangeObservation, changeObservation, DISPUTE_CHOICES, loadReviewContext, observationContext } from "./observation-view";
import type { DisputeChoice, ObservationContext, ReviewContext } from "./observation-view";
import { focusLectures, notebookLectures, NOTEBOOK_VIEWS, TOPIC_SECTIONS, topicName, viewCounts, withDraft } from "./notebook-view";
import type { NoteDrafts, NotebookLecture, NotebookTopic, NotebookViewName } from "./notebook-view";
import { objectFrame } from "./room-object";
import { ErrorNote, EvidencePane, FrameImage, Link, useAsync } from "./ui";
import { DiagramSummaryView, POLL_MS } from "./diagram";
import { frameLink, NO_FRAME_NOTE, shouldPollDiagrams } from "./diagram-view";


const LINK_TYPES: readonly LinkType[] = ["prerequisite_of", "part_of", "example_of", "contrasts_with", "related_to"];
const OVERRIDES: readonly ObservationStatus[] = ["independent", "partial", "after_help", "unresolved", "not_assessed"];
const noTitles: SourceTitles = new Map();
type CitationDetails = Pick<EvidenceBundle, "frames" | "passages">;
type Citations = ReturnType<typeof useAsync<CitationDetails | null>>;
type Run = (a: () => Promise<void>) => Promise<void>;
type Lectures = LecturesResponse["lectures"];
type SetDraft = (id: NoteId, text: string | null) => void;

const decisionText = (d: LinkDecision): string => (typeof d === "string" ? d : `corrected to ${d.corrected.replaceAll("_", " ")}`);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The full-page notebook and the room's notebook dialog. Both show the same lectures, topics, labels and order. */
export function RecordScreen({ api, reviewId }: { readonly api: AppApi; readonly reviewId: ReviewId | null }) {
  const record = useAsync(useCallback(() => api.record(reviewId === null ? {} : { reviewId }), [api, reviewId]));
  const lectures = useAsync(useCallback(() => api.lectures(), [api]));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const [drafts, setDrafts] = useState<NoteDrafts>(new Map());
  const setDraft = useCallback<SetDraft>((id, text) => setDrafts((d) => withDraft(d, id, text)), []);

  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      await action();
      record.reload();
    } catch (e) {
      setError(message(e));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  // Lectures are grouped once the lecture list has answered, so a topic's drafts are not remounted when titles arrive.
  const grouped = lectures.data !== null || lectures.error !== null;
  return (
    <main className="notebook-page record-page room-paper" {...objectFrame("history")}>
      <header className="page-heading">
        <div><p className="page-kicker">Kept in your own words</p><h1 tabIndex={-1}>My notebook</h1></div>
        <nav aria-label="Notebook navigation"><Link to={{ page: "home" }}>Your lectures</Link> <Link to={{ page: "usage" }}>Usage</Link></nav>
      </header>
      <p className="muted">{reviewId === null ? "Every lecture you saved a review of, topic by topic." : "The topics from this review."} Your words, the tutor's help and the lecture's source stay labelled.</p>
      {reviewId !== null && <p><Link to={{ page: "review", id: reviewId }}>Return to review</Link> · <Link to={{ page: "record", reviewId: null }}>All lectures</Link></p>}
      <ErrorNote error={record.error} retry={record.reload} />
      {lectures.error !== null && <ErrorNote error={`Lecture titles could not be loaded: ${lectures.error}`} retry={lectures.reload} />}
      <ErrorNote error={error} />
      {(record.data === null || !grouped) && record.error === null && <p className="page-loading" role="status">Opening your notebook...</p>}
      {saving && <p className="page-loading" role="status">Saving your change...</p>}
      {record.data && grouped && (
        <fieldset className="record-content" disabled={saving} aria-label="Saved learning record">
          <RecordBody api={api} data={record.data} lectures={lectures.data?.lectures ?? null} run={run} drafts={drafts} setDraft={setDraft} />
        </fieldset>
      )}
    </main>
  );
}

/**
 * The notebook's contents: a focused-view switch, a contents list, then each lecture with its topics. `lectures` is the
 * lecture list, or null when it could not be read; each review then stands as its own lecture without a title. `drafts`
 * are the learner's unsaved edits, held by the caller so a view or a regrouping that remounts a topic keeps them.
 */
export function RecordBody({ api, data, lectures, run, drafts, setDraft }: {
  readonly api: AppApi;
  readonly data: RecordView;
  readonly lectures: Lectures | null;
  readonly run: Run;
  readonly drafts: NoteDrafts;
  readonly setDraft: SetDraft;
}) {
  const deleted = useMemo(() => new Set<string>(data.unavailableEvidence.map((d) => d.id)), [data.unavailableEvidence]);
  const cited = useMemo(() => {
    return [...new Set(data.notes.flatMap((note) => [...note.evidence, ...note.generated.flatMap((segment) => segment.evidence)]))].filter((id) => !deleted.has(id)).sort();
  }, [data, deleted]);
  const citations = useAsync(useCallback(async (): Promise<CitationDetails | null> => {
    if (cited.length === 0) return null;
    const batches = [];
    for (let offset = 0; offset < cited.length; offset += 250) batches.push(cited.slice(offset, offset + 250));
    const bundles = await Promise.all(batches.map((ids) => api.evidence({ ids })));
    return { frames: bundles.flatMap((bundle) => bundle.frames), passages: bundles.flatMap((bundle) => bundle.passages) };
  }, [api, cited]));
  const reviewIds = [...new Set([...data.notes.map((n) => n.reviewId), ...data.observations.map((o) => o.reviewId)])];
  const reviews = useReviewContexts(api, reviewIds);
  const diagrams = useReviewDiagrams(api, reviewIds);
  const [chosen, setChosen] = useState<NotebookViewName>("all");
  const prefix = useId();
  const all = notebookLectures(data, lectures, reviews.contexts);
  const counts = viewCounts(all);
  const view = counts[chosen] === 0 ? "all" : chosen;
  const shown = focusLectures(all, view);
  const topicKey = (lecture: NotebookLecture, topic: NotebookTopic) => `${lecture.key}-${topic.conceptId ?? "none"}`;
  const headingId = (lecture: NotebookLecture, topic: NotebookTopic) => `${prefix}-${topicKey(lecture, topic)}`;
  // A topic keeps the name its place in the whole lecture gives it, whichever view is showing.
  const names = new Map(all.flatMap((lecture) => {
    const loading = lecture.reviews.some((r) => (reviews.contexts.get(r.reviewId)?.state ?? "loading") === "loading");
    return lecture.topics.map((topic, index) => [topicKey(lecture, topic), topicName(topic, index, loading)] as const);
  }));
  const nameOf = (lecture: NotebookLecture, topic: NotebookTopic) => names.get(topicKey(lecture, topic)) ?? "Topic";

  if (all.length === 0 && data.links.length === 0) return <EmptyNotebook />;
  return (
    <>
      {(counts.revisit > 0 || counts.disputed > 0) && (
        <div className="notebook-views" role="group" aria-label="Show topics">
          {NOTEBOOK_VIEWS.filter((v) => counts[v.value] > 0).map((v) => (
            <button key={v.value} type="button" aria-pressed={view === v.value} onClick={() => setChosen(v.value)}>{v.label} ({counts[v.value]})</button>
          ))}
        </div>
      )}
      {shown.length > 0 && (
        <nav className="notebook-contents" aria-label="Notebook contents">
          <ol>
            {shown.map((lecture) => (
              <li key={lecture.key}>
                <span>{lecture.title ?? "Lecture title unavailable"}</span>
                <ol>
                  {lecture.topics.map((topic) => (
                    <li key={topic.conceptId ?? "none"}>
                      <button type="button" className="notebook-contents-topic" onClick={() => focusHeading(headingId(lecture, topic))}>{nameOf(lecture, topic)}</button>
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        </nav>
      )}
      {shown.map((lecture) => (
          <LectureSection key={lecture.key} lecture={lecture}>
            {lecture.topics.map((topic) => (
              <TopicSection
                key={topic.conceptId ?? "none"}
                api={api}
                topic={topic}
                name={nameOf(lecture, topic)}
                headingId={headingId(lecture, topic)}
                contexts={reviews.contexts}
                retry={reviews.retry}
                diagram={topicDiagram(lecture, topic, diagrams)}
                deleted={deleted}
                citations={citations}
                drafts={drafts}
                setDraft={setDraft}
                run={run}
              />
            ))}
          </LectureSection>
      ))}
      {data.links.length > 0 && (
        <section className="record-section" aria-labelledby={`${prefix}-links`}>
          <h2 id={`${prefix}-links`}>Suggested links between concepts</h2>
          <p className="muted">Accept, reject, or correct each connection. A suggestion is not a decision.</p>
          <ul className="record-list">
            {data.links.map((l, index) => (
              <li key={l.id}>
                <p>{l.rationale}</p><p className="muted">Connection: {l.type.replaceAll("_", " ")} · {decisionText(l.decision)}</p>
                <div className="actions">
                  <button type="button" onClick={() => void run(() => api.decideLink(l.id, "accepted"))}>Accept</button>
                  <button type="button" onClick={() => void run(() => api.decideLink(l.id, "rejected"))}>Reject</button>
                  <select aria-label={`Correct connection ${index + 1}: ${l.rationale}`} value="" onChange={(e) => e.target.value && void run(() => api.decideLink(l.id, { corrected: e.target.value as LinkType }))}>
                    <option value="">Correct to...</option>
                    {LINK_TYPES.map((t) => <option key={t} value={t}>{t.replaceAll("_", " ")}</option>)}
                  </select>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function focusHeading(id: string) {
  const heading = document.getElementById(id);
  heading?.scrollIntoView({ block: "start" });
  heading?.focus({ preventScroll: true });
}

/** A first visit: one explanation and one way forward, with no empty sections. */
export function EmptyNotebook() {
  return (
    <section className="record-section notebook-empty" aria-labelledby="notebook-empty-heading">
      <h2 id="notebook-empty-heading">Your notebook is empty</h2>
      <p>When you save a review, each lecture appears here with its topics: your explanation, the help you used, the status and the lecture source.</p>
      <Link to={{ page: "home" }}>Choose a lecture to review</Link>
    </section>
  );
}

const startedAt = (ms: number): string => new Date(ms).toLocaleString();

function LectureSection({ lecture, children }: { readonly lecture: NotebookLecture; readonly children: ReactNode }) {
  const headingId = useId();
  return (
    <section className="record-section notebook-lecture" aria-labelledby={headingId}>
      <header className="record-note-heading">
        <div>
          <p className="page-kicker">Lecture</p>
          <h2 id={headingId}>{lecture.title ?? "Lecture title unavailable"}</h2>
          {lecture.detail !== null && <p className="muted">{lecture.detail}</p>}
        </div>
        <ul className="notebook-reviews">
          {lecture.reviews.map((r) => (
            <li key={r.reviewId}><Link to={{ page: "review", id: r.reviewId }}>{lecture.reviews.length > 1 && r.startedMs !== null ? `Revisit review from ${startedAt(r.startedMs)}` : "Revisit review"}</Link></li>
          ))}
        </ul>
      </header>
      {children}
    </section>
  );
}

type TopicDiagramState =
  | { readonly kind: "none" }
  | { readonly kind: "failed"; readonly error: string; readonly retry: () => void }
  | { readonly kind: "ready"; readonly topic: TopicDiagram; readonly error: string | null; readonly request: () => void };

function topicDiagram(lecture: NotebookLecture, topic: NotebookTopic, diagrams: ReviewDiagrams): TopicDiagramState {
  if (topic.conceptId === null) return { kind: "none" };
  const conceptId = topic.conceptId;
  for (const { reviewId } of lecture.reviews) {
    const d = diagrams.values.get(reviewId);
    const found = d?.state === "ready" ? d.topics.find((t) => t.topicId === conceptId) : undefined;
    if (d?.state === "ready" && found !== undefined) return { kind: "ready", topic: found, error: d.error, request: () => void diagrams.request(reviewId, conceptId) };
  }
  const failed = lecture.reviews.find((r) => diagrams.values.get(r.reviewId)?.state === "failed");
  const d = failed === undefined ? undefined : diagrams.values.get(failed.reviewId);
  return failed !== undefined && d?.state === "failed" ? { kind: "failed", error: d.error, retry: () => diagrams.load(failed.reviewId) } : { kind: "none" };
}

/** One topic: the learner's explanation, the help they used, its status, then its source, under one heading. */
export function TopicSection({ api, topic, name, headingId, contexts, retry, diagram, deleted, citations, drafts, setDraft, run }: {
  readonly api: AppApi;
  readonly topic: NotebookTopic;
  readonly name: string;
  readonly headingId: string;
  readonly contexts: ReadonlyMap<ReviewId, ReviewContext>;
  readonly retry: (reviewId: ReviewId) => void;
  readonly diagram: TopicDiagramState;
  readonly deleted: ReadonlySet<string>;
  readonly citations: Citations;
  readonly drafts: NoteDrafts;
  readonly setDraft: SetDraft;
  readonly run: Run;
}) {
  const help = topic.notes.flatMap((n) => noteView(n).segments.filter((s) => s.author === "tutor"));
  const statuses = [...new Set(topic.observations.map((o) => STATUS_LABEL[o.status]))];
  return (
    <article className="notebook-topic" aria-labelledby={headingId}>
      <h3 id={headingId} tabIndex={-1}>{name}</h3>
      {statuses.length > 0 && (
        <p className="topic-status">
          <strong>Status: </strong>{statuses.join(", ")}
          {topic.revisit && <span className="topic-flag"> · To revisit</span>}
          {topic.disputed && <span className="topic-flag"> · Disputed, not counted as a gap</span>}
        </p>
      )}
      {topic.notes.length > 0 && (
        <section className="topic-part" aria-label={`${TOPIC_SECTIONS.explanation}: ${name}`}>
          <h4>{TOPIC_SECTIONS.explanation}</h4>
          {topic.notes.map((note) => <NoteExplanation key={note.id} api={api} note={note} topic={name} draft={drafts.get(note.id) ?? null} setDraft={setDraft} run={run} />)}
        </section>
      )}
      {help.length > 0 && (
        <section className="topic-part" aria-label={`${TOPIC_SECTIONS.help}: ${name}`}>
          <h4>{TOPIC_SECTIONS.help}</h4>
          {help.map((s, i) => <p key={i} className="author-tutor"><strong>{s.label}: </strong>{s.text}</p>)}
        </section>
      )}
      {topic.observations.length > 0 && (
        <section className="topic-part" aria-label={`${TOPIC_SECTIONS.status}: ${name}`}>
          <h4>{TOPIC_SECTIONS.status}</h4>
          <ul className="record-list">
            {topic.observations.map((o, index) => (
              <ObservationItem key={o.id} api={api} observation={o} number={index + 1} context={observationContext(o, contexts.get(o.reviewId))} deleted={deleted} retry={() => retry(o.reviewId)} run={run} />
            ))}
          </ul>
        </section>
      )}
      <TopicSource api={api} notes={topic.notes} name={name} diagram={diagram} deleted={deleted} citations={citations} run={run} />
    </article>
  );
}

/** The learner's own words for one note, with their edit beside the original and never replacing it. */
function NoteExplanation({ api, note, topic, draft, setDraft, run }: {
  readonly api: AppApi;
  readonly note: Note;
  readonly topic: string;
  readonly draft: string | null;
  readonly setDraft: SetDraft;
  readonly run: Run;
}) {
  const editId = useId();
  const view = noteView(note);
  const mine = view.segments.filter((s) => s.author === "learner");
  return (
    <div className="record-note">
      {mine.map((s, i) => <p key={i} className="author-learner"><strong>{s.label}: </strong>{s.text}</p>)}
      {mine.length === 0 && view.userEdit === null && <p className="muted">No explanation of yours was saved for this topic.</p>}
      {view.userEdit !== null && draft === null && <p className="author-learner"><strong>Your edit: </strong>{view.userEdit}</p>}
      {draft !== null ? (
        <div>
          <label htmlFor={editId}>Your edit</label>
          <p className="muted">Your wording is kept alongside the original contributions.</p>
          <textarea id={editId} value={draft} rows={4} onChange={(e) => setDraft(note.id, e.target.value)} />
          <div className="actions">
            <button type="button" onClick={() => void run(async () => { await api.editNote(note.id, draft); setDraft(note.id, null); })}>Save edit</button>
            <button type="button" onClick={() => setDraft(note.id, null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="actions">
          <button type="button" aria-label={`Edit your note on ${topic}`} onClick={() => setDraft(note.id, view.userEdit ?? "")}>Edit</button>
          <button type="button" aria-label={`Delete your note on ${topic}`} onClick={() => window.confirm("Delete this note? Its help and source lines go with it.") && void run(() => api.deleteNote(note.id))}>Delete</button>
        </div>
      )}
    </div>
  );
}

type OpenSource = { readonly ids: readonly EvidenceId[]; readonly origin: HTMLElement | null };

/** The lecture's words, the cited evidence, then a compact frame and its summary. Nothing here asks for a summary until the learner does. */
function TopicSource({ api, notes, name, diagram, deleted, citations, run }: {
  readonly api: AppApi;
  readonly notes: readonly Note[];
  readonly name: string;
  readonly diagram: TopicDiagramState;
  readonly deleted: ReadonlySet<string>;
  readonly citations: Citations;
  readonly run: Run;
}) {
  const [open, setOpen] = useState<OpenSource | null>(null);
  const lecture = notes.flatMap((n) => noteView(n).segments.filter((s) => s.author === "source"));
  const cited = [...new Set(notes.flatMap((n) => [...n.evidence, ...n.generated.flatMap((s) => s.evidence)]))];
  const missingDetails = cited.some((id) => !deleted.has(id) && !citations.data?.frames.some((frame) => frame.id === id) && !citations.data?.passages.some((passage) => passage.id === id));
  if (lecture.length === 0 && cited.length === 0 && diagram.kind === "none") return null;

  function close() {
    open?.origin?.focus();
    setOpen(null);
  }
  const isOpen = (id: EvidenceId) => open !== null && open.ids.length === 1 && open.ids[0] === id;

  return (
    <section className="topic-part" aria-label={`${TOPIC_SECTIONS.source}: ${name}`}>
      <h4>{TOPIC_SECTIONS.source}</h4>
      {lecture.map((s, i) => <p key={i} className="author-source"><strong>{s.label}: </strong>{s.text}</p>)}
      {cited.length > 0 && (
        <p>
          Evidence:{" "}
          {cited.map((id, i) => {
            if (deleted.has(id)) return <span key={id} className="muted">[{i + 1}: deleted by you] </span>;
            const frame = citations.data?.frames.find((frame) => frame.id === id);
            const passage = citations.data?.passages.find((passage) => passage.id === id);
            const label = frame ? `Captured frame ${formatClock(frame.mediaS)}` : passage ? `Transcript ${formatInterval(passage.interval)}` : citations.loading ? "Loading evidence details…" : "Evidence details unavailable";
            return <button key={id} type="button" aria-label={frame || passage ? `Open ${label.toLowerCase()}` : "Open cited evidence"} aria-pressed={isOpen(id)} onClick={(e) => (isOpen(id) ? setOpen(null) : setOpen({ ids: [id], origin: e.currentTarget }))}>{label}</button>;
          })}
        </p>
      )}
      {cited.some((id) => !deleted.has(id)) && !citations.loading && (citations.error !== null || missingDetails) && <p className="muted">Some evidence details could not be loaded. <button type="button" onClick={citations.reload}>Retry evidence details</button></p>}
      {diagram.kind === "failed" && <ErrorNote error={`The frame and summary could not be loaded: ${diagram.error}`} retry={diagram.retry} />}
      {diagram.kind === "ready" && (
        <div className="topic-diagram">
          <FramePreview api={api} frame={diagram.topic.frame} deleted={deleted} />
          <ErrorNote error={diagram.error} />
          {diagram.topic.summary.state === "ready" && <p className="topic-summary-title"><strong>{diagram.topic.summary.title}</strong></p>}
          <DiagramSummaryView topic={diagram.topic} onRequest={diagram.request} onCite={(ids, _label, origin) => setOpen({ ids, origin })} />
        </div>
      )}
      {open !== null && (
        <section className="record-evidence" aria-label={`Lecture evidence for ${name}`}>
          <div className="record-note-heading"><h5>Lecture evidence</h5><button type="button" onClick={close}>Close source</button></div>
          <EvidencePane api={api} ids={open.ids} titles={noTitles} />
          <button
            type="button"
            onClick={() => window.confirm("Delete this evidence everywhere? Notes citing it will show it as deleted.") && void run(async () => { await api.deleteEvidence(open.ids); setOpen(null); })}
          >
            Delete this evidence
          </button>
        </section>
      )}
    </section>
  );
}

/** A small frame first; the learner expands it to full width. */
export function FramePreview({ api, frame, deleted }: { readonly api: AppApi; readonly frame: DiagramFrame | null; readonly deleted: ReadonlySet<string> }) {
  const [expanded, setExpanded] = useState(false);
  if (frame === null) return <p className="muted">{NO_FRAME_NOTE}</p>;
  if (deleted.has(frame.id)) return <p className="muted">You deleted the frame captured for this topic.</p>;
  const link = frameLink(frame);
  return (
    <figure className="topic-frame" data-expanded={expanded}>
      <FrameImage api={api} id={frame.id} />
      <figcaption className="muted">
        Captured frame · {frame.title ?? "Lecture"} at {formatClock(frame.mediaS)}
        {link !== null && <> · <a href={link} target="_blank" rel="noreferrer">Open in YouTube at that moment ↗</a></>}
      </figcaption>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Show smaller frame" : "Expand frame"}</button>
    </figure>
  );
}

/**
 * One value per saved review, each read on its own, so one failed review shows its own retry while the others keep
 * theirs. `read` must not reject. A newer read for a review replaces an older one that answers late.
 */
function usePerReview<T>(reviewIds: readonly ReviewId[], read: (id: ReviewId) => Promise<T>, loading: T) {
  const [values, setValues] = useState<ReadonlyMap<ReviewId, T>>(new Map());
  const requests = useRef(new Map<ReviewId, number>());
  const mounted = useRef(true);
  const reader = useRef(read);
  useLayoutEffect(() => { reader.current = read; }, [read]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const load = useCallback((id: ReviewId, quiet = false) => {
    const request = (requests.current.get(id) ?? 0) + 1;
    requests.current.set(id, request);
    if (!quiet) setValues((m) => new Map(m).set(id, loading));
    void reader.current(id).then((value) => {
      if (mounted.current && requests.current.get(id) === request) setValues((m) => new Map(m).set(id, value));
    });
  }, [loading]);
  const update = useCallback((id: ReviewId, next: (prev: T | undefined) => T) => {
    requests.current.set(id, (requests.current.get(id) ?? 0) + 1);
    setValues((m) => new Map(m).set(id, next(m.get(id))));
  }, []);
  useEffect(() => {
    for (const id of reviewIds) if (!requests.current.has(id)) load(id);
  }, [load, reviewIds]);
  return { values, load, update };
}

const LOADING_CONTEXT: ReviewContext = { state: "loading" };

function useReviewContexts(api: AppApi, reviewIds: readonly ReviewId[]) {
  const { values, load } = usePerReview(reviewIds, (id) => loadReviewContext(api, id), LOADING_CONTEXT);
  return { contexts: values, retry: load };
}

type LoadedDiagrams =
  | { readonly state: "loading" }
  | { readonly state: "failed"; readonly error: string }
  | { readonly state: "ready"; readonly topics: readonly TopicDiagram[]; readonly error: string | null };
type ReviewDiagrams = ReturnType<typeof useReviewDiagrams>;

const LOADING_DIAGRAMS: LoadedDiagrams = { state: "loading" };

/** Each review's topic diagrams, read only. A summary is written only when `request` is called from its button. */
function useReviewDiagrams(api: AppApi, reviewIds: readonly ReviewId[]) {
  const read = (id: ReviewId): Promise<LoadedDiagrams> => api.diagrams(id).then((topics) => ({ state: "ready", topics, error: null }), (e: unknown) => ({ state: "failed", error: message(e) }));
  const { values, load, update } = usePerReview(reviewIds, read, LOADING_DIAGRAMS);
  const preparing = useMemo(() => [...values].filter(([, d]) => d.state === "ready" && shouldPollDiagrams(d.topics)).map(([id]) => id), [values]);
  useEffect(() => {
    if (preparing.length === 0) return;
    const timer = setTimeout(() => { for (const id of preparing) load(id, true); }, POLL_MS);
    return () => clearTimeout(timer);
  }, [preparing, load]);
  const request = useCallback(async (reviewId: ReviewId, topicId: ConceptId): Promise<void> => {
    try {
      const next = await api.requestDiagram(reviewId, topicId);
      update(reviewId, (prev) => (prev?.state === "ready" ? { ...prev, topics: prev.topics.map((t) => (t.topicId === topicId ? next : t)), error: null } : prev ?? LOADING_DIAGRAMS));
    } catch (e) {
      update(reviewId, (prev) => (prev?.state === "ready" ? { ...prev, error: message(e) } : prev ?? LOADING_DIAGRAMS));
    }
  }, [api, update]);
  return { values, load, request };
}

export function ObservationItem({ api, observation: o, number, context, deleted, retry, run }: {
  readonly api: AppApi;
  readonly observation: Observation;
  readonly number: number;
  readonly context: ObservationContext;
  readonly deleted: ReadonlySet<string>;
  readonly retry: () => void;
  readonly run: Run;
}) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [choice, setChoice] = useState<DisputeChoice>("keep");
  const [showEvidence, setShowEvidence] = useState(false);
  const row = observationRow(o);
  const ready = canChangeObservation(context);
  const details = ready ? context.details : null;
  const name = details?.topic ?? `Observation ${number}`;
  const evidence = details?.evidence.filter((id) => !deleted.has(id)) ?? [];

  async function change(action: () => Promise<void>) {
    if (await changeObservation(context, run, action)) heading.current?.focus();
  }

  return (
    <li className="record-observation" aria-labelledby={headingId}>
      <h5 id={headingId} ref={heading} tabIndex={-1}>{name}</h5>
      <p><strong>Status: {row.status}</strong>{row.note && <span className="muted"> {row.note}</span>}</p>
      {context.kind === "loading" && <p className="muted" role="status">Loading the topic, question and your answer...</p>}
      {context.kind === "failed" && <ErrorNote error={`The topic, question and your answer could not be loaded: ${context.error}`} retry={retry} />}
      {context.kind === "incomplete" && <p className="muted">The saved review no longer shows the {context.missing.join(" or ")} for this observation, so it can't be changed here. <Link to={{ page: "review", id: o.reviewId }}>Revisit review</Link></p>}
      {details && (
        <dl className="observation-context">
          <dt>{details.kind}</dt><dd>{details.question}</dd>
          <dt>Your answer</dt><dd className="author-learner">{details.answers.length > 0 ? details.answers.map((a, i) => <p key={i}>{a}</p>) : "No answer recorded."}</dd>
          {details.dispute !== null && <><dt>Your dispute</dt><dd className="author-learner">{details.dispute}</dd></>}
          <dt>Tutor's judgment</dt><dd className="author-tutor">Proposed "{details.proposed}".{details.reasoning !== null && <> {details.reasoning}</>}</dd>
        </dl>
      )}
      {details && (evidence.length > 0 ? (
        <>
          <button type="button" aria-expanded={showEvidence} onClick={() => setShowEvidence(!showEvidence)}>{showEvidence ? "Hide lecture evidence" : `Show lecture evidence (${evidence.length})`}</button>
          {showEvidence && <section className="record-evidence" aria-label={`Lecture evidence for ${details.topic}`}><EvidencePane api={api} ids={evidence} titles={noTitles} /></section>}
        </>
      ) : <p className="muted">{details.evidence.length > 0 ? "You deleted the evidence the tutor cited here." : "The tutor cited no lecture evidence on this question."}</p>)}
      {!ready && <p className="muted">You can change this observation once its topic, question and answer are shown.</p>}
      <div className="actions">
        <label>
          Correct status{" "}
          <select aria-label={`Correct status for ${name}`} value="" disabled={!ready} onChange={(e) => { const status = e.target.value as ObservationStatus | ""; if (status) void change(() => api.overrideObservation(o.id, status)); }}>
            <option value="">Choose...</option>
            {OVERRIDES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </label>
      </div>
      {row.disputeOpen && (
        <fieldset className="dispute-decision" disabled={!ready}>
          <legend>Settle the dispute about {name}</legend>
          {DISPUTE_CHOICES.map((c) => (
            <label key={c.value} className="dispute-choice">
              <input type="radio" name={`${headingId}-dispute`} value={c.value} checked={choice === c.value} onChange={() => setChoice(c.value)} />
              <span><strong>{c.label}</strong> <span className="muted">{c.meaning}</span></span>
            </label>
          ))}
          <button type="button" disabled={choice === "keep"} onClick={() => { if (choice !== "keep") { const outcome = choice; void change(() => api.resolveDispute(o.id, outcome)); } }}>Save decision</button>
        </fieldset>
      )}
    </li>
  );
}

export function UsageTable({ summary }: { readonly summary: UsageSummary }) {
  return (
    <>
      <p className="muted">Totals are per cost kind and are never added together. Unknown cost stays unknown.</p>
      <div className="usage-table-scroll"><table>
        <caption>Calls and cost by cost kind</caption>
        <thead>
          <tr><th>Cost kind</th><th>Calls</th><th>Amount</th></tr>
        </thead>
        <tbody>
          {usageRows(summary).map((r) => (
            <tr key={r.kind}><td>{r.kind}</td><td>{r.calls}</td><td>{r.amount}</td></tr>
          ))}
        </tbody>
      </table></div>
      <h2>By purpose</h2>
      {Object.values(summary.byPurpose).every((value) => value.calls === 0) && <p className="muted">No calls recorded yet.</p>}
      <div className="usage-table-scroll"><table>
        <caption>Calls by purpose</caption>
        <thead>
          <tr><th>Purpose</th><th>Calls</th><th>Errors</th><th>Cost unknown</th></tr>
        </thead>
        <tbody>
          {Object.entries(summary.byPurpose).filter(([, v]) => v.calls > 0).map(([purpose, v]) => (
            <tr key={purpose}><td>{purpose.replaceAll("_", " ")}</td><td>{v.calls}</td><td>{v.errors}</td><td>{v.unknownCost}</td></tr>
          ))}
        </tbody>
      </table></div>
    </>
  );
}

/** This month's allowance. Nothing when no budget runs. */
export function AllowanceNote({ allowance }: { readonly allowance: UsageSummary["allowance"] }) {
  const view = allowanceView(allowance);
  if (view === null) return null;
  return (
    <section className="record-section" aria-labelledby="allowance-heading">
      <h2 id="allowance-heading">This month</h2>
      <p>{view.line}</p>
      {view.held !== null && <p className="note" role="status">{view.held}</p>}
      <p className="muted">A call whose cost was not reported counts at the amount set aside for it before it ran.</p>
    </section>
  );
}

/** Hosted, a learner sees only this month's allowance. The tables by cost kind and purpose are for the developer running it locally. */
export function UsageScreen({ api, hosted = false }: { readonly api: AppApi; readonly hosted?: boolean }) {
  const usage = useAsync(useCallback(() => api.usage(), [api]));
  return (
    <main className="notebook-page usage-page room-paper" {...objectFrame("source")}>
      <header className="page-heading"><div><p className="page-kicker">{hosted ? "Your AI allowance" : "Local usage record"}</p><h1>Usage</h1></div><nav aria-label="Usage navigation"><Link to={{ page: "record", reviewId: null }}>My notebook</Link><Link to={{ page: "home" }}>Your lectures</Link></nav></header>
      <ErrorNote error={usage.error} retry={usage.reload} />
      {usage.data === null && usage.error === null && <p className="page-loading" role="status">Opening the usage record...</p>}
      {usage.data && <AllowanceNote allowance={usage.data.allowance} />}
      {usage.data && !hosted && <div className="record-section"><UsageTable summary={usage.data} /></div>}
    </main>
  );
}
