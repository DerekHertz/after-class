/**
 * `bun run scripts/finish-save-preview.ts`: the real backend in local replay mode on a temporary data directory, with fake model
 * calls that wait, so e2e/finish-save.spec.ts can time what a learner sees between Finish & save and Review saved. No provider is called.
 *
 *   AFTERCLASS_FINISH_PREVIEW_PORT (default 8776)  the backend: app and API on http://127.0.0.1:<port>
 *   AFTERCLASS_FINISH_CONTROL_PORT (default 8777)  POST /new makes a lecture and a review under way and answers { reviewId };
 *                                                  GET /calls?reviewId=... answers when each fake call began (epoch ms)
 *   AFTERCLASS_FINISH_CLOSING_MS (default 3000)    how long the tutor's closing line takes
 *   AFTERCLASS_FINISH_SUMMARY_MS (default 5000)    how long the summary call takes
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { main } from "../src/backend/main";
import type { TaskSet } from "../src/backend/main";
import { canonicalInterpretation, canonicalResourceSearch, canonicalRevision } from "../src/backend/preparation/tasks";
import { nextThreadId } from "../src/backend/review/tutor";
import type { TutorInput } from "../src/backend/review/tutor";
import type { Provider, Purpose } from "../src/shared/domain";
import type { CaptureId, IdPart } from "../src/shared/ids";
import { randomId, stableId } from "../src/shared/ids";
import { fakeTask, ok, usage } from "../test/fakes";
import type { FakeStep } from "../test/fakes";

const port = Number(process.env.AFTERCLASS_FINISH_PREVIEW_PORT ?? 8776);
const controlPort = Number(process.env.AFTERCLASS_FINISH_CONTROL_PORT ?? 8777);
const CLOSING_MS = Number(process.env.AFTERCLASS_FINISH_CLOSING_MS ?? 3000);
const SUMMARY_MS = Number(process.env.AFTERCLASS_FINISH_SUMMARY_MS ?? 5000);
const CLOSING_LINE = "That is the end of this review. You explained the main idea in your own words, and the rest is in your notebook.";

const began = new Map<string, { closingMs?: number; summaryMs?: number }>();
const note = (reviewId: string, key: "closingMs" | "summaryMs") => void began.set(reviewId, { ...began.get(reviewId), [key]: Date.now() });

function scripted<I, O>(purpose: Purpose, provider: Provider, canonical: (i: I) => IdPart, answer: (input: I) => FakeStep<O> | Promise<FakeStep<O>>) {
  return Object.assign(fakeTask<IdPart, O>({ purpose, provider, maxAttempts: 1, answer: (i) => answer(i as unknown as I) }), { canonicalInput: canonical });
}

const boundary = scripted("boundary", "jev", (i: any) => ({ window: i.window.id, new: i.newPassages.map((p: any) => p.id) }), () => ok({ boundary: false } as never));
const frameChange = scripted("frame_change", "jev", () => "frame", () => ok({ verdict: "yes" as const, p: 0.9 }));
const interpret = scripted("interpretation", "claude", canonicalInterpretation as never, (i: any) =>
  ok({ concepts: [{ label: "Topic", summary: "What the lecture is about", claims: [{ text: "The lecture states its topic first.", evidence: [i.newMaterial.passages[0].id], visualDependent: false, assumptions: [] }], confusions: [] }], links: [], supersedes: [] }));
const revise = scripted("claim_revision", "claude", canonicalRevision as never, () => ok(null as never));
const checkClaim = scripted("claim_check", "jev", (i: any) => ({ claim: i.claim.text, passages: i.passages.map((p: any) => p.id) }), () => ok({ verdict: "yes" as const, p: 0.9 }));
const searchResources = scripted("resource_search", "claude", canonicalResourceSearch as never, () => ok([] as never));

/** Streams the move header at once and the words as a model would, so the learner sees the closing line arrive. */
const tutor = {
  provider: "claude" as const,
  purpose: "tutor_turn" as const,
  model: "fake-tutor",
  version: "v1",
  maxAttempts: 1,
  canonicalInput: (i: TutorInput) => ({ turns: i.turns.map((t) => t.id), allowed: i.allowed, repair: i.repairNote }),
  decode: (stored: unknown) => stored as { move: any; say: string },
  async attempt(input: TutorInput, ctx: { admit(): void; streamTo?: ((d: string) => void) | undefined }) {
    ctx.admit();
    const reviewId = input.state.reviewId;
    let move: Record<string, unknown>;
    let say: string;
    if (input.allowed.length === 1 && input.allowed[0] === "wrap_up") {
      note(reviewId, "closingMs");
      move = { kind: "wrap_up" };
      say = CLOSING_LINE;
      ctx.streamTo?.(`${JSON.stringify(move)}\n`);
      await Bun.sleep(CLOSING_MS * 0.3);
      ctx.streamTo?.(say.slice(0, 40));
      await Bun.sleep(CLOSING_MS * 0.7);
      ctx.streamTo?.(say.slice(40));
      return { output: { move, say }, usage: usage() };
    }
    if (input.allowed.includes("ask_main")) {
      move = { kind: "ask_main", threadId: nextThreadId({ reviewId, mainQuestions: input.state.mainQuestions }), claimIds: [input.claims[0]!.id] };
      say = "What does the lecture say first?";
    } else {
      move = { kind: "ask_followup", threadId: input.state.openThread };
      say = "Can you say a little more about that?";
    }
    ctx.streamTo?.(`${JSON.stringify(move)}\n${say}`);
    return { output: { move, say }, usage: usage() };
  },
};

