/**
 * `interlude status <app>`: who owns it, whether it is delegated, and whether its node is up.
 *
 * These were three different places to look — the app, the hub, the node — and the answer that
 * matters most after `ship` (has my `--owner` actually taken ownership?) was in none of the
 * CLI's output. Everything on chain is read, not asked of the node, so a node that is down or
 * wrong cannot make this report look better than it is.
 */

import { createPublicClient, http, isAddress, parseAbi, type Address, type Hex } from "viem";

import { QUICK_TIMEOUT_MS, request } from "./http.js";
import { flag } from "./project.js";
import { baseRpcUrl, controlUrl } from "./ship.js";
import { fail, ok, pairs, say, step, warn } from "./ui.js";

export const GLOBAL_PARTITION =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

const APP_ABI = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function hub() view returns (address)",
]);

// Types.Session, whose layout is part of the hub's stable interface.
const HUB_ABI = parseAbi([
  "struct Session { address validator; address resolver; uint8 status; uint8 spec; uint256 epoch; uint256 batchIndex; uint64 baseBlock; uint64 lastExecTimestamp; uint64 lastCommitAt; uint64 maxBatchInterval; uint64 expiresAt; uint32 maxDiffsPerCommit; }",
  "function sessionOf(address app, bytes32 partition) view returns (Session)",
]);

const STATUS = ["None", "Active", "Exiting", "Challenged"] as const;

