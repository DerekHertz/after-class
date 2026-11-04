# Experiment 1: the capture probe

The capture probe checks one thing: whether the extension, running in Derek's Windows Chrome on a real lecture, hands the backend watched time and evidence that match what Derek saw. It costs nothing. The backend runs in replay mode, so no Jev call and no Claude call is made. The bars below are fixed. They were adopted on 2026-11-03 before any result existed, and nothing is tuned after a run.

This file is the protocol and, under "Results", the reports from Derek's runs. Results come from Derek's run, and they are pasted in chat, not edited.

## The four bars

Quoted from `docs/flows/after-class.md`, "Experiments and pass bars":

> Capture probe (free). Bar: every watched interval has evidence or a logged gap; ≥9/10 spot checks caption-to-screen within ±2s; board text readable in ≥9/10 frames; zero ad evidence.

| Bar | Text | How it is measured |
| --- | --- | --- |
| 1 | "every watched interval has evidence or a logged gap" | Automatic, from the exported bundle. For each source, take the watched intervals and remove every passage interval and every gap interval, using half-open `[start, end)`. PASS only if zero seconds remain. A frame is an instant and covers no seconds. If nothing was watched, the result is NOT MEASURED. |
| 2 | "≥9/10 spot checks caption-to-screen within ±2s" | Derek checks 10 caption samples against the real video. The wizard records yes or no for each. PASS at 9 or more yes. |
| 3 | "board text readable in ≥9/10 frames" | Derek looks at up to 10 exported frames. PASS at 9 or more readable. |
| 4 | "zero ad evidence" | Automatic candidate list, then Derek's check of each candidate. See below. |

Bars 2 and 3 need exactly 10 results each. If the capture produced fewer than 10 samples, the bar is NOT MEASURED, not passed on fewer.

### Bar 4 and what an ad looks like in the data

An ad has no stretch of lecture time. The extension closes its playback span before an ad starts and records only the point where the lecture stopped (`atContentS`) and how long the ad ran in wall-clock time (`wallDurationMs`). Lecture time resumes afterwards, so lecture evidence just after that point is normal and not ad evidence.

Evidence leaked from an ad would carry the ad video's own clock, which starts at 0. So the window to inspect is `[0, wallDurationMs/1000 + 5 s)` of the same source. The 5 s is `AD_WINDOW_SLACK_S`, one fixed constant for detection lag (the ad is noticed after it starts, so its clock can run past the measured wall time). It was chosen before any data and is not tuned afterwards.

Every frame stamped in the window, every passage that overlaps it, and every watched interval that overlaps it is a candidate. The wizard shows each one and Derek answers: for a frame, "does this frame show an ad?"; for a passage or interval, "is this the lecture, not an ad?" (the video opens at that media time).

- NOT MEASURED when the capture has no ad record, or when any candidate is unchecked. An ad cannot be forced; if YouTube serves none, no ad occurred in this capture and the bar was not exercised. It is never reported as a pass.
- FAIL when Derek judges any candidate to be an ad.
- PASS when there is an ad record, every candidate is checked, and none is an ad. An ad record with zero candidates also passes. The report prints how many candidates were checked.

What the bar scores and does not score is printed in the report's own bar 4 lines: it scores the window, and it does not see ad evidence stamped outside it.


## The perf rule

From `docs/plans/mvp-completion.md`, "Run the capture probe with Derek (M11, experiment 1)":

> Capture overhead on playback (dropped video frames). Chrome media stats with capture on and off, same clip. Baseline: capture off first. Rule: fail above 1 percent more dropped frames.

Interpretation, fixed here and in the report: take `dropped / total` with capture on, subtract `dropped / total` with capture off, and fail if the difference is more than 1 percentage point. Exactly 1.000 points passes. Derek reads the numbers from `video.getVideoPlaybackQuality()` after the first 2 minutes of the same lecture, capture off first. A total of 0 cannot be scored and is NOT MEASURED.

The perf result is reported next to the four bars. A perf FAIL fails the run. A perf probe that was not measured does not block the four bars, but the report says that overhead on playback is unknown.

## Data origin labels

Every line of the report starts with `[fixture]` or `[live]`.

- `fixture` is data made by tests or by hand. It proves the report script works. It says nothing about capture.
- `live` is data from a real capture in Chrome that Derek ran through the wizard; the `Machine:` line says which machine.

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

## Running on macOS

The same wizard runs on a Mac, with Mac Chrome and the backend on the same Mac. It picks its mode from `uname`: Darwin is Mac mode, Linux with `wslpath` is the WSL mode above, anything else exits with a message.

Prerequisites: clone the repo, install Bun 1.4.3 (the wizard warns if `bun --version` differs), and run `bun install --frozen-lockfile` in the repo root. No keys are needed: the backend runs in replay mode. Then, from the repo root:

```
bash scripts/wizards/capture-probe.sh
```

In Mac mode there is no Windows folder: stage 1 builds with `bun run build:ext` and shows the absolute path of `dist/extension` to pick in Chrome's Load unpacked. Frame images open with `open`, the DevTools Console shortcut is Cmd+Option+J, and stage 3 checks `127.0.0.1:4317/health` on the same machine. macOS ships bash 3.2 and the script is written to run on it.

The probe then measures capture on Mac Chrome, a different machine from the WSL and Windows setup, so its numbers are not comparable to a Windows run. The report prints a `Machine:` line (from `--machine <label>`, `unspecified` when absent) to say which.

## What the files are

