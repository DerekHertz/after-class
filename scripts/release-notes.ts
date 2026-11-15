// The draft release's summary: one line per merged PR since the release the beta runs, grouped by the type and scope in
// its title, with a warning when the range needs the operator. It reads PR titles from master's squash commits, so it makes
// no model call. Usage, in a clone with full history and tags: bun scripts/release-notes.ts [--warnings] <tag> <commit>
// --warnings prints only the base and the warnings, which scripts/try-release.sh prints right before a Publish.
//
// The range starts at the release the beta's GET /health reports, because a failed deploy that rolled back, or a manual
// deploy, leaves the beta on a release older than the highest published one. When /health names no version, as before
// v0.1.5, the range starts at the highest published release, and the notes say the base is only assumed.

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
export function highestPublished(releases: unknown, tag: string): string | null {
  if (!Array.isArray(releases) || !releases.every(isRelease)) throw new Error("the releases answer is not a list of releases");
  const tags = releases.filter((r) => !r.draft && !r.prerelease && r.tag_name !== tag && RELEASE_TAG.test(r.tag_name)).map((r) => r.tag_name);
  return tags.sort(compareTags).at(-1) ?? null;
}

/** The release tag of the version in the beta's GET /health answer, or null when it names none. */
export function runningRelease(health: unknown): string | null {
  if (typeof health !== "object" || health === null) return null;
  const version = (health as Record<string, unknown>).version;
  if (typeof version !== "string") return null;
  return RELEASE_TAG.test(`v${version}`) ? `v${version}` : null;
}

/** The release the range starts at: the one the beta runs when it is older than `tag`, otherwise the highest published. */
export function baseOf(tag: string, highest: string | null, running: string | null): string | null {
  return running !== null && compareTags(running, tag) < 0 ? running : highest;
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
  /** The highest published release other than `tag`, or null when nothing is published. */
  readonly highest: string | null;
  /** The release the beta reported running, or null when it did not say. */
  readonly running: string | null;
  /** The subject of each first-parent commit in the range, newest first. On master each is a squash-merged PR's title. */
  readonly subjects: readonly string[];
  /** Every path the range changes. */
  readonly paths: readonly string[];
}

const code = (items: Iterable<string>): string => [...items].map((item) => `\`${item}\``).join(", ");

function baseLine(tag: string, base: string, highest: string | null, running: string | null): string {
  if (running === null) {
    return `**Check the base.** The beta did not say which release it runs, so this list assumes ${base}, the highest published release. If it runs an older one, this list and its warnings leave out that release's changes. \`scripts/try-release.sh ${tag}\` checks again against the release it runs.`;
  }
  if (running !== base) return `**Check the base.** The beta runs ${running}, which is not older than ${tag}, so this list starts at ${base}, the highest published release.`;
  if (highest !== null && highest !== base) return `The beta runs ${base}, not ${highest}, the highest published release, so this list starts at ${base}.`;
  return `The beta runs ${base}, the highest published release.`;
}

export function releaseNotes(range: ReleaseRange, opts: { warningsOnly?: boolean } = {}): string {
  const { tag, highest, running } = range;
  if (highest !== null && compareTags(highest, tag) > 0) return `${highest} is published and newer, so publishing ${tag} deploys nothing.\n`;
  const base = baseOf(tag, highest, running);
  if (base === null) return "First release. No published release to compare with.\n";

  const out = [`## Changes since ${base}`, "", baseLine(tag, base, highest, running), ""];
  const stacks = new Set(range.paths.flatMap((p) => /^infra\/([^/]+)\//.exec(p)?.slice(1, 2).map((s) => `infra/${s}`) ?? []));
  if (stacks.size > 0) {
    out.push(`**Needs the operator.** This range changes ${code(stacks)}. Run \`terraform plan\` there and apply it, as in \`infra/README.md\`. A change to the beta's files or settings replaces its instance.`, "");
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
  out.push(`Try it with \`scripts/try-release.sh ${tag}\`. Publishing this release deploys it to the beta within a few minutes.`, "");
  return out.join("\n");
}

function run(...args: string[]): string {
  const result = Bun.spawnSync(args, { stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${args.join(" ")} exited ${result.exitCode}`);
  return result.stdout.toString();
}

/** The beta's GET /health answer, or null when it cannot be read within 10 seconds and 4 KiB. */
async function readHealth(origin: string): Promise<unknown> {
  try {
    const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!response.ok || response.body === null) return null;
    let text = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      text += decoder.decode(chunk, { stream: true });
      if (text.length > 4096) return null;
    }
    return JSON.parse(text);
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const warningsOnly = args[0] === "--warnings";
  const [tag = "", commit = ""] = warningsOnly ? args.slice(1) : args;
  if (!RELEASE_TAG.test(tag) || !/^[0-9a-f]{40}$/.test(commit)) {
    console.error("usage: bun scripts/release-notes.ts [--warnings] <tag> <commit>");
    process.exit(2);
  }
  const repository = process.env.GITHUB_REPOSITORY ?? "DerekHertz/after-class";
  const highest = highestPublished(JSON.parse(run("gh", "api", `repos/${repository}/releases?per_page=100`)), tag);
  const running = runningRelease(await readHealth(process.env.AFTERCLASS_BETA_URL ?? "https://useafterclass.com"));
  const base = baseOf(tag, highest, running);
  const lines = (text: string) => text.split("\n").filter(Boolean);
  const inRange = base !== null && compareTags(base, tag) < 0 && (highest === null || compareTags(highest, tag) < 0);
  const subjects = inRange ? lines(run("git", "log", "--first-parent", "--format=%s", `refs/tags/${base}..${commit}`)) : [];
  const paths = inRange ? lines(run("git", "diff", "--name-only", `refs/tags/${base}`, commit)) : [];
  process.stdout.write(releaseNotes({ tag, highest, running, subjects, paths }, { warningsOnly }));
}
