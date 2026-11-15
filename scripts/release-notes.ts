// A release's notes: one line per merged PR since the release the beta runs, grouped by the type and scope in its title,
// with a warning when the range needs terraform or migrates the database. It reads PR titles from master's squash commits,
// so it makes no model call. scripts/release.sh runs it after fetching master and the release tags, with the live release
// it read from the server or the one you passed with --live.
// Usage: bun scripts/release-notes.ts [--warnings] <tag> <commit> <live release tag>
// --warnings prints only the base and the warnings.

const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const versionOf = (tag: string): number[] => tag.slice(1).split(".").map(Number);

export function compareTags(a: string, b: string): number {
  const [x, y] = [versionOf(a), versionOf(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/** Where the notes start: the live release when it is older than `tag`, otherwise the release tag just below `tag`. */
export function baseOf(tag: string, live: string, tags: readonly string[]): string | null {
  if (compareTags(live, tag) < 0) return live;
  return tags.filter((t) => RELEASE_TAG.test(t) && compareTags(t, tag) < 0).sort(compareTags).at(-1) ?? null;
}

type Group = "friends" | "room" | "fixes" | "infra" | "internal" | "other";

const HEADINGS: Record<Group, string> = {
  friends: "For friends",
  room: "For the room",
  fixes: "Fixes",
  infra: "Infra",
  internal: "Behind the scenes",
  other: "Other",
};

interface Title {
  readonly type: string;
  readonly scope: string;
  readonly text: string;
}

const INFRA_SCOPES = new Set(["infra", "ci", "deploy", "docker", "ops", "release"]);
const ROOM_SCOPES = new Set(["room", "art", "front-row", "companions", "stage"]);
const INTERNAL_TYPES = new Set(["docs", "test", "refactor", "chore", "style"]);

/** The first rule that matches a title picks its group. null leaves the title out. */
const RULES: readonly [(t: Title) => boolean, Group | null][] = [
  [(t) => t.type === "chore" && t.scope === "release", null],
  [(t) => t.type === "ci" || t.type === "build" || INFRA_SCOPES.has(t.scope), "infra"],
  [(t) => INTERNAL_TYPES.has(t.type) || t.scope === "test" || t.scope === "docs", "internal"],
  [(t) => ROOM_SCOPES.has(t.scope), "room"],
  [(t) => t.type === "fix", "fixes"],
  [(t) => t.type === "feat" || t.type === "perf", "friends"],
];

const CONVENTIONAL = /^([a-z]+)(?:\(([^)]*)\))?!?: (.+)$/;

function place(subject: string): { group: Group; line: string } | null {
  const match = CONVENTIONAL.exec(subject);
  if (!match) return { group: "other", line: subject };
  const title: Title = { type: match[1]!, scope: match[2] ?? "", text: match[3]! };
  const rule = RULES.find(([when]) => when(title));
  const group = rule ? rule[1] : "other";
  if (group === null) return null;
  return { group, line: title.text.charAt(0).toUpperCase() + title.text.slice(1) };
}

export interface ReleaseRange {
  readonly tag: string;
  /** The release the beta runs. */
  readonly live: string;
  /** Where the range starts, from baseOf, or null when no release is older than `tag`. */
  readonly base: string | null;
  /** The subject of each first-parent commit in the range, newest first. On master each is a squash-merged PR's title. */
  readonly subjects: readonly string[];
  /** Every path the range changes. */
  readonly paths: readonly string[];
}

const code = (items: Iterable<string>): string => [...items].map((item) => `\`${item}\``).join(", ");

function baseLine(tag: string, base: string, live: string): string {
  if (live !== base) {
    return `**Rollback.** The beta runs ${live}, which is not older than ${tag}. This list shows ${tag}'s changes since ${base}. Any database migration from a newer release stays, and ${tag} runs on it.`;
  }
  return `The beta runs ${base}.`;
}

export function releaseNotes(range: ReleaseRange, opts: { warningsOnly?: boolean } = {}): string {
  const { tag, live, base } = range;
  if (base === null) {
    if (compareTags(live, tag) <= 0) return "First release. No older release to compare with.\n";
    return `**Rollback.** The beta runs ${live}, which is newer than ${tag}, the oldest release. No older release lists its changes. Any database migration from a newer release stays, and ${tag} runs on it.\n`;
  }

  const out = [`## Changes since ${base}`, "", baseLine(tag, base, live), ""];
  const stacks = new Set(range.paths.flatMap((p) => /^infra\/([^/]+)\//.exec(p)?.slice(1, 2).map((s) => `infra/${s}`) ?? []));
  if (stacks.size > 0) {
    out.push(`**Needs terraform.** This range changes ${code(stacks)}. Run \`terraform plan\` there and apply it, as in \`infra/README.md\`. A change to the beta's files or settings replaces its instance.`, "");
  }
  const migrations = range.paths.filter((p) => /^src\/backend\/migrations[^/]*\.ts$/.test(p));
  if (migrations.length > 0) {
    out.push(`**Migrates the database.** This range changes ${code(migrations)}. The beta migrates its database when the new release starts, and an older release then runs on the migrated database.`, "");
  }
  if (opts.warningsOnly) {
    if (stacks.size === 0 && migrations.length === 0) out.push(`No change to \`infra/\` or a database migration since ${base}.`, "");
    return out.join("\n");
  }

  const groups = new Map<Group, string[]>(Object.keys(HEADINGS).map((g) => [g as Group, []]));
  for (const subject of range.subjects) {
    const placed = place(subject);
    if (placed) groups.get(placed.group)!.push(placed.line);
  }
  for (const [group, lines] of groups) {
    if (lines.length > 0) out.push(`### ${HEADINGS[group]}`, ...lines.map((line) => `- ${line}`), "");
  }
  return out.join("\n");
}

function git(...args: string[]): string[] {
  const result = Bun.spawnSync(["git", ...args], { stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${result.exitCode}`);
  return result.stdout.toString().split("\n").filter(Boolean);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const warningsOnly = args[0] === "--warnings";
  const [tag = "", commit = "", live = ""] = warningsOnly ? args.slice(1) : args;
  if (!RELEASE_TAG.test(tag) || !/^[0-9a-f]{40}$/.test(commit) || !RELEASE_TAG.test(live)) {
    console.error("usage: bun scripts/release-notes.ts [--warnings] <tag> <commit> <live release tag>");
    process.exit(2);
  }
  const base = baseOf(tag, live, git("tag", "--list", "v*"));
  const subjects = base === null ? [] : git("log", "--first-parent", "--format=%s", `refs/tags/${base}..${commit}`);
  const paths = base === null ? [] : git("diff", "--name-only", `refs/tags/${base}`, commit);
  process.stdout.write(releaseNotes({ tag, live, base, subjects, paths }, { warningsOnly }));
}
