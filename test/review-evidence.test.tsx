/** Issue #115: help beside the response, one source panel with labelled lecture and tutor content, a way back to the question. */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppApi } from "../src/app/api";
import { availableActions, composerActions, distinctFrames } from "../src/app/core";
import type { ActionId } from "../src/app/core";
import { DiagramPanel } from "../src/app/diagram";
import { Composer } from "../src/app/review";
import { EvidenceGroups } from "../src/app/ui";
import { RoomInspector, returnTarget, sourceButtonLabel } from "../src/app/room-object";
import type { Inspecting } from "../src/app/room-object";
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

describe("the folio and the notebook open over the room, one at a time, only when asked", () => {
  const heading = { current: null };
  const held = (object: Inspecting, children?: string) => renderToStaticMarkup(
    <RoomInspector object={object} headingRef={heading} onPutDown={noop}>{children}</RoomInspector>,
  );

  test("with nothing picked up the dialog is empty, so cited evidence alone never covers the question", () => {
    const html = held(null, "Each thread holds a lock");
    expect(html).toBe('<dialog class="room-object"></dialog>');
  });

  test("the source button says how much the current reply cites, without opening anything", () => {
    expect(sourceButtonLabel(0)).toBe("Open source");
    expect(sourceButtonLabel(1)).toBe("Open source · 1 cited");
    expect(sourceButtonLabel(3)).toBe("Open source · 3 cited");
  });

  test("the folio and the notebook share one dialog and only the held one is shown", () => {
    const source = held("source", "Each thread holds a lock");
    expect(source).toContain('data-object="source"');
    expect(source).toContain(">Lecture evidence</h2>");
    expect(source).toContain(">Close source</button>");
    expect(source).toContain("Each thread holds a lock");
    expect(source).not.toContain("Earlier in this review");
    const history = held("history", "What is a deadlock?");
    expect(history).toContain('data-object="history"');
    expect(history).toContain(">Earlier in this review</h2>");
    expect(history).toContain(">Hide earlier</button>");
    expect(history).not.toContain("Lecture evidence");
  });

  test("each object has one scrolling page, labelled by its heading, between a heading that stays and a way back that stays", () => {
    for (const object of ["source", "history"] as const) {
      const html = held(object, "Body");
      expect(html.match(/role="region"/g)).toHaveLength(1);
      const label = /<h2[^>]*id="([^"]+)"/.exec(html)![1];
      expect(html).toContain(`aria-labelledby="${label}" tabindex="0">Body</div>`);
      expect(html.indexOf("</h2>")).toBeLessThan(html.indexOf(">Body<"));
      expect(html.indexOf(">Body<")).toBeLessThan(html.indexOf(">Back to the question</button>"));
    }
  });

  test("putting an object down returns focus to the control that picked it up, or to the question once that control is gone", () => {
    const button = { isConnected: true, name: "Lecture source · 2 items" };
    const question = { isConnected: true, name: "current question" };
    expect(returnTarget(button, question)).toBe(button);
    expect(returnTarget({ ...button, isConnected: false }, question)).toBe(question);
    expect(returnTarget(null, question)).toBe(question);
  });
});
