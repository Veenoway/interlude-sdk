/**
 * The local validator's terms, and the delegation `dev` opens against them.
 *
 * The repo's deploy scripts no longer publish free delegations (a zero fee lets anyone fill a
 * validator's `maxDelegations`), and the local stack follows so that an app's delegation path is
 * exercised with a fee before it meets one on Monad. The integration half runs `dev`'s own
 * bootstrap on a throwaway anvil when Foundry is on PATH.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi, parseEther } from "viem";
import { afterAll, describe, expect, it } from "vitest";

import { bootstrap, GLOBAL_PARTITION, localDelegationFee, localTerms, RESOLVER_ADDRESS } from "../src/bootstrap.js";
import { parseConfig } from "../src/config.js";
import { ensureRemapping, vendorContracts } from "../src/remappings.js";

const here = dirname(fileURLToPath(import.meta.url));
const bundledContracts = join(here, "../contracts");
const bundledArtifacts = join(here, "../artifacts");
const hasFoundry =
  spawnSync("forge", ["--version"]).status === 0 && spawnSync("anvil", ["--version"]).status === 0;
/** r2-control's port range. */
const ANVIL_PORT = 27221;

describe("the local validator's delegation fee", () => {
  it("is 0.01 MON by default, not zero", () => {
    expect(localDelegationFee({})).toBe(parseEther("0.01"));
    expect(localTerms(RESOLVER_ADDRESS).delegationFee).toBe(parseEther("0.01"));
  });

  it("can be overridden in wei, and refuses anything else", () => {
    expect(localDelegationFee({ INTERLUDE_LOCAL_DELEGATION_FEE: "0" })).toBe(0n);
    expect(localDelegationFee({ INTERLUDE_LOCAL_DELEGATION_FEE: "123" })).toBe(123n);
    expect(() => localDelegationFee({ INTERLUDE_LOCAL_DELEGATION_FEE: "0.01" })).toThrow(/wei/);
  });
});

describe.skipIf(!hasFoundry)("dev's bootstrap on anvil, with a fee to pay", () => {
  let anvil: ChildProcess | undefined;
  afterAll(() => anvil?.kill());

  it("opens the delegation, forwarding the validator's fee", async () => {
    const dir = mkdtempSync(join(tmpdir(), "interlude fee é-"));
    writeFileSync(
      join(dir, "foundry.toml"),
      `[profile.default]\nsrc = "src"\nout = "out"\nlibs = ["lib"]\nsolc = "0.8.28"\nevm_version = "cancun"\n`,
    );
    mkdirSync(join(dir, "src"));
    ensureRemapping(dir, vendorContracts(dir, bundledContracts));
    writeFileSync(
      join(dir, "src", "Toy.sol"),
      `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {Delegatable} from "@interludelayer/contracts/Delegatable.sol";
import {IInterludeHub} from "@interludelayer/contracts/interfaces/IInterludeHub.sol";
import {Delegated} from "@interludelayer/contracts/libraries/Delegated.sol";
contract Toy is Delegatable {
    Delegated.Uint256Slot internal constant SCORE = Delegated.Uint256Slot.wrap(keccak256("Toy.score"));
    constructor(IInterludeHub hub_) Delegatable(hub_) {
        _registerGlobal(SCORE);
    }
}
`,
    );
    const built = spawnSync("forge", ["build"], { cwd: dir, encoding: "utf8" });
    expect(built.status, built.stderr || built.stdout).toBe(0);

    anvil = spawn("anvil", ["--port", String(ANVIL_PORT), "--silent", "--disable-code-size-limit"], {
      stdio: "ignore",
    });
    const rpc = `http://127.0.0.1:${ANVIL_PORT}`;
    const chain = createPublicClient({ transport: http(rpc) });
    for (let i = 0; i < 50; i += 1) {
      try {
        await chain.getChainId();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    const deployment = await bootstrap({
      config: parseConfig(`[app]\ncontract = "Toy"\nargs = ["$HUB"]\n`, join(dir, "interlude.toml")),
      projectRoot: dir,
      interludeOut: bundledArtifacts,
      baseRpc: rpc,
      chainId: 31337,
      step: () => {},
    });

    const hub = parseAbi([
      "struct Terms { address resolver; uint8 spec; uint256 stakePerDelegation; uint256 challengeBond; uint256 delegationFee; uint64 maxBatchInterval; uint64 maxDelegationDuration; uint64 challengeWindow; uint64 resolutionWindow; uint32 maxDiffsPerCommit; uint32 maxDelegations; uint16 timeoutPenaltyBps; bool open; }",
      "struct Session { address validator; address resolver; uint8 status; uint8 spec; uint256 epoch; uint256 batchIndex; uint64 baseBlock; uint64 lastExecTimestamp; uint64 lastCommitAt; uint64 maxBatchInterval; uint64 expiresAt; uint32 maxDiffsPerCommit; }",
      "function termsOf(address validator) view returns (Terms)",
      "function sessionOf(address app, bytes32 partition) view returns (Session)",
    ]);
    const terms = await chain.readContract({
      address: deployment.hub,
      abi: hub,
      functionName: "termsOf",
      args: [deployment.validator],
    });
    expect(terms.delegationFee).toBe(parseEther("0.01"));
    const session = await chain.readContract({
      address: deployment.hub,
      abi: hub,
      functionName: "sessionOf",
      args: [deployment.app, GLOBAL_PARTITION],
    });
    expect(session.status).toBe(1);
    expect(session.validator).toBe(deployment.validator);
  }, 180_000);
});
