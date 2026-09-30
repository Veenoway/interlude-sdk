# Security model (optimistic)

Interlude v1 has **no cryptographic fraud proof**. Security rests on money at
risk plus an independent resolver. This document states exactly what is and is
not guaranteed.

> **State of the live deployment, 2026-09-28.** The live hub is v3,
> `0x98922c6E5e4Bea62761C71D2401c7ec2c26eC43e`
> ([DEPLOYMENTS.md](DEPLOYMENTS.md) has every address). Its validator
> (`0xa375CF27eD39491dB8302Ffc3dF4210Ad263eF43`) names a dedicated resolver key,
> `0x3dd6202F995EFbAAA1a0Ddc413e46f72f96E147E`. How it got there: the audit of
> 2026-09-26 found that the hub then live, hub v1
> (`0x3Ef8327F69e09cf721772F345e2A887eA22cD595`), had anvil's third account
> (`0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC`) as its validator's only
> resolver. That key is public, so "an independent resolver" was anybody. The
> same day hub v1's resolver was rotated off anvil
> ([runbooks/rotate-resolver-and-signers.md](runbooks/rotate-resolver-and-signers.md))
> and hub v2 went live with the hub fixes described here
> ([runbooks/deploy-fixed-hub.md](runbooks/deploy-fixed-hub.md)); hub v3
> replaced hub v2 on 2026-09-28 with every one of those fixes and an optional
> lease end. Hub v1 keeps its older bytecode for the partner apps still bound
> to it, and a delegation keeps the judge it opened with
> ([Resolution](#resolution)), so on hub v1 the rotation reaches an app from
> its next delegation. Hubs v1, v2 and v3 all refuse `0x3C44…` as a resolver,
> and the deploy scripts can no longer produce that state (they refuse anvil
> keys off chain 31337). [10-audit-fixes.md](10-audit-fixes.md) says which fix
> is where. Hubs v1, v2 and v3 are deployments; the "v1" in the rest of this
> page is the protocol's first, permissioned phase, which all three belong to.

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
  judges its own fraud and can dismiss every challenge against itself.
- Revoking a validator only closes the door to new delegations. Live sessions
  run to completion on the terms they opened under, so no app is cut off
  mid-flight. The same holds for a revoked resolver: the re-audit found that
  `openDelegation` did not re-check `allowedResolver` (nor the committee
  members), so a validator whose resolver the admin had revoked still sat new
  sessions under it. Fix round 2 makes `openDelegation` re-check them.

## State machine

A delegation covers one `(app, partition)` pair.

| Status | On-chain writes to that partition | Commits | Validator stake |
|---|---|---|---|
| `None` | allowed | n/a | not reserved |
| `Active` | blocked | allowed | reserved |
| `Exiting` | blocked (until `releaseStake`) | blocked | reserved until `stakeUnlockAt`, still challengeable |
| `Challenged` | blocked | blocked | reserved, at risk |

`undelegate` (and the validator's `resignDelegation`, and anyone's
`forceClose`) moves `Active → Exiting`. The session is over, so the hub refuses
further commits, but **the app stays locked**, and the stake stays reserved and
challengeable, for the whole challenge window (`challengeWindow`: at least one
hour, and one hour on the repo's deploy terms), plus any time a dispute kept the
session frozen. Unlocking at exit would let users withdraw on the base chain
against state that a fraud verdict a block later would rewind; keeping the lock
is what lets the unwind restore the app cleanly. It also closes the obvious
attack: commit a fraudulent batch, exit next block, walk away with the money.

After `stakeUnlockAt`, **anyone** may call `releaseStake(app, partition)`. That
call and a confirmed slash are the only two things that unlock the app. The
Hub does not do it on a timer — without the call the delegation stays
`Exiting`, the app stays locked (`DelegatedWritesDisabled` on every guarded
write) and the bond stays reserved. The SDK exposes `client.releaseStake`; a
control keeper can schedule it. Calling early reverts with `StakeStillLocked`.

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

Capacity is finite, so opening a session should not be free:
`Terms.delegationFee` is charged on `openDelegation` and credited to the
validator, and the validator can always close its door with `open = false`.
The fee only helps if it is set. The re-audit of 2026-09-26 found every repo
deploy script and the CLI's local bootstrap publishing `delegationFee = 0`, so a
stranger could fill the default validator's `maxDelegations` with one
throwaway app and `delegateRaw`, then re-squat each hour after a
permissionless `releaseStake`, for the cost of gas. Fix round 2 gives those
terms a non-zero default fee (see [10-audit-fixes.md](10-audit-fixes.md)).
What remains is a *paid* squat: someone willing to pay the fee per slot can
still hold capacity for a challenge window at a time. On a live hub the
operator has to set `delegationFee` and `maxDelegations` to numbers that make
that expensive; nothing in the hub chooses them.

This is the capital-efficient shape: a 10 ETH bond can back ten 1 ETH
delegations at once, and slashing one delegation takes only its own stake. One
bond per delegation would make thousands of ephemeral instances unaffordable.

## Liveness

**Anyone** can call `forceClose` for either of two reasons. The session enters
`Exiting` exactly as after `undelegate`: the app stays locked and the stake
stays reserved through the challenge window, until somebody calls
`releaseStake`.

The first is silence: no commit landed for longer than `maxBatchInterval` plus
a five-minute grace (`LIVENESS_GRACE`, so a commit stuck a few blocks in the
mempool does not cost an honest node its session). That covers a node that
died, which without this plus an absent owner would freeze user funds forever.
(Until branch `fix/audit-critical`, the hub's source only honoured a fixed
seven-day silence, `FORCE_CLOSE_SILENCE`, whatever the terms said; the fixed hub
checks `lastCommitAt + maxBatchInterval + LIVENESS_GRACE` and keeps seven days
as a backstop.) A live but idle node is not silent: it commits an empty batch at least every
min(`maxBatchInterval` / 2, `INTERLUDE_HEARTBEAT_SECS`), and the hub accepts a
batch with no diffs, or with a log and no diffs, as a heartbeat.

The second is age, and only when the validator's terms set a lease end: the
session has run past its `expiresAt` (open + `maxDelegationDuration`), however
alive it looks. Silence is not the only way a node can hold an app hostage. One
that keeps committing on schedule — even empty batches — while refusing to serve
anybody resets the silence clock forever, and there is no way for the chain to
tell that apart from a session nobody is using. Refusing empty commits does not
help: an idle session has nothing to commit, so the empty batch *is* the
heartbeat, and a censoring node could flip one slot back and forth for the same
price. So the bound is on time instead.

A lease end, when set, is capped by the hub at 365 days. Since hub v3 a
validator may also set none (`maxDelegationDuration = 0`, `expiresAt = 0`). The
repo's deploy scripts and the CLI bootstrap advertise none, and neither does
Interlude's validator on the live hub (`maxDelegationDuration` 0; hub v2 capped
the lease at seven days and refused 0): an app owner who wants a node up for
months must not have it closed by a stranger while it works. Such a session ends
when its owner undelegates, its validator resigns, its node goes silent (the
first rule, which stays: `maxBatchInterval` is capped at seven days less the
grace, so a dead node can always be closed by anyone within a week), or a
challenge ends it (a slash, or a timeout while the judges are silent, known
limitation 13); age alone never does. The price is the bound above: with no
lease end, a node that heartbeats while censoring holds the app until its owner
undelegates. In v1 the validator is permissioned and operated by Interlude, so
that is the trust assumption already stated; a validator set that opens up needs
forced inclusion first.

A lease end bounds censorship rather than removing it — worst case, a censoring
node holds an app for one session length. Removing it needs forced inclusion: users
queue a transaction on-chain and the validator is force-closed if it does not
include it. The batch's signed transactions are already published (they are in
the commit calldata); what is missing is the on-chain inclusion queue, so it is
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
`withSession` refuses `applyDelegatedDiffs`, `revertDelegatedDiffs`,
`syncDelegatedSlot`, `onDelegationChanged`, the `delegate*` family,
`undelegate` and itself, whatever a grant says. The self-call arrives with
`msg.sender == address(this)`, so without the block list an app that owns
itself would let a session walk through `onlyOwner` and undelegate.

**Inside a session call, `msg.sender` is the app.** That is the sharp edge of
the design. Anyone can sign an `anyFunction` grant for themselves, so any
function that trusts `msg.sender` runs as the contract: an app that inherits an
OpenZeppelin ERC20 or ERC721 and holds its own tokens could be emptied with a
self-granted `transfer`. On branch `fix/audit-critical` the default block list
therefore also refuses the token-moving family (`transfer`, `transferFrom`,
`approve`, `increase/decreaseAllowance`, `permit`, `setApprovalForAll`, the
`safeTransferFrom` and `safeBatchTransferFrom` variants) and the ownership
functions (`transferOwnership`, `acceptOwnership`, `renounceOwnership`).

The list checks only the outer selector of the call. The re-audit showed what
that costs: an app that also inherits OpenZeppelin's `Multicall` exposes
`multicall(bytes[])`, which delegatecalls the app itself with `msg.sender`
still the app, so `multicall([transfer(thief, all)])` walked past a refused
`transfer`. Fix round 2 adds the self-batchers (`multicall(bytes[])`,
`multicall(uint256,bytes[])`), ERC-1363 (`transferAndCall`,
`transferFromAndCall`, `approveAndCall`), `burn`/`burnFrom`, ERC-4626
`deposit`/`mint`/`withdraw`/`redeem` and ERC-777 `send`/`operatorSend`/
`authorizeOperator` to the defaults. No fixed list can know an app's own
forwarders, though: **any function that forwards arbitrary calldata, or that
calls or delegatecalls the app itself, must be blocked by the app**, by
overriding `_isSessionBlocked` and returning `super`. The rule for app code is
simpler than any list: identify the user with `_actor()`, never `msg.sender`,
and do not let a session reach a function that trusts `msg.sender`.

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
and never the validator itself. The default bench is that one address
(threshold 1). Extra judges and a higher threshold are optional (`setCommittee`)
and are snapshotted when the session opens, so rotating the validator's terms
does not reach a session already open: it has to be re-delegated.

The resolver is an address whose holders decide the leaf of a dispute, helped
by `interlude-watcher`, which re-executes a batch against the pre-state pinned
by `baseBlock` and the clock pinned by `execTimestamp` and says whether it
agrees. Nothing votes automatically. In particular the Chainlink CRE workflow in
`cre/floor-watch` is **monitoring only**: it reads each public floor's
`GET /health` and reaches consensus on the snapshot. It does not replay batches
and it is not a resolver. (An earlier version of this page said otherwise.)

**Answering a challenge (new on branch `fix/audit-critical`).** A challenge
used to be answered by nobody: no code posted `bisect` or `proveStep`, so any
challenge against a hosted session ran into `timeoutBisection`, slashing an
honest validator and unwinding honest state, and the challenger profited. The
node now runs a responder: it watches for `Challenged` on its own delegation,
replays the challenged batch to compute the requested intermediate roots, and
posts `bisect`, `proveStep` or `counterStep`, and `timeoutChallenge` when the
challenger stalls, each well before its move deadline. A node that holds the
validator key posts the moves itself; a hosted node without the key relays
them through control's `POST /disputes/move`, authenticated with the same
per-app machine token as `/commits`, and control checks that a dispute is
actually open before signing. The hub gives every move its own deadline, reset
by each move, and a timeout blames whoever's turn it was.

| Verdict | Validator | Challenger | App |
|---|---|---|---|
| fraud confirmed | loses the reserved stake (on the last page of the unwind) | bond back + 50% of the stake | state unwound, then unlocked; delegation ends; the beneficiary gets the other 50% |
| dismissed | nothing: the bond is burned to `0x…dEaD`, never paid to the validator or the beneficiary | loses their bond | resumes at the same batch; the frozen time is added back to the challenge window |
| judges silent | stake stays reserved: the session enters `Exiting` and can still be challenged until `stakeUnlockAt` | bond back minus `timeoutPenaltyBps` | stays locked until `releaseStake`; the beneficiary receives the penalty |

Inside the bisection, a player who lets its own move clock run out loses on
the spot instead: `timeoutBisection` convicts a validator that stopped
answering, and `timeoutChallenge` burns the bond of a challenger that stopped
picking.

The other 50% of a slashed stake goes to the delegation's beneficiary. Until
branch `fix/audit-critical` that was the app's **owner**, which for an app
deployed through `ship` was Interlude's own key: the party whose validator had
just been slashed. The fixed `Delegatable` exposes `slashBeneficiary()`, which
defaults to the owner and which the owner can point elsewhere with
`setSlashBeneficiary(address)` (an escrow, a treasury, the app's users).

The beneficiary is **read when the session opens** (`openDelegation` snapshots
it into the delegation), not when the slash happens. `ship --owner` has control
call `setSlashBeneficiary(owner)` before `delegateAll`, which is what makes a
shipped app's payout go to its team. Accepting ownership later does not
redirect a session already open, and neither does a later
`setSlashBeneficiary`: both apply from the next delegation.

**Why a timeout refunds instead of slashing.** If an absent resolver meant an
automatic win, anyone could post a small challenge bond, wait, and collect the
stake. Refunding removes that profit. The cost of an absent resolver is that the
session stops (it enters `Exiting`, the app locked until `releaseStake`), which
is a safe failure rather than a wrong payout.

**Why the refund is not complete.** Nothing was proven, but a live session was
still killed. A full refund would make stalling free and repeatable, so the
challenger forfeits `timeoutPenaltyBps` of its bond (capped at 20%, or honest
challenges become too expensive to bring).

That penalty goes to the **app's side** (the same beneficiary as above), not to
the validator. Paying the validator would give it a reason to arrange the
resolver's silence; paying the app's side means nobody inside the dispute
profits from a timeout, and the party that actually lost its session is the one
compensated. Who that is, concretely, is whoever `slashBeneficiary()` names.

## Fixed

- **Validator escaping with the bond.** The stake now stays reserved through the
  challenge window, including after `undelegate`, and (since branch
  `fix/audit-critical`) the app stays locked with it until `releaseStake`.
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
  schedule while serving nobody held the app forever. A session can now expire
  on time as well: hub v2 required a lease end of at most seven days, and hub v3
  makes it optional, capped at 365 days when set (see "The second is age" above,
  and limitation 11, for what a session with none trades away). (The audit of
  2026-09-26 found the hub's source enforcing neither `maxBatchInterval` nor
  `expiresAt`, only a fixed seven-day silence; branch `fix/audit-critical`
  enforces both.)
- **Found by the audit of 2026-09-26, fixed on branch `fix/audit-critical`**
  (details and status per item in [10-audit-fixes.md](10-audit-fixes.md)): a
  public resolver key on the hub then live (the scripts now refuse anvil keys
  off anvil); a bisection with one global deadline, which let a challenger move
  late and then time the honest validator out; nobody answering challenges;
  unbounded end-of-session loops that could lock an app forever; exits that a
  hostile app could block by reverting in its callback; exits that unlocked the
  app while the stake was still challengeable; unbounded terms; the slash
  paying the app's owner (Interlude, for a shipped app) with no way to redirect
  it; an owner that could never change; `withSession` reaching token-moving
  selectors (extended in fix round 2 to multicall and the ERC-1363, ERC-4626
  and ERC-777 families, see [Session keys](#session-keys)).
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
  paid to the app's beneficiary.
- **Junk delegations eating capacity.** `Terms.delegationFee`, once it is set
  above zero (see [One bond, many delegations](#one-bond-many-delegations): a
  paid squat is still possible).
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

1. **Rollback restores the overlay, not only the unwind list.** A confirmed
   slash walks those diffs backwards (`oldValue` written back) and then writes
   every overlay slot the hub stored — including a slot an earlier honest batch
   owned that the unwind list did not name. `oldValue` of a later commit is
   checked against that overlay, not only against a live `sload`. What this is
   not: a repair of slots the session never wrote.
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
   It is the first thing that ever *replays* `stateRoot`. The hub now checks
   that the posted root is `hashOverlay(diffs)` at commit, so a validator cannot
   sign one tree and apply another. The watcher still has to reproduce the tree
   from the transactions.

   The replay is also what makes a challenge admissible. `challenge` no longer
   takes an ignored `bytes` blob; it takes the state root the challenger says
   the batch should have, and the hub refuses a claim equal to the published one
   — objecting to nothing is not a dispute. `resolveChallenge` has to echo that
   same root, so a ruling is on record against a specific number rather than
   against whichever dispute was open, and `challengeOf` hands a third party
   everything needed to redo the work: the batch, both roots, the bond, the
   deadline, with the transactions themselves pinned by `batchTxRoot`.

   Two things this deliberately does not claim. It replays, it does not prove
   the EVM. The hub bisects the posted log down to one transaction and checks
   overlay algebra for that step; it still cannot re-execute the call. The
   committee's boolean is only for the leaf where both traces are well-formed
   and still disagree — a real execution disagreement, not a vague batch root.
   Silence on a player's clock is derived. And it catches a wrong
   answer, not a withheld one — the next paragraph.

   A validator can no longer publish a root and withhold the fold: `commit`
   takes the entries and reverts unless they hash to `txRoot`. The calldata is
   the publication. The signed EIP-2718 bytes travel in the same call as `raws`,
   checked against each `txHash`. So there is nothing left to withhold:
   `challengeAvailability` is kept only for ABI stability and **always
   reverts** (`LogPublishedAtCommit`, or `NothingToServe` for an empty batch),
   which leaves `serveBatchLog` and `timeoutAvailability` unreachable. A replay
   reads the log and the signed bytes from the commit transaction and needs
   nothing from the node; asking the node is only a convenience.

   Prices are not covered, and used not to say so. A commit carried a
   `PriceReport[]` under the validator's signature which the hub never read,
   never stored and never checked, while the node's oracle was a stub that never
   filled it. A signed field nobody verifies is worse than an absent one,
   because it reads as though the hub attests to it, so the field is gone.
   The print has to travel in the app call: `Tape` takes a signed update as
   calldata, `LazerLocal` checks the signer, and a replay of that tx has the
   same bytes or it is a different batch. Live Pyth Lazer (native fee, signer
   registry) does not fit the node; a partner swaps the parser, not the shape.

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
5. **A resolver committee with a threshold.** Default is still one judge
   (`Terms.resolver`, threshold 1). A validator can publish extras with
   `setCommittee` and a number that must agree; live sessions keep the bench they
   opened under. The verdict is still a vote, not a derived proof. The admin
   who lists resolvers is still us. An app owner should check `committeeOf`
   and `termsOf(validator).resolver` before delegating.
6. **Proxy setup is manual.** `_initDelegatable` exists, but an upgradeable app
   must call it *and* re-run every `_registerGlobal` / `_registerPerKey` from
   its initializer, because the registry lives in storage. Forgetting the
   registration is loud (`NotRegistered` on the first write) but forgetting the
   init is quieter: `baseChainId` stays zero, which disables the write guard.
   `_register` rejects that case; nothing else does.
7. **`stateRoot` is the Merkle of the batch's post-state.** `commit` refuses a
   root that is not `hashOverlay(diffs)`. The hub also keeps an overlay of every
   slot it has applied: a later batch's `oldValue` must match that overlay, and a
   confirmed slash restores overlay slots the unwind list did not name. What this
   is not: a proof of slots the session never wrote. (The signed transaction
   bytes are in the commit calldata, checked against the log.)
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
11. **Censorship is bounded only by a lease end, and not prevented.** A
    validator that keeps committing while serving nobody holds the app until the
    session expires, up to `maxDelegationDuration` when the terms set one. With
    no lease end (`maxDelegationDuration = 0`, what the repo's deploy scripts and
    the CLI bootstrap advertise since hub v3) it holds the app until the owner
    undelegates. The chain cannot tell that apart from a session
    nobody is using: a transaction that never reached a batch leaves no trace
    on chain. Forced inclusion is the fix; the signed bytes of every committed
    transaction are already in the commit calldata, and what is still roadmap
    is the on-chain queue a user would post to. Meanwhile the app's owner can
    always `closeDelegation`, so this bites hardest on an app whose owner is
    also gone.
12. **A mapping entry the EVM never hashes cannot be committed.** The node
    learns a mapping entry's key by watching the `KECCAK256` that derives its
    slot (and still takes the key `DelegatedLayout` announces), so a plain
    `mapping` written directly is fine. A slot nothing hashes at run time
    leaves nothing to watch: a Solidity `constant` key, whose hash the
    optimizer folds into a literal, or a slot worked out off chain and written
    by hand-rolled assembly. The node refuses that write rather than commit a
    diff with no key, which is the intended failure, since the hub checks
    every mapping diff against its key. Make such a key `immutable`
    (`packages/contracts/src/examples/Purse.sol` holds that property in its
    tests).
13. **Silent judges end a session.** If the judges do not vote on a disputed
    leaf within `resolutionWindow`, `timeoutChallenge` moves an `Active` session
    to `Exiting`, or adds the frozen time to an `Exiting` one's `stakeUnlockAt`,
    and pays `timeoutPenaltyBps` of the challenger's bond to the beneficiary.
    Repeated on an exiting session, that keeps the app locked for as long as the
    judges stay silent, and the penalty costs nothing to a challenger who is
    also the beneficiary. A running resolver is what prevents it. The cheap
    version is closed: a batch with no transactions (a heartbeat) went straight
    to the vote, so with silent judges a challenge on one ended a live session
    for the price of the penalty. Since hub v2, `challenge` refuses a batch with
    no transactions (`NothingDisputed`, `test/HubDispute.t.sol`), so a challenge
    has to name a batch with transactions and play the bisection down to one
    first.
14. **Per-batch views follow batch numbers, which restart every epoch.**
    `batchRoot`, `batchTxRoot`, `batchDiffRoot`, `batchTxCount` and
    `isBatchLog` are keyed by `(app, partition, batchIndex)`. Until hub v2,
    right after a re-delegation they answered for batches the new session had
    not committed yet with the previous session's values. Since hub v2 they
    answer zero (false) for any index above the latest session's `batchIndex`
    (`test/HubEpochViews.t.sol`). A reader following one app across epochs
    still binds to `sessionOf().epoch`, since the same index names a different
    batch in each.
The honest summary: item 2 is what stands between this and a security model
that actually binds. The reference a replay needs is pinned at both ends, the
inputs are on chain and signed for, `interlude-watcher` replays a batch and the
node's responder plays the bisection down to one transaction. What the hub
still cannot do is re-execute that one transaction, so the last step of a
genuine disagreement is a vote by the judges, and the bond deters rather than
proves at that step. Everything else is either a known trade for v1 or a
decentralisation step, not a hole.

## Cost of the guard

A guarded write on Monad costs three extra `SLOAD`s: the base chain id, the
variable's registration, and the partition lock. On the ephemeral node only the
first runs before the guard returns, so the hot path stays hot.
