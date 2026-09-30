import {
  createPublicClient,
  fallback,
  http,
  webSocket,
  type Address,
  type Client,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";

import {
  NodeBusyError,
  NodeUnreachableError,
  SettlementLostError,
  SettlementTimeoutError,
  WrongNodeError,
  WriteOutsideDelegationError,
} from "./errors";
import { nodeSocketUrl } from "./watch";

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

/**
 * What `waitSettled` and `SendResult.settled` resolve with: the node's status at the moment
 * settlement was established, plus, when a transaction was being tracked, where it landed.
 */
export interface SettledStatus extends SessionStatus {
  /** The committed batch that carries the tracked transaction. Absent without a `hash`. */
  batchIndex?: number;
  /** The base-chain transaction that committed that batch, when the node recorded it. */
  settlementHash?: Hex | null;
}

/** One committed (or still collecting) batch, as `interlude_getBatch` serves it. */
export interface ServedBatch {
  batchIndex: number | null;
  settled: boolean;
  settlementHash: Hex | null;
  transactions: readonly { hash: Hex; blockNumber: number }[];
}

export type NodeClient = PublicClient<Transport, undefined>;

/**
 * A viem client pointed at the node, for everything that is safe to repeat.
 *
 * No `chain`, on purpose: the ephemeral chain id is the node's to report, and hardcoding it
 * here would let a client and a node disagree about which chain a transaction is signed for,
 * which the node rejects rather than guesses at.
 *
 * `transport` is there for a node that is not reached by a plain POST to `url`: an endpoint
 * behind an API key, or one proxied through the app's own backend.
 *
 * Default transport opens a WebSocket and keeps it (jsonrpsee serves WS on the same port).
 * Each tap used to pay a new HTTP connection; the socket is the round trip. HTTP is the
 * fallback when the environment has no WebSocket, or the upgrade fails.
 *
 * Reads only. A transaction is not safe to hand to a transport that retries and falls back on
 * its own: see `createSendClient`.
 */
export function createNodeClient(url: string, transport?: Transport): NodeClient {
  return createPublicClient({
    transport: transport ?? nodeTransport(url),
    name: "Interlude node",
  });
}

/**
 * The client a signed transaction goes through: no retries, no fallback.
 *
 * A read can be asked twice. A transaction whose response was lost cannot be blindly sent
 * again by the transport, because the SDK then sees "nonce too low" for the copy and cannot
 * tell whether the original ran. So the transport sends once and reports failure, and `send`
 * decides — by looking the transaction up by its hash first — whether anything needs sending
 * again, and then it resends the same signed bytes rather than signing a new transaction.
 */
export function createSendClient(url: string, via: "ws" | "http" = "ws", socket = 0): NodeClient {
  const transport =
    via === "ws" && typeof WebSocket !== "undefined"
      ? webSocket(sendSocketUrl(url, socket), { retryCount: 0 })
      : http(url, { retryCount: 0 });
  return createPublicClient({ transport, name: "Interlude node (send)" });
}

/**
 * Where send socket `socket` connects: the node's socket URL, with `?interlude_send=N` after the
 * first.
 *
 * viem keeps one socket per URL for the life of the page (its cache is keyed by the URL and the
 * keep-alive and reconnect settings, and not by the transport's `key`), and a socket that died
 * and ran out of its reconnects stays in that cache, dead: a transport built for the same URL
 * hands it back, and every request on it fails at once. So a socket tried again after a loss
 * connects at a URL of its own. The node serves JSON-RPC on any path and query, so the
 * parameter changes nothing there. Socket 0 keeps the plain URL, and so shares the socket the
 * node's reads already hold.
 */
export function sendSocketUrl(url: string, socket: number): string {
  const ws = nodeSocketUrl(url);
  if (socket === 0) return ws;
  const tried = new URL(ws);
  tried.searchParams.set("interlude_send", String(socket));
  return tried.toString();
}

/**
 * Close a send socket nothing will use again, and drop it from viem's cache.
 *
 * Only ever one the router opened after the first (see `sendSocketUrl`): socket 0 is the one
 * the node's reads use too, and closing it would cut them off. Left open, a replaced socket
 * would keep its keep-alive timer running for the rest of the page, and hold one of the few
 * sockets the node allows each caller. A socket that never opened has nothing to close, and
 * the error from trying is dropped.
 */
function closeSendClient(client: NodeClient): void {
  const transport = client.transport as { getRpcClient?: () => Promise<{ close(): void }> };
  transport.getRpcClient?.().then(
    (rpc) => rpc.close(),
    () => {},
  );
}

/**
 * How long sends stay on HTTP after the socket lost one: this at first, doubled for each loss in
 * a row...
 */
export const SEND_SOCKET_REST_MS = 2_000;
/** ...up to this. A socket that keeps losing sends is tried again once a minute, not never. */
export const SEND_SOCKET_REST_MAX_MS = 60_000;

/** Which transport a send goes over, and its client. */
export interface SendRouter {
  /** The client the next send goes through, and what it goes over. */
  client(): { client: NodeClient; via: "ws" | "http" };
  /** A send over `via` was lost on the way. Over the socket, sends rest on HTTP for a while. */
  lost(via: "ws" | "http"): void;
  /** A send over `via` arrived. Over the socket, the next loss rests the first time again. */
  delivered(via: "ws" | "http"): void;
}

/**
 * The socket for sends, and HTTP while it rests.
 *
 * A send is the one call the SDK cannot let a transport retry on its own (see
 * `createSendClient`), so a delivery the socket lost is resent over HTTP by `send`. It used to
 * stay there for the rest of the page: one dropped socket, on a phone changing networks say, and
 * every later tap paid HTTP's request instead of a frame on an open socket. Now the socket rests
 * instead: sends go over HTTP for `SEND_SOCKET_REST_MS`, twice that after a second loss in a row,
 * up to `SEND_SOCKET_REST_MAX_MS`, and then over a fresh socket again, at a URL of its own
 * (`sendSocketUrl`) so that viem opens a new connection instead of handing back the one that
 * lost the send. The socket it replaces is closed then, unless it is the first, which the reads
 * share. One arrival over the socket and the next loss starts from the first rest.
 *
 * `make`, `close` and `now` are there so a test can see which clients are made and closed, and
 * when, without a network or a clock.
 */
export function createSendRouter(
  url: string,
  options: {
    now?: () => number;
    firstRestMs?: number;
    maxRestMs?: number;
    make?: (url: string, via: "ws" | "http", socket: number) => NodeClient;
    close?: (client: NodeClient, socket: number) => void;
  } = {},
): SendRouter {
  const now = options.now ?? (() => Date.now());
  const firstRestMs = options.firstRestMs ?? SEND_SOCKET_REST_MS;
  const maxRestMs = options.maxRestMs ?? SEND_SOCKET_REST_MAX_MS;
  const make = options.make ?? createSendClient;
  const close = options.close ?? closeSendClient;

  /** Which socket: the page's first, then one more for each time the socket is tried again. */
  let socket = 0;
  /** Losses over the socket in a row, and when the socket may be tried again. */
  let losses = 0;
  let restingUntil: number | undefined;
  let current: { client: NodeClient; via: "ws" | "http"; socket: number } | undefined;
  /** The socket client made last, kept while sends rest on HTTP so it can be closed later. */
  let lastSocket: { client: NodeClient; socket: number } | undefined;

  const via = (): "ws" | "http" => (restingUntil !== undefined && now() < restingUntil ? "http" : "ws");

  return {
    client() {
      const wanted = via();
      if (wanted === "ws" && restingUntil !== undefined) {
        // The rest is over: a socket of its own, not the one that lost the send.
        restingUntil = undefined;
        socket += 1;
      }
      if (!current || current.via !== wanted || current.socket !== socket) {
        current = { client: make(url, wanted, socket), via: wanted, socket };
        if (wanted === "ws") {
          // Closed when replaced rather than when it lost the send: another send may still be
          // waiting on it then, and cutting it off would only turn that one into a loss too.
          if (lastSocket && lastSocket.socket > 0) close(lastSocket.client, lastSocket.socket);
          lastSocket = { client: current.client, socket };
        }
      }
      return { client: current.client, via: wanted };
    },
    lost(on) {
      if (on !== "ws") return;
      losses += 1;
      const rest = Math.min(firstRestMs * 2 ** (losses - 1), maxRestMs);
      restingUntil = now() + rest;
    },
    delivered(on) {
      if (on === "ws") losses = 0;
    },
  };
}

function nodeTransport(url: string): Transport {
  const httpTransport = http(url);
  if (typeof WebSocket === "undefined") {
    return httpTransport;
  }
  return fallback([webSocket(nodeSocketUrl(url), { retryCount: 0 }), httpTransport]);
}

export async function interludeSession(client: Client, url: string): Promise<SessionStatus> {
  return request<SessionStatus>(client, url, "interlude_session", []);
}

/**
 * A batch by index, or `"pending"` for the one still collecting.
 *
 * `null` for an index the node never settled. Throws when the node keeps no transaction log,
 * which is a configuration and not an absence.
 */
export async function interludeGetBatch(
  client: Client,
  url: string,
  batch: number | "pending",
): Promise<ServedBatch | null> {
  return request<ServedBatch | null>(client, url, "interlude_getBatch", [batch]);
}

/** The node's stored receipt for a hash, or `null` if it never ran it (or forgot it). */
export async function getReceipt(
  client: Client,
  url: string,
  hash: Hex,
): Promise<InterludeReceipt | null> {
  return request<InterludeReceipt | null>(client, url, "eth_getTransactionReceipt", [hash]);
}

export interface WaitSettledOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /**
   * Track this transaction rather than the node as a whole: resolve only once a committed
   * batch carries it, and reject with `SettlementLostError` if the node forgets it. This is
   * what `SendResult.settled` passes, and the only form that cannot resolve for a lost call.
   */
  hash?: Hex;
  /** The ephemeral block the tracked transaction ran in, to stop the batch search early. */
  blockNumber?: number;
  /**
   * With `hash`: how long the node may not know the transaction before it counts as lost.
   * Default 15 s, cut short once two more batches have landed without it.
   *
   * A node that restarts while a batch is frozen (handed to the commit, not yet on chain)
   * republishes that batch, but in between nothing it serves mentions its transactions: their
   * receipts lived in memory, and the batch is neither open nor committed. Calling them lost on
   * the first miss rejected calls that settled seconds later.
   */
  lostAfterMs?: number;
}

