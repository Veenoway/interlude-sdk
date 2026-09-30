#!/usr/bin/env node
/**
 * `npx create-interlude-app <dir> [--name my-app]`
 *
 * A shell around `src/cli.js`, which parses and prints, and `src/scaffold.js`, which writes.
 * Kept this thin so the tests can call `run` directly and the process they also spawn runs
 * exactly the code they called.
 */

import { readFileSync } from "node:fs";
import { run } from "../src/cli.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

process.exitCode = run(process.argv.slice(2), {
  version,
  cwd: process.cwd(),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
