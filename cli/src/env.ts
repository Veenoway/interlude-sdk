import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write `NAME=value` lines into an env file, merged rather than written over.
 *
 * A project with more than one node — one per demo, on its own port — would otherwise lose the
 * other one's settings every time this ran, and that failure looks like the other demo breaking
 * on its own. Lines this does not own, comments included, are kept where they were.
 */
export function mergeEnv(path: string, vars: Record<string, string>): void {
  const names = Object.keys(vars);
  const kept = existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "" && !names.some((name) => line.startsWith(`${name}=`)))
    : [];
  const ours = Object.entries(vars).map(([name, value]) => `${name}=${value}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [...kept, ...ours, ""].join("\n"));
}
