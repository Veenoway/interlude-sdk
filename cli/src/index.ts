/**
 * `interlude` — a local ephemeral layer over your own Foundry project.
 *
 * This exists because the answer to "how do I try this on my contract" used to be "read these
 * five shell scripts and write a sixth". Standing up a hub, a bonded validator, a delegation and
 * a node is the same work every time, and none of it is the developer's problem.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createPublicClient, http, type Abi, type Address, type Hex } from "viem";
import {
  ArtifactError,
  compiledContracts,
  findInterludeOut,
  findProjectRoot,
  forgeBuild,
  readArtifact,
  readArtifactAt,
} from "./artifacts.js";
import { bootstrap, VALIDATOR_KEY, type Deployment } from "./bootstrap.js";
import { ConfigError, parseConfig, substitute, type Config, type Placeholder } from "./config.js";
import { generatedFileName, generateSurface, GENERATED_SUFFIX } from "./generate.js";
import { readSurface } from "./layout.js";
import { onExit, startAnvil, startNode, stopAll } from "./processes.js";
import { sessions } from "./sessions.js";
import { ship } from "./ship.js";
import { CONTRACTS_REMAPPING, ensureRemapping, findInterludeContracts } from "./remappings.js";
import { starterConfig } from "./starter.js";
import { Bail, fail, note, ok, pairs, say, step, warn } from "./ui.js";
import { checkRulesAgree, VerifyError, watchCommits } from "./verify.js";

const USAGE = `interlude — run your contract on an ephemeral layer, locally

  interlude dev [--config <path>]     stand up a chain, a hub, a validator and a node
  interlude init [--contract <name>]  write a starter interlude.toml for this project
  interlude gen --contract <name>     generate the delegated surface from the storage layout
  interlude check                     fail if a generated surface no longer matches the layout
  interlude ship [--contract <name>]  send us the bytecode; we deploy, pay, and give you a node
  interlude sessions create <app>     ask for a node if the contract is already live
  interlude sessions get <app>        look up an already-provisioned node

Options
  --config <path>     where interlude.toml is (default: ./interlude.toml)
  --contract <name>   which contract to work on
  --no-build          skip forge build, and reason about whatever is in out/
  --force             let init write over an existing interlude.toml
  --help              this

Mark the storage a node should hold with a comment above each state variable:

  /// @custom:interlude global
  mapping(address => uint256) internal balances;

then \`interlude gen\`, and run \`interlude check\` in CI.

Needs forge, cast and anvil on PATH: https://getfoundry.sh
  \`init\` writes the Foundry remapping for @interludelayer/contracts if it is missing.
`;

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

  if (!argv.includes("--no-build")) {
    step("compiling");
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
  note("first run in a fresh checkout builds it, which takes a minute");
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
    checkout: interludeCheckout(interludeOut),
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

/**
 * Merged into the env file rather than written over it.
 *
 * A project with more than one node — one per demo, on its own port — would otherwise lose the
 * other one's settings every time this ran, and that failure looks like the other demo breaking
 * on its own.
 */
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

  const ours = Object.entries(env.vars).map(
    ([name, value]) => `${name}=${substitute(value, known)}`,
  );
  const names = Object.keys(env.vars);
  const kept = existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "" && !names.some((name) => line.startsWith(`${name}=`)))
    : [];

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [...kept, ...ours, ""].join("\n"));
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
  const projectRoot = findProjectRoot(process.cwd());
  const path = join(projectRoot, "interlude.toml");
  if (existsSync(path) && !argv.includes("--force")) {
    fail(`${path} already exists. Pass --force to write over it.`);
  }

  // Remapping first. A project that does not inherit Delegatable yet cannot compile an
  // import of it, and a project that already does cannot compile without the remapping.
  // Either way the next step is forge build, so this has to happen here.
  wireContracts(projectRoot);

  step("compiling, to see what this project has");
  await forgeBuild(projectRoot);

  const outDir = join(projectRoot, "out");
  const candidates = compiledContracts(outDir)
    // Sources only. `out/` also holds the mocks the tests deploy and every dependency's
    // contracts, and offering those as candidates would be offering mostly noise.
    .filter((contract) => contract.source.startsWith(`${sourceDir(projectRoot)}/`))
    .filter((contract) =>
      readArtifactAt(contract.artifactPath).abi.some(
        (item) => item.type === "function" && item.name === "delegateAll",
      ),
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  if (candidates.length === 0) {
    fail(firstHour(sourceDir(projectRoot)));
  }

  const wanted = flag(argv, "--contract");
  const chosen = wanted
    ? candidates.find((contract) => contract.name === wanted)
    : candidates.length === 1
      ? candidates[0]
      : undefined;

  if (!chosen) {
    // Choosing for the reader would be worse than asking. A config naming the wrong contract
    // stands up a whole stack around it and fails somewhere that does not mention this decision.
    const list = candidates.map((c) => `  ${c.name.padEnd(20)} ${c.source}`).join("\n");
    fail(
      wanted
        ? `no delegatable contract named ${wanted}. This project has:\n${list}`
        : `this project has ${candidates.length} delegatable contracts, so which one a node ` +
            `should serve is yours to say:\n${list}\n\n  interlude init --contract <name>`,
    );
  }

  const artifact = readArtifactAt(chosen.artifactPath);
  const constructor = artifact.abi.find((item) => item.type === "constructor");
  const inputs = constructor && "inputs" in constructor ? constructor.inputs : [];

  writeFileSync(path, starterConfig(chosen.name, chosen.source, inputs));

  ok(`wrote ${path} for ${chosen.name}`);
  if (inputs.some((input) => input.type !== "address")) {
    note("Fill in the constructor arguments it could not guess, then run: interlude dev");
  } else {
    note("Now run: interlude dev");
  }
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
  const generatedName = `${contract}${GENERATED_SUFFIX}`;
  const generatedImport = `./${generatedFileName(contract)}`;
  note(`Now inherit it and register once, in the constructor:`);
  say("");
  say(`  import {${generatedName}} from "${generatedImport}";`);
  say("");
  say(`  contract ${contract} is ${generatedName} {`);
  say(`      constructor(IInterludeHub hub_) Delegatable(hub_) {`);
  say(`          _registerInterludeSurface();`);
  say(`      }`);
  say(`  }`);
  say("");
  note(`Then run interlude check in CI, so a layout change cannot pass unnoticed.`);
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
 * not need would be the worse first impression.
 */
function wireContracts(projectRoot: string): void {
  try {
    const contractsDir = findInterludeContracts(projectRoot);
    const mapping = ensureRemapping(projectRoot, contractsDir);
    if (mapping.wrote) {
      ok(`wrote ${mapping.line} into ${mapping.path}`);
    }
  } catch (error) {
    if (error instanceof ArtifactError) {
      warn(error.message);
      return;
    }
    throw error;
  }
}

/**
 * The first hour, printed by `init` when the project has not inherited Delegatable yet.
 *
 * This used to be one sentence about `delegateAll()`. The reader who sees it has just been
 * given a remapping and does not yet have a contract that uses it, so the next lines they
 * need are the import, the annotation, `gen`, and `ship` — not a reminder of the ABI.
 */
function firstHour(src: string): string {
  return (
    `nothing under ${src}/ inherits Delegatable yet. The remapping is written; ` +
    `the import it resolves is:\n\n` +
    `  import {Delegatable} from "${CONTRACTS_REMAPPING}Delegatable.sol";\n` +
    `  import {IInterludeHub} from "${CONTRACTS_REMAPPING}interfaces/IInterludeHub.sol";\n` +
    `  import {Types} from "${CONTRACTS_REMAPPING}interfaces/Types.sol";\n\n` +
    `  contract YourApp is Delegatable {\n` +
    `      /// @custom:interlude global\n` +
    `      uint256 internal score;\n\n` +
    `      constructor(IInterludeHub hub_) Delegatable(hub_) {}\n\n` +
    `      function play() external whenNotDelegated(Types.GLOBAL) {\n` +
    `          score += 1;\n` +
    `      }\n` +
    `  }\n\n` +
    `Then inherit the generated surface, register it, and come back:\n\n` +
    `  interlude gen --contract YourApp\n` +
    `  interlude init --contract YourApp\n` +
    `  interlude check\n` +
    `  interlude ship\n\n` +
    `ship sends us the bytecode. We deploy, pay, and print a node URL. ` +
    `Nothing to set. dev is the laptop loop and needs an interlude-node binary, ` +
    `which the published CLI does not ship.`
  );
}

/** Foundry's source directory, which a project may have renamed. */
function sourceDir(projectRoot: string): string {
  const config = join(projectRoot, "foundry.toml");
  if (!existsSync(config)) return "src";
  const found = /^\s*src\s*=\s*["']([^"']+)["']/m.exec(readFileSync(config, "utf8"));
  return found?.[1]?.replace(/\/$/, "") ?? "src";
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

main(process.argv.slice(2))
  .then(() => stopAll())
  .catch(async (error: unknown) => {
    await stopAll();
    if (error instanceof Bail) {
      process.exit(1);
    }
    if (
      error instanceof ConfigError ||
      error instanceof ArtifactError ||
      error instanceof VerifyError
    ) {
      process.stderr.write(`\nerror ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  });

// Referenced by the report and the node's partition argument, and kept out of the config module
// because it is a protocol constant rather than a setting.
export type { Address, Hex, Abi };
