# @interludelayer-sdk/cli

Send us the bytecode. We deploy it, we pay, we run the node.

```sh
cd my-foundry-project
npx @interludelayer-sdk/cli init
npx @interludelayer-sdk/cli gen --contract YourApp
# import {YourAppInterludeSurface} from "./YourAppInterludeSurface.sol";
npx @interludelayer-sdk/cli check
npx @interludelayer-sdk/cli ship
```

`ship` talks to `https://control.interludelayer.xyz`. Nothing to set. The CLI prints
a node URL. Point the SDK at it.

The hub artifact and the Solidity a contract inherits (`Delegatable`, `Types`) are bundled.
`init` copies those sources into `lib/interlude` when they sit outside the project: Foundry
will not follow a remapping into the `npx` cache.

`dev` is the laptop loop (anvil, a hub, a validator, a node on loopback). A built
`interlude-node` is not bundled, so set `INTERLUDE_NODE_BIN` outside a checkout. You do
not need that binary to `ship`.

`init` writes `@interludelayer/contracts/=lib/interlude/` into `remappings.txt` if it is
missing, even when nothing inherits `Delegatable` yet. That is the first hour: vendor,
inherit, annotate, `gen`, `init` again, `check`, `ship`.

`init` compiles the project, finds the contracts that inherit `Delegatable`, and writes an
`interlude.toml`. `dev` reads it and stands up everything a session needs: a base chain, the
hub, a bonded validator with published terms, your contract, the delegation, and a node pointed
at it. Then it watches, and checks each batch against the chain as it settles.

This exists because the answer to "how do I try this on my contract" used to be "read five shell
scripts and write a sixth". None of that work is yours: the hub, the validator and the bond are
the same every time.

## Keeping your storage

Delegating state used to mean rewriting it. A balance became a `Delegated.MapUint256Slot` under
a hash you chose by hand, and every `balances[who]` in the contract became `BALANCE.get(who)`.

None of that is needed now. Mark what a node should hold, in place:

```solidity
/// @custom:interlude global
mapping(address => uint256) internal balances;
```

then `interlude gen --contract Purse` writes `PurseInterludeSurface.sol` beside it — the slots
read off solc's storage layout, and one `_registerInterludeSurface()` to call from your
constructor. Inherit it and you are done; the mapping stays an ordinary mapping.

Two modes. `global` hands the variable over as one partition, which is what a shared book needs:
one call can debit one seat and credit another, because both are in the same partition.
`per-key` makes each key its own partition, so a node can hold room 42 while room 43 stays on
Monad.

### `interlude check`, and why it is not optional

The generated file asserts slot numbers. Insert a state variable above a delegated one and
everything below it shifts — the file would go on naming slots that now belong to something
else, and your app would hand a node the wrong storage. Nothing would complain until a commit
did.

So the generated file carries a commitment to the layout it was read from, and `interlude check`
recomputes it:

```sh
npx @interludelayer-sdk/cli check   # in CI
```

It exits non-zero and tells you what moved.

### One sharp edge

A mapping indexed by a compile-time `constant` will not work, and the reason is worth
understanding. The node learns which entry a hashed slot belongs to by watching the EVM derive
it. With a `constant` key there is nothing to watch: solc can compute the slot itself, so the
optimizer folds it into a literal and no hash happens at run time. The write is refused, with an
error that says this.

Make the key `immutable` — or any value not known until deployment — and the derivation stays in
the code. `src/examples/Purse.sol` in the Interlude repo does exactly that, and its test suite
holds the property by checking the slot appears nowhere in the runtime bytecode.

### What you still do by hand

The write guard. An accessor could refuse a base-chain write while the node held the state;
`balances[to] += amount` cannot be intercepted, so `whenNotDelegated(partition)` goes on the
functions that seed or repair delegated state:

```solidity
function credit(address who, uint256 amount) external onlyOwner whenNotDelegated(Types.GLOBAL) {
    balances[who] += amount;
}
```

Forgetting it does not lose funds. The hub checks every diff's `oldValue` against what it holds,
so a base-chain write behind the node's back makes the next commit fail rather than land — the
session stalls until `forceClose` rather than settling something wrong.

## What you write

