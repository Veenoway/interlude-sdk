/**
 * The two processes a local stack is made of, and getting rid of them again.
 *
 * Shutdown gets as much attention as startup here. A command that leaves an `anvil` holding a
 * port is a command whose second run fails for a reason the reader did not cause, and the demo
 * scripts this replaces all grew a trap for exactly that.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { ArtifactError, run } from "./artifacts.js";

export interface Managed {
  name: string;
  child: ChildProcess;
  logPath: string;
  /** Set when the process never came into being, which a log file cannot tell you. */
  failedToStart?: string | undefined;
}

const running: Managed[] = [];

/** Ask everything to stop, then insist. */
export async function stopAll(): Promise<void> {
  const doomed = running.splice(0, running.length);
  for (const { child } of doomed) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
  }
  // A node with pending state commits it on the way out, which is worth waiting for: the
  // alternative is a session whose last batch never lands and has to be replayed at next boot.
  const deadline = Date.now() + 8_000;
  for (const { child } of doomed) {
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await sleep(50);
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

export function onExit(): void {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void stopAll().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

export interface AnvilOptions {
  port: number;
  blockTime: number;
  logDir: string;
}

export async function startAnvil(options: AnvilOptions): Promise<Managed> {
  const managed = launch(
    "anvil",
    "anvil",
    [
      "--port",
      String(options.port),
      "--block-time",
      String(options.blockTime),
      "--silent",
    ],
    process.cwd(),
    {},
    options.logDir,
  );
  await waitForRpc(`http://127.0.0.1:${options.port}`, managed, "the base chain");
  return managed;
}

export interface NodeOptions {
  baseRpc: string;
  hub: `0x${string}`;
  app: `0x${string}`;
  partition?: `0x${string}`;
  validatorKey: `0x${string}`;
  port: number;
  chainId: number;
  commitInterval: number;
  dataDir: string;
  logDir: string;
  /** Where to look for a built node, when one is not already on PATH. */
  checkout: string;
}

export async function startNode(options: NodeOptions): Promise<Managed> {
  const binary = await findNodeBinary(options.checkout);
  const env: Record<string, string> = {
    INTERLUDE_BASE_RPC: options.baseRpc,
    INTERLUDE_HUB: options.hub,
    INTERLUDE_APP: options.app,
    INTERLUDE_VALIDATOR_KEY: options.validatorKey,
    INTERLUDE_LISTEN: `127.0.0.1:${options.port}`,
    INTERLUDE_CHAIN_ID: String(options.chainId),
    INTERLUDE_COMMIT_SECS: String(options.commitInterval),
    INTERLUDE_DATA_DIR: options.dataDir,
    RUST_LOG: process.env["RUST_LOG"] ?? "info",
  };
  if (options.partition) env["INTERLUDE_PARTITION"] = options.partition;
  if (process.env["INTERLUDE_COMMIT_TOKEN"]) {
    env["INTERLUDE_COMMIT_TOKEN"] = process.env["INTERLUDE_COMMIT_TOKEN"];
  }

  const managed = launch("node", binary, [], process.cwd(), env, options.logDir);
  await waitForRpc(`http://127.0.0.1:${options.port}`, managed, "the node");
  return managed;
}

/**
 * A node binary, from wherever one can be had.
 *
 * Cargo is asked where it put the binary rather than guessed at. A target directory can be moved
 * by a `.cargo/config.toml`, a workspace above it or an environment variable, and a tool that
 * assumed `target/release/` would fail on a project that did any of those — reporting only that
 * a node exited immediately, which is nowhere near the truth.
 */
export async function findNodeBinary(checkout: string): Promise<string> {
  const override = process.env["INTERLUDE_NODE_BIN"];
  if (override) {
    if (!existsSync(override)) {
      throw new ArtifactError(`INTERLUDE_NODE_BIN points at ${override}, which is not there`);
    }
    return override;
  }

  const workspace = join(checkout, "packages", "node");
  if (existsSync(join(workspace, "Cargo.toml"))) {
    const output = await run(
      "cargo",
      ["build", "--release", "-p", "interlude-node", "--message-format=json"],
      workspace,
    );
    const built = executableFromCargo(output);
    if (built && existsSync(built)) return built;
    throw new ArtifactError(
      `cargo built interlude-node but did not say where. Set INTERLUDE_NODE_BIN to the binary.`,
    );
  }

  const onPath = binaryOnPath("interlude-node");
  if (onPath) return onPath;

  throw new ArtifactError(
    `interlude-node is not on PATH, and ${checkout} is not an Interlude checkout. ` +
      `The published CLI deploys the hub and generates the surface. It does not ship the Rust node.\n\n` +
      `  INTERLUDE_NODE_BIN=/path/to/interlude-node interlude dev\n\n` +
      `or run \`interlude ship\` instead: we deploy the bytecode and run the node. ` +
      `You do not need the binary.`,
  );
}

function binaryOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Cargo emits one JSON object per line; the one that matters names the executable it linked. */
function executableFromCargo(output: string): string | undefined {
  for (const line of output.split("\n").reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      const message = JSON.parse(line) as { executable?: string | null };
      if (message.executable && message.executable.endsWith("interlude-node")) {
        return message.executable;
      }
    } catch {
      /* not every line is a message we know */
    }
  }
  return undefined;
}

function launch(
  name: string,
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  logDir: string,
): Managed {
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${name}.log`);
  const log = createWriteStream(logPath, { flags: "w" });

  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);

  const managed: Managed = { name, child, logPath, failedToStart: undefined };
  // A process that never started writes nothing, so the readiness wait would report "it exited
  // before it was ready" and quote an empty log. Keeping the reason here is what turns that into
  // the actual problem, which is usually a missing binary.
  child.on("error", (error: NodeJS.ErrnoException) => {
    managed.failedToStart =
      error.code === "ENOENT"
        ? `${command} is not on PATH`
        : `${command} could not start: ${error.message}`;
  });

  running.push(managed);
  return managed;
}

/**
 * Poll until something answers `eth_chainId`, or until the process we are waiting on gives up.
 *
 * Watching the child matters more than the timeout: a node that refuses its session exits in
 * milliseconds with a precise reason in its log, and a command that waited thirty seconds and
 * then said "timed out" would have thrown that reason away.
 */
async function waitForRpc(url: string, managed: Managed, what: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (managed.failedToStart) throw new ArtifactError(`${what} never ran: ${managed.failedToStart}`);
    if (managed.child.exitCode !== null || managed.child.signalCode !== null) {
      throw new ArtifactError(
        `${what} exited before it was ready. What it said is in ${managed.logPath}:\n\n` +
          lastLines(managed.logPath, 12),
      );
    }
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (response.ok) {
        const body = (await response.json()) as { result?: string };
        if (body.result) return;
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      throw new ArtifactError(
        `${what} never answered on ${url}. Its log is ${managed.logPath}:\n\n` +
          lastLines(managed.logPath, 12),
      );
    }
    await sleep(100);
  }
}

function lastLines(path: string, count: number): string {
  try {
    return readFileSync(path, "utf8").trimEnd().split("\n").slice(-count).join("\n");
  } catch {
    return "(nothing was written to it)";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
