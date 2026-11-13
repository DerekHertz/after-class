/** The review app's side of hosted sign-in, without a browser or Clerk: the token per request and the ClerkJS loader. */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, createApi } from "../src/app/api";
import { SignInScreen, SignOutButton, accountToken, loadClerk } from "../src/app/sign-in";
import type { ClerkClient } from "../src/app/sign-in";

const lectures = () => new Response(JSON.stringify({ lectures: [] }), { headers: { "content-type": "application/json" } });

function fakeClerk(over: Partial<ClerkClient> = {}): ClerkClient & { loads: number } {
  const clerk = {
    loads: 0,
    async load() {
      clerk.loads += 1;
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
  test("waits for the script, then loads ClerkJS once", async () => {
    const script = new EventTarget() as unknown as HTMLScriptElement;
    const host: { Clerk?: ClerkClient } = {};
    const loading = loadClerk(script, host);
    const clerk = fakeClerk();
    host.Clerk = clerk;
    script.dispatchEvent(new Event("load"));
    expect(await loading).toBe(clerk);
    expect(clerk.loads).toBe(1);
  });

  test("uses ClerkJS that arrived before the app, and refuses when the script failed", async () => {
    const early = fakeClerk();
    expect(await loadClerk(new EventTarget() as unknown as HTMLScriptElement, { Clerk: early })).toBe(early);
    const script = new EventTarget() as unknown as HTMLScriptElement;
    const failing = loadClerk(script, {});
    script.dispatchEvent(new Event("error"));
    await expect(failing).rejects.toThrow("sign-in did not load");
  });
});

test("the signed-out screen names what signing in gives, and the signed-in control signs out", () => {
  const page = renderToStaticMarkup(createElement(SignInScreen, { clerk: fakeClerk() }));
  expect(page).toContain("<h1>Sign in to After Class</h1>");
  expect(page).toContain('class="sign-in-widget"');
  expect(renderToStaticMarkup(createElement(SignOutButton, { clerk: fakeClerk() }))).toBe('<button type="button" class="sign-out">Sign out</button>');
});
