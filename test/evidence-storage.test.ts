import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asSeq } from "../src/backend/db";
import { createEvidence } from "../src/backend/evidence";
import type { FrameChangeInput } from "../src/backend/providers/jev-tasks";
import type { Evidence } from "../src/shared/domain";
import type { EvidenceId } from "../src/shared/ids";
import { stableId } from "../src/shared/ids";
import { Material, interval } from "../src/shared/time";
import { DAY, JPEG, SRC, count, exceptStalls, harness, hit, keyOf, stream, textsOf } from "./evidence-fixtures";

describe("frames and Jev judgments", () => {
  function frameStream() {
    const h = harness();
    const s = stream();
    s.control("start");
    s.source();
    s.transcript([[0, 6, "near"], [100, 104, "far"]]);
    s.span(0, 60);
    s.frame("f1", 5);
    s.frame("f2", 20);
    s.frame("f3", 40);
    s.frame("f4", 50);
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    const id = (f: string) => stableId("ev", s.captureId, f);
    return { h, s, id };
  }

  test("the first frame of a source is kept without a call; later frames are demanded until judged", () => {
    const { h, s, id } = frameStream();
    const teaching = () => Object.fromEntries(h.evidence.watchOrder(s.captureId).frameCandidates.map((f) => [f.id, f.teaching]));
    expect(teaching()).toEqual({ [id("f1")]: "kept", [id("f2")]: "unjudged", [id("f3")]: "unjudged", [id("f4")]: "unjudged" });
    expect(h.evidence.frameDemand(s.captureId)).toHaveLength(3);
    expect(new Set(h.evidence.frameDemand(s.captureId).map((w) => w.key)).size).toBe(3);

    h.script.set(id("f2"), hit("yes", id("f2")));
    h.script.set(id("f3"), hit("no", id("f3")));
    h.script.set(id("f4"), { kind: "failed", key: stableId("key", "f4"), attempts: 3, lastError: "boom", atSeq: asSeq(2) });
    expect(teaching()).toEqual({ [id("f1")]: "kept", [id("f2")]: "kept", [id("f3")]: "dropped", [id("f4")]: "uncertain" });
    expect(h.evidence.frameDemand(s.captureId)).toEqual([]);
  });

  test("a bundle holds kept and uncertain frames only; a dropped frame is hidden but stays gettable", () => {
    const { h, s, id } = frameStream();
    h.script.set(id("f2"), hit("yes", id("f2")));
    h.script.set(id("f3"), hit("no", id("f3")));
    h.script.set(id("f4"), hit("uncertain", id("f4")));
    const bundle = h.evidence.bundle(h.evidence.watchedMaterial(s.captureId));
    expect(bundle.frames.map((f) => f.id).sort()).toEqual([id("f1"), id("f2"), id("f4")].sort());
    expect(bundle.frames.every((f) => f.teaching === "kept" || f.teaching === "uncertain")).toBe(true);
    expect(h.evidence.get([id("f3")]).get(id("f3"))).toMatchObject({ kind: "frame", teaching: "dropped" });
  });

  test("the judgment input pairs a frame with its media-order predecessor and the passages within 15 s", () => {
    const { h, s, id } = frameStream();
    const seen: FrameChangeInput[] = [];
    const store = createEvidence(h.db, h.dir, {
      lookupFrameChange: (input) => (seen.push(input), { kind: "missing", key: keyOf(input) }),
      runFrameChange: async () => undefined, frameChangeKey: keyOf, onChange: () => {},
    });
    store.frameDemand(s.captureId);
    const f2 = seen.find((i) => i.after.frame.id === id("f2"))!;
    expect(f2.before?.frame.id).toBe(id("f1"));
    expect(textsOf(f2.nearbyPassages)).toEqual(["near"]);
    expect(f2.after.bytes().length).toBeGreaterThan(0);
    expect(seen.find((i) => i.after.frame.id === id("f4"))!.nearbyPassages).toEqual([]);
  });
});

