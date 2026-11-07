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
      screen: { kind: "processing", pendingChunks: 2, estimate: null, ready: { topics: ["Pivots"], supportedClaims: 1, covered: [], limits: ["Frame capture stalled."] }, offers: [
        { choice: "prepared_only", label: "Review now", note: "Only prepared material." },
        { choice: "stop_early", label: "Stop early", note: "Keep completed work." },
      ] }, busy: true, onStart() {}, onRetry() {}, api, titles: new Map(),
    }));
    expect(html).toContain("No reliable time estimate yet.");
    expect(html).toContain("Limits of this review");
    expect(html).toContain("Frame capture stalled.");
    expect(html).toContain("Review now");
    expect(html).toContain("Stop early");
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });

  test("record keeps learner, tutor, source and edits distinct and deleted evidence explicit", () => {
    const html = renderToStaticMarkup(createElement(RecordBody, { api, data, run: async () => {} }));
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

  test("empty record explains where future notes come from without implying a saved review", () => {
    const html = renderToStaticMarkup(createElement(RecordBody, { api, data: { notes: [], observations: [], links: [], unavailableEvidence: [] }, run: async () => {} }));
    expect(html).toContain("No saved notes yet");
    expect(html).toContain("review");
    expect(html).toContain("No observations.");
    expect(html).toContain("No suggested links.");
  });
});
