import { describe, expect, test } from "bun:test";
import { copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpDir } from "./tmp";

const CLERK_TF = resolve(import.meta.dir, "../infra/beta/clerk.tf");

/** Evaluates local.clerk_frontend_api for one key in terraform console, against infra/beta/clerk.tf alone. */
function frontendApi(key: string): { ok: boolean; output: string } {
  const dir = tmpDir("afterclass-clerk-tf-");
  copyFileSync(CLERK_TF, join(dir, "clerk.tf"));
  const result = Bun.spawnSync(["terraform", `-chdir=${dir}`, "console", `-var=clerk_publishable_key=${key}`], {
    stdin: new TextEncoder().encode("local.clerk_frontend_api\n"),
    env: { ...process.env, TF_IN_AUTOMATION: "1" },
  });
  return { ok: result.exitCode === 0, output: result.stdout.toString() + result.stderr.toString() };
}

const base64 = (text: string) => Buffer.from(text).toString("base64");

describe.skipIf(Bun.which("terraform") === null)("infra/beta/clerk.tf", () => {
  test("derives the Frontend API from pk_test_ and pk_live_ keys, with or without base64 padding", () => {
    for (const host of ["test-test.clerk.accounts.dev", "ab.clerk.accounts.dev", "clerk.example.com"]) {
      const padded = base64(`${host}$`);
      for (const key of [`pk_test_${padded}`, `pk_test_${padded.replace(/=+$/, "")}`, `pk_live_${padded.replace(/=+$/, "")}`]) {
        const run = frontendApi(key);
        expect(run.output).toContain(`"https://${host}"`);
        expect(run.ok).toBe(true);
      }
    }
  });

  test("refuses a key that is not pk_live_ or pk_test_ and the base64 of a host followed by $", () => {
    for (const key of [`pk_prod_${base64("clerk.example.com$")}`, `pk_test_${base64("clerk.example.com")}`, "pk_test_Y", "pk_test_"]) {
      const run = frontendApi(key);
      expect(run.ok).toBe(false);
      expect(run.output).toContain("clerk_publishable_key must be pk_live_ or pk_test_");
    }
  });
});
