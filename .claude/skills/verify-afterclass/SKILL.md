---
name: verify-afterclass
description: Launch the After Class backend in replay mode and drive it over HTTP (and the review app in Chrome) to prove a change works. Use when a PR touches src/backend, src/shared/wire.ts, the review app or the extension's backend calls, or when a verifier lane must show the real server, not just bun test.
---

# Verify After Class

After Class has three surfaces: a Bun backend (HTTP on 127.0.0.1), a React review app served by that backend at `/app/`, and a Chrome MV3 extension. This skill drives the first two. Everything runs in **replay mode**: no Jev, no `claude`, every live call refused. The extension needs Windows Chrome and Derek (see Gotchas).

Never use the real `~/.config/afterclass`, and never put a real key anywhere. `launch.sh` points HOME at a scratch dir, so the backend sees no keys file and picks replay mode by itself.

## Launch

From any directory, with a checkout that has `bun install` done:

```bash
WORK=$(.claude/skills/verify-afterclass/launch.sh)
```

It prints the scratch dir. Ready means the log has `pairing token:` (the app bundle is built before that, about 2 s). `$WORK/env` holds `PORT`, `TOKEN`, `PID`. The port is free-picked, so two instances can run side by side; each has its own `$WORK`.

## Doctor

Run first whenever anything looks off. Read-only.

```bash
.claude/skills/verify-afterclass/doctor.sh "$WORK"
```

Checks: the pid is alive, the log says replay mode, the port is owned by that pid, `/health` is 200, `/usage` without a token is 401.

## Drive: HTTP

`call.sh <workdir> <METHOD> <path> [json-body] [extension|app]` sends the bearer token and the right Origin. It prints the body, then the status code on its own line. Routes are the `ROUTES` table in `src/shared/wire.ts`; request and reply shapes are the zod schemas it names. A request with a wrong Host or Origin is 403 before a bad token is 401.

```bash
.claude/skills/verify-afterclass/call.sh "$WORK" POST /ingest "$(cat .claude/skills/verify-afterclass/fixtures/capture.json)" extension
.claude/skills/verify-afterclass/call.sh "$WORK" GET /captures/cap_ezfc5wzmacr3v72qohuhllql4k "" app
```

Capture ids come from `stableId("cap", name)` in `src/shared/ids.ts`. Replay mode has no recorded or fake tasks, so preparation, claims and reviews do not run from this skill. To prove those, run `bun test test/e2e-replay.test.ts` (it injects scripted tasks) and say which half of the proof each one is.

## Drive: review app in Chrome

The app is at `http://127.0.0.1:$PORT/app/` (deep link `/app/capture/<captureId>`). Navigate there with the Claude in Chrome tools; a navigation carries no header, so the server needs Host and Origin only, and the token comes from the page's `<meta name="afterclass-token">`. `curl` the same URL first to confirm the meta tag is present. Close the tab you opened when done (`tabs_close_mcp`).

## Evidence

Save proofs under `.claude/shots/<pr-or-topic>/` (gitignored, outside `$WORK`, so cleanup keeps them). A proof is the request, the reply and the resulting state, not the final screen alone:

- HTTP: the exact command, the status line and body, then a second read of the state (`GET /captures/:id`).
- Side effects: the `capture_facts` table in `$WORK/data/afterclass.sqlite` (read it with `bun:sqlite` opened `{readonly: true}`; the `sqlite3` CLI may be missing).
- Idempotence (retro 1): resend every write once and show nothing changed (`watchedSeconds` stays 20, row counts match).
- App: a screenshot at the URL plus the page text.

Exercise the real routes. Do not call module functions or edit the database to set up a state, and do not claim live-model behavior from replay mode: label everything here "replay".

## Cleanup

```bash
.claude/skills/verify-afterclass/cleanup.sh "$WORK"
```

Stops the backend by pid (never by process name) and removes `$WORK`. Run it after a failed attempt too, or the port and process stay behind.

## Gotchas

- The pinned extension id is a dummy (`abcdefghijklmnopabcdefghijklmnop`), set only so `extension` requests pass the Origin check. The real id is Derek's, for M11.
- `/app/` is rebuilt on every boot into `dist/app` of the checkout, so two checkouts do not clash but two instances of one checkout rebuild the same files.
- The ingest route accepts the `app` origin as well as `extension`; do not report that as a bug.
- Not proven by this skill: the extension in real Chrome (popup button, stream-id timing, navigation order), the real 5-minute stream deadline, any live Jev or Claude call. The Chrome recipe above was not run end to end when this skill was written; curl on the same URLs was.

## Features

`features/README.md` indexes what to cover.