/** See `WaitSettledOptions.lostAfterMs`. */
const LOST_AFTER_MS = 15_000;

/**
 * Wait until what was sent is committed on the base chain, or until `timeoutMs`.
 *
 * A receipt from `send` is the ephemeral execution. Monad has the diffs only after a commit.
 * Call this when the page needs to say "settled" rather than "the node accepted it".
 *
 * With `hash` it tracks that one transaction through the node's batch log. Without it, it
 * waits for everything the node had executed when it was called: either nothing is pending, or
 * two more batches have been committed since — the first may already have been frozen when
 * the call was made, so only the one after it is certain to contain the rest. Under steady
 * traffic `pendingDiffs` is never empty, and waiting for that alone never resolves.
 */
export async function waitSettled(
  client: Client,
  url: string,
  options?: WaitSettledOptions,
): Promise<SettledStatus> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const intervalMs = options?.intervalMs ?? 400;
  const started = Date.now();
  const deadline = () => Date.now() - started >= timeoutMs;

  if (options?.hash) {
    return waitForTransaction(client, url, options.hash, options.blockNumber, {
      intervalMs,
      lostAfterMs: options.lostAfterMs ?? LOST_AFTER_MS,
      deadline,
      timeoutMs,
    });
  }

  let last = await interludeSession(client, url);
  const floor = last.committedBatches;
  for (;;) {
    if (last.pendingDiffs.length === 0 || last.committedBatches >= floor + 2) {
      return last;
    }
    if (deadline()) {
      throw new SettlementTimeoutError(last.pendingDiffs.length, last.committedBatches, timeoutMs);
    }
    await sleep(intervalMs);
    last = await interludeSession(client, url);
  }
}

