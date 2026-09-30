import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ArtifactError, findInterludeOut, readArtifact } from "../src/artifacts.js";

const bundled = join(dirname(fileURLToPath(import.meta.url)), "../artifacts");

describe("finding Interlude's own artifacts", () => {
  it("honours INTERLUDE_CONTRACTS_OUT when it points at a real directory", () => {
    const previous = process.env.INTERLUDE_CONTRACTS_OUT;
    process.env.INTERLUDE_CONTRACTS_OUT = bundled;
    try {
      expect(findInterludeOut("/tmp")).toBe(bundled);
    } finally {
      if (previous === undefined) delete process.env.INTERLUDE_CONTRACTS_OUT;
      else process.env.INTERLUDE_CONTRACTS_OUT = previous;
    }
  });

  it("refuses an override that is not there, so a typo is not a silent walk-up", () => {
    const previous = process.env.INTERLUDE_CONTRACTS_OUT;
    process.env.INTERLUDE_CONTRACTS_OUT = "/no/such/interlude-out";
    try {
      expect(() => findInterludeOut("/tmp")).toThrow(ArtifactError);
      expect(() => findInterludeOut("/tmp")).toThrow(/INTERLUDE_CONTRACTS_OUT/);
    } finally {
      if (previous === undefined) delete process.env.INTERLUDE_CONTRACTS_OUT;
      else process.env.INTERLUDE_CONTRACTS_OUT = previous;
    }
  });

  it("ships a hub artifact the command can deploy without a checkout", () => {
    expect(
      existsSync(join(bundled, "InterludeHub.sol", "InterludeHub.json")),
      "run `pnpm --filter @interludelayer-sdk/cli bundle` after forge build",
    ).toBe(true);

    const previous = process.env.INTERLUDE_CONTRACTS_OUT;
    delete process.env.INTERLUDE_CONTRACTS_OUT;
    try {
      const out = findInterludeOut("/tmp");
      expect(out).toBe(bundled);
      const hub = readArtifact(out, "InterludeHub");
      expect(hub.bytecode.startsWith("0x")).toBe(true);
      expect(hub.bytecode.length).toBeGreaterThan(100);
      expect(hub.abi.some((item) => "name" in item && item.name === "commit")).toBe(true);
      expect(hub.abi.some((item) => "name" in item && item.name === "bisect")).toBe(true);
      expect(hub.abi.some((item) => "name" in item && item.name === "proveStep")).toBe(true);
    } finally {
      if (previous !== undefined) process.env.INTERLUDE_CONTRACTS_OUT = previous;
    }
  });
});
