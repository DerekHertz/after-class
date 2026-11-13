import { describe, expect, test } from "bun:test";
import { randomId, stableId } from "../src/shared/ids";
import { Material, interval } from "../src/shared/time";
import { encodeMaterial, evidenceBundleResponse, recordViewResponse, reviewViewResponse, saveResponse } from "../src/shared/wire";
import { CAP, CONCEPT, JSON_HEADERS, LINK, PAGE, VIDEO, bearer, count, ingest, post, registerCleanup, reviewRig, said, savedRig, send, start, startedIn, wireFacts } from "./http-fixtures";

registerCleanup();

describe("the record routes", () => {
  test("GET /record answers the notes, observations and links of a review in the route's schema, filtered by reviewId", async () => {
    const rig = await savedRig();
    const mine = await rig.record();
    expect(mine.notes).toHaveLength(1);
    expect(mine.observations).toHaveLength(2);
    expect(mine.links).toEqual([{ ...LINK, evidence: [...LINK.evidence], decision: "suggested" }]);
    expect((await rig.record("")).notes).toHaveLength(1);
    expect((await rig.record(`?reviewId=${randomId("rvw")}`)).notes).toEqual([]);
  });

  test("GET /record: a bad reviewId or an unknown query key is 400, a wrong token 401, a page Origin 403", async () => {
    const rig = await savedRig();
    expect((await rig.get("/record?reviewId=nope")).status).toBe(400);
    expect((await rig.get(`/record?conceptId=${CONCEPT}`)).status).toBe(400);
    expect((await fetch(`${rig.base}/record`)).status).toBe(401);
    expect((await fetch(`${rig.base}/record`, { headers: { ...bearer, Origin: PAGE } })).status).toBe(403);
  });

  test("PATCH /record/notes/:id stores the learner's wording beside the generated text and answers 204", async () => {
    const rig = await savedRig();
    const note = (await rig.record()).notes[0]!;
    const r = await send(rig.base, "PATCH", `/record/notes/${note.id}`, { text: "my own wording" });
    expect(r.status).toBe(204);
    expect(await r.text()).toBe("");
    const after = (await rig.record()).notes[0]!;
    expect(after.userEdit).toBe("my own wording");
    expect(after.generated).toEqual(note.generated);
    expect(count(rig.db, "SELECT COUNT(*) AS n FROM notes")).toBe(1);
  });

  test('R8: "Results from cancelled or outdated jobs never overwrite current preparation or my notes." Saving again keeps the edit', async () => {
    const rig = await savedRig();
    const note = (await rig.record()).notes[0]!;
    await send(rig.base, "PATCH", `/record/notes/${note.id}`, { text: "mine" });
    await post(rig.base, `/reviews/${rig.reviewId}/save`, {});
    expect((await rig.record()).notes[0]!.userEdit).toBe("mine");
  });

  test("DELETE /record/notes/:id removes the note from the view and a later save does not bring it back; answers 204", async () => {
    const rig = await savedRig();
    const note = (await rig.record()).notes[0]!;
    const r = await send(rig.base, "DELETE", `/record/notes/${note.id}`);
    expect(r.status).toBe(204);
    expect((await rig.record()).notes).toEqual([]);
    const again = saveResponse.parse(await (await post(rig.base, `/reviews/${rig.reviewId}/save`, {})).json());
    expect(again).toMatchObject({ kind: "saved", notes: 1 }); // the first save's result; the tombstone hides the note
    expect((await rig.record()).notes).toEqual([]);
  });

  test('R16: "Evidence cited by a saved note is only deleted when I delete it, never by expiry." A deleted note\'s evidence is not snapshotted again by a re-save', async () => {
    const rig = await savedRig();
    const note = (await rig.record()).notes[0]!;
    expect(note.evidence.length).toBeGreaterThan(0);
    expect(rig.snapshots.at(-1)).toEqual([...note.evidence].sort());
    await send(rig.base, "DELETE", `/record/notes/${note.id}`);
    const snapshotted = rig.snapshots.length;
    await post(rig.base, `/reviews/${rig.reviewId}/save`, {});
    expect(rig.snapshots).toHaveLength(snapshotted);
  });

  test("POST /record/links/:id accepts, rejects or corrects a suggestion; an unknown decision is 400", async () => {
    const rig = await savedRig();
    const decide = (decision: unknown) => send(rig.base, "POST", `/record/links/${LINK.id}`, { decision });
    const decision = async () => (await rig.record()).links[0]!.decision;
    expect((await decide("accepted")).status).toBe(204);
    expect(await decision()).toBe("accepted");
    expect((await decide({ corrected: "prerequisite_of" })).status).toBe(204);
    expect(await decision()).toEqual({ corrected: "prerequisite_of" });
    expect((await decide("rejected")).status).toBe(204);
    expect(await decision()).toBe("rejected");
    expect((await decide("maybe")).status).toBe(400);
    expect((await decide({ corrected: "friends_with" })).status).toBe(400);
    expect(await decision()).toBe("rejected");
  });

  test("POST /record/observations/:id/override sets the status and still passes through the clamp; a status that is not one is 400", async () => {
    const rig = await savedRig();
    const skipped = (await rig.record()).observations.find((o) => o.facts.firstSubstantiveAnswerSeq === null)!;
    expect(skipped.status).not.toBe("independent");
    const r = await send(rig.base, "POST", `/record/observations/${skipped.id}/override`, { status: "independent" });
    expect(r.status).toBe(204);
    const after = (await rig.record()).observations.find((o) => o.id === skipped.id)!;
    expect(after.status).not.toBe("independent");
    expect(after.clampedFrom).toBe("independent");
    expect((await send(rig.base, "POST", `/record/observations/${skipped.id}/override`, { status: "disputed" })).status).toBe(400);
  });

  test('R14: "A disputed assessment is never counted as a learning gap unless I resolve it that way." Resolving an observation nobody disputed changes nothing', async () => {
    const rig = await savedRig();
    const obs = (await rig.record()).observations[0]!;
    const r = await send(rig.base, "POST", `/record/observations/${obs.id}/dispute-resolution`, { outcome: "it_was_my_gap" });
    expect(r.status).toBe(204);
    const after = (await rig.record()).observations.find((o) => o.id === obs.id)!;
    expect(after.dispute).toEqual({ kind: "none" });
    expect(after.status).toBe(obs.status);
    expect((await send(rig.base, "POST", `/record/observations/${obs.id}/dispute-resolution`, { outcome: "whatever" })).status).toBe(400);
  });

  test("R14: a dispute the learner raised is settled only by their resolution", async () => {
    const rig = reviewRig();
    const reviewId = await startedIn(rig);
    await rig.turn(reviewId, { kind: "resume" });
    await rig.turn(reviewId, said("a wrong answer"));
    await rig.turn(reviewId, { kind: "dispute", text: "I think my answer was fine" });
    await rig.turn(reviewId, { kind: "end" });
    await post(rig.base, `/reviews/${reviewId}/save`, {});
    const record = async () => recordViewResponse.parse(await (await fetch(`${rig.base}/record?reviewId=${reviewId}`, { headers: bearer })).json());
    const disputed = (await record()).observations.find((o) => o.dispute.kind !== "none");
    expect(disputed).toBeDefined();
    expect(disputed!.dispute.kind).not.toBe("resolved_by_learner");
    expect(disputed!.status).toBe("disputed");
    const r = await send(rig.base, "POST", `/record/observations/${disputed!.id}/dispute-resolution`, { outcome: "learner_was_right" });
    expect(r.status).toBe(204);
    const after = (await record()).observations.find((o) => o.id === disputed!.id)!;
    expect(after.dispute).toEqual({ kind: "resolved_by_learner", outcome: "learner_was_right" });
    expect(after.status).not.toBe("disputed");
  });

  test("an unknown note, link or observation is 404 and writes nothing; a bad id is 400; a bad body is 400; a wrong token is 401", async () => {
    const rig = await savedRig();
    const note = stableId("note", "nobody");
    const obs = stableId("obs", "nobody");
    const lnk = stableId("lnk", "nobody");
    const rows = () => count(rig.db, "SELECT (SELECT COUNT(*) FROM note_edits) + (SELECT COUNT(*) FROM note_deletions) + (SELECT COUNT(*) FROM observation_decisions) + (SELECT COUNT(*) FROM link_decisions) AS n");
    expect((await send(rig.base, "PATCH", `/record/notes/${note}`, { text: "x" })).status).toBe(404);
    expect((await send(rig.base, "DELETE", `/record/notes/${note}`)).status).toBe(404);
    expect((await send(rig.base, "POST", `/record/links/${lnk}`, { decision: "accepted" })).status).toBe(404);
    expect((await send(rig.base, "POST", `/record/observations/${obs}/override`, { status: "partial" })).status).toBe(404);
    expect((await send(rig.base, "POST", `/record/observations/${obs}/dispute-resolution`, { outcome: "it_was_my_gap" })).status).toBe(404);
    expect(rows()).toBe(0);

    const real = (await rig.record()).notes[0]!.id;
    expect((await send(rig.base, "PATCH", "/record/notes/nope", { text: "x" })).status).toBe(400);
    expect((await send(rig.base, "DELETE", `/record/notes/${CAP}`)).status).toBe(400);
    expect((await send(rig.base, "PATCH", `/record/notes/${real}`, "not json")).status).toBe(400);
    expect((await send(rig.base, "PATCH", `/record/notes/${real}`, { text: 7 })).status).toBe(400);
    expect((await send(rig.base, "PATCH", `/record/notes/${real}`, { text: "x".repeat(20_001) })).status).toBe(400);
    expect((await send(rig.base, "PATCH", `/record/notes/${real}`, { text: "x" }, { "Content-Type": "application/json" })).status).toBe(401);
    expect((await send(rig.base, "PATCH", `/record/notes/${real}`, { text: "x" }, { ...JSON_HEADERS, Origin: PAGE })).status).toBe(403);
    expect(rows()).toBe(0);
  });
});

