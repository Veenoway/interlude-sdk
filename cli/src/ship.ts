import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isAddress, keccak256, toHex, type Abi, type Address, type Hex } from "viem";

import { ArtifactError, findProjectRoot, forgeBuild, readArtifactAt } from "./artifacts.js";
import { coerce, parseSignature } from "./bootstrap.js";
import {
  parseConfig,
  PLACEHOLDERS,
  refuseWellKnownOwner,
  type AppConfig,
  type Config,
} from "./config.js";
import { mergeEnv } from "./env.js";
import { DEPLOY_TIMEOUT_MS, NetworkError, request } from "./http.js";
import {
  chooseContract,
  delegatableContracts,
  flag,
  perKeyEvidence,
  readToolchainWarnings,
} from "./project.js";
import { ensureRemapping, findInterludeContracts } from "./remappings.js";
import { fillIn, hubArgumentIndex, type ConstructorInput } from "./starter.js";
import { ask, bold, fail, note, ok, pairs, say, step, warn } from "./ui.js";

/** Public control plane. Override with INTERLUDE_CONTROL_URL only for a laptop. */
export const DEFAULT_CONTROL_URL = "https://control.interludelayer.xyz";

/** Where hosted apps live. Used for the commands this prints, never to send anything. */
export const DEFAULT_BASE_RPC = "https://testnet-rpc.monad.xyz";

export function controlUrl(argv: string[] = []): string {
  return (flag(argv, "--control") ?? process.env.INTERLUDE_CONTROL_URL ?? DEFAULT_CONTROL_URL).replace(
    /\/$/,
    "",
  );
}

export function baseRpcUrl(argv: string[] = []): string {
  return flag(argv, "--rpc") ?? process.env.INTERLUDE_BASE_RPC ?? DEFAULT_BASE_RPC;
}

/** Refused before anything is sent: the message is the whole explanation. */
export class ShipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShipError";
  }
}

/**
 * The body of `POST /apps`.
 *
 * `args` are strings, one per constructor input, exactly as `interlude.toml` says them; `$HUB`
 * is the one placeholder, replaced by control with the hub it deploys against. `setup` calls run
 * from the deploying key before `delegateAll`, the same order `dev` uses and for the same reason:
 * once a partition is handed over, base-chain writes to it are refused.
 */
export interface ShipPayload {
  name: string;
  bytecode: Hex;
  abi: Abi;
  args: string[];
  setup?: { signature: string; args: string[] }[];
  owner?: Address;
  stake?: string;
  region?: string;
}

export interface PlanInput {
  contract: string;
  abi: Abi;
  bytecode: Hex;
  /** The `[app]` section, only when interlude.toml describes this very contract. */
  app?: AppConfig | undefined;
  label: string;
  owner?: string | undefined;
  stake?: string | undefined;
  region?: string | undefined;
  /** From `perKeyEvidence`: why this contract looks per-key, if it does. */
  perKey?: string[];
}

export interface ShipPlan {
  payload: ShipPayload;
  notes: string[];
}

/** Stands in for the hub while checking types, so `$HUB` validates as the address it will be. */
const HUB_STANDIN = { $HUB: "0x0000000000000000000000000000000000000001" } as const;

/**
 * Decide what to send, and refuse what would deploy something other than what the files say.
 *
 * `ship` used to send only the bytecode and the constructor's ABI, and the control plane filled
 * the constructor in itself — the first address became the hub and the first uint became a
 * 0.1 MON stake, whatever the parameter meant. `[app] args` and `[[setup]]` were read by `dev`
 * alone. Now the file is what gets deployed, and anything the file does not say is an error here
 * rather than a guess over there.
 */
