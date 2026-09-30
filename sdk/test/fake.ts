/**
 * A node and a base chain in process, behind viem's `custom` transport.
 *
 * Just enough of each to exercise what the SDK does between the calls — nonces, retries,
 * settlement, backpressure, reconnects — without anvil or the Rust node. It is not a model of
 * the EVM: every call to the app "runs" by bumping a counter and returning it, which is all the
 * assertions below need, and the errors are the real node's wording so that the SDK's
 * classification is tested against what it will actually see.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionSerialized,
  type Transport,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import { delegatableAbi, hubAbi } from "../src/abi";

export const APP: Address = "0x00000000000000000000000000000000000a4401";
export const HUB: Address = "0x00000000000000000000000000000000000b0b00";
export const EPHEMERAL_CHAIN_ID = 4242;
export const BASE_CHAIN_ID = 31337;

/** `counter()` view and `bump(uint256)` write, the whole app surface the unit tests use. */
export const counterAbi = [
  {
    type: "function",
    name: "bump",
    stateMutability: "nonpayable",
    inputs: [{ name: "by", type: "uint256" }],
    outputs: [{ name: "total", type: "uint256" }],
  },
  {
    type: "function",
    name: "ping",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "counter",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "counterOf",
    stateMutability: "view",
    inputs: [{ name: "who", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "error",
    name: "Frozen",
    inputs: [{ name: "until", type: "uint256" }],
  },
] as const;

/** An error the way a JSON-RPC server sends one, which is what viem looks for. */
export function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

/** A transport failure: no code, so the SDK cannot mistake it for the node answering. */
export function dropped(): Error {
  return new Error("socket hang up");
}

interface Receipt {
  transactionHash: Hex;
  transactionIndex: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  from: Address;
  to: Address;
  gasUsed: Hex;
  status: Hex;
  logs: unknown[];
}

export type Fault =
  | "lose-response"
  | "busy"
  | "full"
  | "outside"
  | "drop-request"
  | "limited"
  | "http-429"
  | undefined;

export interface FakeNode {
  /** Transactions that actually ran. The one number a double execution cannot hide from. */
  executed: number;
  /** Every JSON-RPC method the SDK asked for, in order. */
  calls: string[];
  counter: bigint;
  nonces: Map<string, number>;
  receipts: Map<string, Receipt & { output: Hex }>;
  batches: { hash: Hex; blockNumber: number }[][];
  open: { hash: Hex; blockNumber: number }[];
  /**
   * A batch handed to the commit and not yet on chain. The real node serves it nowhere: not as
   * `"pending"` (that is the next batch), not by index (not settled yet).
   */
  frozen: { hash: Hex; blockNumber: number }[] | null;
  block: number;
  /** The app this node claims to serve. */
  serves: Address;
  /** Answer `interlude_*` with method-not-found, like an ordinary Ethereum node. */
  legacy: boolean;
  /** Decide, per send, what goes wrong. Called before the transaction is looked at. */
  fault?: (method: string, attempt: number) => Fault;
  /** Fail `interlude_session` this many more times with a dropped connection. */
  sessionFailures: number;
  /** Include `output` in `eth_getTransactionReceipt`, which the real node does not. */
  receiptOutput: boolean;
  /** Keep one diff pending forever, like a node under steady traffic. */
  steadyTraffic: boolean;
  /** Delay, per send, before the node sees it: how a network reorders concurrent requests. */
  jitter?: () => number;
  /**
   * Make every `eth_call` revert with these bytes ("0x": a halt with no data), answered the
   * way the node does since fix round 2: JSON-RPC error 3, "execution reverted", `data`.
   */
  callReverts?: Hex;
  /** Land the frozen batch if there is one, else close the open batch, as the next committed one. */
  commit(): number;
  /** Freeze the open batch for its commit, as the batcher does before publishing it. */
  freeze(): void;
  /**
   * A restart. Without a journal it loses everything not yet committed; with one it recovers
   * the open batch, but not the receipts, which the real node keeps only in memory.
   */
  restart(options?: { journal?: boolean }): void;
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

export function fakeNode(): FakeNode {
  const attempts = new Map<string, number>();

  const node: FakeNode = {
    executed: 0,
    calls: [],
    counter: 0n,
    nonces: new Map(),
    receipts: new Map(),
    batches: [],
    open: [],
    frozen: null,
    block: 1,
    serves: APP,
    legacy: false,
    sessionFailures: 0,
    receiptOutput: false,
    steadyTraffic: false,
    commit() {
      if (node.frozen) {
        node.batches.push(node.frozen);
        node.frozen = null;
      } else {
        node.batches.push(node.open);
        node.open = [];
      }
      return node.batches.length;
    },
    freeze() {
      node.frozen = node.open;
      node.open = [];
    },
    restart(options) {
      if (options?.journal) {
        node.receipts = new Map();
        return;
      }
      // The open batch is gone; a frozen one is in the WAL and comes back to be published.
      node.open = [];
      node.receipts = new Map(
        [...node.receipts].filter(([hash]) =>
          node.batches.some((batch) => batch.some((tx) => tx.hash === hash)),
        ),
      );
    },
    async request({ method, params }) {
      node.calls.push(method);
      const args = (params ?? []) as unknown[];

      if (node.legacy && method.startsWith("interlude_")) {
        throw rpcError(-32601, "Method not found");
      }

      switch (method) {
        case "eth_chainId":
          return toHex(EPHEMERAL_CHAIN_ID);
        case "eth_getTransactionCount":
          return toHex(node.nonces.get((args[0] as string).toLowerCase()) ?? 0);
        case "interlude_session": {
          if (node.sessionFailures > 0) {
            node.sessionFailures--;
            throw dropped();
          }
          return {
            app: node.serves,
            chainId: EPHEMERAL_CHAIN_ID,
            validator: HUB,
            resolver: HUB,
            epoch: 1,
            baseBlock: 1,
            committedBatches: node.batches.length,
            maxDiffsPerCommit: 64,
            ephemeralBlock: node.block,
            execTimestamp: 0,
            pendingDiffs:
              node.open.length > 0 || node.steadyTraffic
                ? [{ slot: toHex(0, { size: 32 }), committedValue: "0x", ephemeralValue: "0x" }]
                : [],
          };
        }
        case "interlude_getBatch": {
          const which = args[0];
          if (which === "pending") return { batchIndex: null, settled: false, settlementHash: null, transactions: node.open };
          const batch = node.batches[Number(which) - 1];
          if (!batch) return null;
          return {
            batchIndex: Number(which),
            settled: true,
            settlementHash: keccak256(toHex(`settle-${String(which)}`)),
            transactions: batch,
          };
        }
        case "eth_getTransactionReceipt": {
          const stored = node.receipts.get((args[0] as string).toLowerCase());
          if (!stored) return null;
          if (node.receiptOutput) return stored;
          const { output: _output, ...plain } = stored;
          return plain;
        }
        case "eth_call": {
          const call = args[0] as { data: Hex };
          if (node.callReverts !== undefined) {
            throw Object.assign(rpcError(3, "execution reverted"), { data: node.callReverts });
          }
          return simulate(node, call.data);
        }
        case "interlude_sendTransaction":
        case "eth_sendRawTransaction": {
          const raw = args[0] as Hex;
          const hash = keccak256(raw);
          const attempt = (attempts.get(hash) ?? 0) + 1;
          attempts.set(hash, attempt);

          const jitter = node.jitter?.() ?? 0;
          if (jitter > 0) await new Promise((resolve) => setTimeout(resolve, jitter));

          const fault = node.fault?.(method, attempt);
          if (fault === "drop-request") throw dropped();
          if (fault === "limited") {
            // The node's front door, as the node-rpc middleware answers it.
            throw Object.assign(rpcError(-32005, "too many requests from this caller; retry later"), {
              data: { retryAfterSecs: 0.05 },
            });
          }
          if (fault === "http-429") {
            // A proxy's refusal: no JSON-RPC body at all, only the status.
            throw Object.assign(new Error("HTTP request failed. Status: 429"), { status: 429 });
          }
          if (fault === "busy") {
            throw rpcError(
              -32000,
              "the open batch is full (512 txs, 65536 raw bytes); retry after the next commit",
            );
          }
          if (fault === "full") {
            throw rpcError(
              -32000,
              "this transaction alone would write 99 unique diffs, above maxDiffsPerCommit 64",
            );
          }
          if (fault === "outside") {
            throw rpcError(
              3,
              `write to slot 0x01 of ${APP}, which this delegation does not cover`,
            );
          }

          const receipt = await execute(node, raw);
          if (fault === "lose-response") throw dropped();
          if (method === "eth_sendRawTransaction") return receipt.transactionHash;
          return receipt;
        }
        default:
          throw rpcError(-32601, `Method not found: ${method}`);
      }
    },
  };

  return node;
}

async function execute(node: FakeNode, raw: Hex) {
  const tx = parseTransaction(raw as TransactionSerialized);
  const from = (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase();
  if (tx.chainId !== EPHEMERAL_CHAIN_ID) {
    throw rpcError(-32000, `this transaction is for chain Some(${tx.chainId}), but this node is chain ${EPHEMERAL_CHAIN_ID}`);
  }
  if (tx.to?.toLowerCase() !== node.serves.toLowerCase()) {
    throw rpcError(-32000, `this node only serves ${node.serves}, and this is addressed to ${tx.to}`);
  }
  const expected = node.nonces.get(from) ?? 0;
  if (tx.nonce! < expected) {
    throw rpcError(3, `transaction rejected before execution: nonce ${tx.nonce} too low, expected ${expected}`);
  }
  if (tx.nonce! > expected) {
    throw rpcError(3, `transaction rejected before execution: nonce ${tx.nonce} too high, expected ${expected}`);
  }

  node.nonces.set(from, expected + 1);
  node.executed++;
  const output = simulate(node, tx.data!, true);
  node.block++;
  const hash = keccak256(raw);
  const receipt = {
    transactionHash: hash,
    transactionIndex: "0x0" as Hex,
    blockNumber: toHex(node.block),
    blockHash: toHex(node.block, { size: 32 }),
    from: from as Address,
    to: node.serves,
    gasUsed: "0x5208" as Hex,
    status: "0x1" as Hex,
    logs: [],
    output,
  };
  node.receipts.set(hash, receipt);
  node.open.push({ hash, blockNumber: node.block });
  return receipt;
}

/** What `withSession(grant, sig, call)` returns for the inner call, applied or not. */
function simulate(node: FakeNode, data: Hex, apply = false): Hex {
  const { functionName, args } = decodeFunctionData({ abi: [...delegatableAbi, ...counterAbi], data });
  if (functionName === "counter") return encodeFunctionResult({ abi: counterAbi, functionName: "counter", result: node.counter });
  if (functionName === "counterOf") return encodeFunctionResult({ abi: counterAbi, functionName: "counterOf", result: node.counter });
  if (functionName !== "withSession") throw rpcError(3, `execution reverted: ${functionName}`);

  const inner = (args as readonly unknown[])[2] as Hex;
  const call = decodeFunctionData({ abi: counterAbi, data: inner });
  let innerReturn: Hex = "0x";
  if (call.functionName === "bump") {
    const total = node.counter + (call.args[0] as bigint);
    if (apply) node.counter = total;
    innerReturn = encodeFunctionResult({ abi: counterAbi, functionName: "bump", result: total });
  }
  return encodeAbiParameters([{ type: "bytes" }], [innerReturn]);
}

export interface FakeBase {
  calls: string[];
  epoch: bigint;
  /** Fail the next `eth_chainId` this many times with a dropped connection. */
  chainIdFailures: number;
  /** Fail the next `hub()` reads this many times. */
  hubFailures: number;
  /** Apply a `bumpSessionEpoch` only when told to, like a transaction waiting to be mined. */
  holdBumps: boolean;
  pendingBumps: number;
  mine(): void;
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

export function fakeBase(): FakeBase {
  const base: FakeBase = {
    calls: [],
    epoch: 0n,
    chainIdFailures: 0,
    hubFailures: 0,
    holdBumps: false,
    pendingBumps: 0,
    mine() {
      base.epoch += BigInt(base.pendingBumps);
      base.pendingBumps = 0;
    },
    async request({ method, params }) {
      base.calls.push(method);
      const args = (params ?? []) as unknown[];
      switch (method) {
        case "eth_chainId":
          if (base.chainIdFailures > 0) {
            base.chainIdFailures--;
            throw dropped();
          }
          return toHex(BASE_CHAIN_ID);
        case "eth_call": {
          const call = args[0] as { to: Address; data: Hex };
          if (call.to.toLowerCase() === APP.toLowerCase()) {
            if (base.hubFailures > 0) {
              base.hubFailures--;
              throw rpcError(429, "Too Many Requests");
            }
            return encodeFunctionResult({ abi: delegatableAbi, functionName: "hub", result: HUB });
          }
          return encodeFunctionResult({ abi: hubAbi, functionName: "sessionEpochOf", result: base.epoch });
        }
        case "eth_sendTransaction": {
          const [tx] = args as [{ to: Address; data: Hex }];
          const { functionName } = decodeFunctionData({ abi: hubAbi, data: tx.data });
          if (functionName === "bumpSessionEpoch") {
            if (base.holdBumps) base.pendingBumps++;
            else base.epoch++;
          }
          return keccak256(toHex(`base-${base.calls.length}`));
        }
        case "eth_estimateGas":
          return "0x5208";
        default:
          throw rpcError(-32601, `Method not found: ${method}`);
      }
    },
  };
  return base;
}

export interface Stack {
  node: FakeNode;
  chain: FakeBase;
  base: PublicClient;
  user: PrivateKeyAccount;
  wallet: WalletClient;
  browserWallet: WalletClient;
  nodeTransport: Transport;
}

/** A stack: the fake node and chain, a base client, and a user wallet holding a local key. */
export function stack(options?: { walletChainId?: number }): Stack {
  const node = fakeNode();
  const chain = fakeBase();
  const baseClient: PublicClient = createPublicClient({
    transport: custom({ request: (args) => chain.request(args) }, { retryDelay: 1 }),
  });
  const user = privateKeyToAccount(generatePrivateKey());
  const walletChainId = options?.walletChainId ?? BASE_CHAIN_ID;
  const walletTransport = custom({
    request: async (args: { method: string; params?: unknown }) =>
      args.method === "eth_chainId" ? toHex(walletChainId) : chain.request(args),
  });
  /** Signs in process, as an agent would. */
  const wallet: WalletClient = createWalletClient({ account: user, transport: walletTransport });
  /** A browser wallet: the key is elsewhere and the account is only an address. */
  const browserWallet: WalletClient = createWalletClient({ transport: walletTransport });
  // viem's default three retries are kept on purpose: resending the same bytes after a lost
  // response is exactly the behaviour the SDK has to survive. Only the delay is shortened.
  const nodeTransport = custom({ request: (args) => node.request(args) }, { retryDelay: 1 });
  return { node, chain, base: baseClient, user, wallet, browserWallet, nodeTransport };
}
