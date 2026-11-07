import { useCallback, useEffect, useState } from "react";
import type { ConceptId, EvidenceId, ReviewId } from "../shared/ids";
import type { TopicDiagram } from "../shared/domain";
import type { AppApi } from "./api";
import { formatClock } from "./core";
import { frameLink, lineSources, NO_FRAME_NOTE, shouldPollDiagrams, SUMMARY_NOTE } from "./diagram-view";
import { ErrorNote, FrameImage } from "./ui";

export type Diagrams = {
  readonly topics: readonly TopicDiagram[] | null;
  readonly error: string | null;
  readonly reload: () => void;
  /** Starts (or retries) the topic's summary. */
  readonly request: (topicId: ConceptId) => Promise<void>;
};

export const POLL_MS = 2000;
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

/** The state-change summary, or why there is none. Citations (R19) stay on every line but are hidden until one control for the whole diagram shows them. */
export function DiagramSummaryView({ topic, onRequest, onCite, initialSources = false }: { readonly topic: TopicDiagram; readonly onRequest: () => void; readonly onCite: CiteHandler; readonly initialSources?: boolean }) {
  const [showSources, setShowSources] = useState(initialSources);
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
        <>
          <button type="button" className="diagram-sources-toggle" aria-expanded={showSources} onClick={() => setShowSources((v) => !v)}>{showSources ? "Hide sources" : "Show sources"}</button>
          <ol className="diagram-lines" aria-label={`State changes: ${s.title}`}>
            {s.lines.map((line, i) => {
              const src = lineSources(line, i + 1);
              return (
                <li key={i}>
                  <span>{line.text}</span>
                  {showSources && line.evidence.length > 0 && <>{" "}<button type="button" className="citation" aria-label={src.aria} onClick={(e) => onCite(src.ids, "Cited by the diagram summary", e.currentTarget)}>{src.label}</button></>}
                </li>
              );
            })}
          </ol>
        </>
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
        <button type="button" onClick={onClose}>Close diagram</button>
      </div>
      <ErrorNote error={error} />
      <DiagramFrameView api={api} topic={topic} />
      <h3>{heading}</h3>
      <DiagramSummaryView topic={topic} onRequest={onRequest} onCite={onCite} />
    </section>
  );
}

/** A "Show diagram" button for one topic. */
export function ShowDiagramButton({ topic, onShow }: { readonly topic: { readonly id: ConceptId; readonly label: string }; readonly onShow: (topicId: ConceptId) => void }) {
  return <button type="button" className="show-diagram" aria-label={`Show diagram: ${topic.label}`} onClick={() => onShow(topic.id)}>Show diagram</button>;
}
