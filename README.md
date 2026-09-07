# Interlude SDK

The client and CLI for [Interlude](https://interludelayer.xyz): a real-time engine in front of Monad. The loop is live now. The state stays the contract, same address. Diffs settle on Monad.

This repository is the public surface a team integrates against. The engine itself is operated by Interlude.

| Package | npm | What it is |
|---|---|---|
| `@interludelayer-sdk/sdk` | [npm](https://www.npmjs.com/package/@interludelayer-sdk/sdk) | Sessions, gasless calls, live vs settled reads |
| `@interludelayer-sdk/cli` | [npm](https://www.npmjs.com/package/@interludelayer-sdk/cli) | `init`, `gen`, `check`, `dev`, `ship` |

## Install

```sh
npm i @interludelayer-sdk/sdk
npm i -D @interludelayer-sdk/cli
```

Docs: [interludelayer.xyz/docs](https://interludelayer.xyz/docs) · first hour: [interludelayer.xyz/docs/first-hour](https://interludelayer.xyz/docs/first-hour)

```sh
npx @interludelayer-sdk/cli init
npx @interludelayer-sdk/cli gen --contract YourApp
npx @interludelayer-sdk/cli ship
```

`ship` talks to `https://control.interludelayer.xyz`. We deploy on Monad testnet, pay the gas, open the session, and print a node URL. The first node takes a few minutes to come up; a 502 right after the command is the image building. Point the SDK at that URL. Do not use `https://rpc.interludelayer.xyz` — that node only serves [Room](https://demo.interludelayer.xyz/room).

On-chain owner of a shipped app is Interlude; you keep the source, the frontend and the users. A contract that is already live cannot be adopted. Delegated storage is declared at construction.

## Layout

- `sdk/` — TypeScript client (`createInterludeClient`, React hooks)
- `cli/` — Foundry helpers and the hosted `ship` command
- `docs/` — overview, security model, bring-a-contract

License: MIT.
