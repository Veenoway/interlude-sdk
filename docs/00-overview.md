# Interlude for app developers

The contract stays on Monad. A node runs the hot loop. Diffs settle back to
the same address. Users sign once, then pay no gas.

Interlude is an ephemeral execution layer. Any contract that needs latency
below a block — a game tick, a tap, a match, a social write — uses it the
same way. Monad remains the source of truth; the node is a fast, disposable
runtime.

`interlude ship` is how a team that is not us gets there: send the bytecode,
we deploy, we run the node, we print a URL.

## Two contracts, on purpose

**`InterludeHub`** is deployed once per chain. It holds every piece of security
logic: validator bonds, delegation lifecycle, commit sequencing, challenges and
slashing. Audited once, fixed once.

**`Delegatable`** is the thin part your app inherits. It holds no security logic
at all, only the lock flags and the two doors the hub is allowed to open.

Why split at all? Because the EVM has two hard limits: a contract can only
`sstore` its own storage, and only it can `sload` it. So the hub decides *what
is allowed*, and the app performs the write and checks the expected old value.
Nothing else crosses the boundary.

## Writing an app

Mark ordinary Solidity storage. `interlude gen` reads solc's layout and writes
the registration. The mapping stays a mapping.

```solidity
import {Delegatable} from "@interludelayer/contracts/Delegatable.sol";
import {Types} from "@interludelayer/contracts/interfaces/Types.sol";

contract MyGame is MyGameInterludeSurface {
    /// @custom:interlude global
    uint256 internal score;

    constructor(IInterludeHub hub_) Delegatable(hub_) {
        _registerInterludeSurface();
    }

    function play() external whenNotDelegated(Types.GLOBAL) {
        score += 1;
    }
}
```

The modifier is yours. A plain assignment cannot be intercepted, so
`whenNotDelegated` goes on the functions that write delegated state. On Monad,
once the partition is live, those writes revert. On the node (different
`chainId`, same bytecode) the modifier is a no-op.

The older path still exists: a `Delegated.Uint256Slot` behind a hash, with the
lock inside `Delegated.add` and no modifier to forget. Use it when you want the
unguarded write to be unwritable. Most apps want to keep their storage, which
is why `gen` is the default.

A mapping key that is a Solidity `constant` will not work. The optimizer folds
the hash into a literal, no `KECCAK256` runs, and the node cannot see the
entry. Make the key `immutable`. `src/examples/Purse.sol` holds that property
in its tests.

## Partitions: global, per instance, per user

A delegation covers one **partition** of one app, and the annotation decides which:

| Annotation | Partition | Example |
|---|---|---|
| `@custom:interlude global` on a scalar | the whole app moves together | a chess board, a counter |
| `@custom:interlude global` on a mapping | one shared partition for the mapping | a token ledger, an order book, a pool |
| `@custom:interlude per-key` | one partition per key | room 42 runs on a node while 43 stays on Monad; or one partition per user address |

The node recovers mapping keys by watching `KECCAK256` in the EVM. Assembly that
writes a mapping without hashing the pair produces a slot the node will refuse.

Then delegating takes no arguments beyond the instance:

```solidity
myGame.delegateAll();                       // every global variable
myRooms.delegateKey(bytes32(uint256(42)));  // just room 42
```

`delegateKey` hands over the **exact derived slots** for that key, never the
mapping base, so the validator gains no rights over anybody else's entry.

The two shapes are worth reading side by side, because the choice is not a
preference. `src/examples/Players.sol` registers per key: each player's square is
its own partition, so one player can run on a node while everybody else stays on
Monad. `src/examples/Chips.sol` registers the whole mapping, because it has to —
a transfer debits one balance and credits another in the same call, and two
independently delegated partitions cannot be written together, since the second
write is somebody else's to authorise. The price of moving as one book is that a
validator holding the delegation holds every balance on the table, which is why
that app declares a stake floor. It is also what lets an address the table has
never seen write its first entry mid-session, with no delegation of its own.

One number is worth setting deliberately. The validator's stake is everything it
forfeits for cheating, so an app holding more value than the stake has turned
fraud into arithmetic. Declare a floor beside the state it protects and the hub
refuses any validator offering less:

```solidity
_requireStake(50 ether);
```

Pick global whenever the fast path touches **shared** state. Per-key only works
when instances never touch each other's data.

## What you actually have to do

