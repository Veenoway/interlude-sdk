/**
 * Checking the node against the chain, continuously, while the developer works.
 *
 * The demo scripts did this once at the end of their run. Doing it as batches land is worth more
 * than a tidier script: the questions "did that reach Monad" and "can somebody else prove it"
 * are the two a developer actually has while building, and answering them in the terminal beats
 * answering them in documentation.
 *
 * Nothing here trusts the node. Every claim it makes is put to the hub, which is the only party
 * with standing to confirm it.
 */

import type { Abi, Address, Hex, PublicClient } from "viem";
import { sleep } from "./processes.js";

export interface ServedTransaction {
  hash: Hex;
  raw: Hex;
  blockNumber: number;
  execTimestamp: number;
}

export interface ServedBatch {
  app: Address;
  partition: Hex;
  epoch: number;
  baseBlock: number;
  spec: string;
  batchIndex: number | null;
  txRoot: Hex;
  settled: boolean;
  transactions: ServedTransaction[];
}

export class VerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyError";
  }
}

export async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new VerifyError(`${method} failed: ${body.error.message ?? "no reason"}`);
  return body.result as T;
}

/**
 * The one thing worth checking before any traffic exists: that the node and the delegation agree
 * on which EVM rules the session runs under.
 *
 * A disagreement here is not a warning. The node would execute under rules the delegation does
 * not claim, every batch would contradict a replay, and an honest validator would look like a
 * fraudulent one. The node refuses to boot on a mismatch, so reaching this is already good news
 * — but the check is cheap and it is stated from the outside, which is where it counts.
 */
export async function checkRulesAgree(
  nodeRpc: string,
  chain: PublicClient,
  hubAbi: Abi,
  hub: Address,
  app: Address,
  partition: Hex,
): Promise<string> {
  const session = (await chain.readContract({
    address: hub,
    abi: hubAbi,
    functionName: "sessionOf",
    args: [app, partition],
  })) as { spec: number };

  const served = await rpc<ServedBatch | null>(nodeRpc, "interlude_getBatch", ["pending"]);
  if (!served) throw new VerifyError("the node served no pending batch, not even an empty one");

  // Types.Spec: 0 is Unset, 1 is MonadTen. The hub refuses to record Unset, so a session that
  // exists has a real value here.
  const onChain = session.spec === 1 ? "MonadTen" : `Spec(${session.spec})`;
  if (served.spec !== onChain) {
    throw new VerifyError(
      `the node says it runs ${served.spec} and the delegation says ${onChain}. ` +
        `Batches produced under rules the delegation does not claim are not reproducible.`,
    );
  }
  return onChain;
}

export interface VerifiedBatch {
  index: number;
  transactions: number;
  txRoot: Hex;
}

/**
 * Take one settled batch and put everything the node said about it to the chain.
 *
 * Two separate questions, and both matter. `batchTxRoot` says the root the node serves is the
 * root the validator signed. `isBatchLog` says the transactions it serves actually hash to that
 * root — which is the half that makes the log opposable rather than merely present.
 */
export async function verifyBatch(
  nodeRpc: string,
  chain: PublicClient,
  hubAbi: Abi,
  hub: Address,
  app: Address,
  partition: Hex,
  index: number,
): Promise<VerifiedBatch> {
  const served = await rpc<ServedBatch | null>(nodeRpc, "interlude_getBatch", [index]);
  if (!served) throw new VerifyError(`the node does not have batch ${index}`);
  if (!served.settled) {
    throw new VerifyError(`the node calls batch ${index} unsettled, but the hub has counted it`);
  }

  const signed = (await chain.readContract({
    address: hub,
    abi: hubAbi,
    functionName: "batchTxRoot",
    args: [app, partition, BigInt(index)],
  })) as Hex;

  if (served.txRoot.toLowerCase() !== signed.toLowerCase()) {
    throw new VerifyError(
      `batch ${index}: the node serves root ${served.txRoot} and the validator signed ${signed}`,
    );
  }

  const entries = served.transactions.map((tx) => ({
    txHash: tx.hash,
    blockNumber: BigInt(tx.blockNumber),
    execTimestamp: BigInt(tx.execTimestamp),
  }));
  const recognised = (await chain.readContract({
    address: hub,
    abi: hubAbi,
    functionName: "isBatchLog",
    args: [app, partition, BigInt(index), entries],
  })) as boolean;

  if (!recognised) {
    throw new VerifyError(
      `batch ${index}: Monad does not recognise the transactions the node served for it. ` +
        `The node's txRoot and the hub's hashTxLog disagree.`,
    );
  }

  return { index, transactions: served.transactions.length, txRoot: served.txRoot };
}

/**
 * Follow the commit counter and verify each batch as it settles.
 *
 * The counter comes from the node, so it is a claim; every batch it points at is then checked
 * against the chain, so the claim cannot inflate anything. A node under-reporting would only
 * hide its own work from this feed.
 */
export async function watchCommits(
  nodeRpc: string,
  chain: PublicClient,
  hubAbi: Abi,
  hub: Address,
  app: Address,
  partition: Hex,
  report: (batch: VerifiedBatch) => void,
  onError: (error: Error) => void,
): Promise<never> {
  let seen = 0;
  for (;;) {
    try {
      const status = await rpc<{ committedBatches?: number }>(nodeRpc, "interlude_session");
      const committed = status.committedBatches ?? 0;
      while (seen < committed) {
        seen += 1;
        report(await verifyBatch(nodeRpc, chain, hubAbi, hub, app, partition, seen));
      }
    } catch (error) {
      onError(error as Error);
    }
    await sleep(1_000);
  }
}
