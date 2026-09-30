import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ArtifactError } from "../src/artifacts.js";
import {
  CONTRACTS_REMAPPING,
  ensureRemapping,
  findInterludeContracts,
  remappingLine,
  vendorContracts,
} from "../src/remappings.js";

const bundled = join(dirname(fileURLToPath(import.meta.url)), "../contracts");

describe("finding Interlude's Solidity sources", () => {
  it("honours INTERLUDE_CONTRACTS when it holds Delegatable.sol", () => {
    const previous = process.env.INTERLUDE_CONTRACTS;
    process.env.INTERLUDE_CONTRACTS = bundled;
    try {
      expect(findInterludeContracts("/tmp")).toBe(bundled);
    } finally {
      if (previous === undefined) delete process.env.INTERLUDE_CONTRACTS;
      else process.env.INTERLUDE_CONTRACTS = previous;
    }
  });

  it("refuses an override that is not a source tree", () => {
    const previous = process.env.INTERLUDE_CONTRACTS;
    process.env.INTERLUDE_CONTRACTS = "/no/such/interlude-src";
    try {
      expect(() => findInterludeContracts("/tmp")).toThrow(ArtifactError);
      expect(() => findInterludeContracts("/tmp")).toThrow(/INTERLUDE_CONTRACTS/);
    } finally {
      if (previous === undefined) delete process.env.INTERLUDE_CONTRACTS;
      else process.env.INTERLUDE_CONTRACTS = previous;
    }
  });

  it("ships Delegatable so a project outside the checkout can inherit it", () => {
    const previous = process.env.INTERLUDE_CONTRACTS;
    delete process.env.INTERLUDE_CONTRACTS;
    try {
      expect(findInterludeContracts("/tmp")).toBe(bundled);
    } finally {
      if (previous !== undefined) process.env.INTERLUDE_CONTRACTS = previous;
    }
  });
});

describe("writing the remapping", () => {
  it("points at the sources with a trailing slash, the way Foundry wants", () => {
    expect(remappingLine("/proj", "/proj/lib/interlude")).toBe(
      `${CONTRACTS_REMAPPING}=lib/interlude/`,
    );
  });

  it("appends the line and leaves forge-std alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "interlude-remap-"));
    writeFileSync(join(dir, "remappings.txt"), "forge-std/=lib/forge-std/src/\n");
    const sources = join(dir, "vendor", "interlude");
    mkdirSync(sources, { recursive: true });

    const first = ensureRemapping(dir, sources);
    expect(first.wrote).toBe(true);
    expect(readFileSync(first.path, "utf8")).toBe(
      `forge-std/=lib/forge-std/src/\n${CONTRACTS_REMAPPING}=vendor/interlude/\n`,
    );

    const second = ensureRemapping(dir, sources);
    expect(second.wrote).toBe(false);
    expect(readFileSync(first.path, "utf8")).toBe(
      `forge-std/=lib/forge-std/src/\n${CONTRACTS_REMAPPING}=vendor/interlude/\n`,
    );
  });

  it("copies sources that sit outside the project into lib/interlude", () => {
    const dir = mkdtempSync(join(tmpdir(), "interlude-vendor-"));
    const dest = vendorContracts(dir, bundled);
    expect(dest).toBe(join(dir, "lib", "interlude"));
    expect(existsSync(join(dest, "Delegatable.sol"))).toBe(true);
    expect(readFileSync(join(dest, "interfaces", "IInterludeHub.sol"), "utf8")).toMatch(
      /function bisect/,
    );
    expect(readFileSync(join(dest, "interfaces", "Types.sol"), "utf8")).toMatch(/struct BisectGame/);

    const written = ensureRemapping(dir, bundled);
    expect(written.line).toBe(`${CONTRACTS_REMAPPING}=lib/interlude/`);
    expect(readFileSync(written.path, "utf8")).toBe(`${CONTRACTS_REMAPPING}=lib/interlude/\n`);
  });

  it("vendors a copy installed in the project's own node_modules too", () => {
    // `npm i -D @interludelayer-sdk/cli` puts the sources inside the project, but under a
    // directory the next `npm ci` rewrites. The remapping has to name lib/interlude, as the
    // README says, not node_modules/.
    const dir = mkdtempSync(join(tmpdir(), "interlude-installed-"));
    const installed = join(dir, "node_modules", "@interludelayer-sdk", "cli", "contracts");
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "Delegatable.sol"), "// stand-in\n");
    const written = ensureRemapping(dir, installed);
    expect(written.line).toBe(`${CONTRACTS_REMAPPING}=lib/interlude/`);
    expect(existsSync(join(dir, "lib", "interlude", "Delegatable.sol"))).toBe(true);
  });

  it("replaces a remapping Foundry cannot follow", () => {
    const dir = mkdtempSync(join(tmpdir(), "interlude-remap-stale-"));
    writeFileSync(
      join(dir, "remappings.txt"),
      `${CONTRACTS_REMAPPING}=../../../Users/someone/.npm/_npx/cli/contracts/\n`,
    );
    const written = ensureRemapping(dir, bundled);
    expect(written.wrote).toBe(true);
    expect(readFileSync(written.path, "utf8")).toBe(`${CONTRACTS_REMAPPING}=lib/interlude/\n`);
  });
});
