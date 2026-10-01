/**
 * `interlude` — a local ephemeral layer over your own Foundry project.
 *
 * This exists because the answer to "how do I try this on my contract" used to be "read these
 * five shell scripts and write a sixth". Standing up a hub, a bonded validator, a delegation and
 * a node is the same work every time, and none of it is the developer's problem.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createPublicClient, http, type Abi, type Address, type Hex } from "viem";
import { abiCommand } from "./abi.js";
import {
  ArtifactError,
  findInterludeOut,
  findProjectRoot,
  forgeBuild,
  readArtifact,
  readArtifactAt,
} from "./artifacts.js";
import { bootstrap, FILL_IN, VALIDATOR_KEY, type Deployment } from "./bootstrap.js";
import { ConfigError, parseConfig, substitute, type Config, type Placeholder } from "./config.js";
import { mergeEnv } from "./env.js";
import { generatedFileName, generateSurface, GENERATED_SUFFIX } from "./generate.js";
import { NetworkError } from "./http.js";
import { readSurface } from "./layout.js";
import { devPreflight, onExit, startAnvil, startNode, stopAll } from "./processes.js";
import {
  chooseContract,
  delegatableContracts,
  flag,
  perKeyEvidence,
  readToolchainWarnings,
  REQUIRED_SOLC,
  sourceDir,
} from "./project.js";
import { sessions } from "./sessions.js";
import { logs } from "./logs.js";
import { ship, ShipError } from "./ship.js";
import { status } from "./status.js";
import { CONTRACTS_REMAPPING, ensureRemapping, findInterludeContracts } from "./remappings.js";
import { firstHour, starterConfig } from "./starter.js";
import { Bail, fail, note, ok, pairs, say, step, warn } from "./ui.js";
import { checkRulesAgree, VerifyError, watchCommits } from "./verify.js";

const USAGE = `interlude — run your contract on an ephemeral layer, locally or hosted

  interlude init [--contract <name>]  write a starter interlude.toml for this project
  interlude gen --contract <name>     generate the delegated surface from the storage layout
  interlude check                     fail if a generated surface no longer matches the layout
  interlude ship [--owner 0x...] [--out .env.local] [--contract <name>] [--name <label>]
                 [--region us|ny|eu|asia|sa|tokyo|mumbai|africa] [--again]
                                      send us the bytecode, args and [[setup]]; we deploy,
                                      pay, and give you a node
  interlude abi [--contract <name>] [--out src/abi.ts]
                                      the ABI as \`export const abi = [...] as const\`
  interlude status <app> [--rpc <url>] [--node <url>]
                                      owner, pending owner, delegation, epoch, node health
  interlude sessions create <app> [--signature 0x...]
                                      ask for a node for a contract that is already live;
                                      one you delegated yourself needs its owner's opt-in
  interlude sessions opt-in <app>     print what the owner signs for that, epoch included
  interlude sessions get <app>        look up an already-provisioned node
  interlude logs --follow [--node <url>] [--abi <file>] [--json]
                                      every call a node runs, as the node reports it;
                                      exits 1 when it cannot be reached or will not stream
  interlude dev [--config <path>]     stand up a chain, a hub, a validator and a node locally;
                                      needs an interlude-node binary (INTERLUDE_NODE_BIN),
                                      which this package does not ship

Options
  --config <path>     where interlude.toml is (default: ./interlude.toml)
  --contract <name>   which contract to work on
  --name <label>      Fly machine name (default: the contract, or a prompt on a TTY)
  --owner 0x...       ship: who owns the app afterwards (default: Interlude's deploy key)
  --out <file>        ship: merge NEXT_PUBLIC_INTERLUDE_* into an env file; abi: where to write
  --region <floor>    ship: where the hosted node sits. omit = nearest to whoever ships
  --no-build          skip forge build, and reason about whatever is in out/
  --force             let init write over an existing interlude.toml
  --local             let init write a config for a per-key contract (dev only, not ship)
  --help              this

Mark the storage a node should hold with a comment above each state variable:

  /// @custom:interlude global
  mapping(address => uint256) internal balances;

then \`interlude gen\`, and run \`interlude check\` in CI.

Needs forge, cast and anvil on PATH (https://getfoundry.sh), and solc >= ${REQUIRED_SOLC} with
evm_version cancun or later — Interlude's contracts use transient storage.
  \`init\` writes the Foundry remapping for @interludelayer/contracts if it is missing.
`;

function wantsHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h" || command === "help") {
    say(USAGE);
    return;
  }
  if (command === "dev") return dev(argv.slice(1));
  if (command === "init") return init(argv.slice(1));
  if (command === "gen") return gen(argv.slice(1));
  if (command === "check") return check(argv.slice(1));
  if (command === "sessions") return sessions(argv.slice(1));
  if (command === "ship") return ship(argv.slice(1));
  if (command === "abi") return abiCommand(argv.slice(1));
  if (command === "status") return status(argv.slice(1));
  if (command === "logs") return logs(argv.slice(1));
  fail(`no command "${command}". Try: interlude --help`);
}

// --- dev -------------------------------------------------------------------

async function dev(argv: string[]): Promise<void> {
  const configPath = resolve(flag(argv, "--config") ?? "interlude.toml");
  if (!existsSync(configPath)) {
    fail(
      `no ${configPath}. Run \`interlude init\` in a Foundry project and it will write one ` +
        `naming the contracts it finds.`,
    );
  }

  const config = parseConfig(readFileSync(configPath, "utf8"), configPath);
  const projectRoot = findProjectRoot(dirname(configPath));
  wireContracts(projectRoot);
  const interludeOut = findInterludeOut(projectRoot);

  step("checking ports and the node binary before starting anything");
  const binary = await devPreflight(
    { chain: config.chain.port, node: config.node.port },
    interludeCheckout(interludeOut),
  );
  note(`node binary ${binary}`);

  if (!argv.includes("--no-build")) {
    step("compiling");
    for (const message of readToolchainWarnings(projectRoot)) warn(message);
    await forgeBuild(projectRoot);
    note(`forge build in ${projectRoot}`);
  }

  const logDir = join(projectRoot, ".interlude", "logs");
  const dataDir = isAbsolute(config.node.dataDir)
    ? config.node.dataDir
    : join(projectRoot, config.node.dataDir);

  onExit();

  const baseRpc = `http://127.0.0.1:${config.chain.port}`;
  const nodeRpc = `http://127.0.0.1:${config.node.port}`;

  step(`base chain on ${config.chain.port}, ${config.chain.blockTime}s blocks like Monad`);
  await startAnvil({ port: config.chain.port, blockTime: config.chain.blockTime, logDir });
  const chain = createPublicClient({ transport: http(baseRpc) });
  const baseChainId = await chain.getChainId();
  if (baseChainId === config.node.chainId) {
    fail(
      `the base chain and the node would both be chain ${baseChainId}. ` +
        `Delegatable.isEphemeral() compares the two, so every delegated write would revert. ` +
        `Set chain_id under [node] to something else.`,
    );
  }
  note(`chain id ${baseChainId}`);

  const deployment = await bootstrap({
    config,
    projectRoot,
    interludeOut,
    baseRpc,
    chainId: baseChainId,
    step,
  });

  step(`starting the node on ${config.node.port}`);
  await startNode({
    baseRpc,
    hub: deployment.hub,
    app: deployment.app,
    partition: deployment.partition === GLOBAL ? undefined : deployment.partition,
    validatorKey: VALIDATOR_KEY,
    port: config.node.port,
    chainId: config.node.chainId,
    commitInterval: config.node.commitInterval,
    dataDir,
    logDir,
    binary,
  });

  const hubAbi = readArtifact(interludeOut, "InterludeHub").abi;
  const rules = await checkRulesAgree(
    nodeRpc,
    chain,
    hubAbi,
    deployment.hub,
    deployment.app,
    deployment.partition,
  );
  ok(`the node and the delegation agree the rules are ${rules}`);

  if (config.env) writeEnv(configPath, config, deployment, baseRpc, nodeRpc);

  report(config, deployment, baseRpc, nodeRpc, logDir, dataDir);

  step("watching for commits");
  say("Send traffic to the node. Each batch that settles is checked against Monad here.");
  say("");
  await watchCommits(
    nodeRpc,
    chain,
    hubAbi,
    deployment.hub,
    deployment.app,
    deployment.partition,
    (batch) =>
      ok(
        `batch ${batch.index}: ${batch.transactions} transaction(s), ` +
          `root ${batch.txRoot.slice(0, 14)}… recognised by Monad`,
      ),
    (error) => {
      // A verification failure is louder than a poll that missed, because one means the node and
      // the chain disagree about what was committed and the other means nothing at all.
      if (error instanceof VerifyError) warn(error.message);
    },
  );
}

const GLOBAL = "0x0000000000000000000000000000000000000000000000000000000000000000";

function report(
  config: Config,
  deployment: Deployment,
  baseRpc: string,
  nodeRpc: string,
  logDir: string,
  dataDir: string,
): void {
  step("ready");
  pairs([
    ["base chain", baseRpc],
    ["node", nodeRpc],
    ["hub", deployment.hub],
    ["app", deployment.app],
    ["partition", deployment.partition === GLOBAL ? "the whole contract" : deployment.partition],
    ["commits", `every ${config.node.commitInterval}s`],
    ["logs", logDir],
    ["batches", join(dataDir, "txlog")],
  ]);
}

/** `[env]`, merged into the file it names — see `mergeEnv` for why merged. */
function writeEnv(
  configPath: string,
  config: Config,
  deployment: Deployment,
  baseRpc: string,
  nodeRpc: string,
): void {
  const env = config.env!;
  const path = resolve(dirname(configPath), env.file);
  const known: Partial<Record<Placeholder, string>> = {
    $HUB: deployment.hub,
    $APP: deployment.app,
    $ADMIN: deployment.admin,
    $VALIDATOR: deployment.validator,
    $RESOLVER: deployment.resolver,
    $BASE_RPC: baseRpc,
    $NODE_RPC: nodeRpc,
  };
  mergeEnv(
    path,
    Object.fromEntries(
      Object.entries(env.vars).map(([name, value]) => [name, substitute(value, known)]),
    ),
  );
  note(`wrote ${path}`);
}