describe("the evidence routes", () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const FRAME_FACT = { kind: "frame", videoId: VIDEO, frameId: "f1", mediaS: 5, width: 640, height: 360, trigger: "change_settled", diff: 0.4, jpegBase64: JPEG.toString("base64") };
  const TRANSCRIPT = {
    kind: "transcript", videoId: VIDEO, origin: "panel", language: "en", autoGenerated: false,
    segments: [{ start: 0, end: 4, text: "watched words" }, { start: 30, end: 34, text: "never watched" }],
  };

  /** One capture: a watched span [0, 5), a transcript with one segment inside it and one outside, and a frame at 3 s. */
  async function captured() {
    const w = start();
    const facts = [
      ...wireFacts(0, 3),
      { ...TRANSCRIPT, clientSeq: 3, wallMs: 1100 },
      { ...FRAME_FACT, mediaS: 3, clientSeq: 4, wallMs: 1200 },
    ];
    expect((await ingest(w.base, facts)).status).toBe(200);
    const get = async (path: string) => {
      const r = await fetch(`${w.base}${path}`, { headers: bearer });
      return { status: r.status, body: (await r.json()) as Record<string, any> };
    };
    const bundle = await get(`/evidence?captureId=${CAP}`);
    const parsed = evidenceBundleResponse.parse(bundle.body);
    return { ...w, get, bundle, parsed, passage: parsed.passages[0]!, frame: parsed.frames[0]! };
  }

  test('R1: "Evidence only comes from intervals I actually watched while capture was on." GET /evidence?captureId= answers the watched passages and frames only', async () => {
    const c = await captured();
    expect(c.bundle.status).toBe(200);
    expect(c.parsed.passages.map((p) => p.text)).toEqual(["watched words"]);
    expect(c.parsed.frames).toHaveLength(1);
    expect(c.bundle.body.material).toEqual([[expect.any(String), [[0, 5]]]]);
  });

  test("GET /evidence?ids= answers the passages and frames asked for, and leaves out ids it does not know", async () => {
    const c = await captured();
    const r = await c.get(`/evidence?ids=${c.passage.id},${c.frame.id},${stableId("ev", "unknown")}`);
    expect(r.status).toBe(200);
    const parsed = evidenceBundleResponse.parse(r.body);
    expect(parsed.passages.map((p) => p.id)).toEqual([c.passage.id]);
    expect(parsed.frames.map((f) => f.id)).toEqual([c.frame.id]);
  });

  test("GET /evidence?material= answers what lies inside the material; Material crosses as canonical rows", async () => {
    const c = await captured();
    const src = c.parsed.passages[0]!.sourceId;
    const ask = (m: Material) => c.get(`/evidence?material=${encodeURIComponent(encodeMaterial(m))}`);
    const inside = evidenceBundleResponse.parse((await ask(Material.of([[src, [interval(0, 5)]]]))).body);
    expect(inside.passages).toHaveLength(1);
    const outside = evidenceBundleResponse.parse((await ask(Material.of([[src, [interval(100, 110)]]]))).body);
    expect(outside.passages).toEqual([]);
    expect(outside.frames).toEqual([]);
  });

  test("a bad evidence query is 400: none or two of material, ids, captureId; a bad id; material that is not JSON; an unknown key; a wrong token is 401", async () => {
    const c = await captured();
    for (const q of ["", `?captureId=${CAP}&ids=${c.passage.id}`, "?ids=nope", `?ids=${CAP}`, "?ids=", "?material=not-json", "?material=%5B%5B%22x%22%5D%5D", "?captureId=nope", `?captureId=${CAP}&extra=1`]) {
      expect(`${q}: ${(await c.get(`/evidence${q}`)).status}`).toBe(`${q}: 400`);
    }
    expect((await fetch(`${c.base}/evidence?captureId=${CAP}`)).status).toBe(401);
    expect((await fetch(`${c.base}/evidence?captureId=${CAP}`, { headers: { ...bearer, Origin: PAGE } })).status).toBe(403);
  });

  test("GET /frames/:id answers the stored JPEG bytes; an unknown frame is 404, a bad id 400, a wrong token 401", async () => {
    const c = await captured();
    const r = await fetch(`${c.base}/frames/${c.frame.id}`, { headers: bearer });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await r.arrayBuffer())).toEqual(JPEG);
    expect((await fetch(`${c.base}/frames/${stableId("ev", "none")}`, { headers: bearer })).status).toBe(404);
    expect((await fetch(`${c.base}/frames/nope`, { headers: bearer })).status).toBe(400);
    expect((await fetch(`${c.base}/frames/${c.frame.id}`)).status).toBe(401);
  });

  test("POST /record/evidence/delete removes the evidence from every lookup and its frame image, and answers 204; deleting twice is the same", async () => {
    const c = await captured();
    const r = await post(c.base, "/record/evidence/delete", { evidenceIds: [c.passage.id, c.frame.id] });
    expect(r.status).toBe(204);
    expect(await r.text()).toBe("");
    expect(evidenceBundleResponse.parse((await c.get(`/evidence?captureId=${CAP}`)).body)).toMatchObject({ passages: [], frames: [] });
    expect(evidenceBundleResponse.parse((await c.get(`/evidence?ids=${c.passage.id}`)).body).passages).toEqual([]);
    expect((await fetch(`${c.base}/frames/${c.frame.id}`, { headers: bearer })).status).toBe(404);
    const tombstones = count(c.db, "SELECT COUNT(*) AS n FROM evidence_deletions");
    expect((await post(c.base, "/record/evidence/delete", { evidenceIds: [c.passage.id] })).status).toBe(204);
    expect(count(c.db, "SELECT COUNT(*) AS n FROM evidence_deletions")).toBe(tombstones);
  });

  test("evidence delete: an empty or bad id list, non-JSON and a wrong token write nothing", async () => {
    const c = await captured();
    for (const body of [{ evidenceIds: [] }, { evidenceIds: ["nope"] }, { evidenceIds: c.passage.id }, {}, "not json"]) {
      expect((await post(c.base, "/record/evidence/delete", body)).status).toBe(400);
    }
    expect((await post(c.base, "/record/evidence/delete", { evidenceIds: [c.passage.id] }, { "Content-Type": "application/json" })).status).toBe(401);
    expect(count(c.db, "SELECT COUNT(*) AS n FROM evidence_deletions")).toBe(0);
  });
});

describe("ReviewView.saved is the persisted save state", () => {
  test("it reads the record's tables, not this process's memory: a failure marker or a saved row from before a restart shows", async () => {
    const rig = reviewRig();
    const reviewId = await startedIn(rig);
    expect((await rig.view(reviewId)).body.saved).toBe("unsaved");
    rig.db.sql.run("INSERT INTO save_failures (user_id, review_id, error, failed_ms) VALUES (?, ?, 'earlier run', 0)", [rig.db.userId, reviewId]);
    expect((await rig.view(reviewId)).body.saved).toBe("save_pending");
    rig.db.sql.run("INSERT INTO saved_reviews (user_id, review_id, bundle_hash, saved_ms) VALUES (?, ?, 'h', 0)", [rig.db.userId, reviewId]);
    const view = await rig.view(reviewId);
    reviewViewResponse.parse(view.body);
    expect(view.body.saved).toBe("saved");
  });
});
