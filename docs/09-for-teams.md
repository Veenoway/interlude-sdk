# Bring a contract

You write the contract. We run the node. You do not talk to us.

The contract stays on Monad. Users hit the node we start. Diffs settle back
to the same address. v1 is permissioned: Interlude operates the validator.
You trust us to run the process. You do not trust us to keep the state — a
slash unwinds a lie. Privacy is not in this product.

## First hour

From your Foundry project, not a fork of this repo:

```sh
npm i @interludelayer-sdk/sdk @interludelayer-sdk/cli
npx interlude init
npx interlude gen --contract YourApp
```

`init` vendors `Delegatable` into `lib/interlude` and writes the remapping.
`gen` writes `YourAppInterludeSurface.sol` beside the contract, from solc's
storage layout. Inherit it, call `_registerInterludeSurface()` in the
constructor, put `whenNotDelegated` on every function that writes the
annotated state. Same-directory Solidity is not auto-imported.

Then:

```sh
npx interlude ship
```

`ship` sends us the bytecode. We deploy it on Monad testnet, we pay the gas,
we call `delegateAll()`, we spawn a node, we print the URL. No faucet, no
wallet key, no invite, no issue to open. The CLI already knows where we are.

Point the SDK at that URL:

```ts
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

**A contract that cannot be redeployed.** Delegated storage is declared at
construction. An immutable live contract cannot be adopted.

**A read of delegated state as an oracle.** A getter called on Monad while the
partition is live returns the last committed value, with no revert.
`Delegated.isStale` exists; nothing forces a caller to check it.

**Two partitions in one call.** Debit A and credit B needs both entries in the
same partition: `@custom:interlude global`, not `per-key`.

## What you are trusting

We deploy the bytecode, so the on-chain owner is us. You keep the source, the
frontend and the users. We can undelegate. That is the v1 hosted path.

The hub admin (us) curates who may validate. The bond, the challenge window
and slashing are live. A watcher can replay a batch. The resolver is still
one address. You are trusting us, with a paper trail, not a self-enforcing
proof.

One process serves one app. A batch is inspectable with `curl` against
`interlude_getBatch`.