function interludeCheckout(interludeOut: string): string {
  // .../packages/contracts/out -> the checkout. A bundled artifacts directory has no checkout
  // above it, and the caller falls back to a node on PATH, so being wrong here is not fatal.
  return resolve(interludeOut, "..", "..", "..");
}

// --- init ------------------------------------------------------------------

/**
 * Write a starter config, naming what the project actually has.
 *
 * Delegatable contracts are found by looking for `delegateAll` in each compiled ABI rather than
 * by reading sources for an inheritance list. The ABI is what the compiler concluded, so it
 * cannot be fooled by an import alias or a base contract two levels up.
 */
async function init(argv: string[]): Promise<void> {
  if (wantsHelp(argv)) {
    say(
      `interlude init [--contract <name>] [--force] [--local]\n\n` +
        `Write interlude.toml for a contract that inherits Delegatable.\n` +
        `Exits 1 with a starter contract to copy while no contract under src/ inherits\n` +
        `Delegatable yet — which includes a fresh \`forge init\` with only Counter.sol. That is\n` +
        `expected: add the starter, run gen, then init --contract <name>.\n` +
        `--local writes a config for a per-key contract, which \`dev\` can serve and \`ship\` cannot.`,
    );
    return;
  }

  const projectRoot = findProjectRoot(process.cwd());
  const path = join(projectRoot, "interlude.toml");
  if (existsSync(path) && !argv.includes("--force")) {
    fail(`${path} already exists. Pass --force to write over it.`);
  }

  // Remapping first. A project that does not inherit Delegatable yet cannot compile an
  // import of it, and a project that already does cannot compile without the remapping.
  // Either way the next step is forge build, so this has to happen here.
  const wired = wireContracts(projectRoot);

  // Before forge: a pinned compiler too old for the vendored sources fails inside lib/interlude,
  // and the setting to change is in foundry.toml, which the solc error never mentions.
  const toolchain = readToolchainWarnings(projectRoot);
  for (const message of toolchain) warn(message);
  if (toolchain.length === 0) {
    note(`Interlude's contracts need solc >= ${REQUIRED_SOLC} and evm_version cancun or later.`);
  }

  step("compiling, to see what this project has");
  await forgeBuild(projectRoot);

  const candidates = delegatableContracts(projectRoot);
  if (candidates.length === 0) {
    fail(firstHour(sourceDir(projectRoot), wired));
  }

  const chosen = chooseContract(candidates, flag(argv, "--contract"));

  const perKey = perKeyEvidence(projectRoot, chosen);
  if (perKey.length > 0 && !argv.includes("--local")) {
    fail(
      `${chosen.name} hands storage over per key (${perKey.join("; ")}).\n` +
        `The hosted node — what \`ship\` gives you — serves the whole contract as one partition ` +
        `(GLOBAL) and nothing else, so every keyed write would be refused after a deploy that ` +
        `looked fine. Mark the variables "/// @custom:interlude global" and run ` +
        `\`interlude gen --contract ${chosen.name}\` again.\n` +
        `To serve one key on your laptop with \`interlude dev\` anyway: interlude init --contract ` +
        `${chosen.name} --local`,
    );
  }

  const artifact = readArtifactAt(chosen.artifactPath);
  const constructor = artifact.abi.find((item) => item.type === "constructor");
  const inputs = constructor && "inputs" in constructor ? constructor.inputs : [];

  const written = starterConfig(chosen.name, chosen.source, inputs, { perKey: perKey.length > 0 });
  writeFileSync(path, written);

  ok(`wrote ${path} for ${chosen.name}`);
  const unfinished = parseConfig(written, path).app.args.filter((arg) => FILL_IN.test(arg));
  if (unfinished.length > 0) {
    note(
      `${unfinished.length} constructor argument(s) are marked <fill in: ...> in interlude.toml. ` +
        `Replace them: ship sends them as written, and ship and dev both refuse the marker.`,
    );
  }
  if (perKey.length > 0) {
    note(`per-key: set delegate to the 32-byte key to serve, then: interlude dev`);
  } else {
    note(
      "Now run: npx @interludelayer-sdk/cli ship --owner <your address> --out .env.local",
    );
  }
  note("interlude dev is the laptop loop. The published CLI does not ship the node binary.");
}