The smallest useful config is four lines. `$HUB` is filled in with the address of the hub this
command deploys, which does not exist when you write the file.

```toml
[app]
contract = "Counter"
args = ["$HUB"]
```

That gets you:

```
== ready
  base chain  http://127.0.0.1:8547    # anvil on this machine
  node        http://127.0.0.1:8555    # the local node, not the internet
  hub         0x5fbdb231…
  app         0xdc64a140…
```

Those two URLs are loopback: they only answer on the laptop that ran `dev`. The public node
is `https://rpc.interludelayer.xyz`, against Monad testnet. Clock on that node is at
[demo.interludelayer.xyz/clock](https://demo.interludelayer.xyz/clock).

The line that matters is the one after, once a batch lands:

```
ok batch 1: 3 transaction(s), root 0x880d08a370b1… recognised by Monad
```

That is not the node reporting on itself. The root it serves is compared against what the
validator signed on chain, and the transactions behind it are handed to the hub's
`isBatchLog`, which recomputes the root and says whether they are the ones the signature
covers. A node that served a different list would fail this.

## Configuration

Everything below has a default, and the defaults are the numbers the demo scripts in this
repository converged on.

```toml
[app]
contract = "Chips"        # a Foundry artifact name; this command deploys it
args = ["$HUB", "1000"]   # constructor arguments, as strings
delegate = "all"          # "all", or a 32-byte key for one partition

# Calls to make after the app is deployed and before it is delegated. Anything that seeds
# delegated state belongs here: once a partition is handed over, the write guard refuses
# base-chain writes to it, so seeding afterwards fails — correctly.
[[setup]]
signature = "credit(address,uint256)"
args = ["0x90F79bf6EB2c4f870365E785982E1f101E93b906", "1000"]

[chain]
port = 8547
block_time = 0.3          # Monad's is 0.4

[node]
port = 8555
chain_id = 4242           # must differ from the base chain's, see below
commit_interval = 5       # seconds
data_dir = ".interlude/data"

[env]
file = "app/.env.local"   # merged, not overwritten
vars = { NEXT_PUBLIC_NODE = "$NODE_RPC", NEXT_PUBLIC_APP = "$APP" }
```

Placeholders: `$HUB`, `$APP`, `$ADMIN`, `$VALIDATOR`, `$RESOLVER`, `$BASE_RPC`, `$NODE_RPC`.
Using one before the thing it names exists is an error rather than an empty string — `$APP` in
the app's own constructor arguments, for instance.

`chain_id` under `[node]` has to differ from the base chain's. `Delegatable.isEphemeral()`
compares the two, and if they match, every delegated write reverts. The command refuses to go
further rather than letting you find that out one revert at a time.

### When a constructor is not enough

Some apps need more bring-up than arguments can express. Point at a Foundry script instead:

```toml
[app]
script = "script/DeployChips.s.sol:DeployChips"
address_from = "Chips"
delegate = "all"
```

In this mode the script owns the whole bootstrap — including the hub — and this command reads
the addresses back out of Foundry's broadcast file rather than deploying a second hub beside the
one your script just made. The broadcast file rather than the console output, so you are not
obliged to print addresses in a shape a regular expression expects.

## Requirements

`forge`, `cast` and `anvil` on `PATH` ([getfoundry.sh](https://getfoundry.sh)), and a node
binary. In an Interlude checkout the binary is built for you on first run, which takes a minute;
elsewhere, set `INTERLUDE_NODE_BIN` to one.

- `INTERLUDE_NODE_BIN` — a built `interlude-node`. In a checkout the command builds it on first
  run. Outside one, this has to be set: the node is a Rust binary, not something npm can ship.
- `INTERLUDE_CONTRACTS_OUT` — optional. The hub artifact is bundled in this package. Set this
  only to point at a different `forge out/` you compiled yourself.
- `INTERLUDE_CONTRACTS` — optional. Directory holding `Delegatable.sol`. The same sources are
  bundled in this package; set this to point at a checkout you are editing.

Constructor arguments are read from config as value types only — addresses, integers, booleans,
strings and fixed bytes. A tuple or an array is expressible in TOML and would be guesswork to
map onto an ABI, and guessing wrong means deploying a contract configured differently from what
the file says. Use `script` for those.
