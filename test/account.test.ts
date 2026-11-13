/**
 * Two accounts on one browser, as on a shared computer: Alice signs out or Bob takes her place while her review is
 * mid-turn. Nothing of Alice's may reach Bob's token, Bob's store or Bob's speakers.
 */
import { describe, expect, test } from "bun:test";
import { followAccount } from "../src/app/account";
import type { Platform } from "../src/app/account";
import { createReviewController } from "../src/app/controller";
import type { ClerkClient } from "../src/app/sign-in";
import type { Speaker } from "../src/app/speech";
import { accountUnsentDb, createIndexedDbUnsent } from "../src/app/unsent";
import type { LearnerAct } from "../src/shared/domain";
import { enc, fakeFetch, fakeIdb, json, line, reviewId, reviewJson, sentence, tid } from "./app-fixtures";

const ALICE = "user_alice";
const BOB = "user_bob";
const aliceAnswer: LearnerAct = { kind: "answer", text: "Alice's private answer about locks", modality: "text" };
const tick = () => new Promise((r) => setTimeout(r, 5));
/** True when the work ends within a few ticks: Alice's held-open turn ends only if signing out cancels its stream. */
const settledSoon = (work: Promise<unknown>) => Promise.race([work.then(() => true), new Promise((r) => setTimeout(r, 50, false))]);

type FakeClerk = ClerkClient & { signInAs(userId: string | null): void };

function fakeClerk(userId: string | null): FakeClerk {
  const listeners = new Set<() => void>();
  const clerk = {
    user: null as { id: string } | null,
    session: null as { getToken(): Promise<string> } | null,
    load: async () => {},
    mountSignIn() {},
    unmountSignIn() {},
    signOut: async () => clerk.signInAs(null),
    addListener(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    signInAs(id: string | null) {
      clerk.user = id === null ? null : { id };
      clerk.session = id === null ? null : { getToken: async () => `${id}-token` };
      for (const listener of listeners) listener();
    },
  };
  clerk.signInAs(userId);
  return clerk;
}

/** The browser's voice, as a record of what was said and what was cut off. A playback lasts until it is stopped. */
function fakeVoice() {
  const said: string[] = [];
  const cut: string[] = [];
  const playback = (what: string) => {
    said.push(what);
    let settle!: () => void;
    const done = new Promise<void>((resolve) => (settle = resolve));
    return { done, stop: () => (cut.push(what), settle()) };
  };
  const synth: Speaker = { beginTurn() {}, speak: (text) => void playback(`synth: ${text}`), stop() {} };
  return { said, cut, play: () => playback("elevenlabs audio"), fallback: (text: string) => playback(`fallback: ${text}`), synth };
}

/** The tutor's turn stream, held open so the test decides when each event arrives. It errors when its request is aborted, as a browser's does. */
function heldStream(signal: AbortSignal | null | undefined) {
  let push!: (chunk: string) => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (chunk) => controller.enqueue(enc.encode(chunk));
      signal?.addEventListener("abort", () => controller.error(new DOMException("The request was aborted.", "AbortError")));
    },
  });
  return { body, push: (chunk: string) => { try { push(chunk); } catch { /* the stream already errored */ } } };
}

function setup(start: string | null, idb = fakeIdb({ autoComplete: true })) {
  const clerk = fakeClerk(start);
  const voice = fakeVoice();
  const streams: ReturnType<typeof heldStream>[] = [];
  let signal: AbortSignal | null | undefined;
  const net = fakeFetch((call) => {
    if (call.url === "/voice") return json({ available: true });
    if (call.url === "/voice/speech") return new Response(new Blob(["mp3"]), { headers: { "content-type": "audio/mpeg" } });
    if (call.url.endsWith("/turns")) {
      const stream = heldStream(signal);
      streams.push(stream);
      return new Response(stream.body, { headers: { "content-type": "application/x-ndjson" } });
    }
    if (call.url.startsWith("/reviews/")) return json(reviewJson());
    return json({ error: "not found" }, 404);
  });
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal;
    return net.fetchFn(input, init);
  }) as typeof fetch;
  const platform: Platform = {
    voiceEnabled: () => true,
    play: voice.play,
    fallback: voice.fallback,
    browserSpeaker: () => voice.synth,
    speechInput: () => ({ supported: false, start() {}, stop() {} }),
    idb: idb.factory,
    fetch: fetchFn,
  };
  const accounts = followAccount(clerk, platform);
  const bearers = () => net.calls.map((c) => `${c.headers.get("authorization")} ${c.method} ${c.url}`);
  return { clerk, idb, voice, streams, net, accounts, bearers };
}