// --- gen and check ---------------------------------------------------------

/**
 * Write the delegated surface for one contract.
 *
 * The file lands beside the contract's own source, which is what makes its imports resolve: it
 * reuses the app's own import lines verbatim rather than deriving a path from assumptions about
 * how the project arranges its dependencies.
 */
async function gen(argv: string[]): Promise<void> {
  if (wantsHelp(argv)) {
    say(`interlude gen --contract <name>\n\nWrite <Name>InterludeSurface.sol beside the source.`);
    return;
  }

  const projectRoot = findProjectRoot(process.cwd());
  wireContracts(projectRoot);
  const contract = flag(argv, "--contract");
  if (!contract) fail(`which contract? interlude gen --contract <name>`);

  if (!argv.includes("--no-build")) {
    step("compiling");
    await forgeBuild(projectRoot);
  }

  step(`reading ${contract}'s storage layout`);
  const surface = await readSurface(projectRoot, contract);
  for (const variable of surface.variables) {
    const shape =
      variable.kind === "scalar"
        ? "one slot"
        : variable.mode === "per-key"
          ? "one partition per key"
          : "one partition, whole mapping";
    say(`  ${variable.name.padEnd(18)} slot ${String(variable.slot).padEnd(4)} ${shape}`);
  }

  const appSourcePath = join(projectRoot, surface.source);
  const appSource = readFileSync(appSourcePath, "utf8");
  const target = join(dirname(appSourcePath), generatedFileName(contract));
  writeFileSync(target, generateSurface(surface, appSource));

  ok(`wrote ${target}`);
  if (surface.variables.some((variable) => variable.mode === "per-key")) {
    warn(
      `per-key storage is for \`interlude dev\` only: ship serves the whole contract (GLOBAL), ` +
        `and init and ship refuse a per-key surface. Use "global" to ship this.`,
    );
  }
  const generatedName = `${contract}${GENERATED_SUFFIX}`;
  const generatedImport = `./${generatedFileName(contract)}`;
  const next = nextAfterGen(projectRoot, contract);

  // Regenerating after a change to a contract that already inherits its surface: the contract
  // needs nothing, and printing the inheritance scaffold again reads as if it did.
  if (new RegExp(`\\bis\\b[^{]*\\b${generatedName}\\b`).test(appSource)) {
    note(`${contract} already inherits ${generatedName}: nothing to change in the contract.`);
    note(next);
    note(`Put npx @interludelayer-sdk/cli check in CI, so a layout change cannot pass unnoticed.`);
    return;
  }

  note(`Now inherit it and register once, in the constructor.`);
  note(`Keep the Delegatable import — the constructor still names Delegatable(hub_).`);
  say("");
  say(`  import {Delegatable} from "${CONTRACTS_REMAPPING}Delegatable.sol";`);
  say(`  import {IInterludeHub} from "${CONTRACTS_REMAPPING}interfaces/IInterludeHub.sol";`);
  say(`  import {Types} from "${CONTRACTS_REMAPPING}interfaces/Types.sol";`);
  say(`  import {${generatedName}} from "${generatedImport}";`);
  say("");
  say(`  contract ${contract} is ${generatedName} {`);
  say(`      constructor(IInterludeHub hub_) Delegatable(hub_) {`);
  say(`          _registerInterludeSurface();`);
  say(`      }`);
  say("");
  say(`      // Seeding or repairing delegated state from the base chain: guard it.`);
  say(`      // function credit(...) external onlyOwner whenNotDelegated(Types.GLOBAL) { ... }`);
  say(`  }`);
  say("");
  note(next);
  note(`Put npx @interludelayer-sdk/cli check in CI, so a layout change cannot pass unnoticed.`);
}