/** The part of a viem client this reads through, so a test can hand it a fake. */
export interface ChainReader {
  readContract(args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
}

export interface AppStatus {
  app: Address;
  hub: Address;
  owner: Address;
  /** Undefined when the app predates two-step ownership and has no `pendingOwner()`. */
  pendingOwner?: Address | undefined;
  partition: Hex;
  delegation: {
    status: (typeof STATUS)[number] | `Status(${number})`;
    validator: Address;
    epoch: bigint;
    batches: bigint;
    lastCommitAt: bigint;
    expiresAt: bigint;
    maxBatchInterval: bigint;
  };
}

interface Session {
  validator: Address;
  status: number;
  epoch: bigint;
  batchIndex: bigint;
  lastCommitAt: bigint;
  maxBatchInterval: bigint;
  expiresAt: bigint;
}

export async function readAppStatus(
  chain: ChainReader,
  app: Address,
  partition: Hex = GLOBAL_PARTITION,
): Promise<AppStatus> {
  const read = (functionName: string) =>
    chain.readContract({ address: app, abi: APP_ABI, functionName }) as Promise<Address>;

  const [owner, hub] = await Promise.all([read("owner"), read("hub")]);
  let pendingOwner: Address | undefined;
  try {
    pendingOwner = await read("pendingOwner");
  } catch {
    pendingOwner = undefined;
  }

  const session = (await chain.readContract({
    address: hub,
    abi: HUB_ABI,
    functionName: "sessionOf",
    args: [app, partition],
  })) as Session;

  return {
    app,
    hub,
    owner,
    pendingOwner,
    partition,
    delegation: {
      status: STATUS[session.status] ?? `Status(${session.status})`,
      validator: session.validator,
      epoch: session.epoch,
      batches: session.batchIndex,
      lastCommitAt: session.lastCommitAt,
      expiresAt: session.expiresAt,
      maxBatchInterval: session.maxBatchInterval,
    },
  };
}

const ZERO = "0x0000000000000000000000000000000000000000";

/** Rows for the terminal. `now` is injected so a test can pin "12s ago". */
export function statusRows(status: AppStatus, now = Math.floor(Date.now() / 1000)): [string, string][] {
  const d = status.delegation;
  const pending =
    status.pendingOwner && status.pendingOwner.toLowerCase() !== ZERO
      ? `${status.pendingOwner} — has not called acceptOwnership() yet`
      : status.pendingOwner === undefined
        ? "n/a (this app has no two-step ownership)"
        : "none";
  return [
    ["app", status.app],
    ["hub", status.hub],
    ["owner", status.owner],
    ["pending owner", pending],
    ["partition", status.partition === GLOBAL_PARTITION ? "GLOBAL (the whole contract)" : status.partition],
    ["delegation", d.status],
    ...(d.status === "None"
      ? []
      : ([
          ["validator", d.validator],
          ["epoch", d.epoch.toString()],
          ["batches", d.batches.toString()],
          ["last commit", d.lastCommitAt === 0n ? "never" : ago(d.lastCommitAt, now)],
          ["expires", d.expiresAt === 0n ? "never" : new Date(Number(d.expiresAt) * 1000).toISOString()],
        ] as [string, string][])),
  ];
}

function ago(timestamp: bigint, now: number): string {
  const seconds = now - Number(timestamp);
  const iso = new Date(Number(timestamp) * 1000).toISOString();
  if (seconds < 0) return iso;
  const span =
    seconds < 120 ? `${seconds}s` : seconds < 7200 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds / 3600)} h`;
  return `${iso} (${span} ago)`;
}

/** `/health`, which a node answers with a plain GET. Never throws: a dead node is a result. */
export async function nodeHealth(
  url: string,
  fetchImpl?: typeof fetch,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await request(
      `${url.replace(/\/$/, "")}/health`,
      { method: "GET" },
      { timeoutMs: QUICK_TIMEOUT_MS, what: "the node", ...(fetchImpl ? { fetchImpl } : {}) },
    );
    const text = await response.text();
    return {
      ok: response.ok,
      detail: response.ok ? compact(text) : `HTTP ${response.status}${text ? ` ${compact(text)}` : ""}`,
    };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}

function compact(text: string): string {
  const trimmed = text.trim();
  try {
    return JSON.stringify(JSON.parse(trimmed));
  } catch {
    return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
  }
}

/** The node control knows for this app, if any. A miss is not an error: it may be self-hosted. */
async function nodeFromControl(control: string, app: Address): Promise<string | undefined> {
  try {
    const response = await request(
      `${control}/sessions/${app}`,
      { method: "GET" },
      { timeoutMs: QUICK_TIMEOUT_MS, what: "the control plane" },
    );
    if (!response.ok) return undefined;
    const body = (await response.json()) as { url?: string };
    return body.url;
  } catch {
    return undefined;
  }
}

export async function status(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h") || !argv[0]) {
    say(
      `interlude status <app> [--rpc <url>] [--node <url>] [--partition <bytes32>]\n\n` +
        `Owner, pending owner, delegation status and epoch from the hub, and the node's /health.\n` +
        `--rpc defaults to INTERLUDE_BASE_RPC, then Monad testnet. --node defaults to the node\n` +
        `the control plane has for this app. For \`interlude dev\`: --rpc http://127.0.0.1:8547\n` +
        `--node http://127.0.0.1:8555.`,
    );
    if (!argv[0]) process.exitCode = 1;
    return;
  }

  const app = argv[0];
  if (!isAddress(app)) fail(`${app} is not an address. interlude status <app>`);
  const partition = (flag(argv, "--partition") ?? GLOBAL_PARTITION) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(partition)) fail(`--partition wants 32 bytes of hex`);

  const rpc = baseRpcUrl(argv);
  step(`reading ${app} on ${rpc}`);
  const chain = createPublicClient({ transport: http(rpc, { timeout: QUICK_TIMEOUT_MS }) });
  let report: AppStatus;
  try {
    report = await readAppStatus(chain as unknown as ChainReader, app, partition);
  } catch (error) {
    fail(
      `could not read ${app} on ${rpc}: ${(error as { shortMessage?: string }).shortMessage ?? (error as Error).message}. ` +
        `Is it a Delegatable app on that chain? (--rpc picks the chain.)`,
    );
  }
  pairs(statusRows(report));

  const node = flag(argv, "--node") ?? (await nodeFromControl(controlUrl(argv), app));
  if (!node) {
    say("");
    warn("no node known for this app. Pass --node <url> to check one.");
    return;
  }
  const health = await nodeHealth(node);
  say("");
  if (health.ok) ok(`node ${node} is up: ${health.detail}`);
  else warn(`node ${node} is not healthy: ${health.detail}`);
}