describe("bundle(material)", () => {
  test("holds passages wholly inside the material, gaps that touch it, and nothing for other material", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.source();
    s.transcript([[0, 4, "one"], [14, 18, "two"], [28, 32, "three"]]);
    s.span(0, 40);
    s.span(60, 70, { visible: false });
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });

    const chunk = Material.of([[SRC, [interval(10, 30)]]]);
    const bundle = h.evidence.bundle(chunk);
    expect(textsOf(bundle.passages)).toEqual(["two"]);
    expect(bundle.gaps.some((g) => g.reason === "hidden_tab")).toBe(false);
    expect(h.evidence.bundle(Material.of([[SRC, [interval(60, 65)]]])).gaps.map((g) => g.reason)).toContain("hidden_tab");
    expect(Material.isEmpty(h.evidence.bundle(Material.empty).material)).toBe(true);
    expect(h.evidence.bundle(Material.of([[SRC, [interval(500, 510)]]])).passages).toEqual([]);
  });

  test("a gap from a capture that did not watch the material does not leak in", () => {
    const h = harness();
    const first = stream();
    first.control("start");
    first.span(0, 10, { visible: false });
    const second = stream();
    second.control("start");
    second.span(0, 10);
    second.frame("f", 5);
    h.evidence.ingest({ captureId: first.captureId, facts: first.facts });
    h.evidence.ingest({ captureId: second.captureId, facts: second.facts });
    expect(exceptStalls(h.evidence.captureBundle(first.captureId).gaps).map((g) => g.reason)).toEqual(["hidden_tab"]);
    expect(exceptStalls(h.evidence.captureBundle(second.captureId).gaps)).toEqual([]);
  });
});

describe("capture probe bundle", () => {
  test("is plain JSON carrying watched intervals, passages, frames, gaps and ads", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.source();
    s.transcript([[0, 4, "hello"], [8, 12, "partial"]]);
    s.span(0, 10);
    s.ad(10);
    s.frame("f1", 2);
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });

    const bundle = h.evidence.captureBundle(s.captureId);
    expect(JSON.parse(JSON.stringify(bundle))).toEqual(bundle);
    expect(bundle.captureId).toBe(s.captureId);
    expect(bundle.status).toEqual({ state: "capturing" });
    expect(bundle.watchedSeconds).toBe(10);
    expect(bundle.watched).toEqual([{ sourceId: SRC, intervals: [[0, 10]] }]);
    expect(bundle.passages).toHaveLength(1);
    expect(bundle.frames).toHaveLength(1);
    expect(bundle.frames[0]!.file).toBe(join(h.dir, "frames", h.db.userId, SRC, `${stableId("ev", s.captureId, "f1")}.jpg`));
    expect(exceptStalls(bundle.gaps).map((g) => g.reason)).toEqual(["partially_watched_segment"]);
    expect(bundle.ads).toHaveLength(1);
  });
});

