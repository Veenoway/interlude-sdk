# Runbook: take the live hub's disputes and prices off public keys

Written after the audit of 2026-09-26 (finding CP-C2, top-15 #1; CP-H7 for the printers). Nobody
has run it yet. Read it end to end before sending anything, and do it with the demo quiet.

## What is wrong, and how to see it yourself

The live hub's default validator names **anvil's third account** as its resolver, with an empty
committee and a threshold of one:

```sh
HUB=0x3Ef8327F69e09cf721772F345e2A887eA22cD595
RPC=https://testnet-rpc.monad.xyz
TERMS_T='(address,uint8,uint256,uint256,uint256,uint64,uint64,uint64,uint64,uint32,uint32,uint16,bool)'

VALIDATOR=$(cast call $HUB 'defaultValidator()(address)' --rpc-url $RPC)   # 0xB28E6848…d691
cast call $HUB "termsOf(address)($TERMS_T)" $VALIDATOR --rpc-url $RPC    # first field: 0x3C44…93BC
cast call $HUB 'committeeOf(address)(address[],uint8)' $VALIDATOR --rpc-url $RPC   # [] 1
```

`0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` is derived from a private key printed in anvil's
banner and in every Foundry tutorial. Whoever holds it decides every dispute that reaches a vote:
they can slash an honest validator and unwind honest state, or clear a dishonest one. It got
there because the deploy scripts defaulted `RESOLVER` to it and nobody set the variable. The
scripts no longer do that (`packages/contracts/script/lib/Keys.sol`, `scripts/lib/guard.sh`):
off chain 31337 they refuse any of anvil's ten accounts as admin, validator, resolver or price
signer, and require each one explicitly.

The price printers have the same problem in a smaller way. `LazerLocal` pins its signer at
construction, and the Monad deploys of Tape and GridBet defaulted that signer to anvil #9. A
public printer key means anyone can sign the price a fill or a mark settles at.

## Before you start

- **Choose the new resolver.** A multisig is right (a Safe with two or three signers who are not
  the validator's operators). An EOA whose key lives offline is acceptable on testnet. It
  must not be the validator, and it must not be any anvil account (the script refuses both).
- **Hold the two keys that sign.** The hub admin (`cast call $HUB 'admin()(address)'`) and the
  validator (`defaultValidator()`). On the live deployment these are the same key. Nothing here
  needs the resolver's own key.
- **Know what rotation does not reach.** A delegation snapshots its resolver and committee when
  it opens. Rotating the validator's terms changes what *new* delegations get; every floor that
  is already open keeps being judged by `0x3C44…` until it is closed and opened again. The
  section "Re-open every floor" is the part that actually protects the live floors.
- **Decide whether you are staying on this hub.** If you are about to cut over to the fixed hub
  ([deploy-fixed-hub.md](deploy-fixed-hub.md)), deploy that one with the new resolver from the
  start and retire the old floors instead of re-opening them. Do step 1 below anyway: it costs
  three transactions and stops anybody opening a *new* delegation on the old hub under a public
  judge.

## 1. Rotate the validator's resolver (three transactions)

Dry run first. It reads the hub, prints the current terms, and prints every call as a `cast`
line with the keys left as `$ADMIN_PK` / `$VALIDATOR_PK`, so the same output can be pasted into a
multisig's transaction builder. It sends nothing.

```sh
HUB=0x3Ef8327F69e09cf721772F345e2A887eA22cD595 \
NEW_RESOLVER=0xYourSafeOrOfflineEOA \
  scripts/rotate-resolver.sh
```

What it prints, in the only order the hub accepts:

1. **admin** `allowResolver(NEW_RESOLVER, true)`: `setTerms` refuses a resolver the hub has not
   listed.
2. **validator** `setTerms(<the current terms, with only the resolver changed>)`. The script
   reads the current terms with `termsOf` and rewrites the first field, so the bond, the stake,
   the windows and `maxDiffsPerCommit` stay exactly as they are. If the committee lists the old
   resolver or any anvil account, it also prints the `setCommittee` to reseat it.
3. **admin** `allowResolver(0x3C44…, false)`: the old address can no longer be put into new
   terms or a new committee.

Then send it, with keys in the environment (never on argv; the script hands them to
`script/RotateResolver.s.sol`, which checks the terms took before returning):

```sh
HUB=0x3Ef8327F69e09cf721772F345e2A887eA22cD595 \
NEW_RESOLVER=0xYourSafeOrOfflineEOA \
ADMIN_PK=... VALIDATOR_PK=... \
  scripts/rotate-resolver.sh --execute
```

`VALIDATOR_PK` defaults to `ADMIN_PK`. `MONAD_RPC` overrides the RPC. The script refuses an
`ADMIN_PK` that is not the hub's admin or a `VALIDATOR_PK` that is not the validator, so a wrong
key fails before it spends anything.

### Checks (they only read)

```sh
cast call $HUB "termsOf(address)($TERMS_T)" $VALIDATOR --rpc-url $RPC
#   first field is NEW_RESOLVER; every other field unchanged from the dry run
cast call $HUB 'allowedResolver(address)(bool)' $NEW_RESOLVER --rpc-url $RPC            # true
cast call $HUB 'allowedResolver(address)(bool)' 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC --rpc-url $RPC   # false
cast call $HUB 'committeeOf(address)(address[],uint8)' $VALIDATOR --rpc-url $RPC       # no anvil account
```

## 2. Re-open every floor (this is what protects them)

For each app on the hub, the resolver it is judged by is the second field of its session:

```sh
SESSION_T='(address,address,uint8,uint8,uint256,uint256,uint64,uint64,uint64,uint64,uint64,uint32)'
GLOBAL=0x0000000000000000000000000000000000000000000000000000000000000000
cast call $HUB "sessionOf(address,bytes32)($SESSION_T)" <app> $GLOBAL --rpc-url $RPC
```

The floors are the eight public Rooms in the README, the lab Room, and any partner app `ship`
deployed (control's app list). Each one still showing `0x3C44…` needs a new epoch:

1. **owner** `undelegate(GLOBAL)` on the app. The partition enters `Exiting`; the stake stays
   reserved for the challenge window (3600 s under the deployed terms).
2. Wait out `stakeUnlockAt`, then **anyone** `releaseStake(app, GLOBAL)` on the hub. Before that
   it reverts with `StakeStillLocked`.
3. **owner** `delegateAll()` on the app. The new delegation snapshots the rotated terms.
4. Restart that floor's node so it pins the new epoch: `fly machine restart` on the floor's Fly
   app (`floor-<region>`), a redeploy for the Railway Paris node, or control's lab route for the
   lab. The node reads the delegation at boot.

This is what control's lab "new epoch" button already does in one go (`packages/control/src/lab.ts`,
`epochLab`), so for the lab that button is the procedure. For the public floors it is the same
three calls from the floor owner's key, one floor at a time, so only one world is closed at once.
Stop the floor's node first (SIGTERM publishes a closing batch), then undelegate. Once the
session is `Exiting` the hub refuses commits, so anything the node had not committed when
`undelegate` lands is lost for good; stopping the node first is what makes it zero. The Room
keeps its committed state on Monad.

On the live hub (the previous bytecode) the Room unlocks at `undelegate`. On the fixed hub it
does not: the app stays locked from `undelegate` until `releaseStake`, so a floor is unplayable
for the whole challenge window (about an hour on the deployed terms). Schedule it.

Check each floor afterwards: the `sessionOf` line above must show the new resolver in the second
field and a higher epoch in the fifth.

## 3. The price printers (Tape, GridBet / Kandle)

`LazerLocal`'s signer is immutable, so a printer cannot be rotated in place. A new printer key
means a new `LazerLocal` and a new app that points at it:

- **GridBet (Kandle).** Generate a fresh printer key that is not the validator and not an anvil
  account, then redeploy LazerLocal + GridBet with `scripts/gridbet-monad.sh` (`LAZER_PK` set
  explicitly). Point Kandle at the new app (`NEXT_PUBLIC_INTERLUDE_GRIDBET`, its node, and
  `INTERLUDE_LAZER_KEY` for the printer route) and open its node. The contract rules, the
  maximum print age and the operator checklist live in [`apps/kandle/GRIDBET.md`](../../apps/kandle/GRIDBET.md),
  which the Kandle contract stream maintains. Do not reuse the old GridBet: its signer is anvil
  #9 forever.
- **Tape.** `DeployTape.s.sol` now requires `LAZER_PK` off chain 31337 and defaults the maximum
  print age to 10 s (`LAZER_MAX_AGE`). Redeploy the same way if a Tape floor is live on Monad.

Checks: `cast call <lazerLocal> 'signer()(address)' --rpc-url $RPC` returns the new printer
address, `maxAge()(uint64)` is seconds rather than an hour, and the app's constructor argument
names that `LazerLocal`.

## 4. After

- Put the new resolver's address in the README's live table and in the demo's environment if it
  is pinned there (`NEXT_PUBLIC_INTERLUDE_RESOLVER`; unset, the demo reads it from the hub).
- Re-run the three reads in "What is wrong" and keep the output with the date, the way the audit
  did, so the fix is checkable by somebody who was not there.
- If a dispute is ever opened on a floor, the resolver's operators need
  `docs/04-security.md` ("Resolution") and the hub address; nothing else in this repository acts
  as the resolver for them.

## Rolling back

There is nothing to roll back to: `0x3C44…` is not a state worth returning to. If the new
resolver's key is lost, rotate again to another address with the same script; open delegations
keep whichever resolver they were opened under, so re-open the floors again afterwards.
