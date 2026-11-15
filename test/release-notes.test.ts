import { describe, expect, test } from "bun:test";
import { highestPublished, releaseNotes, runningRelease } from "../scripts/release-notes";

const published = (tag_name: string, extra: Record<string, unknown> = {}) => ({ tag_name, draft: false, prerelease: false, ...extra });

describe("highestPublished", () => {
  test("is the highest published release by version, not by list order or by name", () => {
    expect(highestPublished([published("v0.1.9"), published("v0.1.10"), published("v0.2.0"), published("v0.1.11")], "v0.3.0")).toBe("v0.2.0");
  });

  test("skips drafts, pre-releases, the tag being cut and tags that are not versions", () => {
    const releases = [published("v0.1.4"), published("v0.1.6", { draft: true }), published("v0.1.7", { prerelease: true }), published("v0.1.5"), published("latest"), published("v0.1.8-rc1")];
    expect(highestPublished(releases, "v0.1.5")).toBe("v0.1.4");
  });

  test("is null when nothing is published yet", () => {
    expect(highestPublished([published("v0.1.0", { draft: true })], "v0.1.0")).toBeNull();
  });

  test("refuses an answer that is not a list of releases", () => {
    expect(() => highestPublished({ message: "API rate limit exceeded" }, "v0.1.0")).toThrow();
  });
});

describe("runningRelease", () => {
  test("is the tag of the version the beta's /health reports", () => {
    expect(runningRelease({ ok: true, version: "0.1.4" })).toBe("v0.1.4");
  });

  test("is null when /health names no version, or one that is not a release", () => {
    for (const health of [{ ok: true }, { ok: true, version: "0.1.4-rc1" }, { ok: true, version: 4 }, null, "v0.1.4"]) expect(runningRelease(health)).toBeNull();
  });
});

