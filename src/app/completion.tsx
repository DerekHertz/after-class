import { useEffect, useRef } from "react";
import type { EvidenceId, ReviewId } from "../shared/ids";
import type { ReviewView } from "../shared/domain";
import type { SessionState } from "./controller";
import { completionOf } from "./completion-view";
import { objectStyle } from "./room-object";
import { Link } from "./ui";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Shown only once the backend reports the review saved. `justSaved` is true when the save finished in this page,
 * so the summary takes focus and scrolls into view then, and not when a saved review is reopened later.
 */
export function CompletionPanel({ view, reviewId, savedSummary, justSaved, onSource }: {
  readonly view: ReviewView;
  readonly reviewId: ReviewId;
  readonly savedSummary: SessionState["savedSummary"];
  readonly justSaved: boolean;
  readonly onSource?: undefined | ((ids: readonly EvidenceId[], label: string, origin: HTMLButtonElement) => void);
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!justSaved) return;
    heading.current?.scrollIntoView({ block: "nearest" });
    heading.current?.focus();
  }, [justSaved]);
  const outcome = completionOf(view);
  return (
    <section className="note review-complete" style={objectStyle("history")} aria-labelledby="review-complete-heading">
      <h2 id="review-complete-heading" ref={heading} tabIndex={-1}>Review saved</h2>
      <p>
        The conversation is finished. Your notes and these results are in your notebook, and you can reread this review here.
        {savedSummary !== null && ` Saved ${plural(savedSummary.notes, "note")} and ${plural(savedSummary.observations, "observation")}.`}
      </p>
      {outcome.observations === 0 && <p className="muted">The tutor saved no observations for this review, so nothing here is assessed.</p>}
      {outcome.groups.map((g) => (
        <div key={g.group} className="review-complete-group" data-outcome={g.group}>
          <h3>{g.heading} ({g.items.length})</h3>
          <ul>
            {g.items.map((item) => (
              <li key={item.key}>
                <strong>{item.label}</strong> <span className="muted">{item.status}</span>
                {item.resolution !== null && <span className="muted">. {item.resolution}.</span>}
                {onSource && item.evidence.length > 0 && (
                  <>
                    {" "}
                    <button type="button" className="citation" onClick={(e) => onSource(item.evidence, `Source for ${item.label}`, e.currentTarget)}>
                      Lecture source · {plural(item.evidence.length, "item")}
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="review-complete-next">
        <h3>Next</h3>
        {outcome.revisit.length > 0 && <p>Next time, start with {outcome.revisit.join(", ")}.</p>}
        {outcome.disputed > 0 && <p>Settle {outcome.disputed === 1 ? "the disputed item" : `the ${outcome.disputed} disputed items`} in your notebook. For each one, you can mark your explanation as supported, choose to revisit it, or leave it disputed for now.</p>}
        <p className="actions"><Link to={{ page: "record", reviewId }}>Open this review in my notebook</Link></p>
      </div>
    </section>
  );
}
