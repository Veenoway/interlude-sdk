# @interludelayer-sdk/cli

Send us the bytecode. We deploy it, we pay, we run the node.

```sh
cd my-foundry-project
npm i -D @interludelayer-sdk/cli
npx @interludelayer-sdk/cli init        # exits 1 until a contract inherits Delegatable — expected
npx @interludelayer-sdk/cli gen --contract YourApp
# import {YourAppInterludeSurface} from "./YourAppInterludeSurface.sol";
npx @interludelayer-sdk/cli init --contract YourApp
npx @interludelayer-sdk/cli check
npx @interludelayer-sdk/cli ship --owner 0xYourWallet --out .env.local
npx @interludelayer-sdk/cli abi --out src/abi.ts
npx @interludelayer-sdk/cli status 0xYourApp
```

Install it in the Foundry project, and the SDK (`npm i @interludelayer-sdk/sdk viem`) in the
frontend: two packages, two folders. Call the CLI by its scoped name, as above. Inside the
project, `npx @interludelayer-sdk/cli` runs the copy you installed; a bare `npx interlude` in a
folder that has not installed it fetches an unrelated npm package called `interlude`.

Your project needs **solc 0.8.28 or later and `evm_version` cancun or later**: the vendored
contracts use transient storage (`tstore`). A fresh `forge init` is fine as it is; `init` warns
if `foundry.toml` pins something older. The starter it prints uses `pragma solidity ^0.8.28`.

## `init`

`init` writes `@interludelayer/contracts/=lib/interlude/` into `remappings.txt` and copies the
sources into `lib/interlude` — also when the CLI is installed in your `node_modules`, since
Foundry will not follow a remapping into the `npx` cache and `node_modules` is rewritten by the
next install. Then it compiles and looks for contracts that inherit `Delegatable`.

Until one does — and a fresh `forge init` with only `Counter.sol` does not — it prints a starter
contract and **exits 1**. That is the first hour: add the starter, annotate, `gen`, then
`init --contract YourApp` writes `interlude.toml`.

Constructor arguments it can name are filled in: the hub (typed `IInterludeHub`, or named
`hub`, or the only address) becomes `"$HUB"`. Anything else is written as
`"<fill in: uint256 minBet>"`, and both `ship` and `dev` refuse that marker by name until you
replace it. It used to write `"0"`, which deploys fine and is wrong.

## `ship`

`ship` talks to `https://control.interludelayer.xyz` (`INTERLUDE_CONTROL_URL` or `--control`
to override). Nothing to set. It sends:

- the bytecode and the whole ABI;
- `args` from `[app]` in `interlude.toml`, one string per constructor input, `"$HUB"` for the
  hub. A constructor that takes only the hub needs no `args`. Any other constructor without
  `args` is refused here — `ship` does not guess, and the hosted deployer no longer does either;
- every `[[setup]]` call, run by the deploying key before `delegateAll` (so it can seed
  delegated state). `$HUB` is the only placeholder on the hosted path; `value` is refused;
- `owner`, from `--owner 0x...` or `owner = "0x..."` under `[app]`.

It prints the app address and the node URL, and `--out .env.local` merges
`NEXT_PUBLIC_INTERLUDE_APP`, `NEXT_PUBLIC_INTERLUDE_NODE` and `NEXT_PUBLIC_INTERLUDE_BASE_RPC`
into that file (other lines are kept).

### Who owns the app

Control deploys and delegates with its own key — `delegateAll()` is owner-only, so it has to.
**Without `--owner`, Interlude's key stays the owner**, and `ship` says so loudly. With
`--owner`, control offers ownership to that address once the delegation is open, and `ship`
prints the one command that takes it:

```sh
cast send 0xYourApp "acceptOwnership()" --rpc-url https://testnet-rpc.monad.xyz --interactive
```

Until that runs, Interlude's key is still the owner. `interlude status 0xYourApp` shows the
owner and the pending owner.

The owner is your own wallet's address. Never one of anvil's ten default accounts
(`0xf39F…2266`, `0x7099…79C8`, `0x3C44…93BC`, `0x90F7…b906`, …): their private keys are printed
in anvil's banner, so whoever sent `acceptOwnership()` first would own the app, and could
undelegate it, re-seed it and receive its slash payouts. `ship` refuses them, from `--owner` or
from `[app] owner`, before it sends anything — unless `--control` is a control plane on this
machine, which deploys on a local chain where those accounts are the point. `interlude.toml`
itself only checks that `owner` is an address: `dev` and `abi` read the same file and ignore
the owner.

### When it fails, and running it twice

