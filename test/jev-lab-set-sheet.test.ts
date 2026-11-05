/**
 * Experiment 2/6's labeling sheet for a SET of clips (label schema 2) and model proposals, offline. The export logic is
 * checked against the lab's own `validateLabels` and `loadLabels`; the generator is run on a capture built on disk, and
 * the page is parsed, never executed here (a real-browser smoke test is a separate manual step, see the experiment doc).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/backend/db";
import { createEvidence } from "../src/backend/evidence";
import type { CaptureFact, CaptureFactBody } from "../src/shared/domain";
import { randomId, stableId } from "../src/shared/ids";
import type { CaptureId, MemoKey } from "../src/shared/ids";
import { media } from "../src/shared/time";
import { VISUAL_STEP_RULE, draftLabelsSet, loadLabels } from "../scripts/jev-lab";
import { makeSplitter, validateLabels } from "../scripts/jev-lab-score";
import type { LabelFileV2 } from "../scripts/jev-lab-score";
import { proposalsAgainstLabels, validateProposals } from "../scripts/jev-lab-proposals";
import type { Proposals } from "../scripts/jev-lab-proposals";
import { generateSheet } from "../scripts/jev-lab-sheet";
import { proposalsLabel } from "../scripts/jev-lab-set-client";
import {
  BOUNDARY_TOLERANCE_S, FRAME_FILE, STEP_TOLERANCE_S, disagreements, evaluate, initialState, labelJson, makeGroup, mergeProposals, modelLabel, removeItem, removeMember, restoreState, setSignature,
  setStatus, toggleMark,
} from "../scripts/jev-lab-set-client";
import type { SetData, SetState } from "../scripts/jev-lab-set-client";

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `afterclass-setsheet-${name}-`));
  cleanup.push(dir);
  return dir;
};

// ───────────────────────────── a hand-made set, with no capture ─────────────────────────────

const V = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd", "eeeeeeeeeee"] as const;
const [A, B, C, D, E] = V;
const SPAN = { start: 0, end: 100 };
const OPUS = "claude-opus-5-5";
const FABLE = "claude-fable-5-1";

const draftSet = (over: Partial<LabelFileV2> = {}): LabelFileV2 => ({
  schemaVersion: 2,
  status: "draft",
  signedOffBy: null,
  signedOffAt: null,
  description: "DRAFT labels. Not Derek's labels until he corrects them and signs off.",
  lecture: { captureId: "cap_x", videos: V.map((videoId, i) => ({ videoId, title: `Clip ${i + 1}`, spanS: i === 1 ? { start: 0.5, end: 100 } : { ...SPAN } })) },
  boundaries: V.slice(1).map((videoId, i) => ({ videoId, mediaS: videoId === B ? 0.5 : 0, note: "candidate clip join", confirmed: false, cue: `start of clip ${i + 2}: the product treats the next clip's first window as the decision point` })),
  visualSteps: [{ videoId: A, mediaS: 50, note: "candidate visual step", confirmed: false, cue: "jpeg size jump" }],
  duplicateGroups: [{ note: "candidate duplicate group", confirmed: false, cue: "byte-identical JPEG files", frames: [{ videoId: A, mediaS: 10, frameId: "ev_1" }, { videoId: C, mediaS: 90, frameId: "ev_2" }] }],
  ...over,
});

type Items = Proposals["items"];
const proposals = (model: string, items: Partial<Items>, captureId = "cap_x"): Proposals => ({
  schemaVersion: 1,
  kind: "label-proposals",
  proposedBy: { model, effort: "high" },
  captureId,
  provenance: "hand-made for a test",
  createdAt: "2026-11-05T00:00:00Z",
  items: { boundaries: [], visualSteps: [], duplicateGroups: [], ...items },
});
const step = (videoId: string, mediaS: number, reason = "slide text changes") => ({ videoId, mediaS, reason });
const bound = (videoId: string, mediaS: number, reason = "new topic", source: "model" | "join" = "model") => ({ videoId, mediaS, reason, source });

const ORDER: readonly string[] = V;

describe("merging proposals and the disagreements between two models", () => {
  test("an item both models proposed is one item with both reasons; an item only one proposed stays that model's alone", () => {
    const opus = proposals(OPUS, { visualSteps: [step(A, 20, "opus reason"), step(B, 30, "only opus")] });
    const fable = proposals(FABLE, { visualSteps: [step(A, 25, "fable reason"), step(C, 40, "only fable")] });
    const merged = mergeProposals([opus, fable], ORDER);
    expect(merged.visualSteps.map((m) => [m.videoId, m.mediaS, m.proposers.map((p) => p.label)])).toEqual([
      [A, 20, ["Opus", "Fable"]],
      [B, 30, ["Opus"]],
      [C, 40, ["Fable"]],
    ]);
    expect(merged.visualSteps[0]!.proposers.map((p) => p.reason)).toEqual(["opus reason", "fable reason"]);
  });

  test("the step tolerance is 10 s and inclusive; the boundary tolerance is 60 s and inclusive", () => {
    expect(STEP_TOLERANCE_S).toBe(10);
    expect(BOUNDARY_TOLERANCE_S).toBe(60);
    const steps = (gap: number) => mergeProposals([proposals(OPUS, { visualSteps: [step(A, 20)] }), proposals(FABLE, { visualSteps: [step(A, 20 + gap)] })], ORDER).visualSteps.length;
    expect(steps(10)).toBe(1);
    expect(steps(-10)).toBe(1);
    expect(steps(10.001)).toBe(2);
    expect(steps(0)).toBe(1);
    const bounds = (gap: number) => mergeProposals([proposals(OPUS, { boundaries: [bound(A, 20)] }), proposals(FABLE, { boundaries: [bound(A, 20 + gap)] })], ORDER).boundaries.length;
    expect(bounds(60)).toBe(1);
    expect(bounds(60.001)).toBe(2);
    expect(bounds(11)).toBe(1);
  });

  test("items in different clips never pair, however close their times", () => {
    const m = mergeProposals([proposals(OPUS, { visualSteps: [step(A, 20)] }), proposals(FABLE, { visualSteps: [step(B, 20)] })], ORDER);
    expect(m.visualSteps).toHaveLength(2);
  });

  test("pairing is one to one and takes the closest pair first", () => {
    const m = mergeProposals([proposals(OPUS, { visualSteps: [step(A, 20), step(A, 28)] }), proposals(FABLE, { visualSteps: [step(A, 26)] })], ORDER);
    // 28 is closest to 26 (gap 2); 20 is 6 away but the fable item is used, so 20 stays alone.
    expect(m.visualSteps.map((x) => [x.mediaS, x.proposers.length])).toEqual([[20, 1], [26, 2]]);
  });

  test("duplicate groups are the same when they share two frames, and the merged group is the union", () => {
    const f = (videoId: string, frameId: string, mediaS: number) => ({ videoId, frameId, mediaS });
    const opus = proposals(OPUS, { duplicateGroups: [{ frames: [f(A, "f1", 5), f(B, "f2", 6)], reason: "same slide" }, { frames: [f(C, "f3", 7), f(C, "f4", 9)], reason: "other" }] });
    const fable = proposals(FABLE, { duplicateGroups: [{ frames: [f(A, "f1", 5), f(B, "f2", 6), f(D, "f5", 8)], reason: "same slide again" }, { frames: [f(C, "f3", 7), f(E, "f6", 3)], reason: "one shared frame only" }] });
    const m = mergeProposals([opus, fable], ORDER);
    expect(m.groups.map((g) => [g.frames.map((x) => x.frameId), g.proposers.length])).toEqual([
      [["f1", "f2", "f5"], 2],
      [["f3", "f4"], 1],
      [["f3", "f6"], 1],
    ]);
  });

  test("agreement is read off the state: both, only one model, nothing to compare with one file, nothing for draft candidates", () => {
    const opus = proposals(OPUS, { boundaries: [bound(A, 30)], visualSteps: [step(B, 20), step(B, 70)] });
    const fable = proposals(FABLE, { boundaries: [bound(A, 80)], visualSteps: [step(B, 22)] });
    const two = disagreements(initialState(draftSet(), [opus, fable]), 2);
    expect(two.comparable).toBe(true);
    const by = (key: string) => two.entries.filter((e) => e.key === key).map((e) => [e.videoId, e.mediaS, e.agreement, e.by]);
    expect(by("boundaries")).toEqual([[A, 30, "both", ["Opus", "Fable"]]]);
    expect(by("visualSteps")).toEqual([[B, 20, "both", ["Opus", "Fable"]], [B, 70, "only", ["Opus"]]]);
    expect(two.entries.some((e) => e.key === "boundaries" && e.videoId === C)).toBe(false);
    const one = disagreements(initialState(draftSet(), [opus]), 1);
    expect(one.comparable).toBe(false);
    expect(one.entries.every((e) => e.agreement === "only")).toBe(true);
    expect(disagreements(initialState(draftSet(), []), 0).entries).toEqual([]);
  });

  test("a model proposal at exactly a draft candidate's place is attached to it, and a join proposal does not add a second item", () => {
    const opus = proposals(OPUS, { boundaries: [bound(C, 0, "the next clip starts a new topic", "join")], visualSteps: [step(A, 50, "same place as the draft step")] });
    const s = initialState(draftSet(), [opus]);
    expect(s.boundaries.filter((b) => b.videoId === C)).toHaveLength(1);
    expect(s.boundaries.find((b) => b.videoId === C)!.proposers[0]!.source).toBe("join");
    expect(s.visualSteps).toHaveLength(1);
    expect(s.visualSteps[0]!.origin).toBe("draft");
    expect(s.visualSteps[0]!.proposers).toHaveLength(1);
  });

  test("model names: Opus, Fable, or the raw id", () => {
    expect(modelLabel(OPUS)).toBe("Opus");
    expect(modelLabel(FABLE)).toBe("Fable");
    expect(modelLabel("gpt-x")).toBe("gpt-x");
  });

  test("more than two proposal files are refused", () => {
    expect(() => mergeProposals([proposals("a", {}), proposals("b", {}), proposals("c", {})], ORDER)).toThrow("at most two");
  });
});

describe("no proposal is ever pre-confirmed", () => {
  const rich = [
    proposals(OPUS, { boundaries: [bound(A, 30), bound(C, 0, "join", "join")], visualSteps: [step(A, 20), step(A, 50)], duplicateGroups: [{ frames: [{ videoId: A, mediaS: 10, frameId: "ev_1" }, { videoId: C, mediaS: 90, frameId: "ev_2" }], reason: "same slide" }] }),
    proposals(FABLE, { boundaries: [bound(A, 35)], visualSteps: [step(A, 24)] }),
  ];

  test("every item that carries a proposal starts unconfirmed, and an untouched export says confirmed: false for all of them", () => {
    const d = draftSet();
    const s = initialState(d, rich);
    const proposed = [...s.boundaries, ...s.visualSteps, ...s.groups].filter((x) => x.proposers.length > 0);
    expect(proposed.length).toBeGreaterThan(4);
    expect(proposed.every((x) => x.status === "unconfirmed")).toBe(true);
    const out = evaluate(s, d);
    expect(out.labels.status).toBe("draft");
    for (const it of [...out.labels.boundaries, ...out.labels.visualSteps, ...out.labels.duplicateGroups]) expect(it.confirmed).toBe(false);
    expect(out.blockers.filter((b) => b.code === "unconfirmed").length).toBe([...s.boundaries, ...s.visualSteps, ...s.groups].length);
  });

  test("a proposal is confirmed only by an action on it, and only that item", () => {
    const d = draftSet();
    const s0 = initialState(d, rich);
    const target = s0.visualSteps.find((x) => x.origin === "proposal")!;
    const s1 = setStatus(s0, "visualSteps", target.id, "confirmed");
    expect(s1.visualSteps.filter((x) => x.status === "confirmed").map((x) => x.id)).toEqual([target.id]);
    expect(evaluate(s1, d).labels.visualSteps.filter((x) => x.confirmed)).toHaveLength(1);
  });

  test("the exported cue records who proposed a confirmed item and why; an item Derek added has no cue", () => {
    const d = draftSet();
    let s = initialState(d, rich);
    const both = s.visualSteps.find((x) => x.proposers.length === 2)!;
    s = setStatus(s, "visualSteps", both.id, "confirmed");
    s = toggleMark(s, "visualSteps", B, 33, ORDER);
    s = setSignature(s, "Derek", "2026-11-05");
    const out = evaluate(s, d).labels;
    const cue = out.visualSteps.find((x) => x.mediaS === both.mediaS)!.cue!;
    expect(cue).toContain(`proposed by ${OPUS}: slide text changes`);
    expect(cue).toContain(`proposed by ${FABLE}: slide text changes`);
    expect(out.visualSteps.find((x) => x.videoId === B && x.mediaS === 33)).toEqual({ videoId: B, mediaS: 33, note: "", confirmed: true });
  });
});

// ───────────────────────────── the export against the lab's own validator ─────────────────────────────

const valid = (labels: LabelFileV2) => {
  const r = validateLabels(JSON.parse(labelJson(labels)));
  expect(r.ok ? [] : r.errors).toEqual([]);
};

const confirmAll = (s: SetState): SetState => {
  let out = s;
  for (const m of s.boundaries) out = setStatus(out, "boundaries", m.id, "confirmed");
  for (const m of s.visualSteps) out = setStatus(out, "visualSteps", m.id, "confirmed");
  for (const g of s.groups) out = setStatus(out, "groups", g.id, "confirmed");
  return out;
};

describe("export logic for schema 2", () => {
  test("a draft with unconfirmed items stays a draft with null name and date, and validates", () => {
    const d = draftSet();
    const out = evaluate(initialState(d), d);
    expect(out.labels.status).toBe("draft");
    expect(out.labels.signedOffBy).toBeNull();
    expect(out.labels.signedOffAt).toBeNull();
    expect(out.labels.lecture.videos.map((v) => v.videoId)).toEqual([...V]);
    expect(out.blockers.filter((b) => b.code === "unconfirmed")).toHaveLength(6);
    valid(out.labels);
  });

  test("everything confirmed plus a typed name and an ISO date becomes signed_off and loads through loadLabels", () => {
    const d = draftSet();
    const out = evaluate(setSignature(confirmAll(initialState(d)), "  Derek Hertzell ", "2026-11-05"), d);
    expect(out.blockers).toEqual([]);
    expect(out.labels.status).toBe("signed_off");
    expect(out.labels.signedOffBy).toBe("Derek Hertzell");
    valid(out.labels);
    const file = join(tmp("signed"), "labels-set.json");
    writeFileSync(file, labelJson(out.labels));
    const loaded = loadLabels([file])[0]!.labels;
    expect(loaded.schemaVersion).toBe(2);
    expect(loaded.status).toBe("signed_off");
  });

  test("nothing is pre-filled: the name and date start empty whatever the draft says", () => {
    const d = draftSet({ status: "signed_off", signedOffBy: "Someone", signedOffAt: "2026-01-01" });
    expect(initialState(d).signedOffBy).toBe("");
    expect(initialState(d).signedOffAt).toBe("");
  });

  test("a missing name, a missing date and a bad date each block the sign-off", () => {
    const d = draftSet();
    const all = confirmAll(initialState(d));
    expect(evaluate(all, d).blockers.map((b) => b.code).sort()).toEqual(["date", "name"]);
    expect(evaluate(setSignature(all, "Derek", ""), d).blockers.map((b) => b.code)).toEqual(["date"]);
    const bad = evaluate(setSignature(all, "Derek", "next tuesday"), d);
    expect(bad.labels.status).toBe("draft");
    valid(bad.labels);
  });

  test("a time outside its own clip's half-open span is a blocker and is left out so the file still validates", () => {
    const d = draftSet();
    let s = confirmAll(initialState(d));
    s = toggleMark(s, "boundaries", A, 100, ORDER); // A's span is [0, 100)
    s = toggleMark(s, "visualSteps", B, 0.25, ORDER); // B's span starts at 0.5
    s = toggleMark(s, "visualSteps", C, 99.9, ORDER); // inside C
    const out = evaluate(setSignature(s, "Derek", "2026-11-05"), d);
    expect(out.blockers.filter((b) => b.code === "outside_span")).toHaveLength(2);
    expect(out.labels.status).toBe("draft");
    expect(out.labels.boundaries.some((b) => b.mediaS === 100)).toBe(false);
    expect(out.labels.visualSteps.map((x) => [x.videoId, x.mediaS])).toContainEqual([C, 99.9]);
    valid(out.labels);
  });

  test("a video that is not one of the clips is a blocker and is left out", () => {
    const d = draftSet();
    const s = setSignature(confirmAll(toggleMark(initialState(d), "boundaries", "zzzzzzzzzzz", 5, ORDER)), "Derek", "2026-11-05");
    const out = evaluate(s, d);
    expect(out.blockers.map((b) => b.code)).toEqual(["unknown_video"]);
    expect(out.labels.boundaries.some((b) => b.videoId === "zzzzzzzzzzz")).toBe(false);
    valid(out.labels);
  });

  test("a duplicate group of one frame, or of one frame twice, is a blocker and is left out; a group across clips is fine", () => {
    const d = draftSet();
    const one = removeMember(confirmAll(initialState(d)), "dg0", 1);
    const out = evaluate(setSignature(one, "Derek", "2026-11-05"), d);
    expect(out.blockers.map((b) => b.code)).toEqual(["group_size"]);
    expect(out.labels.duplicateGroups).toEqual([]);
    valid(out.labels);

    const base = initialState(d);
    expect(makeGroup(base, [{ videoId: A, mediaS: 5, frameId: "x" }, { videoId: A, mediaS: 5, frameId: "x" }], ORDER)).toBe(base);
    const twice: SetState = { ...base, groups: [{ ...base.groups[0]!, frames: [{ videoId: A, mediaS: 10, frameId: "ev_1" }, { videoId: A, mediaS: 10, frameId: "ev_1" }] }] };
    expect(evaluate(twice, d).blockers.map((b) => b.code)).toContain("group_size");

    const cross = makeGroup(base, [{ videoId: D, mediaS: 7, frameId: "d1" }, { videoId: B, mediaS: 20, frameId: "b1" }], ORDER);
    const made = cross.groups.at(-1)!;
    expect(made.frames.map((f) => f.videoId)).toEqual([B, D]);
    const exported = evaluate(setSignature(confirmAll(cross), "Derek", "2026-11-05"), d);
    expect(exported.blockers).toEqual([]);
    valid(exported.labels);
  });

  test("items come out in watch order: clip order first, then media time", () => {
    const d = draftSet();
    let s = confirmAll(initialState(d));
    s = toggleMark(s, "boundaries", E, 3, ORDER);
    s = toggleMark(s, "boundaries", A, 90, ORDER);
    s = toggleMark(s, "boundaries", C, 50, ORDER);
    const out = evaluate(setSignature(s, "Derek", "2026-11-05"), d).labels;
    const idx = (v: string) => V.indexOf(v as (typeof V)[number]);
    const places = out.boundaries.map((b) => idx(b.videoId) * 1000 + b.mediaS);
    expect(places).toEqual([...places].sort((x, y) => x - y));
  });

  test("a boundary at the start of the first clip draws a warning, not a blocker", () => {
    const d = draftSet();
    const s = setSignature(confirmAll(toggleMark(initialState(d), "boundaries", A, 0, ORDER)), "Derek", "2026-11-05");
    const out = evaluate(s, d);
    expect(out.blockers).toEqual([]);
    expect(out.warnings.join(" ")).toContain("first clip");
  });

  test("rejecting an item leaves it out of the file and the blockers; removing a user item deletes it", () => {
    const d = draftSet();
    let s = confirmAll(initialState(d));
    s = setStatus(s, "boundaries", "db0", "rejected");
    s = toggleMark(s, "visualSteps", D, 12, ORDER);
    const added = s.visualSteps.find((m) => m.videoId === D)!;
    expect(removeItem(s, "visualSteps", added.id).visualSteps.some((m) => m.videoId === D)).toBe(false);
    const out = evaluate(setSignature(s, "Derek", "2026-11-05"), d);
    expect(out.labels.boundaries.some((b) => b.videoId === B)).toBe(false);
    expect(out.labels.status).toBe("signed_off");
  });

  test("saved state round-trips, and anything that is not the exact shape is refused", () => {
    const d = draftSet();
    const s = setStatus(initialState(d, [proposals(OPUS, { visualSteps: [step(B, 20, "r")] })]), "visualSteps", "dv0", "confirmed");
    expect(restoreState(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(restoreState(null)).toBeNull();
    expect(restoreState({ ...s, nextId: "3" })).toBeNull();
    expect(restoreState({ ...s, boundaries: [{ ...s.boundaries[0]!, videoId: 7 }] })).toBeNull();
    expect(restoreState({ ...s, visualSteps: [{ ...s.visualSteps[0]!, proposers: [{ key: 1 }] }] })).toBeNull();
    expect(restoreState({ ...s, groups: [{ ...s.groups[0]!, origin: "robot" }] })).toBeNull();
  });

  test("any mix of actions leaves a file that validates, signed_off exactly when nothing blocks, and loadLabels agrees", () => {
    const d = draftSet();
    const props = [
      proposals(OPUS, { boundaries: [bound(A, 30), bound(D, 0, "join", "join")], visualSteps: [step(A, 20), step(C, 60)], duplicateGroups: [{ frames: [{ videoId: B, mediaS: 5, frameId: "b1" }, { videoId: E, mediaS: 8, frameId: "e1" }], reason: "same slide" }] }),
      proposals(FABLE, { boundaries: [bound(A, 70)], visualSteps: [step(A, 25), step(E, 1)] }),
    ];
    let seed = 987654;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const videos = [...V, "zzzzzzzzzzz"];
    const times = [-3, 0, 0.5, 20, 33.25, 50, 99.9, 100, 140];
    const statuses = ["unconfirmed", "confirmed", "rejected"] as const;
    let signedRounds = 0;
    for (let round = 0; round < 300; round++) {
      let s = initialState(d, props);
      for (let n = 0; n < 10; n++) {
        const v = videos[rnd(videos.length)]!;
        const t = times[rnd(times.length)]!;
        const all = [...s.boundaries.map((x) => ["boundaries", x.id] as const), ...s.visualSteps.map((x) => ["visualSteps", x.id] as const), ...s.groups.map((x) => ["groups", x.id] as const)];
        const pick = all[rnd(all.length)]!;
        switch (rnd(9)) {
          case 0: s = toggleMark(s, "boundaries", v, t, ORDER); break;
          case 1: s = toggleMark(s, "visualSteps", v, t, ORDER); break;
          case 2: s = confirmAll(s); break;
          case 3: s = setStatus(s, pick[0], pick[1], statuses[rnd(3)]!); break;
          case 4: s = removeMember(s, s.groups[rnd(s.groups.length)]!.id, rnd(3)); break;
          case 5: s = makeGroup(s, [{ videoId: v, mediaS: t }, { videoId: videos[rnd(videos.length)]!, mediaS: times[rnd(times.length)]! }], ORDER); break;
          case 6: s = setSignature(s, ["", "Derek"][rnd(2)]!, ["", "2026-11-05", "junk", "2026-13-45"][rnd(4)]!); break;
          case 7: s = removeItem(s, pick[0], pick[1]); break;
          default: s = confirmAll(setSignature(s, "Derek", "2026-11-05"));
        }
      }
      const out = evaluate(s, d);
      const checked = validateLabels(JSON.parse(labelJson(out.labels)));
      expect(checked.ok ? [] : checked.errors).toEqual([]);
      expect(out.labels.status === "signed_off").toBe(out.blockers.length === 0);
      expect(restoreState(JSON.parse(JSON.stringify(s)))).toEqual(s);
      if (out.labels.status === "signed_off") {
        signedRounds++;
        expect([...out.labels.boundaries, ...out.labels.visualSteps, ...out.labels.duplicateGroups].every((x) => x.confirmed)).toBe(true);
      }
      if (round % 20 === 0) {
        const file = join(tmp("rnd"), "labels.json");
        writeFileSync(file, labelJson(out.labels));
        expect(loadLabels([file])[0]!.labels.status).toBe(out.labels.status);
      }
    }
    expect(signedRounds).toBeGreaterThan(10);
  });
});

describe("proposals files", () => {
  test("a proposal for a video, a time or a capture that is not in the label file's set is an error naming it", () => {
    const d = draftSet();
    const errs = proposalsAgainstLabels(
      proposals(OPUS, { boundaries: [bound("zzzzzzzzzzz", 5)], visualSteps: [step(A, 100), step(B, 0.25)], duplicateGroups: [{ frames: [{ videoId: A, mediaS: 1, frameId: "nope" }, { videoId: C, mediaS: 2 }], reason: "r" }] }, "cap_other"),
      d,
      (v) => (v === A ? new Set(["ev_1"]) : null),
    );
    expect(errs.join("\n")).toContain("capture cap_other");
    expect(errs.join("\n")).toContain("video zzzzzzzzzzz is not one of the label file's clips");
    expect(errs.join("\n")).toContain("100 s lies outside the labeled span [0, 100) of video aaaaaaaaaaa");
    expect(errs.join("\n")).toContain("0.25 s lies outside the labeled span [0.5, 100)");
    expect(errs.join("\n")).toContain("frame nope is not a frame of video aaaaaaaaaaa");
    expect(proposalsAgainstLabels(proposals(OPUS, { boundaries: [bound(B, 0.5)] }), d)).toEqual([]);
  });

  test("validateProposals lists every problem and refuses a misspelled field", () => {
    const good = proposals(OPUS, { boundaries: [bound(A, 5)] });
    expect(validateProposals(good).ok).toBe(true);
    const bad = validateProposals({ ...good, kind: "other", extra: 1, items: { boundaries: [{ videoId: A, mediaS: -1, reason: "", source: "x" }], visualSteps: [], duplicateGroups: [{ frames: [{ videoId: A, mediaS: 1 }], reason: "r" }] } });
    expect(bad.ok).toBe(false);
    const text = bad.ok ? "" : bad.errors.join("\n");
    for (const needle of ["kind:", "proposals.extra: unknown field", "items.boundaries[0].mediaS", "items.boundaries[0].reason", "items.boundaries[0].source", "frames: expected at least 2"]) expect(text).toContain(needle);
  });
});

// ───────────────────────────── the generator on a capture on disk ─────────────────────────────

const IMG_PAYLOAD = `<img src=x onerror="window.__pwned=1">`;
const SCRIPT_PAYLOAD = `</script><script>window.__pwned=2</script><!--`;
const SEPARATORS = "line\u2028sep\u2029end";
const EVIL_TITLE = `Evil </title><script>window.__pwned=0</script> & "quotes"`;

/** A JPEG-ish blob; the byte tag makes frames distinguishable, equal tags make byte-identical frames (a duplicate candidate). */
const jpeg = (n: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, n, n + 1, n + 2, 4]);

