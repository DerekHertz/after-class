import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpDir } from "./tmp";
import { baseOf, liveRelease, releaseNotes } from "../scripts/release-notes";

describe("liveRelease", () => {
  test("is the tag of the version the beta's /health reports", () => {
    expect(liveRelease("0.1.4")).toBe("v0.1.4");
  });

  test("is null when /health named no version, or one that is not a release", () => {
    for (const version of ["", "0.1.4-rc1", "v0.1.4", "01.1.4"]) expect(liveRelease(version)).toBeNull();
  });
});

describe("baseOf", () => {
  const tags = ["v0.1.9", "v0.1.10", "v0.2.0", "v0.1.11", "latest", "v0.3.0-rc1"];

  test("is the live release when it is older than the tag", () => {
    expect(baseOf("v0.2.0", "v0.1.9", tags)).toBe("v0.1.9");
  });

  test("is the release tag just below the tag, by version, when the beta named no release", () => {
    expect(baseOf("v0.2.0", null, tags)).toBe("v0.1.11");
  });

  test("is the release tag just below the tag when the live release is not older, as in a rollback", () => {
    expect(baseOf("v0.1.11", "v0.2.0", tags)).toBe("v0.1.10");
  });

  test("is null when no release is older than the tag", () => {
    expect(baseOf("v0.1.9", null, tags)).toBeNull();
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
  const range = { tag: "v0.1.5", live: "v0.1.4", base: "v0.1.4", subjects, paths: ["src/app/home.tsx"] };

  test("gives one line per merged PR in the PR's own words, grouped for friends, for the room, fixes, infra and the rest", () => {
    expect(releaseNotes(range)).toBe(
      [
        "## Changes since v0.1.4",
        "",
        "The beta runs v0.1.4.",
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
      ].join("\n"),
    );
  });

  test("warns before the list when the range changes infra/, naming each stack", () => {
    const notes = releaseNotes({ ...range, paths: ["infra/beta/files/Caddyfile.tftpl", "infra/README.md", "infra/beta/instance.tf", "src/app/home.tsx"] });
    expect(notes).toContain("**Needs terraform.** This range changes `infra/beta`.");
    expect(notes.indexOf("Needs terraform")).toBeLessThan(notes.indexOf("### For friends"));
  });

  test("warns when the range changes a database migration, naming the files", () => {
    const notes = releaseNotes({ ...range, paths: ["src/backend/migrations-budget.ts", "src/backend/main.ts"] });
    expect(notes).toContain("**Migrates the database.** This range changes `src/backend/migrations-budget.ts`.");
  });

  test("carries no warning when the range touches neither", () => {
    const notes = releaseNotes({ ...range, paths: ["src/app/home.tsx", "docs/infra-notes.md"] });
    expect(notes).not.toContain("Needs terraform");
    expect(notes).not.toContain("Migrates the database");
  });

  test("leaves out the version bump and empty groups", () => {
    const notes = releaseNotes({ ...range, subjects: ["chore(release): set version 0.1.5 (#300)", "fix(app): keep drafts (#301)"], paths: [] });
    expect(notes).not.toContain("set version");
    expect(notes).not.toContain("### For friends");
    expect(notes).toContain("### Fixes\n- Keep drafts (#301)\n");
  });

  test("says so when no release is older, instead of listing all history", () => {
    expect(releaseNotes({ tag: "v0.1.0", live: null, base: null, subjects: [], paths: [] })).toBe("First release. No older release to compare with.\n");
  });

  test("says when the beta did not report its release, so the base is only assumed", () => {
    const notes = releaseNotes({ ...range, tag: "v0.1.6", live: null, base: "v0.1.5" });
    expect(notes).toStartWith("## Changes since v0.1.5\n\n**Check the base.** The beta did not say which release it runs, so this list assumes v0.1.5, the release before v0.1.6.");
  });

  test("calls a tag no newer than the live release a rollback", () => {
    const notes = releaseNotes({ ...range, tag: "v0.1.4", live: "v0.1.6", base: "v0.1.3" });
    expect(notes).toContain("**Rollback.** The beta runs v0.1.6, which is not older than v0.1.4.");
  });

  test("the warnings alone say so when the range changes neither infra/ nor a migration", () => {
    expect(releaseNotes(range, { warningsOnly: true })).toBe("## Changes since v0.1.4\n\nThe beta runs v0.1.4.\n\nNo change to `infra/` or a database migration since v0.1.4.\n");
  });

  test("the warnings alone keep both warnings and leave out the PR list", () => {
    const notes = releaseNotes({ ...range, paths: ["infra/beta/instance.tf", "src/backend/migrations.ts"] }, { warningsOnly: true });
    expect(notes).toContain("**Needs terraform.**");
    expect(notes).toContain("**Migrates the database.**");
    expect(notes).not.toContain("###");
  });
});

describe("bun scripts/release-notes.ts", () => {
  const SCRIPT = resolve(import.meta.dir, "../scripts/release-notes.ts");

  test("lists the first-parent titles and warnings between the live release and the tag in a real clone", () => {
    const repo = tmpDir("afterclass-release-notes-");
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString().trim();
    };
    const commit = (path: string, subject: string) => {
      mkdirSync(join(repo, dirname(path)), { recursive: true });
      writeFileSync(join(repo, path), subject);
      git("add", "-A");
      git("commit", "-q", "-m", subject);
    };
    git("init", "-q");
    commit("README.md", "feat(app): first (#1)");
    git("tag", "v0.1.0");
    commit("src/backend/migrations.ts", "feat(review): add a column (#2)");
    git("tag", "v0.1.1");
    commit("infra/beta/instance.tf", "fix(infra): grow the disk (#3)");
    git("tag", "v0.1.2");
    const run = (live: string) => Bun.spawnSync(["bun", SCRIPT, "v0.1.2", git("rev-parse", "v0.1.2"), live], { cwd: repo }).stdout.toString();

    const fromLive = run("0.1.0");
    expect(fromLive).toStartWith("## Changes since v0.1.0\n\nThe beta runs v0.1.0.\n");
    expect(fromLive).toContain("**Needs terraform.** This range changes `infra/beta`.");
    expect(fromLive).toContain("**Migrates the database.** This range changes `src/backend/migrations.ts`.");
    expect(fromLive).toContain("- Add a column (#2)");
    expect(fromLive).toContain("- Grow the disk (#3)");

    const unknown = run("");
    expect(unknown).toStartWith("## Changes since v0.1.1\n\n**Check the base.**");
    expect(unknown).not.toContain("Migrates the database");
  });
});
