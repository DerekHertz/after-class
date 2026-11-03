import { describe, expect, test } from "bun:test";
import { randomId } from "../src/shared/ids";
import {
  BadRequest, parseIngestBatch, parseLinkDecisionRequest, parseObservationOverrideRequest, parseStartReviewRequest, parseTurnRequest,
} from "../src/shared/wire";

const captureId = randomId("cap");
const base = (clientSeq: number) => ({ clientSeq, wallMs: 1_700_000_000_000 + clientSeq });
const span = { kind: "span", videoId: "QgWz_s7uugE", start: 10, end: 15, rate: 1, tabVisible: true, wallDurationMs: 5000 };
const frame = {
  kind: "frame", videoId: "QgWz_s7uugE", frameId: "f1", mediaS: 12, width: 1280, height: 720,
  trigger: "change_settled", diff: 14.2, jpegBase64: "/9j/4AAQ",
};

describe("parseIngestBatch", () => {
  test("stamps every fact with the branded capture id", () => {
    const parsed = parseIngestBatch({
      captureId,
      facts: [
        { ...base(0), kind: "control", action: "start", reason: "user" },
        { ...base(1), ...span },
        { ...base(2), ...frame },
        { ...base(3), kind: "ad", videoId: "QgWz_s7uugE", atContentS: 15, wallDurationMs: 6000, signals: ["duration_mismatch"] },
      ],
    });
    expect(parsed.captureId).toBe(captureId);
    expect(parsed.facts.map((f) => [f.captureId, f.kind])).toEqual([
      [captureId, "control"], [captureId, "span"], [captureId, "frame"], [captureId, "ad"],
    ]);
  });

  test.each([
    ["a span that does not move forward", { ...base(0), ...span, end: 10 }],
    ["negative media time", { ...base(0), ...span, start: -1 }],
    ["a frame over the 1280 px capture cap", { ...base(0), ...frame, width: 1568 }],
    ["a frame under Jev's 280 px floor", { ...base(0), ...frame, height: 200 }],
    ["an ad with no detection signal", { ...base(0), kind: "ad", videoId: "QgWz_s7uugE", atContentS: 1, wallDurationMs: 1, signals: [] }],
    ["an unknown fact kind", { ...base(0), kind: "telemetry" }],
    ["a malformed video id", { ...base(0), ...span, videoId: "nope" }],
  ])("rejects %s", (_, fact) => {
    expect(() => parseIngestBatch({ captureId, facts: [fact] })).toThrow(BadRequest);
  });

  test("rejects a capture id that is not a cap_ id, and oversized batches", () => {
    expect(() => parseIngestBatch({ captureId: randomId("rvw"), facts: [] })).toThrow(BadRequest);
    const many = Array.from({ length: 501 }, (_, k) => ({ ...base(k), ...span }));
    expect(() => parseIngestBatch({ captureId, facts: many })).toThrow(BadRequest);
  });
});

describe("app requests", () => {
  test("a turn carries an app-minted turn id and a learner act", () => {
    const turnId = randomId("turn");
    expect(parseTurnRequest({ turnId, act: { kind: "answer", text: " rows times columns ", modality: "speech" } })).toEqual({
      turnId, act: { kind: "answer", text: "rows times columns", modality: "speech" },
    });
    expect(parseTurnRequest({ turnId, act: { kind: "detour_wait" } }).act.kind).toBe("detour_wait");
    expect(() => parseTurnRequest({ turnId: randomId("rvw"), act: { kind: "skip" } })).toThrow(BadRequest);
    expect(() => parseTurnRequest({ turnId, act: { kind: "answer", text: "   ", modality: "text" } })).toThrow(BadRequest);
  });

  test("a review start carries an app-minted review id", () => {
    const reviewId = randomId("rvw");
    expect(parseStartReviewRequest({ reviewId, choice: "stop_early" })).toEqual({ reviewId, choice: "stop_early" });
    expect(() => parseStartReviewRequest({ reviewId: "rvw_1", choice: "prepared_only" })).toThrow(BadRequest);
  });

  test("the learner can never record 'disputed' themselves", () => {
    expect(() => parseObservationOverrideRequest({ status: "disputed" })).toThrow(BadRequest);
    expect(parseLinkDecisionRequest({ decision: { corrected: "part_of" } }).decision).toEqual({ corrected: "part_of" });
  });
});