type Clip = { readonly videoId: string; readonly len: number; readonly frames: readonly { readonly id: string; readonly at: number; readonly tag: number }[] };
const FIVE: readonly Clip[] = [
  { videoId: A, len: 60, frames: [{ id: "a1", at: 5, tag: 1 }, { id: "a2", at: 30, tag: 9 }] },
  { videoId: B, len: 70, frames: [{ id: "b1", at: 4, tag: 1 }, { id: "b2", at: 40, tag: 17 }] },
  { videoId: C, len: 80, frames: [{ id: "c1", at: 10, tag: 25 }] },
  { videoId: D, len: 90, frames: [{ id: "d1", at: 20, tag: 33 }, { id: "d2", at: 60, tag: 41 }] },
  { videoId: E, len: 50, frames: [{ id: "e1", at: 8, tag: 9 }] },
];

function makeCapture(clips: readonly Clip[]) {
  const dir = tmp("data");
  const db = openDb(join(dir, "afterclass.sqlite"));
  const keyOf = (input: { readonly after: { readonly frame: { readonly id: string } } }): MemoKey => stableId("key", "frame_change", input.after.frame.id);
  const evidence = createEvidence(db, dir, { lookupFrameChange: (i) => ({ kind: "missing", key: keyOf(i) }), runFrameChange: async () => undefined, frameChangeKey: keyOf, onChange: () => {} });
  const captureId = randomId("cap");
  const bodies: CaptureFactBody[] = [{ kind: "control", action: "start", reason: "user" }];
  clips.forEach((c, n) => {
    const segments = [];
    for (let t = 0; t < c.len; t += 10) segments.push({ start: media(t), end: media(Math.min(c.len, t + 10)), text: t === 10 && n === 0 ? IMG_PAYLOAD : t === 20 && n === 1 ? SCRIPT_PAYLOAD : t === 30 && n === 2 ? SEPARATORS : `caption ${c.videoId} ${t}` });
    bodies.push(
      { kind: "source", videoId: c.videoId, title: n === 0 ? EVIL_TITLE : `Clip ${n + 1}`, channelName: "Prof", url: `https://www.youtube.com/watch?v=${c.videoId}`, durationS: c.len },
      { kind: "transcript", videoId: c.videoId, origin: "panel", language: "en", autoGenerated: false, segments },
      { kind: "span", videoId: c.videoId, start: media(0), end: media(c.len), rate: 1, tabVisible: true, wallDurationMs: c.len * 1000 },
      ...c.frames.map((f): CaptureFactBody => ({ kind: "frame", videoId: c.videoId, frameId: f.id, mediaS: media(f.at), width: 640, height: 360, trigger: "change_settled", diff: 0.4, jpegBase64: jpeg(f.tag).toString("base64") })),
    );
  });
  bodies.push({ kind: "control", action: "stop", reason: "user" });
  evidence.ingest({ captureId: captureId as CaptureId, facts: bodies.map((b, i) => ({ captureId, clientSeq: i, wallMs: 1000 + i, ...b }) as CaptureFact) });
  db.close();
  return { dir, captureId };
}

