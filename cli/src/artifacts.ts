/**
 * Finding compiled contracts, both the project's and Interlude's own.
 *
 * The compiler is the authority on what a contract is: its ABI, its bytecode and — for the
 * generator this command will grow into — its storage layout. Reading artifacts rather than
 * asking the developer to restate any of it is the whole idea.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Abi } from "viem";

export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactError";
  }
}

export interface Artifact {
  abi: Abi;
  bytecode: `0x${string}`;
}

/**
 * The directory holding `foundry.toml`, searched upwards from `from`.
 *
 * Upwards rather than exact, so the command works from a subdirectory the way `forge` does.
 */
export function findProjectRoot(from: string): string {
  let at = resolve(from);
  for (;;) {
    if (existsSync(join(at, "foundry.toml"))) return at;
    const up = dirname(at);
    if (up === at) {
      throw new ArtifactError(
        `no foundry.toml at or above ${from}. This command drives a Foundry project — ` +
          `run it where your contracts live.`,
      );
    }
    at = up;
  }
}

/**
 * Read one contract out of a Foundry `out/` directory.
 *
 * The obvious path is tried first and then the directory is searched, because Foundry files an
 * artifact under its *source file's* name. A contract declared in a file named after something
 * else is ordinary Solidity, and a tool that only understood the tidy case would reject projects
 * for a filing convention they never agreed to.
 */
export function readArtifact(outDir: string, name: string): Artifact {
  const path = existsSync(join(outDir, `${name}.sol`, `${name}.json`))
    ? join(outDir, `${name}.sol`, `${name}.json`)
    : searchForArtifact(outDir, name);

  if (!path) {
    throw new ArtifactError(
      `no compiled ${name} under ${outDir}. Check the contract name, and that forge build ` +
        `succeeded — this searched every artifact directory, not just ${name}.sol/.`,
    );
  }

  let parsed: { abi?: unknown; bytecode?: { object?: string } };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ArtifactError(`${path} is not readable JSON: ${(error as Error).message}`);
  }

  const object = parsed.bytecode?.object;
  if (!parsed.abi || !object) {
    throw new ArtifactError(`${path} carries no ABI or no bytecode`);
  }
  if (object === "0x" || object === "") {
    throw new ArtifactError(
      `${name} compiled to no bytecode, which is what an interface or an abstract contract ` +
        `does. Name the contract you want deployed.`,
    );
  }

  return {
    abi: parsed.abi as Abi,
    bytecode: (object.startsWith("0x") ? object : `0x${object}`) as `0x${string}`,
  };
}

function searchForArtifact(outDir: string, name: string): string | undefined {
  if (!existsSync(outDir)) return undefined;
  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(outDir, entry.name, `${name}.json`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** What a contract was compiled from, so artifacts belonging to tests can be told apart. */
export interface CompiledContract {
  name: string;
  /** Project-relative, as solc recorded it: `src/examples/Counter.sol`. */
  source: string;
  artifactPath: string;
}

/**
 * Every deployable contract in `out/`, with the source it came from.
 *
 * The source path is the part that matters. An `out/` directory holds the project's contracts,
 * its tests' mocks and its dependencies' contracts all together, and a tool that offered all of
 * them as candidates would be offering mostly noise.
 */
export function compiledContracts(outDir: string): CompiledContract[] {
  if (!existsSync(outDir)) return [];
  const found: CompiledContract[] = [];

  for (const dir of readdirSync(outDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of readdirSync(join(outDir, dir.name))) {
      if (!file.endsWith(".json")) continue;
      const artifactPath = join(outDir, dir.name, file);
      let parsed: {
        bytecode?: { object?: string };
        metadata?: { settings?: { compilationTarget?: Record<string, string> } };
      };
      try {
        parsed = JSON.parse(readFileSync(artifactPath, "utf8"));
      } catch {
        continue;
      }

      const object = parsed.bytecode?.object;
      if (!object || object === "0x") continue;

      const target = parsed.metadata?.settings?.compilationTarget ?? {};
      const source = Object.keys(target)[0];
      if (!source) continue;

      found.push({ name: file.replace(/\.json$/, ""), source, artifactPath });
    }
  }
  return found;
}

/** Read an artifact by its exact path, for callers that already located it. */
export function readArtifactAt(path: string): Artifact {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    abi?: unknown;
    bytecode?: { object?: string };
  };
  const object = parsed.bytecode?.object;
  if (!parsed.abi || !object) throw new ArtifactError(`${path} carries no ABI or no bytecode`);
  return {
    abi: parsed.abi as Abi,
    bytecode: (object.startsWith("0x") ? object : `0x${object}`) as `0x${string}`,
  };
}

/**
 * Where Interlude's own artifacts are, which is not where the project's are.
 *
 * Three places, in order of how deliberate they are: an explicit override, the copy shipped
 * beside this command, and the checkout it was run from. The last is what makes the repository's
 * own demos work, and it is why publishing needs the second — stated in the README rather than
 * pretended away.
 */
export function findInterludeOut(startFrom: string): string {
  const override = process.env["INTERLUDE_CONTRACTS_OUT"];
  if (override) {
    if (!existsSync(override)) {
      throw new ArtifactError(`INTERLUDE_CONTRACTS_OUT points at ${override}, which is not there`);
    }
    return override;
  }

  const bundled = bundledDir(import.meta.url, "artifacts");
  if (existsSync(join(bundled, "InterludeHub.sol"))) return bundled;

  let at = resolve(startFrom);
  for (;;) {
    const candidate = join(at, "packages", "contracts", "out");
    if (existsSync(join(candidate, "InterludeHub.sol"))) return candidate;
    const up = dirname(at);
    if (up === at) {
      throw new ArtifactError(
        `cannot find Interlude's compiled contracts. Point INTERLUDE_CONTRACTS_OUT at a ` +
          `forge out/ directory holding InterludeHub, or run this from an Interlude checkout ` +
          `where packages/contracts has been built.`,
      );
    }
    at = up;
  }
}

/**
 * A directory shipped beside this command — `artifacts/` or `contracts/` — one level above the
 * module that asks.
 *
 * `fileURLToPath` rather than `new URL(...).pathname`, and the difference is not cosmetic. A
 * URL's path is percent-encoded, so `~/Library/Application Support/...` or a home directory
 * named "José" came back as `Application%20Support` and `Jos%C3%A9` — directories that do not
 * exist — and the command then reported that its own bundled files were missing. On Windows the
 * pathname also keeps a slash in front of the drive letter. The same call works from `src/`
 * under tsx and from `dist/` once bundled, because both sit one level below the package root.
 */
export function bundledDir(moduleUrl: string, name: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "..", name);
}

/** Compile the project, so nothing downstream is reasoning about a stale artifact. */
export async function forgeBuild(cwd: string): Promise<void> {
  await run("forge", ["build"], cwd);
}

export function run(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", (error) => {
      rejectRun(
        new ArtifactError(
          error.message.includes("ENOENT")
            ? `${command} is not on PATH. Foundry provides forge, cast and anvil: ` +
              `https://getfoundry.sh`
            : `${command} could not start: ${error.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      if (code === 0) resolveRun(out);
      else rejectRun(new ArtifactError(`${command} ${args.join(" ")} failed:\n${err || out}`));
    });
  });
}
