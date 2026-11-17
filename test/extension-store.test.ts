import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExtension, extensionVersion, PACKAGE_VERSION, storeFrom } from "../scripts/build-extension";
import type { AppApi } from "../src/app/api";
import { connectExtension, extensionIdOf, storeListing } from "../src/app/connect";
import type { PageRuntime } from "../src/app/connect";
import { authorize, hostedOrigin } from "../src/backend/http";
import { isExtensionOrigin, parseExtensionIds } from "../src/shared/extension-ids";

const STORE = "abcdefghijklmnopabcdefghijklmnop";
const OLD = "jambcaokhnaonnemlbpnppijaojlohgl";
const OTHER = "p".repeat(32);

describe("extension id list", () => {
  test("parses one id, or a list with spaces and empty entries, in order", () => {
    expect(parseExtensionIds(undefined)).toEqual([]);
    expect(parseExtensionIds("")).toEqual([]);
    expect(parseExtensionIds(STORE)).toEqual([STORE]);
    expect(parseExtensionIds(` ${STORE} ,, ${OLD},`)).toEqual([STORE, OLD]);
  });

  test("a malformed id stops startup", () => {
    for (const bad of ["short", `${STORE}z`, `${STORE},nope`, STORE.toUpperCase()]) expect(() => parseExtensionIds(bad)).toThrow(/AFTERCLASS_EXTENSION_ID/);
  });

  test("an origin matches any listed id and nothing else", () => {
    const list = `${STORE},${OLD}`;
    expect(isExtensionOrigin(`chrome-extension://${STORE}`, list)).toBe(true);
    expect(isExtensionOrigin(`chrome-extension://${OLD}`, list)).toBe(true);
    expect(isExtensionOrigin(`chrome-extension://${STORE}x`, list)).toBe(false);
    expect(isExtensionOrigin(`chrome-extension://${OLD}`, "")).toBe(false);
    expect(isExtensionOrigin(null, list)).toBe(false);
  });

  test("the local origin check allows both ids", () => {
    const cfg = { port: 4317, extensionId: `${STORE},${OLD}`, token: "t" };
    for (const id of [STORE, OLD]) {
      const headers = new Headers({ Host: "127.0.0.1:4317", Origin: `chrome-extension://${id}`, Authorization: "Bearer t" });
      expect(authorize(headers, cfg)).toEqual({ ok: true, origin: "extension" });
    }
    const other = new Headers({ Host: "127.0.0.1:4317", Origin: `chrome-extension://${OTHER}`, Authorization: "Bearer t" });
    expect(authorize(other, cfg)).toEqual({ ok: false, status: 403 });
  });

  test("the hosted origin check allows both ids", () => {
    const hosted = { publicOrigin: "https://useafterclass.com", extensionId: `${STORE},${OLD}` };
    for (const id of [STORE, OLD]) expect(hostedOrigin(new Headers({ Origin: `chrome-extension://${id}` }), hosted)).toEqual({ ok: true, origin: "extension" });
    expect(hostedOrigin(new Headers({ Origin: `chrome-extension://${OTHER}` }), hosted)).toEqual({ ok: false, status: 403 });
  });

  test("the page reads the list from the meta tag and the store link names the first id", () => {
    const doc = { querySelector: () => ({ content: `${STORE},${OLD}` }) } as unknown as Document;
    expect(extensionIdOf(doc)).toBe(`${STORE},${OLD}`);
    expect(storeListing(`${STORE},${OLD}`)).toBe(`https://chromewebstore.google.com/detail/${STORE}`);
    expect(storeListing(STORE)).toBe(`https://chromewebstore.google.com/detail/${STORE}`);
  });
});