- `spot-results.json`: `captionChecks` and `frameChecks` (10 each, `index` 0 to 9), `adChecks` (`{kind: "frame"|"passage"|"span", index, isAd}` per ad candidate), and `observations`.
- `perf.json`: `{"off": {"dropped", "total"}, "on": {"dropped", "total"}}`.
- Observations (popup shows the title and caption status; the popup's Review now opens a tab on the review app; whether an ad played) are listed in the report and are not scored. The Review now check has never been made in real Chrome before.

## What NOT MEASURED means

The bar was not exercised, so it is neither passed nor failed. Causes are missing spot results, fewer than 10 samples, no ad in the capture, an unchecked ad candidate, nothing watched, or perf counts that cannot be scored. The overall line is PASS only when none of the four bars is FAIL or NOT MEASURED. Any NOT MEASURED bar means the probe needs another run or another lecture before bar 4 or the sample bars can be claimed.

## What the probe does not show

- It does not measure model accuracy. No Jev or Claude call runs.
- It does not measure learning effectiveness.
- It covers one lecture on one machine in one browser. It says nothing about other videos, other captions, or other hardware.
- A pass is evidence that capture worked in that run, not proof it works in general.
- The ad bar checks only the window described above. Ad evidence stamped outside it is not seen, and every candidate verdict is Derek's eye, not a measurement.
- Data labelled `fixture` shows only that the tools work.


## Results

### Run 1 (2026-11-04, Windows Chrome, backend in WSL)

This is the first real-Chrome run of the capture probe that produced a report. The report below is pasted unedited from `data/probe/probe-report.md`. Nothing was tuned after seeing it; the bars are the ones adopted on 2026-11-03.

What was captured, from the run's own database (it records the six sources, not playlist membership or order):

- One capture, `cap_z7m3abizdfotkmmhuqqulie5t4`, of six videos, all titled '... - Georgia Tech - Advanced Operating Systems': "Introduction" (`-nY-8shbqOo`, the URL entered at the wizard, a link into a playlist), "Routing on the Internet", "An Example", "How to Implement the Vision", "ANTS Toolkit", "ANTS Capsule and API". Their listed durations sum to about 1154 s; the report counts 853.713 s watched.
- This is not one of the two lectures named under "How to run it". It is a set of six short clips, so the run says nothing about a single long lecture. The protocol's "one lecture" limit below applies, and the sources are listed above so the choice is visible.
- The spot checks (10 captions, 10 frames) are Derek's answers in the wizard. The report script scores them; it does not verify them.

Not from this database: an earlier attempt the same day, on the Lamport clocks video (`QgWz_s7uugE`), stopped at stage 8: the exporter picked the newest capture, which was a 70-second capture started after Stop, instead of the 10-minute one. That is fixed in PR #55 (the default is now the capture with the most watched time). That attempt was not scored and no report from it exists. Run 1 used the fixed exporter.

```text
[live] Capture probe report for cap_z7m3abizdfotkmmhuqqulie5t4
[live] Data origin: live
[live] Machine: Windows Chrome, backend in WSL

[live] Bar 1 (coverage): PASS
[live] Bar: "every watched interval has evidence or a logged gap"
[live] Measured: 0 s uncovered of 853.713 s watched, across 6 source(s).
[live] Covered means inside a passage interval or a gap interval, half-open [start, end). A frame is an instant and covers no seconds.

[live] Bar 2 (caption to screen): PASS
[live] Bar: "≥9/10 spot checks caption-to-screen within ±2s"
[live] Measured: 10/10 caption spot checks matched.

[live] Bar 3 (board text): PASS
[live] Bar: "board text readable in ≥9/10 frames"
[live] Measured: 10/10 frames with readable board text.

[live] Bar 4 (ads): NOT MEASURED
[live] Bar: "zero ad evidence"
[live] Measured: no ad occurred in this capture, so the bar was not exercised.

[live] Perf probe (capture overhead): PASS
[live] Bar: "Capture overhead on playback (dropped video frames). Chrome media stats with capture on and off, same clip. Baseline: capture off first. Rule: fail above 1 percent more dropped frames."
[live] Interpretation: (dropped/total with capture on) minus (dropped/total with capture off) above 1 percentage point fails.
[live] Measured: off 0/3743 = 0%, on 5/3646 = 0.137%, difference 0.137 percentage points.

[live] Observations outside the bars (unscored, from real Chrome)
[live]   Does the popup show the video title and a caption status such as Captions found? yes
[live]   Did Review now open a tab on the review app at 127.0.0.1:4317 that shows this capture? yes
[live]   Did an ad play during the capture? no

[live] OVERALL: NOT PASSED (not measured: bar 4)
```

Reading it, without going beyond it:

- Bars 1, 2 and 3 and the perf probe passed in this run. Bar 4 was NOT MEASURED because YouTube served no ad, so by the rule above the overall line is NOT PASSED and the probe is not complete.
- The perf probe is one measurement (capture off 0 of 3743 dropped, on 5 of 3646) on one machine. It is not evidence about other hardware or longer sessions.
- Observations outside the bars: the popup showed the title and a captions status, and Review now opened a tab on the review app showing this capture. Both are noted as `yes` by Derek. The protocol says the Review now check had never been made in real Chrome before.
- Still open: bar 4 needs a capture in which an ad plays (it cannot be forced), and a run on one of the two approved single lectures would answer the "one lecture" limit. Derek also reported running it on a Mac earlier; that run is not recorded here.
