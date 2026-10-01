# @interludelayer-sdk/sdk

## 0.2.2

- **`watch()` says when it cannot run.** It needs a global `WebSocket`, and Node 20 has none
  unless started with `--experimental-websocket`. There the feed could not open, and since a
  bare `watch()` has no view to poll, its callback never ran and nothing said why (Node 20 is
  inside `engines`). The first `watch()` on such a runtime now prints one `console.warn` naming
  the fix: Node 22 or later, or `globalThis.WebSocket` from the `ws` package. `watchRead` and
  `useWatch`, which poll their view meanwhile, stay quiet. The README and `watch`'s doc comment
  say the same.
- The npm description gives the measured latency, a few ms next to the node and ~40 ms round
  trip, where it said "sub-millisecond": the engine alone on a laptop, not a call over the
  network.

## 0.2.1

- **A socket that loses a send is tried again.** A delivery the WebSocket lost is still resent
  over HTTP (the same signed bytes, once the node has said it never saw them), but sends no longer
  stay on HTTP for the rest of the page. The socket rests for 2 s, twice that for each loss in a
  row up to a minute, and sends then go over a fresh connection. It connects at a URL of its own
  (`?interlude_send=N`, which the node ignores): viem caches one socket per URL, whatever the
  transport's key, and hands back a dead one for good once its reconnects run out. The socket it
  replaces is closed, except the first, which the reads share. One send that arrives over the
  socket resets the rest. `createSendRouter` is the policy on its own; a `transport` of the app's
  own is used as before, for everything.
- **The public floors are the v3 ones.** `PUBLIC_DEMO_FLOORS`, and so `nearestFloor()` with its
  default table, name the eight public Rooms on hub v3
  ([`0x98922c6E…C43e`](https://testnet.monadscan.com/address/0x98922c6E5e4Bea62761C71D2401c7ec2c26eC43e)),
  Paris being `0xA116fcaEC711c9D8f64DA409CBE3AF673Fb9084C` on `https://rpc.interludelayer.xyz`.
  0.2.0 named the Rooms of an earlier hub, which the public nodes no longer serve, so the pair it
  returned ended in `WrongNodeError`.
- **`roomAbi` is exported.** The public Room's floor (`join`, `move`, `jump`, `hit`, `leave`,
  `where`, `hearts`, `scoreOf`, `lootOf`, `takenCount`, `floor`) and every error Room itself
  declares, `as const`. The README's snippets imported a `roomAbi` the package did not have;
  they now run as written. The salons and their events are left out to keep it small.
- **Room's reverts decode by name.** `examples/agent-room.mjs` uses `roomAbi`, so a step into a
  wall reports `Edge` instead of the raw `0x105d8ccf`. It also leaves the floor when it is done,
  rather than leaving a body on a public Room for every run, and ends with `process.exit()`: on
  Node 22+ the client's WebSocket to the node stays open and would keep the process alive. The
  client itself is unchanged; the README says how to end a script (`process.exit()`, or an HTTP
  `transport`).
- **`delegatableErrorsAbi` matches Delegatable again.** It lacked three errors Delegatable
  declares: `KeyIsGlobalPartition()` (`delegateKey(0)`), `TermsRejected(address validator)` (the
  validator's terms fail `_acceptTerms`) and `NotPendingOwner()` (someone other than the pending
  owner completing a hand-over). An app's compiled ABI decoded them as the app's own rule
  (`AppRevertError`), a hand-written one not at all (`UnrecognisedRevertError`); they are now a
  `DelegatableError` that names them and says Delegatable raised them. `DelegatableError` now
  carries the error's decoded `args`, so `TermsRejected` still names the validator that refused,
  in `args` and in the message. `NotRegistered()` stays, though Delegatable does not declare it:
  `DelegatedLayout`'s write guard does, and every app that writes a `Delegated` variable compiles
  with it. `delegatableAbi` carries the same list. `test/abi.test.ts` derives the list from the
  Solidity sources (Delegatable, what it inherits, the libraries it imports), and when
  `forge build` has left fresh artifacts, checks it against Delegatable's, `DelegatedLayout`'s and
  an app's (`Counter`) compiled ABIs, argument names included, so it cannot fall behind again.
- **`examples/try.mjs`.** Under fifty lines, this package and viem only: a throwaway key joins the
  Paris Room, takes a few steps, leaves, and prints each call's latency, then the MonadScan link
  of every commit that carries those calls (usually one; two when the walk straddles a commit).
  The examples are in the repository, not in the npm tarball.
- README: the wagmi wiring (`useWalletClient()` straight into `<InterludeProvider wallet>`),
  `useWatch` in the hook list, what the unit suites cover without a node, how a script ends on
  Node 22+, and when pointing at a public floor is fine (experiments) and when it is not (your
  own contract).

## 0.2.0

The post-audit release (2026-09-26). What changed and why is in `docs/10-audit-fixes.md`.
