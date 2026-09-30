# Audit of 2026-09-26: what was fixed, and where

The audit is `docs/audit/2026-09-26-audit.md` (French). Branch `fix/audit-critical` answers it in
two passes. The first ran one workstream per area. An independent re-audit of the merged branch
then checked every claim and found what the first pass missed. The second pass (**fix round 2**)
closes what the re-audit confirmed. This table is the index: one row per finding, its status, and
where the fix lives. Each row is written so it can be checked.

**Nothing below reaches Monad testnet just by being merged.** The hub is immutable and every app
binds its hub at construction, so hub and `Delegatable` fixes reach the chain only through a new hub
([runbooks/deploy-fixed-hub.md](runbooks/deploy-fixed-hub.md)). They went live with hub v2
(`0x62323Dab1B383878C9e9B042664cd43d9c2179c9`, 2026-09-26, its resolver a dedicated key) and are all
in hub v3 (`0x98922c6E5e4Bea62761C71D2401c7ec2c26eC43e`), which replaced v2 on 2026-09-28 and also
makes the lease end optional ([DEPLOYMENTS.md](DEPLOYMENTS.md)). The resolver of hub v1, the hub the
audit found live, was rotated off anvil #2 on 2026-09-26
([runbooks/rotate-resolver-and-signers.md](runbooks/rotate-resolver-and-signers.md)). Node, control
and app fixes reach production when those services are redeployed from this branch. The fixed CLI
and SDK (0.2.0) and `create-interlude-app` (0.1.0) are on npm.

Status: **fixed** (done and tested on the branch) · **fixed in round 2** (found or left open by the
re-audit, addressed by the second pass; every round-2 fix was merged and the whole branch re-verified
afterwards: forge 529/529, cargo 357 passed, clippy and fmt clean, sdk/cli/control/starter/demo/Kandle
suites green, and `gridbet-demo --e2e`, `dispute-e2e all` (honest, relay, epoch-2, dishonest),
`sdk-e2e` and the Room smoke test all passing; see `docs/audit/2026-09-26-rapport-final.md`) ·
**partial** (the note says what is missing) · **not done** (the note says why) ·
**documented** (a design limit, stated where a reader will find it).

## Top 15 (audit §2)