/**
 * What to run after `gen`, from what `interlude.toml` already says.
 *
 * `init --contract` is the next step only while there is no config: with one, init refuses to
 * write over it, and suggesting it sent a project that was only regenerating its surface into
 * "interlude.toml already exists".
 */
function nextAfterGen(projectRoot: string, contract: string): string {
  const path = join(projectRoot, "interlude.toml");
  if (!existsSync(path)) return `Then: npx @interludelayer-sdk/cli init --contract ${contract}`;

  let named: string | undefined;
  try {
    named = parseConfig(readFileSync(path, "utf8"), path).app.contract;
  } catch {
    // A config that does not parse is ship's to report, with its own message.
    return (
      `Then: npx @interludelayer-sdk/cli check, then forge test. interlude.toml does not parse ` +
      `as it stands: ship says why.`
    );
  }
  if (named === contract) {
    return (
      `Then: npx @interludelayer-sdk/cli check (it compiles and proves the surface matches), ` +
      `then forge test. interlude.toml already names ${contract}.`
    );
  }
  return (
    `interlude.toml names ${named ? `"${named}"` : "another contract"}. To ship ${contract}, ` +
    `set contract = "${contract}" under [app] there (init --contract ${contract} --force would ` +
    `rewrite the whole file).`
  );
}

