// Shows each rule depends on the flow line that keeps it: removes that line from a copy of the
// model, checks only that rule with plain TLC, and expects the rule to break.
// Run: TLA2TOOLS=... JAVA=... bun docs/flows/model/mutants.ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = import.meta.dir;
const jar = process.env.TLA2TOOLS ?? "";
const java = process.env.JAVA ?? "java";
const want = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
const have = createHash("sha256").update(fs.readFileSync(jar)).digest("hex");
if (have !== want) throw new Error(`tla2tools.jar checksum ${have}, want ${want}`);

type Mutant = {
  name: string;
  module: "Preparation" | "Record";
  rule: string;
  kind: "INVARIANT" | "PROPERTY";
  removes: string;
  from: string;
  to: string;
};

const mutants: Mutant[] = [
  {
    name: "outdated result applied",
    module: "Preparation",
    rule: "R8_LateResultsNeverOverwrite",
    kind: "PROPERTY",
    removes: "TLC fix R8: a result for an outdated revision is logged, never applied",
    from: `        /\\ UNCHANGED status\n`,
    to: `        /\\ IF kind = "cancelled"\n           THEN UNCHANGED status\n           ELSE status' \\in {[status EXCEPT ![c] = "supported"], [status EXCEPT ![c] = "unverified"]}\n`,
  },
  {
    name: "used revision forgotten",
    module: "Preparation",
    rule: "R4_AtMostOneRevision",
    kind: "INVARIANT",
    removes: "TLC fix R4: a claim keeps its used revision through reprocessing and retry",
    from: `[status EXCEPT ![c] = IF revisions[c] = 0 THEN "revising" ELSE "unverified"]`,
    to: `[status EXCEPT ![c] = "revising"]`,
  },
  {
    name: "boundary move grows scope",
    module: "Preparation",
    rule: "R7_ScopeNeverGrows",
    kind: "PROPERTY",
    removes: "TLC fix R7: a boundary move can't add material to an open review's scope",
    from: `        /\\ review = "active" => UNION {MaterialAt(ch, nb) : ch \\in scope} \\subseteq ScopeMaterial\n`,
    to: ``,
  },
  {
    name: "tutor asks about a rechecked claim",
    module: "Preparation",
    rule: "R3_JudgedOnlyAgainstCheckedClaims",
    kind: "INVARIANT",
    removes: "TLC fix R3, first half: a claim being rechecked is out of assessment",
    from: `    /\\ status[c] \\notin Pending\n`,
    to: ``,
  },
  {
    name: "open question not paused",
    module: "Preparation",
    rule: "R3_JudgedOnlyAgainstCheckedClaims",
    kind: "INVARIANT",
    removes: "TLC fix R3, second half: an open question on it pauses",
    from: `          /\\ IF question \\in redo\n             THEN /\\ paused' = question\n                  /\\ question' = NoQuestion\n             ELSE UNCHANGED <<paused, question>>\n`,
    to: `          /\\ UNCHANGED <<paused, question>>\n`,
  },
  {
    name: "unsettled dispute not clamped",
    module: "Record",
    rule: "R14_DisputedNeverCountedAsGap",
    kind: "INVARIANT",
    removes: "TLC fix R14: a dispute still open or unsettled saves as \"disputed\"",
    from: `                        [] obs[c] = "disputed" -> "disputed"\n`,
    to: ``,
  },
  {
    name: "pending save not cited",
    module: "Record",
    rule: "R16_CitedEvidenceNeverExpires",
    kind: "INVARIANT",
    removes: "TLC fix R16: evidence cited by a pending save counts as cited",
    from: `    /\\ note \\notin {"saved", "pending"}\n`,
    to: `    /\\ note # "saved"\n`,
  },
  {
    name: "Later drops preparation",
    module: "Preparation",
    rule: "R5_LaterLeavesPreparation",
    kind: "PROPERTY",
    removes: "Later -> keep preparing",
    from: `    /\\ invite' = "later"\n    /\\ UNCHANGED CaptureVars /\\ UNCHANGED PrepVars /\\ UNCHANGED <<review, scope, reviewed, question, paused>>\n`,
    to: `    /\\ invite' = "later"\n    /\\ status' = [c \\in Claims |-> IF status[c] \\in Pending THEN "dropped" ELSE status[c]]\n    /\\ UNCHANGED CaptureVars /\\ UNCHANGED <<revisions, late, resources>> /\\ UNCHANGED <<review, scope, reviewed, question, paused>>\n`,
  },
  {
    name: "Later drops preparation",
    module: "Preparation",
    rule: "R5_OnlyStopEarlyCancels",
    kind: "PROPERTY",
    removes: "Later -> keep preparing",
    from: `    /\\ invite' = "later"\n    /\\ UNCHANGED CaptureVars /\\ UNCHANGED PrepVars /\\ UNCHANGED <<review, scope, reviewed, question, paused>>\n`,
    to: `    /\\ invite' = "later"\n    /\\ status' = [c \\in Claims |-> IF status[c] \\in Pending THEN "dropped" ELSE status[c]]\n    /\\ UNCHANGED CaptureVars /\\ UNCHANGED <<revisions, late, resources>> /\\ UNCHANGED <<review, scope, reviewed, question, paused>>\n`,
  },
  {
    name: "Jev may never answer",
    module: "Preparation",
    rule: "R5_PreparationFinishesAfterLater",
    kind: "PROPERTY",
    removes: "Later -> keep preparing (the Jev check keeps running)",
    from: `        /\\ WF_vars(JevChecksAClaim(c))\n`,
    to: ``,
  },
  {
    name: "review waits for resources",
    module: "Preparation",
    rule: "R6_ResourcesNeverBlockReview",
    kind: "INVARIANT",
    removes: "failure never blocks review (Review now always available)",
    from: `    /\\ HasSupported(ReadyScope)\n    /\\ review' = "active"\n`,
    to: `    /\\ HasSupported(ReadyScope)\n    /\\ resources # "searching"\n    /\\ review' = "active"\n`,
  },
  {
    name: "review start stops capture",
    module: "Preparation",
    rule: "R9_ReviewAndCaptureIndependent",
    kind: "PROPERTY",
    removes: "Review now leaves capture alone",
    from: `    /\\ invite' = "none"\n    /\\ UNCHANGED <<reviewed, question, paused>>\n    /\\ UNCHANGED CaptureVars /\\ UNCHANGED PrepVars\n`,
    to: `    /\\ invite' = "none"\n    /\\ UNCHANGED <<reviewed, question, paused>>\n    /\\ capture' = IF capture = "not started" THEN capture ELSE "stopped"\n    /\\ UNCHANGED <<watched, closed, boundary, boundaryFixed>> /\\ UNCHANGED PrepVars\n`,
  },
  {
    name: "stop capture ends review",
    module: "Preparation",
    rule: "R9_ReviewAndCaptureIndependent",
    kind: "PROPERTY",
    removes: "stop capture leaves the review alone",
    from: `    /\\ UNCHANGED <<watched, boundaryFixed, revisions, late, resources>>\n    /\\ UNCHANGED ReviewVars\n`,
    to: `    /\\ UNCHANGED <<watched, boundaryFixed, revisions, late, resources>>\n    /\\ review' = IF review = "active" THEN "none" ELSE review\n    /\\ UNCHANGED <<invite, scope, reviewed, question, paused>>\n`,
  },
  {
    name: "Stop early starts empty",
    module: "Preparation",
    rule: "R10_NeverStartsEmpty",
    kind: "PROPERTY",
    removes: "No supported claims in scope -> don't start",
    from: `           ok == \\E c \\in ClaimsIn(closed \\ reviewed) : s[c] = "supported"\n`,
    to: `           ok == TRUE\n`,
  },
  {
    name: "detour starts without yes",
    module: "Record",
    rule: "R11_DetourOnlyAfterYes",
    kind: "INVARIANT",
    removes: "[user] Accept or decline the detour",
    from: `    /\\ detour' = "offered"\n`,
    to: `    /\\ detour' \\in {"offered", "on"}\n`,
  },
];