| # | Finding | Status | Where / proof |
|---|---|---|---|
| 1 | Live hub resolver is anvil #2 | **fixed** | Scripts can no longer do it: `script/lib/Keys.sol` (keys required, anvil accounts refused off chain 31337, `test/ScriptKeys.t.sol`) and `scripts/lib/guard.sh` (`selftest.sh --chain`). `DeployGridBet`'s `HUB=` path checks the live hub's resolver in round 2. On chain: hub v2 `0x62323Dab…` (2026-09-26) and hub v3 `0x98922c6E…`, live since 2026-09-28, name a dedicated resolver key, and hub v1 `0x3Ef8327F…` had its resolver rotated off anvil #2 on 2026-09-26; all three refuse anvil #2 as a resolver. A delegation keeps the judge it opened with, so on hub v1 the rotation applies from each app's next delegation ([04-security.md](04-security.md)). |
| 2 | Bisection has no per-move clock | **fixed** | Every move resets its own deadline (`_move`, `InterludeHub.sol`), and a timeout blames whoever had the turn (`timeoutBisection` validator, `timeoutChallenge` challenger or judges). `test/HubDispute.t.sol`. |
| 3 | Nobody answers challenges | **fixed**, hosted relay **in round 2** | `interlude-responder`, embedded in `interlude-node`, posts `bisect`/`proveStep`/`timeoutChallenge` itself or through control's `POST /disputes/move` (`packages/control/src/disputes.ts`). `scripts/dispute-e2e.sh honest|relay|dishonest` pass. The re-audit found the relay URL broken for hosted machines (`/commits?app=…` became `/commits?app=…/disputes/move`) and replays failing from epoch 2 on: both fixed in round 2, with an epoch-2 e2e scenario. |
| 4 | `eth_feeHistory` OOM | **fixed** | ≤ 128 blocks, ≤ 100 ascending percentiles (`interlude-rpc/src/api.rs`). |
| 5 | Reverting txs stall a session forever | **fixed** | N-C3: the node commits a non-empty log with zero diffs, which the hub accepts. |
| 6 | Nonces lost on restart | **fixed**, replay side **in round 2** | N-C1: `interlude-state/src/continuity.rs` and the epoch genesis carry nonces across restarts and epochs (`boot.rs` tests). The watcher and responder did not apply the genesis, so a returning sender became unreplayable from epoch 2: round 2. |
| 7 | Unbounded end-of-session loops | **fixed** | Overlay keyed by epoch, so `releaseStake` is O(1); the slash unwind is paged and checked against the stored fold, and pays once on the last page (`test/HubOverlayScale.t.sol`, `HubDispute.t.sol`). |
| 8 | Kandle/Tape price oracle | **partial** | Tape: 10 s max print age, monotonic prints, feed check, the demo printer signs the Hermes price. GridBet: KND-01…05 fixed (strictly monotonic tape, per-slot ranges, next-slot rule). The re-audit's certain win (`LazerLocal` accepts prints 5 s ahead while taps open 2 s ahead) is fixed in round 2. Open: live Hermes needs an API key, and the live GridBet has to be redeployed. |
| 9 | Shipped contract owned by Interlude | **fixed** | `Delegatable` two-step ownership (`test/Ownership.t.sol`); control calls `setSlashBeneficiary(owner)` before `delegateAll` and `transferOwnership(owner)` after it (`packages/control/src/deploy.ts`); cli `ship --owner`, on npm since 0.2.0. The earlier cli 0.1.6 silently ignores `--owner`. |
| 10 | Control signs an RPC-supplied hash | **fixed** | CP-H6: control computes the commit digest locally (`commit.ts`), checked against Solidity. |
| 11 | Operator wallet drainable | **fixed**, setup gas **in round 2** | Gas estimated and capped, per-app and global hourly budgets (`budget.ts`), quotas refunded on a failed simulation, `/api/match` open removed. The re-audit found `/apps` setup calls could spend the global budget: per-request cap in round 2. |
| 12 | Hostile app blocks exits | **fixed** | The unlock callback runs with a bounded gas stipend (`APP_UNLOCK_GAS`) behind a 63/64 pre-check, so a reverting or starving app cannot block an exit (`test/HubHostileApp.t.sol`). |
| 13 | `withSession` acts as the app | **partial**, extended **in round 2** | Token-moving and ownership selectors blocked by default (`Delegatable._isTokenMovement`). The re-audit drained an app through `multicall([transfer])`: round 2 adds `multicall`, ERC-1363, ERC-4626, ERC-777 and `burn`/`burnFrom`. The list checks the outer selector only, so an app must block its own forwarders ([04-security.md](04-security.md#session-keys)). |
| 14 | SDK double execution / poisoned client / `waitSettled` | **fixed** | sdk F5–F28 (unit tests against an in-process fake node). Round 2: a transient `interlude_subscribe` error no longer disables the live feed, and the SDK becomes 0.2.0 (on npm). |
| 15 | Risky showcase (`/da`, fake Tap history, simulated challenge) | **partial** | `/da` is 404 in production unless `NEXT_PUBLIC_ENABLE_DA=1`; the demo's Tap history is real; the demo's Challenge is a **labelled simulation**, not a live dispute (the real path is the responder and the watcher). The web landing still called it the real fraud proof: reworded in round 2. |

## Found by the re-audit

| Finding | Status | Where / proof |
|---|---|---|
| Hosted nodes' dispute relay URL (critical) | **fixed in round 2** | Responder derives `<control>/disputes/move` and keeps the `app` hint (query and `x-interlude-app`); `dispute-e2e.sh` relay mode uses a `?app=` URL. |
| Replay from epoch 2 (critical) | **fixed in round 2** | Watcher and responder apply the epoch genesis before the epoch's first batch; epoch-2 scenario in `dispute-e2e.sh`. The genesis nonces come from the node: they cannot change state, only which signed raws are admissible. |
| Free capacity squat (`delegationFee` 0 everywhere) | **fixed in round 2**, residual documented | Non-zero default fee in the deploy scripts and the CLI's local bootstrap. A squat by someone willing to pay the fee is still possible; the operator sets fee and `maxDelegations` on the live hub ([04-security.md](04-security.md#one-bond-many-delegations)). |
| L-02: revoked resolver still sits new sessions | **fixed in round 2** | `openDelegation` re-checks `allowedResolver` and the committee. |
| TapBook: two free seats freeze the order book | **fixed in round 2** | Resting capacity no longer squattable for free; market sells skip unfillable junk. |
| GridBet duel: harvest order decides, shared tap cap, tie pays the host | **fixed in round 2** | Winner from both fully settled stacks, per-player cap, tie split. |
| `/commits` 16 MiB unauthenticated bodies OOM control | **fixed in round 2** | Bounded pre-auth body reads, the app hint required, floors post `?app=`. |
| `/disputes/move` reads 1 MiB before auth, unthrottled `sessionOf` | **fixed in round 2** | Authenticates on the app hint before the body, smaller cap, per-IP limit. |
| Provisioning allowlist bypass through an attacker's `owner()` | **fixed in round 2** | Only the `/apps` registry, an owner-signed opt-in or an operator allowlist provisions; `interlude sessions create --signature` sends the opt-in. |
| `eth_call` answers a revert as a result | **fixed in round 2** | JSON-RPC error code 3 with the revert bytes; the SDK surfaces it as its typed revert error. |
| Responder direct poster: no timeouts, no replacement; relay duplicates | **fixed in round 2** | The node's timeout client, a replacement path, and a check that the move already landed before resending. |
| Control `execTimestamp` clamp vs the watcher's clock bound (H6) | **fixed in round 2** | Control refuses and the node retries instead of clamping below the node's clock. |
| Starter ships a stale ABI; its guard test skipped in CI | **fixed in round 2** | ABI regenerated from the template contract; CI runs it with forge. |
| `apps/demo` `/api/settlements` amplifies onto the RPC | **fixed in round 2** | App allowlist, cache across ranges, batch range bounded by the hub head. |
| `apps/web` without security headers | **fixed in round 2** | CSP and headers like the demo's. |
| Docs describing the pre-fix hub (exit unlock, bond to validator, availability disputes, COMMIT_SECS, beneficiary) | **fixed in round 2** | README, `docs/00`–`09`, the runbooks and the web docs. |
| Silent judges and a challenge on an empty heartbeat batch | **fixed** (in the hub since v2) | `challenge` refuses a batch with no transactions (`NothingDisputed`, `test/HubDispute.t.sol`). Silent judges on a real leaf still end a session: [04-security.md](04-security.md#known-limitations-v1) item 13. |
| Per-batch views serve the previous epoch's data | **fixed** (in the hub since v2) | The five per-batch views answer zero past the latest session's `batchIndex` (`test/HubEpochViews.t.sol`); [04-security.md](04-security.md#known-limitations-v1) item 14. |
| Unwind budget assumes refunds Monad does not give | **not done** | Low. A long tail of padded batches can cost keepers more than the reward. A keeper fee per page or a cap on batches is the fix. |

## Scripts, deploy scripts, CI

| ID | Finding | Status | Where / proof |
|---|---|---|---|
| CP-C2 | Resolver anvil #2 via script defaults | **fixed** | See top-15 #1. Floors opened on an existing hub refuse a hub whose validator names an anvil account (`Keys._liveResolver`). |
| CP-H7 | Lazer signer = anvil #9 on testnet | **partial** | `DeployTape` and `DeployGridBet` require `LAZER_PK` off 31337. `scripts/gridbet-monad.sh` still passed keys on argv and used a fixed `/tmp` log: fixed in round 2 (`guard.sh`). The on-chain signers change only with a redeploy. |
| M-08 | `vm.envOr(..., anvil key)` in deploy scripts | **fixed** | `Keys.sol` everywhere, `test/ScriptKeys.t.sol`; `DeployGridBet`'s `HUB=` attach path checks the live resolver in round 2. |
| S1, S2, S4, S5, S7 | Keys on argv, fixed `/tmp`, undeclared deps, int64 wei, unguarded `rm -rf` | **fixed**; GridBet scripts **in round 2** | `keyaddr.py`, `make_run_dir`, `require_cmd`, `big`, `safe_wipe` in `scripts/lib/guard.sh`. `gridbet-monad.sh` and `gridbet-demo.sh` did not use them; round 2 ports them. |
| S3, S6 | Swallowed errors, children outliving the script | **fixed** | `scripts/lib/fly.sh`, `kill_tree` (selftest checks a grandchild dies). |
| L-08 | Hub > EIP-170 | **documented** | Hub runtime about 34 KB: under Monad's 128 KB, over a stock anvil's 24 KB, so laptop scripts and the CLI pass `--disable-code-size-limit`. |
| §4.3 / §4.6 CI | No forge, vitest, lint, build, shellcheck in CI; unpinned actions | **fixed**, gaps **in round 2** | `.github/workflows/{contracts,ts,node,scripts}.yml`, actions pinned by SHA. Round 2: clippy blocking, Kandle and demo unit tests, starter tests with forge, node CI on contract changes. |
| CLI-7 (root) | Root `pnpm dev` broken | **fixed** | Root `package.json` runs the CLI from `packages/contracts`; `test:all`. |
| §4.6 Ops | No incident runbooks | **partial** | Rotation and cut-over runbooks exist. Runbooks for an open challenge or a leaked token: not written. |

## Docs versus code (audit §3.4)

| # | Gap | Now says |
|---|---|---|
| 1 | `pragma ^0.8.24` | `^0.8.28`, solc ≥ 0.8.28, Cancun |
| 2 | `init` vendors into `lib/interlude` | True: the cli copies into `lib/interlude`, also from npm (0.2.0) |
| 3 | `args` / `[[setup]]` only used by `dev` | `ship` sends them and control applies them |
| 4 | Revocation immediate | Immediate on Monad; a running node keeps the grants it pinned, and refuses new ones, until the partition is re-delegated |
| 5 | `openSession({ ttl })` | `expirySeconds` |
| 6 | Five floors | Eight |
| 7 | Demo calls `GET /near` | The demo's server picks the floor from the country header |
| 8 | `forceClose` after `maxBatchInterval` | Since hub v2: `maxBatchInterval` + 5 min grace, `expiresAt` when the terms set a lease end (optional since v3), 7 days backstop; nodes heartbeat. Hub v1, where earlier apps still run, closes on `maxBatchInterval` of silence with no grace, or at its lease end ([DEPLOYMENTS.md](DEPLOYMENTS.md#retired)). |
| 9 | "Two doors" | Four hub entry points, named (README, `docs/00`, `docs/02`) |
| 10 | Vault cannot mint | Vault is a stub, `claim()` reverts |
| 11 | Slash goes to the app / harmed users | `slashBeneficiary()`, snapshotted at `openDelegation`; control sets it to the `--owner` before `delegateAll` |
| 12 | `COMMIT_SECS` = 10 | 1 on a standalone node and on the public floors, 10 on the machines control-v2 starts (control's own default is 5, which the previous control uses; control spaces one app's commits ≥ 2 s), 5 under `interlude dev` |
| 13 | No `eth_subscribe`, nothing authorised | `docs/06-rpc.md` method table, limits, `interlude_subscribe` |
| 14 | `read()` is the live state | Live only for delegated slots; the rest at the pin |
| 15 | CRE is the resolver | CRE floor-watch only reads `/health` |
| 16 | "Every call site is typed off your ABI" | True with the SDK's typed `args`/`data` (F10) and `interlude abi` |
| H-03 | Exit unlocks the app | Exit (undelegate, resign, `forceClose`, a judges' timeout) keeps the app locked until `releaseStake` after the challenge window; only that or a slash unlocks it (round 2) |

## By area

| Area | Findings | Status |
|---|---|---|
| Hub + Delegatable | C-01, C-02, H-01…H-05, M-01…M-06, L-03, L-04, L-06, L-09, I-01 | **fixed** (hub stream; `forge test` all green at the time of writing). H-04 extended in round 2 (see #13). M-07: **documented**, no admin escape hatch on purpose (it would be a key that moves every app's state). L-07: **documented**, the validator names each midRoot and a leaf both sides prove goes to the vote. L-02: round 2. L-01 (the owner can `delegateRaw` `Delegatable`'s keccak-derived layout slots outside the reserved range) and L-10 (no on-chain guard on the node's ruleset beyond its boot check): **not done**. |
| Node state | N-C1, N-C3, N-H1, N-H3…N-H5, M1, M2, M5, M9–M12, B2–B5, heartbeat | **fixed**, except: N-H1 **partial** (`eth_call`/`eth_estimateGas` can still read the base chain under the session lock, now bounded by 5 s / 2 s timeouts and fail-fast on 429); a fee-bumped commit pending across a restart may be refused as underpriced once; Railway drain time not set (B5, Fly is done). |
| Node RPC | N-C2, N-H2, N-H7, N-H8, M3, M4, M6–M8, M13, B1, B6, B8 | **fixed** (B1 by node-state). `eth_call` revert answer: round 2. |
| Responder + watcher | CP-C1, N-H6, N-M14, B7 | **fixed** for local keys, floors and epoch 1; hosted relay URL, epoch ≥ 2 replay and poster timeouts in round 2. H6: an out-of-bounds clock that leaves the root unchanged is logged, not a disagreement (documented). |
| Control | CP-H1…H6, CP-M1…M9, L1–L8 | **fixed**: CP-H2, CP-H3, CP-H5, CP-H6, the CP-M group (M1–M8 in the control stream's numbering; the Pyth Lazer token handed to visitors is KND-13, fixed in Kandle), L2, L3, L7, L8. Round 2: CP-H4 allowlist bypass, M4 pre-auth bodies, `/disputes/move` auth, setup gas, execTimestamp refusal, error ABIs. **Partial**: CP-H4 persistence (`packages/control/fly.toml` now mounts a volume for `CONTROL_STATE_FILE`; until the live app is redeployed with it, and the volume chowned to the `node` user, the registry and the watcher checkpoint live in memory), L1 (legacy epoch-less tokens stay accepted by default because floors and the lab still carry them), M7 (base image by tag, not digest), CP-H1 (since hub v2 the validator, `0xa375…eF43`, is a key of its own; the admin, `0xB28E…d691`, still owns the public floors, GridBet and the salon). |
| CLI | CLI-1…CLI-6, P1 commands | **fixed**. Round 2: `sessions create --signature`, `ship --stake`, `ship --again`, non-zero local `delegationFee`. Not done: server-side idempotency of `ship`; `check` verifying `_registerInterludeSurface()`. On npm: 0.2.0. |
| SDK | F5–F17, F20–F28 | **fixed**. F25 (retry a transient subscribe error) and the 0.2.0 version: round 2. F8 node side: **documented**, a running node honours a revoked grant until re-delegation. On npm: 0.2.0. |
| Example contracts | EX-1…EX-14 | **fixed**, with EX-3 non-decreasing (not strict) print times and EX-4 a half-unit minimum notional. TapBook squat: round 2. Tape still lets a player pick among prints held within `maxAge` (low, open). |
| Demo API | S1–S9, B1, B2, B9 | **fixed**. `/api/settlements` amplification: round 2. Shared rate limiting needs Upstash (per instance otherwise). |
| Demo UI | B2–B9, A2, Q1/Q3, claims | **fixed**. The Challenge is a labelled simulation. Not done: Q2 (`components/room.tsx` is still one large file), Q4 (floors listed in four places). |
| Web | #15 `/da`, A1, claims, B9, Q1/Q3/Q4 | **fixed**. Round 2: security headers, landing copy about the Challenge. Not done: written consent for the people quotes (the owner's call). |
| Kandle | KND-01…KND-40 | **fixed** except: KND-02 **partial** (live contract needs a redeploy with a fresh printer), KND-03 certain win and duel fairness **round 2**, KND-06 **partial** (multiplier can slip between click and execution; shown in round 2), KND-11/KND-28 1v1 history **round 2**, KND-19 **documented** (rate limits per instance), KND-25 **partial** (about ten free seats can still lock the house's exposure). Front items from the re-audit (idle tape pause, hidden-tab forfeits, paper ledger leak, recap, render crash): round 2. |
| Starter (`create-interlude-app`) | §3.3 P1 | **fixed** (scaffolds in a path with spaces, forge and web tests). Stale ABI: round 2. On npm: 0.1.0, with cli and sdk 0.2.0; scaffolded from npm, its contract tests (7), web typecheck and build pass. |

## Still open after both passes

- **On chain:** the live hub, v3, is the fixed bytecode with a dedicated resolver key. An app
  shipped on hub v1 keeps that hub's bytecode until it is redeployed against v3 and shipped again;
  while it stays, the resolver rotation reaches it only from its next delegation. Hub v2's nodes
  stopped committing at the v3 cutover, so an app bound to v2 needs the same redeploy.
- **Public mirror:** the site's GitHub links point at `Veenoway/interlude-sdk`, a mirror last
  synced before the audit (its `docs/04-security.md` still describes the pre-fix hub). It needs a
  sync from this branch at the cut-over, with `DEPLOYMENTS.md` added to the pages
  `scripts/sync-mirror.sh` copies, since the mirrored overview, security page and this one link
  to it. `LIMITS.md`, whose only link is to that page, can go with it.
- **Design limits, documented:** the leaf of a dispute is a vote; censorship is bounded by the
  session length, not prevented; one process serves one app; the hub is over EIP-170 (fine on
  Monad).
