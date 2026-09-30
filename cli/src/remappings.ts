/**
 * Point a Foundry project at Interlude's Solidity sources.
 *
 * `init` used to fail unless the project already inherited Delegatable, and inheriting
 * Delegatable used to fail unless the remapping was already written. That circle is why a
 * first-time run looked like the command was broken. Writing the remapping first is the
 * whole job of this module.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ArtifactError, bundledDir } from "./artifacts.js";

export const CONTRACTS_REMAPPING = "@interludelayer/contracts/";

/**
 * Directory that contains `Delegatable.sol`.
 *
 * Three places, same order as the hub artifacts: an explicit override, the checkout this
 * was run from, then the copy shipped beside the command.
 */
export function findInterludeContracts(startFrom: string): string {
  const override = process.env["INTERLUDE_CONTRACTS"];
  if (override) {
    if (!existsSync(join(override, "Delegatable.sol"))) {
      throw new ArtifactError(
        `INTERLUDE_CONTRACTS points at ${override}, which has no Delegatable.sol`,
      );
    }
    return resolve(override);
  }

  let at = resolve(startFrom);
  for (;;) {
    const candidate = join(at, "packages", "contracts", "src");
    if (existsSync(join(candidate, "Delegatable.sol"))) return candidate;
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }

  const bundled = bundledDir(import.meta.url, "contracts");
  if (existsSync(join(bundled, "Delegatable.sol"))) return bundled;

  throw new ArtifactError(
    `cannot find Interlude's Solidity sources. Point INTERLUDE_CONTRACTS at the directory ` +
      `holding Delegatable.sol, or run this from an Interlude checkout.`,
  );
}

export function remappingLine(projectRoot: string, contractsDir: string): string {
  let rel = relative(resolve(projectRoot), resolve(contractsDir));
  if (rel === "") rel = ".";
  const posix = rel.split(sep).join("/");
  const withSlash = posix.endsWith("/") ? posix : `${posix}/`;
  return `${CONTRACTS_REMAPPING}=${withSlash}`;
}

/**
 * Foundry will not read a remapping that leaves the project. `npx` lands the bundled
 * sources in a cache under the home directory; a relative path to that cache compiles
 * as "file outside of allowed directories". Copying into `lib/interlude` is the same
 * shape as forge-std, and `lib/` is always allowed.
 *
 * Sources already inside the project are left where they are: that is the Interlude
 * checkout, and a second copy under lib/ would drift. The exception is a copy inside the
 * project's own `node_modules/` (`npm i -D @interludelayer-sdk/cli`): pointing the remapping
 * there compiles today and breaks on the next `npm ci`, pnpm's store layout or a pruned
 * install, so it is vendored like the `npx` case — which is also what the README promises.
 */
export function vendorContracts(projectRoot: string, contractsDir: string): string {
  const from = resolve(contractsDir);
  const root = resolve(projectRoot);
  const inside = from === root || from.startsWith(`${root}${sep}`);
  const installed = from.split(sep).includes("node_modules");
  if (inside && !installed) return from;

  const dest = join(root, "lib", "interlude");
  mkdirSync(dest, { recursive: true });
  cpSync(from, dest, { recursive: true });
  return dest;
}

export function ensureRemapping(
  projectRoot: string,
  contractsDir: string,
): { path: string; wrote: boolean; line: string } {
  const local = vendorContracts(projectRoot, contractsDir);
  const path = join(projectRoot, "remappings.txt");
  const line = remappingLine(projectRoot, local);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const rows = existing.split(/\r?\n/);
  if (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  const at = rows.findIndex((row) => row.startsWith(`${CONTRACTS_REMAPPING}=`));
  if (at >= 0 && rows[at] === line) {
    return { path, wrote: false, line };
  }
  if (at >= 0) rows[at] = line;
  else rows.push(line);
  writeFileSync(path, `${rows.join("\n")}\n`);
  return { path, wrote: true, line };
}
