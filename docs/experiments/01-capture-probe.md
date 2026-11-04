# Experiment 1: the capture probe

The capture probe checks one thing: whether the extension, running in Derek's Windows Chrome on a real lecture, hands the backend watched time and evidence that match what Derek saw. It costs nothing. The backend runs in replay mode, so no Jev call and no Claude call is made. The bars below are fixed. They were adopted on 2026-11-03 before any result existed, and nothing is tuned after a run.

This file is the protocol. It has no results section yet. Results come from Derek's run, and they are pasted in chat, not edited.

## The four bars

Quoted from `docs/flows/after-class.md`, "Experiments and pass bars":

> Capture probe (free). Bar: every watched interval has evidence or a logged gap; ≥9/10 spot checks caption-to-screen within ±2s; board text readable in ≥9/10 frames; zero ad evidence.

| Bar | Text | How it is measured |
| --- | --- | --- |
| 1 | "every watched interval has evidence or a logged gap" | Automatic, from the exported bundle. For each source, take the watched intervals and remove every passage interval and every gap interval, using half-open `[start, end)`. PASS only if zero seconds remain. A frame is an instant and covers no seconds. If nothing was watched, the result is NOT MEASURED. |
| 2 | "≥9/10 spot checks caption-to-screen within ±2s" | Derek checks 10 caption samples against the real video. The wizard records yes or no for each. PASS at 9 or more yes. |
| 3 | "board text readable in ≥9/10 frames" | Derek looks at up to 10 exported frames. PASS at 9 or more readable. |
| 4 | "zero ad evidence" | See below. |

Bars 2 and 3 need exactly 10 results each. If the capture produced fewer than 10 samples, the bar is NOT MEASURED, not passed on fewer.

### Bar 4 and what an ad looks like in the data

An ad has no stretch of lecture time. The extension closes its playback span before an ad starts and records only the point where the lecture stopped (`atContentS`) and how long the ad ran in wall-clock time (`wallDurationMs`). Lecture time resumes afterwards, so lecture evidence just after that point is normal and not ad evidence.

If an ad frame leaked, it would carry the ad video's own clock, which starts at 0. So the probe lists every frame stamped inside `[0, wallDurationMs/1000)` of the same source as a candidate, and Derek looks at each one and says whether it shows an ad. The bar PASSES when no candidate shows an ad (including when there are no candidates), FAILS when one does, and is NOT MEASURED while a candidate is unchecked.

Two limits follow from this and are printed in the report. The report cannot tell leaked ad time inside the watched intervals from real viewing of a lecture's first seconds, so that overlap is shown but not scored. And an ad cannot be forced. If YouTube serves none, there is no ad record and the bar is reported NOT MEASURED, because no ad occurred in this capture and the bar was not exercised. It is never reported as a pass.

## The perf rule

From `docs/plans/mvp-completion.md`, "Run the capture probe with Derek (M11, experiment 1)":

> Capture overhead on playback (dropped video frames). Chrome media stats with capture on and off, same clip. Baseline: capture off first. Rule: fail above 1 percent more dropped frames.

Interpretation, fixed here and in the report: take `dropped / total` with capture on, subtract `dropped / total` with capture off, and fail if the difference is more than 1 percentage point. Exactly 1.000 points passes. Derek reads the numbers from `video.getVideoPlaybackQuality()` after the first 2 minutes of the same lecture, capture off first. A total of 0 cannot be scored and is NOT MEASURED.

The perf result is reported next to the four bars. A perf FAIL fails the run. A perf probe that was not measured does not block the four bars, but the report says that overhead on playback is unknown.

## Data origin labels

Every line of the report starts with `[fixture]` or `[live]`.

- `fixture` is data made by tests or by hand. It proves the report script works. It says nothing about capture.
- `live` is data from a real capture in Windows Chrome that Derek ran through the wizard.

The wizard always passes `--origin live`. The report script defaults to `fixture`, so a hand-run report is never mistaken for a live one.

## How to run it

Derek runs this in WSL bash from the repo root. Windows Chrome does the capturing.

```
bash scripts/wizards/capture-probe.sh
```

The wizard takes nine stages:

1. Builds the extension into a Windows folder (Chrome does not load extensions from `\\wsl$`).
2. Loads it in Chrome and saves the public extension ID in `.env`.
3. Starts the backend itself in replay mode on `data/probe`, shows the pairing token on screen only, and checks that Windows Chrome reaches `127.0.0.1:4317`.
4. Pairs the extension (expects "Connected to the backend.").
5. Measures dropped frames with capture off.
6. Measures dropped frames with capture on, then asks for 10+ more minutes of watching with a pause, a seek back, a speed change, and an ad if YouTube serves one. It records three observations.
7. Stops the capture, waits until the backend has stored the stop, then stops its own backend process.
8. Exports samples (`scripts/probe-export.ts`) and walks the caption, frame and ad-candidate checks.
9. Runs `scripts/probe-report.ts --origin live` and saves `data/probe/probe-report.md`.

The approved lectures are MIT 18.06 Lecture 1, "The geometry of linear equations" (a chalkboard), and the Georgia Tech Lamport clocks lesson `QgWz_s7uugE`.

Stopping with Ctrl-C and re-running is safe. The extension ID and lecture URL are reused from `.env`. Everything under `data/probe/` is gitignored.

The tools can also be run by hand:

```
bun run scripts/probe-export.ts --data data/probe --out data/probe/export
bun run scripts/probe-report.ts --bundle data/probe/export/bundle.json \
  --spot data/probe/spot-results.json --perf data/probe/perf.json --origin live
```

`probe-export` reads a scratch copy of the database and only reads frame files, so it never writes the data dir and never makes a model call. It samples deterministically: 10 passages spaced evenly over watched time, each wholly inside a watched interval, and up to 10 frames spaced evenly over the frames that are not dropped and still have a file. Without Jev, frames are not judged, so they show as unjudged and all count. The exit code of `probe-report` is 0 only when the overall line reads PASS.

## What the files are

- `spot-results.json`: `captionChecks` and `frameChecks` (10 each, `index` 0 to 9), `adFrameChecks` for ad candidates, and `observations`.
- `perf.json`: `{"off": {"dropped", "total"}, "on": {"dropped", "total"}}`.
- Observations (popup shows the title and caption status; the popup's Review now opens a tab on the review app; whether an ad played) are listed in the report and are not scored. The Review now check has never been made in real Chrome before.

## What NOT MEASURED means

The bar was not exercised, so it is neither passed nor failed. Causes are missing spot results, fewer than 10 samples, no ad in the capture, an unchecked ad candidate, nothing watched, or perf counts that cannot be scored. The overall line is PASS only when none of the four bars is FAIL or NOT MEASURED. Any NOT MEASURED bar means the probe needs another run or another lecture before bar 4 or the sample bars can be claimed.

## What the probe does not show

- It does not measure model accuracy. No Jev or Claude call runs.
- It does not measure learning effectiveness.
- It covers one lecture on one machine in one browser. It says nothing about other videos, other captions, or other hardware.
- A pass is evidence that capture worked in that run, not proof it works in general.
- The ad bar cannot prove that no ad time leaked into a watched interval. It checks stamped frames and relies on Derek's eye.
- Data labelled `fixture` shows only that the tools work.
