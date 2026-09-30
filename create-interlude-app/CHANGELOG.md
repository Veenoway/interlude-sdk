# create-interlude-app

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
