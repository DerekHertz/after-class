import { useCallback, useEffect, useRef, useState } from "react";
import type { ConceptId, EvidenceId, ReviewId } from "../shared/ids";
import type { TopicDiagram } from "../shared/domain";
import type { AppApi } from "./api";
import { formatClock } from "./core";
import type { SourceTitles } from "./core";
import { citationLabels, frameLink, illustratedPages, needsSummary, NO_FRAME_NOTE, shouldPollDiagrams, SUMMARY_NOTE } from "./diagram-view";
import type { IllustratedPage } from "./diagram-view";
import { ErrorNote, EvidencePane, FrameImage, useAsync } from "./ui";

export type Diagrams = {
  readonly topics: readonly TopicDiagram[] | null;
  readonly error: string | null;
  readonly reload: () => void;
  /** Starts (or retries) the topic's summary. */
  readonly request: (topicId: ConceptId) => Promise<void>;
};

const POLL_MS = 2000;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The review's topic diagrams, kept fresh while a summary is being written. A summary is only ever asked for by `request`.
 */
export function useDiagrams(api: AppApi, reviewId: ReviewId): Diagrams {
  const [topics, setTopics] = useState<readonly TopicDiagram[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    api.diagrams(reviewId).then(
      (list) => { if (live) { setTopics(list); setError(null); } },
      (e: unknown) => { if (live) setError(message(e)); },
    );
    return () => { live = false; };
  }, [api, reviewId, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  const request = useCallback(async (topicId: ConceptId): Promise<void> => {
    try {
      const next = await api.requestDiagram(reviewId, topicId);
      setTopics((prev) => prev?.map((t) => (t.topicId === topicId ? next : t)) ?? prev);
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  }, [api, reviewId]);

  useEffect(() => {
    if (!shouldPollDiagrams(topics)) return;
    const timer = setTimeout(reload, POLL_MS);
    return () => clearTimeout(timer);
  }, [topics, reload]);

  return { topics, error, reload, request };
}

type CiteHandler = (ids: readonly EvidenceId[], label: string, origin: HTMLButtonElement) => void;

/** The frame a topic shows, with its time and a link back to that moment. */
export function DiagramFrameView({ api, topic }: { readonly api: AppApi; readonly topic: TopicDiagram }) {
  const frame = topic.frame;
  if (frame === null) return <p className="muted diagram-no-frame">{NO_FRAME_NOTE}</p>;
  const link = frameLink(frame);
  return (
    <figure className="diagram-frame">
      <FrameImage api={api} id={frame.id} />
      <figcaption className="muted">
        Captured frame · {frame.title ?? "Lecture"} at {formatClock(frame.mediaS)}
        {link !== null && <> · <a href={link} target="_blank" rel="noreferrer">Open in YouTube at that moment ↗</a></>}
      </figcaption>
    </figure>
  );
}

/** The state-change summary, or why there is none. Every line shown carries a citation button (R19). */
export function DiagramSummaryView({ topic, onRequest, onCite }: { readonly topic: TopicDiagram; readonly onRequest: () => void; readonly onCite: CiteHandler }) {
  const s = topic.summary;
  switch (s.state) {
    case "no_claims":
      return <p className="muted diagram-summary-note">{SUMMARY_NOTE.no_claims}</p>;
    case "not_requested":
      return (
        <p className="diagram-summary-note">
          <span className="muted">{SUMMARY_NOTE.not_requested}</span> <button type="button" onClick={onRequest}>Write the summary</button>
        </p>
      );
    case "preparing":
      return <p className="muted diagram-summary-note" role="status">{SUMMARY_NOTE.preparing}</p>;
    case "failed":
      return <ErrorNote error={`The summary could not be written: ${s.error}`} retry={onRequest} />;
    case "ready":
      return (
        <ol className="diagram-lines" aria-label={`State changes: ${s.title}`}>
          {s.lines.map((line, i) => (
            <li key={i}>
              <span>{line.text}</span>{" "}
              {citationLabels(line, i + 1).map((c) => (
                <button key={c.ids[0]} type="button" className="citation" aria-label={c.aria} onClick={(e) => onCite(c.ids, "Cited by the diagram summary", e.currentTarget)}>{c.label}</button>
              ))}
            </li>
          ))}
        </ol>
      );
  }
}

/** The diagram panel in the review's source column: the frame, then the summary, beside the always-visible conversation. */
export function DiagramPanel({ api, topic, error, onRequest, onCite, onClose }: {
  readonly api: AppApi;
  readonly topic: TopicDiagram;
  readonly error: string | null;
  readonly onRequest: () => void;
  readonly onCite: CiteHandler;
  readonly onClose: () => void;
}) {
  const heading = topic.summary.state === "ready" ? topic.summary.title : topic.label;
  return (
    <section className="diagram-panel" aria-label={`Diagram: ${topic.label}`}>
      <div className="source-heading">
        <p className="eyebrow">Diagram · {topic.label}</p>
        <h3>{heading}</h3>
        <button type="button" onClick={onClose}>Close diagram</button>
      </div>
      <ErrorNote error={error} />
      <DiagramFrameView api={api} topic={topic} />
      <DiagramSummaryView topic={topic} onRequest={onRequest} onCite={onCite} />
    </section>
  );
}

const noTitles: SourceTitles = new Map();

/** One illustrated page: the tutor's question, the frame, the state-change summary, the learner's answer and its status. */
export function IllustratedPageView({ api, page, onRequest }: { readonly api: AppApi; readonly page: IllustratedPage; readonly onRequest: () => void }) {
  const [open, setOpen] = useState<readonly EvidenceId[] | null>(null);
  const { topic, questions } = page;
  return (
    <article className="illustrated-page" aria-label={`Illustrated page: ${topic.label}`}>
      <h3>{topic.summary.state === "ready" ? topic.summary.title : topic.label}</h3>
      <p className="muted">{topic.label}</p>
      {questions.map((q) => <p key={q.threadId} className="illustrated-question"><strong>{q.kind}: </strong>{q.question}</p>)}
      <DiagramFrameView api={api} topic={topic} />
      <DiagramSummaryView topic={topic} onRequest={onRequest} onCite={(ids) => setOpen(ids)} />
      {open !== null && (
        <section className="record-evidence" aria-label="Cited lecture evidence">
          <div className="record-note-heading"><h4>Lecture evidence</h4><button type="button" onClick={() => setOpen(null)}>Close source</button></div>
          <EvidencePane api={api} ids={open} titles={noTitles} />
        </section>
      )}
      {questions.map((q) => (
        <div key={q.threadId} className="illustrated-answer">
          <p><strong>Your answer: </strong>{q.answers.length > 0 ? q.answers.join(" ") : "No answer recorded."}</p>
          <p><strong>Status: </strong>{q.status}{q.note !== null && <span className="muted"> {q.note}</span>}</p>
        </div>
      ))}
    </article>
  );
}

/** The record's illustrated pages for one saved review, one per topic it covered. With `auto`, missing summaries are written on view; without, each waits for its button (the all-notes view must not spend a call per old review). */
export function IllustratedReview({ api, reviewId, auto }: { readonly api: AppApi; readonly reviewId: ReviewId; readonly auto: boolean }) {
  const review = useAsync(() => api.review(reviewId), [api, reviewId]);
  const diagrams = useDiagrams(api, reviewId);
  const asked = useRef(new Set<ConceptId>());
  const pages = review.data === null || diagrams.topics === null ? [] : illustratedPages(review.data, diagrams.topics);
  const missing = auto ? pages.filter((p) => needsSummary(p.topic)).map((p) => p.topic.topicId).join(",") : "";
  useEffect(() => {
    for (const id of missing === "" ? [] : (missing.split(",") as ConceptId[])) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      void diagrams.request(id);
    }
  }, [missing]);
  return (
    <>
      <ErrorNote error={review.error} retry={review.reload} />
      <ErrorNote error={diagrams.error} retry={diagrams.reload} />
      {(review.loading || diagrams.topics === null) && review.error === null && diagrams.error === null && <p className="muted" role="status">Opening the illustrated pages...</p>}
      {review.data !== null && diagrams.topics !== null && pages.length === 0 && <p className="muted">No topic was asked about in this review.</p>}
      {pages.map((p) => <IllustratedPageView key={p.topic.topicId} api={api} page={p} onRequest={() => void diagrams.request(p.topic.topicId)} />)}
    </>
  );
}

/** A "Show diagram" button for one topic. */
export function ShowDiagramButton({ topic, onShow }: { readonly topic: { readonly id: ConceptId; readonly label: string }; readonly onShow: (topicId: ConceptId) => void }) {
  return <button type="button" className="show-diagram" aria-label={`Show diagram: ${topic.label}`} onClick={() => onShow(topic.id)}>Show diagram</button>;
}
