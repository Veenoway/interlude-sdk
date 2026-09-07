/**
 * Working out which storage a node should be handed, from the compiler rather than from the
 * developer.
 *
 * The division of labour here is the whole point. Slot numbers come from solc's storage layout,
 * because a slot written by hand is a slot that can be wrong. Which variables are delegated
 * comes from an annotation in the source, because that is a decision only the author can make,
 * and because a reviewer reading the contract should be able to see which state leaves the
 * chain.
 *
 * The two are matched by name. A missed annotation therefore produces a *missing* entry, which
 * the developer sees, and never a wrong slot, which nobody would.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toHex } from "viem";
import { ArtifactError, run } from "./artifacts.js";

/** How a variable is handed over. */
export type Mode = "global" | "per-key";

export interface DelegatedVariable {
  name: string;
  /** The slot solc assigned. For a mapping, the base its entries hash against. */
  slot: bigint;
  /** solc's type identifier, kept verbatim so the fingerprint notices a type change. */
  type: string;
  /** The readable form, for comments in generated code. */
  label: string;
  mode: Mode;
  kind: "scalar" | "mapping";
  /** Where it was declared, which is not always the contract being generated for. */
  declaredIn: string;
}

export interface Surface {
  contract: string;
  source: string;
  variables: DelegatedVariable[];
  /**
   * A commitment to every fact the generated code depends on.
   *
   * This is what makes the generator safe to use rather than merely convenient. Insert a
   * variable above a delegated one and every slot below it shifts; the generated file would go
   * on naming the old numbers and the app would hand a node somebody else's storage. Recomputing
   * this and comparing is how that gets caught, and it is why `interlude check` exists.
   */
  fingerprint: `0x${string}`;
}

interface LayoutEntry {
  label: string;
  slot: string;
  offset: number;
  type: string;
  contract: string;
}

interface RawLayout {
  storage: LayoutEntry[];
  types: Record<string, { label: string; numberOfBytes: string; encoding: string }>;
}

const ANNOTATION = /@custom:interlude\s+(global|per-key)/;

/**
 * Read one contract's delegated surface.
 *
 * `forge inspect` rather than the artifact on disk, because a project has to opt into
 * `storageLayout` in `foundry.toml` for it to be filed, and requiring that would be one more
 * step between a developer and a working stack.
 */
export async function readSurface(projectRoot: string, contract: string): Promise<Surface> {
  const raw = await inspectLayout(projectRoot, contract);
  const annotated = annotationsFor(projectRoot, raw.storage);

  const variables: DelegatedVariable[] = [];
  for (const entry of raw.storage) {
    const mode = annotated.get(`${entry.contract}#${entry.label}`);
    if (!mode) continue;

    const type = raw.types[entry.type];
    if (!type) throw new ArtifactError(`solc described ${entry.label} with no type information`);

    variables.push({
      name: entry.label,
      slot: BigInt(entry.slot),
      type: entry.type,
      label: type.label,
      mode,
      kind: classify(entry, type, mode),
      declaredIn: entry.contract,
    });
  }

  if (variables.length === 0) {
    throw new ArtifactError(
      `nothing in ${contract} is marked for delegation. Put a comment above each state variable ` +
        `a node should hold:\n\n` +
        `  /// @custom:interlude global\n  mapping(address => uint256) internal balances;\n\n` +
        `"global" hands the variable over as one partition. "per-key" makes each mapping key its ` +
        `own, which suits a room or a single user.`,
    );
  }

  refuseSharedSlots(raw, variables, contract);

  return {
    contract,
    source: variables[0]!.declaredIn.split(":")[0] ?? "",
    variables,
    fingerprint: fingerprintOf(contract, variables),
  };
}

async function inspectLayout(projectRoot: string, contract: string): Promise<RawLayout> {
  const inspect = (extra: string[]) =>
    run("forge", ["inspect", contract, "storageLayout", "--json", ...extra], projectRoot);

  let output: string;
  try {
    output = await inspect([]);
  } catch (cached) {
    // Foundry files an artifact without a storage layout when nothing asked for one, and then
    // serves it from cache to the call that does. Recompiling is the documented way out, and it
    // is worth doing quietly: a developer who has never seen this has no reason to know that
    // "missing from artifact" means "ask again".
    if (!/storage layout missing/i.test(String(cached))) throw cached;
    output = await inspect(["--no-cache"]);
  }

  try {
    const parsed = JSON.parse(output) as RawLayout;
    return { storage: parsed.storage ?? [], types: parsed.types ?? {} };
  } catch {
    throw new ArtifactError(
      `forge could not describe ${contract}'s storage. Check the contract name.`,
    );
  }
}

/**
 * Find the annotations, by reading the sources solc says the variables were declared in.
 *
 * Reading the source is the part of this that could go wrong, so nothing load-bearing rests on
 * it: this decides only *whether* a variable is delegated, and the slot it will be delegated at
 * always comes from the layout. A comment this fails to see produces a variable that is not
 * handed over, which is visible in the generated file and in the delegated surface on chain.
 */
