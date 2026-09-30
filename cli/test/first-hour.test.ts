import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ensureRemapping, vendorContracts } from "../src/remappings.js";

const bundled = join(dirname(fileURLToPath(import.meta.url)), "../contracts");
const forgeAvailable = spawnSync("forge", ["--version"]).status === 0;

describe("the first hour, outside this checkout", () => {
  it.skipIf(!forgeAvailable)(
    "vendors the current ABI and compiles a contract that inherits Delegatable",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "interlude-npx-"));
      writeFileSync(
        join(dir, "foundry.toml"),
        `[profile.default]\nsrc = "src"\nout = "out"\nlibs = ["lib"]\nsolc = "0.8.28"\n`,
      );
      mkdirSync(join(dir, "src"));
      const dest = vendorContracts(dir, bundled);
      ensureRemapping(dir, dest);
      writeFileSync(
        join(dir, "src", "Toy.sol"),
        `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {Delegatable} from "@interludelayer/contracts/Delegatable.sol";
import {IInterludeHub} from "@interludelayer/contracts/interfaces/IInterludeHub.sol";
import {Types} from "@interludelayer/contracts/interfaces/Types.sol";
contract Toy is Delegatable {
    constructor(IInterludeHub hub_) Delegatable(hub_) {}
    function ping() external view returns (Types.BisectPhase) {
        return Types.BisectPhase.None;
    }
}
`,
      );

      const built = spawnSync("forge", ["build"], { cwd: dir, encoding: "utf8" });
      expect(built.status, built.stderr || built.stdout).toBe(0);
      expect(existsSync(join(dir, "lib", "interlude", "interfaces", "IInterludeHub.sol"))).toBe(
        true,
      );
    },
  );
});
