/**
 * Putting a hub, a validator and an app on a chain, in the one order that works.
 *
 * Two modes, because projects arrive in two states. A project with no deploy script gets the
 * whole bootstrap from here and needs to write no Solidity at all. A project that already has a
 * script owns its own bootstrap, and this reads the addresses back out of Foundry's broadcast
 * file rather than deploying a second hub beside the one the script just made.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbiItem,
  parseEther,
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ArtifactError, readArtifact, run, type Artifact } from "./artifacts.js";
import { substitute, type Config, type Placeholder, type SetupCall } from "./config.js";

/**
 * anvil's first three accounts, in the three roles the hub refuses to let one account hold.
 *
 * Not a simplification: `_setTerms` rejects a validator that names itself as resolver, and the
 * admin curating the validator set while also owning the app is the shape a real deployment
 * would not have either. Keeping them separate locally means the local stack exercises the same
 * checks a real one does.
 */
export const ADMIN_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
export const VALIDATOR_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
export const RESOLVER_ADDRESS = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;

export const GLOBAL_PARTITION =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/**
 * Terms a local validator publishes. Deliberately not the ones a real one would.
 *
 * The windows are hours rather than days so a developer can watch a session end within one
 * sitting, and the stake is play money. What is *not* relaxed is the shape: a resolver distinct
 * from the validator, a real bond reserved per delegation, and a declared ruleset — because a
 * local stack that skipped those would pass while a real one failed.
 */
function localTerms(resolver: Address) {
  return {
    resolver,
    // Types.Spec.MonadTen. The node checks this against the rules it implements and refuses to
    // serve a session it would execute differently, so a wrong value fails at boot.
    spec: 1,
    stakePerDelegation: parseEther("2"),
    challengeBond: parseEther("0.5"),
    delegationFee: 0n,
    maxBatchInterval: 3600n,
    maxDelegationDuration: 86_400n,
    challengeWindow: 3600n,
    resolutionWindow: 1800n,
    maxDiffsPerCommit: 64,
    maxDelegations: 8,
    timeoutPenaltyBps: 2000,
    open: true,
  };
}

const BOND = parseEther("10");

export interface Deployment {
  hub: Address;
  app: Address;
  partition: Hex;
  admin: Address;
  validator: Address;
  resolver: Address;
}

export interface BootstrapContext {
  config: Config;
  projectRoot: string;
  interludeOut: string;
  baseRpc: string;
  chainId: number;
  step: (message: string) => void;
}

export async function bootstrap(context: BootstrapContext): Promise<Deployment> {
  return context.config.app.script ? viaScript(context) : viaConfig(context);
}

// --- the project has no deploy script, so this is the whole bootstrap ------

async function viaConfig(context: BootstrapContext): Promise<Deployment> {
  const { config, baseRpc, step } = context;
  const admin = wallet(ADMIN_KEY, baseRpc);
  const validator = wallet(VALIDATOR_KEY, baseRpc);
  const chain = reader(baseRpc);

  const hubArtifact = readArtifact(context.interludeOut, "InterludeHub");

  step("deploying the hub and registering a validator");
  const hub = await deploy(chain, admin, hubArtifact, [admin.account.address]);

  await send(chain, admin, hub, hubArtifact.abi, "allowResolver", [RESOLVER_ADDRESS, true]);
  await send(chain, admin, hub, hubArtifact.abi, "allowValidator", [
    validator.account.address,
    true,
  ]);
  await send(
    chain,
    validator,
    hub,
    hubArtifact.abi,
    "register",
    [localTerms(RESOLVER_ADDRESS)],
    BOND,
  );
  // So the app can delegate without naming a validator, which is what keeps `delegateAll()` a
  // no-argument call in the common case.
  await send(chain, admin, hub, hubArtifact.abi, "setDefaultValidator", [validator.account.address]);

  const outDir = join(context.projectRoot, "out");
  const appArtifact = readArtifact(outDir, config.app.contract!);

  step(`deploying ${config.app.contract}`);
  const known: Partial<Record<Placeholder, string>> = {
    $HUB: hub,
    $ADMIN: admin.account.address,
    $VALIDATOR: validator.account.address,
    $RESOLVER: RESOLVER_ADDRESS,
    $BASE_RPC: baseRpc,
  };
  const app = await deploy(
    chain,
    admin,
    appArtifact,
    coerceConstructorArgs(appArtifact.abi, config.app.args, known, config.app.contract!),
  );

  // Before the delegation, not after. Once a partition is handed over the write guard refuses
  // base-chain writes to it, so seeding afterwards does not fail obscurely — it fails correctly.
  if (config.app.setup.length > 0) {
    step(`running ${config.app.setup.length} setup call(s) before delegating`);
    for (const call of config.app.setup) {
      await sendRaw(chain, admin, app, call, { ...known, $APP: app });
    }
  }

  const partition = await delegate(chain, admin, app, appArtifact.abi, config, step);
  return {
    hub,
    app,
    partition,
    admin: admin.account.address,
    validator: validator.account.address,
    resolver: RESOLVER_ADDRESS,
  };
}