function annotationsFor(projectRoot: string, storage: LayoutEntry[]): Map<string, Mode> {
  const found = new Map<string, Mode>();
  const sources = new Set(storage.map((entry) => entry.contract.split(":")[0]!));

  for (const source of sources) {
    let text: string;
    try {
      text = readFileSync(join(projectRoot, source), "utf8");
    } catch {
      // A variable inherited from a dependency whose source is not where solc said. Nothing to
      // annotate there anyway: a library the project does not own is not its state to delegate.
      continue;
    }

    const lines = text.split("\n");
    for (let at = 0; at < lines.length; at += 1) {
      const annotation = ANNOTATION.exec(lines[at]!);
      if (!annotation) continue;

      const name = declaredNameBelow(lines, at + 1);
      if (!name) continue;

      // Keyed by source too, so two contracts in one project may each have a `balances`.
      for (const entry of storage) {
        if (entry.label === name && entry.contract.startsWith(`${source}:`)) {
          found.set(`${entry.contract}#${name}`, annotation[1] as Mode);
        }
      }
    }
  }
  return found;
}

/**
 * The name of the state variable an annotation sits above.
 *
 * Comment lines in between are skipped, because an annotation is rarely the only thing said
 * about a variable. Anything else ends the search: an annotation followed by a function is an
 * annotation on the wrong thing, and guessing further would be inventing intent.
 */
export function declaredNameBelow(lines: string[], from: number): string | undefined {
  let declaration = "";
  for (let at = from; at < lines.length && at < from + 12; at += 1) {
    const line = lines[at]!.trim();
    if (line === "" || line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) {
      continue;
    }
    // A declaration may wrap, so read on until it ends.
    declaration += ` ${line}`;
    if (!line.includes(";")) continue;

    // The name is the last thing said before the type is done being described. `=>` has to go
    // first or a mapping's arrow reads as an initialiser and the key type reads as the name.
    const beforeInitialiser = declaration
      .slice(0, declaration.indexOf(";"))
      .replace(/=>/g, " ")
      .split("=")[0]!;
    const words = beforeInitialiser.match(/[A-Za-z_]\w*/g);
    return words?.[words.length - 1];
  }
  return undefined;
}

function classify(
  entry: LayoutEntry,
  type: { encoding: string; label: string; numberOfBytes: string },
  mode: Mode,
): "scalar" | "mapping" {
  if (type.encoding === "mapping") {
    // The hub commits one 32-byte value per slot, so a mapping whose value spreads over several
    // slots — a nested mapping, a struct, a dynamic array — has nothing a diff could carry.
    if (!/=>\s*(uint256|bytes32|address|bool|int256)\s*\)$/.test(type.label)) {
      throw new ArtifactError(
        `${entry.label} is ${type.label}. A delegated mapping has to hold a single 32-byte ` +
          `value, because a commit moves one slot at a time. Keep this one on the base chain, ` +
          `or flatten it into a mapping this can express.`,
      );
    }
    return "mapping";
  }

  if (mode === "per-key") {
    throw new ArtifactError(
      `${entry.label} is ${type.label}, not a mapping, so "per-key" has nothing to key on. ` +
        `Use "global".`,
    );
  }
  if (type.encoding !== "inplace" || BigInt(type.numberOfBytes) > 32n) {
    throw new ArtifactError(
      `${entry.label} is ${type.label}, which does not live in a single slot. Dynamic arrays, ` +
        `strings and structs spread across storage, and one slot is the unit a commit moves.`,
    );
  }
  return "scalar";
}

/**
 * Refuse a delegated variable that shares its slot with anything.
 *
 * solc packs small types together, and a slot is what gets handed over — so delegating a `bool`
 * sharing slot 3 with two `uint64`s would hand a node the neighbours as well, silently. There is
 * no way to express "part of a slot" to the hub, so the honest answer is to decline.
 */
function refuseSharedSlots(raw: RawLayout, variables: DelegatedVariable[], contract: string): void {
  for (const variable of variables) {
    if (variable.kind === "mapping") continue;

    const sharers = raw.storage.filter(
      (entry) =>
        BigInt(entry.slot) === variable.slot &&
        entry.contract === variable.declaredIn &&
        entry.label !== variable.name,
    );
    if (sharers.length > 0) {
      throw new ArtifactError(
        `${contract}.${variable.name} shares slot ${variable.slot} with ` +
          `${sharers.map((s) => s.label).join(", ")}. A slot is what gets handed to a node, so ` +
          `delegating this one would hand over its neighbours too. Give it a slot of its own — ` +
          `declaring it as uint256, or moving it, is enough.`,
      );
    }
  }
}

/** Canonical, ordered, and covering everything the generated code asserts. */
export function fingerprintOf(contract: string, variables: DelegatedVariable[]): `0x${string}` {
  const canonical = [
    contract,
    ...variables
      .map((v) => `${v.declaredIn}#${v.name}:${v.slot}:${v.type}:${v.mode}`)
      .sort(),
  ].join("\n");
  return keccak256(toHex(canonical));
}
