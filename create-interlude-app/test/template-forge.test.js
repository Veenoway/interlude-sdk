/**
 * The scaffolded contracts compile and their tests pass, against this repository's Interlude
 * sources, from a path with a space in it.
 *
 * The remapping is pointed at `packages/contracts/src` rather than `lib/interlude`, which is
 * where `interlude check` would vendor the published CLI's copy: this runs before anything is
 * published, and it is also the check that notices when a change to Delegatable breaks the
 * template. Skipped when forge is not on PATH, so the rest of the suite runs anywhere.
 *
 * It also holds `web/lib/abi.ts` to the compiled ABI, so a Delegatable change that adds a
 * function (and so moves the ABI) fails here until `npm run sync-template` regenerates it.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { scaffold } from "../src/scaffold.js";
import { repoContracts, scratch } from "./helpers.js";

const hasForge = spawnSync("forge", ["--version"], { encoding: "utf8" }).status === 0;
const hasSources = existsSync(join(repoContracts, "Delegatable.sol"));

describe.skipIf(!hasForge || !hasSources)("the scaffolded contracts, with forge", () => {
  let project;
  let cleanup;

  beforeAll(() => {
    const s = scratch("forge é");
    cleanup = s.cleanup;
    project = scaffold({ dir: join(s.dir, "Forge Check"), name: "forge-check" }).dir;
    writeFileSync(
      join(project, "contracts", "remappings.txt"),
      `@interludelayer/contracts/=${repoContracts.replace(/\/?$/, "/")}\n`,
    );
  });

  afterAll(() => cleanup?.());

  const forge = (...args) =>
    spawnSync("forge", args, { cwd: join(project, "contracts"), encoding: "utf8" });

  it("builds, with no compiler or lint warning", { timeout: 300_000 }, () => {
    const build = forge("build");
    expect(build.status, build.stdout + build.stderr).toBe(0);
    expect(build.stdout + build.stderr).not.toMatch(/warning/i);
  });

  it("passes its own tests", { timeout: 300_000 }, () => {
    const test = forge("test");
    expect(test.status, test.stdout + test.stderr).toBe(0);
    expect(test.stdout).toMatch(/7 passed; 0 failed/);
  });

  it("ships web/lib/abi.ts equal to the ABI solc produced", () => {
    const artifact = JSON.parse(
      readFileSync(join(project, "contracts", "out", "Clicker.sol", "Clicker.json"), "utf8"),
    );
    const module = readFileSync(join(project, "web", "lib", "abi.ts"), "utf8");
    const shipped = JSON.parse(module.slice(module.indexOf("["), module.lastIndexOf("]") + 1));
    expect(shipped, "run `npm run sync-template` in packages/create-interlude-app").toEqual(
      artifact.abi,
    );
  });
});
