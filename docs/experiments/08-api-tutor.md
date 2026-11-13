# Experiment 8: does the Messages API run the tutor turn and the wrap-up, and at what cost?

Experiment 8 is outside the five approved in `docs/flows/after-class.md`. Derek's approval of the cases, bars and spend cap below on 2026-11-12 covers it. It spends real money on the Anthropic API, so it needs his key and his go-ahead for each run.

Status: PROTOCOL, written before any result. No call has been made.

## Why

The product calls Claude through `claude -p` on Derek's subscription. That path reports a notional cost and has no control over caching. This experiment tries a second backend that calls the Messages API through the official SDK, so a review's lecture context can be cached across its turns and its cost is measured from usage.

Derek approved one new dependency for it, `@anthropic-ai/sdk` at exactly 1.5.0. The backend is `src/backend/providers/claude-api.ts`. `AFTERCLASS_CLAUDE_BACKEND=api` routes only the tutor turn and the wrap-up to it, and every other Claude task keeps the CLI. The default is the CLI and its behavior is unchanged.

## Cases

Derek, 2026-11-12: "the 10 tutor inputs and the wrap-up from your 11 Nov review, replayed through the API on Opus 5.5 at the same effort".

The runner reads those 11 inputs from `memo_inputs` in a copy of the live database. It sends each stored `system` and `prompt` once, at the stored effort, on `claude-opus-5-5`. Tutor turns stream, and the wrap-up is a structured call checked against `wrapUpSchema`. The memo is not used, so nothing is cached locally and the copy is not written.

## Bars

Derek, 2026-11-12:

- "All 10 moves pass `validateMove` with no repair attempt."
- "From turn 2 on, the lecture context is read from cache."
- "Actual cost is at or below the CLI's notional $1.27 for the same calls."
- "Time to first sentence is reported with no target."

## Spend cap

Derek, 2026-11-12: "$5, which leaves room for one optional Sonnet 5.5 arm on the same cases".

The runner takes `--cap-usd` with a default of 5. Before every call it reserves a worst case for that call. The worst case prices every byte of the system text, the prompt and the serialized output schema as a token written to the 1 hour cache. It adds a fixed allowance of 4,096 input tokens for the request framing and spends the whole output limit. The assumptions behind that bound are written in the comment on `worstCaseUsd` in `claude-api.ts`. If the measured cost so far, plus what is reserved for calls that may have been billed, plus the worst case for the next call could pass the cap, the run stops before the call and says so.

After each call the runner checks the bound. If a finished call cost more than it was reserved at, the runner records an overrun, stops at once, prints both figures and exits with code 4. The computed total may then be above the cap, and Derek's console is the check.

What a failed call counts depends on whether the API could have billed it.

- An authentication or permission error (HTTP 401 or 403) stops the run at once with a clear message and exit code 3, because no later call can succeed. The call was not billed.
- A call that fails with an error the API does not bill counts as $0 toward the cap and is labelled "failed, not billed". These are an invalid request, a missing model, a rate limit, a server error answered with an HTTP status, and any failure before a request was sent. The run goes on to the next call.
- A call that may have been billed keeps its worst-case reservation and is labelled "failed, may have been billed (reserved)". These are a timeout, a connection that broke after the request was sent, and a stream that broke partway through a response.
- A call that returned usage is measured from that usage, even when it ended in a refusal or a stop that is not a finished answer.

The results show two separate totals, the measured cost and the amount reserved for calls that may have been billed. They are never added into one figure, and the reserved amount is not a cost. The runner also refuses to start when the database copy is inside the output folder, and refuses to overwrite a results file from an earlier run. The optional Sonnet arm is the same command with `--model sonnet`.

## What this tests

Derek, 2026-11-12: "It tests plumbing and cost. It says nothing about tutoring quality or about marketing and psychology."

## Where the runner measures something weaker than a bar

1. The `validateMove` bar. The memo stores each call's rendered `system` and `prompt` text, not the `TutorInput` they came from. Rebuilding it needs the review's usable claims and its evidence bundle as they stood at the time of the call. Preparation and evidence compute those from state that a later copy of the database does not reflect, and both write to the database when they open. So the runner does not rebuild it. It makes a weaker check on each tutor reply. The first line must parse as a move header with `parseMoveHeader`, and the move kind must be one of the allowed moves that the stored prompt names on its "Allowed moves this turn" line. It does not check thread ids, claim ids, cited evidence or the question counts. A row that passes the weaker check can still fail `validateMove`. The results say "header checks passed" and never say "validated".
2. The no-repair bar. The runner sends each stored input once and does not repair. A reply with a bad header is a failed row. It also marks any stored input that already carries the repair note, because that turn needed a repair when the CLI ran it. The note starts with "Your previous reply was rejected".
3. The time to first sentence. The runner measures the time from the request to the first streamed text delta. A tutor reply starts with a one-line JSON header, so the first delta arrives before the first spoken sentence. The figure is a lower bound on time to first sentence, and the results say so.
4. The cache read from turn 2. The runner counts the tutor turns after the first one for each distinct system prompt, and how many of them report cache-read tokens above zero. It does not check that the read covers the whole lecture context. Compare each row's cache-read tokens with the first row's cache-write tokens for that. A run within an hour of an earlier one can also read a cache that the earlier run wrote, so the first turn may show a read.
5. The cost. The runner computes cost from the response's usage and a price table in `claude-api.ts`, which is Opus 5.5 at $4 input and $20 output per million tokens with cache reads at $0.20, and Sonnet 5.5 at $2, $10 and $0.10. Cache writes cost 1.25 times the input price for the 5 minute lifetime and 2 times for the 1 hour lifetime, from `shared/prompt-caching.md` in the claude-api skill, read 2026-11-12. The request asks for the 1 hour lifetime. The cost is stored with the existing `estimated` kind and the basis `anthropic_api_list_price`. It is an estimate from list prices and not a bill, so Derek's console is the check on the real spend.
6. The CLI's $1.27. The runner sums the notional costs that `usage_events` in the copy holds for the same inputs and prints that figure next to the API cost. The two come from different accounting, a figure the CLI reported against a price-table estimate from usage. The bar uses Derek's $1.27, and the runner's sum is there to show whether it matches.

## Procedure

1. Put `AFTERCLASS_ANTHROPIC_API_KEY=<key>` in `~/.config/afterclass/keys.env` at mode 0600. The runner reads the key from that file the way the backend does and exits with a message when it is missing.
2. Copy the live database to a scratch folder, with its `-wal` and `-shm` files if they exist.
3. Run the dry run and check that it lists exactly 11 calls, 10 tutor turns and one wrap-up. `--since` is an ISO date, and a date with no time is read as midnight UTC, so pass a full timestamp if reviews from the same UTC day belong to another review.

   `bun run scripts/experiments/api-tutor-replay.ts --db <copy> --since <ISO date> --out <dir> --dry-run`

4. Run it for real.

   `bun run scripts/experiments/api-tutor-replay.ts --db <copy> --since <ISO date> --out <dir>`

5. Optionally run the Sonnet 5.5 arm with `--model sonnet` and another `--out`.
6. Read `results.md` in each output folder. `results.json` has every field.

Every row in both files is labelled live. Nothing in this experiment is a mock or a replay of recorded model output. The inputs are recorded, and every output is a new call.

## Results

