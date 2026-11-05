# Model label-proposal tool (experiment 6, stages 2 to 4)

`scripts/jev-lab-propose.ts` asks a Claude model to PROPOSE labels for a lecture set so Derek can verify them. It is the code for stages 2 (timing pilot), 3 (model labels) and the proposal side of stage 4 of `docs/experiments/06-model-optimized-jev.md` (merge `docs-exp6-protocol`, PR #60, first; this note belongs under its stages). Proposals are a model's, not Derek's labels and not truth. Everything below marked PROPOSED needs Derek's OK before any call.

```
bun run scripts/jev-lab-propose.ts plan    --data <assembledDir> --capture <id>
bun run scripts/jev-lab-propose.ts pilot   --model <id> --out <dir> [--data <dir> --capture <id>] [--live-claude --max-claude-calls N]
bun run scripts/jev-lab-propose.ts propose --data <assembledDir> --capture <id> --model <id> --out <dir> [--live-claude --max-claude-calls N]
bun run scripts/jev-lab-propose.ts compare --a <proposals.json> --b <proposals.json> --out <file>
```

Models: `claude-opus-5-5` and `claude-fable-5-1` only (any other id is refused). Effort `high` (PROPOSED, `--effort` can change it).

## What one call is

One Claude call covers one clip, or one chunk of a clip. The prompt has the transcript passages of the clip with their media times, the captured frames as image files that Claude reads with the Read tool (each labelled `frame <id> at <mediaS> s`), and the clip's watched span. A clip with more than 24 frames is split into calls of at most 24 frames, neighbouring calls sharing 3 frames (`CHUNK_OVERLAP_FRAMES`, PROPOSED); the prompt says so. The prompt carries, verbatim: Derek's visual-step rule, the product's own `QUESTIONS` for a new concept, a stopping point and a frame teaching change, and the statement that the model has NOT seen any Jev output and no other model's labels. Nothing about a split, a held-out half or a score is in it.

The model answers with strict JSON: boundaries inside the clip, visual steps, duplicate groups (frames of the call, by `frameId` and `mediaS`), each with a one-sentence reason. Clip JOINS are not asked: code adds a boundary candidate (`source: "join"`) at the start of each later clip, because the product does not close a chunk when a video ends and the next clip's first window decides.

A reply is accepted only if it parses as one JSON object (one code fence is allowed), has exactly the three arrays, every time lies in `[start, end)` of the clip's watched span, every reason is a non-empty string, every duplicate frame is a frame shown in that call (a frame named only by its time must match a shown frame's time), a group has at least 2 distinct frames, and no frame is in two groups. Otherwise the reply is stored with the reason and the call is retried ONCE with the reason appended. A second failure stops the run: nothing is repaired or invented, no `proposals.json` is written, and the README says INCOMPLETE. Chunk results of one clip are merged by code, not by a model: an item within `MERGE_TOLERANCE_S` (10 s, PROPOSED) of an item kept from an earlier call of the same clip is the same item (the earlier wording stays); duplicate groups of different calls that share a frame become one group.

Cross-clip duplicate groups are not proposed (each call sees one clip). Derek can add them in the sheet.

## Output of `propose`

`<out>/proposals.json`, `<out>/README.md`, and `<out>/calls/<n>.prompt.txt`, `.response.txt`, `.meta.json` for every attempt (model, effort, origin, latency, attempt, refused reason, usage, the labels of the attached images). A prompt is stored before its call is made; the image file paths the client appends are temporary and are not stored.

`proposals.json`, schemaVersion 1 (the TypeScript types `LabelProposals` and `validateProposals` are exported from the script):

```json
{ "schemaVersion": 1, "kind": "label-proposals",
  "proposedBy": { "model": "claude-opus-5-5", "effort": "high" },
  "captureId": "cap_...", "provenance": "assembled (replayed live data): ..." ,
  "createdAt": "ISO date-time", "origin": "live",
  "items": {
    "boundaries":      [{ "videoId": "...", "mediaS": 12.5, "reason": "...", "source": "model" | "join" }],
    "visualSteps":     [{ "videoId": "...", "mediaS": 40, "reason": "..." }],
    "duplicateGroups": [{ "frames": [{ "videoId": "...", "mediaS": 10, "frameId": "ev_..." }], "reason": "..." }] } }
```

`provenance` is `provenanceLine(readProvenance(dataDir))` or null. `origin` is an addition to the brief's schema (optional in the validator): `"fixture"` marks a file made by a scripted client, so it cannot be mistaken for a model's proposals. No unknown field is allowed.

## `compare`

Deterministic, no model call. Items both models proposed (same video, times within `COMPARE_TOLERANCE_STEP_S` = 10 s for steps and `COMPARE_TOLERANCE_BOUNDARY_S` = 60 s for boundaries, both PROPOSED), only A, only B. Pairing is one-to-one, nearest pair first. Join candidates are code in both files, so they are counted, not compared. Duplicate groups match when they share a frame (same `frameId`, or without ids the same video and a time within `COMPARE_FRAME_MATCH_S` = 2 s, PROPOSED). Output: `kind: "proposal-comparison"` JSON with `both: [{a, b}]`, `onlyA`, `onlyB` per kind; an existing `--out` and proposals of different captures are refused.

## Safety rails (all enforced in code and tested)

- No Claude call without `--live-claude` AND `--max-claude-calls N` (a positive integer). Without them only an injected scripted client runs (tests); `propose` and `pilot` refuse the real client. `plan` makes no call and prints the planned count.
- A persisted counter `claude-state.<origin>.json` in the parent of `--out` (validated; malformed refuses). A deleted state file cannot reset it: every attempt writes a `calls/<n>.meta.json` BEFORE the call, and the metas of all sibling output dirs are a floor. Hard ceiling `BUDGET_CLAUDE_CALLS` = 150 for the whole experiment (PROPOSED in the protocol, decision 6), checked before every call, retries included; `--max-claude-calls` is checked the same way. A run refuses up front if its planned calls exceed N or would pass the ceiling.
- Claude only through the product's client (`createClaudeCli`, reused unchanged): `claude -p --restricted --tools Read --strict-mcp-config --disable-slash-commands --no-session-persistence`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` stripped from the child env (and `TYPESAFE_API_KEY` too), frames copied to a per-call temp dir that the client deletes. The child runs in a fresh empty temp dir as its cwd. The tool uses `streamText` so the reply text is stored verbatim.
- The data dir is read through a scratch copy of its database (`openCapture`) and frame files are only read; it is byte-identical afterwards. `--out` inside the data dir (also via a symlink) or non-empty is refused.
- Stored text has the values of the secret env vars replaced by `[redacted]`. No Jev call, no key file, no network code of the tool's own.

## Planned calls on the assembled 11-clip capture

`plan` on a copy of `data/lab/assembled` (393 frames, 11 clips): 23 calls per model for `propose` (clips of 17, 33, 19, 28, 37, 3, 33, 35, 93, 62 and 33 frames take 1, 2, 1, 2, 2, 1, 2, 2, 5, 3 and 2 calls), 46 for both models, plus 3 pilot calls per model: 52 minimum, within the 150 ceiling, with 98 left for retries and the optimizers. The protocol's rough figure of "about 2 x 40" for the labelers is higher than this because it assumed smaller chunks.
