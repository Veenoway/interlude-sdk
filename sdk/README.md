# @interludelayer-sdk/sdk

Open a session and send gasless, sub-millisecond transactions to an Interlude node.

One wallet signature buys a session key. Every call after that is signed by the key, costs no
gas, and comes back in a single round trip with its return value already decoded.

## The shortest thing that works

```tsx
import { createPublicClient, http, type WalletClient } from "viem";
import { monadTestnet } from "viem/chains";
import { createInterludeClient } from "@interludelayer-sdk/sdk";
import { createInterludeHooks } from "@interludelayer-sdk/sdk/react";
import { playersAbi } from "./players-abi";

const { InterludeProvider, useSession, useSessionCall } = createInterludeHooks(
  createInterludeClient({
    app: "0x7584eeEe58787a3C88411905efD4d379B274fF7d",
    abi: playersAbi,
    node: "https://rpc.interludelayer.xyz",
    base: createPublicClient({ chain: monadTestnet, transport: http() }),
  }),
);

function Board() {
  const { session, open } = useSession();
  const move = useSessionCall("move");

  if (!session) return <button onClick={() => open()}>Play</button>;

  return (
    <button onClick={() => move.send([3n])}>
      square {String(move.data ?? 0n)}
      {move.latencyMs && ` · ${move.latencyMs.toFixed(1)}ms`}
    </button>
  );
}

export function Game({ wallet }: { wallet: WalletClient }) {
  return (
    <InterludeProvider wallet={wallet} scope={["move"]}>
      <Board />
    </InterludeProvider>
  );
}
```

That is the whole integration. `open()` prompts the wallet once — the user signs a grant that
says "this key may call `move`, for the next hour" — and `move.send([3n])` never prompts again.
`move.data` is the `uint256` the app returned, typed off the ABI.

A process is the same three lines, with `memoryStore()` and a key it holds. `examples/agent-clock.mjs` does that against the public Clock.

Without React the core is the same three lines:

```ts
const interlude = createInterludeClient({ app, abi: playersAbi, node, base });

const session = await interlude.openSession({ wallet, scope: ["move"] });
const { result, latencyMs } = await session.send("move", [3n]);
```

## Install

```bash
npm i @interludelayer-sdk/sdk viem
```

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

`hub.bumpSessionEpoch()` is the panic button. It invalidates every grant the user has ever
signed, for every Interlude app at once, in one base-chain transaction:

```ts
const { revoke } = useSession();
await revoke(); // or interlude.revokeAll(wallet)
```

Individual sessions do not need revoking; they expire. Default expiry is one hour, overridable
with `expirySeconds`.

## Reading state

```ts
await interlude.read("squareOf", [user]); // the node's live state
await interlude.readSettled("squareOf", [user]); // the last committed value on the base chain
```

The two differ by whatever the node has not committed yet — that gap is the whole design. In
React:

```tsx
const { data, refetch } = useRead("squareOf", [user], { pollMs: 1000 });
const { data: live } = useWatch("squareOf", [user]);
const { status } = useNodeStatus();
```

`useWatch` / `interlude.watchRead("squareOf", [user], setSquare)` opens a WebSocket
(`interlude_subscribe("applied")`) and re-reads **your** view each time any call lands on
that node. The socket is not tied to a contract shape: Clock, Room or an app you have not
written yet all hear the same event (`app`, `input`, `output`, `logs`). Decode `logs`
against your ABI, or ignore them and just re-read. A node that does not serve the socket
falls back to polling on its own.

```ts
const stop = interlude.watch((call) => {
  if (!call.succeeded) return;
  // any app: decode call.logs, or re-read whatever view you named
  void interlude.read("squareOf", [user]).then(setSquare);
});
// later
stop();
```

`status` is what `interlude_session` reports: the app, the ephemeral chain id, the validator, the
pinned base block, the batches committed so far, and the diffs still pending. It is the quickest
way to find out whether the node is serving the app your frontend thinks it is.

`interlude.commit()` publishes the pending diffs now instead of waiting out the node's interval,
which is mostly useful in tests. A hosted node that set `INTERLUDE_COMMIT_TOKEN` needs
`createInterludeClient({ …, commitToken })` or the call is refused.

