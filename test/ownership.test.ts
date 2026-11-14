/**
 * Phase 1 step 4 of the hosting plan: every route that takes an id answers 404 to a second user who presents the first
 * user's id, and changes nothing. `CASES` has an entry for every route in `ROUTES` (a new route is a type error until it
 * has one), a route whose path has a parameter may not be listed as taking no id, and the owner's own request with the
 * same id must not be a 404, so the ids are real.
 */
import { describe, expect, test } from "bun:test";
import { createClerkVerifier } from "../src/backend/clerk";
import { ensureLocalUser, scopeDb, userForIdentity } from "../src/backend/db";
import type { Db, UserDb } from "../src/backend/db";
import { createDevices } from "../src/backend/devices";
import { serve } from "../src/backend/http";
import { clerkUsers, hostedCallers } from "../src/backend/main";
import { randomId, stableId } from "../src/shared/ids";
import type { CaptureId, ConceptId, DeviceId, EvidenceId } from "../src/shared/ids";
import { ROUTES, routeUrl } from "../src/shared/wire";
import type { RouteName } from "../src/shared/wire";
import { ISSUER, PUBLIC_ORIGIN, PUBLISHABLE_KEY, claims, fakeJwks, sign, signingKey } from "./clerk-fixtures";
import { stream } from "./evidence-fixtures";
import { EXT_ID, JSON_HEADERS, connectDevice, fixtureApp, pick, registerCleanup, reviewRig, said, savedRig, send } from "./http-fixtures";
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
  /** Hosted only: a connected browser of the owner's that no request in the walk uses as its bearer. */
  readonly deviceId: DeviceId;
};

type Call = {
  readonly request: (base: string, ids: Ids, headers: Record<string, string>) => Promise<Response>;
  readonly bStatus: number;
  readonly ownerSkipped?: string;
  /** The route exists in hosted mode only; locally it answers 501 to everyone. */
  readonly hostedOnly?: true;
};

const get = (path: string) => (base: string, headers: Record<string, string>) => fetch(`${base}${path}`, { headers });
const url = <N extends RouteName>(name: N, params: Record<string, string>) => routeUrl(ROUTES[name] as never, params as never);