/**
 * Recompute every generated surface and refuse a stale one.
 *
 * This is the half that makes the generator safe rather than merely convenient. A generated file
 * asserts slot numbers; inserting a state variable above a delegated one shifts everything below
 * it, and the file would go on naming slots that now belong to something else — so the app would
 * hand a node the wrong storage, and nothing at runtime would object until a commit did.
 */
async function check(argv: string[]): Promise<void> {
  if (wantsHelp(argv)) {
    say(`interlude check\n\nFail if a generated surface no longer matches solc's layout.`);
    return;
  }

  const projectRoot = findProjectRoot(process.cwd());
  wireContracts(projectRoot);

  if (!argv.includes("--no-build")) {
    step("compiling");
    await forgeBuild(projectRoot);
  }

  const generated = findGenerated(join(projectRoot, sourceDir(projectRoot)));
  if (generated.length === 0) {
    fail(
      `no generated surfaces found under ${sourceDir(projectRoot)}/. ` +
        `interlude gen --contract <name> writes one.`,
    );
  }

  step(`checking ${generated.length} generated surface(s)`);
  let stale = 0;
  for (const { contract, path } of generated) {
    const recorded = /INTERLUDE_LAYOUT\s*=\s*(0x[0-9a-fA-F]{64})/.exec(readFileSync(path, "utf8"));
    if (!recorded) {
      warn(`${path} has no INTERLUDE_LAYOUT to compare against`);
      stale += 1;
      continue;
    }

    const surface = await readSurface(projectRoot, contract);
    if (surface.fingerprint.toLowerCase() !== recorded[1]!.toLowerCase()) {
      stale += 1;
      warn(
        `${contract}: the layout has moved since this was generated.\n` +
          `  recorded  ${recorded[1]}\n  now       ${surface.fingerprint}\n` +
          `  ${surface.variables.map((v) => `${v.name} at slot ${v.slot}`).join(", ")}`,
      );
      continue;
    }
    ok(`${contract}: ${surface.variables.length} variable(s), layout unchanged`);
  }

  if (stale > 0) {
    fail(
      `${stale} generated surface(s) no longer match the compiler. Run interlude gen again, and ` +
        `look at what moved: a delegated slot that shifted means the app would hand a node ` +
        `storage that is no longer the variable it named.`,
    );
  }
}

