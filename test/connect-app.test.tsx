import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppApi } from "../src/app/api";
import { ConnectExtensionScreen, browserLabel, connectExtension, sendToExtension } from "../src/app/connect";
import type { PageRuntime } from "../src/app/connect";
import { parseRoute, routePath } from "../src/app/core";
import type { ConnectMessage } from "../src/shared/wire";

const EXT = "abcdefghijklmnopabcdefghijklmnop";

/** chrome.runtime as a page sees it: Chrome sets lastError before the callback when no extension answers. */
function runtime(answer: (message: ConnectMessage) => { readonly reply?: unknown; readonly lastError?: unknown } | "never") {
  const sent: { id: string; message: ConnectMessage }[] = [];
  const r: PageRuntime & { lastError?: unknown; sent: typeof sent } = {
    sent,
    sendMessage(id, message, callback) {
      sent.push({ id, message });
      const a = answer(message);
      if (a === "never") return;
      setTimeout(() => {
        r.lastError = a.lastError;
        callback(a.reply);
        r.lastError = undefined;
      }, 1);
    },
  };
  return r;
}

const message: ConnectMessage = { type: "afterclass_connect", code: "acc_x" };

describe("handing the code to the extension", () => {
  test("no chrome.runtime on the page, or Chrome's lastError, means the extension is not installed", async () => {
    expect(await sendToExtension(null, EXT, message)).toEqual({ kind: "not_installed" });
    const missing = runtime(() => ({ lastError: { message: "Could not establish connection. Receiving end does not exist." } }));
    expect(await sendToExtension(missing, EXT, message)).toEqual({ kind: "not_installed" });
  });

  test("the extension's answer decides connected or refused, and silence is no answer", async () => {
    expect(await sendToExtension(runtime(() => ({ reply: { ok: true } })), EXT, message)).toEqual({ kind: "connected" });
    expect(await sendToExtension(runtime(() => ({ reply: { ok: false, error: "the connect code was not accepted." } })), EXT, message)).toEqual({ kind: "refused", detail: "the connect code was not accepted." });
    expect(await sendToExtension(runtime(() => ({ reply: "garbage" })), EXT, message)).toEqual({ kind: "no_answer" });
    expect(await sendToExtension(runtime(() => "never"), EXT, message, 20)).toEqual({ kind: "no_answer" });
  });

  test("the code goes to the pinned extension id, and a code made for an account that has since signed out is never sent", async () => {
    const api = { createConnectCode: async () => ({ code: "acc_fresh", expiresMs: 1 }) } as Pick<AppApi, "createConnectCode">;
    const r = runtime(() => ({ reply: { ok: true } }));
    expect(await connectExtension({ api, extensionId: EXT, label: "Chrome on Linux", runtime: r, alive: () => true })).toEqual({ kind: "connected" });
    expect(r.sent).toEqual([{ id: EXT, message: { type: "afterclass_connect", code: "acc_fresh" } }]);
    const late = runtime(() => ({ reply: { ok: true } }));
    expect(await connectExtension({ api, extensionId: EXT, label: "Chrome on Linux", runtime: late, alive: () => false })).toBeNull();
    expect(late.sent).toEqual([]);
  });

  test("no extension means no code is made; a backend that refuses the code says so", async () => {
    let made = 0;
    const counting = { createConnectCode: async () => ({ code: `acc_${++made}`, expiresMs: 1 }) };
    expect(await connectExtension({ api: counting, extensionId: EXT, label: "x", runtime: null, alive: () => true })).toEqual({ kind: "not_installed" });
    expect(made).toBe(0);
    const failing = { createConnectCode: async () => { throw new Error("unauthorized"); } };
    expect(await connectExtension({ api: failing, extensionId: EXT, label: "x", runtime: runtime(() => ({ reply: { ok: true } })), alive: () => true })).toEqual({ kind: "failed", detail: "unauthorized" });
  });
});

describe("the connect page", () => {
  test("lives at /app/connect-extension", () => {
    expect(parseRoute("/app/connect-extension")).toEqual({ page: "connect_extension" });
    expect(routePath({ page: "connect_extension" })).toBe("/app/connect-extension");
  });

  test("offers the one button when the server names its extension, and says why not otherwise", () => {
    const api = {} as AppApi;
    const page = (extensionId: string | null) => renderToStaticMarkup(createElement(ConnectExtensionScreen, { api, extensionId, runtime: null, label: "Chrome on Linux" }));
    expect(page(EXT)).toContain("Connect this browser&#x27;s extension");
    expect(page("")).toContain("does not name its extension yet");
    expect(page("")).not.toContain("<button");
    expect(page(null)).toContain("pairing token");
  });

  test("names the browser from what it says about itself", () => {
    expect(browserLabel({ userAgent: "", userAgentData: { platform: "Windows" } })).toBe("Chrome on Windows");
    expect(browserLabel({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/130" })).toBe("Chrome on macOS");
    expect(browserLabel({ userAgent: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/130" })).toBe("Chrome on ChromeOS");
    expect(browserLabel({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130" })).toBe("Chrome on Linux");
    expect(browserLabel({ userAgent: "Something else" })).toBe("Chrome");
  });
});
