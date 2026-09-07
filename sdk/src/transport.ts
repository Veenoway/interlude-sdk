import {
  createPublicClient,
  http,
  type Address,
  type Client,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";

import { NodeUnreachableError } from "./errors";

/** The receipt shape the node answers with, which is an ordinary Ethereum receipt. */
export interface InterludeReceipt {
  transactionHash: Hex;
  transactionIndex: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  from: Address;
  to: Address;
  gasUsed: Hex;
  status: Hex;
  logs: readonly unknown[];
  /**
   * The transaction's return data, or its revert data when it failed.
   *
   * Only `interlude_sendTransaction` carries this. No chain can put it in a receipt, because on
   * a chain the transaction has not run when the receipt is asked for.
   */
  output?: Hex;
}

/** A slot the node holds a newer value for than the chain does. */
export interface PendingDiff {
  slot: Hex;
  committedValue: Hex;
  ephemeralValue: Hex;
}

/** What `interlude_session` reports: the session itself, and what is waiting to be committed. */
export interface SessionStatus {
  app: Address;
  chainId: number;
  validator: Address;
  resolver: Address;
  epoch: number;
  baseBlock: number;
  committedBatches: number;
  maxDiffsPerCommit: number;
  ephemeralBlock: number;
  execTimestamp: number;
  pendingDiffs: readonly PendingDiff[];
}

export type NodeClient = PublicClient<Transport, undefined>;

/**
 * A viem client pointed at the node.
 *
 * No `chain`, on purpose: the ephemeral chain id is the node's to report, and hardcoding it
 * here would let a client and a node disagree about which chain a transaction is signed for,
 * which the node rejects rather than guesses at.
 *
 * `transport` is there for a node that is not reached by a plain POST to `url`: an endpoint
 * behind an API key, or one proxied through the app's own backend.
 */
export function createNodeClient(url: string, transport?: Transport): NodeClient {
  return createPublicClient({ transport: transport ?? http(url), name: "Interlude node" });
}

export async function interludeSession(client: Client, url: string): Promise<SessionStatus> {
  return request<SessionStatus>(client, url, "interlude_session", []);
}

/** Ask the node to publish what is pending instead of waiting out its commit interval. */
export async function interludeCommit(
  client: Client,
  url: string,
  token?: string,
): Promise<{ transactionHash: Hex }> {
  return request<{ transactionHash: Hex }>(
    client,
    url,
    "interlude_commit",
    token === undefined ? [] : [token],
  );
}

/**
 * The fast path: submit and get the receipt and the return data back in one round trip.
 *
 * `null` means the node does not know the method, which is how an ordinary Ethereum node
 * answers. Everything else, including a transaction that ran and reverted, is a response.
 */
export async function sendFast(
  client: Client,
  url: string,
  raw: Hex,
): Promise<InterludeReceipt | null> {
  try {
    return await request<InterludeReceipt>(client, url, "interlude_sendTransaction", [raw]);
  } catch (error) {
    if (rpcCode(error) === METHOD_NOT_FOUND) return null;
    throw error;
  }
}

/**
 * What a wallet has to do: send, then ask again for the receipt.
 *
 * Kept for a node that does not serve the fast path. It costs at least one more round trip, and
 * against a node answering in microseconds that round trip is most of the latency.
 */
export async function sendCompatible(
  client: Client,
  url: string,
  raw: Hex,
): Promise<InterludeReceipt> {
  const hash = await request<Hex>(client, url, "eth_sendRawTransaction", [raw]);

  for (let attempt = 0; attempt < 200; attempt++) {
    const receipt = await request<InterludeReceipt | null>(
      client,
      url,
      "eth_getTransactionReceipt",
      [hash],
    );
    if (receipt) return receipt;
    await sleep(10);
  }

  throw new NodeUnreachableError(url, new Error(`no receipt for ${hash} after 2s`));
}

export function succeeded(receipt: InterludeReceipt): boolean {
  return BigInt(receipt.status) === 1n;
}

const METHOD_NOT_FOUND = -32601;

/**
 * One place where a call to the node is made, so that a dead node reads as a dead node.
 *
 * A JSON-RPC error is the node answering and is passed through: the caller has to tell a
 * reverted transaction from an unreachable process.
 */
async function request<T>(
  client: Client,
  url: string,
  method: string,
  params: readonly unknown[],
): Promise<T> {
  try {
    return (await client.request({ method, params } as never)) as T;
  } catch (error) {
    if (rpcCode(error) === undefined) throw new NodeUnreachableError(url, error);
    throw error;
  }
}

/** The JSON-RPC error code, wherever viem wrapped it. */
function rpcCode(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "number" && code !== -1) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
