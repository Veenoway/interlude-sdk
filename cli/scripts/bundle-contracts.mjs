/**
 * Copy the Solidity a team inherits into this package.
 *
 * The hub bytecode is a different file: that is what `dev` deploys. This is what their
 * contract imports. Publishing without it means `@interludelayer/contracts/Delegatable.sol`
 * only resolves inside an Interlude checkout.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const src = join(repo, "packages/contracts/src");
const dest = join(here, "../contracts");

const files = [
  "Delegatable.sol",
  "interfaces/IDelegatableApp.sol",
  "interfaces/IInterludeHub.sol",
  "interfaces/Types.sol",
  "libraries/Delegated.sol",
  "libraries/DelegatedLayout.sol",
  "libraries/Session.sol",
];

if (!existsSync(join(src, "Delegatable.sol"))) {
  console.error(`no Delegatable.sol under ${src}`);
  process.exit(1);
}

for (const file of files) {
  const from = join(src, file);
  if (!existsSync(from)) {
    console.error(`missing ${from}`);
    process.exit(1);
  }
  const to = join(dest, file);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

console.log(`wrote ${files.length} sources under ${dest}`);