export function planShip(input: PlanInput): ShipPlan {
  const notes: string[] = [];
  const { contract, app } = input;

  if (input.perKey && input.perKey.length > 0) {
    throw new ShipError(
      `${contract} hands storage over per key (${input.perKey.join("; ")}). The hosted node ` +
        `serves the whole contract as one partition, GLOBAL, and nothing else — so this would ` +
        `deploy, delegate and get a node, and then every write to a keyed partition would be ` +
        `refused. Mark those variables "/// @custom:interlude global", run interlude gen ` +
        `again, then ship. \`interlude dev\` can still serve one key on your laptop.`,
    );
  }
  if (app && app.delegate !== "all") {
    throw new ShipError(
      `interlude.toml delegates one key (delegate = "${app.delegate}"). The hosted node serves ` +
        `delegate = "all" only; that setting is for \`interlude dev\`.`,
    );
  }
  if (input.owner !== undefined && !isAddress(input.owner)) {
    throw new ShipError(`--owner ${input.owner} is not an address`);
  }
  if (input.stake !== undefined && !/^\d+$/.test(input.stake)) {
    throw new ShipError(`--stake ${input.stake} is not a whole number of wei`);
  }

  const inputs = constructorInputs(input.abi);
  const configured = app?.args ?? [];
  let args: string[];
  if (configured.length === 0 && inputs.length === 1 && hubArgumentIndex(inputs) === 0) {
    // The Delegatable shape: the hub and nothing else. Nothing to guess.
    args = ["$HUB"];
    notes.push(`${contract}'s one constructor argument is the hub; sending "$HUB".`);
  } else if (configured.length === 0 && inputs.length > 0) {
    const suggestion = inputs
      .map((item, index) => (index === hubArgumentIndex(inputs) ? `"$HUB"` : `"${fillIn(item)}"`))
      .join(", ");
    throw new ShipError(
      `${contract}'s constructor takes ${describeInputs(inputs)}, and ship will not guess them. ` +
        `Write them under [app] in interlude.toml:\n\n  args = [${suggestion}]\n\n` +
        `\`interlude init --contract ${contract}\` writes that list for you.`,
    );
  } else {
    if (configured.length !== inputs.length) {
      throw new ShipError(
        `${contract}'s constructor takes ${inputs.length} argument(s) (${describeInputs(inputs)}) ` +
          `and [app] args gives ${configured.length}.`,
      );
    }
    refuseLocalPlaceholders(configured, `${contract}'s constructor arguments`);
    coerce(inputs, configured, HUB_STANDIN, `${contract}'s constructor`);
    args = configured;
  }

  const setup = (app?.setup ?? []).map((call, index) => {
    const where = `[[setup]] #${index + 1} (${call.signature})`;
    if (call.value !== undefined) {
      throw new ShipError(
        `${where} attaches value. The hosted deployer pays gas, not your app's funding; ` +
          `send that call yourself once you own the app.`,
      );
    }
    const item = parseSignature(call.signature);
    if (item.inputs.length !== call.args.length) {
      throw new ShipError(
        `${where} takes ${item.inputs.length} argument(s) and gives ${call.args.length}.`,
      );
    }
    refuseLocalPlaceholders(call.args, where);
    coerce(item.inputs, call.args, HUB_STANDIN, where);
    return { signature: call.signature, args: call.args };
  });

  return {
    payload: {
      name: input.label,
      bytecode: input.bytecode,
      // The whole ABI: control encodes the constructor, the setup calls and delegateAll from it,
      // and a trimmed one was how a constructor's parameter names got lost on the way.
      abi: input.abi,
      args,
      ...(setup.length > 0 ? { setup } : {}),
      ...(input.owner ? { owner: input.owner as Address } : {}),
      ...(input.stake ? { stake: input.stake } : {}),
      ...(input.region ? { region: input.region } : {}),
    },
    notes,
  };
}

function constructorInputs(abi: Abi): readonly (ConstructorInput & { type: string })[] {
  const constructor = abi.find((item) => item.type === "constructor");
  return constructor && "inputs" in constructor
    ? (constructor.inputs as readonly (ConstructorInput & { type: string })[])
    : [];
}

function describeInputs(inputs: readonly ConstructorInput[]): string {
  return inputs.map((input) => `${input.type}${input.name ? ` ${input.name}` : ""}`).join(", ");
}

/**
 * `$ADMIN`, `$VALIDATOR`, `$RESOLVER`, `$BASE_RPC`, `$NODE_RPC` and `$APP` name things `dev`
 * creates on a laptop. The hosted deployer has none of them, and sending the literal text would
 * fail on the server with a message about a string that is not an address.
 */
function refuseLocalPlaceholders(args: string[], where: string): void {
  for (const arg of args) {
    const local = PLACEHOLDERS.find((name) => name !== "$HUB" && arg.includes(name));
    if (local) {
      throw new ShipError(
        `${where} use ${local}, which only \`interlude dev\` knows. On the hosted path $HUB is ` +
          `the only placeholder; write the value itself.`,
      );
    }
  }
}

// --- talking to control ----------------------------------------------------

export interface ShipResult {
  app: Address;
  url: string;
  name: string;
  region?: string | undefined;
  owner?: Address | undefined;
  ownershipPending?: boolean | undefined;
  warnings: string[];
}

/** Control said no. `app` is set when the contract was deployed before it failed. */
export class ShipFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly app?: Address,
    readonly retry?: string,
  ) {
    super(message);
    this.name = "ShipFailure";
  }
}

