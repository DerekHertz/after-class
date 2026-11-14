/** The review app's side of hosted sign-in, without a browser or Clerk: the token per request and the ClerkJS loader. */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, createApi } from "../src/app/api";
import { SignInScreen, SignOutButton, accountToken, loadClerk } from "../src/app/sign-in";
import type { ClerkClient, ClerkHost } from "../src/app/sign-in";

const lectures = () => new Response(JSON.stringify({ lectures: [] }), { headers: { "content-type": "application/json" } });

function fakeClerk(over: Partial<ClerkClient> = {}): ClerkClient & { loads: unknown[] } {
  const clerk = {
    loads: [] as unknown[],
    async load(options: unknown) {
      clerk.loads.push(options);
    },
    user: null,
    session: null,
    mountSignIn() {},
    unmountSignIn() {},
    signOut: async () => {},
    addListener: () => () => {},
    ...over,
  };
  return clerk;
}

describe("createApi with a session", () => {
  test("asks for a fresh token on every request and sends it as the bearer", async () => {
    const sent: string[] = [];
    let n = 0;
    const api = createApi(async () => `session-${++n}`, {
      fetch: (async (_url: string, init: RequestInit) => {
        sent.push((init.headers as Record<string, string>).authorization!);
        return lectures();
      }) as unknown as typeof fetch,
    });
    await api.lectures();
    await api.lectures();
    expect(sent).toEqual(["Bearer session-1", "Bearer session-2"]);
  });

  test("a token that cannot be had is a network-class failure, so the app offers a retry", async () => {
    const api = createApi(() => Promise.reject(new Error("offline")), { fetch: (async () => lectures()) as unknown as typeof fetch });
    const error = await api.lectures().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
  });

  test("an account's token is refused once another account, or nobody, is signed in, even if the switch lands while Clerk is asked", async () => {
    const clerk = fakeClerk({ user: { id: "user_alice" }, session: { getToken: async () => "alice-jwt" } });
    expect(await accountToken(clerk, "user_alice")).toBe("alice-jwt");
    await expect(accountToken(clerk, "user_bob")).rejects.toThrow("signed out");

    const switching = fakeClerk({ user: { id: "user_alice" } });
    Object.assign(switching, {
      session: {
        getToken: async () => {
          Object.assign(switching, { user: { id: "user_bob" } });
          return "bob-jwt";
        },
      },
    });
    await expect(accountToken(switching, "user_alice")).rejects.toThrow("signed out");
    await expect(accountToken(fakeClerk(), "user_alice")).rejects.toThrow("signed out");
  });
});

describe("loadClerk", () => {
  const script = () => new EventTarget() as unknown as HTMLScriptElement;
  class ClerkUI {}

  test("waits for both scripts, then loads ClerkJS once, handing it the UI", async () => {
    const scripts = { clerk: script(), ui: script() };
    const host: ClerkHost = {};
    const loading = loadClerk(scripts, host);
    const clerk = fakeClerk();
    host.Clerk = clerk;
    scripts.clerk.dispatchEvent(new Event("load"));
    await Bun.sleep(0);
    expect(clerk.loads).toEqual([]);
    host.__internal_ClerkUICtor = ClerkUI;
    scripts.ui.dispatchEvent(new Event("load"));
    expect(await loading).toBe(clerk);
    expect(clerk.loads).toEqual([{ ui: { ClerkUI } }]);
  });

  test("uses ClerkJS and its UI that arrived before the app", async () => {
    const early = fakeClerk();
    expect(await loadClerk({ clerk: script(), ui: script() }, { Clerk: early, __internal_ClerkUICtor: ClerkUI })).toBe(early);
    expect(early.loads).toEqual([{ ui: { ClerkUI } }]);
  });

  test("refuses when the ClerkJS script failed", async () => {
    const scripts = { clerk: script(), ui: script() };
    const failing = loadClerk(scripts, { __internal_ClerkUICtor: ClerkUI });
    scripts.clerk.dispatchEvent(new Event("error"));
    await expect(failing).rejects.toThrow("sign-in did not load");
  });

  test("refuses without loading ClerkJS when the UI is missing, whether its script failed or the page has none", async () => {
    const scripts = { clerk: script(), ui: script() };
    const clerk = fakeClerk();
    const failing = loadClerk(scripts, { Clerk: clerk });
    scripts.ui.dispatchEvent(new Event("error"));
    await expect(failing).rejects.toThrow("sign-in did not load");
    await expect(loadClerk({ clerk: script(), ui: null }, { Clerk: clerk })).rejects.toThrow("sign-in did not load");
    expect(clerk.loads).toEqual([]);
  });
});

test("the signed-out screen names what signing in gives, and the signed-in control signs out", () => {
  const page = renderToStaticMarkup(createElement(SignInScreen, { clerk: fakeClerk() }));
  expect(page).toContain("<h1>Sign in to After Class</h1>");
  expect(page).toContain('class="sign-in-widget"');
  expect(renderToStaticMarkup(createElement(SignOutButton, { clerk: fakeClerk() }))).toBe('<button type="button" class="sign-out">Sign out</button>');
});
