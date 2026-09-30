/**
 * Parse `create-interlude-app`'s arguments, run the scaffold, print what to do next.
 *
 * The next steps are printed with the directory the reader actually typed, quoted when it has a
 * space in it, because the first thing anyone does is paste the `cd` line — and an unquoted
 * `cd My Game` goes to a directory that does not exist.
 */

import { relative, resolve } from "node:path";
import { scaffold, ScaffoldError } from "./scaffold.js";

export const USAGE = `create-interlude-app — a Foundry contract and a Next.js page, wired to an Interlude node

  npx create-interlude-app <dir> [--name my-app]

  <dir>           where to write the project; must be empty or not exist yet
  --name <name>   the npm name of the project (default: from <dir>)
  --help          this
  --version       the scaffolder's version

What you get:
  contracts/   Foundry project: Clicker.sol, its generated surface, a test, interlude.toml
  web/         Next.js app: connect a wallet, sign once, click with no gas and no prompt
  README.md    the five commands from here to a live delegated app on Monad testnet`;

/**
 * @param {string[]} argv
 * @param {{ version: string, cwd: string, out: (line: string) => void, err: (line: string) => void }} io
 * @returns {number} the exit code
 */
export function run(argv, io) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof ScaffoldError) {
      io.err(`error ${error.message}`);
      io.err("");
      io.err(USAGE);
      return 1;
    }
    throw error;
  }

  if (parsed.help) {
    io.out(USAGE);
    return 0;
  }
  if (parsed.version) {
    io.out(io.version);
    return 0;
  }
  if (!parsed.dir) {
    io.err("error which directory? npx create-interlude-app <dir>");
    io.err("");
    io.err(USAGE);
    return 1;
  }

  let result;
  try {
    result = scaffold({
      dir: resolve(io.cwd, parsed.dir),
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
    });
  } catch (error) {
    if (error instanceof ScaffoldError) {
      io.err(`error ${error.message}`);
      return 1;
    }
    throw error;
  }

  const shown = relative(io.cwd, result.dir) || ".";
  const cd = shellQuote(shown);
  io.out(`Created ${result.name} in ${result.dir} (${result.files.length} files).`);
  io.out("");
  io.out("Next, from zero to a live delegated app on Monad testnet:");
  io.out("");
  io.out(`  cd ${cd}/contracts`);
  io.out("  npm i");
  io.out("  npm run build        # vendors Interlude's contracts, compiles, checks the surface");
  io.out("  npx interlude ship --owner <your address> --out ../web/.env.local");
  io.out("  cd ../web && npm i && npm run dev");
  io.out("");
  io.out("Needs Foundry (forge) on PATH: https://getfoundry.sh. README.md explains what you");
  io.out("are trusting, how ownership is handed to you, and the limits worth knowing first.");
  return 0;
}

/**
 * Hand-rolled rather than `util.parseArgs`, for the one thing that one does not do: a clear
 * sentence when `--name` is given no value, instead of taking the directory as the name.
 */
export function parseArgs(argv) {
  const parsed = { dir: undefined, name: undefined, help: false, version: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--version" || arg === "-v") parsed.version = true;
    else if (arg === "--name" || arg.startsWith("--name=")) {
      const value = arg === "--name" ? argv[++i] : arg.slice("--name=".length);
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new ScaffoldError("--name needs a value: --name my-app");
      }
      parsed.name = value;
    } else if (arg.startsWith("-")) {
      throw new ScaffoldError(`unknown option ${arg}`);
    } else if (parsed.dir === undefined) {
      parsed.dir = arg;
    } else {
      throw new ScaffoldError(`one directory at a time (got "${parsed.dir}" and "${arg}")`);
    }
  }
  return parsed;
}

/** Quote a path for a POSIX shell only when it needs it, so the common case stays readable. */
export function shellQuote(path) {
  if (/^[A-Za-z0-9_./-]+$/.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}