/** `none`: the route takes no id, so there is nothing to present. Anything else lists the requests a second user makes. */
const CASES: { readonly [N in RouteName]: "none" | ((ids: Ids) => readonly Call[]) } = {
  ingest: (ids) => [{
    request: (base, _ids, h) => send(base, "POST", "/ingest", { captureId: ids.captureId, facts: [{ kind: "control", action: "start", reason: "user", clientSeq: 0, wallMs: 1000 }] }, h),
    bStatus: 404,
  }],
  lectures: "none",
  captureView: () => [{ request: (base, ids, h) => get(url("captureView", { captureId: ids.captureId }))(base, h), bStatus: 404 }],
  answerInvite: () => [{ request: (base, ids, h) => send(base, "POST", url("answerInvite", { captureId: ids.captureId }), { answer: "later" }, h), bStatus: 404 }],
  reviewOptions: () => [{ request: (base, ids, h) => get(url("reviewOptions", { captureId: ids.captureId }))(base, h), bStatus: 404 }],
  startReview: () => [
    { request: (base, ids, h) => send(base, "POST", url("startReview", { captureId: ids.captureId }), { reviewId: randomId("rvw"), choice: "prepared_only" }, h), bStatus: 404 },
  ],
  sendTurn: () => [{ request: (base, ids, h) => send(base, "POST", url("sendTurn", { reviewId: ids.reviewId }), { turnId: randomId("turn"), act: said("hi") }, h), bStatus: 404 }],
  review: () => [{ request: (base, ids, h) => get(url("review", { reviewId: ids.reviewId }))(base, h), bStatus: 404 }],
  save: () => [{ request: (base, ids, h) => send(base, "POST", url("save", { reviewId: ids.reviewId }), {}, h), bStatus: 404 }],
  diagrams: () => [{ request: (base, ids, h) => get(url("diagrams", { reviewId: ids.reviewId }))(base, h), bStatus: 404 }],
  requestDiagram: () => [
    {
      request: (base, ids, h) => send(base, "POST", url("requestDiagram", { reviewId: ids.reviewId, topicId: ids.topicId }), {}, h),
      bStatus: 404,
      ownerSkipped: "the fixture review has no topics, so its owner gets 404 for the topic",
    },
  ],
  record: () => [{ request: (base, ids, h) => get(`/record?reviewId=${ids.reviewId}`)(base, h), bStatus: 404 }],
  usage: "none",
  evidence: () => [
    { request: (base, ids, h) => get(`/evidence?captureId=${ids.captureId}`)(base, h), bStatus: 404 },
    // Documented no-op: evidence ids and material another user holds read as an id nobody holds, an empty bundle.
    { request: (base, ids, h) => get(`/evidence?ids=${ids.frameId}`)(base, h), bStatus: 200 },
  ],
  frameImage: () => [{ request: (base, ids, h) => get(url("frameImage", { evidenceId: ids.frameId }))(base, h), bStatus: 404 }],
  editNote: () => [{ request: (base, ids, h) => send(base, "PATCH", url("editNote", { noteId: ids.noteId }), { text: "stolen" }, h), bStatus: 404 }],
  deleteNote: () => [{ request: (base, ids, h) => send(base, "DELETE", url("deleteNote", { noteId: ids.noteId }), undefined, h), bStatus: 404 }],
  decideLink: () => [{ request: (base, ids, h) => send(base, "POST", url("decideLink", { linkId: ids.linkId }), { decision: "accepted" }, h), bStatus: 404 }],
  resolveDispute: () => [
    { request: (base, ids, h) => send(base, "POST", url("resolveDispute", { observationId: ids.observationId }), { outcome: "it_was_my_gap" }, h), bStatus: 404 },
  ],
  overrideObservation: () => [
    { request: (base, ids, h) => send(base, "POST", url("overrideObservation", { observationId: ids.observationId }), { status: "independent" }, h), bStatus: 404 },
  ],
  deleteEvidence: () => [{ request: (base, ids, h) => send(base, "POST", "/record/evidence/delete", { evidenceIds: [ids.frameId] }, h), bStatus: 404 }],
  retryPreparation: () => [{ request: (base, ids, h) => send(base, "POST", url("retryPreparation", { captureId: ids.captureId }), {}, h), bStatus: 404 }],
  voiceStatus: "none",
  speak: "none",
  createConnectCode: "none",
  // The code is the credential and names its user; a code nobody was given matches nothing.
  exchangeConnectCode: "none",
  devices: "none",
  revokeDevice: () => [{ request: (base, ids, h) => send(base, "DELETE", url("revokeDevice", { deviceId: ids.deviceId }), undefined, h), bStatus: 404, hostedOnly: true }],
};

async function world(raw: Db = testDb(), aliceDb: UserDb = scopeDb(raw, ensureLocalUser(raw)), bobDb: UserDb = otherUserDb(raw, "bob")) {
  const alice = await savedRig(aliceDb);
  const bob = await savedRig(bobDb);
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
    deviceId: stableId("dev", "none-locally"),
  };
  return { raw, alice, bob, ids };
}

/** The headers a party sends on each route: hosted, the extension's device token where the route takes one, else the session. */
type Party = { readonly base: string; readonly headers: (route: RouteName) => Record<string, string> };

const everywhere = (base: string, headers: Record<string, string>): Party => ({ base, headers: () => headers });

