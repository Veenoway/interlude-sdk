# Interlude SDK

The client and CLI for [Interlude](https://interludelayer.xyz): a real-time engine in front of Monad. The loop is live now. The state stays the contract, same address. Diffs settle on Monad.

This repository is the public surface a team integrates against. The engine itself is operated by Interlude.

| Package | npm | What it is |
|---|---|---|
| `@interludelayer-sdk/sdk` | [npm](https://www.npmjs.com/package/@interludelayer-sdk/sdk) | Sessions, gasless calls, live vs settled reads |
| `@interludelayer-sdk/cli` | [npm](https://www.npmjs.com/package/@interludelayer-sdk/cli) | `init`, `gen`, `check`, `dev`, `ship` |

## Install

```sh
npm i @interludelayer-sdk/sdk @interludelayer-sdk/cli
```

Docs: [interludelayer.xyz/docs](https://interludelayer.xyz/docs)

```sh
npx interlude init
npx interlude gen --contract YourApp
npx interlude ship
```

`ship` sends the bytecode to Interlude. We deploy on Monad testnet, pay the gas, open the session, and print a node URL. Point the SDK at that URL. On-chain owner of a shipped app is Interlude; you keep the source, the frontend and the users.

A contract that is already live cannot be adopted. Delegated storage is declared at construction.

## Layout

- `sdk/` — TypeScript client (`createInterludeClient`, React hooks)
- `cli/` — Foundry helpers and the hosted `ship` command
- `docs/` — overview, security model, bring-a-contract

License: MIT.
