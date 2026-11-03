import { useState } from "react";
import type { EvidenceId, ReviewId } from "../shared/ids";
import type { LinkDecision, LinkType, Note, ObservationStatus, RecordView, UsageSummary } from "../shared/domain";
import type { AppApi } from "./api";
import { noteView, observationRow, STATUS_LABEL, usageRows } from "./core";
import type { SourceTitles } from "./core";
import { ErrorNote, EvidencePane, Link, useAsync } from "./ui";

const LINK_TYPES: readonly LinkType[] = ["prerequisite_of", "part_of", "example_of", "contrasts_with", "related_to"];
const OVERRIDES: readonly ObservationStatus[] = ["independent", "partial", "after_help", "unresolved", "not_assessed"];
const noTitles: SourceTitles = new Map();

const shortId = (id: string): string => id.slice(0, 10);
const decisionText = (d: LinkDecision): string => (typeof d === "string" ? d : `corrected to ${d.corrected.replaceAll("_", " ")}`);

export function RecordScreen({ api, reviewId }: { readonly api: AppApi; readonly reviewId: ReviewId | null }) {
  const record = useAsync(() => api.record(reviewId === null ? {} : { reviewId }), [api, reviewId]);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setError(null);
    try {
      await action();
      record.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const data = record.data;
  return (
    <main>
      <h1>Saved record</h1>
      <p className="muted">{reviewId === null ? "All reviews." : "This review only."} <Link to={{ page: "usage" }}>Usage</Link></p>
      <ErrorNote error={record.error} retry={record.reload} />
      <ErrorNote error={error} />
      {data && <RecordBody api={api} data={data} run={run} />}
    </main>
  );
}

function RecordBody({ api, data, run }: { readonly api: AppApi; readonly data: RecordView; readonly run: (a: () => Promise<void>) => Promise<void> }) {
  const deleted = new Set<string>(data.unavailableEvidence.map((d) => d.id));
  return (
    <>
      <h2>Notes</h2>
      {data.notes.length === 0 && <p className="muted">No saved notes.</p>}
      {data.notes.map((n) => <NoteCard key={n.id} api={api} note={n} deleted={deleted} run={run} />)}

      <h2>Observations</h2>
      {data.observations.length === 0 && <p className="muted">No observations.</p>}
      <ul>
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

      <h2>Suggested links between concepts</h2>
      {data.links.length === 0 && <p className="muted">No suggested links.</p>}
      <ul>
        {data.links.map((l) => (
          <li key={l.id}>
            {shortId(l.from)} {l.type.replaceAll("_", " ")} {shortId(l.to)} <span className="muted">({decisionText(l.decision)}) {l.rationale}</span>
            <div className="actions">
              <button type="button" onClick={() => void run(() => api.decideLink(l.id, "accepted"))}>Accept</button>
              <button type="button" onClick={() => void run(() => api.decideLink(l.id, "rejected"))}>Reject</button>
              <select value="" onChange={(e) => e.target.value && void run(() => api.decideLink(l.id, { corrected: e.target.value as LinkType }))}>
                <option value="">Correct to...</option>
                {LINK_TYPES.map((t) => <option key={t} value={t}>{t.replaceAll("_", " ")}</option>)}
              </select>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function NoteCard({ api, note, deleted, run }: { readonly api: AppApi; readonly note: Note; readonly deleted: ReadonlySet<string>; readonly run: (a: () => Promise<void>) => Promise<void> }) {
  const view = noteView(note);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(view.userEdit ?? "");
  const [open, setOpen] = useState<EvidenceId | null>(null);
  const cited = [...new Set([...note.evidence, ...view.segments.flatMap((s) => s.evidence)])];

  return (
    <article className="card">
      <h3>Concept {shortId(note.conceptId)}</h3>
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
          <textarea value={draft} rows={4} onChange={(e) => setDraft(e.target.value)} />
          <div className="actions">
            <button type="button" onClick={() => void run(async () => { await api.editNote(note.id, draft); setEditing(false); })}>Save edit</button>
            <button type="button" onClick={() => setEditing(false)}>Cancel</button>
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
              <button key={id} type="button" aria-pressed={open === id} onClick={() => setOpen(open === id ? null : id)}>{i + 1}</button>
            ),
          )}
        </p>
      )}
      {open !== null && (
        <>
          <EvidencePane api={api} ids={[open]} titles={noTitles} />
          <button
            type="button"
            onClick={() => window.confirm("Delete this evidence everywhere? Notes citing it will show it as deleted.") && void run(async () => { await api.deleteEvidence([open]); setOpen(null); })}
          >
            Delete this evidence
          </button>
        </>
      )}
    </article>
  );
}

export function UsageTable({ summary }: { readonly summary: UsageSummary }) {
  return (
    <>
      <p className="muted">Totals are per cost kind and are never added together. Unknown cost stays unknown.</p>
      <table>
        <thead>
          <tr><th>Cost kind</th><th>Calls</th><th>Amount</th></tr>
        </thead>
        <tbody>
          {usageRows(summary).map((r) => (
            <tr key={r.kind}><td>{r.kind}</td><td>{r.calls}</td><td>{r.amount}</td></tr>
          ))}
        </tbody>
      </table>
      <h2>By purpose</h2>
      <table>
        <thead>
          <tr><th>Purpose</th><th>Calls</th><th>Errors</th><th>Cost unknown</th></tr>
        </thead>
        <tbody>
          {Object.entries(summary.byPurpose).filter(([, v]) => v.calls > 0).map(([purpose, v]) => (
            <tr key={purpose}><td>{purpose.replaceAll("_", " ")}</td><td>{v.calls}</td><td>{v.errors}</td><td>{v.unknownCost}</td></tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function UsageScreen({ api }: { readonly api: AppApi }) {
  const usage = useAsync(() => api.usage(), [api]);
  return (
    <main>
      <h1>Usage</h1>
      <ErrorNote error={usage.error} retry={usage.reload} />
      {usage.data && <UsageTable summary={usage.data} />}
    </main>
  );
}
