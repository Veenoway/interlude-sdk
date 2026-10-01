# create-interlude-app

## 0.1.2

- **Next.js 16.3.8.** The template pinned 16.3.4, inside the range of GHSA-vcvr-r3jv-pc5j
  (`next/og` `ImageResponse`, fixed in 16.3.6), so every first `npm i` in `web/` reported a
  critical vulnerability. The page does not use `next/og`; the pin moves anyway.
- **The page checks which app the node serves.** On load it asks `interlude.status()` and, when
  the node serves another contract (a node URL copied from elsewhere), shows the setup screen
  with both addresses instead of a live total of 0. A node that does not answer yet (a 502 while
  a freshly shipped machine starts) is named on the page and asked again every 5 s.
- **The slot test survives the first change to the contract.** It read fixed counts (one
  mapping, one scalar), so adding a variable and running `npm run gen` turned `npm test` red. It
  now takes the slots from the generated surface (`CLICKS_SLOT`, `TOTAL_SLOT`), checks that
  `clicks` and `total` are among those registered, and that their values live there.
- The project asks for `@interludelayer-sdk/cli@^0.2.2` and `@interludelayer-sdk/sdk@^0.2.2`:
  0.2.2's `gen` no longer sends a configured project to an `init` that refuses to run.
- Latency is stated as measured: one round trip, a few ms next to the node and ~40 ms over the
  network, where the description, both READMEs, `Clicker.sol` and the page's comments said
  "sub-millisecond" or "about a millisecond".
- Commands call the CLI by its scoped name, `npx @interludelayer-sdk/cli`, in the READMEs, the
  setup screen, `.env.example` and what the scaffolder prints: a bare `npx interlude` outside
  `contracts/` fetches an unrelated npm package.
- The `next.config.ts` comment on `agentRules: false` no longer names particular tools' files.

## 0.1.1

- The generated project asks for `@interludelayer-sdk/cli@^0.2.1` (`contracts/`) and
  `@interludelayer-sdk/sdk@^0.2.1` (`web/`): the releases that bundle the v3 hub for
  `interlude dev` and name the v3 public floors. `^0.2.0` also accepted 0.2.0, whose hub and
  floors predate v3.
- The project's README no longer says 0.2.0 may not be published yet.
- The project's README no longer says the node can be built from the `interlude-sdk`
  repository. It cannot: that repository carries the SDK, the CLI and this template. The local
  loop (`npm run dev` in `contracts/`) needs the Interlude monorepo's `interlude-node`; `ship`
  and the public floors need nothing.

## 0.1.0

First release: a Foundry contract (`Clicker`) and a Next.js page wired to an Interlude node.
