# Limits and quotas

Every ceiling a developer can run into between a signed call and a batch on Monad: the number,
where it is set, and what happens past it. Values are the code's defaults (control's in
`packages/control/src/config.ts`) and the deployment settings in this repository (control-v2's
`packages/control/fly.v2.toml`, the floors' `scripts/fly-floor.sh`), with the hub v3 terms read
on chain on 2026-09-28 ([DEPLOYMENTS.md](DEPLOYMENTS.md)).

Two rules of thumb cover most of it. `-32005` (or HTTP 429) is a limit to wait out, and sending
the same signed bytes again later is safe: the nonce stops a transaction from running twice.
"Retry after the next commit" means the open batch has no room yet, and the node has already
waited for a commit before saying so.

## The node's front door

A caller is an IPv4 address, or an IPv6 /64. Hosted nodes and floors run behind Fly with
`INTERLUDE_TRUST_PROXY=1`, so there the caller is the `Fly-Client-IP` Fly's edge writes; a room of
players behind one NAT is one caller. Every JSON-RPC call counts, over HTTP or a WebSocket, and a
batch request spends one token per call in it. `GET /health`, `GET /ready` and `interlude_health`
cost nothing.

| Limit | Value | Setting | Past it |
|---|---|---|---|
| Calls per caller | 6,000 per 10 s, a token bucket that refills continuously | `INTERLUDE_RPC_PER_WINDOW`, `INTERLUDE_RPC_WINDOW_SECS` | Over HTTP, an empty bucket answers HTTP 429 with `Retry-After: 10` before the body is read; a batch request that outruns what is left gets `-32005` on the calls past it. Over a WebSocket, every call past it answers JSON-RPC `-32005` "too many requests from this caller; retry later" with `data.retryAfterSecs` 10 |
| Requests in flight, all callers | 64; a call waits up to 5 s for a slot | fixed | HTTP 503 with `Retry-After: 1`, or `-32005` "too many requests in flight" with `retryAfterSecs` 1 |
| Time per call | 60 s (subscriptions and `interlude_commit` exempt) | fixed | `-32005` "the request took too long and was dropped" |
| Time to send a request | 10 s for the headers, 30 s for the body | fixed | The connection is dropped |
| WebSockets per caller | 64 | `INTERLUDE_WS_PER_CALLER` (`0` disables) | The upgrade answers HTTP 429 with `Retry-After: 5` |
| Open sockets | 1,024 per process; 128 per peer address when no proxy is trusted | fixed | The new socket is closed as soon as it is accepted |
| Subscriptions per WebSocket | 4 | fixed | `-32006` |
| Calls per batch request | 64 | fixed | `-32010` for the whole batch |
| Request body, and one WebSocket message | 512 KiB | fixed | HTTP 413 with `-32007` |
| Response | 16 MiB | fixed | `-32008` |

## Transactions

| Limit | Value | Setting | Past it |
|---|---|---|---|
| Size of one signed transaction | 16 KiB | `INTERLUDE_MAX_TX_BYTES` | `-32000` "this transaction is N bytes; this node accepts at most 16384 per transaction" |
| Transactions per signer | 1,000 per 10 s, 100 a second | `INTERLUDE_TX_PER_SENDER`, `INTERLUDE_TX_SENDER_WINDOW_SECS` | `-32005` "too many transactions from 0x…; retry shortly" |
| Gas one write may sign for | Monad's per-transaction cap (30M) by default | `INTERLUDE_MAX_TX_GAS` lowers it | `-32000` naming the setting, before the signature is even recovered: nothing ran |
| Gas one `eth_call` may burn | 5M | fixed | `-32000` "execution halted: … (a call may spend at most 5000000 gas)" |
| Gas one `eth_estimateGas` may burn | 5M | fixed | Code `3`, "the transaction would not succeed: halted: … (an estimate may spend at most 5000000 gas)" |
| Value | Must be 0 | fixed | `-32000`: the node moves no native value |
| Type | Legacy, 2930 or 1559 | fixed | Blob (4844) and set-code (7702) transactions are refused with `-32000` |
| `eth_getLogs` | 10,000 blocks per query, 10,000 logs per answer | fixed | `-32005` with a message saying to narrow the range |
| `eth_feeHistory` | 128 blocks, 100 ascending percentiles | fixed | Refused rather than allocated |

The SDK signs every call with a 5M gas limit unless the client's `gas` option says otherwise, so
an SDK app meets the read cap's number on writes too.

## Batches

The node holds the open batch to limits that make every batch it seals one Monad will carry,
checked before a transaction joins it. It seals early when any of them reaches three quarters.

| Limit | Value | Setting |
|---|---|---|
| Transactions per batch | 1,024 | `INTERLUDE_MAX_BATCH_TXS` |
| Signed bytes per batch | 192 KiB | `INTERLUDE_MAX_BATCH_RAW_BYTES` |
| Commit calldata | 256 KiB (Monad refuses an encoding past 393,216 bytes) | `INTERLUDE_MAX_BATCH_CALLDATA_BYTES` |
| Modelled commit gas | 20M, and never above the relaying control's cap: 25M on control-v2 (`CONTROL_COMMIT_GAS_CAP`, read from `GET /config` at boot), 8M on a control that reports none | `INTERLUDE_MAX_BATCH_GAS` |
| Slots changed per batch | **233 on every live node**; the terms allow 256 | `maxDiffsPerCommit` in the validator's terms, lowered to what `INTERLUDE_MAX_BATCH_GAS` carries |

The terms allow 256 slots per batch (`maxDiffsPerCommit`, also the hub's own ceiling), but no live
node reaches it. The gas model prices every diff at 80,000 gas, and the node lowers the diff cap
to the most one transaction of the largest admitted size (16 KiB) can write and still fit a batch
under the gas limit, and logs the lowered cap at boot. Under the default 20M that is 233. No floor,
and no node control starts, sets `INTERLUDE_MAX_BATCH_GAS`, so every node in
[DEPLOYMENTS.md](DEPLOYMENTS.md) holds its batches to 233 diffs, and a transaction writing more is
refused naming 233. About 22M (21,863,904 exactly) reaches the full 256 and stays under control-v2's
25M cap.

Past a batch limit there are two answers, and the difference matters:

- **The open batch is full.** `-32000` ending in "retry after the next commit". The node parks the
  call first, for up to 16 tries, each one as soon as a batch settles or at most 2 s after the
  last, and runs it in the next batch when there is room; the refusal only reaches the caller if
  room never comes. Nothing ran and the nonce is free.
- **The transaction could never fit.** "this transaction alone can never be committed", or "this
  transaction alone would write N unique diffs, above maxDiffsPerCommit". No retry changes that:
  split the work into smaller calls.

## Commits

| What | Value | Where |
|---|---|---|
| Commit period, standalone node | 1 s if anything is pending | `INTERLUDE_COMMIT_SECS` |
| Commit period, floors | 1 s | `scripts/fly-floor.sh` |
| Commit period, nodes control-v2 starts (`ship`, GridBet, the salon) | 10 s | `INTERLUDE_COMMIT_SECS` in `fly.v2.toml` (control's own default is 5) |
| Commit period, Interlude Exchange's two books | 2 s | `CONTROL_COMMIT_SECS_BY_APP` in `fly.v2.toml`, and `COMMIT_SECS` in `apps/demo/lib/tap-agents.ts`, which the page assumes |
| Early commit | when the open batch reaches three quarters of any limit | the node |
| Heartbeat, when nothing is pending | every min(`maxBatchInterval` / 2, 900 s): 15 minutes on the live terms | `INTERLUDE_HEARTBEAT_SECS` |
| Force-close by anyone | after `maxBatchInterval` (3600 s) plus a five-minute grace without a commit | hub v3 |

A node refuses to boot with a commit period at or past `maxBatchInterval`. A failed commit is
retried with backoff (1 s, doubling, never past the period). A node that has failed 5 commits in a
row (15 when the relay to control is what fails), or has been failing for half of
`maxBatchInterval` (30 minutes on the live terms), stops accepting writes rather than promise
state it cannot settle: `GET /ready` then answers 503.

## Control

Control relays every hosted node's commits and pays for them, so it rations them. Budgets run
over a rolling hour and count each commit at its gas limit, which is what Monad bills. Partner
apps (everything `ship` or `sessions create` brought, GridBet and the salon) and the public floors
draw on separate gas pools, so spam on a free public Room cannot spend the gas the partners commit
with. The gas budgets book a commit before it is sent, so a commit that would cross one is
refused. The MON ceilings read what receipts have charged, and a commit still waiting for its
receipt counts for nothing yet: the commits already under way when a MON ceiling is crossed still
go through, and later ones are refused. Control sends one app's commits one at a time, so past an
app's own MON ceiling that is one commit at most; past the floors' or the wallet's, which many
apps share, it can be one per app.

Two columns, because they are not the same thing. **control-v2** is the configuration committed
for the hosted control behind `control.interludelayer.xyz`: `packages/control/fly.v2.toml` as of
2026-09-30 (the ceilings sized for the Exchange books' 2 s commits), and the default wherever that
file sets nothing, marked "the default". It is what the next deploy runs, not a reading of the
live machine: the only one of these read back from it is the commit gas cap (`GET /config`
answers `commitGasCap` 25,000,000, [DEPLOYMENTS.md](DEPLOYMENTS.md)). Whether it runs these
ceilings is for the owner to confirm (`GET /admin/spend`, admin token, lists what each app and
pool spent in the hour). **Default** is what `packages/control/src/config.ts` uses when the variable is
unset: what a control you run yourself gets.

| Limit | control-v2 | Default | Setting | Past it |
|---|---|---|---|---|
| Gas per partner app | 6,000,000,000 | 200,000,000 | `CONTROL_APP_GAS_PER_HOUR` | HTTP 429 "this app has spent its gas budget for this hour (C gas)", C the ceiling |
| MON per partner app | 615 MON | none: the gas budget only | `CONTROL_APP_WEI_PER_HOUR` | HTTP 429 "this app has spent its MON budget for this hour" |
| Gas, all partner apps together, and control's own closes and lab transactions (the floors not included) | 16,000,000,000 | 2,000,000,000 | `CONTROL_GLOBAL_GAS_PER_HOUR` | HTTP 429 "the control plane has spent its gas budget for this hour" |
| Gas per public floor (the lab included) | 1,000,000,000 | 1,000,000,000 | `CONTROL_FLOOR_GAS_PER_HOUR` | HTTP 429 "this floor has spent its gas budget for this hour (C gas)", C the ceiling |
| Gas, all floors together | 1,500,000,000 | 1,500,000,000 | `CONTROL_FLOOR_TOTAL_GAS_PER_HOUR` | HTTP 429 "the operator floors have spent their gas budget for this hour" |
| MON, all floors together | 155 MON | none | `CONTROL_FLOOR_TOTAL_WEI_PER_HOUR` | HTTP 429 "the operator floors have spent their MON budget for this hour" |
| MON, everything control books against commits: every commit, floors included, and control's own closes and lab transactions | 1,800 MON | none | `CONTROL_GLOBAL_WEI_PER_HOUR` | HTTP 429 "the control plane has spent its MON budget for this hour" |
| Spacing between a partner app's commits (the floors skip it) | 1 s | 2 s | `CONTROL_MIN_COMMIT_INTERVAL_MS` | HTTP 429 "commits for this app are limited to one every 1000 ms"; the node waits and sends again |
| Commits per app, floors included | 3,600 per hour | 3,600 per hour | `CONTROL_COMMIT_PER_HOUR` | HTTP 429 "too many commits this hour" |
| Gas limit of one commit: the estimate plus 20 %, capped | 25,000,000 | 8,000,000 | `CONTROL_COMMIT_GAS_CAP` (margin: `CONTROL_COMMIT_GAS_MARGIN_PCT`) | HTTP 409 "commit needs N gas, above the C cap", before anything is sent; the node holds its batches under it (above), and a commit control still refuses on it halts the node instead of being retried |
| Diffs and log entries per relayed commit | 256 and 2,048 | the same | fixed | HTTP 400 |
| Balance under which control's `/health` warns | 1,000 MON on the validator and the fee payer; 1 MON on floor-lab's validator, the default | 1 MON each | `CONTROL_MIN_BALANCE_WEI`, `CONTROL_LAB_MIN_BALANCE_WEI` | `/health` answers `degraded` with a warning, still HTTP 200. Nothing is refused |

Every refusal from the first eight rows carries `retryAfterMs` in its body and a `Retry-After`
header: when the oldest spend of that hour leaves the window, or when the spacing is over. Control's
own closes and lab transactions are counted and never refused.

How control-v2's figures hold together, at 102 gwei (the gas price `fly.v2.toml` was sized at; at
another price the MON a gas ceiling stands for moves with it, and the MON ceilings do not): an
app's 6B gas is about 612 MON and the floors' 1.5B about 153, so for one app and for the floors
the gas ceilings bind first, and the MON ones only if gas costs more (above about 102.5 gwei for
an app, 103.3 for the floors). The partners' 16B is about 1,632 MON, and the wallet's 1,800 covers
it with the floors' 155, so at 102 gwei no ceiling of the wallet's binds before the gas ones.
The app ceiling is sized for an Exchange book committing every 2 s: its page's agents stop adding
to a batch that would bill 2.6M, so a book held there for an hour spends about 4.82B, and the
partners' pool holds both books at that bound at once beside Kandle's seven tables and the seven
salons busy (15.11B, [runbooks/tap-books.md](runbooks/tap-books.md), "Budget"). It is a large
ceiling for what the wallet holds (about 10,100 MON on 30/09: five hours at 1,800 an hour before
`/health` warns): what it spends is what is busy, about 395 MON an hour for one book with a
visitor's agents. Deploys are outside all of these, in a book of their own (below).

A node reads a 429 from control as backpressure: it waits what control asks (at most 10 s a time,
up to four times per attempt) and sends again. A budget that stays spent turns into failed
commits, and those count towards the halt above.

`ship` and the other partner routes, per caller (IP) unless stated. Control answers with a
sentence saying which limit refused, and `ship` prints it and stops. `fly.v2.toml` sets none of
these, so control-v2's configuration keeps the defaults below.

| Limit | Value | Setting | Past it |
|---|---|---|---|
| Deploys (`POST /apps`, what `ship` sends) | 5 an hour; 20 an hour for everyone together | `CONTROL_DEPLOY_PER_HOUR`, `CONTROL_DEPLOY_GLOBAL_PER_HOUR` | HTTP 429 |
| Failed deploys (a reverted simulation, a refused request) | 10 an hour | `CONTROL_DEPLOY_FAILURES_PER_HOUR` | HTTP 429 |
| Gas of the deployment | 12M | `CONTROL_DEPLOY_GAS_CAP` | HTTP 422, naming the gas it needs |
| `[[setup]]` calls | 4 per deploy, 4M gas together | `CONTROL_MAX_SETUP_CALLS`, `CONTROL_SETUP_GAS_CAP` | Refused, with the advice to seed the app yourself once you own it |
| Deploy gas | 80M an hour per caller, 400M for everyone: a book of its own, apart from the commit budgets and the MON ceilings | `CONTROL_DEPLOY_GAS_PER_CALLER_PER_HOUR`, `CONTROL_DEPLOY_GAS_PER_HOUR` | HTTP 429 with `retryAfterMs` |
| `/apps` body | 256 KiB | fixed | HTTP 413 |
| Node requests (`POST /sessions`, `interlude sessions create`) | 30 an hour | `CONTROL_SESSION_PER_HOUR` | HTTP 429 |
| Node lookups (`GET /sessions/:app`) | 1,200 an hour | `CONTROL_LOOKUP_PER_HOUR` | HTTP 429 |
| Relayed dispute moves (`POST /disputes/move`) | 600 an hour | `CONTROL_DISPUTE_PER_HOUR` | HTTP 429 |
| Machines, all partners together | 40 live, 20 new an hour; an automatic restart of one app at most every 10 minutes | `CONTROL_MAX_MACHINES`, `CONTROL_PROVISION_PER_HOUR`, `CONTROL_RESTART_COOLDOWN_SECS` | HTTP 503: "hosted capacity is full", or "too many new nodes this hour" |

A deploy that sent nothing (a reverted simulation, a malformed request, a spent budget) is given
back to the first line, and every one of those but the budget counts as a failure.

Nodes the previous control started, for apps on hub v1, still post their commits and dispute moves
to the same domain. control-v2's configuration hands the ones for apps it does not serve to that
control unchanged (`CONTROL_UPSTREAM_URL`, which `fly.v2.toml` sets to
`https://interlude-control.fly.dev`; unset by default, and then they are refused), where that
control's own budgets apply. At most 36,000 forwards an hour per caller
(`CONTROL_FORWARD_PER_HOUR`; past it HTTP 429 with `Retry-After: 60`) and 8 in flight for everyone
(`CONTROL_FORWARD_SLOTS`; past it HTTP 503 with `Retry-After: 1`), the defaults, which
`fly.v2.toml` keeps.

## What the SDK does with them

`session.send` never signs a call twice. Every refusal below left the nonce unused, and a retry
resends the same signed bytes.

| The node answered | The SDK |
|---|---|
| `-32005` | `NodeBusyError`, `kind: "limit"`, `retryable: true`, `retryAfterMs` set from the node's `retryAfterSecs`. `send` retries it up to `busyRetries` times (default 5), waiting `retryAfterMs` when it is at most 5 s, else 150 ms doubling to 2 s. A caller over its 6,000 calls is told 10 s, longer than `send` will wait, so over a WebSocket (browsers, Node 22 and later) that one is thrown at once with `retryAfterMs` 10000 |
| HTTP 429 | `NodeBusyError`, `kind: "limit"`, `retryable: true`, with no `retryAfterMs` (the SDK does not read `Retry-After`). `send` retries it `busyRetries` times, 150 ms doubling to 2 s (about 4.25 s in all), then throws it. This is what a caller over its 6,000 calls meets on Node 20, which has no global `WebSocket`, so the SDK talks HTTP there |
| "retry after the next commit" | `NodeBusyError`, `kind: "batch"`, `retryable: true`, after the node's own parking and the same retries as above |
| "alone would write N unique diffs" | `NodeBusyError`, `retryable: false`: split the call |
| "this transaction alone can never be committed" | viem's RPC error as the node worded it, not yet a typed error: split the call |
| A revert | The app's typed error (`AppRevertError`, or the `Delegatable` error by name) |

The live feed (`watch`, `useWatch`) retries a subscription refused with `-32005` after the
`retryAfterSecs` it was given, and polls while the socket is down.