You write the contract. We run the node.

1. **Contract**: inherit `Delegatable` and register your delegated state in the
   constructor. Behind a proxy, do it in the initializer and call
   `_initDelegatable(owner)` there too.
2. **Go live**: `npx @interludelayer-sdk/cli ship` talks to
   `https://control.interludelayer.xyz`. We deploy on Monad testnet, we call
   `delegateAll`, we start a node, we print the URL. The first node takes a
   few minutes to come up. No validator to pick, no stake, no window, no
   machine. You only call `delegateAll` or `delegateKey` yourself for a
   second partition later. Do not point the SDK at
   `https://rpc.interludelayer.xyz` — that node only serves Room.
3. **Frontend**: point the client at the URL we print. Standard `eth_*`, so
   viem and wagmi work unchanged.

`interlude dev` is the same loop on loopback and needs the Rust binary. The
hosted path does not.

`undelegate(partition)` unlocks the app immediately; the stake stays reserved
for the challenge window, then `hub.releaseStake(...)` frees it.

Running your own node is not open yet. v1 is a curated set: the hub admin
allows a validator, and only then can it bond and publish terms with
`hub.register(terms)`. So today the trust assumption is Interlude, not a bond.
[04-security.md](04-security.md) says exactly what that does and does not buy
you. The bond and challenge machinery is live regardless, so opening the set
later is a governance change rather than a redesign.

**Anyone** can call `hub.forceClose(app, partition)` once the validator has
gone silent past `maxBatchInterval`, or once the session has simply run past
`maxDelegationDuration` whatever it has been committing. The first covers a dead
node; the second puts a ceiling on a node that keeps up appearances while
serving nobody, since committing on schedule holds off the silence clock but not
the deadline.

## Session keys

A game that asks for a wallet signature per tap is not a game. A **session
grant** is one EIP-712 message the user signs once, naming a throwaway key, an
expiry and the functions that key may call. The key signs the ephemeral
transactions itself from then on, and the user is never prompted again.

What it costs the app is one identifier per function:

```solidity
Delegated.MapUint256Slot internal constant SCORE =
    Delegated.MapUint256Slot.wrap(keccak256("MyGame.score"));

function play() external {
    SCORE.add(_actor(), 1);   // where msg.sender would have gone
}
```

`_actor()` *is* `msg.sender` until somebody signs a grant, so an app can be
written against it from day one and behave exactly as it would have. A key
presents its grant through the wrapper `Delegatable` already carries:

```solidity
myGame.withSession(grant, signature, abi.encodeCall(MyGame.play, ()));
```

`withSession` verifies the grant, records the granter and calls `play()` on
itself, so `play` keeps its signature, its selector and every existing caller.
A frontend that signs no grant notices nothing.

Nothing is registered anywhere. The grant travels in calldata, which is what
keeps a batch replayable: a resolver re-verifies the same signature over the
same bytes and reaches the same verdict, with no extra state to pin.

Four things bound a grant.

- **The app and the chain**, through the EIP-712 domain. The domain names the
  *base* chain, never the ephemeral one, whose id is a node setting the user
  could not be asked to recognise. So one signature is valid on both the fast
  path and the settlement path while still pinning to one deployment.
- **The expiry**, exclusive, and the only bound that holds without anybody
  having to act. Keep it short.
- **The scope**: the selectors that key may reach. `anyFunction` exists and is
  a footgun, because a wallet prompt reading "only `play`" is the whole point.
  Inside a session, `this.other()` does not inherit the actor unless the grant
  was a wildcard: the fence is the function the key was admitted through.
- **The epoch**: `hub.bumpSessionEpoch()` invalidates every grant the caller
  has ever signed, for every app, in one transaction.

A grant carries no value and `withSession` is not payable. A spend limit would
need a counter of what has been spent, and a counter is exactly the state a
signed-once grant exists to avoid. A session key moves state, not money.

`src/examples/Players.sol` is the whole thing in thirty lines.

## Money is optional

Apps that hold no tokens (a game, a leaderboard) never touch the vault. Apps
that do can use the Interlude vault so the node cannot mint: internal balances
are capped by real deposits. See [01-vault.md](01-vault.md).

## What Interlude is not

Not an app, not a DEX, not a game, and not an L2. Nothing is bridged: the
contract never leaves Monad, and between sessions it is natively composable
with the rest of the ecosystem.
