/**
 * Phase 1 step 4 of the hosting plan: every route that takes an id answers 404 to a second user who presents the first
 * user's id, and changes nothing. `CASES` has an entry for every route in `ROUTES` (a new route is a type error until it
 * has one), a route whose path has a parameter may not be listed as taking no id, and the owner's own request with the
 * same id must not be a 404, so the ids are real.
 */
import { describe, expect, test } from "bun:test";
import { ensureLocalUser, scopeDb } from "../src/backend/db";
import { randomId, stableId } from "../src/shared/ids";
import type { CaptureId, ConceptId, EvidenceId } from "../src/shared/ids";
import { ROUTES, routeUrl } from "../src/shared/wire";
import type { RouteName } from "../src/shared/wire";
import { stream } from "./evidence-fixtures";
import { JSON_HEADERS, bearer, pick, registerCleanup, reviewRig, said, savedRig, send } from "./http-fixtures";
import { otherUserDb, testDb } from "./fakes";

registerCleanup();

type Ids = {
  readonly captureId: CaptureId;
  readonly reviewId: string;
  readonly frameId: EvidenceId;
  readonly noteId: string;
  readonly linkId: string;
  readonly observationId: string;
  readonly topicId: ConceptId;
};

type Call = { readonly request: (base: string, ids: Ids) => Promise<Response>; readonly bStatus: number; readonly ownerSkipped?: string };

const get = (path: string) => (base: string) => fetch(`${base}${path}`, { headers: bearer });
const url = <N extends RouteName>(name: N, params: Record<string, string>) => routeUrl(ROUTES[name] as never, params as never);

/** `none`: the route takes no id, so there is nothing to present. Anything else lists the requests a second user makes. */
const CASES: { readonly [N in RouteName]: "none" | ((ids: Ids) => readonly Call[]) } = {
  ingest: (ids) => [{
    request: (base) => send(base, "POST", "/ingest", { captureId: ids.captureId, facts: [{ kind: "control", action: "start", reason: "user", clientSeq: 0, wallMs: 1000 }] }),
    bStatus: 404,
  }],
  lectures: "none",
  captureView: () => [{ request: (base, ids) => get(url("captureView", { captureId: ids.captureId }))(base), bStatus: 404 }],
  answerInvite: () => [{ request: (base, ids) => send(base, "POST", url("answerInvite", { captureId: ids.captureId }), { answer: "later" }), bStatus: 404 }],
  reviewOptions: () => [{ request: (base, ids) => get(url("reviewOptions", { captureId: ids.captureId }))(base), bStatus: 404 }],
  startReview: () => [
    { request: (base, ids) => send(base, "POST", url("startReview", { captureId: ids.captureId }), { reviewId: randomId("rvw"), choice: "prepared_only" }), bStatus: 404 },
  ],
  sendTurn: () => [{ request: (base, ids) => send(base, "POST", url("sendTurn", { reviewId: ids.reviewId }), { turnId: randomId("turn"), act: said("hi") }), bStatus: 404 }],
  review: () => [{ request: (base, ids) => get(url("review", { reviewId: ids.reviewId }))(base), bStatus: 404 }],
  save: () => [{ request: (base, ids) => send(base, "POST", url("save", { reviewId: ids.reviewId }), {}), bStatus: 404 }],
  diagrams: () => [{ request: (base, ids) => get(url("diagrams", { reviewId: ids.reviewId }))(base), bStatus: 404 }],
  requestDiagram: () => [
    {
      request: (base, ids) => send(base, "POST", url("requestDiagram", { reviewId: ids.reviewId, topicId: ids.topicId }), {}),
      bStatus: 404,
      ownerSkipped: "the fixture review has no topics, so its owner gets 404 for the topic",
    },
  ],
  record: () => [{ request: (base, ids) => get(`/record?reviewId=${ids.reviewId}`)(base), bStatus: 404 }],
  usage: "none",
  evidence: () => [
    { request: (base, ids) => get(`/evidence?captureId=${ids.captureId}`)(base), bStatus: 404 },
    // Documented no-op: evidence ids and material another user holds read as an id nobody holds, an empty bundle.
    { request: (base, ids) => get(`/evidence?ids=${ids.frameId}`)(base), bStatus: 200 },
  ],
  frameImage: () => [{ request: (base, ids) => get(url("frameImage", { evidenceId: ids.frameId }))(base), bStatus: 404 }],
  editNote: () => [{ request: (base, ids) => send(base, "PATCH", url("editNote", { noteId: ids.noteId }), { text: "stolen" }), bStatus: 404 }],
  deleteNote: () => [{ request: (base, ids) => send(base, "DELETE", url("deleteNote", { noteId: ids.noteId })), bStatus: 404 }],
  decideLink: () => [{ request: (base, ids) => send(base, "POST", url("decideLink", { linkId: ids.linkId }), { decision: "accepted" }), bStatus: 404 }],
  resolveDispute: () => [
    { request: (base, ids) => send(base, "POST", url("resolveDispute", { observationId: ids.observationId }), { outcome: "it_was_my_gap" }), bStatus: 404 },
  ],
  overrideObservation: () => [
    { request: (base, ids) => send(base, "POST", url("overrideObservation", { observationId: ids.observationId }), { status: "independent" }), bStatus: 404 },
  ],
  deleteEvidence: () => [{ request: (base, ids) => send(base, "POST", "/record/evidence/delete", { evidenceIds: [ids.frameId] }), bStatus: 404 }],
  retryPreparation: () => [{ request: (base, ids) => send(base, "POST", url("retryPreparation", { captureId: ids.captureId }), {}), bStatus: 404 }],
  voiceStatus: "none",
  speak: "none",
};