const constants = { Preparation: "Passages = 2\n    ClaimsPerChunk = 1", Record: "Claims = {1, 2}" };
const work = fs.mkdtempSync(path.join(os.tmpdir(), "mutants-"));
const rows: string[] = [];
let missed = 0;
try {
  mutants.forEach((m, i) => {
    const source = fs.readFileSync(path.join(here, `${m.module}.tla`), "utf8");
    const hits = source.split(m.from).length - 1;
    if (hits !== 1) throw new Error(`${m.name}: the text to remove occurs ${hits} times in ${m.module}.tla`);
    const dir = path.join(work, String(i));
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, `${m.module}.tla`), source.replace(m.from, m.to));
    fs.writeFileSync(
      path.join(dir, "one.cfg"),
      `SPECIFICATION Spec\nCONSTANTS\n    ${constants[m.module]}\n${m.kind} ${m.rule}\nCHECK_DEADLOCK FALSE\n`,
    );
    const r = spawnSync(
      java,
      ["-XX:+UseParallelGC", `-Djava.io.tmpdir=${dir}`, "-cp", jar, "tlc2.TLC", "-workers", "auto",
        "-metadir", path.join(dir, "meta"), "-config", "one.cfg", `${m.module}.tla`],
      { cwd: dir, encoding: "utf8", maxBuffer: 1 << 28 },
    );
    const out = r.stdout + r.stderr;
    const broke = /is violated|were violated/.test(out);
    const clean = /No error has been found/.test(out);
    const steps = (out.match(/^State \d+:/gm) ?? []).length;
    const result = broke ? `breaks, ${steps}-state counterexample` : clean ? "HOLDS (mutant survived)" : "TLC error";
    if (!broke) {
      missed++;
      fs.writeFileSync(path.join(here, `mutant-${i}.out`), out);
    }
    rows.push(`| ${m.rule} | ${m.removes} | ${result} |`);
  });
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
console.log("| Rule | Flow line removed | Result |\n| --- | --- | --- |\n" + rows.join("\n"));
process.exit(missed ? 1 : 0);
