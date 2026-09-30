import { cpSync, mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { bundledDir } from "../src/artifacts.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");

/**
 * macOS puts a space in "Application Support", plenty of people have an accent in their home
 * directory, and the CLI used to decode neither: `new URL(import.meta.url).pathname` hands back
 * `%20` and `%C3%A9`, so the command looked for its own bundled files in a directory that does
 * not exist. These run the lookup from exactly such a path.
 */
describe("bundled files, from a path with a space and an accent", () => {
  it("decodes the module URL instead of reading its percent-encoded path", () => {
    const url = pathToFileURL("/tmp/with space é/dist/index.js").href;
    // What the old code did, kept here so the reason for this test stays visible.
    expect(new URL(url).pathname).toContain("%20");
    expect(bundledDir(url, "artifacts")).toBe("/tmp/with space é/artifacts");
    expect(bundledDir(url, "contracts")).toBe("/tmp/with space é/contracts");
  });

  it("finds the shipped Solidity and the hub artifact when the package lives there", async () => {
    // A copy of the package's sources and bundled files, installed under an awkward path, and
    // loaded from there — so import.meta.url inside the module really is that path.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "interlude cli é-")));
    cpSync(join(pkg, "src"), join(root, "src"), { recursive: true });
    cpSync(join(pkg, "contracts"), join(root, "contracts"), { recursive: true });
    mkdirSync(join(root, "artifacts"), { recursive: true });
    cpSync(join(pkg, "artifacts", "InterludeHub.sol"), join(root, "artifacts", "InterludeHub.sol"), {
      recursive: true,
    });

    const remappings = (await import(
      pathToFileURL(join(root, "src", "remappings.ts")).href
    )) as typeof import("../src/remappings.js");
    const artifacts = (await import(
      pathToFileURL(join(root, "src", "artifacts.ts")).href
    )) as typeof import("../src/artifacts.js");

    const previous = {
      contracts: process.env.INTERLUDE_CONTRACTS,
      out: process.env.INTERLUDE_CONTRACTS_OUT,
    };
    delete process.env.INTERLUDE_CONTRACTS;
    delete process.env.INTERLUDE_CONTRACTS_OUT;
    try {
      // Started from a directory with no Interlude checkout above it, as a user project is.
      const project = realpathSync(mkdtempSync(join(tmpdir(), "my project ü-")));
      expect(remappings.findInterludeContracts(project)).toBe(join(root, "contracts"));
      expect(artifacts.findInterludeOut(project)).toBe(join(root, "artifacts"));

      const hub = artifacts.readArtifact(artifacts.findInterludeOut(project), "InterludeHub");
      expect(hub.bytecode.length).toBeGreaterThan(100);

      // And the remapping written for that project resolves to a directory Foundry may read.
      const written = remappings.ensureRemapping(project, remappings.findInterludeContracts(project));
      expect(written.line).toBe("@interludelayer/contracts/=lib/interlude/");
    } finally {
      if (previous.contracts !== undefined) process.env.INTERLUDE_CONTRACTS = previous.contracts;
      if (previous.out !== undefined) process.env.INTERLUDE_CONTRACTS_OUT = previous.out;
    }
  });
});