export async function postApp(
  control: string,
  payload: ShipPayload,
  options: { fetchImpl?: typeof fetch; write?: (text: string) => void } = {},
): Promise<ShipResult> {
  const response = await request(
    `${control}/apps`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
    {
      timeoutMs: DEPLOY_TIMEOUT_MS,
      what: "the control plane",
      progress: true,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.write ? { write: options.write } : {}),
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    app?: string;
    url?: string;
    name?: string;
    region?: string;
    owner?: string;
    ownershipPending?: boolean;
    warnings?: unknown;
    error?: string;
    retry?: string;
  };
  const app = body.app && isAddress(body.app) ? (body.app as Address) : undefined;
  if (!response.ok || !app || !body.url) {
    throw new ShipFailure(
      body.error ??
        (response.ok ? "control answered without an app and a node url" : `control answered ${response.status}`),
      response.status,
      app,
      body.retry ?? (app ? `interlude sessions create ${app}` : undefined),
    );
  }
  return {
    app,
    url: body.url,
    name: body.name ?? payload.name,
    region: body.region,
    owner: body.owner && isAddress(body.owner) ? (body.owner as Address) : undefined,
    ownershipPending: body.ownershipPending,
    warnings: Array.isArray(body.warnings)
      ? body.warnings.filter((item): item is string => typeof item === "string")
      : [],
  };
}

export interface NextSteps {
  ok: string[];
  warnings: string[];
  /** Printed as commands to copy. */
  commands: string[];
  notes: string[];
}

/**
 * What the reader has to do now, which depends mostly on who owns the app.
 *
 * Ownership is a two-step handover: control deploys and delegates with its own key (it has to —
 * `delegateAll` is owner-only), then offers ownership to `--owner`. Nothing is final until that
 * address calls `acceptOwnership()`, and until it does Interlude can still act as the owner. So
 * the command to run is printed in full rather than described.
 */
export function nextSteps(
  result: ShipResult,
  context: { rpc: string; requestedOwner?: string | undefined },
): NextSteps {
  const steps: NextSteps = { ok: [], warnings: [...result.warnings], commands: [], notes: [] };
  const requested = context.requestedOwner?.toLowerCase();

  if (result.owner && result.ownershipPending) {
    steps.notes.push(
      `${result.owner} has been offered ownership of ${result.app}. Until it accepts, ` +
        `Interlude's deploy key is still the owner. From that wallet:`,
    );
    steps.commands.push(
      `cast send ${result.app} "acceptOwnership()" --rpc-url ${context.rpc} --interactive`,
    );
    steps.notes.push(
      `(--interactive asks for the key; --account <name> or --ledger work as well.) ` +
        `Then check: interlude status ${result.app}`,
    );
  } else if (result.owner) {
    steps.ok.push(`owner ${result.owner}`);
  } else if (requested) {
    steps.warnings.push(
      `you asked for ${context.requestedOwner} to own ${result.app} and control did not confirm ` +
        `it, so the owner is probably still Interlude's deploy key. Check: interlude status ${result.app}`,
    );
  } else {
    steps.warnings.push(
      `${result.app} is owned by Interlude's deploy key, not by you: it can undelegate, re-seed ` +
        `and receive slash payouts. Ship again with --owner 0x... (or owner = "0x..." under ` +
        `[app]) to own it.`,
    );
  }

  steps.notes.push(
    result.region
      ? `point the SDK at that node (${result.region}). The first one takes a few minutes; a 502 right after this is the image building.`
      : "point the SDK at that node. The first one takes a few minutes; a 502 right after this is the image building.",
  );
  return steps;
}

/** The three values a Next.js front end needs, under the names the SDK's examples read. */
export function envFor(result: ShipResult, rpc: string): Record<string, string> {
  return {
    NEXT_PUBLIC_INTERLUDE_APP: result.app,
    NEXT_PUBLIC_INTERLUDE_NODE: result.url,
    NEXT_PUBLIC_INTERLUDE_BASE_RPC: rpc,
  };
}

// --- not deploying the same thing twice ------------------------------------

/**
 * A record of what this project has shipped, so running `ship` twice is not two deploys.
 *
 * Each deploy spends a rate-limited slot shared by everybody behind the same IP — a classroom or
 * a meetup — and leaves a second contract nobody will use. The record is keyed by everything that
 * decides what gets deployed (bytecode, arguments, setup, owner, stake) and not by the label or
 * region, which only decide where the node runs.
 */
export interface ShipRecord {
  fingerprint: Hex;
  app: Address;
  url?: string | undefined;
  name: string;
  at: string;
  /** False when control deployed the contract and then failed: the app exists, its node may not. */
  complete: boolean;
}