describe("connect with two ids", () => {
  const api = { createConnectCode: async () => ({ code: "acc_x", expiresMs: 1 }) } as Pick<AppApi, "createConnectCode">;
  /** Only the `installed` id answers. Chrome sets lastError for the others. */
  function runtime(installed: string) {
    const sent: string[] = [];
    const r: PageRuntime & { lastError?: unknown; sent: string[] } = {
      sent,
      sendMessage(id, _message, callback) {
        sent.push(id);
        setTimeout(() => {
          r.lastError = id === installed ? undefined : { message: "Could not establish connection." };
          callback(id === installed ? { ok: true } : undefined);
          r.lastError = undefined;
        }, 1);
      },
    };
    return r;
  }
  const run = (rt: PageRuntime) => connectExtension({ api, extensionId: `${STORE},${OLD}`, label: "x", runtime: rt, alive: () => true });

  test("uses the second id when the first has no extension", async () => {
    const r = runtime(OLD);
    expect(await run(r)).toEqual({ kind: "connected" });
    expect(r.sent).toEqual([STORE, OLD]);
  });

  test("stops at the first id that answers", async () => {
    const r = runtime(STORE);
    expect(await run(r)).toEqual({ kind: "connected" });
    expect(r.sent).toEqual([STORE]);
  });

  test("is not installed when no listed id answers", async () => {
    const r = runtime("none");
    expect(await run(r)).toEqual({ kind: "not_installed" });
    expect(r.sent).toEqual([STORE, OLD]);
  });
});

describe("store build", () => {
  const root = mkdtempSync(join(tmpdir(), "afterclass-store-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("AFTERCLASS_EXT_STORE needs AFTERCLASS_EXT_BACKEND", () => {
    expect(storeFrom(undefined, null)).toBe(false);
    expect(storeFrom("1", "https://useafterclass.com")).toBe(true);
    expect(() => storeFrom("1", null)).toThrow(/AFTERCLASS_EXT_BACKEND/);
  });

  test("has no key, has icons that exist, no source maps, and a zip of the build", async () => {
    const out = join(root, "build", "extension");
    await buildExtension(out, { hostedOrigin: "https://useafterclass.com", store: true });
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(manifest.key).toBeUndefined();
    expect(manifest.externally_connectable).toEqual({ matches: ["https://useafterclass.com/*"] });
    expect(Object.keys(manifest.icons)).toEqual(["16", "32", "48", "128"]);
    expect(Object.keys(manifest.action.default_icon)).toEqual(["16", "32", "48", "128"]);
    for (const f of [...Object.values<string>(manifest.icons), ...Object.values<string>(manifest.action.default_icon)]) expect(existsSync(join(out, f)), f).toBe(true);
    expect(readdirSync(out).filter((f) => f.endsWith(".map"))).toEqual([]);
    for (const f of readdirSync(out).filter((f) => f.endsWith(".js"))) expect(readFileSync(join(out, f), "utf8"), f).not.toContain("sourceMappingURL");

    expect(manifest.version).toBe(PACKAGE_VERSION);
    const zip = join(root, "build", `after-class-extension-${manifest.version}.zip`);
    expect(existsSync(zip)).toBe(true);
    expect(readFileSync(zip).subarray(0, 2).toString()).toBe("PK");
    const listing = Bun.spawnSync(["zip", "-sf", zip]);
    expect(listing.stdout.toString()).toContain("manifest.json");
  });

  test("the extension's version is the app's, and Chrome's format is enforced", async () => {
    const out = join(root, "local", "extension");
    await buildExtension(out);
    expect(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")).version).toBe(PACKAGE_VERSION);
    expect(extensionVersion("0.1.10")).toBe("0.1.10");
    for (const bad of ["1.2.3-beta", "1.2.3.4.5", "01.2", "1.65536", ""]) expect(() => extensionVersion(bad), bad).toThrow(/Chrome extension version/);
  });

  test("a plain hosted build still carries the key and icons, and makes no zip", async () => {
    const out = join(root, "hosted", "extension");
    await buildExtension(out, { hostedOrigin: "https://useafterclass.com" });
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(typeof manifest.key).toBe("string");
    expect(existsSync(join(out, "icons/icon-128.png"))).toBe(true);
    expect(readdirSync(join(root, "hosted")).filter((f) => f.endsWith(".zip"))).toEqual([]);
  });
});
