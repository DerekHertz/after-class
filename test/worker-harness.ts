/**
 * Runs the real service worker module against fakes: an in-memory IndexedDB,
 * chrome.* with just what the worker touches, a scripted backend, and a fake
 * content-script port. Support file for test/worker.test.ts (W2).
 */
import type { CaptureFactBody } from "../src/shared/domain";
import { media } from "../src/shared/time";
import { parseIngestBatch } from "../src/shared/wire";
import type { WireFact } from "../src/extension/worker/outbox";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const cmp = (a: Any, b: Any): number => {
  if (Array.isArray(a)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = cmp(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
};

/** Only what createIdbOutbox uses: keyed stores, key ranges, count, getAll, getAllKeys, put, delete. */
export class FakeIDB {
  readonly stores = new Map<string, { keyPath: Any; rows: Map<string, Any> }>();

  private req<T>(f: () => T): Any {
    const r: Any = {};
    setTimeout(() => {
      try {
        r.result = f();
        r.onsuccess?.();
      } catch (e) {
        r.error = e;
        r.onerror?.();
      }
    }, 0);
    return r;
  }

  open(): Any {
    const r: Any = {};
    setTimeout(() => {
      const db = this.db();
      r.result = db;
      r.onupgradeneeded?.();
      r.onsuccess?.();
    }, 0);
    return r;
  }

  private keyOf(s: Any, v: Any) {
    return Array.isArray(s.keyPath) ? s.keyPath.map((k: string) => v[k]) : v[s.keyPath];
  }

  private db(): Any {
    const self = this;
    return {
      objectStoreNames: { contains: (n: string) => self.stores.has(n) },
      createObjectStore: (n: string, o: Any) => self.stores.set(n, { keyPath: o.keyPath, rows: new Map() }),
      transaction: () => {
        const tx: Any = {
          objectStore: (n: string) => {
            const s = self.stores.get(n)!;
            const sorted = (range?: Any) =>
              [...s.rows.values()]
                .map((v) => ({ k: self.keyOf(s, v), v }))
                .filter((e) => !range || (cmp(e.k, range.lo) >= 0 && cmp(e.k, range.hi) <= 0))
                .sort((a, b) => cmp(a.k, b.k));
            return {
              get: (k: Any) => self.req(() => s.rows.get(JSON.stringify(k))),
              put: (v: Any) => void s.rows.set(JSON.stringify(self.keyOf(s, v)), structuredClone(v)),
              delete: (range: Any) => void sorted(range).forEach((e) => s.rows.delete(JSON.stringify(e.k))),
              getAll: (range: Any, limit?: number) => self.req(() => sorted(range).slice(0, limit).map((e) => structuredClone(e.v))),
              count: (range: Any) => self.req(() => sorted(range).length),
              getAllKeys: () => self.req(() => sorted().map((e) => e.k)),
            };
          },
        };
        Object.defineProperty(tx, "oncomplete", { set: (f) => void setTimeout(f, 5) });
        return tx;
      },
    };
  }
}

export type Backend = {
  down: boolean;
  /** Answers 400 to any batch containing a fact this returns true for. */
  refuses: (f: WireFact) => boolean;
  lostAckOnce: boolean;
  calls: number;
  readonly stored: Map<string, Map<number, WireFact>>;
};
export const newBackend = (): Backend => ({ down: false, refuses: () => false, lostAckOnce: false, calls: 0, stored: new Map() });

function ackFor(b: Backend, cap: string) {
  const m = b.stored.get(cap) ?? new Map();
  let hi = -1;
  while (m.has(hi + 1)) hi++;
  return {
    ackedThroughSeq: hi,
    invite: { state: "none" },
    capture: { captureId: cap, status: { state: "capturing" }, sources: [], currentSourceId: null, transcript: "unknown", health: [], watchedSeconds: 0 },
    reviewAppUrl: "http://127.0.0.1:4317/app/",
  };
}

function fakeFetch(b: Backend) {
  return async (_url: string, init: Any) => {
    b.calls++;
    if (b.down) throw new TypeError("fetch failed");
    const body = JSON.parse(init.body);
    let batch;
    try {
      batch = parseIngestBatch(body);
    } catch {
      return new Response("bad batch", { status: 400 });
    }
    if ((body.facts as WireFact[]).some(b.refuses)) return new Response("a fact is invalid", { status: 400 });
    const m = b.stored.get(batch.captureId) ?? new Map<number, WireFact>();
    b.stored.set(batch.captureId, m);
    for (const f of body.facts as WireFact[]) if (!m.has(f.clientSeq)) m.set(f.clientSeq, f);
    if (b.lostAckOnce) {
      b.lostAckOnce = false;
      throw new TypeError("connection reset after store");
    }
    return new Response(JSON.stringify(ackFor(b, batch.captureId)), { status: 200 });
  };
}

const event = () => {
  const l: Any[] = [];
  return { addListener: (f: Any) => void l.push(f), fire: (...a: Any[]) => l.map((f) => f(...a)), l };
};

export type Env = {
  idb: FakeIDB;
  session: Record<string, Any>;
  local: Record<string, Any>;
  urls: Record<number, string>;
  backend: Backend;
  /** Make chrome.storage.local.setAccessLevel reject. */
  accessLevelError?: Error;
};

export const WATCH = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
export const newEnv = (): Env => ({ idb: new FakeIDB(), session: {}, local: { pairingToken: "tok" }, urls: { 1: WATCH, 2: WATCH }, backend: newBackend() });

export type FakeChrome = Any;
export type FakePort = {
  readonly posted: Any[];
  onPost: ((m: Any) => void) | null;
  readonly onMessage: ReturnType<typeof event>;
  readonly onDisconnect: ReturnType<typeof event>;
  postMessage(m: Any): void;
  readonly sender: Any;
  readonly name: string;
};

const GLOBALS = ["chrome", "indexedDB", "fetch", "IDBKeyRange"] as const;
const originals = new Map<string, unknown>();
const g = globalThis as Any;

export function restoreGlobals(): void {
  for (const k of GLOBALS) {
    if (originals.has(k)) g[k] = originals.get(k);
  }
  originals.clear();
}

let nth = 0;
/** Installs the fakes and loads a fresh instance of the worker, as after a service-worker restart. */
export async function boot(env: Env): Promise<{ c: FakeChrome; errors: string[] }> {
  for (const k of GLOBALS) if (!originals.has(k)) originals.set(k, g[k]);
  const errors: string[] = [];
  const c: FakeChrome = {
    runtime: { id: "ext", onConnect: event(), onMessage: event(), onStartup: event() },
    storage: {
      session: { get: async (k: string) => ({ [k]: structuredClone(env.session[k]) }), set: async (o: Any) => void Object.assign(env.session, structuredClone(o)) },
      local: {
        get: async (k: string) => ({ [k]: env.local[k] }),
        set: async (o: Any) => void Object.assign(env.local, o),
        setAccessLevel: async (o: Any) => {
          if (env.accessLevelError) throw env.accessLevelError;
          env.local.__access = o.accessLevel;
        },
      },
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: {
      onUpdated: event(),
      onRemoved: event(),
      create: async (o: Any) => void c.created.push(o.url),
      get: async (id: number) => ({ id, url: env.urls[id] }),
    },
    scripting: { executeScript: async () => {} },
    alarms: { create: async () => {}, onAlarm: event() },
    created: [] as string[],
  };
  g.chrome = c;
  g.indexedDB = env.idb;
  g.IDBKeyRange = { bound: (lo: Any, hi: Any) => ({ lo, hi }) };
  g.fetch = fakeFetch(env.backend);
  const realError = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
  try {
    await import(`../src/extension/worker/service-worker.ts?v=${++nth}`);
    await wait();
  } finally {
    console.error = realError;
  }
  return { c, errors };
}

/** A content-script port as the worker sees it. `onPost` plays the content script's side. */
export function connectPort(c: FakeChrome, tabId: number): FakePort {
  const p: FakePort = {
    name: "capture",
    sender: { tab: { id: tabId }, id: "ext" },
    posted: [],
    onPost: null,
    onMessage: event(),
    onDisconnect: event(),
    postMessage(m: Any) {
      p.posted.push(m);
      p.onPost?.(m);
    },
  };
  c.runtime.onConnect.fire(p);
  return p;
}

/** The content script sending the worker a message. */
export const feed = (p: FakePort, msg: Any): void => void p.onMessage.l.forEach((f: Any) => f(msg));

export const wait = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));

export const sendPopup = (c: FakeChrome, msg: Any) =>
  new Promise<Any>((res) => {
    c.runtime.onMessage.fire(msg, { id: "ext" }, res);
  });

export const span = (s: number, e: number): CaptureFactBody => ({ kind: "span", videoId: "dQw4w9WgXcQ", start: media(s), end: media(e), rate: 1, tabVisible: true, wallDurationMs: (e - s) * 1000 });

export const kindsOf = (m: Map<number, WireFact> | undefined): string[] => [...(m?.values() ?? [])].map((f) => (f.kind === "control" ? `control:${(f as Any).action}` : f.kind));