/**
 * Follow one transaction into a committed batch.
 *
 * Committed batches never change, so each is fetched once. The search walks down from the
 * newest and stops at the first batch whose transactions all ran before this one: batches are
 * cut in execution order, so nothing further down can hold it. That is why the transaction's
 * block is looked up first when the caller did not pass it: without it, the first poll would
 * walk every batch the session ever committed.
 *
 * Between polls, what tells a transaction still waiting for its commit apart from one a
 * restarted node dropped is whether the node still knows it: its receipt, or — since receipts
 * live in memory and a node with a journal recovers its open batch but not those receipts —
 * its place in the batch still collecting. Only a transaction that is in neither, nor in any
 * committed batch, is lost — and only once it has stayed so for `lostAfterMs`, or through two
 * more committed batches: a batch frozen for its commit when the node restarted is in none of
 * those places until the new process lands it.
 */
async function waitForTransaction(
  client: Client,
  url: string,
  hash: Hex,
  blockNumber: number | undefined,
  timing: { intervalMs: number; lostAfterMs: number; deadline: () => boolean; timeoutMs: number },
): Promise<SettledStatus> {
  const wanted = hash.toLowerCase();
  // Since when, and as of which committed batch, the node has not known the transaction.
  let missing: { since: number; batches: number } | undefined;
  // Every batch up to this index has been searched (or is known to predate the transaction).
  let searched = 0;
  let firstPoll: number | undefined;
  let logless = false;

  if (blockNumber === undefined) {
    const receipt = await getReceipt(client, url, hash);
    if (receipt) blockNumber = Number(BigInt(receipt.blockNumber));
  }

  /** Searches what was committed since the last look; `undefined` for a node with no log. */
  const lookCommitted = async (status: SessionStatus, exhaustive = false) => {
    if (logless) return undefined;
    try {
      const found = exhaustive
        ? await searchBatches(client, url, wanted, undefined, 0, status)
        : await searchBatches(client, url, wanted, blockNumber, searched, status);
      if (!found) searched = Math.max(searched, status.committedBatches);
      return found;
    } catch (error) {
      // A node without a transaction log cannot say which batch holds what. Degrade to the
      // node-wide rule below rather than fail a wait the node can still answer.
      if (error instanceof NodeUnreachableError) throw error;
      logless = true;
      return undefined;
    }
  };

  const settledAt = (
    status: SessionStatus,
    found: { index: number; settlementHash: Hex | null },
  ): SettledStatus => ({ ...status, batchIndex: found.index, settlementHash: found.settlementHash });

  for (;;) {
    const status = await interludeSession(client, url);
    firstPoll ??= status.committedBatches;

    const found = await lookCommitted(status);
    if (found) return settledAt(status, found);

    if (await stillKnown(client, url, hash, wanted, logless)) {
      missing = undefined;
    } else {
      missing ??= { since: Date.now(), batches: status.committedBatches };
      const givenUp =
        logless ||
        Date.now() - missing.since >= timing.lostAfterMs ||
        status.committedBatches >= missing.batches + 2 ||
        timing.deadline();
      if (givenUp) {
        // It may have been committed between the search and the look at the open batch. And
        // this is the one place the search does not trust block order: a restarted node may
        // number its blocks afresh, so every batch is looked at once before calling it lost.
        const again = await interludeSession(client, url);
        const late = await lookCommitted(again, true);
        if (late) return settledAt(again, late);
        throw new SettlementLostError(hash, again.committedBatches);
      }
    }

    if (logless && (status.pendingDiffs.length === 0 || status.committedBatches >= firstPoll + 2)) {
      return status;
    }

    if (timing.deadline()) {
      throw new SettlementTimeoutError(
        status.pendingDiffs.length,
        status.committedBatches,
        timing.timeoutMs,
      );
    }
    await sleep(timing.intervalMs);
  }
}

