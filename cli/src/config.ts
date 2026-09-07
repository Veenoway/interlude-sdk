/**
 * `interlude.toml`: what a project has to say about itself before a node can serve it.
 *
 * TOML rather than JSON because the reader already keeps a `foundry.toml`, and a second config
 * language in the same directory is a tax on nobody's behalf.
 *
 * Everything that can have a default has one, so the smallest working file is five lines:
 *
 * ```toml
 * [app]
 * contract = "Counter"
 * args = ["$HUB"]
 * ```
 *
 * The defaults are not arbitrary — they are the numbers the demo scripts in this repository
 * converged on after being written five times.
 */

import { parse as parseToml } from "smol-toml";

/** Thrown with a message meant for the person editing the file, not for a stack trace. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * A call to make after the app is deployed and before the partition is handed over.
 *
 * The ordering is a constraint rather than a convenience: once a partition is delegated, the
 * write guard refuses base-chain writes to it, so seeding afterwards fails. Anything that has
 * to touch delegated state from the outside belongs here.
 */
export interface SetupCall {
  /** A human-readable signature, e.g. `credit(address,uint256)`. */
  signature: string;
  args: string[];
  /** Wei to attach, as a decimal string. */
  value?: string;
}

export interface AppConfig {
  /**
   * A Foundry artifact name, deployed by the CLI with `args`. Enough for any app whose setup a
   * constructor can express, which is most of them, and it means no deploy script to write.
   */
  contract?: string;
  /**
   * A Foundry script, for apps whose bring-up a constructor cannot express. Escape hatch rather
   * than the main road: it puts the hub's own bootstrap back in the project's hands, which is
   * the duplication this command exists to remove.
   */
  script?: string;
  /** Which logged contract name to read the app's address from, when using `script`. */
  addressFrom?: string;
  args: string[];
  /**
   * `"all"` delegates the whole contract under `GLOBAL`. A 32-byte value delegates that one key,
   * which is the right shape for a room or a single user's state.
   */
  delegate: "all" | `0x${string}`;
  setup: SetupCall[];
}

export interface ChainConfig {
  port: number;
  /** Seconds. Monad's is 0.4; the demos use 0.3 so nothing looks tuned to flatter us. */
  blockTime: number;
}

export interface NodeConfig {
  port: number;
  /**
   * Must differ from the base chain's, or `Delegatable.isEphemeral()` returns false and every
   * delegated write reverts. The node refuses to start otherwise, so this is a fast failure
   * rather than a silent one.
   */
  chainId: number;
  /** Seconds between commits. */
  commitInterval: number;
  dataDir: string;
}

export interface EnvConfig {
  /** Written relative to the config file, and merged rather than clobbered. */
  file: string;
  vars: Record<string, string>;
}

export interface Config {
  app: AppConfig;
  chain: ChainConfig;
  node: NodeConfig;
  env?: EnvConfig;
}

const DEFAULTS = {
  chain: { port: 8547, blockTime: 0.3 },
  node: {
    port: 8555,
    chainId: 4242,
    commitInterval: 5,
    dataDir: ".interlude/data",
  },
} as const;

/**
 * Every placeholder a config file may use, resolved once the thing it names exists.
 *
 * Addresses are not knowable when the file is written — the hub is deployed by this command —
 * so a config that could only name literals would be a config nobody could write.
 */
export const PLACEHOLDERS = [
  "$HUB",
  "$APP",
  "$ADMIN",
  "$VALIDATOR",
  "$RESOLVER",
  "$BASE_RPC",
  "$NODE_RPC",
] as const;

export type Placeholder = (typeof PLACEHOLDERS)[number];

export function substitute(value: string, values: Partial<Record<Placeholder, string>>): string {
  let out = value;
  for (const name of PLACEHOLDERS) {
    const replacement = values[name];
    if (replacement !== undefined) out = out.split(name).join(replacement);
  }
  // A leftover placeholder means the file asked for something that does not exist at this point
  // in the bring-up — `$APP` in a constructor argument, say. Substituting nothing would send a
  // literal dollar sign to the chain and fail somewhere much less legible.
  const leftover = PLACEHOLDERS.find((name) => out.includes(name));
  if (leftover) {
    throw new ConfigError(
      `${leftover} is not known yet where it is used (in "${value}"). ` +
        `The hub exists before the app does, so $APP cannot appear in the app's own constructor ` +
        `arguments; use it in [[setup]] or [env] instead.`,
    );
  }
  return out;
}

