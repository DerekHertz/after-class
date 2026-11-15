# Where the first review's wait goes, and the first-chunk cap

Measurement report, 2026-11-15, for issue #247. Derek's goal is a beta his friends find fast. On preparing only reviewed blocks he said: "this is enticing but i think we can come up with a method to reduce the wait time". This report times every stage of the first review's wait on replayed lectures, ships the cut that needs no product call, and lists the rest for Derek.

## How to read the numbers

- **Measured** means read from a run's database: `capture_facts`, `memo`, `chunk_revisions` and `usage_events`.
- **Replayed** means the product's `buildWindows` and `planChunks` run over a run's recorded Jev judgments. No call is made.
- **Estimated** means arithmetic on measured figures.
- Times are wall seconds after the capture's first fact. The replay script sends the recorded facts at their original upload times with gaps cut to 15 s, so wall time is close to watched time.
- "First review ready" is when the first chunk's interpretation, claim checks and revisions have all finished, which is when "Review now" can start a review of it.
- Each lecture ran once per side. Run-to-run spread is not measured. The section close is set by the replay pacing and Jev, and the replayed close matched the live close within 8 s.

## What ran

| Run | Code | Lecture | Watched |
| --- | --- | --- | --- |
| A | master 9b97c84, from the cost work | Krebs cycle, Khan Academy, board lecture | 17.8 min |
| C | `perf/beta-cost` 14b6f87, short labels, from the cost work | Global Memory System, GT Advanced OS, slides over 9 clips | 20.0 min |
| K | this branch, labels and the first-chunk cap | Krebs, as run A | 17.8 min |
| G | this branch | Global Memory System, as run C | 20.0 min |

Runs K and G ran at the same time, each on its own local backend in live mode. Claude went through `claude -p` with the CLAUDE.md flags and Jev through `keys.env`. Both read copies of the source data. Derek's live database was not read. The scripts are `timeline.ts`, `sweep.ts`, `psum.ts`, `replay.ts` and `serve.sh` in the session scratchpad folder `wait/`.

## Before: where the first review's wait goes

| Stage | Krebs, run A | GMS, run C (labels) |
| --- | --- | --- |
| Watching until the last window of the first section is judged | 218 s | 554 s |
| Holding a section whose cut was already settled, until the 8-minute cap fires | **364 s** | 0 s |
| Close to interpretation start, the queue | 0.9 s | 1.5 s |
| Interpretation | 74 s, about 40 s with labels | 48 s |
| Claim checks and revisions | 1.0 s, no revision | 20.6 s, one revision of 19.1 s |
| **First review ready** | **659 s (10:59)**, about 625 s with labels (estimated) | **624 s (10:24)** |

All figures are measured except the label estimate for Krebs. That estimate takes run A's close and the paired label interpretation of the same chunk input from the cost work, 40.0 s.

- **The 8-minute cap is the limiter.** Watching until the cap fires is 89% of GMS's wait and 88% of Krebs's. No section closed on a boundary in either run.
- **Boundaries do not fire because the lectures have no topic change.** The 2026-11-14 report traced this. The boundary question asks for "a different main subject", and a single-subject lecture has none. That is the question working as Derek approved it, so this work does not touch it.
- **The queue is not a limiter.** Interpretation starts 0.3 to 2.6 s after a close in all four runs. Claim checks and revisions already outrank interpretation in the scheduler, so a first chunk's revision never waits behind the next chunk's interpretation.
- **Interpretation is second.** With labels it takes 36 to 48 s for a first section.

## The change: a 210 s cap for a capture's first chunk

The first chunk of a new capture now closes once it holds 210 s of material, cut back to the latest soft pause, as the 8-minute cap is. Later chunks keep the 8-minute cap. Flow B calls its numbers "starting values to tune", and this tunes the cap for the first chunk only. No Jev question, threshold, window or Claude prompt changes.

**Choosing 210 s.** The decision rule was the smallest first cap whose first chunk ends at a soft pause in every recorded capture. Replayed over six recorded captures (runs A and C, Derek's two lectures, the Fable run's two captures):

| First cap | First close, the six captures | First chunk ends at a soft pause |
| --- | --- | --- |
| 480 s, today | 542 to 757 s | 6 of 6 |
| 240 s | 289 to 493 s | 6 of 6 |
| 210 s | 243 to 442 s | 6 of 6 |
| 180 s | 192 to 391 s | 4 of 6 |

At 210 s the first chunk is the same as at 240 s in all six, about 50 s sooner. At 180 s three captures cut at a window Jev did not call a stopping point. The chunk count is unchanged in all six.

