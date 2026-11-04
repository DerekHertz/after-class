import { useId, useRef, useState } from "react";
import type { EvidenceId, ReviewId } from "../shared/ids";
import type { LinkDecision, LinkType, Note, ObservationStatus, RecordView, UsageSummary } from "../shared/domain";
import type { AppApi } from "./api";
import { noteView, observationRow, STATUS_LABEL, usageRows } from "./core";
import type { SourceTitles } from "./core";
import { ErrorNote, EvidencePane, Link, useAsync } from "./ui";

import "./pages.css";

const LINK_TYPES: readonly LinkType[] = ["prerequisite_of", "part_of", "example_of", "contrasts_with", "related_to"];
const OVERRIDES: readonly ObservationStatus[] = ["independent", "partial", "after_help", "unresolved", "not_assessed"];
const noTitles: SourceTitles = new Map();

const shortId = (id: string): string => id.slice(0, 10);
const decisionText = (d: LinkDecision): string => (typeof d === "string" ? d : `corrected to ${d.corrected.replaceAll("_", " ")}`);

export function RecordScreen({ api, reviewId }: { readonly api: AppApi; readonly reviewId: ReviewId | null }) {
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

  const data = record.data;
  return (
    <main className="notebook-page record-page">
      <header className="page-heading">
        <div><p className="page-kicker">Kept in your own words</p><h1>My notebook</h1></div>
        <nav aria-label="Notebook navigation"><Link to={{ page: "home" }}>Your lectures</Link> <Link to={{ page: "usage" }}>Usage</Link></nav>
      </header>
      <p className="muted">{reviewId === null ? "Notes from all your saved reviews." : "Notes from this review."} Learner, tutor, and source contributions stay separate.</p>
      {reviewId !== null && <p><Link to={{ page: "review", id: reviewId }}>Return to review</Link> · <Link to={{ page: "record", reviewId: null }}>All notes</Link></p>}
      <ErrorNote error={record.error} retry={record.reload} />
      <ErrorNote error={error} />
      {record.data === null && record.error === null && <p className="page-loading" role="status">Opening your notebook...</p>}
      {saving && <p className="page-loading" role="status">Saving your change...</p>}
      {data && <fieldset className="record-content" disabled={saving} aria-label="Saved learning record"><RecordBody api={api} data={data} run={run} /></fieldset>}
    </main>
  );
}

export function RecordBody({ api, data, run }: { readonly api: AppApi; readonly data: RecordView; readonly run: (a: () => Promise<void>) => Promise<void> }) {
  const deleted = new Set<string>(data.unavailableEvidence.map((d) => d.id));
  return (
    <>
      <section className="record-section" aria-labelledby="record-notes-heading">
      <h2 id="record-notes-heading">Your notes</h2>
      {data.notes.length === 0 && <div className="notebook-empty"><h3>No saved notes yet</h3><p>Your explanations and the help you used will appear here after you save a review.</p><Link to={{ page: "home" }}>Open a lecture capture</Link></div>}
      {data.notes.map((n) => <NoteCard key={n.id} api={api} note={n} deleted={deleted} run={run} />)}
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
        {data.links.map((l) => (
          <li key={l.id}>
            {shortId(l.from)} {l.type.replaceAll("_", " ")} {shortId(l.to)} <span className="muted">({decisionText(l.decision)}) {l.rationale}</span>
            <div className="actions">
              <button type="button" onClick={() => void run(() => api.decideLink(l.id, "accepted"))}>Accept</button>
              <button type="button" onClick={() => void run(() => api.decideLink(l.id, "rejected"))}>Reject</button>
              <select aria-label={`Correct connection ${shortId(l.from)} to ${shortId(l.to)}`} value="" onChange={(e) => e.target.value && void run(() => api.decideLink(l.id, { corrected: e.target.value as LinkType }))}>
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

function NoteCard({ api, note, deleted, run }: { readonly api: AppApi; readonly note: Note; readonly deleted: ReadonlySet<string>; readonly run: (a: () => Promise<void>) => Promise<void> }) {
  const editId = useId();
  const sourceButtons = useRef(new Map<EvidenceId, HTMLButtonElement>());
  const view = noteView(note);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(view.userEdit ?? "");
  const [open, setOpen] = useState<EvidenceId | null>(null);
  const cited = [...new Set([...note.evidence, ...view.segments.flatMap((s) => s.evidence)])];

  function closeSource() {
    if (open !== null) sourceButtons.current.get(open)?.focus();
    setOpen(null);
  }

  return (
    <article className="record-note">
      <header className="record-note-heading"><h3>Review note</h3><Link to={{ page: "review", id: note.reviewId }}>Revisit review</Link></header>
      <p className="note-reference">Concept {shortId(note.conceptId)}</p>
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
          {cited.map((id, i) =>
            deleted.has(id) ? (
              <span key={id} className="muted">[{i + 1}: deleted by you] </span>
            ) : (
              <button key={id} type="button" ref={(element) => { if (element) sourceButtons.current.set(id, element); else sourceButtons.current.delete(id); }} aria-label={`Open source ${i + 1}`} aria-pressed={open === id} onClick={() => setOpen(open === id ? null : id)}>Source {i + 1}</button>
            ),
          )}
        </p>
      )}
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