describe("releaseNotes", () => {
  const subjects = [
    "chore(release): set version 0.1.5 (#300)",
    "feat(review): let a student skip a question (#299)",
    "fix(capture): show channel health ok once its data arrived (#298)",
    "feat(room): draw the review room's painted layers on a Canvas 2D stage (#297)",
    "feat(infra): run the beta on one EC2 server (#296)",
    "docs(design): add painted animation frames for Lumi (#295)",
    "perf(preparation): stop queuing resource searches nothing reads (#294)",
    "Room: react to the tutor's moves from one table (#293)",
    "fix(test): build the review app once for the bundle tests (#292)",
  ];

  test("gives one line per merged PR in the PR's own words, grouped for friends, for the room, fixes, infra and the rest", () => {
    expect(releaseNotes({ tag: "v0.1.5", highest: "v0.1.4", running: "v0.1.4", subjects, paths: ["src/app/home.tsx"] })).toBe(
      [
        "## Changes since v0.1.4",
        "",
        "The beta runs v0.1.4, the highest published release.",
        "",
        "### For friends",
        "- Let a student skip a question (#299)",
        "- Stop queuing resource searches nothing reads (#294)",
        "",
        "### For the room",
        "- Draw the review room's painted layers on a Canvas 2D stage (#297)",
        "",
        "### Fixes",
        "- Show channel health ok once its data arrived (#298)",
        "",
        "### Infra",
        "- Run the beta on one EC2 server (#296)",
        "",
        "### Behind the scenes",
        "- Add painted animation frames for Lumi (#295)",
        "- Build the review app once for the bundle tests (#292)",
        "",
        "### Other",
        "- Room: react to the tutor's moves from one table (#293)",
        "",
        "Try it with `scripts/try-release.sh v0.1.5`. Publishing this release deploys it to the beta within a few minutes.",
        "",
      ].join("\n"),
    );
  });

  test("warns when the range changes infra/, naming each stack, because the operator must apply it", () => {
    const notes = releaseNotes({ tag: "v0.1.5", highest: "v0.1.4", running: "v0.1.4", subjects, paths: ["infra/beta/files/Caddyfile.tftpl", "infra/README.md", "infra/beta/instance.tf", "src/app/home.tsx"] });
    expect(notes).toContain("**Needs the operator.** This range changes `infra/beta`.");
    expect(notes.indexOf("Needs the operator")).toBeLessThan(notes.indexOf("### For friends"));
  });

  test("warns when the range changes a database migration, naming the files", () => {
    const notes = releaseNotes({ tag: "v0.1.5", highest: "v0.1.4", running: "v0.1.4", subjects, paths: ["src/backend/migrations-budget.ts", "src/backend/main.ts"] });
    expect(notes).toContain("**Migrates the database.** This range changes `src/backend/migrations-budget.ts`.");
  });

  test("carries no warning when the range touches neither", () => {
    const notes = releaseNotes({ tag: "v0.1.5", highest: "v0.1.4", running: "v0.1.4", subjects, paths: ["src/app/home.tsx", "docs/infra-notes.md"] });
    expect(notes).not.toContain("Needs the operator");
    expect(notes).not.toContain("Migrates the database");
  });

  test("leaves out the version bump and empty groups", () => {
    const notes = releaseNotes({ tag: "v0.1.5", highest: "v0.1.4", running: "v0.1.4", subjects: ["chore(release): set version 0.1.5 (#300)", "fix(app): keep drafts (#301)"], paths: [] });
    expect(notes).not.toContain("set version");
    expect(notes).not.toContain("### For friends");
    expect(notes).toContain("### Fixes\n- Keep drafts (#301)\n");
  });

  test("says so when nothing is published yet, instead of listing all history", () => {
    const notes = releaseNotes({ tag: "v0.1.0", highest: null, running: null, subjects: [], paths: [] });
    expect(notes).toContain("First release. No published release to compare with.");
  });

  test("says publishing deploys nothing when a newer release is already published", () => {
    const notes = releaseNotes({ tag: "v0.1.5", highest: "v0.1.6", running: "v0.1.6", subjects: [], paths: [] });
    expect(notes).toContain("v0.1.6 is published and newer, so publishing v0.1.5 deploys nothing.");
  });

  test("starts at the release the beta runs when it is older than the highest published one, so that release's changes and warnings stay in", () => {
    const notes = releaseNotes({ tag: "v0.1.6", highest: "v0.1.5", running: "v0.1.4", subjects, paths: ["src/backend/migrations-budget.ts"] });
    expect(notes).toStartWith("## Changes since v0.1.4\n\nThe beta runs v0.1.4, not v0.1.5, the highest published release, so this list starts at v0.1.4.\n");
    expect(notes).toContain("**Migrates the database.**");
  });

  test("says when the beta did not report its release, so the base is only assumed", () => {
    const notes = releaseNotes({ tag: "v0.1.6", highest: "v0.1.5", running: null, subjects, paths: [] });
    expect(notes).toStartWith("## Changes since v0.1.5\n\n**Check the base.** The beta did not say which release it runs, so this list assumes v0.1.5, the highest published release.");
    expect(notes).toContain("`scripts/try-release.sh v0.1.6`");
  });

  test("the warnings alone say so when the range changes neither infra/ nor a migration", () => {
    const notes = releaseNotes({ tag: "v0.1.5", highest: "v0.1.4", running: "v0.1.4", subjects, paths: ["src/app/home.tsx"] }, { warningsOnly: true });
    expect(notes).toBe("## Changes since v0.1.4\n\nThe beta runs v0.1.4, the highest published release.\n\nNo change to `infra/` or a database migration since v0.1.4.\n");
  });

  test("the warnings alone keep both warnings and leave out the PR list", () => {
    const notes = releaseNotes({ tag: "v0.1.5", highest: "v0.1.4", running: "v0.1.4", subjects, paths: ["infra/beta/instance.tf", "src/backend/migrations.ts"] }, { warningsOnly: true });
    expect(notes).toContain("**Needs the operator.**");
    expect(notes).toContain("**Migrates the database.**");
    expect(notes).not.toContain("###");
  });
});
