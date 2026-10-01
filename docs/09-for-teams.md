# Bring a contract

You write the contract. We run the node. You do not talk to us.

The contract stays on Monad. Users hit the node we start. Diffs settle back
to the same address. v1 is permissioned: Interlude operates the validator.
You trust us to run the process. You do not trust us to keep the state — a
slash unwinds a lie. Privacy is not in this product.

## First hour

Two packages, two folders: the CLI in your Foundry project (not a fork of
this repo), the SDK in the web app that talks to the node. The commands below
assume the two side by side, `contracts/` and `web/`, the layout
`npx create-interlude-app` writes. The SDK in the Foundry project does
nothing, and neither does the CLI in the web app. The Foundry project needs
solc 0.8.28 or later and `evm_version` cancun or later (the vendored contracts
use transient storage); `init` warns if `foundry.toml` pins something older.

> **Needs 0.2.2.** Every command on this page needs `@interludelayer-sdk/cli`
> and `@interludelayer-sdk/sdk` 0.2.2 or later, both on npm. The 0.1.x releases
> are older: cli 0.1.6 **silently ignores** `--owner` and `--out`, so `ship`
> deploys a contract we own, and it has no `abi`, `status` or
> `sessions create --signature`. A `^0.1` range never resolves to 0.2.

```sh
# contracts/, your Foundry project
npm i -D @interludelayer-sdk/cli@^0.2.2
npx @interludelayer-sdk/cli init
npx @interludelayer-sdk/cli gen --contract YourApp

# web/, your frontend
npm i @interludelayer-sdk/sdk@^0.2.2 viem
```

`init` vendors `Delegatable` into `lib/interlude` and writes the remapping
(also when the CLI was installed from npm: Foundry will not follow a remapping
into `node_modules` reliably).
`gen` writes `YourAppInterludeSurface.sol` beside the contract, from solc's
storage layout. Inherit it, call `_registerInterludeSurface()` in the
constructor, put `whenNotDelegated` on every function that writes the
annotated state. Same-directory Solidity is not auto-imported.

Then, still in `contracts/`:

```sh
npx @interludelayer-sdk/cli init --contract YourApp
npx @interludelayer-sdk/cli check
npx @interludelayer-sdk/cli ship --owner 0xYourWallet --out ../web/.env.local
npx @interludelayer-sdk/cli abi --out ../web/lib/your-app-abi.ts
npx @interludelayer-sdk/cli status 0xYourApp
```

`0xYourWallet` is your own wallet's address. Never one of anvil's default
accounts: their keys are public, so anyone could accept the ownership `ship`
offers it.

`ship` talks to `https://control.interludelayer.xyz`. We deploy the bytecode
on Monad testnet with the constructor `args` from `interlude.toml` (`"$HUB"` is
the hub; any other argument you did not give is refused, never guessed), run
your `[[setup]]` calls to seed state, call `delegateAll()`, start a node and
print the URL. We pay the gas. A `per-key` surface is refused: the hosted node
serves the whole contract as one partition. `--out ../web/.env.local` merges
`NEXT_PUBLIC_INTERLUDE_APP`, `NEXT_PUBLIC_INTERLUDE_NODE` and
`NEXT_PUBLIC_INTERLUDE_BASE_RPC` into the web app's env file; `abi` writes the
ABI there as a typed `as const` module; `status` reads the owner, the pending
owner, the delegation and the node's health. `ship --region sa` sits that node in São Paulo; omit it and
we pick from a country header or the Fly edge your request came
in through. `--name pongit` (or the TTY prompt) is the
label on the Fly machine: `il-sa-pongit-<hex>`. No faucet, no wallet key, no invite, no
issue to open.

The first node takes a few minutes to come up. A 502 right after the command
is the image building. Do not point your app's client at
`https://rpc.interludelayer.xyz`: that node only serves the Paris Room and
refuses calls to any other contract. Pointing the SDK at it with Room's ABI
(`roomAbi`, exported since sdk 0.2.1) is fine for trying the SDK before you
ship anything.