const wrapUp = scripted<{ turns: readonly { reviewId: string }[] }, { observations: never[]; notes: never[] }>("wrap_up", "claude", (input) => ({ review: input.turns[0]!.reviewId }), async (input) => {
  note(input.turns[0]!.reviewId, "summaryMs");
  await Bun.sleep(SUMMARY_MS);
  return ok({ observations: [], notes: [] });
});

const dataDir = mkdtempSync(join(tmpdir(), "afterclass-finish-preview-"));
const tasks = { boundary, frameChange, preparation: { interpret, revise, checkClaim, searchResources }, tutor, wrapUp } as unknown as TaskSet;
const running = await main({
  port,
  configDir: join(dataDir, "config"),
  appDir: resolve(import.meta.dir, "../dist/finish-save-preview-app"),
  tasks,
  log: () => {},
  error: () => {},
  env: { AFTERCLASS_MODE: "replay", AFTERCLASS_DATA: dataDir },
});
const base = `http://127.0.0.1:${running.port}`;
const headers = { Authorization: `Bearer ${running.token}`, "Content-Type": "application/json" };
const call = async (path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${text}`);
  return text;
};

let lectures = 0;
/** A lecture of its own for each review, because one lecture's material serves one review at a time. */
async function newReview(): Promise<string> {
  const captureId = stableId("cap", "finish-preview", randomId("cap")) as CaptureId;
  const videoId = `vid${String(++lectures).padStart(8, "0")}`;
  const facts = [
    { kind: "control", action: "start", reason: "user" },
    { kind: "source", videoId, title: "Lecture", channelName: "Prof", url: `https://www.youtube.com/watch?v=${videoId}`, durationS: 600 },
    { kind: "transcript", videoId, origin: "panel", language: "en", autoGenerated: false, segments: Array.from({ length: 10 }, (_, i) => ({ start: i * 10, end: i * 10 + 10, text: `Statement ${i + 1} about the topic.` })) },
    { kind: "span", videoId, start: 0, end: 100, rate: 1, tabVisible: true, wallDurationMs: 100_000 },
    { kind: "control", action: "stop", reason: "user" },
  ].map((f, clientSeq) => ({ ...f, clientSeq, wallMs: 1000 + clientSeq }));
  await call("/ingest", { captureId, facts });
  const reviewId = randomId("rvw");
  for (let i = 0; i < 300; i++) {
    const started = JSON.parse(await call(`/captures/${captureId}/reviews`, { reviewId, choice: "prepared_only" })) as { kind: string };
    if (started.kind === "started") break;
    await Bun.sleep(100);
  }
  await call(`/reviews/${reviewId}/turns`, { turnId: randomId("turn"), act: { kind: "begin", fuzzy: [] } });
  await call(`/reviews/${reviewId}/turns`, { turnId: randomId("turn"), act: { kind: "answer", text: "It says the topic first.", modality: "text" } });
  return reviewId;
}

const control = Bun.serve({
  hostname: "127.0.0.1",
  port: controlPort,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/new" && req.method === "POST") return Response.json({ reviewId: await newReview(), origin: base });
    if (url.pathname === "/calls") return Response.json(began.get(url.searchParams.get("reviewId") ?? "") ?? {});
    return new Response("not found", { status: 404 });
  },
});

console.log(`Finish and save preview. Replay mode, fake model calls (closing line ${CLOSING_MS} ms, summary ${SUMMARY_MS} ms). ${base}, control on ${control.port}`);
const shutdown = () =>
  void running.stop().then(() => {
    void control.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  });
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
