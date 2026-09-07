import { describe, expect, it } from "vitest";
import { constantName, generateSurface, importsFrom } from "../src/generate.js";
import { declaredNameBelow, fingerprintOf, type DelegatedVariable } from "../src/layout.js";

/**
 * Reading the annotation is the one part of the generator that parses source rather than
 * compiler output, so it is the one part that can be wrong in a way nothing else catches. It
 * cannot produce a wrong slot — those come from solc and are matched by name — but it can miss a
 * variable, and a variable missed is state that quietly stays on the base chain.
 */
describe("finding the variable an annotation sits above", () => {
  const nameIn = (source: string) => declaredNameBelow(source.split("\n"), 0);

  it("reads a mapping without mistaking the arrow for an assignment", () => {
    // The bug this was written for: scanning left to right for `word =` finds `address =>`
    // first, and the surface comes out naming the key type.
    expect(nameIn("mapping(address => uint256) internal balances;")).toBe("balances");
  });

  it("reads a scalar", () => {
    expect(nameIn("uint256 private total;")).toBe("total");
  });

  it("reads past an initialiser", () => {
    expect(nameIn("uint256 internal seats = 9;")).toBe("seats");
  });

  it("reads a nested mapping, whose declaration is refused later for other reasons", () => {
    expect(nameIn("mapping(address => mapping(address => uint256)) internal allowance;")).toBe(
      "allowance",
    );
  });

  it("skips the rest of the comment block to reach the declaration", () => {
    const source = ["/// @dev the book", "///", "// and a plain comment", "uint256 internal a;"];
    expect(declaredNameBelow(source, 0)).toBe("a");
  });

  it("follows a declaration that wraps across lines", () => {
    const source = ["mapping(address => uint256)", "    internal balances;"];
    expect(declaredNameBelow(source, 0)).toBe("balances");
  });

  it("gives up rather than guess when the annotation is above something else", () => {
    expect(nameIn("function join() external returns (uint256) {")).toBeUndefined();
  });
});

describe("the layout commitment", () => {
  const variable = (over: Partial<DelegatedVariable> = {}): DelegatedVariable => ({
    name: "balances",
    slot: 0n,
    type: "t_mapping(t_address,t_uint256)",
    label: "mapping(address => uint256)",
    mode: "global",
    kind: "mapping",
    declaredIn: "src/Purse.sol:Purse",
    ...over,
  });

  it("moves when a slot moves, which is the whole reason it exists", () => {
    expect(fingerprintOf("Purse", [variable()])).not.toBe(
      fingerprintOf("Purse", [variable({ slot: 1n })]),
    );
  });

  it("moves when a type changes under the same name", () => {
    expect(fingerprintOf("Purse", [variable()])).not.toBe(
      fingerprintOf("Purse", [variable({ type: "t_mapping(t_address,t_bytes32)" })]),
    );
  });

  it("moves when a whole mapping becomes per-key, because that is a different delegation", () => {
    expect(fingerprintOf("Purse", [variable()])).not.toBe(
      fingerprintOf("Purse", [variable({ mode: "per-key" })]),
    );
  });

  it("does not move when the same facts arrive in a different order", () => {
    const a = variable();
    const b = variable({ name: "total", slot: 3n, kind: "scalar", type: "t_uint256" });
    expect(fingerprintOf("Purse", [a, b])).toBe(fingerprintOf("Purse", [b, a]));
  });
});

describe("the generated Solidity", () => {
  const surface = {
    contract: "Purse",
    source: "src/Purse.sol",
    fingerprint: `0x${"ab".repeat(32)}` as `0x${string}`,
    variables: [
      {
        name: "balances",
        slot: 0n,
        type: "t_mapping(t_address,t_uint256)",
        label: "mapping(address => uint256)",
        mode: "global" as const,
        kind: "mapping" as const,
        declaredIn: "src/Purse.sol:Purse",
      },
      {
        name: "handsPlayed",
        slot: 1n,
        type: "t_uint256",
        label: "uint256",
        mode: "global" as const,
        kind: "scalar" as const,
        declaredIn: "src/Purse.sol:Purse",
      },
    ],
  };

  const app = `import {Delegatable} from "../Delegatable.sol";`;

  it("registers each variable the way its shape requires", () => {
    const out = generateSurface(surface, app);
    expect(out).toContain("_registerGlobalMapping(Delegated.MapUint256Slot.wrap(BALANCES_SLOT))");
    expect(out).toContain("_registerGlobal(Delegated.Bytes32Slot.wrap(HANDS_PLAYED_SLOT))");
  });

  it("takes its slots from the compiler's numbering, not from a hash chosen by hand", () => {
    const out = generateSurface(surface, app);
    expect(out).toContain("BALANCES_SLOT = bytes32(uint256(0))");
    expect(out).toContain("HANDS_PLAYED_SLOT = bytes32(uint256(1))");
    expect(out).not.toMatch(/keccak256\(["']/);
  });

  it("carries the commitment interlude check compares against", () => {
    expect(generateSurface(surface, app)).toContain(`INTERLUDE_LAYOUT =\n        ${surface.fingerprint}`);
  });

  it("imports Delegated for a scalar-only surface, because registration names it", () => {
    const scalars = {
      ...surface,
      variables: [surface.variables[1]!],
    };
    const out = generateSurface(scalars, app);
    expect(out).toContain("import {Delegated} from");
    expect(out).toContain("_registerGlobal(Delegated.Bytes32Slot.wrap(HANDS_PLAYED_SLOT))");
  });

  it("uses a per-key registration when that is what was asked for", () => {
    const perKey = {
      ...surface,
      variables: [{ ...surface.variables[0]!, mode: "per-key" as const }],
    };
    expect(generateSurface(perKey, app)).toContain(
      "_registerPerKey(Delegated.MapUint256Slot.wrap(BALANCES_SLOT))",
    );
  });
});

describe("where the generated file imports from", () => {
  it("copies the app's own path, whatever the project's layout", () => {
    const app = `import {Delegatable} from "lib/interlude/src/Delegatable.sol";`;
    expect(importsFrom(app).delegatable).toBe(`"lib/interlude/src/Delegatable.sol"`);
  });

  /**
   * The usual case, and the good one: an app on plain storage has no reason to import
   * `Delegated`, which is the point of generating this at all.
   */
  it("puts Delegated beside Delegatable when the app never needed it", () => {
    const app = `import {Delegatable} from "../Delegatable.sol";`;
    expect(importsFrom(app).delegated).toBe(`"../libraries/Delegated.sol"`);
  });

  it("prefers a path the app already proved resolves", () => {
    const app = [
      `import {Delegatable} from "../Delegatable.sol";`,
      `import {Delegated} from "../elsewhere/Delegated.sol";`,
    ].join("\n");
    expect(importsFrom(app).delegated).toBe(`"../elsewhere/Delegated.sol"`);
  });
});

describe("constant names", () => {
  it("reads as a constant and cannot collide with the variable", () => {
    expect(constantName("balances")).toBe("BALANCES_SLOT");
    expect(constantName("handsPlayed")).toBe("HANDS_PLAYED_SLOT");
    expect(constantName("_total")).toBe("TOTAL_SLOT");
  });
});