export function shipFingerprint(payload: ShipPayload): Hex {
  return keccak256(
    toHex(
      JSON.stringify({
        bytecode: payload.bytecode.toLowerCase(),
        args: payload.args,
        setup: payload.setup ?? [],
        owner: payload.owner?.toLowerCase() ?? null,
        stake: payload.stake ?? null,
      }),
    ),
  );
}

/**
 * What this build was shipped as, if it was: the newest deploy whose node came up, else the newest
 * one at all (a deploy control did not finish).
 */
export function previousShip(records: ShipRecord[], fingerprint: Hex): ShipRecord | undefined {
  const same = records.filter((entry) => entry.fingerprint === fingerprint);
  return [...same].reverse().find((entry) => entry.complete) ?? same[same.length - 1];
}

export function shipRecordPath(projectRoot: string): string {
  return join(projectRoot, ".interlude", "shipped.json");
}

export function readShipRecords(projectRoot: string): ShipRecord[] {
  const path = shipRecordPath(projectRoot);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as ShipRecord[]) : [];
  } catch {
    return [];
  }
}

/**
 * One record per deployed app. Keyed by the app, not the fingerprint: `--again` deploys a second
 * copy of the same build, and when that copy failed half-way it used to replace the record of the
 * first one, which worked — its address and node were forgotten and the next `ship` pointed at
 * the broken copy.
 */
