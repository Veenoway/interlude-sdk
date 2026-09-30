import { createPublicClient, http, isAddress, isHex, type Address, type Hex } from "viem";

import { DEPLOY_TIMEOUT_MS, QUICK_TIMEOUT_MS, request } from "./http.js";
import { flag } from "./project.js";
import { baseRpcUrl, controlUrl, parseShipRegion } from "./ship.js";
import { readAppStatus, type ChainReader } from "./status.js";
import { fail, note, ok, pairs, say, step, warn } from "./ui.js";

/**
 * Ask the operator control plane for a node, or look one up.
 *
 * Control runs a node, on its own account, only for an app it deployed itself (`interlude ship`)
 * or one whose owner asked for it. It watches `DelegationOpened`, but a stranger who merely
 * delegates to our validator does not get a machine: that was a free fleet for anyone. So an app
 * you deployed and delegated yourself — or one shipped before a control redeploy forgot it —
 * needs the owner's opt-in, an EIP-191 signature of
 *
 *     interlude:provision:<app, lowercase>:<the hub session's epoch>
 *
 * by the address `owner()` returns, passed as `--signature`. The epoch pins the opt-in to this
 * delegation: a signature for a session you have since closed cannot be replayed on the next.
 */

const USAGE =
  `interlude sessions create <app> [--signature 0x...] [--region <floor>]\n` +
  `interlude sessions opt-in <app>     print the message the owner signs, and the command\n` +
  `interlude sessions get <app>\n\n` +
  `  --signature 0x...  the owner's EIP-191 signature of interlude:provision:<app>:<epoch>\n` +
  `  --region <floor>   us|ny|eu|asia|sa|tokyo|mumbai|africa; omit = nearest to you\n` +
  `  --rpc <url>        base chain, to read owner() and the epoch (default: Monad testnet)\n` +
  `  --control <url>    control plane (default: the public one)`;

export class SessionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionsError";
  }
}

/** Byte for byte what control's `optInMessage` checks (packages/control/src/provision.ts). */
export function optInMessage(app: Address, epoch: bigint): string {
  return `interlude:provision:${app.toLowerCase()}:${epoch}`;
}

/**
 * `cast wallet sign` signs EIP-191 (personal_sign) by default, which is what control recovers.
 * `--interactive` asks for the key on the terminal, so it is never on the command line.
 */
export function signCommand(message: string): string {
  return `cast wallet sign --interactive "${message}"`;
}

/** Reading the epoch by hand: the fifth field of `Types.Session`. */
export function epochCommand(hub: Address, app: Address, rpc: string): string {
  return (
    `cast call ${hub} "sessionOf(address,bytes32)((address,address,uint8,uint8,uint256,uint256,uint64,uint64,uint64,uint64,uint64,uint32))" ` +
    `${app} 0x${"00".repeat(32)} --rpc-url ${rpc}`
  );
}

/** A 65-byte signature, as `cast wallet sign` prints it. Anything else is refused before sending. */
export function parseOptInSignature(value: string | undefined): Hex | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!isHex(trimmed) || !/^0x[0-9a-fA-F]{130}$/.test(trimmed)) {
    throw new SessionsError(
      `--signature must be the 65-byte 0x signature \`cast wallet sign\` prints (132 characters), got ${value.length} characters`,
    );
  }
  return trimmed as Hex;
}

export function createBody(app: Address, region?: string, signature?: Hex): Record<string, string> {
  return { app, ...(region ? { region } : {}), ...(signature ? { signature } : {}) };
}

export interface OptIn {
  owner: Address;
  hub: Address;
  epoch: bigint;
  message: string;
  lines: string[];
}

/**
 * What the owner has to sign right now, read from the chain: `owner()` and `hub()` from the app,
 * the epoch from the hub's `sessionOf`. The lines are printed as they are.
 */