/** The second user presents each id and gets `bStatus` with nothing changed; then the owner presents it and is answered. */
async function walk(raw: Db, ids: Ids, alice: Party, bob: Party, mode: "local" | "hosted"): Promise<void> {
  const calls = (c: (ids: Ids) => readonly Call[]) => c(ids).filter((call) => mode === "hosted" || call.hostedOnly !== true);
  const state = () =>
    JSON.stringify(
      ["capture_facts", "frames", "invite_answers", "reviews", "review_turns", "notes", "note_edits", "note_deletions", "observation_decisions", "link_decisions", "saved_reviews", "save_failures", "evidence_deletions", "devices"].map(
        // A device's last use moves whenever its own user calls; what a second user must not change is who holds it and whether it is revoked.
        (t) => raw.sql.query(`SELECT ${t === "devices" ? "id, user_id, revoked_ms" : "*"} FROM ${t} ORDER BY rowid`).all(),
      ),
    );
  const before = state();
  const walked: string[] = [];
  for (const [name, c] of Object.entries(CASES)) {
    if (c === "none") continue;
    for (const call of calls(c)) {
      const res = await call.request(bob.base, ids, bob.headers(name as RouteName));
      const text = await res.text();
      expect(res.status, `${name} as the second user`).toBe(call.bStatus);
      if (call.bStatus === 200) expect(JSON.parse(text), `${name} is a no-op`).toMatchObject({ passages: [], frames: [] });
      walked.push(name);
    }
  }
  expect(state()).toBe(before);
  expect(new Set(walked).size).toBe(Object.values(CASES).filter((c) => c !== "none" && calls(c).length > 0).length);

  for (const [name, c] of Object.entries(CASES)) {
    if (c === "none") continue;
    for (const call of calls(c)) {
      if (call.ownerSkipped !== undefined) continue;
      const res = await call.request(alice.base, ids, alice.headers(name as RouteName));
      await res.text();
      expect(res.status, `${name} as the owner`).not.toBe(404);
      expect([401, 403], `${name} as the owner`).not.toContain(res.status);
      expect(res.status, `${name} as the owner`).toBeLessThan(500);
    }
  }
}

describe("every route that takes an id", () => {
  test("is covered: each route is in the table, and one with a path parameter or an id in its request is not marked as taking none", () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(ROUTES).sort());
    for (const [name, route] of Object.entries(ROUTES)) {
      if (route.path.includes(":")) expect(CASES[name as RouteName], name).not.toBe("none");
    }
    expect(Object.entries(CASES).filter(([, c]) => c === "none").map(([n]) => n).sort()).toEqual(["createConnectCode", "devices", "exchangeConnectCode", "lectures", "speak", "usage", "voiceStatus"]);
  });

  test("answers a second user who presents the first user's id with 404 and changes nothing, and answers the owner", async () => {
    const { raw, alice, bob, ids } = await world();
    await walk(raw, ids, everywhere(alice.base, JSON_HEADERS), everywhere(bob.base, JSON_HEADERS), "local");
  });

  test("hosted: one server, two Clerk sign-ins, each with a connected browser; the second user's session or device token gets 404 on every id route and changes nothing", async () => {
    const key = await signingKey("k1");
    const raw = testDb();
    const aliceId = userForIdentity(raw, { provider: "clerk", subject: "user_alice" });
    const bobId = userForIdentity(raw, { provider: "clerk", subject: "user_bob" });
    const { alice, bob, ids } = await world(raw, scopeDb(raw, aliceId), scopeDb(raw, bobId));
    const verifier = createClerkVerifier({ issuer: ISSUER, jwksUrl: "https://clerk.afterclass.test/.well-known/jwks.json", authorizedParties: [PUBLIC_ORIGIN] }, { fetch: fakeJwks([key]).fetch });
    const byUser = new Map([[aliceId, alice.modules], [bobId, bob.modules]]);
    const devices = createDevices(raw);
    const server = serve({
      hosted: {
        publicOrigin: PUBLIC_ORIGIN, extensionId: EXT_ID, clerk: { scriptUrl: "https://clerk.afterclass.test/clerk.js", uiScriptUrl: "https://clerk.afterclass.test/ui.js", publishableKey: PUBLISHABLE_KEY },
        userFor: hostedCallers(clerkUsers(verifier, raw), devices), devices,
      },
      port: 0,
      modulesFor: (userId) => byUser.get(userId)!,
      appDir: fixtureApp(),
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const as = async (sub: string): Promise<Party> => {
        const session = { Authorization: `Bearer ${await sign(key, claims({ sub }))}`, "Content-Type": "application/json" };
        const device = (await connectDevice(base, session)).headers;
        return { base, headers: (route) => (ROUTES[route].bearer.includes("device") ? device : session) };
      };
      const aliceParty = await as("user_alice");
      const spare = devices.exchange(devices.createCode(aliceId, "Spare").code);
      if (spare.kind !== "connected") throw new Error("the spare device did not connect");
      await walk(raw, { ...ids, deviceId: spare.deviceId }, aliceParty, await as("user_bob"), "hosted");
    } finally {
      await server.stop(true);
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