If control deploys the contract and then fails (the machine, the delegation), `ship` still
prints the `app` address and the retry: `interlude sessions create <app>`. Deploys are rate
limited per IP, so `ship` remembers what it shipped in `.interlude/shipped.json`: the same build
(bytecode, args, setup, owner) twice is refused with the existing app's address; `--again`
deploys a second copy. The request times out after 10 minutes (dots while it waits); a network
failure names the host rather than printing a stack.

`--region us|ny|eu|asia|sa|tokyo|mumbai|africa` sits the node on Fly metal in that city
(California, New York, Paris, Singapore, São Paulo, Tokyo, Mumbai, Johannesburg). Omit it and we
pick from where you called `ship`: a country header on control or the Fly edge your request
came in through. On a TTY `ship` asks
for a short name so the machine is `il-tokyo-pongit-<hex>`; `--name` skips the prompt. One
writer, so one region — two replicas would both try to publish the same batch. The first node
takes a few minutes to come up; a 502 right after the command is the image building. Point the
SDK at that URL, not at `https://rpc.interludelayer.xyz` (Room only).

### A node for a contract you deployed yourself: `sessions create`

Control runs a node on its own account only for an app it deployed (`ship`), or one whose owner
asked for it. Delegating to our validator is not enough on its own: that would give anyone a
free machine. So for an app you deployed and delegated yourself (or one shipped before control
was redeployed and forgot it), the address `owner()` returns signs an EIP-191 message naming the
app and the hub session's epoch:

```sh
npx @interludelayer-sdk/cli sessions opt-in 0xYourApp   # prints the message, epoch included
cast wallet sign --interactive "interlude:provision:0xyourapp:<epoch>"
npx @interludelayer-sdk/cli sessions create 0xYourApp --signature 0x...
```

`sessions create` without `--signature` prints the same thing when control answers that an
opt-in is needed. The epoch changes each time the app delegates again, and so does the message:
an old signature does not reopen a new session.

### `per-key` is local only

The hosted node serves the whole contract as one partition, `GLOBAL`. A contract that registers
storage `per-key` would deploy, delegate, get a node — and then have every keyed write refused.
So `init` and `ship` refuse it with a pointer to `global`. `gen` still generates it and `dev`
still serves one key locally (`init --local` writes the config, then set `delegate` to the key).

## `abi` and `status`

`interlude abi [--contract X] [--out src/abi.ts]` writes `export const abi = [...] as const`
from the compiled artifact, so viem infers function names and types. Without `--out` it prints
the module; a path ending in `.json` gets the plain array.

`interlude status <app>` reads the owner and pending owner from the app, the delegation (status,
validator, epoch, batches, last commit) from its hub, and the node's `/health`. `--rpc` picks the
chain (default `INTERLUDE_BASE_RPC`, then Monad testnet); `--node` the node (default: the one
control has for that app).

## `logs`

`interlude logs --follow` opens `interlude_subscribe("applied")` on a node and prints one line
per call the node runs, as it runs it:

```
<time>  <status>  <function>  block <n>  from <sender>  tx <hash>
```

Every field is what the node sent, except the time, which is when your machine received the
call (UTC). There is no latency or gas column: the node reports neither, and the command does
not make them up. The status is `ok` or `failed`: the node's `succeeded` flag, which is false
for a revert and for a halt such as running out of gas, and the notification does not say
which. `--abi` names the function (a JSON ABI, a forge artifact such as
`out/YourApp.sol/YourApp.json`, or the file `interlude abi --out` wrote); without it you get the
selector, and `(no selector)` for calldata shorter than four bytes. The block is the node's;
which batch settles a call is decided at commit and is not in the notification (`dev` prints
each batch as it settles). `--json` prints each notification as the node sent it, calldata,
return data and logs included, plus two keys the command adds: `receivedAt` and, with `--abi`,
`function`.

A follower that falls far behind the node misses calls, and the node does not say which: the
stream is what the node sent, not a guaranteed record of every call. A transaction's receipt
(`eth_getTransactionReceipt` on the node) is.

The node is `--node <url>`, else `INTERLUDE_NODE_URL`, else the node `ship` last gave this
project. There is no public default: somebody else's node would print real calls that are not
yours. A node that cannot be reached, refuses the subscription or does not answer within 10 s
is an error — the command exits 1 with the reason and prints nothing on stdout — and so is a
node that closes the stream later. A 429 on the upgrade means the node turned this machine away
(too many sockets open to it, or its request budget spent), not that it is down. It runs on
Node 20 and later: the socket is the `ws` package, which viem already depends on.

## `dev`