export function parseConfig(source: string, path: string): Config {
  let raw: unknown;
  try {
    raw = parseToml(source);
  } catch (error) {
    throw new ConfigError(`${path} is not valid TOML: ${(error as Error).message}`);
  }
  if (!isTable(raw)) throw new ConfigError(`${path} is empty`);

  const app = table(raw, "app", path);
  if (!app) {
    throw new ConfigError(
      `${path} has no [app] section, so there is nothing to hand to a node. ` +
        `The smallest one names a contract and its constructor arguments:\n\n` +
        `  [app]\n  contract = "Counter"\n  args = ["$HUB"]`,
    );
  }

  const contract = optionalString(app, "contract", "app", path);
  const script = optionalString(app, "script", "app", path);
  if (contract && script) {
    throw new ConfigError(
      `${path}: [app] names both contract = "${contract}" and script = "${script}". ` +
        `Pick one — either this command deploys the app, or your script does.`,
    );
  }
  if (!contract && !script) {
    throw new ConfigError(
      `${path}: [app] needs either contract = "<artifact name>" for this command to deploy it, ` +
        `or script = "<path>:<contract>" for a Foundry script to.`,
    );
  }

  return {
    app: {
      contract,
      script,
      addressFrom: optionalString(app, "address_from", "app", path),
      args: stringList(app, "args", "app", path),
      delegate: delegateTarget(app, path),
      setup: setupCalls(raw, path),
    },
    chain: {
      port: number(table(raw, "chain", path), "port", DEFAULTS.chain.port, "chain", path),
      blockTime: number(
        table(raw, "chain", path),
        "block_time",
        DEFAULTS.chain.blockTime,
        "chain",
        path,
      ),
    },
    node: nodeConfig(table(raw, "node", path), path),
    env: envConfig(table(raw, "env", path), path),
  };
}

function nodeConfig(node: Record<string, unknown> | undefined, path: string): NodeConfig {
  return {
    port: number(node, "port", DEFAULTS.node.port, "node", path),
    chainId: number(node, "chain_id", DEFAULTS.node.chainId, "node", path),
    commitInterval: number(node, "commit_interval", DEFAULTS.node.commitInterval, "node", path),
    dataDir: optionalString(node, "data_dir", "node", path) ?? DEFAULTS.node.dataDir,
  };
}

function envConfig(env: Record<string, unknown> | undefined, path: string): EnvConfig | undefined {
  if (!env) return undefined;
  const file = optionalString(env, "file", "env", path);
  if (!file) throw new ConfigError(`${path}: [env] needs file = "<path>" to write to`);

  const vars = env["vars"];
  if (vars !== undefined && !isTable(vars)) {
    throw new ConfigError(`${path}: [env.vars] has to be a table of NAME = "value" pairs`);
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries((vars as Record<string, unknown>) ?? {})) {
    if (typeof value !== "string") {
      throw new ConfigError(`${path}: [env.vars] ${name} has to be a string`);
    }
    out[name] = value;
  }
  return { file, vars: out };
}

function delegateTarget(app: Record<string, unknown>, path: string): "all" | `0x${string}` {
  const value = optionalString(app, "delegate", "app", path) ?? "all";
  if (value === "all") return "all";
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return value as `0x${string}`;
  throw new ConfigError(
    `${path}: [app] delegate = "${value}" is neither "all" nor a 32-byte key. ` +
      `"all" hands over the whole contract; a key hands over that one partition.`,
  );
}

function setupCalls(raw: Record<string, unknown>, path: string): SetupCall[] {
  const entries = raw["setup"];
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) {
    throw new ConfigError(
      `${path}: setup has to be a list of calls, written as repeated [[setup]] sections`,
    );
  }
  return entries.map((entry, index) => {
    const at = `setup[${index}]`;
    if (!isTable(entry)) throw new ConfigError(`${path}: ${at} has to be a table`);
    const signature = optionalString(entry, "signature", at, path);
    if (!signature) {
      throw new ConfigError(
        `${path}: ${at} needs signature = "name(type,...)", e.g. "credit(address,uint256)"`,
      );
    }
    return {
      signature,
      args: stringList(entry, "args", at, path),
      value: optionalString(entry, "value", at, path),
    };
  });
}

// --- reading TOML without trusting it --------------------------------------

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function table(
  raw: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (!isTable(value)) throw new ConfigError(`${path}: [${key}] has to be a section`);
  return value;
}

function optionalString(
  from: Record<string, unknown> | undefined,
  key: string,
  section: string,
  path: string,
): string | undefined {
  const value = from?.[key];
  if (value === undefined) return undefined;
  // Numbers are quietly accepted where a string is wanted, because `args = [1000]` is the
  // obvious thing to write and refusing it would be pedantry rather than safety.
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value !== "string") {
    throw new ConfigError(`${path}: [${section}] ${key} has to be a string`);
  }
  return value;
}

function stringList(
  from: Record<string, unknown> | undefined,
  key: string,
  section: string,
  path: string,
): string[] {
  const value = from?.[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError(`${path}: [${section}] ${key} has to be a list`);
  }
  return value.map((entry, index) => {
    if (typeof entry === "number" || typeof entry === "bigint" || typeof entry === "boolean") {
      return String(entry);
    }
    if (typeof entry !== "string") {
      throw new ConfigError(`${path}: [${section}] ${key}[${index}] has to be a string or number`);
    }
    return entry;
  });
}

function number(
  from: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
  section: string,
  path: string,
): number {
  const value = from?.[key];
  if (value === undefined) return fallback;
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "number") {
    throw new ConfigError(`${path}: [${section}] ${key} has to be a number`);
  }
  return value;
}