function setFixture(clips: readonly Clip[] = FIVE) {
  const { dir, captureId } = makeCapture(clips);
  const labelsFile = join(tmp("labels"), "draft-set.json");
  draftLabelsSet({ dataDir: dir, captureId, outPath: labelsFile });
  const labels = JSON.parse(readFileSync(labelsFile, "utf8")) as LabelFileV2;
  return { dir, captureId, labelsFile, labels, out: join(tmp("out"), "sheet") };
}

function writeProposals(p: Proposals, name = `${p.proposedBy.model}.json`): string {
  const file = join(tmp("props"), name);
  writeFileSync(file, JSON.stringify(p, null, 2));
  return file;
}

function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[p.slice(root.length)] = new Bun.CryptoHasher("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(root);
  return out;
}

const dataOf = (html: string): { readonly body: string; readonly parsed: SetData } => {
  const open = html.indexOf('<script type="application/json" id="sheet-data">');
  expect(open).toBeGreaterThan(-1);
  const start = html.indexOf(">", open) + 1;
  const body = html.slice(start, html.indexOf("</script", start));
  return { body, parsed: JSON.parse(body) as SetData };
};

describe("the set sheet generator", () => {
  test("writes one self-contained page for a fabricated 5-clip capture, with its frames as files next to it", async () => {
    const { dir, captureId, labelsFile, out } = setFixture();
    const done = await generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: out });
    expect(readdirSync(out).sort()).toEqual(["frames", "index.html"]);
    expect(done.files.map((f) => f.path)).toEqual([join(out, "index.html")]);
    const html = readFileSync(join(out, "index.html"), "utf8");
    const { parsed } = dataOf(html);
    expect(parsed.draft.lecture.captureId).toBe(captureId);
    expect(parsed.clips.map((c) => c.videoId)).toEqual([...V]);
    expect(parsed.clips.map((c) => c.frames.length)).toEqual([2, 2, 1, 2, 1]);
    expect(parsed.clips.every((c) => c.passages.length > 0)).toBe(true);
    for (const c of parsed.clips) for (const f of c.frames) {
      expect(FRAME_FILE.test(f.file)).toBe(true);
      expect(existsSync(join(out, f.file))).toBe(true);
    }
    expect(new Set(readdirSync(join(out, "frames")))).toEqual(new Set(parsed.clips.flatMap((c) => c.frames.map((f) => f.file.slice("frames/".length)))));
    // the page holds no image data of its own: frames are files, so the page stays small
    expect(html).not.toContain("data:image");
    expect(readFileSync(join(out, parsed.clips[0]!.frames[0]!.file)).equals(jpeg(1))).toBe(true);
  });

  test("the split in the page is the lab's own: the join nearest the watched midpoint, with tuning and held-out clips marked", async () => {
    const { dir, labelsFile, out } = setFixture();
    await generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: out });
    const { parsed } = dataOf(readFileSync(join(out, "index.html"), "utf8"));
    const expected = makeSplitter(FIVE.map((c) => ({ videoId: c.videoId, spanS: { start: 0, end: c.len }, watchedS: c.len })));
    expect(parsed.split.kind).toBe("join");
    expect(parsed.split.joinIndex).toBe(expected.joinIndex);
    expect(parsed.split.totalS).toBe(expected.totalS);
    expect(parsed.clips.map((c) => c.half)).toEqual(FIVE.map((c) => expected.halfOf(c.videoId, 0) ?? "first"));
    expect(parsed.clips.some((c) => c.half === "first") && parsed.clips.some((c) => c.half === "second")).toBe(true);
  });

  test("Derek's visual-step rule is on the page verbatim, and the page keeps the clip-join and split explanations", async () => {
    const { dir, labelsFile, out } = setFixture();
    await generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: out });
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toContain(VISUAL_STEP_RULE);
    for (const needle of ["Tuning half", "Held-out half", "scores these clips once", "next clip's first window decides", "Show only disagreements", "Boundary at this join"]) expect(html).toContain(needle);
  });

  test("escaping: a hostile transcript line, title and proposal reason cannot leave the data tag, and the only markup is the generator's", async () => {
    const { dir, captureId, labelsFile, out } = setFixture();
    const evil = `${IMG_PAYLOAD}${SCRIPT_PAYLOAD}${SEPARATORS}`;
    const opus = writeProposals(proposals(OPUS, { visualSteps: [step(A, 30, evil)], boundaries: [bound(B, 20, evil, "model")] }, captureId));
    const fable = writeProposals(proposals(FABLE, { visualSteps: [step(A, 33, `second: ${evil}`)] }, captureId));
    await generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: out, proposalFiles: [opus, fable] });
    const html = readFileSync(join(out, "index.html"), "utf8");
    const { body, parsed } = dataOf(html);
    expect(body).not.toMatch(/<|\u2028|\u2029/);
    const texts = parsed.clips.flatMap((c) => c.passages.map((p) => p.text));
    expect(texts).toContain(IMG_PAYLOAD);
    expect(texts).toContain(SCRIPT_PAYLOAD);
    expect(texts.some((t) => t.includes(SEPARATORS))).toBe(true);
    expect(parsed.proposals[0]!.items.visualSteps[0]!.reason).toBe(evil);
    expect(parsed.proposals[1]!.items.visualSteps[0]!.reason).toBe(`second: ${evil}`);
    expect(parsed.clips[0]!.title).toBe(EVIL_TITLE);

    expect((html.match(/<script\b/gi) ?? [])).toHaveLength(2);
    const outside = html.replace(body, "");
    for (const bad of ["<img src=x", "<script>window", "</title><script", "window.__pwned"]) expect(outside).not.toContain(bad);
    expect(html.match(/<title>[^<]*<\/title>/)![0]).not.toContain("<script");
    expect(html.replace(/<script[\s\S]*?<\/script>/g, "")).not.toMatch(/<[a-z][^>]*\son\w+\s*=/i);
  });

  test("the page script sets captured text with textContent only: no innerHTML, outerHTML, insertAdjacentHTML, document.write or eval", async () => {
    const { dir, labelsFile, out } = setFixture();
    await generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: out });
    const html = readFileSync(join(out, "index.html"), "utf8");
    const script = html.slice(html.lastIndexOf("<script>"));
    expect(script).not.toMatch(/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|srcdoc/);
  });

  test("a strict Content-Security-Policy and no network reference: images only from the page's own folder, no fetch, socket or import", async () => {
    const { dir, labelsFile, out } = setFixture();
    await generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: out });
    const html = readFileSync(join(out, "index.html"), "utf8");
    const policy = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)![1]!;
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("img-src 'self';");
    expect(policy).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(policy).toMatch(/style-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(policy).not.toMatch(/connect-src|https?:|data:|blob:|unsafe-/);
    const { body } = dataOf(html);
    const code = html.replace(body, "");
    const urls = code.match(/(?:https?|wss?|ftp):\/\/[^\s"'`)<>]*/gi) ?? [];
    expect(urls.filter((u) => !u.startsWith("https://www.youtube.com/watch?v="))).toEqual([]);
    expect(code).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|importScripts|\bimport\s*\(|<link\b|<iframe\b|@import|url\(/);
    // the one place the page builds a link: the exact YouTube watch URL, from a video id checked against the 11-character pattern
    expect(code).toContain("https://www.youtube.com/watch?v=");
    expect(code).toContain('rel: "noopener noreferrer"');
    expect(code).toContain("[A-Za-z0-9_-]{11}");
  });

  test("a frame file name outside the fixed pattern is never accepted by the page's pattern", () => {
    for (const bad of ["frames/../x.jpg", "http://evil/x.jpg", "//evil/x.jpg", "frames/c01-f0001.jpg?x", "data:image/png;base64,AA", "frames/c1-f1.jpg", "/frames/c01-f0001.jpg"]) expect(FRAME_FILE.test(bad)).toBe(false);
    expect(FRAME_FILE.test("frames/c01-f0001.jpg")).toBe(true);
  });

  test("a proposal for a clip, video or time that is not in the set is refused before any output, naming each problem", async () => {
    const { dir, captureId, labelsFile, out } = setFixture();
    const unknownVideo = writeProposals(proposals(OPUS, { boundaries: [bound("zzzzzzzzzzz", 5)] }, captureId));
    await expect(generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: out, proposalFiles: [unknownVideo] })).rejects.toThrow("video zzzzzzzzzzz is not one of the label file's clips");
    expect(existsSync(out)).toBe(false);
    const late = writeProposals(proposals(OPUS, { visualSteps: [step(A, 60)] }, captureId));
    await expect(generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: out, proposalFiles: [late] })).rejects.toThrow("60 s lies outside the labeled span [0, 60)");
    const noFrame = writeProposals(proposals(OPUS, { duplicateGroups: [{ frames: [{ videoId: A, mediaS: 5, frameId: "ev_nope" }, { videoId: B, mediaS: 4 }], reason: "r" }] }, captureId));
    await expect(generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: out, proposalFiles: [noFrame] })).rejects.toThrow("frame ev_nope is not a frame of video");
    const otherCapture = writeProposals(proposals(OPUS, {}, "cap_other"));
    await expect(generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: out, proposalFiles: [otherCapture] })).rejects.toThrow("capture cap_other");
    expect(existsSync(out)).toBe(false);
  });

  test("a malformed proposals file, two files from one model, three files, or proposals with a schema 1 file are refused", async () => {
    const { dir, captureId, labelsFile, out } = setFixture();
    const broken = join(tmp("props"), "broken.json");
    writeFileSync(broken, JSON.stringify({ schemaVersion: 1, kind: "label-proposals", items: {} }));
    await expect(generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: out, proposalFiles: [broken] })).rejects.toThrow("not a valid proposals file");
    const one = writeProposals(proposals(OPUS, {}, captureId), "one.json");
    const same = writeProposals(proposals(OPUS, {}, captureId), "same.json");
    await expect(generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: out, proposalFiles: [one, same] })).rejects.toThrow("same model and effort");
    const third = writeProposals(proposals("other-model", {}, captureId), "third.json");
    const two = writeProposals(proposals(FABLE, {}, captureId), "two.json");
    await expect(generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: out, proposalFiles: [one, two, third] })).rejects.toThrow("at most two");
    expect(existsSync(out)).toBe(false);
  });

  test("zero, one or two proposal files all generate; with none the page has no proposals", async () => {
    const { dir, captureId, labelsFile } = setFixture();
    const one = writeProposals(proposals(OPUS, { visualSteps: [step(B, 20)] }, captureId), "one.json");
    const two = writeProposals(proposals(FABLE, { visualSteps: [step(B, 25)] }, captureId), "two.json");
    for (const files of [[], [one], [one, two]]) {
      const out = join(tmp("out"), "sheet");
      await generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: out, proposalFiles: files });
      expect(dataOf(readFileSync(join(out, "index.html"), "utf8")).parsed.proposals).toHaveLength(files.length);
    }
  });

  test("the input hash changes when a proposal changes, so saved work for older inputs is not reused", async () => {
    const { dir, captureId, labelsFile } = setFixture();
    const hashOf = async (reason: string) => {
      const out = join(tmp("out"), "sheet");
      await generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: out, proposalFiles: [writeProposals(proposals(OPUS, { visualSteps: [step(B, 20, reason)] }, captureId), `${reason}.json`)] });
      return dataOf(readFileSync(join(out, "index.html"), "utf8")).parsed.inputHash;
    };
    expect(await hashOf("first")).not.toBe(await hashOf("second"));
  });

  test("refuses an --out inside the data dir, equal to it, or reached through a symlink, and writes nothing", async () => {
    const { dir, labelsFile } = setFixture();
    const before = hashTree(dir);
    for (const out of [join(dir, "sheet"), dir, join(dir, "frames", "deep")]) await expect(generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: out })).rejects.toThrow("inside the data dir");
    const link = join(tmp("link"), "alias");
    symlinkSync(dir, link);
    await expect(generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: join(link, "sheet") })).rejects.toThrow("inside the data dir");
    expect(hashTree(dir)).toEqual(before);
  });

  test("leaves the source data dir byte for byte as it was", async () => {
    const { dir, labelsFile, out } = setFixture();
    const before = hashTree(dir);
    expect(Object.keys(before).some((k) => k.includes("frames"))).toBe(true);
    await generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: out });
    expect(hashTree(dir)).toEqual(before);
  });

  test("a label file that fails validation stops generation before any output, naming the field", async () => {
    const { dir, labels, out } = setFixture();
    const bad = join(tmp("bad"), "bad.json");
    writeFileSync(bad, JSON.stringify({ ...labels, status: "signed_off" }));
    await expect(generateSheet({ dataDir: dir, labelFiles: [bad], outDir: out })).rejects.toThrow("signedOffBy");
    const wrongSpan = join(tmp("bad"), "span.json");
    writeFileSync(wrongSpan, JSON.stringify({ ...labels, boundaries: [{ videoId: A, mediaS: 9999, note: "", confirmed: false }] }));
    await expect(generateSheet({ dataDir: dir, labelFiles: [wrongSpan], outDir: out })).rejects.toThrow("boundaries[0].mediaS");
    expect(existsSync(out)).toBe(false);
  });

  test("a video id that is not an 11-character YouTube id is refused, so it never becomes a link", async () => {
    const { dir, labels, out } = setFixture();
    const evil = join(tmp("evil"), "evil.json");
    writeFileSync(evil, JSON.stringify({ ...labels, lecture: { ...labels.lecture, videos: labels.lecture.videos.map((v, i) => (i === 1 ? { ...v, videoId: "../../escape" } : v)) }, boundaries: [], visualSteps: [], duplicateGroups: [] }));
    await expect(generateSheet({ dataDir: dir, labelFiles: [evil], outDir: out })).rejects.toThrow("not a YouTube video id");
    expect(existsSync(out)).toBe(false);
  });

  test("a set listed out of the capture's watch order, or with a clip the capture never saw, is refused", async () => {
    const { dir, labels, out } = setFixture();
    const swapped = join(tmp("swap"), "swapped.json");
    const [first, second, ...rest] = labels.lecture.videos;
    writeFileSync(swapped, JSON.stringify({ ...labels, lecture: { ...labels.lecture, videos: [second, first, ...rest] }, boundaries: [], visualSteps: [], duplicateGroups: [] }));
    await expect(generateSheet({ dataDir: dir, labelFiles: [swapped], outDir: out })).rejects.toThrow("watch order");
    const ghost = join(tmp("ghost"), "ghost.json");
    writeFileSync(ghost, JSON.stringify({ ...labels, lecture: { ...labels.lecture, videos: [...labels.lecture.videos, { videoId: "ggggggggggg", spanS: { start: 0, end: 10 } }] }, boundaries: [], visualSteps: [], duplicateGroups: [] }));
    await expect(generateSheet({ dataDir: dir, labelFiles: [ghost], outDir: out })).rejects.toThrow("no source for video ggggggggggg");
    expect(existsSync(out)).toBe(false);
  });

  test("a set file beside another label file is refused: one set, one sheet", async () => {
    const { dir, labelsFile, out } = setFixture();
    await expect(generateSheet({ dataDir: dir, labelFiles: [labelsFile, labelsFile], outDir: out })).rejects.toThrow();
  });

  test("the per-clip sheet for a schema 1 file is unchanged: one page per video with its frames embedded, and data: images in its policy", async () => {
    const { dir, captureId } = setFixture();
    const schema1: Record<string, unknown> = {
      schemaVersion: 1, status: "draft", signedOffBy: null, signedOffAt: null,
      lecture: { captureId, videoId: A, title: "Clip 1", spanS: { start: 0, end: 60 } },
      boundaries: [], visualSteps: [{ mediaS: 30, note: "", confirmed: false }], duplicateGroups: [],
    };
    const file = join(tmp("s1"), "s1.json");
    writeFileSync(file, JSON.stringify(schema1));
    const out = join(tmp("out"), "sheet");
    await generateSheet({ dataDir: dir, labelFiles: [file], outDir: out });
    expect(readdirSync(out).sort()).toEqual([`${A}.html`, "index.html"]);
    const html = readFileSync(join(out, `${A}.html`), "utf8");
    expect(html).toContain("img-src data:;");
    expect(html).toContain("data:image/jpeg;base64,");
    await expect(generateSheet({ dataDir: dir, labelFiles: [file], outDir: out, proposalFiles: ["x.json"] })).rejects.toThrow("--proposals belongs to a set");
  });
});