Closing the delegation and opening it again is a new session (new epoch). The
node URL stays the same; the process has to boot against that epoch. A 502
after a confirmed renewal used to stick because control returned the old
machine. It now restarts it. `POST /sessions` with the app address is enough
for an app control deployed. An app you deployed and delegated yourself (or
one control no longer remembers: its registry lives in memory unless
`CONTROL_STATE_FILE` sits on a volume) needs your
opt-in: `owner()` signs the EIP-191 message
`interlude:provision:<app address, lowercase>:<epoch>` (the epoch of the open
delegation, from the hub's `sessionOf`) and you pass it with
`interlude sessions create <app> --signature 0x…`; the CLI prints the message
and a ready `cast wallet sign` command. When the session actually ends, the
node is stopped, not left crash-looping on `no active delegation`. The app
stays locked until the challenge window has passed and someone calls
`releaseStake(app, partition)` on the hub; only then can it be delegated
again.

In `web/`, point the SDK at the URL `ship` printed:

```ts
const interlude = createInterludeClient({
  app,   // printed
  abi,
  node,  // printed
  base,
});

const session = await interlude.openSession({ wallet, scope: ["play"] });
await session.send("play");
```

`wallet` is the *user's* wallet. It is prompted once. `writeContract` on every
call is the wrong path.

`interlude check` belongs in CI so a layout shift cannot pass unnoticed.

## Laptop, if you want one

`interlude dev` stands up anvil, a hub, a validator and a node on loopback.
The published CLI does not ship the Rust binary: set `INTERLUDE_NODE_BIN` or
run from this checkout. The hosted path is `ship`. It does not need the binary.

Purse in this repo is the ordinary `mapping(address => uint256)` that already
walked that loop: `scripts/purse-walkthrough.sh`.

## What will not work

**A `constant` mapping key.** `balances[HOUSE]` where `HOUSE` is
`address constant` lets the optimizer fold the slot. No hash runs, the node
cannot see the entry. Make the key `immutable`.

**An inherited write you do not own.** OpenZeppelin `_transfer` has no
`whenNotDelegated`. If it writes a slot the node also holds, the next commit
fails on `oldValue` and the session stalls until `forceClose`. Auditing every
write path is yours.

**OpenZeppelin `Ownable` or `Ownable2Step`.** `Delegatable` already has an
owner: `owner()`, `pendingOwner()`, the `onlyOwner` modifier, a two-step
`transferOwnership` / `acceptOwnership`, and the `OwnershipTransferred` and
`OwnershipTransferStarted` events. Inherit OZ's too and `owner`,
`transferOwnership`, `onlyOwner` and `OwnershipTransferred` are each defined
twice (with `Ownable2Step`, `pendingOwner`, `acceptOwnership` and
`OwnershipTransferStarted` as well). The contract does not compile, and no
`override` fixes it, because `Delegatable`'s are not virtual. Drop the OZ
import and its `Ownable(initialOwner)` constructor call, and keep your
`onlyOwner` lines as they are: they now mean `Delegatable`'s owner, which is
the deployer until a hand-over, the one `ship --owner` offers you and the one
that can `undelegate`. There is no `renounceOwnership`.

**A contract that cannot be redeployed.** Delegated storage is declared at
construction. An immutable live contract cannot be adopted.

**A read of delegated state as an oracle.** A getter called on Monad while the
partition is live returns the last committed value, with no revert.
`Delegated.isStale` exists; nothing forces a caller to check it. A fill that
has to be replayable takes the signed print as calldata (`Tape`). Live Pyth
Lazer does not fit the node; swap the parser, not the call shape.

**Two partitions in one call.** Debit A and credit B needs both entries in the
same partition: `@custom:interlude global`, not `per-key`.

## What you are trusting

We deploy the bytecode, so the deployer is us, and until you take it the
on-chain owner is us too. With `ship --owner 0xYou`, control offers you
ownership as soon as the delegation is open (`transferOwnership`), and `ship`
prints the one command that completes it:

```sh
cast send 0xYourApp "acceptOwnership()" --rpc-url https://testnet-rpc.monad.xyz --interactive
```

Two steps, so a typo in the address cannot hand the contract to nobody. After
that you can `undelegate`, change the slash beneficiary
(`setSlashBeneficiary`), and use your own `onlyOwner` functions. The
beneficiary is read when a session opens: `ship --owner` has control set it
to your address before `delegateAll`, and a later `setSlashBeneficiary`
applies from the next delegation, not to the session already open. Without `--owner` we stay the owner and can
undelegate; that is the v1 hosted path.

Inside a session call `msg.sender` is your contract, not the user: write
against `_actor()`. `withSession` refuses the ERC20/721/1155 token-moving and
ownership selectors by default (fix round 2 adds `multicall`, ERC-1363,
ERC-4626, ERC-777 and `burn`/`burnFrom`). It checks only the outer selector,
so override `_isSessionBlocked` (returning `super`) to add yours, including
any function that forwards calldata or calls back into the contract.
`undelegate` does not unlock the contract: it stays locked through the
challenge window (an hour) until `releaseStake`. Revoking grants (`revokeAll`) is immediate on Monad but
reaches a running node only at the next delegation, so keep grants short.

The hub admin (us) curates who may validate. The bond, the challenge window
and slashing are live. A watcher can replay a batch, and the node answers a
challenge against it by playing the bisection itself. The default bench is
one resolver; a committee with a threshold is optional. You are trusting us,
with a paper trail, not a self-enforcing proof. Check `termsOf` and
`committeeOf` on the hub before you rely on it. The live hub's resolver is a
dedicated key; the public anvil key the audit of 2026-09-26 found on the
previous hub was rotated out the same day for new delegations.

One process serves one app. A batch is inspectable with `curl` against
`interlude_getBatch`.
