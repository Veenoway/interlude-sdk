# @interludelayer-sdk/sdk

Open a session and send gasless transactions to an Interlude node: about 3 ms next to the node,
~40 ms round trip over the network.

One wallet signature buys a session key. Every call after that is signed by the key, costs no
gas, and comes back in a single round trip with its return value already decoded.

## Try it in 60 seconds

[`examples/try.mjs`](https://github.com/Veenoway/interlude-sdk/blob/main/sdk/examples/try.mjs)
is the whole loop in under fifty lines, with nothing but this package and viem: a throwaway key
signs one grant, joins the public Paris Room, takes a few steps, leaves, and waits for the node
to commit every one of those calls to Monad. Copy it next to a `package.json` that has both
installed and run `node try.mjs`:

```text
player   0x49670E12AE25114272D78a7836198D5DBcD38c34
join     412.4 ms
move 1   53.7 ms
move 2   53.9 ms
move 3   55.8 ms
move 0   39.9 ms
leave    39.6 ms
waiting for the node to commit that to Monad...
batch 68 https://testnet.monadscan.com/tx/0x0c09a574b1d1e347ce967da29552fd7c631cfb86cfa76913fd54f600e66e2e11
```

The first call also opens the connection to the node; each one after it is a single round trip
to the node, which is most of those milliseconds. The key is never funded:
the node charges no gas, and the commit is the validator's transaction on the hub. The node
commits every few seconds, so a walk can straddle two commits; the script prints one line per
commit that carries its calls.

The examples are in the repository, in `examples/` beside this README; the npm tarball carries
only `dist` and this README. Inside a checkout they run against the built package, so run
`pnpm --filter @interludelayer-sdk/sdk build` first.

## The shortest thing that works

The snippet talks to the **Paris Room**, one of eight public floors (`PUBLIC_DEMO_FLOORS`;
`nearestFloor()` picks the closest). `https://rpc.interludelayer.xyz` serves that contract and
no other, and `roomAbi` is exported so the snippet runs as written. Pointing the SDK at a public
floor is fine for experiments. Your own contract needs its own node: after
`npx @interludelayer-sdk/cli ship`, pass the `app` and `node` it printed. That is what "do not
point the SDK at Room's node" means elsewhere in these docs: a node refuses calls to any
contract but its own (`WrongNodeError`). A 502 on a freshly shipped URL for a few minutes is the
node image building.

```tsx
import { createPublicClient, http, type WalletClient } from "viem";
import { monadTestnet } from "viem/chains";
import { createInterludeClient, roomAbi } from "@interludelayer-sdk/sdk";
import { createInterludeHooks } from "@interludelayer-sdk/sdk/react";

const { InterludeProvider, useSession, useSessionCall } = createInterludeHooks(
  createInterludeClient({
    app: "0xA116fcaEC711c9D8f64DA409CBE3AF673Fb9084C",
    abi: roomAbi,
    node: "https://rpc.interludelayer.xyz",
    base: createPublicClient({ chain: monadTestnet, transport: http() }),
  }),
);

function Floor() {
  const { session, open } = useSession();
  const join = useSessionCall("join");
  const move = useSessionCall("move");

  if (!session) return <button onClick={() => open()}>Enter</button>;

  return (
    <>
      <button onClick={() => join.send()}>Join</button>
      <button onClick={() => move.send([1])}>East</button>
    </>
  );
}

export function Game({ wallet }: { wallet: WalletClient }) {
  return (
    <InterludeProvider wallet={wallet} scope={["join", "move"]}>
      <Floor />
    </InterludeProvider>
  );
}
```

That is the whole client. For a contract you shipped, replace `app`, `abi` and `node` with what
the CLI printed (`interlude abi` writes the ABI). `open()` prompts the wallet once — the user
signs a grant that says "this key may call `join` and `move`, for the next hour" — and the
buttons never prompt again.

`wallet` is a viem `WalletClient`, so with wagmi it is `useWalletClient()`'s `data`, as is.
Until wagmi has one it is `undefined`: the provider restores nothing, and `open()` puts
"connect a wallet" in `error` rather than throwing.

```tsx
import { useWalletClient } from "wagmi";

export function Game() {
  const { data: wallet } = useWalletClient();
  return (
    <InterludeProvider wallet={wallet} scope={["join", "move"]} ensureChain>
      <Floor />
    </InterludeProvider>
  );
}
```

`ensureChain` asks the wallet to switch to the base chain (and to add Monad testnet if it does
not know it) before it signs, rather than failing on another network.

A process is the same three lines, with `memoryStore()` and a key it holds.
`examples/try.mjs` and `examples/agent-room.mjs` do that against the public Room. On Node 22 and
later, where `WebSocket` is a global, the client keeps a socket to the node open for the next
call, and the SDK has no `close()` yet, so a script that is done does not exit by itself. End it
with `process.exit()`, as both examples do, or pass `transport: http(node, { retryCount: 0 })`
to `createInterludeClient`: every read and send is then a plain POST, and the process ends when
its work does (a `watch` still holds its own socket until you stop it).

Without React the core is the same three lines:

```ts
import { createInterludeClient, roomAbi } from "@interludelayer-sdk/sdk";

const interlude = createInterludeClient({ app, abi: roomAbi, node, base });

const session = await interlude.openSession({ wallet, scope: ["join", "move"] });
await session.send("join");
const { latencyMs } = await session.send("move", [1]);
```

## Install

```bash
npm i @interludelayer-sdk/sdk viem
```

Node ≥ 20.9 for scripts and SSR; Node 22 or later for `watch` (it needs a global `WebSocket`,
see [Reading state](#reading-state)). The React entry ships with `"use client"`, so it can be
imported from a Next.js App Router page; the core entry has no directive and works on the
server too.

`viem` and `react` are peer dependencies. The main entry does not import React; only
`@interludelayer-sdk/sdk/react` does.

## What a session is

A `SessionGrant` is an EIP-712 message the user signs with their wallet, naming a freshly
generated secp256k1 key, an expiry, the hub's current session epoch, and the selectors that key
may call. The app verifies the signature on every call and resolves `_actor()` to the granter,
so the app sees the user, not the key.

The SDK does the parts that are easy to get wrong:

- **The domain.** `chainId` is the **base** chain's, not the node's, and `verifyingContract` is
  the app. A grant signed under the wrong one recovers to nobody and every call reverts. Read
  once from the `base` client, cached.
- **The epoch.** A grant must name `hub.sessionEpochOf(granter)` as of signing or it is stale on
  arrival. Fetched for you — including the hub address, which comes off the app's own `hub()`
  getter, so there is nothing to configure.
- **The scope.** `scope: ["move"]` is resolved against the ABI, so a typo is an error before the
  wallet opens rather than a revert later. Full signatures (`"move(uint256)"`) and raw selectors
  work too, for overloads.
- **The wrapping.** `send` encodes the call, wraps it in `withSession(grant, sig, call)`, signs
  with the session key, and unwraps the `bytes` the wrapper returns back into the app's own
  return type.

You can check the SDK's digest against the app's before signing:

```ts
await interlude.openSession({ wallet, scope: ["move"], assertDigest: true });
```

That costs one read of `sessionDigest(grant)` and turns a silent EIP-712 mismatch into a throw
naming both digests. Worth it once in development, not on every session.

## Storage, and the honest trade-off

The session key and its signed grant are stored **together**, in `sessionStorage`, keyed by app
+ base chain + granter. That pairing is the point: a page refresh restores both, so the user
keeps playing with no wallet prompt at all. Closing the tab ends the session.

The cost is that the key sits in `sessionStorage`, readable by any script running on the page.
The blast radius is deliberately small — `withSession` is not payable, so a stolen key cannot
move value, and it can only call the selectors the grant named, until the grant expires — but it
is a real key doing real writes on the user's behalf, and an XSS hole means an attacker can call
`move` as your user for the rest of the hour.

If that is not a trade you want, take memory only:

```ts
import { memoryStore } from "@interludelayer-sdk/sdk";

createInterludeClient({ app, abi, node, base, store: memoryStore() });
```

Then a refresh costs a new signature. There is no `localStorage` option: a key that outlives the
tab is a key nobody remembers granting.

`store` takes anything with `get`/`set`/`remove`, if you want a cookie, an iframe, or a
`Worker`.

### Revocation

`hub.bumpSessionEpoch()` invalidates every grant the user has ever signed, for every Interlude
app at once, in one base-chain transaction:

```ts
const { revoke } = useSession();
await revoke(); // or interlude.revokeAll(wallet)
```

**What it does not do yet: stop a stolen key on a node that is already running.** A node reads
the session epoch at the block its delegation was pinned to. Until the app owner reopens the
delegation, that node keeps accepting the old grant from whoever holds the key — the grant's
expiry is the real bound on a leaked key — and it refuses the user's _new_ grant with
`SessionEpochStaleError` (`pinnedByNode: true`), so the user cannot play on that node until the
delegation moves. What the SDK does do: the client that revoked refuses to sign with the old
key again (`SessionRevokedError`), drops it from storage, and refuses to open a grant the
pending revocation would kill. Wire `revoke` to a deliberate "log out everywhere" action, not to
an ordinary sign-out; `session.discard()` is the sign-out.

It is a Monad transaction, so the wallet needs a little MON, and it moves the epoch for every
Interlude app at once: every node already running, the public demos included, refuses that
address's new grants until its app is delegated again. Try it with a throwaway key, not the
wallet you play with.

Individual sessions do not need revoking; they expire. Default expiry is one hour, overridable
with `expirySeconds` (on `openSession`, on the client, or on `<InterludeProvider>`).
`<InterludeProvider autoRenew>` signs a fresh grant a minute before expiry (`{ beforeSeconds }`
to change the lead), or halfway through a grant it signed that lives less than twice the lead;
it is off by default because a browser wallet prompts for it.

### The wallet's network

`revokeAll`, `delegateAll`, `delegateKey`, `undelegate` and `releaseStake` check that the
wallet is on the base chain before sending, and throw `WrongChainError` otherwise — a
revocation sent to the wrong network used to "succeed" against an empty address. `openSession`
does the same for a browser wallet, which would refuse to sign a grant for another chain with an
unhelpful message. `interlude.ensureChain(wallet)` asks the wallet to switch (and to add Monad
testnet if it does not know it); `openSession({ …, ensureChain: true })` does it for you.

## Reading state

```ts
await interlude.read("squareOf", [user]); // the node's live state
await interlude.readSettled("squareOf", [user]); // the last committed value on the base chain
```

The two differ by whatever the node has not committed yet — that gap is the whole design. `read`
is live for the state the node holds: a view over delegated slots sees every call the node has
run, while anything else it touches (another contract, an undelegated slot) is read as of the
block the delegation was pinned to. A view that reverts throws the same typed errors as a failed
`send`: `AppRevertError` with the app's error name and arguments, or `UnrecognisedRevertError`
(the node answers a reverted `eth_call` as JSON-RPC error 3 with the revert bytes). In React:

```tsx
const { data, isLoading, isFetching, refetch } = useRead("squareOf", [user], { pollMs: 1000 });
const { data: live } = useWatch("squareOf", [user]);
const { status } = useNodeStatus();
```

`data` is typed from your ABI (`bigint | undefined` here). `isLoading` is only true until the
first value for those arguments arrives, so a poll does not flash a spinner; `isFetching` is
true whenever a read is in flight.

`useWatch` / `interlude.watchRead("squareOf", [user], setSquare)` listens on a WebSocket
(`interlude_subscribe("applied")`) and re-reads **your** view each time any call lands on
that node. The socket is not tied to a contract shape: Room or an app you have not
written yet all hear the same event (`app`, `input`, `output`, `logs`). Decode `logs`
against your ABI, or ignore them and just re-read.

One client opens one socket, however many watchers it has. Watchers of the same view with the
same arguments share one read; a burst of calls collapses into at most one read in flight plus
one trailing read (no more often than every 50 ms, `watch.minIntervalMs`), and a reply older than
one already delivered is dropped, so a value never goes backwards. While the socket is down the
views are polled instead (`watch.fallbackMs`, 500 ms). A dropped socket reconnects with a backoff
capped at 30 s, and so does a subscription the node turned down for a transient reason — its
`-32005` rate limit included, after the `retryAfterSecs` it asked for. Only a node that does not
know `interlude_subscribe("applied")` at all (`-32601` / `-32602`) is polled for good, until the
last watcher stops; the next one asks again.

The socket is the runtime's global `WebSocket`: every browser has one, and Node has one from 22
on. On Node 20 there is none, so `watch` delivers nothing (no error either) and `watchRead` /
`useWatch` poll the view every `watch.fallbackMs` instead.

```ts
const stop = interlude.watch((call) => {
  if (!call.succeeded) return;
  // any app: decode call.logs, or re-read whatever view you named
  void interlude.read("squareOf", [user]).then(setSquare);
});
// later
stop();
```

`watch` needs a global `WebSocket`: a browser, or Node 22 and later. Node 20 has none (unless
started with `--experimental-websocket`), so there the callback never runs, and the SDK says so
once with a `console.warn`; set `globalThis.WebSocket` from the `ws` package before the first
`watch` to use it on Node 20. `watchRead` and `useWatch` poll their view there instead.

`status` is what `interlude_session` reports: the app, the ephemeral chain id, the validator, the
pinned base block, the batches committed so far, and the diffs still pending. It is the quickest
way to find out whether the node is serving the app your frontend thinks it is.

A receipt from `send` is the ephemeral execution. Monad has those diffs only after a commit.
Every `send` returns `settled`, a promise that resolves once a committed batch carries **that**
transaction (with `batchIndex` and `settlementHash`), found through the node's batch log. It
rejects with `SettlementLostError` if the node forgets the call — a restart that dropped what it
had not committed; the node must have stopped knowing it for 15 s (`lostAfterMs`) or through two
more batches, because a batch frozen for its commit when the node restarted is served nowhere
until the new process lands it — and with `SettlementTimeoutError` after 60 s. It is lazy: unused `settled`
does not poll. `send` itself does not wait, so tap latency stays the round trip.

```ts
const { result, hash, settled } = await session.send("move", [1]);
// `result` is already the live return. Monad catches up on its own.
await settled; // or `await interlude.waitSettled({ hash })`
```

`interlude.waitSettled()` without a `hash` waits for everything the node had executed when it
was called: nothing pending, or two more batches committed since. It cannot notice a call a
restarted node lost, so pass the `hash` when there is one.

`interlude.commit()` publishes the pending diffs now instead of waiting out the node's interval,
which is mostly useful in tests. It needs the node's commit token: none on a local
`interlude dev` node, and on a node you started yourself with `INTERLUDE_COMMIT_TOKEN`, pass it
as `createInterludeClient({ …, commitToken })`. A node `ship` started refuses it, because its
token is control's, not yours. Those nodes commit every 10 s; await a send's `settled`, or
`interlude.waitSettled({ hash })`, to know when Monad has the call.

## Latency

`send` uses `interlude_sendTransaction`, which returns the receipt **and** the execution output
in one round trip. viem's `sendTransaction` + `waitForTransactionReceipt` costs three, and then
still cannot tell you what the call returned. If the node does not serve the custom method the
SDK falls back to `eth_call` + `eth_sendRawTransaction` + `eth_getTransactionReceipt` on its own,
and `latencyMs` will show it.

Next to the node, a call takes **about 3 ms** from send to receipt. Over the network the round
trip is **~40 ms**, so a call is mostly the network; the SDK's own `send` adds about 0.7 ms,
signing included. The default transport is a **WebSocket** kept open for the tab; HTTP is the
fallback. The first call of a session costs more, because the node reads that account's slots
from Monad. The engine alone, on a laptop and not in production, answers
`interlude_sendTransaction` in 228 µs p50. A user in another continent pays the fibre, not the
EVM — `ship --region` puts the node next to them. How each figure was measured:
[interludelayer.xyz/docs/performance](https://interludelayer.xyz/docs/performance).

Nonces are tracked client-side for the same reason — asking the node for one before each call
would double the round trips. Calls from one session key go out one at a time, in the order they
were made, so twenty `send`s fired at once reach the node with their nonces in order. If the
count drifts (another tab, a restarted node) the SDK resynchronises once and retries.

A response lost on the way back never runs the call twice. Transactions go through a transport
that does not retry on its own; when the outcome is unclear (the connection dropped, or the node
says the nonce is used), the SDK first looks the signed transaction up by its hash. Found means
it ran, and its receipt is the answer — or, when the receipt carries no return data,
`ResultUnavailableError` says it ran rather than sending it again. Not found means it never
arrived, and the _same_ signed bytes are sent again, over HTTP when it was the socket that lost
them. A new transaction is only signed once the node has confirmed the old one does not exist.
The socket then rests, not for good: sends stay on HTTP for 2 s, twice that after each further
loss in a row (up to a minute), and go back over a fresh connection after that (at the node's
URL with `?interlude_send=N`, so that viem opens a new socket instead of reusing the one that
lost the send).

Backpressure is retried for you: when the node's open batch is full it answers "retry after the
next commit", and `send` waits (150 ms, doubling, `busyRetries` times, default 5) and sends the
same transaction again before throwing `NodeBusyError`. A rate limit (JSON-RPC `-32005`, or HTTP
429) is retried the same way after the `retryAfterSecs` the node names, as long as that is at
most 5 s; `NodeBusyError.kind` is `"limit"` for those and `"batch"` for a full batch.

## Errors

Every named revert in `Delegatable` and `Session` becomes a typed error carrying a sentence about
what to do next. Reverts from the app's own ABI come back as `AppRevertError` with the error name
and decoded arguments.

| Error | What happened |
| --- | --- |
| `SessionExpiredError` | The grant's hour ran out. Open a new session. |
| `SelectorOutOfSessionScopeError` | The call is not in the grant's scope. See below. |
| `SessionEpochStaleError` | The user revoked with `bumpSessionEpoch()`, or the node's pinned block predates the bump. The message says which, because it reads the hub to find out. |
| `WrongSessionKeyError` | The grant was presented by a key it does not name. |
| `PrivilegedSelectorError` | No grant may reach the delegation controls or hub callbacks, whatever its scope says. |
| `SessionNotSignedByGranterError` | The signature does not recover to the granter — usually a grant signed for another app or another chain id. |
| `EmptySessionScopeError` | A grant with no selectors and no `anyFunction` authorises nothing. |
| `SessionAlreadyOpenError` | `withSession` refuses to nest. |
| `DelegatedWritesDisabledError` | The write went to the base chain instead of the node. |
| `AppRevertError` | The app's own rule, with its name and arguments. |
| `UnrecognisedRevertError` | Revert data no error in the ABI matches. |
| `NodeUnreachableError` | The node did not answer. |
| `NodeBusyError` | The node's open batch is full (`retryable`, already retried) or the call can never fit (`retryable: false`). |
| `WrongNodeError` | The node at `node` serves another app. |
| `WriteOutsideDelegationError` | The call writes state the delegation does not cover; the node dropped it whole. |
| `WrongChainError` | The wallet is on another network than the base chain. Nothing was sent or signed. |
| `SessionRevokedError` | This client revoked the grant with `revokeAll`; it will not sign with that key again. |
| `ResultUnavailableError` | The call ran but its response was lost and the receipt has no return data. It was not sent again. |
| `SettlementLostError` | `settled`: the node no longer knows the call (a restart dropped it). |
| `SettlementTimeoutError` | `settled` / `waitSettled`: no commit carried it in time. |
| `InvalidScopeError` | The scope names a function the ABI does not have. |

Also `SessionGranterIsZeroError`, `SessionKeyIsZeroError`, `MalformedSessionCallError`,
`BadSessionSignatureError`, `MalleableSessionSignatureError`, `NoActorError`,
`NotRegisteredError`, `DelegatableError` for the rest, and `SessionUnusableError` for the SDK's
own preconditions. All extend `InterludeError`.

`decodeRevert(data, abi)` is exported if you have raw revert data of your own to make sense of.

### The `this.other()` limitation

A scoped session records the selector its grant was presented for, and trusts the actor for that
selector only. An app that dispatches work through an external self-call — `this.other()` — hands
the inner frame a different `msg.sig`, so `_actor()` in that frame reverts with
`SelectorOutOfSessionScope` even though the grant covers the function you called.

Adding the inner selector to the scope does not help: the recorded selector is the outer one.
The SDK detects this case (it already checked the scope locally, so a scope revert from the node
can only be a self-call) and says so instead of showing you four bytes. The fixes are to call
each function under its own grant, or to open the session with `anyFunction: true` — the only
grant that carries an actor through a self-call. Or, better, to have the app call its internal
function internally.

## Opening the delegation

Not the hot path — this is the app owner's job, once, on the base chain — but the helpers are
here so you do not need a second ABI:

```ts
import { parseEther } from "viem";
import { keyOf } from "@interludelayer-sdk/sdk";

// The validator's delegationFee: 0.01 MON on the live terms. Without it: FeeNotPaid.
await interlude.delegateAll(ownerWallet, { value: parseEther("0.01") });
// One key's partition, for a per-key surface (`interlude dev` only: a hosted node serves the
// whole contract, and a shipped app has no per-key slots, so this reverts EmptyDelegation).
await interlude.delegateKey(ownerWallet, keyOf(userAddress), { value: parseEther("0.01") });
```

`ship` already sent `delegateAll()` and paid its fee. You call it yourself only to re-open the
contract after `undelegate` and `releaseStake`, and you forward the validator's `delegationFee`
(0.01 MON on the live terms, listed in
[DEPLOYMENTS.md](https://github.com/Veenoway/interlude-sdk/blob/main/docs/DEPLOYMENTS.md)), or
the hub reverts `FeeNotPaid`. The owner wallet pays that in testnet MON
([faucet](https://faucet.monad.xyz)), as it does `acceptOwnership()` after `ship --owner`.

## Closing the session

`undelegate` ends the session, but the app stays **locked** on Monad, and the
validator's stake stays reserved, for the challenge window (~1 hour on the deployed
terms, plus any time spent frozen in a dispute): a fraud found in that window can
still be unwound. That does **not** clear itself — when `stakeUnlockAt` has passed,
call `releaseStake` (permissionless; reverts with `StakeStillLocked` if you are
early). Only `releaseStake` or a slash unlocks the app. A keeper / control plane can
do that on a timer; the SDK does not wait out the window for you.

```ts
await interlude.undelegate(ownerWallet);
// …after the challenge window…
await interlude.releaseStake(anyWallet);
```

## API

`@interludelayer-sdk/sdk`

| Export | |
| --- | --- |
| `createInterludeClient(config)` | The core client. |
| `client.openSession(options)` | Restore, or prompt once and sign. |
| `client.restoreSession(granter)` | Restore, or `null`. Never prompts. |
| `session.send(fn, args)` | A gasless call. Returns `{ result, receipt, hash, latencyMs, settled }`. |
| `session.covers(entry)`, `session.isExpired()`, `session.discard()` | |
| `client.read`, `client.readSettled` | View calls against the node and the base chain. |
| `client.watch(onCall)`, `client.watchRead(fn, args, onValue)` | Every call the node applies, or a view re-read after each, over one shared WebSocket. |
| `client.waitSettled({ hash })` | What `settled` does, for a hash you kept. |
| `client.status()`, `client.commit()` | `interlude_session`, `interlude_commit`. |
| `client.revokeAll(wallet)` | `hub.bumpSessionEpoch()`. |
| `client.delegateAll` / `delegateKey` / `undelegate` / `releaseStake` | Owner open/close; `releaseStake` after the challenge window. |
| `client.epochOf(user)`, `client.hubAddress()`, `client.baseChainId()` | |
| `client.sessionDigest(grant)`, `client.sessionDigestOnChain(grant)` | For comparing the two. |
| `sessionGrantTypedData`, `sessionGrantDigest`, `signSessionGrant`, `resolveScope`, `grantCovers` | The grant primitives, usable on their own. |
| `memoryStore()`, `webStorageStore(storage)`, `defaultStore()` | |
| `delegatableAbi`, `hubAbi`, `keyOf`, `GLOBAL_PARTITION` | |
| `roomAbi` | The public Room's floor: `join`, `move`, `jump`, `hit`, `leave`, its reads and every error Room itself declares. |
| `PUBLIC_DEMO_FLOORS`, `nearestFloor(floors?)` | The eight public Rooms on hub v3, and the one control says is closest. |

`@interludelayer-sdk/sdk/react`

`createInterludeHooks(client)` returns `InterludeProvider`, `useSession`, `useSessionCall`,
`useRead`, `useWatch`, `useNodeStatus`, `useInterlude`.

It is a factory rather than free hooks because React context cannot be generic: erased to `Abi`,
`send("move", [3n])` would take a `string` and an `unknown[]` and check neither. Bind the client
once where you configure it and every call site is typed off your ABI.

`useSessionCall(...).send` resolves rather than rejects on failure, putting the error in `error`,
so a bare `onClick={() => move.send([3n])}` cannot produce an unhandled rejection. Use
`session.send` where you want the throw.

## Tests

```bash
pnpm --filter @interludelayer-sdk/sdk test   # unit suites; no chain, no node
pnpm test:sdk:e2e                            # from the repo root; or scripts/sdk-e2e.sh
```

Most of the SDK's behaviour is what it does when the network does not cooperate, and that is
tested without one. `test/fake.ts` is an in-process node that answers with the real node's error
wording: `client.test.ts` drives it through lost responses, full batches, rate limits, a
restarted node that forgot a call, a wrong chain and a wrong node; `watch.test.ts` scripts the
socket's subscriptions, drops and reconnects; `react-unit.test.tsx` runs the hooks in a DOM
against a scripted client. `tsc --noEmit` also checks `test/types.check.ts`, the calls the types
have to refuse.

What a mock cannot answer is whether the SDK and a deployed contract agree: the EIP-712 digest,
`_actor()`, a commit on chain. Those suites (`digest`, `e2e`, `react`) are skipped unless a live
stack is named. The e2e script starts anvil, deploys the hub and `Players`, delegates the
player's partition, starts the node against anvil, then runs them — a session opened and used,
`_actor()` resolving to the granter, a commit settling on chain, a session restored from a real
`sessionStorage` across a remount, and every failure mode: out of scope, expired, and revoked by
`bumpSessionEpoch()`.

`--keep` leaves the chain and the node running afterwards, which is the quickest way to point a
frontend at them. With a stack already up, `pnpm --filter @interludelayer-sdk/sdk test` runs the
live suites too, given `INTERLUDE_BASE_RPC`, `INTERLUDE_NODE_RPC`, `INTERLUDE_APP` and
`INTERLUDE_PLAYER_PK`.
