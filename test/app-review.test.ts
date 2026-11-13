import { describe, expect, test } from "bun:test";
import { stableId } from "../src/shared/ids";
import type { Seq, Turn } from "../src/shared/domain";
import { conversationLines, currentEvidenceIds, selectedEvidenceIds, questionScrollTop, shouldSubmitAnswer, startLive } from "../src/app/core";

const reviewId = stableId("rvw", "ui");
const threadId = stableId("thr", "ui");
const evidence = stableId("ev", "old source");
const turn = (n: number, move: Extract<Turn, { actor: "tutor" }>["move"]): Turn => ({
  id: stableId("turn", String(n)), reviewId, seq: n as Seq, atMs: n, threadId, actor: "tutor", move, say: "Tutor text",
});

describe("historical source provenance", () => {
  test("a new streamed main question clears automatic evidence without clearing a learner pin", () => {
    const turns = [turn(1, { kind: "explain", threadId, evidence: [evidence] })];
    const live = { ...startLive(stableId("turn", "new main")), move: { kind: "ask_main" as const, threadId, claimIds: [stableId("clm", "new claim")] as const } };
    const automatic = currentEvidenceIds(turns, live);
    expect(automatic).toEqual([]);
    expect(selectedEvidenceIds({ kind: "pinned", ids: [evidence], label: "Earlier explanation" }, automatic)).toEqual([evidence]);
  });
  test("only a move's own evidence becomes its citation", () => {
    const lines = conversationLines([
      turn(1, { kind: "explain", threadId, evidence: [evidence] }),
      turn(2, { kind: "ask_followup", threadId }),
    ]);
    expect(lines[0]!.evidenceIds).toEqual([evidence]);
    expect(lines[1]!.evidenceIds).toEqual([]);
    expect(selectedEvidenceIds({ kind: "pinned", ids: lines[0]!.evidenceIds, label: "Earlier explanation" }, [])).toEqual([evidence]);
    expect(selectedEvidenceIds({ kind: "automatic" }, [])).toEqual([]);
  });
});

describe("answer keyboard shortcut", () => {
  const key = { key: "Enter", ctrlKey: true, metaKey: false, isComposing: false, repeat: false };
  test("requires a modified Enter with available nonempty answer", () => {
    expect(shouldSubmitAnswer(key, true, false, "some thought")).toBe(true);
    expect(shouldSubmitAnswer({ ...key, ctrlKey: false, metaKey: true }, true, false, "a")).toBe(true);
    expect(shouldSubmitAnswer({ ...key, ctrlKey: false }, true, false, "a")).toBe(false);
    expect(shouldSubmitAnswer(key, true, true, "a")).toBe(false);
    expect(shouldSubmitAnswer(key, false, false, "a")).toBe(false);
    expect(shouldSubmitAnswer(key, true, false, "  ")).toBe(false);
  });
  test("composition and held keys never submit", () => {
    expect(shouldSubmitAnswer({ ...key, isComposing: true }, true, false, "a")).toBe(false);
    expect(shouldSubmitAnswer({ ...key, repeat: true }, true, false, "a")).toBe(false);
  });
});

describe("scrolling the board to the tutors question", () => {
  const board = { scrollTop: 0, clientHeight: 300, scrollHeight: 1200 };
  test("a reply that fits the board does not move it", () => {
    expect(questionScrollTop(board, { top: 20, bottom: 220 })).toBeNull();
  });
  test("a reply longer than the board scrolls so its last lines, the question, sit at the bottom", () => {
    expect(questionScrollTop(board, { top: 20, bottom: 900 })).toBe(900 + 12 - 300);
  });
  test("a short reply that starts below the bottom scrolls until it is wholly in view", () => {
    expect(questionScrollTop(board, { top: 400, bottom: 520 })).toBe(520 + 12 - 300);
  });
  test("a long reply whose end is already in view stays put, wherever the learner scrolled", () => {
    expect(questionScrollTop({ ...board, scrollTop: 640 }, { top: 20, bottom: 900 })).toBeNull();
  });
  test("a reply above the visible area is brought back into view", () => {
    expect(questionScrollTop({ ...board, scrollTop: 800 }, { top: 20, bottom: 200 })).toBe(0);
  });
  test("a reply that only just fits shows its first line, and the gap below gives way", () => {
    expect(questionScrollTop(board, { top: 400, bottom: 695 })).toBe(400);
  });
  test("the target never passes the end of the contents of the board", () => {
    expect(questionScrollTop({ scrollTop: 0, clientHeight: 300, scrollHeight: 700 }, { top: 500, bottom: 690 })).toBe(400);
  });
});