export async function optInFor(chain: ChainReader, app: Address, rpc: string): Promise<OptIn> {
  const status = await readAppStatus(chain, app);
  const { epoch } = status.delegation;
  const message = optInMessage(app, epoch);
  return {
    owner: status.owner,
    hub: status.hub,
    epoch,
    message,
    lines: [
      `control runs a node for ${app} once its owner asks. From ${status.owner} (the app's owner()), sign:`,
      ``,
      `  ${message}`,
      ``,
      `  ${signCommand(message)}`,
      ``,
      `(--account <name> or --ledger instead of --interactive work as well.) Then:`,
      ``,
      `  interlude sessions create ${app} --signature 0x...`,
      ``,
      `The epoch (${epoch}) is the hub session's; it changes when the app delegates again, and so`,
      `does the message. To read it yourself: ${epochCommand(status.hub, app, rpc)}`,
    ],
  };
}

function readerFor(rpc: string): ChainReader {
  return createPublicClient({ transport: http(rpc) }) as unknown as ChainReader;
}

async function printOptIn(app: Address, rpc: string): Promise<void> {
  let optIn: OptIn;
  try {
    optIn = await optInFor(readerFor(rpc), app, rpc);
  } catch (error) {
    warn(`could not read ${app}'s owner and epoch from ${rpc}: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
    note(`sign "interlude:provision:${app.toLowerCase()}:<epoch>" from the app's owner, where <epoch> is sessionOf(app, 0x0).epoch on the hub.`);
    return;
  }
  for (const line of optIn.lines) say(line);
}

export async function sessions(argv: string[]): Promise<void> {
  const command = argv[0];
  if (argv.includes("--help") || argv.includes("-h")) {
    say(USAGE);
    return;
  }
  if (command !== "create" && command !== "get" && command !== "opt-in") fail(USAGE);

  const raw = argv[1];
  if (!raw || !isAddress(raw)) fail("pass the delegated app address");
  const app = raw as Address;
  const rpc = baseRpcUrl(argv);

  if (command === "opt-in") {
    step(`the opt-in for ${app}`);
    await printOptIn(app, rpc);
    return;
  }

  const url = controlUrl(argv);
  const token = flag(argv, "--token") ?? process.env.INTERLUDE_CONTROL_TOKEN;
  const region = parseShipRegion(flag(argv, "--region"));
  let signature: Hex | undefined;
  try {
    signature = parseOptInSignature(flag(argv, "--signature"));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  step(command === "create" ? `asking for a node at ${app}` : `looking up ${app}`);

  // A create provisions a machine, which can take minutes; a lookup that slow is stuck.
  const response = await request(
    command === "create" ? `${url}/sessions` : `${url}/sessions/${app}`,
    {
      method: command === "create" ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(command === "create" ? { body: JSON.stringify(createBody(app, region, signature)) } : {}),
    },
    command === "create"
      ? { timeoutMs: DEPLOY_TIMEOUT_MS, what: "the control plane", progress: true }
      : { timeoutMs: QUICK_TIMEOUT_MS, what: "the control plane" },
  );

  const body = (await response.json().catch(() => ({}))) as {
    url?: string;
    name?: string;
    status?: string;
    error?: string;
  };

  if (!response.ok) {
    // 403: control does not know this app and nobody opted in. Say exactly what to sign, with
    // the epoch read from the hub, rather than leaving the reader with control's one line.
    if (command === "create" && response.status === 403 && !/operator floor/.test(body.error ?? "")) {
      process.stderr.write(`${body.error ?? "control refused"}\n\n`);
      await printOptIn(app, rpc);
      fail(signature ? "the signature was refused; check it is from owner() and for this epoch" : "opt-in needed");
    }
    fail(body.error ?? `control ${response.status}`);
  }
  if (!body.url) fail("control answered without a url");

  ok(body.url);
  pairs([
    ["app", app],
    ["node", body.url],
    ...(body.name ? ([["name", body.name]] as [string, string][]) : []),
    ...(body.status ? ([["status", body.status]] as [string, string][]) : []),
  ]);
  if (command === "create") {
    note("point the SDK at that node. commits settle on our validator.");
    say("");
  }
}
