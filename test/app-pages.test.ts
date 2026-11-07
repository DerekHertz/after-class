import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OptionsView } from "../src/app/capture";
import { RecordBody } from "../src/app/record";
import { stableId } from "../src/shared/ids";
import type { AppApi } from "../src/app/api";
import type { RecordView } from "../src/shared/domain";

const api = {} as AppApi;
const ev = stableId("ev", "pages-evidence");
const data: RecordView = {
  notes: [{ id: stableId("note", "pages"), reviewId: stableId("rvw", "pages"), conceptId: stableId("cpt", "pages"), userEdit: "My correction remains separate.", evidence: [ev], generated: [
    { author: "learner", text: "My first explanation.", turnId: null, evidence: [] },
    { author: "tutor", text: "Help from the tutor.", turnId: null, evidence: [] },
    { author: "source", text: "Words from the lecture.", turnId: null, evidence: [ev] },
  ] }],
  observations: [], links: [], unavailableEvidence: [{ kind: "deleted", id: ev, deletedAtMs: 1 }],
};

describe("notebook pages", () => {
  test("a partial processing invitation keeps the estimate honest and the available choices visible", () => {
    const html = renderToStaticMarkup(createElement(OptionsView, {
      screen: { kind: "processing", pendingChunks: 2, estimate: null, ready: { supportedClaims: 1, partial: ["A section is still being prepared."] }, offers: [
        { choice: "prepared_only", label: "Review now", note: "Only prepared material." },
        { choice: "stop_early", label: "Stop early", note: "Keep completed work." },
      ] }, busy: true, onStart() {}, onRetry() {}, api, titles: new Map(),
    }));
    expect(html).toContain("No reliable time estimate yet.");
    expect(html).toContain("This review is partial.");
    expect(html).toContain("Review now");
    expect(html).toContain("Stop early");
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });

  test("record keeps learner, tutor, source and edits distinct and deleted evidence explicit", () => {
    const html = renderToStaticMarkup(createElement(RecordBody, { api, data, lectures: null, run: async () => {}, drafts: new Map(), setDraft: () => {} }));
    expect(html).toContain("My first explanation.");
    expect(html).toContain('class="author-learner"');
    expect(html).toContain('class="author-tutor"');
    expect(html).toContain('class="author-source"');
    expect(html).toContain("Help from the tutor.");
    expect(html).toContain("Words from the lecture.");
    expect(html).toContain("Your edit");
    expect(html).toContain("My correction remains separate.");
    expect(html).toContain("deleted by you");
    expect(html).not.toContain('aria-label="Open source 1"');
  });

  test("an empty notebook explains where notes come from and offers one next step, with no empty sections", () => {
    const html = renderToStaticMarkup(createElement(RecordBody, { api, data: { notes: [], observations: [], links: [], unavailableEvidence: [] }, lectures: [], run: async () => {}, drafts: new Map(), setDraft: () => {} }));
    expect(html).toContain("Your notebook is empty");
    expect(html).toContain("When you save a review");
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain(">Choose a lecture to review</a>");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("observ");
    expect(html).not.toContain("Suggested links");
    expect(html.match(/<h2/g)).toHaveLength(1);
  });
});
