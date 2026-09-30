/**
 * `roomAbi`: the ABI the README's snippets and the examples import for the public Room.
 *
 * The snippets used to import a `roomAbi` (and a `demoAbi`) the package did not export, and the
 * example's hand-written ABI had no errors, so a wall came back as `0x105d8ccf` rather than
 * `Edge`. Checked against Room's source, and its compiled artifact when there is one, when this
 * runs inside the repository; the SDK's mirror has neither.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toFunctionSelector, toFunctionSignature, type Abi, type AbiFunction } from "viem";
import { describe, expect, it } from "vitest";

import * as sdk from "../src/index";
import { AppRevertError, decodeRevert, roomAbi } from "../src/index";

const sourcePath = fileURLToPath(
  new URL("../../contracts/src/examples/Room.sol", import.meta.url),
);
const artifactPath = fileURLToPath(
  new URL("../../contracts/out/Room.sol/Room.json", import.meta.url),
);
const delegatablePath = fileURLToPath(
  new URL("../../contracts/out/Delegatable.sol/Delegatable.json", import.meta.url),
);

type AbiError = Extract<Abi[number], { type: "error" }>;

describe("roomAbi", () => {
  it("is exported from the package entry", () => {
    expect(sdk.roomAbi).toBe(roomAbi);
    const functions = roomAbi.filter((item) => item.type === "function").map((item) => item.name);
    expect(functions).toEqual(expect.arrayContaining(["join", "move", "jump", "hit", "leave"]));
  });

  it("decodes a Room revert by name instead of leaving four bytes", () => {
    // Edge() is what a step off the floor reverts with; the example printed the raw selector.
    expect(toFunctionSelector("Edge()")).toBe("0x105d8ccf");
    const error = decodeRevert("0x105d8ccf", roomAbi);
    expect(error).toBeInstanceOf(AppRevertError);
    expect((error as AppRevertError).errorName).toBe("Edge");
  });

  it("stays the floor only: no salon functions, no events", () => {
    const names = roomAbi.map((item) => item.name);
    for (const salon of ["create", "enter", "ready", "begin", "expire", "resetFloor"]) {
      expect(names).not.toContain(salon);
    }
    expect(roomAbi.every((item) => item.type === "function" || item.type === "error")).toBe(true);
  });

  it.skipIf(!existsSync(sourcePath))("carries every error Room.sol declares", () => {
    const declared = [...readFileSync(sourcePath, "utf8").matchAll(/^\s*error (\w+)\(\);/gm)].map(
      (match) => match[1],
    );
    expect(declared.length).toBeGreaterThan(0);
    const ours = roomAbi.filter((item) => item.type === "error").map((item) => item.name);
    expect([...ours].sort()).toEqual([...declared].sort());
  });

  it.skipIf(!existsSync(artifactPath) || !existsSync(delegatablePath))(
    "carries every error Room compiles with that it does not inherit, arguments included",
    () => {
      // The source check above only sees errors without arguments. The artifact has them all,
      // Room's own and the ones every Delegatable inherits, which are not Room's to carry.
      const errors = (path: string) =>
        (JSON.parse(readFileSync(path, "utf8")) as { abi: Abi }).abi
          .filter((item): item is AbiError => item.type === "error")
          .map(errorSignature);
      const inherited = new Set(errors(delegatablePath));
      const own = errors(artifactPath).filter((signature) => !inherited.has(signature));
      expect(own).toContain("Edge()");
      const ours = (roomAbi as Abi).filter((item): item is AbiError => item.type === "error");
      expect(ours.map(errorSignature).sort()).toEqual(own.sort());
    },
  );

  it.skipIf(!existsSync(artifactPath))("declares each function as Room compiles it", () => {
    const compiled = (JSON.parse(readFileSync(artifactPath, "utf8")) as { abi: Abi }).abi;
    const byName = new Map(
      compiled
        .filter((item): item is AbiFunction => item.type === "function")
        .map((item) => [item.name, item] as const),
    );
    for (const item of roomAbi) {
      if (item.type !== "function") continue;
      const real = byName.get(item.name);
      expect(real, item.name).toBeDefined();
      expect(toFunctionSignature(item)).toBe(toFunctionSignature(real!));
      expect(item.stateMutability, item.name).toBe(real!.stateMutability);
      expect(
        item.outputs.map((output) => output.type),
        item.name,
      ).toEqual(real!.outputs.map((output) => output.type));
    }
  });
});

/** `Name(type,type)`, the form a selector is hashed from; tuples compare by their word only. */
function errorSignature(item: AbiError): string {
  return `${item.name}(${item.inputs.map((input) => input.type).join(",")})`;
}