/** Whether the node still has the transaction: a receipt, or a place in the open batch. */
async function stillKnown(
  client: Client,
  url: string,
  hash: Hex,
  wanted: string,
  logless: boolean,
): Promise<boolean> {
  if (await getReceipt(client, url, hash)) return true;
  if (logless) return false;
  try {
    const open = await interludeGetBatch(client, url, "pending");
    return Boolean(open?.transactions.some((tx) => tx.hash.toLowerCase() === wanted));
  } catch (error) {
    if (error instanceof NodeUnreachableError) throw error;
    return false;
  }
}

async function searchBatches(
  client: Client,
  url: string,
  wanted: string,
  blockNumber: number | undefined,
  searched: number,
  status: SessionStatus,
): Promise<{ index: number; settlementHash: Hex | null } | null> {
  for (let index = status.committedBatches; index > searched; index--) {
    const batch = await interludeGetBatch(client, url, index);
    if (!batch) break;
    if (batch.transactions.some((tx) => tx.hash.toLowerCase() === wanted)) {
      return { index, settlementHash: batch.settlementHash ?? null };
    }
    // An empty batch (a heartbeat) says nothing about ordering; keep walking past it.
    const newest = batch.transactions.reduce((max, tx) => Math.max(max, Number(tx.blockNumber)), -1);
    if (blockNumber !== undefined && newest >= 0 && newest < blockNumber) break;
  }
  return null;
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
    if (isMethodNotFound(error)) return null;
    throw error;
  }
}

/**
 * What a wallet has to do: send, then ask again for the receipt.
 *
 * Kept for a node that does not serve the fast path. It costs at least one more round trip, and
 * against a node answering in microseconds that round trip is most of the latency.
 *
 * `receipts` is where the receipt is polled from, which is allowed to retry: asking for a
 * receipt twice is harmless, sending a transaction twice is not.
 */
