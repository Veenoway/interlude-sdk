# Runbook: deploy the fixed hub and move every floor onto it

The hub is immutable and every app binds its hub in the constructor (`Delegatable.hub` is
immutable), so the audit fixes to `InterludeHub` and `Delegatable` reach the demo only through new
deployments: a new hub, and a new contract for every floor that should run on it. This is the
order that keeps the demo up while that happens, and how to go back.

Nobody has run it yet. Nothing in it is automatic: each step prints what to paste next, and you
check before moving on.

**The rule that governs everything below: keep the old hub and its floors live until the new
floors are verified.** The demo, the README and the site point at the old addresses until step 6.

## 0. Preconditions

- `fix/audit-critical` has every stream merged and is green: `forge test`,
  `cargo test --workspace --locked` in `packages/node`, the TypeScript suites, and the laptop
  demos (`INTERLUDE_SMOKE=1 scripts/room-demo.sh`, `tap-demo.sh`, `chips-demo.sh`,
  `tape-demo.sh`, and `scripts/dispute-e2e.sh honest|relay|dishonest`). The CI workflows in
  `.github/workflows` run the suites; the laptop demos and `dispute-e2e.sh` are run by hand.
- `forge build --sizes`: `InterludeHub` is under Monad's 128 KB. It is over EIP-170's 24 KB,
  which is why every forge command below passes `--disable-code-size-limit` (the scripts already
  do).
- **Keys, one per job** (audit CP-H1). Until now one key was hub admin, validator, deployer,
  owner of every app and slash beneficiary. For the new hub:
  - `ADMIN_PK`: the hub admin. Lists validators and resolvers. Keep it off every server.
  - `VALIDATOR_PK`: signs commits. Lives on control / the Railway node as today
    (`INTERLUDE_VALIDATOR_KEY_FILE` preferred).
  - `RESOLVER`: an address, ideally a multisig ([rotate-resolver-and-signers.md](rotate-resolver-and-signers.md)
    explains why it matters). Not the validator.
  - Printer keys for Tape / GridBet: fresh, not the validator.

  None of them may be an anvil account: the deploy scripts refuse them off chain 31337
  (`packages/contracts/script/lib/Keys.sol`, `scripts/lib/guard.sh`), and require each one to be
  set.
- A funded deployer. `room-monad.sh` checks the balance before it broadcasts.
- Images built from this branch: the node image (`packages/node/Dockerfile`) that `FLY_IMAGE`
  will name, and control.

## 1. Deploy the hub and the Paris Room

The shortest path, one key as admin and validator (what the live deployment does today):

```sh
MONAD_KEY=0x...  RESOLVER=0xYourSafe  scripts/cutover-monad.sh
```

It always deploys a **new** hub (it unsets `HUB`), bonds the validator with the testnet terms,
opens the Paris Room, checks the hub has the current `commit`, `bisect` and `hashDiffs`, and
prints every address to paste. Its forge log is kept in a private run directory whose path it
prints.

The validator it registers is sized for the whole public fleet on this one hub, so nothing has to
be topped up before step 3:

| Variable | Default | What it sets |
| --- | --- | --- |
| `STAKE_WEI` | 0.1 MON | `stakePerDelegation`: what each floor reserves from the bond |
| `MAX_DELEGATIONS` | 32 | `maxDelegations`: floors the validator holds at once (8 Rooms, lab, salon, GridBet, Tape, Tap books, margin) |
| `BOND_WEI` | `STAKE_WEI * MAX_DELEGATIONS` = 3.2 MON | the validator's bond; floor N+1 reverts `StakeTooLow` once N stakes use it up |
| `DELEGATION_FEE_WEI` | 0.01 MON | `delegationFee`, paid by every open |
| `CHALLENGE_BOND_WEI` | 0.5 MON | `challengeBond`, kept inside the hub's `STAKE_WEI / 100 .. STAKE_WEI * 10` |

The wallet check counts the real gas limits Monad charges (about 36.8M for this run, so plan on
`38M x gas price + BOND_WEI + DELEGATION_FEE_WEI`: about 7.1 MON at 102 gwei). A smaller
`BOND_WEI` is accepted with a warning naming the first floor that would revert.

To separate the admin from the validator, run the forge script directly instead (same checks
afterwards):

```sh
cd packages/contracts
ADMIN_PK=0x... VALIDATOR_PK=0x... RESOLVER=0xYourSafe \
BOND_WEI=3200000000000000000 STAKE_WEI=100000000000000000 MAX_DELEGATIONS=32 \
  forge script script/DeployRoom.s.sol:DeployRoom --rpc-url https://testnet-rpc.monad.xyz \
  --broadcast --slow --gas-estimate-multiplier 250 --disable-code-size-limit
```

(Set `BOND_WEI` explicitly here: the forge script's own default is the laptop's 10 of the native
token.)

Check:

