# Hosted sign-in

The beta runs the current backend on one server behind Caddy, with the app and the API on one origin. Friends sign in with Google through Clerk. Each Clerk account is one After Class user, and the backend serves each user only their own data.

## Settings

Hosted mode is opt-in. With `AFTERCLASS_AUTH` unset, the backend runs the local app exactly as before.

| Variable | Value |
| --- | --- |
| `AFTERCLASS_AUTH` | `clerk` |
| `AFTERCLASS_PUBLIC_ORIGIN` | The address friends open, as a bare origin, such as `https://afterclass.example` |
| `AFTERCLASS_CLERK_PUBLISHABLE_KEY` | The `pk_live_...` or `pk_test_...` key from Clerk's API keys page |
| `AFTERCLASS_CLERK_ISSUER` | The Frontend API URL from the same page, such as `https://clerk.afterclass.example` |
| `AFTERCLASS_CLERK_JWKS_URL` | The JWKS URL from the same page. It is the Frontend API URL followed by `/.well-known/jwks.json` |
| `AFTERCLASS_EXTENSION_ID` | The Chrome Web Store ID of the extension. Unset, no extension can connect |

Leave `AFTERCLASS_HOST` unset so the backend listens on 127.0.0.1 and only Caddy reaches it. Leave `AFTERCLASS_BUILD_APP` unset, because the backend serves the app in hosted mode. The backend refuses to start when a Clerk setting is missing or malformed, and it creates no pairing token.

## Clerk dashboard

These steps come from memory of Clerk's dashboard and were not checked against it.

1. Create an application and turn on Google and email as sign-in methods.
2. Limit who can sign up. The beta sets Access mode to Invite-only and invites each friend under Users, Invitations. Clerk then refuses an uninvited sign-up with `sign_up_mode_restricted`, checked live on 2026-11-14. The allowlist needs a paid plan in production. After Class has no invitation list of its own.
3. Production instances created on or after 2026-11-12 require a minimum ClerkJS version, 6.42.3 by default. `CLERK_JS_VERSION` must stay at or above it.
4. For a production instance, add the DNS records Clerk lists for the domain, then copy the keys and URLs above.

## Caddy

```
afterclass.example {
	reverse_proxy 127.0.0.1:4317
}
```

`https://afterclass.example/` redirects to the app at `/app/`. `GET /health` answers without a token.

## How a request is checked

- The browser loads ClerkJS 6.42.3 from the Frontend API host. Clerk's sign-in card appears on a paper page while signed out.
- Each request from the app sends `Authorization: Bearer <session token>`. The backend checks the RS256 signature against Clerk's JWKS, the expiry, the issuer, and that `azp` is the public origin. It then finds or creates the user for the token's subject.
- Each request from the extension sends `Authorization: Bearer <device token>`, described below.
- Each route in `ROUTES` names the tokens it accepts. A token of another kind answers 401.
- An `Origin` header, when present, must be the public origin or the extension. There is no `Host` check.

## One computer, several accounts

Friends may share a computer, so the app keeps nothing of one account where the next can reach it.

- Each signed-in account gets its own API client, tutor voice, speech input and unsent-answer store, made in `followAccount` in `src/app/account.ts`. When the account signs out, or another account replaces it, the app disposes them before it makes the next account's. Disposing cancels every request and turn stream in flight, cuts off the tutor mid-sentence, stops listening, and closes the unsent-answer store so nothing more is written to it.
- An account's API client asks Clerk for a token only while that account is the signed-in one, and checks again after Clerk answers. A late request from the old account fails instead of carrying the new account's token.
- Unsent answers live in IndexedDB in one database per account, named `afterclass-app.<Clerk user id>`. The local app keeps its one `afterclass-app` database.

Signing out clears your unsent answers from the browser. An unsent answer is one the backend has not stored yet, usually because the connection dropped. Keeping it would let you retry it after signing back in, but on a shared computer it would leave your words on the disk for the next person. The app picks clearing. Whenever the account changes, or the page opens, it deletes every account database except the signed-in account's, so a tab closed without signing out is cleared the next time anyone opens the app. This breaks no rule in `docs/flows/after-class.md`. R13 says "A skipped or unanswered question is never counted as understood.", and a cleared answer was never stored, so nothing counts it. R15 says "Retrying a save never creates a duplicate record.", and a turn the backend did store is still resent from the review with its original id.

This assumes Clerk allows one signed-in account per browser, its default. With Clerk's multi-session mode turned on, switching accounts would clear the other signed-in account's unsent answers.

## Connecting the extension

A friend installs the extension, presses Connect in its popup, and signs in if asked. The popup opens `<public origin>/app/connect-extension`. Sign-in returns to that page.

1. The page's one button asks `POST /devices/connect-codes` for a one-time code. The code works once and for 2 minutes.
2. The page hands the code to the extension with `chrome.runtime.sendMessage(<AFTERCLASS_EXTENSION_ID>, ...)`. The hosted extension lists the public origin under `externally_connectable`, and its worker takes a code only from that origin.
3. The worker trades the code at `POST /devices/exchange` for a device token. The exchange takes no bearer and answers only the pinned extension's Origin. After 20 wrong codes in a minute it refuses every code, the right one included, until the minute ends.
4. The worker keeps the token in `chrome.storage.local`, which only the extension's own pages can read, and sends it as its bearer.

The backend stores a SHA-256 of each code and token, never the value, in the kernel tables `connect_codes` and `devices`. `HostedAuth.userFor` tells a device token from a session token by its shape: a device token starts with `acd_` and has no dots.

A device token reaches `POST /ingest` and the invite answer, and only from the pinned extension's Origin. A session token does not reach `POST /ingest`. Only the extension writes captures, so a script that holds a friend's session cannot add made-up watched evidence. R1: "Evidence only comes from intervals I actually watched while capture was on."

The usage page lists the account's connected browsers. Revoke makes that browser's token answer 401 from the next request on. The extension then empties its token and its popup says Reconnect. A request already past the check when Revoke lands still finishes.

Each capture belongs to the account that was connected when it started. If a browser is later connected to another account, the older captures stay in the extension and are not uploaded until their own account connects again.

### Building the hosted extension

`AFTERCLASS_EXT_BACKEND=https://useafterclass.com bun run build:ext` builds `dist/extension` for that origin. The manifest's host permission and `externally_connectable` name the origin, and the popup and options page show Connect in place of the pairing-token field. Without the variable the build is the local one, unchanged. The Chrome Web Store link on the connect page is a placeholder built from the extension ID until the listing is published.

## Not done yet

- A database that ran in local mode keeps its local user's data, but no Clerk account can reach it.
- The NDJSON turn stream through Caddy is not verified.