export async function sendCompatible(
  client: Client,
  url: string,
  raw: Hex,
  receipts: Client = client,
): Promise<InterludeReceipt> {
  const hash = await request<Hex>(client, url, "eth_sendRawTransaction", [raw]);

  for (let attempt = 0; attempt < 200; attempt++) {
    const receipt = await getReceipt(receipts, url, hash);
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
 * Whether the node answered "I do not serve that method".
 *
 * The standard code, or the wording some providers use instead of it. Anything else — a
 * dropped connection, a 502 while the node boots — is not an answer about the method at all,
 * and must not be remembered as one.
 */
export function isMethodNotFound(error: unknown): boolean {
  if (rpcCode(error) === METHOD_NOT_FOUND) return true;
  if (rpcCode(error) === undefined) return false;
  return /method .*(not found|not supported|does not exist|unsupported|is not available)/i.test(
    messageOf(error),
  );
}

/**
 * One place where a call to the node is made, so that a dead node reads as a dead node.
 *
 * A JSON-RPC error is the node answering and is passed through, typed where the SDK knows
 * what it means: the caller has to tell a reverted transaction from an unreachable process,
 * and backpressure from a misconfiguration.
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
    // A 429 is the node's front door (or the proxy in front of it) refusing before anything
    // ran: backpressure, not a dead node, and not an outcome to look up.
    if (httpStatus(error) === 429) {
      throw new NodeBusyError(true, "HTTP 429 Too Many Requests", error, { kind: "limit" });
    }
    if (rpcCode(error) === undefined) throw new NodeUnreachableError(url, error);
    throw classifyNodeError(error, url) ?? error;
  }
}

/** The HTTP status of a failed request, wherever viem wrapped it. */
function httpStatus(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth++) {
    const status = (current as { status?: unknown }).status;
    if (typeof status === "number") return status;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** `error.data.retryAfterSecs`, the node's hint on a -32005, in milliseconds. */
function retryAfterOf(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth++) {
    const data = (current as { data?: unknown }).data;
    const secs = (data as { retryAfterSecs?: unknown } | undefined)?.retryAfterSecs;
    if (typeof secs === "number" && Number.isFinite(secs) && secs >= 0) return secs * 1000;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** EIP-1474's "limit exceeded", which the node answers when it sheds or rate limits a call. */
const LIMIT_EXCEEDED = -32005;

/**
 * The node's refusals that deserve a name of their own.
 *
 * Matched on the node's wording because every one of them shares code -32000 or 3 with
 * unrelated errors. The phrases are the node's `NodeError` / `GuardError` messages.
 */
export function classifyNodeError(error: unknown, url: string): Error | undefined {
  const message = messageOf(error);

  // Checked first and by code: the node's rate limiter, its in-flight cap, its per-signer
  // admission budget and its call timeout all answer -32005, and none of them ran anything
  // that resending the same signed bytes could run twice (a timed-out call that did run is
  // refused as a replay and then found by its hash).
  if (rpcCode(error) === LIMIT_EXCEEDED) {
    const retryAfterMs = retryAfterOf(error);
    return new NodeBusyError(true, trimDetail(message), error, {
      kind: "limit",
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  if (/retry after the next commit/i.test(message)) {
    return new NodeBusyError(true, trimDetail(message), error);
  }
  if (/would make the open batch unsellable|alone would write \d+ unique diffs/i.test(message)) {
    return new NodeBusyError(false, trimDetail(message), error);
  }
  const serves = /this node only serves (0x[0-9a-fA-F]{40})/.exec(message);
  if (serves) {
    return new WrongNodeError(url, serves[1] as Address);
  }
  if (
    /outside the delegated app|which this delegation does not cover|not a delegated slot/i.test(
      message,
    )
  ) {
    return new WriteOutsideDelegationError(trimDetail(message), error);
  }
  return undefined;
}

/** The JSON-RPC error code, wherever viem wrapped it. */
export function rpcCode(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "number" && code !== -1) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Every message down the cause chain, since viem puts the node's own words a level or two in. */
function messageOf(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth++) {
    const record = current as { details?: unknown; message?: unknown; shortMessage?: unknown };
    for (const text of [record.details, record.shortMessage, record.message]) {
      if (typeof text === "string" && !parts.includes(text)) parts.push(text);
    }
    if (typeof current === "string") parts.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

function trimDetail(message: string): string {
  const first = message.split(" | ")[0] ?? message;
  return first.length > 240 ? `${first.slice(0, 240)}…` : first;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
