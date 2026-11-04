# Capture ingest and retry

The extension posts batches of facts about what Derek watched; the backend stores them and answers with the capture's state.

## Sub-features

- Batch ack: `ackedThroughSeq` is the last `clientSeq` stored.
- Resend: the same batch again changes nothing (R15's retry rule, retro 1).
- Watched time: `watchedSeconds` counts only spans from the batch.

## How to get to it (user POV)

Derek starts capture on a YouTube watch page; the extension sends facts as he watches and stops.

## Driving it with call.sh

1. `call.sh "$WORK" POST /ingest "$(cat fixtures/capture.json)" extension` expects status 200, `ackedThroughSeq` 4, `capture.status.state` `stopped`, `watchedSeconds` 20, one source.
2. Send the same command again. Expect an identical body.
3. `call.sh "$WORK" GET /captures/cap_ezfc5wzmacr3v72qohuhllql4k "" app` expects the same capture.
4. Count rows in `capture_facts` before and after step 2; they must match.

## Gotchas

- The capture id must be a `cap_` id; a made-up string is 400.
- Replay mode runs no preparation here (the log shows a caught `ReplayMiss`), so `invite` stays `none`.