describe("proposals origin: a fixture file is not a model", () => {
  const withOrigin = (origin: unknown, model = OPUS, captureId = "cap_x") => ({ ...proposals(model, { visualSteps: [step(B, 20, "r")] }, captureId), origin });

  test("origin is optional and accepts only fixture or live, with the path of a bad one", () => {
    expect(validateProposals(proposals(OPUS, {})).ok).toBe(true);
    expect(validateProposals(withOrigin("fixture")).ok).toBe(true);
    expect(validateProposals(withOrigin("live")).ok).toBe(true);
    for (const bad of ["model", "", 1, null]) {
      const r = validateProposals(withOrigin(bad));
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.errors.join("\n")).toContain('origin: expected "fixture" or "live"');
    }
  });

  test("a fixture file is refused by default, with an error that says it came from a test client", async () => {
    const { dir, captureId, labelsFile, out } = setFixture();
    const file = writeProposals(withOrigin("fixture", OPUS, captureId) as unknown as Proposals, "fx.json");
    await expect(generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: out, proposalFiles: [file] })).rejects.toThrow(
      "fx.json has origin \"fixture\": it was produced by a scripted test client, not a model. Pass --allow-fixture-proposals to show it anyway, labelled FIXTURE, not a model.",
    );
    expect(existsSync(out)).toBe(false);
  });

  test("with the flag a fixture file is shown labelled FIXTURE, not a model, and never as Opus or Fable", async () => {
    const { dir, captureId, labelsFile, out } = setFixture();
    const file = writeProposals(withOrigin("fixture", OPUS, captureId) as unknown as Proposals, "fx.json");
    await generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: out, proposalFiles: [file], allowFixtureProposals: true });
    const { parsed } = dataOf(readFileSync(join(out, "index.html"), "utf8"));
    expect(parsed.proposals[0]!.origin).toBe("fixture");
    const label = proposalsLabel(parsed.proposals[0]!);
    expect(label).toContain("FIXTURE, not a model");
    expect(label).not.toMatch(/^(Opus|Fable)$/);
    const s = initialState(parsed.draft, parsed.proposals);
    const item = s.visualSteps.find((x) => x.proposers.length > 0)!;
    expect(item.proposers[0]!.label).toContain("FIXTURE, not a model");
    expect(item.status).toBe("unconfirmed");
    const confirmed = evaluate(setSignature(setStatus(s, "visualSteps", item.id, "confirmed"), "Derek", "2026-11-05"), parsed.draft).labels;
    expect(confirmed.visualSteps.find((x) => x.mediaS === 20)!.cue).toContain("FIXTURE, not a model");
  });

  test("a live file, and a file with no origin, are unaffected by the flag", async () => {
    const { dir, captureId, labelsFile } = setFixture();
    const live = writeProposals(withOrigin("live", OPUS, captureId) as unknown as Proposals, "live.json");
    const none = writeProposals(proposals(FABLE, {}, captureId), "none.json");
    for (const allow of [false, true]) {
      const out = join(tmp("out"), "sheet");
      await generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: out, proposalFiles: [live, none], allowFixtureProposals: allow });
      const { parsed } = dataOf(readFileSync(join(out, "index.html"), "utf8"));
      expect(parsed.proposals.map(proposalsLabel)).toEqual(["Opus", "Fable"]);
    }
  });
});
