import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

test("generation is byte-identical, and check rejects drift in every selected consumer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hubspot-policy-"));
  try {
    const script = new URL("./sync-hubspot-grant-policy.mjs", import.meta.url);
    const args = ["--api", join(directory, "api"), "--jobs", join(directory, "jobs"), "--db", join(directory, "db"), "--services", join(directory, "services")];
    const run = (...flags) => execFileSync(process.execPath, [script.pathname, ...args, ...flags], { encoding: "utf8", stdio: "pipe" });
    assert.match(run(), /generated in 4 consumers/);
    assert.match(run("--check"), /verified in 4 consumers/);
    for (const destination of ["api/src/generated", "jobs/src/lib/crm/generated", "db/supabase/functions/_shared/generated", "services/services/pipeline/src/generated"]) {
      const policy = join(directory, destination, "hubspot-grant-policy.ts");
      const original = await readFile(policy, "utf8");
      const drifted = `${original}\n// unintended consumer drift\n`;
      await writeFile(policy, drifted);
      assert.throws(() => run("--check"), /Generated HubSpot policy drift/);
      assert.equal(await readFile(policy, "utf8"), drifted, "check must not repair files");
      run();
      assert.equal(await readFile(policy, "utf8"), original);
      assert.match(run("--check"), /verified in 4 consumers/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a standalone API checkout verifies only itself unless other checkouts are explicit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hubspot-owner-"));
  try {
    await mkdir(join(directory, "scripts"));
    await mkdir(join(directory, "contracts"));
    const script = join(directory, "scripts/sync-hubspot-grant-policy.mjs");
    await copyFile(new URL("./sync-hubspot-grant-policy.mjs", import.meta.url), script);
    for (const file of ["hubspot-grant-policy.ts", "hubspot-grant-policy-cases.ts"]) {
      await copyFile(new URL(`../contracts/${file}`, import.meta.url), join(directory, "contracts", file));
    }
    const run = (...flags) => execFileSync(process.execPath, [script, ...flags], { cwd: tmpdir(), encoding: "utf8", stdio: "pipe" });
    assert.throws(() => run("--jobs"), /Unknown or incomplete argument/);
    assert.throws(() => run("--check"), /ENOENT/, "check requires the generated copy and never creates it");
    assert.match(run(), /generated in 1 consumers/);
    assert.match(run("--check"), /verified in 1 consumers/);
    assert.deepEqual((await readdir(directory)).sort(), ["contracts", "scripts", "src"]);
    const manifestPath = join(directory, "src/generated/hubspot-grant-policy.manifest.json");
    const manifest = await readFile(manifestPath, "utf8");
    assert.equal(JSON.parse(manifest).source, "lifty-api/contracts/hubspot-grant-policy.ts");
    await writeFile(manifestPath, manifest.replace("lifty-api/contracts", "lift-polariz-compass/contracts"));
    assert.throws(() => run("--check"), /Generated HubSpot policy drift/);
    run();
    const source = join(directory, "contracts/hubspot-grant-policy.ts");
    await writeFile(source, `${await readFile(source, "utf8")}\n// unpublished source change\n`);
    assert.throws(() => run("--check"), /Generated HubSpot policy drift/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
