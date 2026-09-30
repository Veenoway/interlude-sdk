/**
 * The scaffolder behind `npx create-interlude-app`.
 *
 * It copies `template/` and substitutes one token. That is deliberately all it does: no install,
 * no `git init`, no network. A command a stranger runs with `npx` should leave nothing behind but
 * the files it printed, and every step it skips is a step the README names instead — so a failure
 * in `npm i` is the reader's familiar `npm i` failing, not a wrapper hiding it.
 *
 * Node built-ins only, because a scaffolder's own dependencies are downloaded on every run and
 * none of this needs one.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Replaced in every template file's contents with the project's name. */
export const NAME_TOKEN = "__APP_NAME__";

/**
 * Files npm will not publish under their real name, stored with a leading underscore instead.
 *
 * `npm pack` drops `.gitignore` from a tarball (it reads it as an ignore file), so a template
 * that ships one arrives without it and the first `git add .` commits `node_modules`. Every
 * create-* tool that ships a template meets this; the rename is the usual answer.
 */
export const RENAMES = {
  _gitignore: ".gitignore",
};

/**
 * `template/` beside this file.
 *
 * `fileURLToPath` and not `new URL(...).pathname`: the second leaves `%20` in a path with a
 * space in it, and `npx` lands packages under the home directory, where "John Doe" and
 * "Application Support" live. That exact bug broke the Interlude CLI's own bundled contracts.
 */
export function templateDir() {
  return fileURLToPath(new URL("../template/", import.meta.url));
}

export class ScaffoldError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScaffoldError";
  }
}

/**
 * npm's rules for a package name, which is what the project name becomes (`<name>-contracts`,
 * `<name>-web`). Checked rather than escaped, because a name npm refuses fails at `npm i`, one
 * step after the scaffolder said everything was fine.
 */
export function validateName(name) {
  if (typeof name !== "string" || name.length === 0) return "the name is empty";
  if (name.length > 200) return "the name is longer than 200 characters";
  if (name !== name.toLowerCase()) return "npm package names are lowercase";
  if (/^[._]/.test(name)) return "npm package names cannot start with . or _";
  if (!/^[a-z0-9][a-z0-9._~-]*$/.test(name)) {
    return "use lowercase letters, digits, and - . _ ~ only";
  }
  return null;
}

/**
 * A name from a directory, for when `--name` is not given.
 *
 * `My Game (v2)` becomes `my-game-v2`. Anything that leaves nothing usable, a directory called
 * `???`, falls back to `interlude-app` rather than refusing: the reader picked a directory, not
 * a package name, and should not have to learn npm's rules to get past step one.
 */
export function nameFromDir(dir) {
  const slug = basename(resolve(dir))
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, "-")
    .replace(/^[-._~]+/, "")
    .replace(/[-._~]+$/, "")
    .slice(0, 200);
  return validateName(slug) === null ? slug : "interlude-app";
}

/** Every file under `root`, as paths relative to it, in a stable order. */
export function listFiles(root) {
  const found = [];
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) found.push(relative(root, path));
    }
  };
  walk(root);
  return found;
}

/** Where a template file lands: renamed if npm would have eaten it, same place otherwise. */
export function targetPath(relativePath) {
  const parts = relativePath.split(sep);
  const last = parts[parts.length - 1];
  if (Object.prototype.hasOwnProperty.call(RENAMES, last)) {
    parts[parts.length - 1] = RENAMES[last];
  }
  return parts.join(sep);
}

/**
 * Anything already in `dir` other than what a fresh `git init` or an editor leaves.
 *
 * A non-empty directory is refused rather than merged into. Overwriting someone's
 * `package.json` or `foundry.toml` is not recoverable, and "merge a template into my repo" is a
 * different command with different questions. `.git` is tolerated because `mkdir x && cd x &&
 * git init` before scaffolding is a normal way to start.
 */
export function blockingEntries(dir) {
  if (!existsSync(dir)) return [];
  const harmless = new Set([".git", ".DS_Store", "Thumbs.db"]);
  return readdirSync(dir).filter((entry) => !harmless.has(entry));
}

/**
 * Copy the template into `dir` under `name`.
 *
 * @param {{ dir: string, name?: string, template?: string }} options
 * @returns {{ dir: string, name: string, files: string[] }} the absolute directory, the name
 *   used, and every file written, relative to `dir`
 */
export function scaffold({ dir, name, template = templateDir() }) {
  if (!dir) throw new ScaffoldError("which directory? npx create-interlude-app <dir>");
  const target = resolve(dir);

  const projectName = name ?? nameFromDir(target);
  const invalid = validateName(projectName);
  if (invalid) {
    throw new ScaffoldError(`"${projectName}" cannot be the project name: ${invalid}.`);
  }

  if (existsSync(target) && !statSync(target).isDirectory()) {
    throw new ScaffoldError(`${target} exists and is a file, not a directory.`);
  }
  const blocking = blockingEntries(target);
  if (blocking.length > 0) {
    const shown = blocking.slice(0, 5).join(", ") + (blocking.length > 5 ? ", ..." : "");
    throw new ScaffoldError(
      `${target} is not empty (${shown}). Pick a new directory: nothing is overwritten.`,
    );
  }

  const sources = listFiles(template);
  if (sources.length === 0) {
    throw new ScaffoldError(`the template at ${template} is empty; this install is broken.`);
  }

  // Every template file is text: the token is substituted everywhere, which is also why the
  // template holds no images. A binary added later would need to be copied, not decoded.
  const written = [];
  for (const source of sources) {
    const out = targetPath(source);
    const contents = readFileSync(join(template, source), "utf8").split(NAME_TOKEN).join(projectName);
    const destination = join(target, out);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
    written.push(out);
  }

  return { dir: target, name: projectName, files: written };
}