`dev` is the laptop loop (anvil, a hub, a validator, a node on loopback). It needs an
`interlude-node` binary, which is not published: this package does not carry it, and neither
does the `interlude-sdk` repository. Outside an Interlude checkout, set `INTERLUDE_NODE_BIN` to
one you have, or skip `dev`: `ship` needs no binary, and the SDK's `examples/try.mjs` runs
against a public floor with nothing to install but the SDK. Before compiling or starting
anything, `dev` checks that both ports are free and that the node binary exists. anvil runs with
`--disable-code-size-limit`: the hub is over EIP-170's 24 KB, as Monad allows and a stock anvil
does not.

The hub artifact and the Solidity a contract inherits (`Delegatable`, `Types`) are bundled,
including `bisect` / `proveStep` / `BisectGame`. The hub is v3: the same code as the hub live
on Monad testnet at
[`0x98922c6E…C43e`](https://testnet.monadscan.com/address/0x98922c6E5e4Bea62761C71D2401c7ec2c26eC43e),
of which `dev` deploys a fresh copy on anvil. Publishing without a `pnpm bundle` after the hub
ABI moves is how `npx` deploys last week's bytecode.

`dev` reads `interlude.toml` and stands up everything a session needs: a base chain, the hub, a
bonded validator with published terms, your contract, the delegation, and a node pointed at it.
Then it watches, and checks each batch against the chain as it settles.

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

Those two URLs are loopback: they only answer on the laptop that ran `dev`. The public
Room node is `https://rpc.interludelayer.xyz`, against Monad testnet. The demo is at
[demo.interludelayer.xyz/room](https://demo.interludelayer.xyz/room). Your app gets a
different URL from `ship`.

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
args = ["$HUB", "1000"]   # constructor arguments, as strings — dev and ship both send them
delegate = "all"          # "all", or a 32-byte key for one partition (dev only)
owner = "0xYourWallet"    # ship: who owns it afterwards; your own address, never anvil's

# Calls to make after the app is deployed and before it is delegated. Anything that seeds
# delegated state belongs here: once a partition is handed over, the write guard refuses
# base-chain writes to it, so seeding afterwards fails — correctly.
[[setup]]
signature = "credit(address,uint256)"
args = ["0xYourWallet", "1000"]

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
the app's own constructor arguments, for instance. `ship` knows only `$HUB`: the others name
accounts and URLs that `dev` creates on your laptop, and it refuses them before sending.
`[env]` is `dev`'s; for `ship`, use `--out`.

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

Node 20 or later. `forge`, `cast` and `anvil` on `PATH` ([getfoundry.sh](https://getfoundry.sh)),
solc 0.8.28+ with `evm_version` cancun or later, and — for `dev` only — a node binary. In an
Interlude checkout the binary is built for you on first run, which takes a minute;
elsewhere, set `INTERLUDE_NODE_BIN` to one.

- `INTERLUDE_NODE_BIN` — a built `interlude-node`. In a checkout the command builds it on first
  run. Outside one, this has to be set: the node is a Rust binary, not something npm can ship.
- `INTERLUDE_CONTRACTS_OUT` — optional. The hub artifact is bundled in this package. Set this
  only to point at a different `forge out/` you compiled yourself.
- `INTERLUDE_CONTRACTS` — optional. Directory holding `Delegatable.sol`. The same sources are
  bundled in this package; set this to point at a checkout you are editing.
- `INTERLUDE_CONTROL_URL` — optional. The control plane `ship`, `sessions` and `status` talk to.
- `INTERLUDE_NODE_URL` — optional. The node `logs --follow` follows when `--node` is not given.
- `INTERLUDE_BASE_RPC` — optional. The chain `status` and `sessions opt-in` read and
  `ship --out` writes (default `https://testnet-rpc.monad.xyz`).
- `INTERLUDE_LOCAL_DELEGATION_FEE` — optional, wei. What `dev`'s local validator charges per
  delegation (default 0.01 MON, forwarded with `delegateAll`). A free delegation is how anyone
  fills a validator's `maxDelegations`, so the local stack charges one like a real validator.
- `INTERLUDE_DEBUG=1` — print the stack for an unexpected error instead of one sentence.

Paths with spaces or accents (`~/Library/Application Support/...`, a home directory named
José) work: the CLI decodes its own location with `fileURLToPath`. Since 0.2.0.

Constructor arguments are read from config as value types only — addresses, integers, booleans,
strings and fixed bytes. A tuple or an array is expressible in TOML and would be guesswork to
map onto an ABI, and guessing wrong means deploying a contract configured differently from what
the file says. Use `script` for those.