```sh
NEW_HUB=0x...   # printed
TERMS_T='(address,uint8,uint256,uint256,uint256,uint64,uint64,uint64,uint64,uint32,uint32,uint16,bool)'
cast call $NEW_HUB "termsOf(address)($TERMS_T)" $(cast call $NEW_HUB 'defaultValidator()(address)' --rpc-url $RPC) --rpc-url $RPC
#   first field is your RESOLVER, not 0x3C44…
cast call $NEW_HUB 'admin()(address)' --rpc-url $RPC
#   fifth field (delegationFee) is not 0, and the twelfth (maxDelegations) is what you meant
```

A `delegationFee` of zero lets a stranger fill the validator's `maxDelegations` with one throwaway
app for the cost of gas and re-squat it every challenge window (re-audit of 2026-09-26). Fix
round 2 gives the deploy scripts a non-zero default fee; check it, and pick the fee and
`maxDelegations` for the live hub deliberately (`setTerms`), because a squatter willing to pay the
fee can still hold capacity. The fee only raises the price.

## 2. Point the operators at it (old floors keep running)

- **Control**: set `INTERLUDE_HUB=<new hub>` and redeploy control from this branch, with the new
  environment it reads (see `packages/control/README.md`; for the lab, `LAB_VALIDATOR_KEY` so
  the dishonest lab no longer shares the production bond). From now on `ship` deploys against the
  new hub. Partners who shipped before keep their old app on the old hub until they `ship` again.
  `packages/control/fly.toml` now mounts a volume at `/data` for `CONTROL_STATE_FILE` (the app
  registry, the watcher checkpoint, GC marks). Before the first deploy with it:
  `fly volumes create control_state --region cdg --size 1 --app interlude-control`; after it, once:
  `fly ssh console --app interlude-control -C "chown 1000:1000 /data"` (the image runs as `node`,
  a new volume belongs to root). Keep the app at one machine.
- **Paris node (Railway)**: a *second* service first, not the existing one. Create it from the
  same image with `INTERLUDE_HUB=<new hub>`, `INTERLUDE_APP=<new Paris Room>` and its own volume.
  The existing service keeps serving the old Room. `.railway/railway.ts` describes the variables.

## 3. The other Room floors, the lab, the salon

Seven Fly floors, one new Room each, on the new hub:

```sh
fly auth login
HUB=<new hub> REGIONS="us ny asia sa tokyo mumbai africa" MONAD_KEY=0x... \
  scripts/open-public-floors.sh
```

`fly-floor.sh` (called for each region) rewrites the `floor-<region>` app's `INTERLUDE_HUB` and
`INTERLUDE_APP`, so **that floor's node switches at that moment**. To keep the old floor up while
the new one is checked, run it for one region at a time and verify each (step 4) before the next.
Floors refuse to open while the new hub's validator names an anvil resolver, which step 1 made
impossible. Before it spends anything, `open-public-floors.sh` reads the validator's free bond and
refuses a `REGIONS` list it cannot cover (it prints the `depositBond` call to make), and checks
the wallet can pay about 17.5M gas plus the fee per floor.

- **Lab**: `HUB=<new hub> MONAD_KEY=0x... scripts/open-lab-floor.sh`. It deploys from a temporary
  copy of `packages/node/fly.lab.toml` with `INTERLUDE_HUB`, `INTERLUDE_APP` and
  `INTERLUDE_COMMIT_URL` set for this run, and leaves the tracked file alone; it prints the three
  lines to paste into it (with `public-floors.ts` and `floors.ts`, step 5). It also prints the
  command that deploys the lab's verdict watcher (`packages/node/fly.watcher.toml`, image
  `packages/node/Dockerfile.watcher`) on the new hub and Room; the demo's
  `INTERLUDE_WATCHER_URL` is `https://interlude-watcher-lab.fly.dev`.
- **Salon (house)**: redeploy a Room on the new hub (`DeployRoom` with `HUB=<new hub>`), serve it
  through control (`interlude sessions create <app> --signature 0x…`, signed by the Room's owner
  over the message the CLI prints; control only provisions apps it deployed or whose owner opted
  in), and set `NEXT_PUBLIC_INTERLUDE_MATCH_APP` /
  `NEXT_PUBLIC_INTERLUDE_MATCH_NODE` on the demo.
