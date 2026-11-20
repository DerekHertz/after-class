/**
 * Counts the synchronous database call sites in src/backend, by module, with no regex on whole statements:
 * a small scanner finds each `db.sql.query(...)` / `db.sql.run(...)` expression, matches its parentheses, and checks
 * whether the call is executed in place (`.get/.all/.run/.values`) or stored as a prepared statement. Each stored
 * statement's name is then searched for its executions.
 *   bun run spikes/postgres/count-callsites.ts [--list]
 */
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXEC = ["get", "all", "run", "values"] as const;

/** Source with comments and the insides of string and template literals blanked, same length, so offsets still line up. */
function blank(src: string): string {
  const out = src.split("");
  let i = 0;
  const wipe = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const templateDepth: number[] = [];
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const e = src.indexOf("\n", i);
      wipe(i, e < 0 ? src.length : e);
      i = e < 0 ? src.length : e;
    } else if (c === "/" && n === "*") {
      const e = src.indexOf("*/", i + 2);
      wipe(i, e + 2);
      i = e + 2;
    } else if (c === "/" && /[(,=:[!&|?{};]\s*$/.test(src.slice(Math.max(0, i - 40), i)) && !/^\/[/*]/.test(src.slice(i, i + 2))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && (src[j] !== "/" || inClass)) {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        j++;
      }
      wipe(i + 1, j);
      i = j + 1;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      wipe(i + 1, j);
      i = j + 1;
    } else if (c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== "`") {
        if (src[j] === "\\") j += 2;
        else if (src[j] === "$" && src[j + 1] === "{") {
          wipe(i + 1, j);
          let depth = 1;
          let k = j + 2;
          while (k < src.length && depth > 0) {
            if (src[k] === "{") depth++;
            else if (src[k] === "}") depth--;
            k++;
          }
          i = k - 1;
          j = k;
          templateDepth.push(0);
          continue;
        } else j++;
      }
      wipe(i + 1, j);
      i = j + 1;
    } else i++;
  }
  return out.join("");
}

function matchClose(s: string, open: number, o: string, c: string): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === o) depth++;
    else if (s[i] === c && --depth === 0) return i;
  }
  return -1;
}

type Site = { file: string; line: number; kind: string };
const sites: Site[] = [];
const lineOf = (src: string, off: number) => src.slice(0, off).split("\n").length;

for (const rel of [...new Glob("src/backend/**/*.ts").scanSync(ROOT)].sort()) {
  if (rel === "src/backend/db.ts") continue;
  const raw = readFileSync(join(ROOT, rel), "utf8");
  const code = blank(raw);
  const prepared = new Map<string, "q" | "bare">();

  for (const m of code.matchAll(/db\.sql\s*\.(query|run)\b/g)) {
    const start = m.index!;
    let p = start + m[0].length;
    while (/\s/.test(code[p]!)) p++;
    if (code[p] === "<") p = matchClose(code, p, "<", ">") + 1;
    while (/\s/.test(code[p]!)) p++;
    const end = matchClose(code, p, "(", ")");
    const after = code.slice(end + 1).match(/^\s*\.(get|all|run|values)\s*\(/);
    if (m[1] === "run") {
      sites.push({ file: rel, line: lineOf(code, start), kind: "db.sql.run" });
      continue;
    }
    if (after) {
      sites.push({ file: rel, line: lineOf(code, start), kind: "inline query" });
      continue;
    }
    const before = code.slice(Math.max(0, start - 80), start);
    const named = before.match(/(\w+)\s*:\s*$/) ?? before.match(/(?:const|let)\s+(\w+)\s*=\s*$/);
    if (!named) throw new Error(`${rel}:${lineOf(code, start)}: query neither executed nor named`);
    prepared.set(named[1]!, before.match(/(?:const|let)\s+\w+\s*=\s*$/) ? "bare" : "q");
  }

  for (const [name, style] of prepared) {
    const re = style === "q" ? new RegExp(`\\bq\\.${name}\\.(${EXEC.join("|")})\\(`, "g") : new RegExp(`(?<![.\\w])${name}\\.(${EXEC.join("|")})\\(`, "g");
    for (const m of code.matchAll(re)) sites.push({ file: rel, line: lineOf(code, m.index!), kind: "prepared statement run" });
  }
  for (const m of code.matchAll(/\bdb\.tx\s*\(/g)) sites.push({ file: rel, line: lineOf(code, m.index!), kind: "db.tx" });
  for (const m of code.matchAll(/\bnextSeq\s*\(/g)) {
    const pre = code.slice(Math.max(0, m.index! - 12), m.index!);
    if (/db\.$/.test(pre)) sites.push({ file: rel, line: lineOf(code, m.index!), kind: "db.nextSeq" });
  }
}

const moduleOf = (file: string) => {
  const m = file.match(/^src\/backend\/([^/]+)/);
  if (!m) return file;
  const seg = m[1]!;
  if (seg === "providers") return `providers/${file.split("/").pop()!.replace(".ts", "")}`;
  return seg.endsWith(".ts") ? seg.replace(".ts", "") : seg;
};

const kinds = ["inline query", "prepared statement run", "db.sql.run", "db.tx", "db.nextSeq"];
const byModule = new Map<string, Record<string, number>>();
for (const s of sites) {
  const key = moduleOf(s.file);
  const row = byModule.get(key) ?? Object.fromEntries(kinds.map((k) => [k, 0]));
  row[s.kind]! += 1;
  byModule.set(key, row);
}

console.log(["module".padEnd(26), ...kinds.map((k) => k.padStart(22)), "total".padStart(7)].join(""));
const total = Object.fromEntries(kinds.map((k) => [k, 0]));
for (const [mod, row] of [...byModule].sort()) {
  const t = kinds.reduce((a, k) => a + row[k]!, 0);
  for (const k of kinds) total[k]! += row[k]!;
  console.log([mod.padEnd(26), ...kinds.map((k) => String(row[k]).padStart(22)), String(t).padStart(7)].join(""));
}
const grand = kinds.reduce((a, k) => a + total[k]!, 0);
console.log(["TOTAL".padEnd(26), ...kinds.map((k) => String(total[k]).padStart(22)), String(grand).padStart(7)].join(""));
const queryExecs = total["inline query"]! + total["prepared statement run"]! + total["db.sql.run"]!;
console.log(`\nSQL executions: ${queryExecs}. Transaction blocks: ${total["db.tx"]}. nextSeq calls: ${total["db.nextSeq"]}.`);
if (process.argv.includes("--list")) for (const s of sites) console.log(`${s.file}:${s.line} ${s.kind}`);