function findGenerated(dir: string): { contract: string; path: string }[] {
  const found: { contract: string; path: string }[] = [];
  const walk = (at: string) => {
    if (!existsSync(at)) return;
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(`${GENERATED_SUFFIX}.sol`)) {
        found.push({ contract: entry.name.slice(0, -`${GENERATED_SUFFIX}.sol`.length), path });
      }
    }
  };
  walk(dir);
  return found;
}

/**
 * Make `@interludelayer/contracts/...` resolve in this Foundry project.
 *
 * Missing sources are a warning rather than a hard stop: a project that already imports
 * Delegatable via a relative path still compiles, and shouting about a remapping it does
 * not need would be the worse first impression. Returns whether the remapping is in place,
 * so nothing later claims it was written when it was not.
 */
function wireContracts(projectRoot: string): boolean {
  try {
    const contractsDir = findInterludeContracts(projectRoot);
    const mapping = ensureRemapping(projectRoot, contractsDir);
    if (mapping.wrote) {
      ok(`wrote ${mapping.line} into ${mapping.path}`);
    }
    return true;
  } catch (error) {
    if (error instanceof ArtifactError) {
      warn(error.message);
      return false;
    }
    throw error;
  }
}

/**
 * Errors that carry a sentence for the reader. Anything else is a bug in this command, and even
 * then a stack is only useful to whoever fixes it — so it is printed on request.
 */
function explainTopLevel(error: unknown): string {
  if (
    error instanceof ConfigError ||
    error instanceof ArtifactError ||
    error instanceof VerifyError ||
    error instanceof NetworkError ||
    error instanceof ShipError
  ) {
    return error.message;
  }
  // viem's own errors carry a one-line summary and the EVM's reason; the full message adds the
  // whole request body, which for a deploy is kilobytes of bytecode between the reader and why.
  const viem = error as { shortMessage?: string; details?: string } | null;
  if (viem?.shortMessage && !process.env["INTERLUDE_DEBUG"]) {
    return (
      `${viem.shortMessage}${viem.details ? `\n  ${viem.details}` : ""}\n\n` +
      `INTERLUDE_DEBUG=1 prints the full request and stack.`
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    `${message}\n\n` +
    (process.env["INTERLUDE_DEBUG"]
      ? `${(error as Error)?.stack ?? ""}`
      : `This looks like a bug in the CLI. INTERLUDE_DEBUG=1 prints the stack; please include it ` +
        `in an issue.`)
  );
}

main(process.argv.slice(2))
  .then(() => stopAll())
  .catch(async (error: unknown) => {
    await stopAll();
    if (error instanceof Bail) {
      process.exit(1);
    }
    process.stderr.write(`\nerror ${explainTopLevel(error)}\n`);
    process.exit(1);
  });

// Referenced by the report and the node's partition argument, and kept out of the config module
// because it is a protocol constant rather than a setting.
export type { Address, Hex, Abi };