## Latency

`send` uses `interlude_sendTransaction`, which returns the receipt **and** the execution output
in one round trip. viem's `sendTransaction` + `waitForTransactionReceipt` costs three, and then
still cannot tell you what the call returned. If the node does not serve the custom method the
SDK falls back to `eth_call` + `eth_sendRawTransaction` + `eth_getTransactionReceipt` on its own,
and `latencyMs` will show it.

Measured against a local node on loopback, per `move` call: **1.3 ms** median wall clock end to
end (p95 2.6 ms, min 1.0 ms), of which ~0.26 ms is the local ECDSA signature and ~0.28 ms is the
bare HTTP round trip. The node's own execution is the sub-millisecond part; signing and JSON-RPC
framing are most of what is left. The same suite on the fallback path measures 1.9 ms.

Nonces are tracked client-side for the same reason — asking the node for one before each call
would double the round trips. If the count drifts (another tab, a restarted node) the SDK
resynchronises once and retries.

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
await interlude.delegateAll(ownerWallet);
await interlude.delegateKey(ownerWallet, keyOf(userAddress));
```

## API

`@interludelayer-sdk/sdk`

| Export | |
| --- | --- |
| `createInterludeClient(config)` | The core client. |
| `client.openSession(options)` | Restore, or prompt once and sign. |
| `client.restoreSession(granter)` | Restore, or `null`. Never prompts. |
| `session.send(fn, args)` | A gasless call. Returns `{ result, receipt, hash, latencyMs }`. |
| `session.covers(entry)`, `session.isExpired()`, `session.discard()` | |
| `client.read`, `client.readSettled` | View calls against the node and the base chain. |
| `client.status()`, `client.commit()` | `interlude_session`, `interlude_commit`. |
| `client.revokeAll(wallet)` | `hub.bumpSessionEpoch()`. |
| `client.epochOf(user)`, `client.hubAddress()`, `client.baseChainId()` | |
| `client.sessionDigest(grant)`, `client.sessionDigestOnChain(grant)` | For comparing the two. |
| `sessionGrantTypedData`, `sessionGrantDigest`, `signSessionGrant`, `resolveScope`, `grantCovers` | The grant primitives, usable on their own. |
| `memoryStore()`, `webStorageStore(storage)`, `defaultStore()` | |
| `delegatableAbi`, `hubAbi`, `keyOf`, `GLOBAL_PARTITION` | |

`@interludelayer-sdk/sdk/react`

`createInterludeHooks(client)` returns `InterludeProvider`, `useSession`, `useSessionCall`,
`useRead`, `useNodeStatus`, `useInterlude`.

It is a factory rather than free hooks because React context cannot be generic: erased to `Abi`,
`send("move", [3n])` would take a `string` and an `unknown[]` and check neither. Bind the client
once where you configure it and every call site is typed off your ABI.

`useSessionCall(...).send` resolves rather than rejects on failure, putting the error in `error`,
so a bare `onClick={() => move.send([3n])}` cannot produce an unhandled rejection. Use
`session.send` where you want the throw.

## Tests

```bash
pnpm test:sdk:e2e   # from the repo root; or scripts/sdk-e2e.sh
```

There is one entry point because there is nothing worth testing against a mock: the digest tests
compare against a deployed app's own `sessionDigest`, and the rest talks to a node. The script
starts anvil, deploys the hub and `Players`, delegates the player's partition, starts the node
against anvil, then runs the suite — a session opened and used, `_actor()` resolving to the
granter, a commit settling on chain, a session restored from a real `sessionStorage` across a
remount, and every failure mode: out of scope, expired, and revoked by `bumpSessionEpoch()`.

`--keep` leaves the chain and the node running afterwards, which is the quickest way to point a
frontend at them. With a stack already up, `pnpm --filter @interludelayer-sdk/sdk test` reruns the suite
on its own, given `INTERLUDE_BASE_RPC`, `INTERLUDE_NODE_RPC`, `INTERLUDE_APP` and
`INTERLUDE_PLAYER_PK`.