**Stored lectures are not re-planned.** The fold runs again over every stored capture at boot, so a new first cap would cut an old lecture's first chunk again and orphan claims that cross the new cut. Migration `segmentation/003-plain-first-cap` lists every capture that already has chunks, and those keep the plain cap. On a copy of Derek's data the new code booted with no new chunk revision. With the list emptied, the same boot appended 4 revisions to the GT AOS lecture.

## After

| Stage | Krebs, run K | GMS, run G |
| --- | --- | --- |
| Watching until the last window of the first section is judged | 213 s | 245 s |
| Holding until the 210 s cap fires | 54 s | 0 s |
| The queue | 0.5 s | 2.6 s |
| Interpretation | 41 s | 36 s |
| Claim checks and revisions | 12.6 s, one revision | 16.6 s, two revisions |
| **First review ready** | **321 s (5:21)** | **299 s (4:59)** |

- **First review ready: GMS 624 s to 299 s, Krebs about 625 s to 321 s.** Both measured after. Krebs's before is estimated as above, and is 659 s measured on master.
- **The same Krebs chunk.** Run K's first chunk is the same 184 s of material as run A's, and its interpretation took 41.0 s against 40.0 s in the paired label sample. So the gain there is the cap wait alone.
- **Why not sooner.** The first section still needs about 210 s of watching, and a close is decided only when a 45 s window is judged. Krebs also holds 54 s, because the cap fires a window after the soft pause it cuts back to. Interpretation and checks are the remaining 54 to 55 s.
- **The wait after Stop is unchanged.** It was 120 s in run A and 118 s in run K, and 70 s in run C and 62 s in run G (measured).

## Cost

| Run | Interpretation | Revisions | Preparation per lecture-hour |
| --- | --- | --- | --- |
| C, GMS before | 3 calls, $0.51 | 5 calls, $0.44 | $3.00 |
| G, GMS after | 3 calls, $0.56 | 2 calls, $0.07 | $2.05 |
| A, Krebs on master, no labels | 3 calls, $0.89 | 1 call, $0.24 | $3.87 |
| K, Krebs after | 4 calls, $0.69 | 12 calls, $0.54 | $4.21 |

Estimated at list prices from measured tokens with the cost work's `price.ts`.

- **GMS kept 3 chunks.** Interpretation rose 10%, $0.51 to $0.56, from 15,506 to 17,717 output tokens. One run per side, so this is inside what the cost work saw between two samples of one task on other chunks.
- **Krebs gained a chunk in run K.** Run K's own Jev answers differ from run A's. Replayed over run K's answers, the 8-minute cap makes 3 chunks (460, 422 and 110 s) and the 210 s cap makes 4 (184, 276, 422 and 110 s). So with those answers the first cap split a 460 s first section and added one Opus interpretation. Interpretation wrote 23,615 output tokens against 18,316 for the paired label sample of run A's 3 chunks, 29% more (estimated). The chunk count is unchanged in the other seven judgment sets replayed.
- **Revisions swing the totals more than the cap.** Run K made 12 revisions, 7 of them in the last 110 s chunk, which the cap does not change. The cost work saw 1 to 5 per 20 minutes. So run K's $4.21 is mostly revisions, not the extra chunk.
- Jev for runs K and G cost $0.08 together (estimated from measured tokens). Claude ran on the subscription.

## Cuts that need Derek's call

Measured or replayed, and not built.

1. **Close the first chunk at its first soft pause after 180 s.** Krebs's first close would move from 267 s to about 213 s, and GMS's would not move (replayed). It saves the 54 s Krebs held. The flow B table's soft-pause row says "Soft pause inside topic; don't close", so this changes that row.
2. **Start the first review before its revisions finish.** The claims under revision would sit out of the review until they pass. It saves the 13 to 17 s check and revision tail. It changes what a review covers when it starts.
3. **Interpret the first section in two pieces at once.** It would cut about 36 to 41 s of interpretation to perhaps 20 to 25 s (guess) and adds one Opus call per lecture. Interpretation would see half a section, which changes model input and needs an audit.
4. **Sonnet or effort medium for interpretation.** This is experiment 4 and the cost work's first lever. It shortens the 36 to 48 s interpretation by an amount not measured on this lecture.

Proposed flow B line for Derek to adopt or reword, since the flow doc does not yet say it: "The first chunk of a capture closes at a ~3.5 min cap (cut at the latest soft pause), provenance 'time'. Later chunks keep ~8 min." The TLA+ model treats time as abstract, so it is unaffected.

## Limits

- One run per side, and runs K and G ran at the same time while run C ran alone.
- The Krebs before with labels is estimated from run A and a paired call, not a full run.
- Claim quality under the shorter first chunk is not audited. Jev's first-check pass rate is a proxy only.
- All timings are local `claude -p`, not the hosted Messages API.
