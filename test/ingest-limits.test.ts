import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createEvidence } from "../src/backend/evidence";
import { IngestRefused, resolveIngestLimits } from "../src/backend/evidence/ingest-limits";
import type { IngestLimits } from "../src/backend/evidence/ingest-limits";
import { jpegSize } from "../src/backend/evidence/jpeg";
import { MAX_RETRY_AFTER_MS, QUOTA_RETRY_MS, classifyStatus, createMemoryOutbox, flushCapture, parseRetryAfter } from "../src/extension/worker/outbox";
import type { Transport } from "../src/extension/worker/outbox";
import { MAX_FRAME_BASE64_CHARS, MAX_FRAME_BYTES } from "../src/shared/domain";
import type { CaptureFactBody } from "../src/shared/domain";
import { randomId, stableId } from "../src/shared/ids";
import { media } from "../src/shared/time";
import { count, harness, keyOf, stream } from "./evidence-fixtures";
import { JSON_HEADERS, VIDEO as WIRE_VIDEO, ingest, post, start } from "./http-fixtures";
import { headerJpeg } from "./jpeg-fixture";
import { otherUserDb, testDb } from "./fakes";
import { ensureLocalUser, scopeDb } from "../src/backend/db";
import type { UserDb } from "../src/backend/db";
import { tmpDir } from "./tmp";

const MIB = 1024 * 1024;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const roomy = (over: Partial<IngestLimits> = {}): IngestLimits => ({ maxUserBytes: 1024 * MIB, minFreeBytes: 0, freeBytes: () => 1e12, ...over });

const wireFrame = (clientSeq: number, jpegBase64: string, size: [number, number] = [640, 360]) => ({
  kind: "frame", videoId: WIRE_VIDEO, frameId: `f${clientSeq}`, mediaS: clientSeq, width: size[0], height: size[1], trigger: "change_settled", diff: 0.4, jpegBase64, clientSeq, wallMs: 1000 + clientSeq,
});

describe("a frame is what the extension sends", () => {
  test("the limit has headroom over the largest lecture frame and is well under the request body limit", () => {
    expect(MAX_FRAME_BYTES).toBeGreaterThan(700_000);
    expect(MAX_FRAME_BASE64_CHARS).toBeLessThan(2 * MIB);
  });

  test("an oversized frame is refused at the boundary and stores nothing", async () => {
    const { base, stored } = start();
    const huge = b64(headerJpeg(640, 360, MAX_FRAME_BYTES));
    expect(huge.length).toBeGreaterThan(MAX_FRAME_BASE64_CHARS);
    const r = await ingest(base, [wireFrame(0, huge)]);
    expect(r.status).toBe(400);
    expect(stored()).toBe(0);
  });

  test("a frame at the limit is still accepted", async () => {
    const { base, stored } = start();
    const edge = headerJpeg(640, 360, MAX_FRAME_BYTES - headerJpeg().length - 4);
    expect(edge.length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    expect(b64(edge).length).toBeLessThanOrEqual(MAX_FRAME_BASE64_CHARS);
    expect((await ingest(base, [wireFrame(0, b64(edge))])).status).toBe(200);
    expect(stored()).toBe(1);
  });

  test("the JPEG header is read for its size", () => {
    expect(jpegSize(headerJpeg(1280, 720))).toEqual({ width: 1280, height: 720 });
    expect(jpegSize(headerJpeg(640, 360, 300))).toEqual({ width: 640, height: 360 });
    expect(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]))).toBeNull();
    expect(jpegSize(new Uint8Array())).toBeNull();
  });

  test("three magic bytes, or a header that disagrees with the declared size, are not stored as a frame", () => {
    const h = harness({ limits: roomy() });
    const s = stream();
    s.control("start");
    s.frame("magic", 1, { jpeg: b64(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])) });
    s.frame("wrong", 2, { jpeg: b64(headerJpeg(1280, 720)) });
    s.frame("tiny", 3, { jpeg: b64(headerJpeg(100, 60)) });
    s.frame("good", 4);
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    expect(count(h, "frames")).toBe(1);
    expect(readdirSync(join(h.dir, "frames", h.db.userId, stableId("src", "youtube", VIDEO_ID))).length).toBe(1);
  });
});
const VIDEO_ID = "aaaaaaaaaaa";

