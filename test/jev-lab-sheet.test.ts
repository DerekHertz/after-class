/**
 * Experiment 2's labeling sheet, offline. The export logic is checked against the lab's own `validateLabels` and
 * `loadLabels`; the generator is run on a capture built on disk, and the page is parsed, never executed here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/backend/db";
import { createEvidence } from "../src/backend/evidence";
import type { CaptureFact, CaptureFactBody } from "../src/shared/domain";
import { randomId, stableId } from "../src/shared/ids";
import type { CaptureId, MemoKey } from "../src/shared/ids";
import { media } from "../src/shared/time";
import { loadLabels } from "../scripts/jev-lab";
import { splitPoint, validateLabels } from "../scripts/jev-lab-score";
import type { LabelFile } from "../scripts/jev-lab-score";
import { generateSheet, jsonForScript } from "../scripts/jev-lab-sheet";
import {
  evaluate, fmtTime, initialState, isMarked, labelJson, makeGroup, midpointOf, removeItem, removeMember, restoreState, setNote, setSignature, setStatus, toggleMark, watchUrl,
} from "../scripts/jev-lab-sheet-client";
import type { SheetState } from "../scripts/jev-lab-sheet-client";

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `afterclass-sheet-${name}-`));
  cleanup.push(dir);
  return dir;
};

const draft = (over: Partial<LabelFile> = {}): LabelFile => ({
  schemaVersion: 1,
  status: "draft",
  signedOffBy: null,
  signedOffAt: null,
  description: "DRAFT labels. Not Derek's labels until he corrects them and signs off.",
  lecture: { captureId: "cap_x", videoId: "aaaaaaaaaaa", title: "Lecture", spanS: { start: 0, end: 100 } },
  boundaries: [{ mediaS: 20, note: "candidate topic boundary", confirmed: false, cue: "caption pause of 4s before this point" }],
  visualSteps: [{ mediaS: 50, note: "candidate visual step", confirmed: false, cue: "jpeg size jump" }],
  duplicateGroups: [{ note: "candidate duplicate group", confirmed: false, cue: "byte-identical JPEG files", frames: [{ mediaS: 10, frameId: "ev_1" }, { mediaS: 90, frameId: "ev_2" }] }],
  ...over,
});

const confirmAll = (s: SheetState): SheetState => {
  let out = s;
  for (const m of s.boundaries) out = setStatus(out, "boundaries", m.id, "confirmed");
  for (const m of s.visualSteps) out = setStatus(out, "visualSteps", m.id, "confirmed");
  for (const g of s.groups) out = setStatus(out, "groups", g.id, "confirmed");
  return out;
};

const valid = (labels: LabelFile) => {
  const r = validateLabels(JSON.parse(labelJson(labels)));
  expect(r.ok ? [] : r.errors).toEqual([]);
};

describe("export logic against validateLabels", () => {
  test("a draft with unconfirmed items stays a draft with null name and date, and validates", () => {
    const d = draft();
    const out = evaluate(initialState(d), d);
    expect(out.labels.status).toBe("draft");
    expect(out.labels.signedOffBy).toBeNull();
    expect(out.labels.signedOffAt).toBeNull();
    expect(out.labels.boundaries[0]).toEqual(d.boundaries[0]!);
    expect(out.labels.duplicateGroups[0]).toEqual(d.duplicateGroups[0]!);
    expect(out.blockers.filter((b) => b.code === "unconfirmed")).toHaveLength(3);
    valid(out.labels);
  });

  test("a typed name and date do not sign off while an item is unconfirmed, and nothing is pre-filled", () => {
    const d = draft({ status: "signed_off", signedOffBy: "Someone", signedOffAt: "2026-01-01" });
    expect(initialState(d).signedOffBy).toBe("");
    expect(initialState(d).signedOffAt).toBe("");
    const out = evaluate(setSignature(initialState(draft()), "Derek", "2026-11-05"), draft());
    expect(out.labels.status).toBe("draft");
    expect(out.labels.signedOffBy).toBeNull();
    valid(out.labels);
  });

  test("everything confirmed plus a name and an ISO date becomes signed_off, validates, and loads through loadLabels", () => {
    const d = draft();
    const out = evaluate(setSignature(confirmAll(initialState(d)), "  Derek Hertzell ", "2026-11-05"), d);
    expect(out.blockers).toEqual([]);
    expect(out.labels.status).toBe("signed_off");
    expect(out.labels.signedOffBy).toBe("Derek Hertzell");
    expect(out.labels.signedOffAt).toBe("2026-11-05");
    expect(out.labels.boundaries.every((b) => b.confirmed)).toBe(true);
    expect(out.labels.boundaries[0]!.cue).toBe("caption pause of 4s before this point");
    valid(out.labels);

    const file = join(tmp("signed"), "labels.json");
    writeFileSync(file, labelJson(out.labels));
    expect(loadLabels([file])[0]!.labels.status).toBe("signed_off");
  });

  test("a missing name, a missing date and a bad date each block the sign-off", () => {
    const d = draft();
    const all = confirmAll(initialState(d));
    expect(evaluate(all, d).blockers.map((b) => b.code).sort()).toEqual(["date", "name"]);
    expect(evaluate(setSignature(all, "Derek", ""), d).blockers.map((b) => b.code)).toEqual(["date"]);
    const bad = evaluate(setSignature(all, "Derek", "next tuesday"), d);
    expect(bad.blockers.map((b) => b.code)).toEqual(["date"]);
    expect(bad.labels.status).toBe("draft");
    valid(bad.labels);
  });

  test("a time outside the half-open span is a blocker and is left out so the file still validates", () => {
    const d = draft();
    let s = confirmAll(initialState(d));
    s = toggleMark(s, "boundaries", 100);
    s = toggleMark(s, "visualSteps", -5);
    const out = evaluate(setSignature(s, "Derek", "2026-11-05"), d);
    expect(out.blockers.filter((b) => b.code === "outside_span")).toHaveLength(2);
    expect(out.labels.status).toBe("draft");
    expect(out.labels.boundaries.map((b) => b.mediaS)).toEqual([20]);
    valid(out.labels);
    const fixed = evaluate(setSignature(removeItem(removeItem(s, "boundaries", s.boundaries.find((m) => m.mediaS === 100)!.id), "visualSteps", s.visualSteps.find((m) => m.mediaS === -5)!.id), "Derek", "2026-11-05"), d);
    expect(fixed.labels.status).toBe("signed_off");
    valid(fixed.labels);
  });

  test("a duplicate group of one frame is a blocker and is left out", () => {
    const d = draft();
    const s = removeMember(confirmAll(initialState(d)), "dg0", 1);
    const out = evaluate(setSignature(s, "Derek", "2026-11-05"), d);
    expect(out.blockers.map((b) => b.code)).toEqual(["group_size"]);
    expect(out.labels.status).toBe("draft");
    expect(out.labels.duplicateGroups).toEqual([]);
    valid(out.labels);
  });

  test("rejecting a candidate removes it from the export and from the blockers", () => {
    const d = draft();
    let s = confirmAll(initialState(d));
    s = setStatus(s, "boundaries", "db0", "rejected");
    const out = evaluate(setSignature(s, "Derek", "2026-11-05"), d);
    expect(out.labels.boundaries).toEqual([]);
    expect(out.labels.status).toBe("signed_off");
    valid(out.labels);
    expect(evaluate(setStatus(initialState(d), "boundaries", "db0", "rejected"), d).blockers.some((b) => b.message.startsWith("Boundary"))).toBe(false);
  });

  test("a note round-trips through the export and through the saved state", () => {
    const d = draft();
    let s = confirmAll(initialState(d));
    s = toggleMark(s, "boundaries", 33.5);
    const added = s.boundaries.find((m) => m.mediaS === 33.5)!;
    s = setNote(setNote(s, "boundaries", added.id, "he starts \"CPU scheduling\" <b>here</b>"), "visualSteps", "dv0", "the slide changes to a table");
    const out = evaluate(s, d);
    const parsed = JSON.parse(labelJson(out.labels)) as LabelFile;
    expect(parsed.boundaries.find((b) => b.mediaS === 33.5)).toEqual({ mediaS: 33.5, note: "he starts \"CPU scheduling\" <b>here</b>", confirmed: true });
    expect(parsed.visualSteps[0]!.note).toBe("the slide changes to a table");
    expect(restoreState(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  test("the draft's cue and the user's own additions: added items are confirmed and carry no cue", () => {
    const d = draft();
    const s = toggleMark(initialState(d), "visualSteps", 70);
    const added = evaluate(s, d).labels.visualSteps.find((v) => v.mediaS === 70)!;
    expect(added).toEqual({ mediaS: 70, note: "", confirmed: true });
  });

  test("any mix of actions leaves a file that validates, and signed_off exactly when nothing blocks", () => {
    const d = draft();
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 300; round++) {
      let s = initialState(d);
      for (let step = 0; step < 8; step++) {
        const t = [-3, 0, 20, 33.25, 50, 99.9, 100, 140][rnd(8)]!;
        switch (rnd(8)) {
          case 0: s = toggleMark(s, "boundaries", t); break;
          case 1: s = toggleMark(s, "visualSteps", t); break;
          case 2: s = confirmAll(s); break;
          case 3: s = setStatus(s, "groups", "dg0", (["unconfirmed", "confirmed", "rejected"] as const)[rnd(3)]!); break;
          case 4: s = removeMember(s, "dg0", rnd(2)); break;
          case 5: s = makeGroup(s, [{ mediaS: t }, { mediaS: t + 1 }]); break;
          case 6: s = setSignature(s, ["", "Derek"][rnd(2)]!, ["", "2026-11-05", "junk", "2026-13-45"][rnd(4)]!); break;
          default: s = setStatus(s, "boundaries", "db0", (["unconfirmed", "confirmed", "rejected"] as const)[rnd(3)]!);
        }
      }
      const out = evaluate(s, d);
      const checked = validateLabels(JSON.parse(labelJson(out.labels)));
      expect(checked.ok ? [] : checked.errors).toEqual([]);
      expect(out.labels.status === "signed_off").toBe(out.blockers.length === 0);
    }
  });

  test("toggling a mark: add, confirm a draft, then undo", () => {
    const d = draft();
    let s = toggleMark(initialState(d), "boundaries", 20);
    expect(isMarked(s, "boundaries", 20)).toBe(true);
    expect(s.boundaries).toHaveLength(1);
    s = toggleMark(s, "boundaries", 20);
    expect(s.boundaries[0]!.status).toBe("unconfirmed");
    s = toggleMark(toggleMark(s, "boundaries", 61), "boundaries", 61);
    expect(s.boundaries.map((b) => b.mediaS)).toEqual([20]);
  });

  test("a group needs two distinct frames; ungrouping a user group removes it", () => {
    const d = draft();
    const s = initialState(d);
    expect(makeGroup(s, [{ mediaS: 5, frameId: "a" }, { mediaS: 5, frameId: "a" }])).toBe(s);
    const g = makeGroup(s, [{ mediaS: 30, frameId: "b" }, { mediaS: 5, frameId: "a" }]);
    expect(g.groups[1]!.frames.map((f) => f.frameId)).toEqual(["a", "b"]);
    expect(removeItem(g, "groups", g.groups[1]!.id).groups).toHaveLength(1);
  });

  test("saved state that is not the exact shape is refused", () => {
    expect(restoreState(null)).toBeNull();
    expect(restoreState({ boundaries: "x" })).toBeNull();
    const s = initialState(draft());
    expect(restoreState({ ...s, boundaries: [{ id: "x", note: 1, status: "confirmed", fromDraft: false, mediaS: 1 }] })).toBeNull();
    expect(restoreState({ ...s, nextId: "3" })).toBeNull();
  });

  test("the midpoint is the lab's split point, and times print as mm:ss", () => {
    for (const span of [{ start: 0, end: 229.421 }, { start: 0.005051, end: 184.341 }]) expect(midpointOf(span)).toBe(splitPoint(span));
    expect(fmtTime(75.9)).toBe("01:15");
    expect(fmtTime(3725)).toBe("1:02:05");
  });
});

describe("YouTube links", () => {
  test("a valid id builds the watch link at whole seconds", () => {
    expect(watchUrl("aaaaaaaaaaa", 75.9)).toBe("https://www.youtube.com/watch?v=aaaaaaaaaaa&t=75s");
    expect(watchUrl("A_b-C1d2E3f", 0)).toBe("https://www.youtube.com/watch?v=A_b-C1d2E3f&t=0s");
  });

  test("a bad id never becomes a link", () => {
    for (const bad of ["", "short", "aaaaaaaaaaaa", "aaaaaaaaaa\"", "aaaaaaaaa&t=", "aaaaaaaaaa/", "javascript:1", "aaaaaaaaaa\n"]) expect(() => watchUrl(bad, 1)).toThrow("refusing");
    expect(() => watchUrl("aaaaaaaaaaa", Number.NaN)).toThrow("refusing");
  });
});

// ───────────────────────────── the generator on a capture on disk ─────────────────────────────

const VIDEO = "aaaaaaaaaaa";
const jpeg = (n: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, n, n + 1, n + 2, 4]).toString("base64");
const EVIL_TITLE = `Evil </title><script>window.__pwned=0</script> & "quotes"`;
const IMG_PAYLOAD = `<img src=x onerror="window.__pwned=1">`;
const SCRIPT_PAYLOAD = `</script><script>window.__pwned=2</script><!--`;

function fixture(videoId = VIDEO) {
  const dir = tmp("data");
  const db = openDb(join(dir, "afterclass.sqlite"));
  const keyOf = (input: { readonly after: { readonly frame: { readonly id: string } } }): MemoKey => stableId("key", "frame_change", input.after.frame.id);
  const evidence = createEvidence(db, dir, { lookupFrameChange: (i) => ({ kind: "missing", key: keyOf(i) }), runFrameChange: async () => undefined, frameChangeKey: keyOf, onChange: () => {} });
  const captureId = randomId("cap");
  const bodies: CaptureFactBody[] = [
    { kind: "control", action: "start", reason: "user" },
    { kind: "source", videoId, title: EVIL_TITLE, channelName: "Prof", url: "https://www.youtube.com/watch?v=x", durationS: 600 },
    {
      kind: "transcript", videoId, origin: "panel", language: "en", autoGenerated: false,
      segments: [
        { start: media(2), end: media(4), text: "hello there" },
        { start: media(10), end: media(14), text: IMG_PAYLOAD },
        { start: media(20), end: media(25), text: SCRIPT_PAYLOAD },
        { start: media(30), end: media(32), text: "line\u2028sep\u2029end see http://example.com/x" },
      ],
    },
    { kind: "span", videoId, start: media(0), end: media(120), rate: 1, tabVisible: true, wallDurationMs: 120_000 },
    { kind: "frame", videoId, frameId: "f1", mediaS: media(10), width: 640, height: 360, trigger: "change_settled", diff: 0.4, jpegBase64: jpeg(1) },
    { kind: "frame", videoId, frameId: "f2", mediaS: media(50), width: 640, height: 360, trigger: "change_settled", diff: 0.4, jpegBase64: jpeg(9) },
    { kind: "frame", videoId, frameId: "f3", mediaS: media(90), width: 640, height: 360, trigger: "change_settled", diff: 0.4, jpegBase64: jpeg(1) },
    { kind: "control", action: "stop", reason: "user" },
  ];
  evidence.ingest({ captureId: captureId as CaptureId, facts: bodies.map((b, i) => ({ captureId, clientSeq: i, wallMs: 1000 + i, ...b }) as CaptureFact) });
  db.close();
  const labels: LabelFile = draft({
    lecture: { captureId, videoId, title: EVIL_TITLE, spanS: { start: 0, end: 120 } },
    boundaries: [{ mediaS: 20, note: SCRIPT_PAYLOAD, confirmed: false, cue: IMG_PAYLOAD }],
    visualSteps: [{ mediaS: 50, note: "candidate visual step", confirmed: false }],
    duplicateGroups: [],
  });
  const labelsFile = join(tmp("labels"), `${videoId}.json`);
  writeFileSync(labelsFile, JSON.stringify(labels, null, 2));
  return { dir, captureId, labelsFile, labels };
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

const dataOf = (html: string): { readonly body: string; readonly end: number } => {
  const open = html.indexOf('<script type="application/json" id="sheet-data">');
  expect(open).toBeGreaterThan(-1);
  const start = html.indexOf(">", open) + 1;
  return { body: html.slice(start, html.indexOf("</script", start)), end: html.indexOf("</script", start) };
};

describe("the generator", () => {
  test("writes one self-contained page per lecture and an index, and the data tag cannot be closed early", async () => {
    const { dir, labelsFile, captureId } = fixture();
    const out = join(tmp("out"), "sheet");
    const done = await generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: out });
    expect(readdirSync(out).sort()).toEqual([`${VIDEO}.html`, "index.html"]);
    expect(done.files.map((f) => f.bytes).every((n) => n > 0)).toBe(true);

    const html = readFileSync(join(out, `${VIDEO}.html`), "utf8");
    const data = dataOf(html);
    expect(data.body).not.toMatch(/<|\u2028|\u2029/);
    const parsed = JSON.parse(data.body) as { passages: { text: string }[]; frames: { src: string }[]; draft: LabelFile; videoId: string };
    expect(parsed.passages.map((p) => p.text)).toContain(IMG_PAYLOAD);
    expect(parsed.passages.map((p) => p.text)).toContain(SCRIPT_PAYLOAD);
    expect(parsed.passages.some((p) => p.text.includes("\u2028sep\u2029"))).toBe(true);
    expect(parsed.draft.lecture.captureId).toBe(captureId);
    expect(parsed.frames).toHaveLength(3);
    expect(parsed.frames[0]!.src.startsWith("data:image/jpeg;base64,")).toBe(true);

    const scriptTags = html.match(/<script\b/gi) ?? [];
    expect(scriptTags).toHaveLength(2);
    const outsideData = html.replace(data.body, "");
    expect(outsideData).not.toContain("<img src=x");
    expect(outsideData).not.toContain("<script>window");
    expect(outsideData).not.toContain("</title><script");
    expect(html.match(/<title>[^<]*<\/title>/)![0]).toContain("&lt;/title&gt;");
    expect(html.replace(/<script[\s\S]*?<\/script>/g, "")).not.toMatch(/<[a-z][^>]*\son\w+\s*=/i);
  });

  test("the page makes no network reference: only the YouTube watch-link prefix, and no fetch, socket or import", async () => {
    const { dir, labelsFile } = fixture();
    const out = join(tmp("out"), "sheet");
    await generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: out });
    for (const file of [`${VIDEO}.html`, "index.html"]) {
      const html = readFileSync(join(out, file), "utf8");
      const code = file === "index.html" ? html : html.replace(dataOf(html).body, "");
      const urls = code.match(/(?:https?|wss?|ftp):\/\/[^\s"'`)<>]*/gi) ?? [];
      expect(urls.filter((u) => !u.startsWith("https://www.youtube.com/watch?v="))).toEqual([]);
      expect(code).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|importScripts|\bimport\s*\(|<link\b|<iframe\b|@import|url\(/);
      expect(html).toContain("Content-Security-Policy");
      expect(html).toContain("default-src 'none'");
    }
    const index = readFileSync(join(out, "index.html"), "utf8");
    expect(index).toContain(`href="${VIDEO}.html"`);
    expect(index).not.toContain("<script");
    expect(index).toContain("&lt;/title&gt;");
    expect(index).toContain("3 frames");
    expect(index).toContain("10:00");
    expect(index).toContain("01:00");
  });

  test("jsonForScript escapes < and the two line separators", () => {
    const text = jsonForScript({ a: "</script><!-- \u2028 \u2029 >" });
    expect(text).not.toMatch(/<|\u2028|\u2029/);
    expect(JSON.parse(text)).toEqual({ a: "</script><!-- \u2028 \u2029 >" });
  });

  test("refuses an --out inside the data dir, or equal to it, and writes nothing", async () => {
    const { dir, labelsFile } = fixture();
    const before = hashTree(dir);
    for (const out of [join(dir, "sheet"), dir, join(dir, "frames", "deep")]) {
      await expect(generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: out })).rejects.toThrow("inside the data dir");
    }
    expect(hashTree(dir)).toEqual(before);
  });

  test("refuses an --out reached through a symlink into the data dir", async () => {
    const { dir, labelsFile } = fixture();
    const link = join(tmp("link"), "alias");
    (await import("node:fs")).symlinkSync(dir, link);
    await expect(generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: join(link, "sheet") })).rejects.toThrow("inside the data dir");
  });

  test("refuses a label file that fails validation, naming the field", async () => {
    const { dir, labelsFile, labels } = fixture();
    const bad = join(tmp("badlabels"), "bad.json");
    writeFileSync(bad, JSON.stringify({ ...labels, status: "signed_off" }));
    const out = join(tmp("out"), "sheet");
    await expect(generateSheet({ dataDir: dir, labelFiles: [bad], outDir: out })).rejects.toThrow("signedOffBy");
    expect(existsSync(out)).toBe(false);
    expect(labelsFile).toBeTruthy();
  });

  test("refuses a video id that is not an 11-character YouTube id, so it never becomes a file name or a link", async () => {
    const { dir, labels } = fixture();
    const evil = join(tmp("evil"), "evil.json");
    writeFileSync(evil, JSON.stringify({ ...labels, lecture: { ...labels.lecture, videoId: "../../escape" } }));
    const out = join(tmp("out"), "sheet");
    await expect(generateSheet({ dataDir: dir, labelFiles: [evil], outDir: out })).rejects.toThrow("not a YouTube video id");
    expect(existsSync(out)).toBe(false);
  });

  test("leaves the source data dir byte for byte as it was", async () => {
    const { dir, labelsFile } = fixture();
    const before = hashTree(dir);
    expect(Object.keys(before).some((k) => k.includes("frames"))).toBe(true);
    await generateSheet({ dataDir: dir, labelFiles: [labelsFile], outDir: join(tmp("out"), "sheet") });
    expect(hashTree(dir)).toEqual(before);
  });

  test("a capture with no frames or passages for the lecture is refused rather than written empty", async () => {
    const { dir, labels } = fixture();
    const other = join(tmp("other"), "other.json");
    mkdirSync(join(other, ".."), { recursive: true });
    writeFileSync(other, JSON.stringify({ ...labels, lecture: { ...labels.lecture, videoId: "bbbbbbbbbbb" } }));
    await expect(generateSheet({ dataDir: dir, labelFiles: [other], outDir: join(tmp("out"), "sheet") })).rejects.toThrow("no passages or frames");
  });
});