async function world() {
  const raw = testDb();
  const alice = await savedRig(scopeDb(raw, ensureLocalUser(raw)));
  const bob = await savedRig(otherUserDb(raw, "bob"));
  const s = stream(alice.capture);
  s.control("start");
  s.source();
  s.span(0, 10);
  s.frame("f1", 3);
  alice.evidence.ingest({ captureId: s.captureId, facts: s.facts });
  // A link id derives from concept ids that every user watching the lecture shares, so the owner's own link is one only it holds.
  const onlyAlice = stableId("lnk", "only-alice");
  raw.sql.run(
    "INSERT INTO link_suggestions (user_id, id, ord, review_id, from_concept, to_concept, type, evidence_json, rationale, saved_ms) VALUES (?, ?, 99, ?, ?, ?, 'part_of', '[]', 'why', 0)",
    [alice.db.userId, onlyAlice, alice.reviewId, stableId("cpt", "a"), stableId("cpt", "b")],
  );
  const mine = await alice.record();
  const ids: Ids = {
    captureId: alice.capture,
    reviewId: alice.reviewId,
    frameId: stableId("ev", alice.capture, "f1"),
    noteId: mine.notes[0]!.id,
    linkId: onlyAlice,
    observationId: mine.observations[0]!.id,
    topicId: stableId("cpt", "c"),
  };
  return { raw, alice, bob, ids };
}

describe("every route that takes an id", () => {
  test("is covered: each route is in the table, and one with a path parameter or an id in its request is not marked as taking none", () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(ROUTES).sort());
    for (const [name, route] of Object.entries(ROUTES)) {
      if (route.path.includes(":")) expect(CASES[name as RouteName], name).not.toBe("none");
    }
    expect(Object.entries(CASES).filter(([, c]) => c === "none").map(([n]) => n).sort()).toEqual(["lectures", "speak", "usage", "voiceStatus"]);
  });

  test("answers a second user who presents the first user's id with 404 and changes nothing, and answers the owner", async () => {
    const { raw, alice, bob, ids } = await world();
    const state = () =>
      JSON.stringify(
        ["capture_facts", "frames", "invite_answers", "reviews", "review_turns", "notes", "note_edits", "note_deletions", "observation_decisions", "link_decisions", "saved_reviews", "save_failures", "evidence_deletions"].map(
          (t) => raw.sql.query(`SELECT * FROM ${t} ORDER BY rowid`).all(),
        ),
      );
    const before = state();
    const walked: string[] = [];
    for (const [name, c] of Object.entries(CASES)) {
      if (c === "none") continue;
      for (const call of c(ids)) {
        const res = await call.request(bob.base, ids);
        const text = await res.text();
        expect(res.status, `${name} as the second user`).toBe(call.bStatus);
        if (call.bStatus === 200) expect(JSON.parse(text), `${name} is a no-op`).toMatchObject({ passages: [], frames: [] });
        walked.push(name);
      }
    }
    expect(state()).toBe(before);
    expect(new Set(walked).size).toBe(Object.values(CASES).filter((c) => c !== "none").length);

    for (const [name, c] of Object.entries(CASES)) {
      if (c === "none") continue;
      for (const call of c(ids)) {
        if (call.ownerSkipped !== undefined) continue;
        const res = await call.request(alice.base, ids);
        await res.text();
        expect(res.status, `${name} as the owner`).not.toBe(404);
        expect(res.status, `${name} as the owner`).toBeLessThan(500);
      }
    }
  });

  test("a turn already running on a review is the owner's alone: the second user's turn on the same id is 404, not 409 or a join", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const raw = testDb();
    const alice = reviewRig((input) => gate.then(() => pick(input)), { db: scopeDb(raw, ensureLocalUser(raw)) });
    const bob = reviewRig(pick, { db: otherUserDb(raw, "bob") });
    alice.prepare();
    const a = await alice.startReview();
    const turnId = randomId("turn");
    const running = fetch(`${alice.base}/reviews/${a.reviewId}/turns`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ turnId, act: { kind: "resume" } }) });
    await Bun.sleep(30);
    const sameTurn = await fetch(`${bob.base}/reviews/${a.reviewId}/turns`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ turnId, act: { kind: "resume" } }) });
    expect(sameTurn.status).toBe(404);
    const other = await fetch(`${bob.base}/reviews/${a.reviewId}/turns`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ turnId: randomId("turn"), act: { kind: "resume" } }) });
    expect(other.status).toBe(404);
    release();
    expect((await (await running).text()).includes("turn_complete")).toBe(true);
  });
});
