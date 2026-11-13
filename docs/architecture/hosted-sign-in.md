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
| `AFTERCLASS_EXTENSION_ID` | The Chrome Web Store ID of the extension. The extension cannot connect yet, see below |

Leave `AFTERCLASS_HOST` unset so the backend listens on 127.0.0.1 and only Caddy reaches it. Leave `AFTERCLASS_BUILD_APP` unset, because the backend serves the app in hosted mode. The backend refuses to start when a Clerk setting is missing or malformed, and it creates no pairing token.

## Clerk dashboard

These steps come from memory of Clerk's dashboard and were not checked against it.

1. Create an application and turn on Google as the only sign-in method.
2. Limit who can sign up. Either set the sign-up mode to Restricted and invite each friend, or turn on the allowlist and add each friend's email. After Class has no invitation list of its own.
3. For a production instance, add the DNS records Clerk lists for the domain, then copy the keys and URLs above.

## Caddy

```
afterclass.example {
	reverse_proxy 127.0.0.1:4317
}
```

`https://afterclass.example/` redirects to the app at `/app/`. `GET /health` answers without a token.

## How a request is checked

- The browser loads ClerkJS 6.42.2 from the Frontend API host. Clerk's sign-in card appears on a paper page while signed out.
- Each request sends `Authorization: Bearer <session token>`. The backend checks the RS256 signature against Clerk's JWKS, the expiry, the issuer, and that `azp` is the public origin. It then finds or creates the user for the token's subject.
- An `Origin` header, when present, must be the public origin or the extension. There is no `Host` check.

## One computer, several accounts

Friends may share a computer, so the app keeps nothing of one account where the next can reach it.

- Each signed-in account gets its own API client, tutor voice, speech input and unsent-answer store, made in `followAccount` in `src/app/account.ts`. When the account signs out, or another account replaces it, the app disposes them before it makes the next account's. Disposing cancels every request and turn stream in flight, cuts off the tutor mid-sentence, stops listening, and closes the unsent-answer store so nothing more is written to it.
- An account's API client asks Clerk for a token only while that account is the signed-in one, and checks again after Clerk answers. A late request from the old account fails instead of carrying the new account's token.
- Unsent answers live in IndexedDB in one database per account, named `afterclass-app.<Clerk user id>`. The local app keeps its one `afterclass-app` database.

Signing out clears your unsent answers from the browser. An unsent answer is one the backend has not stored yet, usually because the connection dropped. Keeping it would let you retry it after signing back in, but on a shared computer it would leave your words on the disk for the next person. The app picks clearing. Whenever the account changes, or the page opens, it deletes every account database except the signed-in account's, so a tab closed without signing out is cleared the next time anyone opens the app. This breaks no rule in `docs/flows/after-class.md`. R13 says "A skipped or unanswered question is never counted as understood.", and a cleared answer was never stored, so nothing counts it. R15 says "Retrying a save never creates a duplicate record.", and a turn the backend did store is still resent from the review with its original id.

This assumes Clerk allows one signed-in account per browser, its default. With Clerk's multi-session mode turned on, switching accounts would clear the other signed-in account's unsent answers.

## Where device tokens plug in

`HostedAuth.userFor` in `src/backend/http.ts` is the only place a bearer token becomes a user. The device-token work adds a second resolver beside `clerkUsers` in `src/backend/main.ts`. A device token has its own prefix and no dots, so `userFor` can tell it from a session token by its shape and look it up, hashed, in a kernel table of devices. The Origin check already admits the pinned extension. The connect route takes a Clerk session and returns a device token, so it needs no new check in the gate.

## Not done yet

- The extension cannot connect in hosted mode. Its requests answer 401 until the device-token work lands.
- A database that ran in local mode keeps its local user's data, but no Clerk account can reach it.
- The NDJSON turn stream through Caddy is not verified.
