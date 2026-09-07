# Security model (optimistic)

Interlude v1 has **no cryptographic fraud proof**. Security rests on money at
risk plus an independent resolver. This document states exactly what is and is
not guaranteed.

## Trust model in v1: permissioned, and we say so

Interlude operates the validator. The hub admin decides who may run one
(`allowValidator`) and who may judge a dispute (`allowResolver`). Apps stay
permissionless: anyone can deploy and delegate.

So the honest sentence is: **you are trusting Interlude, not a bond.** This is
where MagicBlock is too, and pretending otherwise would be worse than admitting
it.

The bond, challenge and slashing machinery is built anyway, for two reasons.
It puts a real cost on our own misbehaviour today, and it means opening the
validator set later is a governance change rather than a redesign. Everything
below describes machinery that works; what a curated set changes is *who* can
enter it, not what happens once they are in.

Two rules make the curation meaningful:

- A validator cannot be its own resolver (`ResolverIsValidator`). Otherwise it
  judges its own fraud, and since a dismissed challenge pays the challenger's
  bond to the validator, every challenge against it becomes free income.
- Revoking a validator only closes the door to new delegations. Live sessions
  run to completion on the terms they opened under, so no app is cut off
  mid-flight.

## State machine

A delegation covers one `(app, partition)` pair.

| Status | On-chain writes to that partition | Commits | Validator stake |
|---|---|---|---|
| `None` | allowed | n/a | not reserved |
| `Active` | blocked | allowed | reserved |
| `Exiting` | allowed | blocked | reserved until `stakeUnlockAt` |
| `Challenged` | blocked | blocked | reserved, at risk |

`undelegate` moves `Active → Exiting`: the app is usable again immediately, but
the stake stays reserved for the whole challenge window. This closes the obvious
attack: commit a fraudulent batch, exit next block, walk away with the money.

## One bond, many delegations

A validator calls `depositBond()` once. Each delegation reserves
`Terms.stakePerDelegation` from that bond, and `withdrawBond` can only touch the
unreserved part.

A validator also publishes **standing terms** once: stake per delegation,
windows, resolver, how many sessions it will serve, and whether it is open at
all. Every delegation it takes copies those terms.

This is what stops a sham app from deploying, naming a real node and locking its
bond behind a century-long challenge window: the terms are the validator's own,
so there is nothing to impose on it. Changing them only affects future sessions,
so a validator cannot retroactively shorten the window its live stake is exposed
to either.

It also keeps the app developer out of it entirely: no validator to pick, no
stake to negotiate, no signature round-trip.

The one number an app *should* care about is the stake, because the stake is the
whole downside of cheating. A validator holding an app worth more than its own
stake is looking at arithmetic, not at a risk, and no challenge window changes
that sum. So an app declares a floor with `_requireStake(amount)` beside the
state it registers, and `openDelegation` reverts if the validator's terms come
in below it. The figure is copied into the delegation, so lowering the terms
afterwards does not reach a session already open. Left at zero — the default —
the app takes whatever the validator posted, which is only reasonable for state
nobody would pay to corrupt.

Capacity is finite, so opening a session is not free: `Terms.delegationFee` is
charged on `openDelegation` and credited to the validator. Filling every slot
with junk apps now costs the attacker money per slot, on top of gas, and the
validator can always close its door with `open = false`.

This is the capital-efficient shape: a 10 ETH bond can back ten 1 ETH
delegations at once, and slashing one delegation takes only its own stake. One
bond per delegation would make thousands of ephemeral instances unaffordable.

## Liveness

**Anyone** can call `forceClose` for either of two reasons. The app unlocks and
the stake enters the normal challenge window.

The first is silence: no commit landed within `maxBatchInterval`. That covers a
node that died, which without this plus an absent owner would freeze user funds
forever.

The second is age: the session has run past `maxDelegationDuration`, however
alive it looks. Silence is not the only way a node can hold an app hostage. One
that keeps committing on schedule — even empty batches — while refusing to serve
anybody resets the silence clock forever, and there is no way for the chain to
tell that apart from a session nobody is using. Refusing empty commits does not
help: an idle session has nothing to commit, so the empty batch *is* the
heartbeat, and a censoring node could flip one slot back and forth for the same
price. So the bound is on time instead.