describe("R16: cited evidence is deleted only by the user, never by expiry", () => {
  /** A saved review's world: a note citing a passage and a frame. */
  function cited(h: ReturnType<typeof harness>, s: ReturnType<typeof stream>, opts: { save?: boolean } = {}) {
    const passage = h.evidence.watchOrder(s.captureId).passages[0]!.passage;
    const frame = stableId("ev", s.captureId, "f1");
    const reviewId = "rvw_x";
    h.db.sql.run("INSERT INTO reviews (id, user_id, capture_id, choice, scope_json, frozen_at_seq, started_ms) VALUES (?, ?, ?, 'prepared_only', '{}', ?, 0)", [reviewId, h.db.userId, s.captureId, h.db.nextSeq()]);
    if (opts.save !== false) {
      h.evidence.snapshotInTx([passage.id, frame]);
      h.db.sql.run("INSERT INTO saved_reviews (user_id, review_id, bundle_hash, saved_ms) VALUES (?, ?, 'h', 0)", [h.db.userId, reviewId]);
      h.db.sql.run("INSERT INTO notes (user_id, id, ord, review_id, concept_id, generated_json, saved_ms) VALUES (?, 'note_1', 1, ?, 'cpt_1', '{}', 0)", [h.db.userId, reviewId]);
      h.db.sql.run("INSERT INTO note_evidence (user_id, note_id, evidence_id) VALUES (?1, 'note_1', ?2), (?1, 'note_1', ?3)", [h.db.userId, passage.id, frame]);
    }
    return { passage, frame, reviewId };
  }

  function capture(clock = { t: 1_000_000 }) {
    const h = harness({ clock });
    const s = stream();
    s.control("start");
    s.source();
    s.transcript([[0, 4, "hello"]]);
    s.span(0, 10);
    s.frame("f1", 2);
    s.control("stop");
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    return { h, s };
  }

  const count = (h: ReturnType<typeof harness>, t: string) => h.db.sql.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${t}`).get()!.n;

  test("expiry removes an old capture's raw facts and frame files, and keeps a young one", () => {
    const { h, s } = capture();
    const young = stream();
    young.control("start");
    h.clock.t = 1_000_000 + 40 * DAY;
    h.evidence.ingest({ captureId: young.captureId, facts: young.facts });

    const swept = h.evidence.sweepExpired(h.clock.t, 30);
    expect(swept).toEqual({ framesDeleted: 1, factsDeleted: 6, snapshotsDeleted: 0 });
    expect(h.evidence.captureView(s.captureId).watchedSeconds).toBe(0);
    expect(h.evidence.captureView(young.captureId).status).toEqual({ state: "capturing" });
    expect(readdirSync(join(h.dir, "frames"), { recursive: true }).filter((f) => String(f).endsWith(".jpg"))).toEqual([]);
  });

  test("nothing is swept before the retention window ends", () => {
    const { h } = capture();
    expect(h.evidence.sweepExpired(1_000_000 + 29 * DAY, 30)).toEqual({ framesDeleted: 0, factsDeleted: 0, snapshotsDeleted: 0 });
    expect(count(h, "capture_facts")).toBe(6);
  });

  test("a snapshot cited by a live note survives expiry and still serves the passage and the frame bytes", () => {
    const { h, s } = capture();
    const { passage, frame } = cited(h, s);
    const swept = h.evidence.sweepExpired(1_000_000 + 60 * DAY, 30);
    expect(swept.snapshotsDeleted).toBe(0);
    expect(swept.factsDeleted).toBe(6);
    expect(count(h, "evidence_snapshots")).toBe(2);

    const got = h.evidence.get([passage.id, frame]);
    expect(got.get(passage.id)).toMatchObject({ kind: "passage", text: "hello", origin: "panel", transcriptRevId: passage.transcriptRevId });
    expect(got.get(frame)).toMatchObject({ kind: "frame", mediaS: 2, width: 640, height: 360 });
    expect([...h.evidence.frameBytes(frame)!]).toEqual([...Buffer.from(JPEG, "base64")]);
  });

  test("once the user deletes the citing note, the snapshot expires", () => {
    const { h, s } = capture();
    const { passage } = cited(h, s);
    h.db.sql.run("INSERT INTO note_deletions (user_id, note_id, deleted_ms) VALUES (?, 'note_1', 5)", [h.db.userId]);
    const swept = h.evidence.sweepExpired(1_000_000 + 60 * DAY, 30);
    expect(swept.snapshotsDeleted).toBe(2);
    expect(count(h, "evidence_snapshots")).toBe(0);
    expect(h.evidence.get([passage.id]).size).toBe(0);
    expect(readdirSync(join(h.dir, "snapshots")).filter((f) => f.endsWith(".jpg"))).toEqual([]);
  });

  test("an unsaved review (a pending save) holds its capture's raw evidence even when old", () => {
    const { h, s } = capture();
    cited(h, s, { save: false });
    expect(h.evidence.sweepExpired(1_000_000 + 90 * DAY, 30)).toEqual({ framesDeleted: 0, factsDeleted: 0, snapshotsDeleted: 0 });
    expect(count(h, "capture_facts")).toBe(6);
    expect(count(h, "frames")).toBe(1);

    h.db.sql.run("INSERT INTO saved_reviews (user_id, review_id, bundle_hash, saved_ms) VALUES (?, 'rvw_x', 'h', 0)", [h.db.userId]);
    expect(h.evidence.sweepExpired(1_000_000 + 90 * DAY, 30).factsDeleted).toBe(6);
  });

  test("snapshotInTx is insert-only: a retried save adds nothing and the frame file is hard-linked", () => {
    const { h, s } = capture();
    const { passage, frame } = cited(h, s);
    const before = count(h, "evidence_snapshots");
    h.evidence.snapshotInTx([passage.id, frame]);
    expect(count(h, "evidence_snapshots")).toBe(before);
    const row = h.db.sql.query<{ frame_path: string }, [string]>("SELECT frame_path FROM evidence_snapshots WHERE evidence_id = ?").get(frame)!;
    expect(statSync(join(h.dir, row.frame_path)).nlink).toBeGreaterThanOrEqual(2);
    expect(() => h.evidence.snapshotInTx([stableId("ev", "nonexistent")])).toThrow(/no evidence/);
  });

  test("the user can delete cited evidence: tombstone, rows and files go, the citing note sees it deleted", () => {
    const { h, s } = capture();
    const { passage, frame } = cited(h, s);
    h.evidence.deleteByUser([passage.id, frame], "req-1");

    expect(count(h, "evidence_deletions")).toBe(2);
    expect(count(h, "evidence_snapshots")).toBe(0);
    expect(count(h, "frames")).toBe(0);
    expect(h.evidence.get([passage.id, frame]).get(passage.id)).toMatchObject({ kind: "deleted", id: passage.id });
    expect(h.evidence.get([frame]).get(frame)).toMatchObject({ kind: "deleted", id: frame });
    expect(h.evidence.frameBytes(frame)).toBeNull();
    expect((readdirSync(h.dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".jpg"))).toEqual([]);
    const bundle = h.evidence.bundle(h.evidence.watchedMaterial(s.captureId));
    expect(bundle.passages).toEqual([]);
    expect(bundle.frames).toEqual([]);
    expect(h.evidence.watchOrder(s.captureId).passages).toEqual([]);
    expect(h.evidence.captureBundle(s.captureId).frames).toEqual([]);
  });

  test("a retried delete is a no-op, and deleted evidence is not revived by a re-sent frame", () => {
    const { h, s } = capture();
    const { passage, frame } = cited(h, s);
    h.evidence.deleteByUser([passage.id, frame], "req-1");
    h.evidence.deleteByUser([passage.id, frame], "req-1");
    expect(count(h, "evidence_deletions")).toBe(2);

    const again = stream(s.captureId);
    for (let i = 0; i < s.facts.length; i++) again.push({ kind: "control", action: "resume", reason: "user" });
    again.frame("f1", 2);
    h.evidence.ingest({ captureId: s.captureId, facts: again.facts });
    expect(count(h, "frames")).toBe(0);
  });

  test("the user can delete evidence of an unsaved review, because the tombstone comes first", () => {
    const { h, s } = capture();
    const { frame } = cited(h, s, { save: false });
    expect(() => h.evidence.deleteByUser([frame], "req-2")).not.toThrow();
    expect(count(h, "frames")).toBe(0);
  });

  test("orphan frame files (a crash between the file write and the row commit) are swept", () => {
    const { h } = capture();
    const orphan = join(h.dir, "frames", h.db.userId, SRC, "ev_orphan.jpg");
    mkdirSync(join(h.dir, "frames", h.db.userId, SRC), { recursive: true });
    writeFileSync(orphan, "x");
    writeFileSync(`${orphan}.tmp-1`, "x");
    expect(h.evidence.sweepExpired(1_000_000, 30).framesDeleted).toBe(2);
    expect(existsSync(orphan)).toBe(false);
    expect(h.evidence.frameBytes(stableId("ev", "x"))).toBeNull();
  });
});

describe("get", () => {
  test("returns passages and frames by id, omits unknown ids", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.source();
    s.transcript([[0, 4, "hello"]]);
    s.span(0, 10);
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    const p = h.evidence.watchOrder(s.captureId).passages[0]!.passage;
    const unknown = stableId("ev", "nothing");
    const got: ReadonlyMap<EvidenceId, Evidence | { readonly kind: "deleted" }> = h.evidence.get([p.id, unknown]);
    expect([...got.keys()]).toEqual([p.id]);
    expect(got.get(p.id)).toEqual(p);
  });
});

describe("half-open intervals: a point at a material's end is outside it", () => {
  test("a frame or ad exactly at the end of the material stays out of the bundle", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.source();
    s.span(0, 20);
    s.ad(10);
    s.frame("at9", 9);
    s.frame("at10", 10);
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    const b = h.evidence.bundle(Material.of([[SRC, [interval(0, 10)]]]));
    expect(b.frames.map((f) => Number(f.mediaS))).toEqual([9]);
    expect(b.ads).toEqual([]);
    expect(h.evidence.bundle(Material.of([[SRC, [interval(10, 20)]]])).ads).toHaveLength(1);
  });

  test("a frame exactly at the end of the visible watched span is not a frame candidate", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.span(0, 10);
    s.frame("at0", 0);
    s.frame("at10", 10);
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    expect(h.evidence.watchOrder(s.captureId).frameCandidates.map((f) => Number(f.mediaS))).toEqual([0]);
  });
});

describe("a resent frame id", () => {
  const OTHER_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]).toString("base64");

  test("under a new clientSeq with other bytes does not overwrite the stored frame", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.span(0, 10);
    s.frame("dup", 5);
    s.frame("dup", 5, { jpeg: OTHER_JPEG });
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts.slice(0, 3) });
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts.slice(3) });
    expect([...h.evidence.frameBytes(stableId("ev", s.captureId, "dup"))!]).toEqual([...Buffer.from(JPEG, "base64")]);
    expect(count(h, "frames")).toBe(1);
  });

  test("twice in one batch keeps the first bytes", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.span(0, 10);
    s.frame("dup", 5);
    s.frame("dup", 5, { jpeg: OTHER_JPEG });
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    expect([...h.evidence.frameBytes(stableId("ev", s.captureId, "dup"))!]).toEqual([...Buffer.from(JPEG, "base64")]);
  });
});

describe("a frame fact whose bytes were not a JPEG", () => {
  const stalls = (h: ReturnType<typeof harness>, s: ReturnType<typeof stream>) =>
    h.evidence.captureBundle(s.captureId).gaps.filter((g) => g.reason === "frame_stall").map((g) => [g.start, g.end]);

  test("is not a frame sample, so frame_stall still covers the time it claims", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.source();
    s.span(0, 80);
    s.frame("bad", 40, { jpeg: Buffer.from("zzzzzzzzzzzz").toString("base64") });
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    expect(stalls(h, s)).toEqual([[0, 80]]);
  });

  test("a real frame the user later deleted still counts as a sample", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.source();
    s.span(0, 80);
    s.frame("good", 40);
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    const before = stalls(h, s);
    expect(before).toEqual([[0, 40], [40, 80]]);
    h.evidence.deleteByUser([stableId("ev", s.captureId, "good")], "r1");
    expect(stalls(h, s)).toEqual(before);
  });
});

describe("deleteByUser on an id that never existed", () => {
  test("leaves no tombstone, so evidence that later arrives under that id is not blocked", () => {
    const h = harness();
    const s = stream();
    s.control("start");
    s.span(0, 10);
    const id = stableId("ev", s.captureId, "later");
    h.evidence.deleteByUser([id, stableId("ev", "never")], "r1");
    expect(count(h, "evidence_deletions")).toBe(0);
    s.frame("later", 5);
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    expect(h.evidence.frameBytes(id)).not.toBeNull();
    expect(h.evidence.get([id]).get(id)).toMatchObject({ kind: "frame" });
  });
});
