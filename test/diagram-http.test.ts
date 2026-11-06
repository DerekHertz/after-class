/**
 * The two diagram routes: auth, ids, 404s, reply shape. The diagram module is a stub here; its behaviour is in
 * diagram.test.ts, and the whole stack runs once in the main wiring test at the end.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { serve } from "../src/backend/http";
import type { Diagrams } from "../src/backend/diagram";
import type { TopicDiagram } from "../src/shared/domain";
import { stableId } from "../src/shared/ids";
import type { ConceptId, EvidenceId, ReviewId, SourceId } from "../src/shared/ids";
import { media } from "../src/shared/time";
import { ROUTES, diagramsResponse, topicDiagramResponse } from "../src/shared/wire";

const TOKEN = "tok-diagram-3f2a9c";
const REVIEW = stableId("rvw", "d") as ReviewId;
const TOPIC = stableId("cpt", "d") as ConceptId;
const EV = stableId("ev", "d") as EvidenceId;
const SRC = stableId("src", "d") as SourceId;

const DIAGRAM: TopicDiagram = {
  topicId: TOPIC, label: "Clocks", claimIds: [stableId("clm", "d")] as never,
  frame: { id: EV, mediaS: media(12), sourceId: SRC, videoId: "VIDEO000001", title: "Lecture" },
  summary: { state: "ready", title: "Q?", lines: [{ text: "A reads 5.", evidence: [EV] }] },
};

const asked: string[] = [];
const stub: Diagrams = {
  list: (id) => (id === REVIEW ? [DIAGRAM] : null),
  request: (id, topic) => {
    asked.push(`${id}/${topic}`);
    return id === REVIEW && topic === TOPIC ? { diagram: { ...DIAGRAM, summary: { state: "preparing" } }, settled: Promise.resolve() } : null;
  },
};

const servers: { stop(force?: boolean): void | Promise<void> }[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop(true);
});

function boot(diagrams: Diagrams | undefined) {
  const server = serve({
    modules: { ledger: {} as never, reviews: {} as never, evidence: {} as never, ...(diagrams ? { diagrams } : {}) },
    auth: { port: 0, extensionId: "abcdefghijklmnopabcdefghijklmnop", token: TOKEN },
    appDir: "/nonexistent",
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method: string, path: string, headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, Origin: base }) => fetch(`${base}${path}`, { method, headers });
  return { call, base };
}

describe("the diagram routes are in ROUTES", () => {
  test("a read route and a start route, both under the review", () => {
    expect(ROUTES.diagrams).toMatchObject({ method: "GET", path: "/reviews/:reviewId/diagrams" });
    expect(ROUTES.requestDiagram).toMatchObject({ method: "POST", path: "/reviews/:reviewId/diagrams/:topicId" });
  });
});

describe("GET /reviews/:reviewId/diagrams", () => {
  test("answers every topic in the shape of its schema", async () => {
    const { call } = boot(stub);
    const res = await call("GET", `/reviews/${REVIEW}/diagrams`);
    expect(res.status).toBe(200);
    const body = diagramsResponse.parse(await res.json());
    expect(body.topics).toHaveLength(1);
    expect(body.topics[0]!.frame?.videoId).toBe("VIDEO000001");
    expect(body.topics[0]!.summary.state).toBe("ready");
  });

  test("needs the pairing token and an allowed origin", async () => {
    const { call } = boot(stub);
    expect((await call("GET", `/reviews/${REVIEW}/diagrams`, {})).status).toBe(401);
    expect((await call("GET", `/reviews/${REVIEW}/diagrams`, { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await call("GET", `/reviews/${REVIEW}/diagrams`, { Authorization: `Bearer ${TOKEN}`, Origin: "https://evil.test" })).status).toBe(403);
  });

  test("an unknown review is 404, a malformed id is 400, and no diagram module is 501", async () => {
    const { call } = boot(stub);
    expect((await call("GET", `/reviews/${stableId("rvw", "other")}/diagrams`)).status).toBe(404);
    expect((await call("GET", "/reviews/not-an-id/diagrams")).status).toBe(400);
    expect((await boot(undefined).call("GET", `/reviews/${REVIEW}/diagrams`)).status).toBe(501);
  });
});

describe("POST /reviews/:reviewId/diagrams/:topicId", () => {
  test("starts the summary and answers where it stands", async () => {
    const { call } = boot(stub);
    asked.length = 0;
    const res = await call("POST", `/reviews/${REVIEW}/diagrams/${TOPIC}`);
    expect(res.status).toBe(200);
    expect(topicDiagramResponse.parse(await res.json()).summary).toEqual({ state: "preparing" });
    expect(asked).toEqual([`${REVIEW}/${TOPIC}`]);
  });

  test("needs the pairing token, and a refused request starts nothing", async () => {
    const { call } = boot(stub);
    asked.length = 0;
    expect((await call("POST", `/reviews/${REVIEW}/diagrams/${TOPIC}`, {})).status).toBe(401);
    expect((await call("POST", `/reviews/${REVIEW}/diagrams/${TOPIC}`, { Authorization: `Bearer ${TOKEN}`, Origin: "https://evil.test" })).status).toBe(403);
    expect(asked).toEqual([]);
  });

  test("an unknown topic is 404 and a malformed topic id is 400", async () => {
    const { call } = boot(stub);
    expect((await call("POST", `/reviews/${REVIEW}/diagrams/${stableId("cpt", "elsewhere")}`)).status).toBe(404);
    expect((await call("POST", `/reviews/${REVIEW}/diagrams/${stableId("ev", "wrong-kind")}`)).status).toBe(400);
  });
});
