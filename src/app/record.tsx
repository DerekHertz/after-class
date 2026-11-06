import { useId, useRef, useState } from "react";
import type { EvidenceId, ReviewId } from "../shared/ids";
import type { EvidenceBundle, LinkDecision, LinkType, Note, ObservationStatus, RecordView, UsageSummary } from "../shared/domain";
import type { AppApi } from "./api";
import { formatClock, formatInterval, noteView, observationRow, STATUS_LABEL, usageRows } from "./core";
import type { SourceTitles } from "./core";
import { ErrorNote, EvidencePane, Link, useAsync } from "./ui";
import { IllustratedReview } from "./diagram";


const LINK_TYPES: readonly LinkType[] = ["prerequisite_of", "part_of", "example_of", "contrasts_with", "related_to"];
const OVERRIDES: readonly ObservationStatus[] = ["independent", "partial", "after_help", "unresolved", "not_assessed"];
const noTitles: SourceTitles = new Map();
type CitationDetails = Pick<EvidenceBundle, "frames" | "passages">;

const decisionText = (d: LinkDecision): string => (typeof d === "string" ? d : `corrected to ${d.corrected.replaceAll("_", " ")}`);

export function RecordScreen({ api, reviewId, indexed = false }: { readonly indexed?: boolean; readonly api: AppApi; readonly reviewId: ReviewId | null }) {
  const record = useAsync(() => api.record(reviewId === null ? {} : { reviewId }), [api, reviewId]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);

  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      await action();
      record.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  const [page, setPage] = useState("index");
  const data = record.data;
  // Only a saved review has notes, so only a saved review gets illustrated pages. One review's record shows that review alone.
  const illustratedReviews = data ? [...new Set(data.notes.map((n) => n.reviewId))].filter((id) => reviewId === null || id === reviewId) : [];
  const pages = data ? [
    ...data.notes.map((note, index) => {
      const view = noteView(note);
      const title = view.userEdit?.trim() || view.segments.find(segment => segment.author === "learner")?.text || view.segments[0]?.text;
      return { id: String(note.id), title: title?.slice(0, 100) || `Review note ${index + 1}` };
    }),
    ...(illustratedReviews.length > 0 ? [{ id: "illustrated", title: "Illustrated pages" }] : []),
    { id: "observations", title: "Tutor observations" },
    { id: "links", title: "Concept connections" },
  ] : [];
  function turnPage(id: string) {
    setPage(id);
    document.querySelector("dialog.room-notebook-dialog")?.scrollTo(0, 0);
  }
  return (
    <main className="notebook-page record-page">
      <header className="page-heading">
        <div><p className="page-kicker">Kept in your own words</p><h1 tabIndex={-1}>My notebook</h1></div>
        <nav aria-label="Notebook navigation"><Link to={{ page: "home" }}>Your lectures</Link> <Link to={{ page: "usage" }}>Usage</Link></nav>
      </header>
      <p className="muted">{reviewId === null ? "Notes from all your saved reviews." : "Notes from this review."} Learner, tutor, and source contributions stay separate.</p>
      {reviewId !== null && <p><Link to={{ page: "review", id: reviewId }}>Return to review</Link> · <Link to={{ page: "record", reviewId: null }}>All notes</Link></p>}
      <ErrorNote error={record.error} retry={record.reload} />
      <ErrorNote error={error} />
      {record.data === null && record.error === null && <p className="page-loading" role="status">Opening your notebook...</p>}
      {saving && <p className="page-loading" role="status">Saving your change...</p>}
      {indexed && page === "index" && data && <nav aria-label="Notebook index"><h2>Index</h2><ol>{pages.map(entry => <li key={entry.id}><button onClick={() => turnPage(entry.id)}>{entry.title}</button></li>)}</ol></nav>}
      {indexed && page !== "index" && <button onClick={() => turnPage("index")}>Return to index</button>}
      {data && (!indexed || page === "illustrated") && illustratedReviews.length > 0 && (
        <section className="record-section illustrated-pages" aria-labelledby="record-illustrated-heading" data-notebook-page={indexed ? "illustrated" : undefined}>
          <h2 id="record-illustrated-heading">Illustrated pages</h2>
          <p className="muted">One page per topic you were asked about: the question, the lecturer's frame, what changes, your answer, and its status.</p>
          {illustratedReviews.map((id) => <IllustratedReview key={id} api={api} reviewId={id} auto={reviewId !== null} />)}
        </section>
      )}
      {data && (!indexed || (page !== "index" && page !== "illustrated")) && <fieldset key={page} data-notebook-page={indexed ? (["links", "observations"].includes(page) ? page : "note") : undefined} className="record-content" disabled={saving} aria-label="Saved learning record"><RecordBody api={api} data={indexed ? { ...data, notes: data.notes.filter(note => note.id === page) } : data} run={run} /></fieldset>}
    </main>
  );
}