Because this term protects users *from* the validator rather than exposing the
validator's own bond, it is the one part of `Terms` a validator cannot set
freely: the hub caps it at seven days. A validator may choose less.

This bounds censorship rather than removing it — worst case, a censoring node
holds an app for one session length. Removing it needs forced inclusion: users
queue a transaction on-chain and the validator is force-closed if it does not
include it. That needs the batch's transactions published first, so it is
[a known limitation](#known-limitations-v1) rather than something v1 closes.

## Reserved storage

`Delegatable` keeps its owner and lock flags in a namespaced region. The hub
refuses to delegate any slot in that region, and the app refuses to write there
even if the hub asked. Otherwise an owner who mis-declared a slot would hand the
validator the ability to rewrite the app's owner.

## Session keys

A grant is a signed message carried in calldata, never a registry entry. That
is a security property as much as a determinism one: there is no stored
authorisation for anybody to read at the wrong block, and a resolver reaches
its verdict from the same bytes the node did.

The EIP-712 domain binds the app and the base chain, so a signature is
worthless at a second deployment. Only the key the grant names may present it,
so a grant lifted out of somebody's calldata is inert without its key.

Two fences sit on what a session can reach, and they belong to different
parties. The **scope** is the user's: the selectors they agreed to, and nothing
authorises anything if they agreed to none. The **block list** is the app's:
`withSession` refuses `applyDelegatedDiffs`, `onDelegationChanged`, the
`delegate*` family, `undelegate` and itself, whatever a grant says. The
self-call arrives with `msg.sender == address(this)`, so without the block list
an app that owns itself would let a session walk through `onlyOwner` and
undelegate.

The actor lives in transient storage inside the reserved region, so no
validator can write it and no slot survives holding a stale identity. It is
cleared before `withSession` returns rather than left to the end of the
transaction, because a direct call arriving afterwards must not find a session
still open. `_actor()` returns it only for a call that came through the
wrapper's own self-call *and* names the function the grant admitted. Either
check missing is a way to spend the granter's state as the granter: a token
callback calling the app straight back, or a scoped function reaching an
unscoped one through `this`.

## Challenging

`challenge` is payable and requires `challengeBond`. Without a bond, freezing a
session would be free. It is callable while `Active` and during the
post-undelegate window, never after `stakeUnlockAt`.

A challenge locks the partition in both directions: contested state must not
move while it is disputed.

## Resolution

A `resolver` is fixed at delegation time, drawn from the admin-registered set
and never the validator itself. In production this is the Chainlink CRE watcher,
which re-executes the batch against the pre-state pinned by `baseBlock` and the
clock pinned by `execTimestamp`.

| Verdict | Validator | Challenger | App |
|---|---|---|---|
| fraud confirmed | loses the reserved stake | bond back + 50% of the stake | unlocked, delegation ends |
| dismissed | gains the challenger's bond | loses their bond | resumes at the same batch |
| resolver silent | stake released untouched | bond back minus `timeoutPenaltyBps` | unlocked, delegation ends, receives the penalty |

The other 50% of a slashed stake goes to the delegation's `beneficiary`, who
represents the harmed users.

**Why a timeout refunds instead of slashing.** If an absent resolver meant an
automatic win, anyone could post a small challenge bond, wait, and collect the
stake. Refunding removes that profit. The cost of an absent resolver is that the
session stops, which is a safe failure rather than a wrong payout.

**Why the refund is not complete.** Nothing was proven, but a live session was
still killed. A full refund would make stalling free and repeatable, so the
challenger forfeits `timeoutPenaltyBps` of its bond (capped at 20%, or honest
challenges become too expensive to bring).

That penalty goes to the **app**, not to the validator. Paying the validator
would give it a reason to arrange the resolver's silence; paying the app means
nobody inside the dispute profits from a timeout, and the party that actually
lost its session is the one compensated.

## Fixed

- **Validator escaping with the bond.** The stake now stays reserved through the
  challenge window, including after `undelegate`.
- **Free griefing.** Challenges are bonded.
- **Vault bricking by donation.** The backing check used exact equality against
  `token.balanceOf`, so a 1 wei `transfer` permanently broke every deposit. It
  now asserts `claims <= balance`, and `deposit` credits the measured delta.
- **Cross-epoch signature replay.** Batch numbers restart at 1 on each
  delegation, so an old signed batch could be replayed later. The epoch is now
  part of the commit digest.
- **Stale slot permissions.** Permissions are keyed by epoch, so a new validator
  never inherits a previous one's rights.
- **Delegatable's own storage.** Now refused at both ends.
- **Dead node freezing an app.** `forceClose`.
- **A heartbeat holding an app hostage.** `forceClose` only opened on silence,
  and every commit reset the silence clock — including an empty one, which is
  what an idle session legitimately sends. A validator that committed on
  schedule while serving nobody held the app forever. A session now expires on
  time as well, capped by the hub at seven days.
- **A signed field the hub never read.** Commits carried a `PriceReport[]`
  under the validator's signature which nothing validated, stored or emitted,
  while the node never filled it. It read as though the hub attested to prices.
  Removed rather than left in place for later.
- **The wrong EVM.** The node executed under Ethereum's rules while claiming to
  extend Monad. Every batch was replayable in principle and wrong in practice:
  clearing a slot earned a 4800 gas refund that Monad does not give, the
  transaction cap sat at 16.7M instead of 30M, and a contract between 24KB and
  128KB was rejected here and fine on the base chain. `monad-revm` pinned to
  `MonadTen` now runs the show, and the delegation records which rules it was
  opened under.
- **Reserving a validator's bond without asking it.** A delegation now runs on
  the validator's own published terms.
- **One panic silencing the whole node.** A handler that panicked poisoned the
  session mutex, so every later request panicked as well: the process stayed up,
  answered nothing, and still passed a health check on `eth_chainId`, which
  never takes the lock. The guard is recovered instead and the node halts, which
  the journal turned into a real answer rather than a resigned one — the
  panicking handler's work reached disk before memory, so a restart rebuilds it.
- **Running out of memory on its own.** Blocks closed every 10 ms and none were
  ever dropped, nor the receipts inside them, so a session that simply ran long
  enough died of it. Ten minutes of history is retained now.
- **A hard stop destroying state users were promised.** A clean shutdown has
  published a closing batch for a while; a `SIGKILL`, an OOM or a lost machine
  took everything since the last commit, and `INTERLUDE_COMMIT_SECS` was
  quietly the size of that loss. Accepted transactions are now appended to a
  write-ahead log and flushed *before* the sender is told they worked, and
  replayed at startup. The log is scoped to one epoch and one pinned block, so a
  stale one is discarded rather than replayed onto a baseline that has moved.
- **A node serving a session the chain had already ended.** The session was read
  once at startup and never again, so a challenge, a close or a `forceClose`
  went unnoticed: the node kept executing and kept answering with receipts, for
  state the hub would refuse every one of. It now re-reads the delegation every
  five seconds and stops accepting transactions the moment the status leaves
  `Active`. Passing `expiresAt` is only warned about, since expiry does not
  block a commit — it just means anyone *may* force-close.
- **Whole mappings did not work.** A commit names the slots it changed, and for
  a mapping entry the hub re-derives `keccak(key, base)` to check the write
  belongs to a delegated mapping — so the key has to travel with the diff, and
  a slot cannot be inverted to produce one. Nothing recorded the association, so
  the node had no key to send, the derived slot was in no delegated set, and its
  guard refused every such write. That failed loudly, one transaction at a time,
  rather than losing anything; but it meant balances and per-user state were
  simply out of reach. Two things fixed it. The app announces the pair at the
  write, which is one place both halves exist; and the node watches the EVM
  derive the slot, which is the other and needs nothing of the app. Both feed
  the same check, and neither grants anything: the base still has to be one the
  delegation covers. The hub's mapping path had never been exercised by a test
  either, and now is. One gap remains and is documented rather than papered
  over — a key that is a compile-time `constant` has its slot folded into a
  literal by the optimizer, so no derivation happens for the node to see, and
  the write is refused with an error that names that cause.
- **Reentrancy from a hostile app.** Apps are arbitrary contracts and the hub
  calls into them, so every hub entry point that moves money or state is
  single-entry.
- **Writing past the guard.** The first version of `Delegated` wrapped values in
  a struct. Solidity struct members have no visibility, so `score._value = 42`
  compiled and skipped the guard entirely. Values now live at named slots with
  no variable bound to them.
- **The validator naming its own judge.** `Terms.resolver` must be on the
  admin's resolver list and cannot be the validator itself.
- **Free session kill.** A timeout now costs the challenger a slice of its bond,
  paid to the app.
- **Junk delegations eating capacity.** `Terms.delegationFee`.
- **Undefined replay.** A delegation pins `baseBlock` at open and every commit
  carries the `execTimestamp` the node ran under, monotonic and never ahead of
  the chain. A resolver now has an unambiguous reference to replay against.
- **Constructor-only setup.** `_initDelegatable(owner)` can be called from an
  initializer, so an app behind a proxy works.
- **A session key reaching past its scope.** `_actor()` trusted any call
  arriving from the contract itself, so a granted function that called
  `this.other()` handed the granter's identity to a function the grant never
  named. Worse, it was authority the same code path does not have off a
  session, where a self-call resolves `_actor()` to the app: an app tested
  without a grant would never show the difference. The admitted selector is now
  recorded beside the actor and rechecked.

## Known limitations (v1)

1. **Rollback is the diffs the hub applied, not a proof of pre-state.** A
   confirmed slash walks those diffs backwards (`oldValue` written back)
   before the stake is taken. The hub stores its own fold at commit, so the
   list submitted later has to be the list that moved storage, not the
   validator's `stateRoot`. A write after undelegate no longer blocks this:
   that write sat on a fraudulent baseline and is overwritten. What this is
   not: a Merkle proof of the pre-state, or a repair of slots the fold never
   named. That is the next protocol item.
2. **Determinism is pinned at both ends, and a replayer now uses it.** A delegated
   function may read state that is *not* delegated: a config value, a balance
   in another contract, a price. If the node reads it at one moment and a
   resolver replays hours later, they compute different things, and the whole
   challenge mechanism assumes a batch can be replayed and compared. If it
   cannot, nobody can say who is right and the bond protects nothing.

   Solana avoids this because a transaction declares every account it touches up
   front. The EVM does not, so we pin the reference instead. The contract now
   fixes both loose ends:

   - `baseBlock`, recorded when the delegation opens. Every read outside the
     delegated slots is defined to be taken at that block, by node and resolver
     alike.
   - `execTimestamp`, carried in every commit and covered by the signature. It
     may lag the chain but never lead it, and never runs backwards, so a
     validator cannot date a batch into the future to settle time-dependent
     logic in its favour.

   A third reference is the ruleset, and it is now on record too. *What* a batch
   computes depends on the EVM running it, and Monad's is not Ethereum's — the
   gas limit is charged in full without refunds, memory is priced under MIP-3,
   contracts may reach 128KB, and two precompiles exist that mainnet has never
   heard of. A node on mainnet revm and a resolver on Monad's would reach
   different answers on an honest batch, and a resolver with no way to know
   which rules to pick could not tell that apart from cheating.

   A validator declares its ruleset in its terms, `openDelegation` snapshots it
   into the delegation beside `baseBlock`, and a session keeps the rules it
   opened under however the validator upgrades afterwards. `Types.Spec` is an
   enum, so the ABI decoder refuses a value the hub has no name for, and
   `Spec.Unset` is refused on top of that: a validator that never says which
   rules it runs could not be held to any. The node reads the value at boot and
   declines to serve a session it would execute differently.

   One caveat, stated plainly: only one hardfork has a name so far, so no
   mismatch is constructible today and the boot check cannot actually fire yet.
   Its value is not present enforcement but the records — the delegations opened
   now are already unambiguous about their rules, and when a second hardfork
   ships, the sessions predating it do not silently become replayable under the
   new one.

   The node honours both. `PinnedReader` is the only way the node's workspace
   exposes chain state and it has no method taking a block number, so a read at
   head is not something a later change can do by accident; the clock comes from
   the chain rather than from wall time, for the same reason. Tests cover it:
   `a_pinned_reader_never_follows_the_head`,
   `storage_is_read_at_the_pin_and_nowhere_else`.

   The inputs a replay needs now exist and are binding. `interlude-state::txlog`
   keeps every signed transaction of every settled batch, in the order it ran and
   with the clock it ran under, and `Types.Batch.txRoot` folds them under the
   validator's signature — so a log produced later can be held against the batch
   instead of taken on trust. `InterludeHub.isBatchLog` is where that check
   happens, and it is what a challenger establishes before anybody argues about
   what replaying the log produces. Both sides of the fold are pinned to one
   shared vector, because a disagreement about the byte layout would not break a
   commit; it would make every challenge fail against an honest validator.

   The other side of the argument now exists. `interlude-watcher` rebuilds the
   node's starting position from the chain's own record — `baseBlock`, the
   delegated surface, the spec — replays the log under the clock each
   transaction ran with, and hashes the result the way the batcher does. Either
   the roots agree or one party is wrong about arithmetic with a single answer.
   It is the first thing that ever reads `stateRoot`, which the hub had stored
   since the beginning and never looked at.

   The replay is also what makes a challenge admissible. `challenge` no longer
   takes an ignored `bytes` blob; it takes the state root the challenger says
   the batch should have, and the hub refuses a claim equal to the published one
   — objecting to nothing is not a dispute. `resolveChallenge` has to echo that
   same root, so a ruling is on record against a specific number rather than
   against whichever dispute was open, and `challengeOf` hands a third party
   everything needed to redo the work: the batch, both roots, the bond, the
   deadline, with the transactions themselves pinned by `batchTxRoot`.

   Two things this deliberately does not claim. It replays, it does not prove.
   The hub cannot run the EVM, so nothing it could be handed would let it decide
   the case itself — a log would only restate `txRoot`, which is already on
   chain, and a second diff list would only be a second well-formed list. The
   resolver's boolean is still a boolean. What changed is that the question it
   answers is now fixed, public and reproducible, which is where a proof system
   or a bisection game slots in when there is one. And it catches a wrong
   answer, not a withheld one — the next paragraph.

   A validator can no longer publish a root and withhold the fold: `commit`
   takes the entries and reverts unless they hash to `txRoot`. The calldata is
   the publication. `challengeAvailability` remains for a batch committed
   before that, and as an objective timeout if someone still claims the list
   is missing; anyone who has the entries (including from the commit itself)
   posts them with `serveBatchLog`. The signed transaction bytes are a
   different question: those still live on the node's disk, and a replay that
   needs the sender recovered from a signature still asks the node.

   Prices are not covered, and used not to say so. A commit carried a
   `PriceReport[]` under the validator's signature which the hub never read,
   never stored and never checked, while the node's oracle was a stub that never
   filled it. A signed field nobody verifies is worse than an absent one,
   because it reads as though the hub attests to it, so the field is gone. An
   app whose delegated logic reads a price from outside the delegated set is
   unreplayable today; pinning that needs a real oracle path with on-chain
   validation, which is roadmap.

3. **The guard is enforced, but only for state you route through `Delegated`.**
   A handle is a constant, so there is no storage variable to assign to; the only
   write path carries the guard, and an unregistered slot reverts rather than
   escaping silently. Two holes remain: `delegateRaw` lets an owner delegate
   slots nothing guards, and inline assembly can always `sstore` anywhere. Both
   are deliberate acts by the app's own author, not accidents.

   Ordinary Solidity storage is delegatable now that the node recovers mapping
   preimages by watching `KECCAK256` rather than waiting to be told, so a plain
   `mapping(address => uint256)` no longer has to become a
   `Delegated.MapUint256Slot`. What that does not give you is the guard. Slots
   registered by hand are still refused on the base chain by the hub, but an
   inherited OpenZeppelin `_transfer` carries no `whenNotDelegated`, so nothing
   stops it writing a balance the node also believes it owns. Retrofitting onto
   code you do not control means auditing every write path yourself.
4. **Reads are silently stale.** A contract calling `counter.value()` while the
   counter is delegated gets the last committed snapshot, with no revert. This is
   inherent to the model, since MagicBlock allows base-layer reads too, but it is a
   real hazard for anything that consumes a delegated value as an oracle.
   `Delegated.isStale` exists; nothing forces a caller to check it.
5. **A single resolver, chosen from a curated list.** Better than a validator
   naming its own judge, but it is still one address, and the admin who
   registers it is us. A validator paired with a complacent resolver stays
   unchallengeable. The real fix is a committee with a threshold. Until then an
   app owner should check `termsOf(validator).resolver` before delegating.
6. **Proxy setup is manual.** `_initDelegatable` exists, but an upgradeable app
   must call it *and* re-run every `_registerGlobal` / `_registerPerKey` from
   its initializer, because the registry lives in storage. Forgetting the
   registration is loud (`NotRegistered` on the first write) but forgetting the
   init is quieter: `baseChainId` stays zero, which disables the write guard.
   `_register` rejects that case; nothing else does.
7. **`stateRoot` is recorded, never verified.** No Merkle commitment. `txRoot`
   beside it is now checked: `commit` is handed the entries and refuses a list
   that does not fold to the signed root. The hub still does not see the signed
   bytes, and `isBatchLog` still reads the root back. The distinction is the one
   that retired `PriceReport[]`: a signed field nothing ever reads is worse than
   an absent one.
8. **No validator handover.** Resuming after a node death means `forceClose`,
   then a fresh delegation. A reorg under the pin is the same shape of ending:
   the node snapshots `block_hash(baseBlock)` at boot, re-reads it while it
   serves, and halts (`PinReorged`) without publishing what is pending. The
   hub still only stores the height, so the hash is this process's. Anyone
   else force-closes after silence. A restart does not help: same number,
   different block.
9. **The hub is trusted by every app.** Centralising the logic means a hub bug
   is a bug for everyone. That is the deliberate trade for auditing it once.
10. **Revoking a session key reaches a running session late.**
    `bumpSessionEpoch` lands on the base chain at once, but the node reads
    `sessionEpochOf` at its pinned block, so a delegation already in flight
    keeps honouring grants until the next one moves the pin. The epoch bounds
    every future session; the expiry is what bounds a live one, which is the
    argument for keeping it short.
11. **Censorship is bounded, not prevented.** A validator that keeps committing
    while serving nobody holds the app until the session expires, up to
    `maxDelegationDuration`. The chain cannot tell that apart from a session
    nobody is using: the hub sees the fold (hashes and clocks), not the signed
    bytes users sent. Forced inclusion is the fix and it needs those bytes
    published, which is still roadmap. Meanwhile the app's owner can always
    `closeDelegation`, so this bites hardest on an app whose owner is also gone.
12. **A mapping write has to go through `Delegated`.** The key is recovered from
    an event the setter emits, so state written by hand-rolled assembly, or by
    an older build of the library, produces a slot the node cannot account for
    and refuses. That is the intended failure — committing it would need a key
    nobody has — but it does mean the typed wrappers are not optional for
    mappings the way they nearly are for scalars.

The honest summary: item 2 is what stands between this and a security model
that actually binds, and it is now one step short rather than three. The
reference a replay needs is pinned at both ends, and the inputs exist and are
signed for — so a challenger can establish *what* the validator claimed to
execute. Nothing re-executes it, so nobody can yet establish that the claim was
false. The bond deters misbehaviour rather than proving it until the replayer
lands. Everything else is either a known trade for v1 or a decentralisation
step, not a hole.

## Cost of the guard

A guarded write on Monad costs three extra `SLOAD`s: the base chain id, the
variable's registration, and the partition lock. On the ephemeral node only the
first runs before the guard returns, so the hot path stays hot.
