/** Issue #115: help beside the response, one source panel with labelled lecture and tutor content, a way back to the question. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppApi } from "../src/app/api";
import { availableActions, composerActions, distinctFrames } from "../src/app/core";
import type { ActionId } from "../src/app/core";
import { DiagramPanel } from "../src/app/diagram";
import { Composer } from "../src/app/review";
import { EvidenceGroups } from "../src/app/ui";
import type { SpeechInput } from "../src/app/speech";
import type { Frame, Passage, ReviewState, TopicDiagram } from "../src/shared/domain";
import { stableId } from "../src/shared/ids";
import type { ClaimId, ConceptId, EvidenceId, SourceId } from "../src/shared/ids";
import { media } from "../src/shared/time";

const api = {} as AppApi;
const noop = () => {};
const quiet: SpeechInput = { supported: true, start() {}, stop() {} };
const id = <T,>(kind: string, name: string) => stableId(kind as never, name) as unknown as T;
const SRC = id<SourceId>("src", "s");
const OTHER = id<SourceId>("src", "other");
const P1 = id<EvidenceId>("ev", "p1");
const F1 = id<EvidenceId>("ev", "f1");
const F2 = id<EvidenceId>("ev", "f2");
const F3 = id<EvidenceId>("ev", "f3");
const F4 = id<EvidenceId>("ev", "f4");
const titles = new Map([[SRC, "Locks & deadlocks"]]);

const frame = (fid: EvidenceId, mediaS: number, sourceId = SRC) => ({ kind: "frame", id: fid, sourceId, mediaS: media(mediaS), width: 800, height: 450, teaching: "kept" }) as unknown as Frame;
const passage = { kind: "passage", id: P1, sourceId: SRC, transcriptRevId: "trv", interval: { start: 402, end: 423 }, text: "Each thread holds a lock while waiting for the other.", origin: "panel" } as unknown as Passage;
const groups = (bundle: { passages: readonly Passage[]; frames: readonly Frame[] }, ids: readonly EvidenceId[], shownFrame: TopicDiagram["frame"] = null) =>
  renderToStaticMarkup(createElement(EvidenceGroups, { api, ids, bundle, titles, shownFrame }));
const diagramFrame = { id: F1, mediaS: media(402), sourceId: SRC, videoId: null, title: "Locks & deadlocks" };

describe("a stuck learner can get help without opening a menu", () => {
  const active = availableActions({ phase: "active", detour: { kind: "none" } } as ReviewState, false).filter((a) => !["pause", "end"].includes(a));

  test("Hint and I don't know sit beside Share my thinking; Skip, Explain it and Dispute stay in the menu", () => {
    expect(composerActions(active)).toEqual({ primary: ["answer"], assist: ["dont_know", "hint"], more: ["skip", "explain", "dispute"] });
    const detour: ActionId[] = ["detour_accept", "detour_decline"];
    expect(composerActions(detour)).toEqual({ primary: detour, assist: [], more: [] });
  });

  test("the composer renders both help buttons outside the menu, after Share my thinking, usable with an empty draft", () => {
    const html = renderToStaticMarkup(createElement(Composer, { actions: active, disabled: false, sendError: null, speech: quiet, onSpeaking() {}, send: async () => true }));
    const menu = html.indexOf("<details");
    const share = html.indexOf("Share my thinking");
    for (const label of ["Hint", "I don&#x27;t know"]) {
      const at = html.indexOf(`>${label}</button>`);
      expect(at).toBeGreaterThan(share);
      expect(at).toBeLessThan(menu);
      expect(html).not.toMatch(new RegExp(`disabled=""[^>]*>${label}</button>`));
    }
    const inMenu = html.slice(menu);
    for (const label of ["Skip", "Explain it", "Dispute"]) expect(inMenu).toContain(`>${label}</button>`);
    expect(inMenu).not.toContain(">Hint</button>");
    expect(html).toMatch(/disabled=""[^>]*>Share my thinking/);
    const shareRow = /<div class="actions primary-actions">[\s\S]*?<\/div>/.exec(html)![0];
    expect(shareRow).not.toContain("Hint");
  });

  test("help buttons are disabled while a turn is under way, like Share my thinking", () => {
    const html = renderToStaticMarkup(createElement(Composer, { actions: active, disabled: true, sendError: null, speech: quiet, onSpeaking() {}, send: async () => true }));
    expect(html).toMatch(/disabled=""[^>]*>Hint<\/button>/);
  });
});

describe("one source panel, no indistinguishable duplicate frames", () => {
  test("frames of one source at the same displayed second are drawn once, and the diagram's frame is not drawn again", () => {
    const frames = [frame(F1, 402), frame(F2, 402.6), frame(F3, 480), frame(F4, 402, OTHER)];
    expect(distinctFrames(frames, null).frames.map((f) => f.id)).toEqual([F1, F3, F4]);
    const withDiagram = distinctFrames(frames, diagramFrame);
    expect(withDiagram.frames.map((f) => f.id)).toEqual([F3, F4]);
    expect(withDiagram.alreadyShown).toBe(true);
    expect(distinctFrames([frame(F3, 480)], diagramFrame)).toEqual({ frames: [frame(F3, 480)], alreadyShown: false });
  });

  test("the transcript comes first, then the lecture frame, each labelled with its source and time", () => {
    const html = groups({ passages: [passage], frames: [frame(F1, 402)] }, [P1, F1]);
    expect(html.indexOf("Transcript")).toBeLessThan(html.indexOf("Each thread holds a lock"));
    expect(html).toContain("Locks &amp; deadlocks, 6:42 to 7:03");
    expect(html.indexOf("7:03")).toBeLessThan(html.indexOf("Lecture frame"));
    expect(html).toContain("Captured frame · Locks &amp; deadlocks at 6:42");
  });

  test("with the diagram open, its frame is named instead of drawn a second time", () => {
    const html = groups({ passages: [passage], frames: [frame(F1, 402)] }, [P1, F1], diagramFrame);
    expect(html).not.toContain("Captured frame");
    expect(html).toContain("The frame at 6:42 is shown with the tutor diagram.");
    expect(html).toContain("Each thread holds a lock");
  });

  test("missing evidence says how much is gone and draws no empty group", () => {
    const html = groups({ passages: [], frames: [] }, [P1, F1]);
    expect(html).toContain("2 evidence items are no longer available.");
    expect(html).not.toContain("Transcript");
    expect(html).not.toContain("Lecture frame");
  });

  test("the diagram says it was written by the tutor, not captured from the lecture", () => {
    const topic: TopicDiagram = { topicId: id<ConceptId>("cpt", "t"), label: "Circular wait", claimIds: [id<ClaimId>("clm", "c")], frame: diagramFrame, summary: { state: "preparing" } };
    const html = renderToStaticMarkup(createElement(DiagramPanel, { api, topic, error: null, onRequest: noop, onCite: noop, onClose: noop }));
    expect(html).toContain("Tutor diagram · Circular wait");
    expect(html).toContain("Written by the tutor, not captured from the lecture.");
    expect(html.indexOf("Written by the tutor")).toBeLessThan(html.indexOf("Captured frame"));
  });
});

describe("the source panel reads in the page and leads back to the question", () => {
  const tsx = readFileSync(new URL("../src/app/review.tsx", import.meta.url), "utf8");
  const aside = /<aside[\s\S]*?<\/aside>/.exec(tsx)![0];

  test("the panel ends with a way back to the question, and the composer is never inside the panel", () => {
    expect(aside).toContain("Back to the question");
    expect(aside).not.toContain("<Composer");
    expect(aside.indexOf("<EvidencePane")).toBeLessThan(aside.indexOf("<DiagramPanel"));
    expect(/<EvidencePane[^>]*\bgrouped\b/.test(aside)).toBe(true);
    const back = /function returnToQuestion\(\) \{[\s\S]*?\n  \}/.exec(tsx)![0];
    expect(back).not.toMatch(/setSourceOpen|setSelection|setDiagramTopic/);
  });

  test("every control that closes the panel has the same name", () => {
    expect(aside).not.toContain("Close evidence");
    expect(aside).toContain(">Close source</button>");
  });

  test("the HD source stand takes its natural height, so a cited passage never hides in a second scroll area", () => {
    const hd = readFileSync(new URL("../src/app/hd-room.css", import.meta.url), "utf8");
    const stand = /\.scene-shell\[data-detail="hd-pixel"\] \.review \.source-stand \{[^}]*\}/.exec(hd)![0];
    expect(stand).toContain("max-height: none");
    expect(stand).toContain("overflow: visible");
  });
});
