// The draft release's summary: one line per merged PR since the live release, grouped by the type and scope in its title,
// with a warning when the range needs the operator. It reads PR titles from master's squash commits, so it makes no model
// call. Usage, in a clone with full history and tags: bun scripts/release-notes.ts <tag> <commit>
// The live release is the highest published version, the one the beta server's afterclass-autodeploy deploys.

const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const versionOf = (tag: string): number[] => tag.slice(1).split(".").map(Number);

function compareTags(a: string, b: string): number {
  const [x, y] = [versionOf(a), versionOf(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

interface Release {
  readonly tag_name: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
}

function isRelease(value: unknown): value is Release {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.tag_name === "string" && typeof r.draft === "boolean" && typeof r.prerelease === "boolean";
}

/** The highest published, non-pre-release version other than `tag`, from the GitHub releases API's answer. */
export function liveRelease(releases: unknown, tag: string): string | null {
  if (!Array.isArray(releases) || !releases.every(isRelease)) throw new Error("the releases answer is not a list of releases");
  const tags = releases.filter((r) => !r.draft && !r.prerelease && r.tag_name !== tag && RELEASE_TAG.test(r.tag_name)).map((r) => r.tag_name);
  return tags.sort(compareTags).at(-1) ?? null;
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
  /** The live release the range starts from, or null when nothing is published. */
  readonly live: string | null;
  /** The subject of each first-parent commit in the range, newest first. On master each is a squash-merged PR's title. */
  readonly subjects: readonly string[];
  /** Every path the range changes. */
  readonly paths: readonly string[];
}

const code = (items: Iterable<string>): string => [...items].map((item) => `\`${item}\``).join(", ");

export function releaseNotes(range: ReleaseRange): string {
  const { tag, live } = range;
  if (live === null) return "First release. No published release to compare with.\n";
  if (compareTags(live, tag) > 0) return `${live} is published and newer, so publishing ${tag} deploys nothing.\n`;

  const out = [`## Changes since ${live}`, ""];
  const stacks = new Set(range.paths.flatMap((p) => /^infra\/([^/]+)\//.exec(p)?.slice(1, 2).map((s) => `infra/${s}`) ?? []));
  if (stacks.size > 0) {
    out.push(`**Needs the operator.** This range changes ${code(stacks)}. Run \`terraform plan\` there and apply it, as in \`infra/README.md\`. A change to the beta's files or settings replaces its instance.`, "");
  }
  const migrations = range.paths.filter((p) => /^src\/backend\/migrations[^/]*\.ts$/.test(p));
  if (migrations.length > 0) {
    out.push(`**Migrates the database.** This range changes ${code(migrations)}. The beta migrates its database when the new release starts, and an older release then runs on the migrated database.`, "");
  }

  const groups = new Map<Group, string[]>(Object.keys(HEADINGS).map((g) => [g as Group, []]));
  for (const subject of range.subjects) {
    const placed = place(subject);
    if (placed) groups.get(placed.group)!.push(placed.line);
  }
  for (const [group, lines] of groups) {
    if (lines.length > 0) out.push(`### ${HEADINGS[group]}`, ...lines.map((line) => `- ${line}`), "");
  }
  out.push(`Try it with \`scripts/try-release.sh ${tag}\`. Publishing this release deploys it to the beta within a few minutes.`, "");
  return out.join("\n");
}

function run(...args: string[]): string {
  const result = Bun.spawnSync(args, { stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${args.join(" ")} exited ${result.exitCode}`);
  return result.stdout.toString();
}

if (import.meta.main) {
  const [tag = "", commit = ""] = process.argv.slice(2);
  if (!RELEASE_TAG.test(tag) || !/^[0-9a-f]{40}$/.test(commit)) {
    console.error("usage: bun scripts/release-notes.ts <tag> <commit>");
    process.exit(2);
  }
  const repository = process.env.GITHUB_REPOSITORY ?? "DerekHertz/after-class";
  const live = liveRelease(JSON.parse(run("gh", "api", `repos/${repository}/releases?per_page=100`)), tag);
  const lines = (text: string) => text.split("\n").filter(Boolean);
  const inRange = live !== null && compareTags(live, tag) < 0;
  const subjects = inRange ? lines(run("git", "log", "--first-parent", "--format=%s", `refs/tags/${live}..${commit}`)) : [];
  const paths = inRange ? lines(run("git", "diff", "--name-only", `refs/tags/${live}`, commit)) : [];
  process.stdout.write(releaseNotes({ tag, live, subjects, paths }));
}
