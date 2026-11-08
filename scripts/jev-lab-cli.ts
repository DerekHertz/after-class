/**
 * Experiment 2, the Jev boundary and visual lab (docs/experiments/02-jev-lab.md is the protocol).
 *
 *   bun run scripts/jev-lab.ts draft-labels --data <dir> --capture <id> [--video <id>] --out <file> [--force]
 *   bun run scripts/jev-lab.ts draft-labels-set --data <dir> --capture <id> --out <file> [--force]
 *   bun run scripts/jev-lab.ts split   [--data <dir>] --labels <file>...      (--data is needed for a set of clips)
 *   bun run scripts/jev-lab.ts plan    --data <dir> --labels <file>... [--arm-config <file> [--lab <dir> --arm <name>]]
 *   bun run scripts/jev-lab.ts run     --data <dir> --lab <dir> --labels <file>... --phase tune|score [tuning flags]
 *                                      [--live --max-calls <n> [--keys <path>]]
 *   experiment 6 arm run: run ... --arm <name> --phase tune --arm-config <file>   (directory <lab>/exp6/<arm>/<origin>)
 *                         run ... --arm <name> --phase score                      (scores the arm's selected round)
 *   experiment 7 arm run (opt-in, directory <lab>/exp7/<arm>/<origin>): run ... --exp7 --arm <name> --phase tune --exp7-config <file>
 *                         the six wordings, lesson-framing routing and frame relevance over kept frames; run ... --exp7 --arm <name> --phase score
 *   bun run scripts/jev-lab.ts report  --results <file> --labels <file>...
 *   bun run scripts/jev-lab.ts rescore --results <file> --labels <file>... [--expect <report.txt>]
 *
 * Everything reads a scratch copy of <data>/afterclass.sqlite, so the real data dir is never written. `run` makes no
 * Jev call unless --live, a 0600 keys file with TYPESAFE_API_KEY, --max-calls within the budget and signed_off labels
 * all hold. Without --live it uses a deterministic fake and everything it prints is tagged [fixture].
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ArmConfig, Exp7ArmConfig } from "./jev-lab-arm";
import { validateArmConfig, validateExp7ArmConfig } from "./jev-lab-arm";
import type { Origin } from "./jev-lab-score";


import type { Overrides } from "./jev-lab";
import { describeSplit, loadLabels, planLab, refuse, reportFromFile, runLab } from "./jev-lab";
import { draftLabels, draftLabelsSet } from "./jev-lab-draft";
// ───────────────────────────── command line ─────────────────────────────

const tag = (origin: Origin, lines: readonly string[]) => lines.map((l) => (l === "" ? l : `[${origin}] ${l}`)).join("\n");

export async function cli(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    allowPositionals: false,
    options: {
      data: { type: "string" }, capture: { type: "string" }, video: { type: "string" }, out: { type: "string" }, force: { type: "boolean" },
      labels: { type: "string", multiple: true }, lab: { type: "string" }, phase: { type: "string" }, live: { type: "boolean" }, "max-calls": { type: "string" },
      keys: { type: "string" }, origin: { type: "string", default: "fixture" }, results: { type: "string" }, expect: { type: "string" },
      "window-new-s": { type: "string" }, "context-s": { type: "string" }, "time-cap-s": { type: "string" }, "max-frames-per-window": { type: "string" },
      "revise-on-next-no-no": { type: "string" }, "yes-at": { type: "string" }, "no-at": { type: "string" },
      arm: { type: "string" }, "arm-config": { type: "string" }, exp7: { type: "boolean" }, "exp7-config": { type: "string" },
    },
  });
  if (values.origin !== "fixture" && values.origin !== "live") return usage("--origin must be fixture or live");
  const origin: Origin = values.origin;
  const labels = values.labels ?? [];
  const num = (name: string, v: string | undefined) => (v === undefined ? undefined : Number.isFinite(Number(v)) && v.trim() !== "" ? Number(v) : refuse(`--${name} must be a number, got "${v}"`));

  const readArmConfig = (): ArmConfig | undefined => {
    if (values["arm-config"] === undefined) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(resolve(values["arm-config"]), "utf8"));
    } catch {
      return refuse(`cannot read ${values["arm-config"]} as JSON`);
    }
    const checked = validateArmConfig(json);
    if (!checked.ok) return refuse(`${values["arm-config"]} is not a valid arm config:\n${checked.errors.map((e) => `  ${e}`).join("\n")}`);
    return checked.config;
  };

  const readExp7Config = (): Exp7ArmConfig | undefined => {
    if (values["exp7-config"] === undefined) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(resolve(values["exp7-config"]), "utf8"));
    } catch {
      return refuse(`cannot read ${values["exp7-config"]} as JSON`);
    }
    const checked = validateExp7ArmConfig(json);
    if (!checked.ok) return refuse(`${values["exp7-config"]} is not a valid experiment 7 config:\n${checked.errors.map((e) => `  ${e}`).join("\n")}`);
    return checked.config;
  };

  switch (command) {
    case "draft-labels": {
      if (!values.data || !values.capture || !values.out) return usage("draft-labels needs --data, --capture and --out");
      const done = draftLabels({ dataDir: resolve(values.data), captureId: values.capture, outPath: resolve(values.out), ...(values.video ? { videoId: values.video } : {}), ...(values.force ? { force: true } : {}) });
      console.log(tag(origin, [`Wrote a DRAFT label file to ${done.path}. It is a starting point for Derek to correct, not truth.`, ...done.notes.map((n) => `note: ${n}`)]));
      return 0;
    }
    case "draft-labels-set": {
      if (!values.data || !values.capture || !values.out) return usage("draft-labels-set needs --data, --capture and --out");
      const done = draftLabelsSet({ dataDir: resolve(values.data), captureId: values.capture, outPath: resolve(values.out), ...(values.force ? { force: true } : {}) });
      console.log(tag(origin, [`Wrote a DRAFT label file for the whole capture to ${done.path}. It is a starting point for Derek to correct, not truth.`, ...done.notes.map((n) => `note: ${n}`)]));
      return 0;
    }
    case "split": {
      if (labels.length === 0) return usage("split needs --labels <file>");
      console.log(tag(origin, ["Tune and held-out split (a one-video lecture splits at the midpoint of its span, a set of clips at the clip join nearest the midpoint of its watched time; the first half is tune, the second is held-out, scored once):", ...describeSplit(loadLabels(labels), values.data ? resolve(values.data) : undefined)]));
      return 0;
    }
    case "plan": {
      if (!values.data || labels.length === 0) return usage("plan needs --data and --labels <file>");
      const armConfig = readArmConfig();
      const cacheDir = armConfig !== undefined && values.lab !== undefined && values.arm !== undefined ? join(resolve(values.lab), "exp6", values.arm, origin) : undefined;
      const plan = planLab({ dataDir: resolve(values.data), labelFiles: labels, ...(armConfig ? { armConfig } : {}), ...(cacheDir ? { cacheDir } : {}) });
      console.log(tag(origin, plan.lines));
      return plan.overBudget ? 1 : 0;
    }
    case "run": {
      if (!values.data || !values.lab || labels.length === 0 || (values.phase !== "tune" && values.phase !== "score")) return usage("run needs --data, --lab, --labels <file> and --phase tune|score");
      const overrides: Overrides = {
        ...(values["window-new-s"] !== undefined ? { windowNewS: num("window-new-s", values["window-new-s"])! } : {}),
        ...(values["context-s"] !== undefined ? { contextS: num("context-s", values["context-s"])! } : {}),
        ...(values["time-cap-s"] !== undefined ? { timeCapS: num("time-cap-s", values["time-cap-s"])! } : {}),
        ...(values["max-frames-per-window"] !== undefined ? { maxFramesPerWindow: num("max-frames-per-window", values["max-frames-per-window"])! } : {}),
        ...(values["revise-on-next-no-no"] !== undefined ? { reviseOnNextNoNo: values["revise-on-next-no-no"] === "true" } : {}),
        ...(values["yes-at"] !== undefined ? { yesAtOrAbove: num("yes-at", values["yes-at"])! } : {}),
        ...(values["no-at"] !== undefined ? { noAtOrBelow: num("no-at", values["no-at"])! } : {}),
      };
      const maxCalls = num("max-calls", values["max-calls"]);
      const armConfig = readArmConfig();
      const exp7Config = readExp7Config();
      const done = await runLab({
        dataDir: resolve(values.data), labDir: resolve(values.lab), labelFiles: labels, phase: values.phase, live: values.live === true, overrides,
        ...(values.arm !== undefined ? { arm: values.arm } : {}), ...(armConfig ? { armConfig } : {}),
        ...(values.exp7 === true ? { exp7: true } : {}), ...(exp7Config ? { exp7Config } : {}),
        ...(maxCalls !== undefined ? { maxCalls } : {}), ...(values.keys ? { keysPath: resolve(values.keys) } : {}), out: (l) => console.log(l),
      });
      console.log(`results ${done.resultsPath}\nreport ${done.reportPath}`);
      return values.phase === "score" ? done.report.exitCode : 0;
    }
    case "report":
    case "rescore": {
      if (!values.results || labels.length === 0) return usage(`${command} needs --results <file> and --labels <file>`);
      const report = reportFromFile(resolve(values.results), labels);
      process.stdout.write(report.text);
      if (values.expect) {
        if (readFileSync(resolve(values.expect), "utf8") !== report.text) {
          console.error(`MISMATCH: the rescored report differs from ${values.expect}`);
          return 1;
        }
        console.error(`rescore matches ${values.expect} byte for byte`);
      }
      return report.exitCode;
    }
    default:
      return usage("commands: draft-labels, draft-labels-set, split, plan, run, report, rescore");
  }
}

function usage(message: string): number {
  console.error(`jev-lab: ${message}`);
  return 2;
}