describe("a per-user stored-bytes quota", () => {
  const frameStream = (n: number, pad = 0) => {
    const s = stream();
    s.control("start");
    for (let i = 0; i < n; i++) s.frame(`f${i}`, i + 1, { jpeg: b64(headerJpeg(640, 360, pad)) });
    return s;
  };

  const evidenceFor = (db: UserDb, dir: string, limits: IngestLimits) =>
    createEvidence(db, dir, { lookupFrameChange: (input) => ({ kind: "missing", key: keyOf(input) }), runFrameChange: async () => undefined, frameChangeKey: keyOf, onChange: () => {}, limits });

  test("a user over the quota is refused, nothing is written, and another user is not refused", () => {
    const db = testDb();
    const dir = tmpDir("afterclass-quota-");
    const limits = roomy({ maxUserBytes: 100_000 });
    const alice = evidenceFor(scopeDb(db, ensureLocalUser(db)), dir, limits);
    const bob = evidenceFor(otherUserDb(db, "bob"), dir, limits);
    const first = frameStream(1, 60_000);
    alice.ingest({ captureId: first.captureId, facts: first.facts });
    const second = frameStream(1, 60_000);
    let reason = "";
    try {
      alice.ingest({ captureId: second.captureId, facts: second.facts });
    } catch (e) {
      reason = e instanceof IngestRefused ? e.reason : "other";
    }
    expect(reason).toBe("quota");
    expect(db.sql.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM capture_facts WHERE capture_id = ?").get(second.captureId)!.n).toBe(0);
    const bobs = frameStream(1, 60_000);
    expect(() => bob.ingest({ captureId: bobs.captureId, facts: bobs.facts })).not.toThrow();
  });

  test("an empty batch from a user at the quota still answers, so the extension's heartbeat is not refused", () => {
    const h = harness({ limits: roomy({ maxUserBytes: 1000 }) });
    const s = frameStream(1, 5000);
    expect(() => h.evidence.ingest({ captureId: s.captureId, facts: s.facts })).toThrow(IngestRefused);
    const first = stream();
    first.control("start");
    expect(() => h.evidence.ingest({ captureId: first.captureId, facts: [] })).not.toThrow();
  });

  test("expiry frees quota, because the sum is over the rows that remain", () => {
    const h = harness({ limits: roomy({ maxUserBytes: 100_000 }) });
    const s = frameStream(1, 60_000);
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    const again = frameStream(1, 60_000);
    expect(() => h.evidence.ingest({ captureId: again.captureId, facts: again.facts })).toThrow(IngestRefused);
    h.evidence.sweepExpired(h.clock.t + 31 * 86_400_000, 30);
    expect(() => h.evidence.ingest({ captureId: again.captureId, facts: again.facts })).not.toThrow();
  });

  test("over HTTP the quota refusal is 507 and the other user's account is untouched", async () => {
    const { base, stored } = start(undefined, { limits: roomy({ maxUserBytes: 100_000 }) });
    expect((await ingest(base, [wireFrame(0, b64(headerJpeg(640, 360, 60_000)))])).status).toBe(200);
    const refused = await post(base, "/ingest", { captureId: randomId("cap"), facts: [wireFrame(0, b64(headerJpeg(640, 360, 60_000)))] }, JSON_HEADERS);
    expect(refused.status).toBe(507);
    expect(stored()).toBe(1);
  });

  test("AFTERCLASS_USER_QUOTA_MB sets it and 0 turns it off", () => {
    expect(resolveIngestLimits({ AFTERCLASS_USER_QUOTA_MB: "2" }, ".").maxUserBytes).toBe(2 * MIB);
    expect(resolveIngestLimits({ AFTERCLASS_MIN_FREE_MB: "100" }, ".").minFreeBytes).toBe(100 * MIB);
    expect(resolveIngestLimits({}, ".").maxUserBytes).toBe(512 * MIB);
    expect(() => resolveIngestLimits({ AFTERCLASS_USER_QUOTA_MB: "lots" }, ".")).toThrow();
  });
});

describe("a batch that writes nothing stays read-only", () => {
  const broke = () => roomy({ minFreeBytes: 1000, freeBytes: () => 0, maxUserBytes: 1 });

  test("a heartbeat for an unknown capture creates no ownership row, however many arrive with no free disk", () => {
    const h = harness({ limits: broke() });
    for (let i = 0; i < 100; i++) expect(h.evidence.ingest({ captureId: randomId("cap"), facts: [] }).ackedThroughSeq).toBe(-1);
    expect(count(h, "capture_owners")).toBe(0);
    expect(count(h, "capture_facts")).toBe(0);
  });

  test("over HTTP the same heartbeat is answered and writes nothing", async () => {
    const { base, stored } = start(undefined, { limits: broke() });
    for (let i = 0; i < 3; i++) {
      const r = await post(base, "/ingest", { captureId: randomId("cap"), facts: [] }, JSON_HEADERS);
      expect(r.status).toBe(200);
    }
    expect(stored()).toBe(0);
  });

  test("a batch of facts the capture already holds is a heartbeat, and a batch with something new still meets the floor", () => {
    let free = 1e12;
    const h = harness({ limits: roomy({ minFreeBytes: 1000, freeBytes: () => free }) });
    const s = stream();
    s.control("start");
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    free = 0;
    expect(h.evidence.ingest({ captureId: s.captureId, facts: s.facts }).ackedThroughSeq).toBe(0);
    s.span(0, 5);
    expect(() => h.evidence.ingest({ captureId: s.captureId, facts: s.facts })).toThrow(IngestRefused);
    expect(count(h, "capture_facts")).toBe(1);
  });
});

describe("storage is counted in bytes", () => {
  const cjk = (n: number) => "\u6f22".repeat(n);
  const lecture = () => {
    const s = stream();
    s.control("start");
    s.transcript([[0, 4, cjk(5000)]]);
    return s;
  };

  test("a CJK transcript is charged its UTF-8 bytes against the quota", () => {
    const h = harness({ limits: roomy({ maxUserBytes: 25_000 }) });
    const a = lecture();
    h.evidence.ingest({ captureId: a.captureId, facts: a.facts });
    const stored = h.db.sql.query<{ n: number }, []>("SELECT SUM(LENGTH(CAST(body_json AS BLOB))) AS n FROM capture_facts").get()!.n;
    expect(stored).toBeGreaterThan(15_000);
    const b = lecture();
    expect(() => h.evidence.ingest({ captureId: b.captureId, facts: b.facts })).toThrow(IngestRefused);
  });

  test("a CJK batch counts its UTF-8 bytes against the disk floor", () => {
    const h = harness({ limits: roomy({ minFreeBytes: 90_000, freeBytes: () => 100_000 }) });
    const a = lecture();
    expect(() => h.evidence.ingest({ captureId: a.captureId, facts: a.facts })).toThrow(IngestRefused);
    expect(count(h, "capture_facts")).toBe(0);
  });
});

describe("a cited snapshot keeps its charge after raw expiry", () => {
  test("the frame a note keeps counts against the quota once the raw frame row is gone", () => {
    const clock = { t: 1_000_000 };
    const h = harness({ clock, limits: roomy({ maxUserBytes: 100_000 }) });
    const s = stream();
    s.control("start");
    s.source();
    s.span(0, 10);
    s.frame("f1", 3, { jpeg: b64(headerJpeg(640, 360, 60_000)) });
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    const frame = stableId("ev", s.captureId, "f1");
    h.evidence.snapshotInTx([frame]);
    h.db.sql.run("INSERT INTO note_evidence (user_id, note_id, evidence_id) VALUES (?, ?, ?)", [h.db.userId, stableId("note", "cites"), frame]);
    h.evidence.sweepExpired(clock.t + 31 * 86_400_000, 30);
    expect(count(h, "frames")).toBe(0);
    expect(count(h, "evidence_snapshots")).toBe(1);

    const next = stream();
    next.control("start");
    next.frame("g1", 1, { jpeg: b64(headerJpeg(640, 360, 60_000)) });
    expect(() => h.evidence.ingest({ captureId: next.captureId, facts: next.facts })).toThrow(IngestRefused);
  });

  test("while the raw frame still exists, its hard-linked snapshot is not charged twice", () => {
    const h = harness({ limits: roomy({ maxUserBytes: 100_000 }) });
    const s = stream();
    s.control("start");
    s.source();
    s.span(0, 10);
    s.frame("f1", 3, { jpeg: b64(headerJpeg(640, 360, 40_000)) });
    h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    h.evidence.snapshotInTx([stableId("ev", s.captureId, "f1")]);
    const next = stream();
    next.control("start");
    next.frame("g1", 1, { jpeg: b64(headerJpeg(640, 360, 40_000)) });
    expect(() => h.evidence.ingest({ captureId: next.captureId, facts: next.facts })).not.toThrow();
  });
});

describe("a disk floor", () => {
  test("below the floor ingest is refused with a retryable 503, nothing is written, and above it ingest works", async () => {
    let free = 1500 * MIB;
    const { base, stored } = start(undefined, { limits: roomy({ minFreeBytes: 2000 * MIB, freeBytes: () => free }) });
    const r = await ingest(base, [wireFrame(0, b64(headerJpeg()))]);
    expect(r.status).toBe(503);
    expect(r.headers.get("Retry-After")).toBe("300");
    expect(stored()).toBe(0);
    free = 3000 * MIB;
    expect((await ingest(base, [wireFrame(0, b64(headerJpeg()))])).status).toBe(200);
    expect(stored()).toBe(1);
  });

  test("the batch's own bytes count against the floor, and no frame file is left behind", () => {
    const h = harness({ limits: roomy({ minFreeBytes: 1000, freeBytes: () => 1500 }) });
    const s = stream();
    s.control("start");
    s.frame("f0", 1, { jpeg: b64(headerJpeg(640, 360, 800)) });
    let reason = "";
    try {
      h.evidence.ingest({ captureId: s.captureId, facts: s.facts });
    } catch (e) {
      reason = (e as IngestRefused).reason;
    }
    expect(reason).toBe("disk");
    expect(existsSync(join(h.dir, "frames"))).toBe(false);
    expect(count(h, "capture_facts")).toBe(0);
  });
});

describe("the extension meets a refusal without looping or dropping the capture", () => {
  const CAP = randomId("cap");
  const body: CaptureFactBody = { kind: "channel", channel: "playback", health: "ok", videoId: null, atMediaS: media(0) as never, detail: "x" } as never;

  test("507 is not retried and not isolated, 503 is retried, and every fact stays in the outbox", async () => {
    expect(classifyStatus(507)).toMatchObject({ retryable: false });
    expect(classifyStatus(507).rejected).toBeUndefined();
    expect(classifyStatus(507).error).toContain("storage limit");
    expect(classifyStatus(503).retryable).toBe(true);
    for (const status of [507, 503]) {
      const store = createMemoryOutbox();
      for (let i = 0; i < 4; i++) await store.append(CAP, body, i);
      let calls = 0;
      const refuse: Transport = async () => {
        calls += 1;
        return { ok: false, ...classifyStatus(status) };
      };
      const out = await flushCapture(store, refuse, CAP);
      expect(calls).toBe(1);
      expect(out.retryable).toBe(status === 503);
      expect(out.remaining).toBe(4);
      expect(await store.deadLetters(CAP)).toHaveLength(0);
    }
  });
});

describe("a refusal's wait is read from the response", () => {
  test("Retry-After is whole seconds, capped, and 507 carries its own window", () => {
    expect(parseRetryAfter("300")).toBe(300_000);
    expect(parseRetryAfter("999999")).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(classifyStatus(503, "120")).toMatchObject({ retryable: true, waitMs: 120_000 });
    expect(classifyStatus(503).waitMs).toBeUndefined();
    expect(classifyStatus(507)).toMatchObject({ retryable: false, waitMs: QUOTA_RETRY_MS });
  });
});

describe("the request body limit fits the frame limit", () => {
  test("the server's limit holds a full extension batch and one frame, and the Caddyfile repeats it", async () => {
    const { MAX_BODY_BYTES } = await import("../src/backend/http");
    const { BATCH_MAX_BYTES } = await import("../src/extension/worker/outbox");
    expect(MAX_BODY_BYTES).toBeGreaterThanOrEqual(BATCH_MAX_BYTES * 2);
    expect(MAX_BODY_BYTES).toBeGreaterThan(MAX_FRAME_BASE64_CHARS * 4);
    const caddy = await Bun.file(join(import.meta.dir, "..", "infra", "beta", "files", "Caddyfile.tftpl")).text();
    expect(caddy).toContain(`max_size ${MAX_BODY_BYTES / MIB}MiB`);
  });
});