export function rememberShip(projectRoot: string, record: ShipRecord): void {
  const records = readShipRecords(projectRoot).filter(
    (entry) => entry.app.toLowerCase() !== record.app.toLowerCase(),
  );
  records.push(record);
  const path = shipRecordPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`);
}

// --- the command -----------------------------------------------------------

const SHIP_USAGE =
  `interlude ship [--contract <name>] [--name <label>] [--owner 0x...] [--out .env.local]\n` +
  `               [--region <floor>] [--again]\n\n` +
  `Compile locally, send us the bytecode, the constructor arguments and the [[setup]] calls\n` +
  `from interlude.toml, and get a node URL back. No key, no invite. Does not run \`dev\`.\n\n` +
  `  --owner 0x...     who owns the app afterwards (default: Interlude's deploy key); your\n` +
  `                    wallet, never one of anvil's accounts, whose keys are public\n` +
  `  --out <file>      merge NEXT_PUBLIC_INTERLUDE_APP / _NODE / _BASE_RPC into an env file\n` +
  `  --region <floor>  ${"us|ny|eu|asia|sa|tokyo|mumbai|africa"}; omit = nearest to you\n` +
  `  --again           deploy even though this exact build was shipped before\n` +
  `  --rpc <url>       base chain, for the commands printed (default: Monad testnet)\n\n` +
  `The first node can 502 for a few minutes while the image builds.`;

/**
 * Compile locally, send us the bytecode, get a node URL back.
 *
 * No key, no invite, no message to us. The URL is public; we pay; a rate limit
 * is what stops a loop from draining the faucet wallet.
 */
export async function ship(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    say(SHIP_USAGE);
    return;
  }

  const control = controlUrl(argv);
  const rpc = baseRpcUrl(argv);
  const region = parseShipRegion(flag(argv, "--region"));

  const projectRoot = findProjectRoot(process.cwd());
  wire(projectRoot);
  for (const message of readToolchainWarnings(projectRoot)) warn(message);

  const outFlag = flag(argv, "--out");
  const outPath = outFlag ? resolve(process.cwd(), outFlag) : undefined;

  if (!argv.includes("--no-build")) {
    step("compiling");
    await forgeBuild(projectRoot);
  }

  const config = readConfig(projectRoot);
  const wanted = flag(argv, "--contract") ?? config?.app.contract;
  const chosen = chooseContract(delegatableContracts(projectRoot), wanted);
  const artifact = readArtifactAt(chosen.artifactPath);

  const app = config?.app.contract === chosen.name ? config.app : undefined;
  if (config && !app) {
    note(
      config.app.contract
        ? `interlude.toml describes ${config.app.contract}, not ${chosen.name}: its args and [[setup]] are not sent.`
        : `interlude.toml deploys through a script, which ship cannot run: only ${chosen.name}'s bytecode is sent.`,
    );
  }

  if (argv.includes("--stake")) {
    // It never did anything: control only uses a stake to fill a "$STAKE" constructor argument,
    // which ship does not send, and then warned that it had ignored it. The stake behind a
    // hosted session is the validator's, set by its terms on the hub.
    fail(
      `--stake does nothing on the hosted path: the stake behind a session is the validator's, ` +
        `from its terms on the hub. Drop the flag.`,
    );
  }
  const owner = flag(argv, "--owner") ?? app?.owner;
  if (owner) {
    // anvil's accounts have public keys, so whoever accepted the ownership first would own the
    // app. Only a control plane on this machine deploys on a chain where that is harmless.
    const source = flag(argv, "--owner") ? "--owner" : "interlude.toml [app] owner";
    refuseWellKnownOwner(owner, source, control);
  }
  const label = flag(argv, "--name") ?? (await ask("name this node", chosen.name));
  const plan = planShip({
    contract: chosen.name,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    app,
    label,
    owner,
    region,
    perKey: perKeyEvidence(projectRoot, chosen),
  });
  for (const line of plan.notes) note(line);

  const fingerprint = shipFingerprint(plan.payload);
  const previous = previousShip(readShipRecords(projectRoot), fingerprint);
  if (previous && !argv.includes("--again")) {
    fail(
      `this exact build of ${chosen.name} was already shipped as ${previous.app} (${previous.at}).\n` +
        (previous.complete
          ? `  its node: ${previous.url ?? "unknown"} — interlude sessions get ${previous.app}\n`
          : `  control deployed it but did not finish: interlude sessions create ${previous.app}\n`) +
        `  pass --again to deploy a second copy.`,
    );
  }

  if (!owner) {
    warn(
      bold(
        `no --owner: the on-chain owner of this app will be Interlude's deploy key, not you. ` +
          `Pass --owner 0x... (or owner = "0x..." under [app]) to own it.`,
      ),
    );
  }

  step(`sending ${chosen.name} to us — we deploy, delegate and run the node`);
  let result: ShipResult;
  try {
    result = await postApp(control, plan.payload);
  } catch (error) {
    if (error instanceof ShipFailure) {
      if (error.app) {
        rememberShip(projectRoot, {
          fingerprint,
          app: error.app,
          name: label,
          at: new Date().toISOString(),
          complete: false,
        });
        // The one thing that must not be lost: the contract exists and cost a deploy.
        pairs([["app", error.app]]);
        note(`the contract is deployed. Retry the rest with: ${error.retry}`);
      }
      fail(error.message);
    }
    if (error instanceof NetworkError && /did not answer within/.test(error.message)) {
      throw new NetworkError(
        `${error.message} The deploy may still finish on our side. Nothing was recorded here, so ` +
          `look for the app on the explorer before shipping again.`,
      );
    }
    throw error;
  }

  rememberShip(projectRoot, {
    fingerprint,
    app: result.app,
    url: result.url,
    name: result.name,
    at: new Date().toISOString(),
    complete: true,
  });

  ok(result.url);
  pairs([
    ["app", result.app],
    ["node", result.url],
    ["name", result.name],
    ...(result.region ? ([["region", result.region]] as [string, string][]) : []),
    ...(result.owner
      ? ([["owner", `${result.owner}${result.ownershipPending ? " (not accepted yet)" : ""}`]] as [
          string,
          string,
        ][])
      : []),
  ]);
  say("");

  const steps = nextSteps(result, { rpc, requestedOwner: owner });
  for (const line of steps.ok) ok(line);
  for (const line of steps.warnings) warn(line);
  // The note that introduces a command comes right before it; the rest follow.
  const [lead, ...rest] = steps.notes;
  if (steps.commands.length > 0 && lead) {
    note(lead);
    for (const command of steps.commands) say(`\n  ${command}\n`);
    for (const line of rest) note(line);
  } else {
    for (const line of steps.notes) note(line);
  }

  if (outPath) {
    mergeEnv(outPath, envFor(result, rpc));
    ok(`wrote NEXT_PUBLIC_INTERLUDE_APP, _NODE and _BASE_RPC into ${outPath}`);
  }
  say("session open");
}

function readConfig(projectRoot: string): Config | undefined {
  const toml = join(projectRoot, "interlude.toml");
  return existsSync(toml) ? parseConfig(readFileSync(toml, "utf8"), toml) : undefined;
}

function wire(projectRoot: string): void {
  try {
    ensureRemapping(projectRoot, findInterludeContracts(projectRoot));
  } catch (error) {
    if (error instanceof ArtifactError) return;
    throw error;
  }
}

/** Closest metal to the people who will tap. */
export const SHIP_REGIONS = ["us", "ny", "eu", "asia", "sa", "tokyo", "mumbai", "africa"] as const;

export function parseShipRegion(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const region = value.trim().toLowerCase();
  if ((SHIP_REGIONS as readonly string[]).includes(region)) return region;
  fail(`unknown region ${value}. use ${SHIP_REGIONS.join(", ")}`);
}