async function delegate(
  chain: PublicClient,
  admin: ReturnType<typeof wallet>,
  app: Address,
  abi: Abi,
  config: Config,
  step: (message: string) => void,
): Promise<Hex> {
  if (config.app.delegate === "all") {
    step("delegating the whole contract");
    await send(chain, admin, app, abi, "delegateAll", []);
    return GLOBAL_PARTITION;
  }
  step(`delegating one partition (${config.app.delegate})`);
  await send(chain, admin, app, abi, "delegateKey", [config.app.delegate]);
  return config.app.delegate;
}

// --- the project owns its bootstrap; learn what it built -------------------

async function viaScript(context: BootstrapContext): Promise<Deployment> {
  const { config, projectRoot, baseRpc, chainId, step } = context;
  const script = config.app.script!;

  step(`running ${script}`);
  await run(
    "forge",
    ["script", script, "--rpc-url", baseRpc, "--broadcast", "--silent"],
    projectRoot,
  );

  const created = readBroadcast(projectRoot, script, chainId);
  const hub = pick(created, "InterludeHub", script, "the hub");
  const wanted = config.app.addressFrom;
  const app = wanted
    ? pick(created, wanted, script, "the app")
    : soleAppOtherThanHub(created, script);

  // The script chose the partition when it called delegateAll or delegateKey, and nothing in the
  // broadcast says which. Config has to, and defaulting to GLOBAL is right for delegateAll.
  const partition = config.app.delegate === "all" ? GLOBAL_PARTITION : config.app.delegate;

  return {
    hub,
    app,
    partition,
    admin: privateKeyToAccount(ADMIN_KEY).address,
    validator: privateKeyToAccount(VALIDATOR_KEY).address,
    resolver: RESOLVER_ADDRESS,
  };
}

interface Created {
  name: string;
  address: Address;
}

/**
 * What the script deployed, read from Foundry's broadcast file rather than from its console.
 *
 * Scraping the log was how the shell scripts did it, and it meant every project had to print
 * addresses in a shape a regex expected. The broadcast file is structured, written by forge, and
 * says which contract each CREATE produced.
 */
function readBroadcast(projectRoot: string, script: string, chainId: number): Created[] {
  const file = basename(script.split(":")[0] ?? script);
  const dir = join(projectRoot, "broadcast", file, String(chainId));
  const path = join(dir, "run-latest.json");
  if (!existsSync(path)) {
    const seen = existsSync(join(projectRoot, "broadcast"))
      ? readdirSync(join(projectRoot, "broadcast")).join(", ")
      : "none";
    throw new ArtifactError(
      `${script} left no broadcast at ${path}. Scripts under broadcast/: ${seen}. ` +
        `A script has to actually broadcast for its addresses to be readable.`,
    );
  }

  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    transactions?: { transactionType?: string; contractName?: string; contractAddress?: string }[];
  };
  return (parsed.transactions ?? [])
    .filter((tx) => tx.transactionType === "CREATE" && tx.contractName && tx.contractAddress)
    .map((tx) => ({ name: tx.contractName!, address: tx.contractAddress! as Address }));
}

function pick(created: Created[], name: string, script: string, what: string): Address {
  const found = created.find((entry) => entry.name === name);
  if (!found) {
    throw new ArtifactError(
      `${script} did not deploy ${name}, so ${what} cannot be located. It deployed: ` +
        `${created.map((entry) => entry.name).join(", ") || "nothing"}.`,
    );
  }
  return found.address;
}

function soleAppOtherThanHub(created: Created[], script: string): Address {
  const candidates = created.filter((entry) => entry.name !== "InterludeHub");
  if (candidates.length === 1) return candidates[0]!.address;
  throw new ArtifactError(
    `${script} deployed ${candidates.length} contracts besides the hub ` +
      `(${candidates.map((entry) => entry.name).join(", ")}), so which one the node should ` +
      `serve is ambiguous. Name it with address_from = "<contract>" under [app].`,
  );
}

// --- chain plumbing --------------------------------------------------------

export function reader(rpc: string): PublicClient {
  return createPublicClient({ transport: http(rpc) });
}

export function wallet(key: Hex, rpc: string) {
  return createWalletClient({ account: privateKeyToAccount(key), transport: http(rpc) });
}