describe("switching accounts mid-turn", () => {
  test("Alice's in-flight turn sends nothing with Bob's token, and her tutor stops talking", async () => {
    const { clerk, voice, streams, accounts, bearers } = setup(ALICE);
    const alice = accounts.current()!.services;
    alice.speaker.beginTurn();
    await tick();
    const controller = createReviewController({ api: alice.api, reviewId, speaker: alice.speaker, unsent: alice.unsent, mintTurnId: () => tid("alice1") });
    const sending = controller.send(aliceAnswer);
    await tick();
    streams[0]!.push(line(sentence("Mutual exclusion means one thread at a time.")));
    await tick();
    expect(bearers()).toContain(`Bearer ${ALICE}-token POST /voice/speech`);
    expect(voice.said).toEqual(["elevenlabs audio"]);

    const before = bearers().length;
    clerk.signInAs(BOB);
    expect(accounts.current()!.userId).toBe(BOB);
    streams[0]!.push(line(sentence("Now tell me what a deadlock needs.")));
    const settled = await settledSoon(sending);

    expect(bearers().filter((b) => b.startsWith(`Bearer ${BOB}-token`))).toEqual([]);
    expect(bearers().slice(before)).toEqual([]);
    expect(voice.cut).toEqual(["elevenlabs audio"]);
    expect(voice.said).toEqual(["elevenlabs audio"]);
    expect(settled).toBe(true);
  });

  test("signing out mid-turn ends Alice's requests and speech the same way", async () => {
    const { clerk, voice, streams, accounts, bearers } = setup(ALICE);
    const alice = accounts.current()!.services;
    alice.speaker.beginTurn();
    await tick();
    const controller = createReviewController({ api: alice.api, reviewId, speaker: alice.speaker, unsent: alice.unsent });
    const sending = controller.send(aliceAnswer);
    await tick();
    streams[0]!.push(line(sentence("Mutual exclusion means one thread at a time.")));
    await tick();
    const before = bearers().length;
    clerk.signInAs(null);
    expect(accounts.current()).toBeNull();
    streams[0]!.push(line(sentence("Now tell me what a deadlock needs.")));
    const settled = await settledSoon(sending);
    expect(bearers().slice(before)).toEqual([]);
    expect(voice.cut).toEqual(["elevenlabs audio"]);
    expect(voice.said).toEqual(["elevenlabs audio"]);
    expect(settled).toBe(true);
  });
});

describe("unsent answers on a shared computer", () => {
  test("Bob's store cannot read Alice's stored draft, even for her review", async () => {
    const idb = fakeIdb({ autoComplete: true });
    const aliceStore = createIndexedDbUnsent(idb.factory, 1000, accountUnsentDb(ALICE));
    await aliceStore.put({ turnId: tid("draft"), reviewId, act: aliceAnswer, createdAtMs: 1 });
    expect((await aliceStore.forReview(reviewId)).map((t) => t.act)).toEqual([aliceAnswer]);
    const bobStore = createIndexedDbUnsent(idb.factory, 1000, accountUnsentDb(BOB));
    expect(await bobStore.forReview(reviewId)).toEqual([]);
  });

  test("when Alice signs out, her unsent answer leaves the browser, and Bob after her sees none", async () => {
    const { clerk, idb, accounts } = setup(ALICE);
    await accounts.current()!.services.unsent.put({ turnId: tid("draft"), reviewId, act: aliceAnswer, createdAtMs: 1 });
    expect([...idb.dbs.get(accountUnsentDb(ALICE))!.values()]).toHaveLength(1);

    clerk.signInAs(null);
    await tick();
    expect(idb.dbs.has(accountUnsentDb(ALICE))).toBe(false);

    clerk.signInAs(BOB);
    expect(await accounts.current()!.services.unsent.forReview(reviewId)).toEqual([]);
    clerk.signInAs(ALICE);
    expect(await accounts.current()!.services.unsent.forReview(reviewId)).toEqual([]);
  });

  test("a draft left by a closed page is deleted when the next page opens for someone else, and the local app's store is kept", async () => {
    const idb = fakeIdb({ autoComplete: true });
    await createIndexedDbUnsent(idb.factory, 1000, accountUnsentDb(ALICE)).put({ turnId: tid("draft"), reviewId, act: aliceAnswer, createdAtMs: 1 });
    await createIndexedDbUnsent(idb.factory, 1000).put({ turnId: tid("local"), reviewId, act: aliceAnswer, createdAtMs: 1 });
    setup(BOB, idb);
    await tick();
    expect([...idb.dbs.keys()]).toEqual(["afterclass-app"]);
  });

  test("Alice's controller writes nothing once she is signed out, to her store or to Bob's", async () => {
    const { clerk, idb, accounts, bearers } = setup(ALICE);
    const alice = accounts.current()!.services;
    const controller = createReviewController({ api: alice.api, reviewId, speaker: alice.speaker, unsent: alice.unsent });
    clerk.signInAs(BOB);
    await tick();
    const before = bearers().length;

    await controller.send(aliceAnswer);
    await controller.retryTurn();
    await tick();

    expect([...idb.dbs.values()].flatMap((rows) => [...rows.values()])).toEqual([]);
    expect(await alice.unsent.forReview(reviewId)).toEqual([]);
    expect(await accounts.current()!.services.unsent.forReview(reviewId)).toEqual([]);
    expect(bearers().slice(before)).toEqual([]);
  });
});
