/**
 * What every command needs to know about the Foundry project it was run in.
 *
 * `init`, `ship` and the new commands each used to carry their own copy of "which directory holds
 * the sources", "which contracts inherit Delegatable" and "read a flag". Three copies had already
 * drifted — `ship` named a missing contract without listing the ones that exist, `init` did —
 * so they live here once.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { ArtifactError, compiledContracts, readArtifactAt, type CompiledContract } from "./artifacts.js";
import { generatedFileName } from "./generate.js";

export function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

/** Foundry's source directory, which a project may have renamed. */
export function sourceDir(projectRoot: string): string {
  const config = join(projectRoot, "foundry.toml");
  if (!existsSync(config)) return "src";
  const found = /^\s*src\s*=\s*["']([^"']+)["']/m.exec(readFileSync(config, "utf8"));
  return found?.[1]?.replace(/\/$/, "") ?? "src";
}

/**
 * The project's own contracts that inherit Delegatable, found by `delegateAll` in the ABI.
 *
 * The ABI is what the compiler concluded, so an import alias or a base contract two levels up
 * cannot fool it. Sources only: `out/` also holds the tests' mocks and every dependency's
 * contracts, and offering those would be offering mostly noise.
 */
export function delegatableContracts(projectRoot: string): CompiledContract[] {
  const src = sourceDir(projectRoot);
  return compiledContracts(join(projectRoot, "out"))
    .filter((contract) => contract.source.startsWith(`${src}/`))
    .filter((contract) =>
      readArtifactAt(contract.artifactPath).abi.some(
        (item) => item.type === "function" && item.name === "delegateAll",
      ),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The one contract a command should act on, or a message saying why there is no such one.
 *
 * Choosing for the reader when there are several would be worse than asking: a config naming the
 * wrong contract stands up a whole stack around it and fails somewhere that does not mention this
 * decision.
 */
export function chooseContract(
  candidates: CompiledContract[],
  wanted: string | undefined,
): CompiledContract {
  const chosen = wanted
    ? candidates.find((contract) => contract.name === wanted)
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  if (chosen) return chosen;

  const list = candidates.map((c) => `  ${c.name.padEnd(20)} ${c.source}`).join("\n");
  if (wanted) {
    throw new ArtifactError(
      candidates.length === 0
        ? `no contract under src/ named ${wanted} inherits Delegatable (none does yet).`
        : `no delegatable contract named ${wanted}. This project has:\n${list}`,
    );
  }
  throw new ArtifactError(
    candidates.length === 0
      ? `nothing under src/ inherits Delegatable yet.`
      : `this project has ${candidates.length} delegatable contracts, so which one is meant ` +
          `is yours to say:\n${list}\n\n  --contract <name>`,
  );
}

/**
 * Evidence that a contract hands storage over per key.
 *
 * The hosted path serves one partition per app — `GLOBAL` — and nothing else: control opens and
 * provisions only that one. A per-key surface would therefore ship, deploy, delegate, get a node,
 * and then have every write to a keyed partition refused by a node that was never told the key
 * existed. Saying so before the deploy is the only kind answer.
 *
 * Read from the contract's own source and from the generated surface beside it, which between
 * them hold every `_registerPerKey` a project can make: `gen` writes the one, a hand-written
 * registration sits in the other. Comments are stripped first so an explanation that mentions
 * the call does not count as making it.
 */
export function perKeyEvidence(projectRoot: string, contract: CompiledContract): string[] {
  const found: string[] = [];
  const sourcePath = join(projectRoot, contract.source);
  const generatedPath = join(dirname(sourcePath), generatedFileName(contract.name));

  for (const path of [sourcePath, generatedPath]) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const relative = path.slice(projectRoot.length + 1);
    if (/_registerPerKey\s*\(/.test(stripComments(text))) {
      found.push(`${relative} calls _registerPerKey`);
    }
    for (const line of text.split("\n")) {
      if (/@custom:interlude\s+per-key/.test(line)) {
        found.push(`${relative} marks a variable "per-key"`);
        break;
      }
    }
  }
  return found;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * The part of `foundry.toml` that decides whether Interlude's sources compile at all.
 *
 * The vendored contracts say `pragma ^0.8.28` and use `tstore`, which needs the Cancun EVM. A
 * project that pins an older compiler or EVM gets a solc error pointing inside `lib/interlude`,
 * which reads as our bug rather than a setting — so the setting is named here, before forge runs.
 */
export const REQUIRED_SOLC = "0.8.28";
const PRE_CANCUN = [
  "homestead",
  "tangerinewhistle",
  "spuriousdragon",
  "byzantium",
  "constantinople",
  "petersburg",
  "istanbul",
  "berlin",
  "london",
  "paris",
  "shanghai",
];

export function toolchainWarnings(foundryToml: string, profile = "default"): string[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(foundryToml) as Record<string, unknown>;
  } catch {
    return [];
  }
  const profiles = (parsed["profile"] ?? {}) as Record<string, Record<string, unknown>>;
  // A named profile inherits from default, so a setting in either is the one forge uses.
  const settings = { ...(profiles["default"] ?? {}), ...(profiles[profile] ?? {}) };
  const warnings: string[] = [];

  const solc = settings["solc"] ?? settings["solc_version"];
  if (typeof solc === "string") {
    const version = /(\d+)\.(\d+)\.(\d+)/.exec(solc);
    if (version && compareVersions(version.slice(1).map(Number), [0, 8, 28]) < 0) {
      warnings.push(
        `foundry.toml pins solc ${solc}. Interlude's contracts need ${REQUIRED_SOLC} or later ` +
          `(pragma ^${REQUIRED_SOLC}): set solc = "${REQUIRED_SOLC}", or remove the pin.`,
      );
    }
  }

  const evm = settings["evm_version"];
  if (typeof evm === "string" && PRE_CANCUN.includes(evm.toLowerCase())) {
    warnings.push(
      `foundry.toml sets evm_version = "${evm}". Interlude's contracts use transient storage ` +
        `(tstore), which needs "cancun" or later: set evm_version = "cancun", or remove it.`,
    );
  }
  return warnings;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function readToolchainWarnings(projectRoot: string): string[] {
  const path = join(projectRoot, "foundry.toml");
  if (!existsSync(path)) return [];
  return toolchainWarnings(readFileSync(path, "utf8"), process.env["FOUNDRY_PROFILE"] ?? "default");
}