- **Tap books**: re-`ship` TapBook per region from `packages/contracts` with the Tap config
  (`interlude.tap.toml`) and `--region`, now that control points at the new hub. `DeployTapBook`
  (and `DeployChips`) are the laptop equivalents: they always build a hub of their own, with
  `BOND_WEI` / `STAKE_WEI` (default 10 and 2, the laptop's numbers), so they are not the way onto
  the new hub. Set `NEXT_PUBLIC_INTERLUDE_TAP_<REGION>[_NODE]` on the demo.
- **Tape** (only if a Tape floor is live): `DeployTape` attaches to `HUB` like `DeployGridBet`: it
  refuses a hub whose validator names an anvil resolver, deploys LazerLocal + Tape against it and
  forwards the validator's `delegationFee` (about 10.5M gas, no bond). Without `HUB` it builds a
  hub of its own.

  ```sh
  cd packages/contracts
  HUB=<new hub> ADMIN_PK=0x... LAZER_PK=0x<fresh printer> \
    forge script script/DeployTape.s.sol:DeployTape --rpc-url https://testnet-rpc.monad.xyz \
    --broadcast --slow --gas-estimate-multiplier 250 --disable-code-size-limit
  ```

  `STAKE_WEI` is only the Tape's own floor on this path and defaults to the validator's stake.
- **GridBet / Kandle**: `scripts/gridbet-monad.sh` with `HUB=<new hub>` and a fresh `LAZER_PK`
  (anybody may mark the table: kandle-feed's keeper marks it while anybody plays, the pages as a
  fallback, and needs no role on it); the contract rules and the printer checklist are in
  [`apps/kandle/GRIDBET.md`](../../apps/kandle/GRIDBET.md), the GridBet v3 cutover order in
  [`docs/v3-release.md`](../v3-release.md).
  It writes Kandle's production values, printer key included, to `.interlude/gridbet-monad.env`
  (git-ignored, mode 600; `GRIDBET_ENV_FILE` moves it) and prints only the Vercel variable
  names. It does not touch `apps/kandle/.env.local`, which a local Kandle dev server reads.

## 4. Verify each new floor before anything public points at it

For each app:

```sh
SESSION_T='(address,address,uint8,uint8,uint256,uint256,uint64,uint64,uint64,uint64,uint64,uint32)'
GLOBAL=0x0000000000000000000000000000000000000000000000000000000000000000
cast call $NEW_HUB "sessionOf(address,bytes32)($SESSION_T)" <app> $GLOBAL --rpc-url $RPC
#   validator = yours, resolver = yours, status 1 (Active)
curl -s https://<node>/health          # halted:false, base.ok:true
npx @interludelayer-sdk/cli status <app> --rpc https://testnet-rpc.monad.xyz --node https://<node>
```

Then play it: two browsers on the demo with `?node=` / the floor's env set on a preview
deployment, a few moves, and wait for a commit hash on the explorer. A floor is verified when a
batch it served has landed on the new hub. An idle floor should also show periodic empty commits
(heartbeats), which is what keeps `forceClose` from firing on a live idle session.

## 5. Switch the public pointers

Only now:

- Vercel (demo): `NEXT_PUBLIC_INTERLUDE_HUB`, the `NEXT_PUBLIC_INTERLUDE_ROOM_*` pairs, the lab,
  salon, Tap and Tape pairs; Kandle: the GridBet pair and `INTERLUDE_LAZER_KEY`. Redeploy.
- DNS: `rpc.interludelayer.xyz` to the new Railway service (or swap the services' domains).
- In git, one commit: `README.md` live table, `apps/demo/lib/floors.ts`, `lib/tap-floors.ts`,
  `lib/match.ts`, `apps/web/shared/content/content.ts`, `packages/control/src/public-floors.ts`,
  `packages/sdk/src/near.ts`, `.railway/railway.ts`, `cre/floor-watch/config.*.json`,
  `INTERLUDE_HUB` / `INTERLUDE_APP` in `packages/node/fly.lab.toml` and
  `packages/node/fly.watcher.toml` and `INTERLUDE_HUB` in `packages/control/fly.toml`, and the
  scripts' `HUB` defaults (`open-public-floors.sh`, `open-lab-floor.sh`, `fly-floor.sh`).
  `grep -rn 0x3Ef8327F` must come back empty outside `docs/`.

## 6. Retire the old floors

After a day on the new hub with nothing reverted:

1. Stop each old node with SIGTERM (it publishes a closing batch before exiting).
2. As each old Room's owner: `undelegate(GLOBAL)` on the old Room.
3. After the challenge window, anyone: `releaseStake(<old room>, GLOBAL)` on the **old** hub.
   (The old hub unlocks a Room at `undelegate`; on the new hub a Room stays locked until this
   call, so the same step there is what hands it back to Monad.)
4. `cast call <old hub> 'sessionOf(...)' <old room> $GLOBAL` shows it closed. Delete the old
   Railway service and any Fly apps that only served old addresses.

The old hub keeps its resolver problem for as long as anything is delegated on it, so do not
leave old floors open "just in case": either retire them, or rotate and re-open them
([rotate-resolver-and-signers.md](rotate-resolver-and-signers.md)).

## Rolling back

Until step 5, rolling back is doing nothing: the public pointers still name the old hub and old
floors, which never stopped. Stop the new services if they cost money.

After step 5, revert the pointer commit and the Vercel / DNS variables to the values saved before
step 5 (write them down first: `vercel env ls`, the Railway variables, the Fly `INTERLUDE_APP` of
each floor). A Fly floor switched in step 3 is switched back by running
`HUB=0x3Ef8327F69e09cf721772F345e2A887eA22cD595 scripts/fly-floor.sh <region> <old room>`. The old
floors work as before as long as step 6 has not run on them. Once an old floor is undelegated,
going back to it means `delegateAll()` again from its owner (a new epoch on the old hub, under its
old resolver), which is exactly the state this runbook exists to leave.
