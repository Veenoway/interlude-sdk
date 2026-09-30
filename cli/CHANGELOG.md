# @interludelayer-sdk/cli

## 0.2.1

- **The bundled hub is v3.** `artifacts/InterludeHub.sol/InterludeHub.json`, what `dev` deploys
  on anvil, is the hub live on Monad testnet at
  [`0x98922c6E…C43e`](https://testnet.monadscan.com/address/0x98922c6E5e4Bea62761C71D2401c7ec2c26eC43e):
  compiled from the same source, it differs from a fresh `forge build` only in the metadata hash
  solc appends, and its runtime code matches the deployed hub's byte for byte once that hash is
  set aside. 0.2.0 bundled the hub that preceded it. `dev`'s local validator publishes terms with
  no lease end (`maxDelegationDuration = 0`), which v3 accepts: a local session runs until its
  owner undelegates, its validator resigns, its node stops committing or a challenge ends it.
- **The vendored Solidity is v3's.** `contracts/` (`Delegatable`, `Types`, `Session`, …) is
  identical to the Interlude sources this release was cut from; `Types` documents the optional
  lease.
- **No anvil account as the example owner.** The error for an `[app] owner` that is not an
  address suggested anvil's account #3 (`0x90F7…b906`), and so did the README's configuration
  example. That account's private key is public, so whoever called `acceptOwnership()` first
  would have owned the shipped app. Both now say `owner = "0xYourWallet"`, and the README says
  why none of anvil's ten accounts belongs there.
- `ship` ends with `session open` once the node URL is printed.
- **`ship` refuses anvil's accounts as owner.** `--owner` or `[app] owner` naming one of anvil's
  ten default accounts stops `ship` before it sends anything, unless `--control` is a control
  plane on this machine (a local chain, where those accounts are the point). `dev` and `abi`
  still read such a config.
- **`logs --follow` prints only what the node sends.** It used to print a recorded sample —
  Kandle action names, a latency picked from a list of values between 24 and 33 ms, `gas=0` —
  whenever the socket failed, and on Node 20, which has no global WebSocket, it always failed; a
  live line carried a constant 28 ms. Each line is now one `interlude_subscribe("applied")`
  notification: when it arrived (UTC), `ok` or `failed` (the node's `succeeded` flag, false for a
  revert and for a halt such as out of gas alike), the function (named with `--abi`, else its
  selector), the node's block, the sender and the transaction hash. `--json` prints the
  notification as the node sent it plus two keys the command adds: `receivedAt` and, with
  `--abi`, `function`. The socket is the `ws` package on every Node (viem already depends on it).
  A node that cannot be reached, refuses the subscription, never answers or closes the stream
  exits 1 with the reason and nothing on stdout; one that answers the upgrade with a 429 is named
  as turning this caller away rather than as unreachable. There is no public default node any
  more: `--node`, `INTERLUDE_NODE_URL`, or the node `ship` last gave the project.

## 0.2.0

The post-audit release (2026-09-26): `ship --owner` and `--out`, `abi`, `status` and
`sessions create --signature`. What changed and why is in `docs/10-audit-fixes.md`.
