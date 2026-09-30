import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = fileURLToPath(new URL("../", import.meta.url));
export const bin = join(packageRoot, "bin", "create-interlude-app.js");
/** Interlude's own Solidity, in this repository: what the published CLI bundles. */
export const repoContracts = fileURLToPath(new URL("../../contracts/src/", import.meta.url));

/**
 * A scratch directory whose path has a space and an accent in it, because that is where `npx`
 * and real users put things ("Application Support", "John Doe", "Projets é"), and where the
 * Interlude CLI once broke on a `%20`.
 */
export function scratch(label = "with space é") {
  const dir = mkdtempSync(join(tmpdir(), `create interlude ${label} `));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
