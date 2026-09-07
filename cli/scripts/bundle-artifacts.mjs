/**
 * Copy the hub artifact the CLI deploys into this package, slimmed to ABI + bytecode.
 *
 * Publishing without this file means `interlude dev` only works inside an Interlude
 * checkout or with INTERLUDE_CONTRACTS_OUT. The full Foundry JSON is not shipped:
 * metadata alone is larger than the command, and readArtifact only needs two fields.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const candidates = [
  join(repo, "packages/contracts/out/InterludeHub.sol/InterludeHub.json"),
  join(repo, "out/InterludeHub.sol/InterludeHub.json"),
];

const source = candidates.find((path) => existsSync(path));
if (!source) {
  console.error(
    "no compiled InterludeHub. Run `forge build` from the repository root, then this script.",
  );
  process.exit(1);
}

const parsed = JSON.parse(readFileSync(source, "utf8"));
const object = parsed.bytecode?.object;
if (!parsed.abi || !object || object === "0x") {
  console.error(`${source} has no ABI or no bytecode`);
  process.exit(1);
}

const destDir = join(here, "../artifacts/InterludeHub.sol");
mkdirSync(destDir, { recursive: true });
const dest = join(destDir, "InterludeHub.json");
writeFileSync(dest, `${JSON.stringify({ abi: parsed.abi, bytecode: { object } }, null, 2)}\n`);
console.log(`wrote ${dest}`);