export function RecordBody({ api, data, run }: { readonly api: AppApi; readonly data: RecordView; readonly run: (a: () => Promise<void>) => Promise<void> }) {
  const deleted = new Set<string>(data.unavailableEvidence.map((d) => d.id));
  const cited = [...new Set(data.notes.flatMap((note) => [...note.evidence, ...note.generated.flatMap((segment) => segment.evidence)]))].filter((id) => !deleted.has(id)).sort();
  const citationKey = cited.join(",");
  const citations = useAsync(async (): Promise<CitationDetails | null> => {
    if (cited.length === 0) return null;
    const batches = [];
    for (let offset = 0; offset < cited.length; offset += 250) batches.push(cited.slice(offset, offset + 250));
    const bundles = await Promise.all(batches.map((ids) => api.evidence({ ids })));
    return { frames: bundles.flatMap((bundle) => bundle.frames), passages: bundles.flatMap((bundle) => bundle.passages) };
  }, [api, citationKey]);
  return (
    <>
      <section className="record-section" aria-labelledby="record-notes-heading">
      <h2 id="record-notes-heading">Your notes</h2>
      {data.notes.length === 0 && <div className="notebook-empty"><h3>No saved notes yet</h3><p>Your explanations and the help you used will appear here after you save a review.</p><Link to={{ page: "home" }}>Open a lecture capture</Link></div>}
      {data.notes.map((n) => <NoteCard key={n.id} api={api} note={n} deleted={deleted} citations={citations} run={run} />)}
      </section>

      <section className="record-section" aria-labelledby="record-observations-heading">
      <h2 id="record-observations-heading">What the tutor observed</h2>
      <p className="muted">These observations describe the review. You can correct them or settle an open dispute.</p>
      {data.observations.length === 0 && <p className="muted">No observations.</p>}
      <ul className="record-list">
        {data.observations.map((o) => {
          const row = observationRow(o);
          return (
            <li key={o.id}>
              <strong>{row.status}</strong>
              {row.note && <span className="muted"> {row.note}</span>}
              <div className="actions">
                <label>
                  Correct status{" "}
                  <select value="" onChange={(e) => e.target.value && void run(() => api.overrideObservation(o.id, e.target.value as ObservationStatus))}>
                    <option value="">Choose...</option>
                    {OVERRIDES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                  </select>
                </label>
                {row.disputeOpen && (
                  <>
                    <button type="button" onClick={() => void run(() => api.resolveDispute(o.id, "learner_was_right"))}>The tutor was wrong</button>
                    <button type="button" onClick={() => void run(() => api.resolveDispute(o.id, "it_was_my_gap"))}>It was my gap</button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      </section>
      <section className="record-section" aria-labelledby="record-links-heading">
      <h2 id="record-links-heading">Suggested links between concepts</h2>
      <p className="muted">Accept, reject, or correct each connection. A suggestion is not a decision.</p>
      {data.links.length === 0 && <p className="muted">No suggested links.</p>}
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
    </>
  );
}

function NoteCard({ api, note, deleted, citations, run }: { readonly api: AppApi; readonly note: Note; readonly deleted: ReadonlySet<string>; readonly citations: ReturnType<typeof useAsync<CitationDetails | null>>; readonly run: (a: () => Promise<void>) => Promise<void> }) {
  const editId = useId();
  const sourceButtons = useRef(new Map<EvidenceId, HTMLButtonElement>());
  const view = noteView(note);
  const wording = view.userEdit?.trim() || view.segments.find((segment) => segment.author === "learner")?.text.trim() || view.segments[0]?.text.trim() || "Review note";
  const heading = wording.length > 120 ? `${wording.slice(0, 120)}…` : wording;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(view.userEdit ?? "");
  const [open, setOpen] = useState<EvidenceId | null>(null);
  const cited = [...new Set([...note.evidence, ...view.segments.flatMap((s) => s.evidence)])];
  const missingDetails = cited.some((id) => !deleted.has(id) && !citations.data?.frames.some((frame) => frame.id === id) && !citations.data?.passages.some((passage) => passage.id === id));

  function closeSource() {
    if (open !== null) sourceButtons.current.get(open)?.focus();
    setOpen(null);
  }

  return (
    <article className="record-note">
      <header className="record-note-heading"><h3>{heading}</h3><Link to={{ page: "review", id: note.reviewId }}>Revisit review</Link></header>
      {view.segments.map((s, i) => (
        <p key={i} className={`author-${s.author}`}>
          <strong>{s.label}: </strong>
          {s.text}
        </p>
      ))}
      {view.userEdit !== null && !editing && (
        <p className="author-learner">
          <strong>Your edit: </strong>
          {view.userEdit}
        </p>
      )}
      {editing ? (
        <div>
          <label htmlFor={editId}>Your edit</label>
          <p className="muted">Your wording is kept alongside the original contributions.</p>
          <textarea id={editId} value={draft} rows={4} onChange={(e) => setDraft(e.target.value)} />
          <div className="actions">
            <button type="button" onClick={() => void run(async () => { await api.editNote(note.id, draft); setEditing(false); })}>Save edit</button>
            <button type="button" onClick={() => { setDraft(view.userEdit ?? ""); setEditing(false); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="actions">
          <button type="button" onClick={() => setEditing(true)}>Edit</button>
          <button type="button" onClick={() => window.confirm("Delete this note?") && void run(() => api.deleteNote(note.id))}>Delete</button>
        </div>
      )}
      {cited.length > 0 && (
        <p>
          Evidence:{" "}
          {cited.map((id, i) => {
            if (deleted.has(id)) return <span key={id} className="muted">[{i + 1}: deleted by you] </span>;
            const frame = citations.data?.frames.find((frame) => frame.id === id);
            const passage = citations.data?.passages.find((passage) => passage.id === id);
            const label = frame ? `Captured frame ${formatClock(frame.mediaS)}` : passage ? `Transcript ${formatInterval(passage.interval)}` : citations.loading ? "Loading evidence details…" : "Evidence details unavailable";
            return <button key={id} type="button" ref={(element) => { if (element) sourceButtons.current.set(id, element); else sourceButtons.current.delete(id); }} aria-label={frame || passage ? `Open ${label.toLowerCase()}` : "Open cited evidence"} aria-pressed={open === id} onClick={() => setOpen(open === id ? null : id)}>{label}</button>;
          })}
        </p>
      )}
      {cited.some((id) => !deleted.has(id)) && !citations.loading && (citations.error !== null || missingDetails) && <p className="muted">Some evidence details could not be loaded. <button type="button" onClick={citations.reload}>Retry evidence details</button></p>}
      {open !== null && (
        <>
          <section className="record-evidence" aria-label="Cited lecture evidence">
          <div className="record-note-heading"><h4>Lecture evidence</h4><button type="button" onClick={closeSource}>Close source</button></div>
          <EvidencePane api={api} ids={[open]} titles={noTitles} />
          <button
            type="button"
            onClick={() => window.confirm("Delete this evidence everywhere? Notes citing it will show it as deleted.") && void run(async () => { await api.deleteEvidence([open]); setOpen(null); })}
          >
            Delete this evidence
          </button>
          </section>
        </>
      )}
    </article>
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

export function UsageScreen({ api }: { readonly api: AppApi }) {
  const usage = useAsync(() => api.usage(), [api]);
  return (
    <main className="notebook-page usage-page">
      <header className="page-heading"><div><p className="page-kicker">Local usage record</p><h1>Usage</h1></div><nav aria-label="Usage navigation"><Link to={{ page: "record", reviewId: null }}>My notebook</Link><Link to={{ page: "home" }}>Your lectures</Link></nav></header>
      <ErrorNote error={usage.error} retry={usage.reload} />
      {usage.data === null && usage.error === null && <p className="page-loading" role="status">Opening the usage record...</p>}
      {usage.data && <div className="record-section"><UsageTable summary={usage.data} /></div>}
    </main>
  );
}
