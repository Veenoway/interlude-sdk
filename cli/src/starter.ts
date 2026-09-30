/**
 * The `interlude.toml` that `init` writes.
 *
 * Its own module so it can be generated and parsed back in a test. A generated config that does
 * not parse is the worst possible first impression — the reader has done nothing wrong and the
 * next command fails — and the first version of this had exactly that bug: a comment after a
 * value in a single-line array swallowed the closing bracket.
 */

import { REQUIRED_SOLC } from "./project.js";
import { CONTRACTS_REMAPPING } from "./remappings.js";

export interface ConstructorInput {
  type: string;
  name?: string | undefined;
  /** solc's own name for the type: `contract IInterludeHub` for a hub typed as its interface. */
  internalType?: string | undefined;
}

/**
 * Which constructor argument is the hub, if one can be named with certainty.
 *
 * The declared type says it best (`IInterludeHub hub_` compiles to an address whose internal
 * type is the interface), then the parameter's name, then being the only address there is. Past
 * that it would be a guess, and a guessed address is a contract deployed against the wrong hub.
 */
export function hubArgumentIndex(inputs: readonly ConstructorInput[]): number {
  const byType = inputs.findIndex(
    (input) => input.type === "address" && /\bIInterludeHub\b/.test(input.internalType ?? ""),
  );
  if (byType >= 0) return byType;
  const byName = inputs.findIndex(
    (input) => input.type === "address" && /hub/i.test(input.name ?? ""),
  );
  if (byName >= 0) return byName;
  const addresses = inputs.filter((input) => input.type === "address");
  return addresses.length === 1 ? inputs.indexOf(addresses[0]!) : -1;
}

/** `<fill in: uint256 stake>` — refused by `dev` and `ship` until it is replaced. */
export function fillIn(input: ConstructorInput): string {
  return `<fill in: ${input.type}${input.name ? ` ${input.name}` : ""}>`;
}

export function starterConfig(
  contract: string,
  source: string,
  inputs: readonly ConstructorInput[],
  options: { perKey?: boolean } = {},
): string {
  const hub = hubArgumentIndex(inputs);
  const args = inputs
    .map((input, index) => {
      const label = `${input.type}${input.name ? ` ${input.name}` : ""}`;
      // One per line, with the type beside it. Both because it is valid TOML and because it is
      // the only form in which "which argument is this" is answerable while editing.
      //
      // The hub's address is the one value that can be filled in with certainty: it does not
      // exist until `dev` or `ship` deploys against it, which is what the placeholder is for.
      // Anything else is left visibly unfinished rather than written as "0": a zero stake or a
      // zero address deploys fine and is wrong, and both commands refuse the marker by name.
      return index === hub
        ? `  "$HUB", # ${label} — the hub; dev and ship fill it in`
        : `  "${fillIn(input)}", # ${label} — yours to fill in`;
    })
    .join("\n");

  const perKey = options.perKey
    ? `
# This contract registers storage "per-key". \`interlude dev\` can serve one key: set delegate
# to that 32-byte key below. \`interlude ship\` cannot — the hosted node serves the whole
# contract (GLOBAL) only — so annotate with "global" before shipping.
`
    : "";

  return `# What a node should serve, and how to put it on a chain.
#
# \`interlude dev\` reads this, stands up a base chain, deploys the hub, bonds a validator,
# deploys ${contract}, delegates it and points a node at it. \`interlude ship\` sends the same
# constructor arguments and [[setup]] calls to the hosted control plane.
${perKey}
[app]
# ${source}
contract = "${contract}"
args = [
${args || "  # no constructor arguments"}
]

# "all" hands over the whole contract. A 32-byte key hands over one partition — one room,
# one user — and leaves the rest on the base chain. (ship: "all" only.)
delegate = "all"

# Who owns ${contract} on Monad after \`ship\`. Without it, the owner is Interlude's deploy key.
# \`ship --owner 0x...\` does the same. That address then calls acceptOwnership() once.
# owner = "0x..."

# Calls to make before delegating. Anything that seeds delegated state belongs here: once a
# partition is handed over, the write guard refuses base-chain writes to it. \`ship\` runs them
# from the deploying key, which is the owner at that point; $HUB is the only placeholder it knows.
# [[setup]]
# signature = "credit(address,uint256)"
# args = ["0x90F79bf6EB2c4f870365E785982E1f101E93b906", "1000"]

[node]
port = 8555
# Must differ from the base chain's, or Delegatable.isEphemeral() returns false and every
# delegated write reverts.
chain_id = 4242
commit_interval = 5
`;
}

/**
 * The first hour, printed by `init` when the project has not inherited Delegatable yet.
 *
 * This used to be one sentence about `delegateAll()`. The reader who sees it has just been
 * given a remapping and does not yet have a contract that uses it, so the next lines they
 * need are the import, the annotation, `gen`, and `ship` — not a reminder of the ABI.
 */
export function firstHour(src: string, wired = true): string {
  return (
    `no contract under ${src}/ inherits Delegatable yet (a fresh \`forge init\` Counter does not). ` +
    (wired
      ? `The remapping is written. `
      : `The remapping could not be written — see the warning above. `) +
    `That stop is expected (exit 1). Add this file — Foundry needs the pragma, and ` +
    `solc ${REQUIRED_SOLC}+ with evm_version cancun or later:\n\n` +
    `  // SPDX-License-Identifier: MIT\n` +
    `  pragma solidity ^${REQUIRED_SOLC};\n\n` +
    `  import {Delegatable} from "${CONTRACTS_REMAPPING}Delegatable.sol";\n` +
    `  import {IInterludeHub} from "${CONTRACTS_REMAPPING}interfaces/IInterludeHub.sol";\n` +
    `  import {Types} from "${CONTRACTS_REMAPPING}interfaces/Types.sol";\n\n` +
    `  contract YourApp is Delegatable {\n` +
    `      /// @custom:interlude global\n` +
    `      uint256 internal score;\n\n` +
    `      constructor(IInterludeHub hub_) Delegatable(hub_) {}\n\n` +
    `      function play() external whenNotDelegated(Types.GLOBAL) {\n` +
    `          score += 1;\n` +
    `      }\n\n` +
    `      function currentScore() external view returns (uint256) {\n` +
    `          return score;\n` +
    `      }\n` +
    `  }\n\n` +
    `Then, always with the scoped command (a bare \`interlude\` is not on PATH after npx):\n\n` +
    `  npx @interludelayer-sdk/cli gen --contract YourApp\n` +
    `  # keep the Delegatable import; inherit YourAppInterludeSurface;\n` +
    `  # call _registerInterludeSurface() in the constructor\n` +
    `  npx @interludelayer-sdk/cli init --contract YourApp\n` +
    `  npx @interludelayer-sdk/cli check\n` +
    `  npx @interludelayer-sdk/cli ship --owner <your address> --out .env.local\n\n` +
    `ship sends us the bytecode, the constructor arguments and [[setup]] from interlude.toml. ` +
    `We deploy, pay, and print a node URL. ` +
    `dev is the laptop loop and needs an interlude-node binary, ` +
    `which the published CLI does not ship.`
  );
}

