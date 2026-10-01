# create-interlude-app

A Foundry contract and a Next.js page, wired to an Interlude node, in one command.

```sh
npx create-interlude-app my-app
```

Then, from the project's README:

```sh
cd my-app/contracts
npm i
npm run build
npx @interludelayer-sdk/cli ship --owner <your address> --out ../web/.env.local
cd ../web && npm i && npm run dev
```

That is a contract deployed on Monad testnet, delegated to a node, and a page where one wallet
signature opens a session and every click after it is a gasless call answered in one round trip
(a few ms next to the node, ~40 ms over the network), then settled on Monad a few seconds later.

Call the CLI by its scoped name, `npx @interludelayer-sdk/cli`: inside `contracts/` that runs
the copy `npm i` installed there. A bare `npx interlude` anywhere else fetches an unrelated npm
package of that name.

## On npm, or from the repository

The generated project depends on `@interludelayer-sdk/cli@^0.2.2` (`contracts/`) and
`@interludelayer-sdk/sdk@^0.2.2` (`web/`). Both are on npm, and so is `create-interlude-app`
itself. The ranges are `^0.2.2` on purpose: a `^0.1` range would quietly install the old CLI
(up to 0.1.6), which ignores `ship --owner/--out` (the app stays owned by Interlude's deploy key
and no env file is written), and the old SDK (up to 0.1.3), which can send a call twice when a
response is lost; `^0.2.0` would accept 0.2.0, whose CLI bundles the hub from before v3; and
`^0.2.1` would accept 0.2.1, whose `gen` sends a project that already has `interlude.toml` to an
`init` that refuses to run.

Release order for the maintainer: publish `@interludelayer-sdk/sdk` and
`@interludelayer-sdk/cli` (both `prepublishOnly` scripts build; the CLI's also re-bundles
the Solidity sources and hub artifacts, so run `forge build` at the repository root first), then
`create-interlude-app`.

To try unpublished changes from a checkout (Node 20.9+, pnpm via `npx pnpm@10`):

```sh
npx pnpm@10 install
npx pnpm@10 --filter @interludelayer-sdk/sdk build
npx pnpm@10 --filter @interludelayer-sdk/cli build
mkdir -p /tmp/interlude-packs
(cd packages/sdk && npm pack --pack-destination /tmp/interlude-packs)
(cd packages/cli && npm pack --pack-destination /tmp/interlude-packs)

node packages/create-interlude-app/bin/create-interlude-app.js ~/my-app
cd ~/my-app/contracts && npm i -D /tmp/interlude-packs/interludelayer-sdk-cli-0.2.2.tgz
cd ../web && npm i /tmp/interlude-packs/interludelayer-sdk-sdk-0.2.2.tgz
```

The CLI tarball carries the Solidity sources and artifacts committed under `packages/cli`.
Installing the tarballs rewrites the two ranges to `file:` paths; the rest of the project's
README applies unchanged from `npm run build` on.

## What it writes

```
my-app/
  README.md          the commands above, what you are trusting, and the limits to know first
  contracts/         Foundry: Clicker.sol, its generated surface, forge tests, interlude.toml
  web/               Next.js App Router: @interludelayer-sdk/sdk + viem, no other runtime deps
```

`contracts/src/Clicker.sol` is delegation-ready as written: its storage is annotated
`/// @custom:interlude global`, `ClickerInterludeSurface.sol` is already generated from solc's
layout (`npm run gen` regenerates it, `npm run check` proves it matches), every writer carries
`whenNotDelegated(Types.GLOBAL)`, it reads the caller with `_actor()` so session keys work, and
its constructor takes only the hub, so `ship` needs no arguments. Each of those lines is
commented with why it is there.

`web/` checks that the node serves the configured app (`status().app`, so a node URL from
somewhere else is an error on load rather than a quiet 0), connects an injected wallet, moves it
to the base chain, opens a session scoped to `click`, shows your count before the node answers,
the round-trip latency, the live total through `useWatch`, and when Monad has caught up, click
by click, through `waitSettled({ hash })` (which also says so when a restarted node lost a
click). It reads
`NEXT_PUBLIC_INTERLUDE_APP`, `NEXT_PUBLIC_INTERLUDE_NODE` and `NEXT_PUBLIC_INTERLUDE_BASE_RPC`,
the names `interlude ship --out` writes.

## Options

```
npx create-interlude-app <dir> [--name my-app]
```

- `<dir>` must not exist yet, or be empty (a `.git` alone is fine). Nothing is ever overwritten.
- `--name` is the npm name the project's packages take (`my-app-contracts`, `my-app-web`).
  Default: derived from `<dir>`.

It copies files and prints the next commands. It does not install anything, run `git init`, or
touch the network.

Needs Node 20.9 or later. The generated project also needs [Foundry](https://getfoundry.sh).

## Working on the template

Tests: `pnpm --filter create-interlude-app test`. With `forge` on PATH they also scaffold into
a path with spaces, build and test the contracts against this repository's
`packages/contracts/src`, and compare `template/web/lib/abi.ts` with the compiled ABI. When a
change to `Delegatable` moves that ABI, `pnpm --filter create-interlude-app sync-template`
regenerates it.

Files npm would drop from a tarball are stored renamed: `template/_gitignore` becomes
`.gitignore`. The token `__APP_NAME__` is replaced in every file's contents.
