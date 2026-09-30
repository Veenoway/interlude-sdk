import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactError, type CompiledContract } from "../src/artifacts.js";
import { chooseContract, perKeyEvidence, toolchainWarnings } from "../src/project.js";

describe("the compiler foundry.toml asks for", () => {
  it("says nothing when nothing is pinned, since forge then picks a recent solc", () => {
    expect(toolchainWarnings(`[profile.default]\nsrc = "src"\n`)).toEqual([]);
  });

  it("accepts 0.8.28 and later, and cancun or later", () => {
    expect(
      toolchainWarnings(`[profile.default]\nsolc = "0.8.30"\nevm_version = "prague"\n`),
    ).toEqual([]);
    expect(toolchainWarnings(`[profile.default]\nsolc_version = "0.8.28"\n`)).toEqual([]);
  });

  it("names a solc pinned below what the vendored sources need", () => {
    const [warning] = toolchainWarnings(`[profile.default]\nsolc = "0.8.24"\n`);
    expect(warning).toMatch(/pins solc 0\.8\.24[\s\S]*0\.8\.28/);
  });

  it("names an EVM without transient storage", () => {
    const warnings = toolchainWarnings(`[profile.default]\nevm_version = "shanghai"\n`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/tstore[\s\S]*cancun/);
  });

  it("reads the active profile over default", () => {
    const toml = `[profile.default]\nsolc = "0.8.28"\n[profile.ci]\nsolc = "0.8.20"\n`;
    expect(toolchainWarnings(toml, "default")).toEqual([]);
    expect(toolchainWarnings(toml, "ci")).toHaveLength(1);
  });
});

describe("spotting a per-key surface", () => {
  function project(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "interlude-perkey-"));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return dir;
  }
  const rooms: CompiledContract = { name: "Rooms", source: "src/Rooms.sol", artifactPath: "" };

  it("finds it in the generated surface", () => {
    const dir = project({
      "src/Rooms.sol": "contract Rooms is RoomsInterludeSurface {}",
      "src/RoomsInterludeSurface.sol":
        "function _registerInterludeSurface() internal {\n  _registerPerKey(Delegated.MapUint256Slot.wrap(S));\n}",
    });
    expect(perKeyEvidence(dir, rooms)).toEqual(["src/RoomsInterludeSurface.sol calls _registerPerKey"]);
  });

  it("finds a hand-written registration and the annotation", () => {
    const dir = project({
      "src/Rooms.sol":
        "/// @custom:interlude per-key\nmapping(uint256 => uint256) seats;\nconstructor() { _registerPerKey(SEATS); }",
    });
    expect(perKeyEvidence(dir, rooms)).toEqual([
      "src/Rooms.sol calls _registerPerKey",
      'src/Rooms.sol marks a variable "per-key"',
    ]);
  });

  it("ignores a comment that only mentions the call", () => {
    const dir = project({
      "src/Rooms.sol": "// not _registerPerKey(x) here: everything is global\ncontract Rooms {}",
    });
    expect(perKeyEvidence(dir, rooms)).toEqual([]);
  });
});

describe("choosing the contract", () => {
  const a: CompiledContract = { name: "Alpha", source: "src/A.sol", artifactPath: "" };
  const b: CompiledContract = { name: "Beta", source: "src/B.sol", artifactPath: "" };

  it("takes the only one, or the named one", () => {
    expect(chooseContract([a], undefined)).toBe(a);
    expect(chooseContract([a, b], "Beta")).toBe(b);
  });

  it("asks rather than choose among several, and lists them", () => {
    expect(() => chooseContract([a, b], undefined)).toThrow(ArtifactError);
    expect(() => chooseContract([a, b], undefined)).toThrow(/Alpha[\s\S]*Beta[\s\S]*--contract/);
    expect(() => chooseContract([a, b], "Gamma")).toThrow(/no delegatable contract named Gamma/);
  });
});
