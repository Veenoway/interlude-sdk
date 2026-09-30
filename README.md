# Interlude SDK

The client, CLI and starter for [Interlude](https://interludelayer.xyz): a real-time engine in front of Monad. The loop is live now. The state stays the contract, same address. Diffs settle on Monad.

This repository is the public surface a team integrates against. The engine itself is operated by Interlude.

| Package | npm | What it is |
|---|---|---|
| `@interludelayer-sdk/sdk` | [npm](https://www.npmjs.com/package/@interludelayer-sdk/sdk) | Sessions, gasless calls, live vs settled reads |
| `@interludelayer-sdk/cli` | [npm](https://www.npmjs.com/package/@interludelayer-sdk/cli) | `init`, `gen`, `check`, `abi`, `status`, `dev`, `ship` |
| `create-interlude-app` | [npm](https://www.npmjs.com/package/create-interlude-app) | A Foundry + Next.js project, ready to `ship` |

## Start

```sh
npx create-interlude-app my-app
```

Or add Interlude to an existing project:

```sh
npm i @interludelayer-sdk/sdk
npm i -D @interludelayer-sdk/cli
npx interlude init
npx interlude gen --contract YourApp
npx interlude ship --owner <your address> --out .env.local
```

Docs: [interludelayer.xyz/docs](https://interludelayer.xyz/docs) · first hour: [interludelayer.xyz/docs/first-hour](https://interludelayer.xyz/docs/first-hour)

`ship` talks to `https://control.interludelayer.xyz`. We deploy on Monad testnet, pay the gas, open the session, and print a node URL. The first node takes a few minutes to come up; a 502 right after the command is the machine starting. Point the SDK at that URL. Do not use `https://rpc.interludelayer.xyz`: that node only serves [Room](https://demo.interludelayer.xyz/room).

With `--owner`, the app is handed to you: `ship` prints the `acceptOwnership()` call to run once from that address (CLI 0.2.0 and later). Without it, the app stays owned by Interlude's deploy key. A contract that is already live cannot be adopted. Delegated storage is declared at construction.

## Layout

- `sdk/`: TypeScript client (`createInterludeClient`, React hooks)
- `cli/`: Foundry helpers and the hosted `ship` command
- `create-interlude-app/`: the starter and its template
- `docs/`: overview, vault, security model, bring-a-contract, audit fixes, what is live on Monad
  testnet (`DEPLOYMENTS.md`), limits and quotas (`LIMITS.md`), and the runbooks for deploying a
  fixed hub and rotating the resolver

License: MIT.
