# Assembled captures (support for experiment 2, the Jev lab)

The lab needs more clip joins than one capture gives. `scripts/assemble-capture.ts` replays the recorded facts of several captures into ONE capture in a NEW data dir. This is replay of recorded live data, never new lecture content, and the result is always labeled: data origin "assembled (replayed live data)", not one live session.

```
bun run scripts/assemble-capture.ts --in <dataDir>:<captureId> [--in <dataDir>:<captureId> ...] --out <newDataDir>
bun run scripts/assemble-capture.ts --describe <dataDir>
```

- Inputs in the order given are the watch order of the result. No Jev call, no Claude call, no key, no network.
- Each input is read through a scratch copy of its sqlite; frame files are only read. `--out` must be new or empty and not inside (or via symlink or `..` inside) an input dir.
- Facts go through the product's own `evidence.ingest`, so tables and frame files are the product's. Frame-change judgments are not run (frames show `unjudged`).
- Changed from the inputs: a new capture id; each input's `control start` and `control stop` dropped, one `start` first and one `stop` last (pause and resume kept); `clientSeq` renumbered; `wallMs` of each later input shifted to follow the earlier one by 1000 ms (relative timing kept; wall time is for ordering only); a `frameId` gets an `in<N>-` prefix only when two inputs reuse it. Nothing else.
- Checked before anything is kept (otherwise the output is removed and the run fails): for every video of every input, the same watched intervals, passages (times and text), frames (media times, size, bytes), gaps and ads; and total watched seconds equal the sum over distinct videos. A video in two inputs is refused unless its facts are identical (then the first input's copy is used).
- Writes `ASSEMBLED.json` (machine-readable) and `ASSEMBLED.md` in the out dir: input data dirs, capture ids, sha256 of each input's sqlite, the order, what was dropped and shifted, and the clip joins with the cumulative watched second where each lands.
- Other tools: `readProvenance(dataDir)` returns the provenance or null, and `provenanceLine(p)` is a one-line label. `jev-lab` does not print it yet.