export async function deploy(
  chain: PublicClient,
  from: ReturnType<typeof wallet>,
  artifact: Artifact,
  args: readonly unknown[],
): Promise<Address> {
  const hash = await from.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: args as never,
    chain: null,
    account: from.account,
  });
  const receipt = await chain.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) {
    throw new ArtifactError(`a deployment produced no address (tx ${hash})`);
  }
  return receipt.contractAddress;
}

export async function send(
  chain: PublicClient,
  from: WalletClient,
  to: Address,
  abi: Abi,
  name: string,
  args: readonly unknown[],
  value?: bigint,
): Promise<void> {
  const hash = await from.sendTransaction({
    to,
    data: encodeFunctionData({ abi, functionName: name, args: args as never }),
    value,
    chain: null,
    account: from.account!,
  });
  const receipt = await chain.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new ArtifactError(
      `${name}() reverted on ${to} (tx ${hash}). ` +
        `Run it with cast to see which revert: cast call ${to} '${name}(...)'`,
    );
  }
}

async function sendRaw(
  chain: PublicClient,
  from: WalletClient,
  to: Address,
  call: SetupCall,
  known: Partial<Record<Placeholder, string>>,
): Promise<void> {
  const item = parseSignature(call.signature);
  const args = coerce(item.inputs, call.args, known, call.signature);
  const hash = await from.sendTransaction({
    to,
    data: encodeFunctionData({ abi: [item], functionName: item.name, args: args as never }),
    value: call.value ? BigInt(call.value) : undefined,
    chain: null,
    account: from.account!,
  });
  const receipt = await chain.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new ArtifactError(`setup call ${call.signature} reverted on ${to} (tx ${hash})`);
  }
}

function parseSignature(signature: string): AbiFunction {
  try {
    const item = parseAbiItem(
      signature.startsWith("function ") ? signature : `function ${signature}`,
    );
    if (item.type !== "function") throw new Error("not a function");
    return item;
  } catch (error) {
    throw new ArtifactError(
      `"${signature}" is not a function signature: ${(error as Error).message}. ` +
        `Write it as it appears in Solidity, e.g. credit(address,uint256).`,
    );
  }
}

// --- turning config strings into ABI values --------------------------------

function coerceConstructorArgs(
  abi: Abi,
  args: string[],
  known: Partial<Record<Placeholder, string>>,
  contract: string,
): unknown[] {
  // Found by type rather than by name: a constructor has no name, and viem's `getAbiItem` looks
  // things up by one.
  const constructor = abi.find((item) => item.type === "constructor");
  const inputs = constructor && "inputs" in constructor ? constructor.inputs : [];
  if (inputs.length !== args.length) {
    throw new ArtifactError(
      `${contract}'s constructor takes ${inputs.length} argument(s) and [app] args gives ` +
        `${args.length}. It wants: ` +
        `${inputs.map((input) => `${input.type} ${input.name ?? ""}`.trim()).join(", ") || "nothing"}.`,
    );
  }
  return coerce(inputs, args, known, `${contract}'s constructor`);
}

/**
 * Config is text; the ABI is types. This is the only place the two meet.
 *
 * Deliberately narrow: value types and nothing else. A tuple or an array in a constructor is
 * expressible in TOML and would be guesswork to map, and guessing wrong here means deploying a
 * contract configured differently from what the file says. Such a project can use `script`.
 */
function coerce(
  inputs: readonly AbiParameter[],
  args: string[],
  known: Partial<Record<Placeholder, string>>,
  where: string,
): unknown[] {
  return inputs.map((input, index) => {
    const raw = substitute(args[index] ?? "", known);
    const type = input.type;

    if (type === "address") {
      if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
        throw new ArtifactError(`${where}: argument ${index} wants an address, got "${raw}"`);
      }
      return raw as Address;
    }
    if (type === "bool") {
      if (raw !== "true" && raw !== "false") {
        throw new ArtifactError(`${where}: argument ${index} wants true or false, got "${raw}"`);
      }
      return raw === "true";
    }
    if (type.startsWith("uint") || type.startsWith("int")) {
      try {
        return BigInt(raw);
      } catch {
        throw new ArtifactError(`${where}: argument ${index} wants ${type}, got "${raw}"`);
      }
    }
    if (type === "string") return raw;
    if (type.startsWith("bytes")) {
      if (!raw.startsWith("0x")) {
        throw new ArtifactError(`${where}: argument ${index} wants ${type} as hex, got "${raw}"`);
      }
      return raw as Hex;
    }
    throw new ArtifactError(
      `${where}: argument ${index} is ${type}, which this command does not know how to read ` +
        `from a config file. Use script = "<path>" under [app] and deploy it yourself.`,
    );
  });
}
