/**
 * The `interlude.toml` that `init` writes.
 *
 * Its own module so it can be generated and parsed back in a test. A generated config that does
 * not parse is the worst possible first impression — the reader has done nothing wrong and the
 * next command fails — and the first version of this had exactly that bug: a comment after a
 * value in a single-line array swallowed the closing bracket.
 */

export interface ConstructorInput {
  type: string;
  name?: string | undefined;
}

export function starterConfig(
  contract: string,
  source: string,
  inputs: readonly ConstructorInput[],
): string {
  const args = inputs
    .map((input) => {
      const label = `${input.type}${input.name ? ` ${input.name}` : ""}`;
      // One per line, with the type beside it. Both because it is valid TOML and because it is
      // the only form in which "which argument is this" is answerable while editing.
      //
      // The hub's address is the one value that can be filled in with certainty: it does not
      // exist until `interlude dev` deploys it, which is what the placeholder is for.
      return input.type === "address"
        ? `  "$HUB", # ${label} — $HUB if this is the hub, otherwise an address`
        : `  "0", # ${label}`;
    })
    .join("\n");

  return `# What a node should serve, and how to put it on a chain.
#
# \`interlude dev\` reads this, stands up a base chain, deploys the hub, bonds a validator,
# deploys ${contract}, delegates it and points a node at it.

[app]
# ${source}
contract = "${contract}"
args = [
${args || "  # no constructor arguments"}
]

# "all" hands over the whole contract. A 32-byte key hands over one partition — one room,
# one user — and leaves the rest on the base chain.
delegate = "all"

# Calls to make before delegating. Anything that seeds delegated state belongs here: once a
# partition is handed over, the write guard refuses base-chain writes to it.
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
