/**
 * The client against an in-process node: what it does when the network does not cooperate.
 *
 * Every test here is one of the audit's findings, stated as the failure it used to produce.
 * None of them needs anvil or the Rust node; `test/fake.ts` answers in their place, with the
 * real node's error wording.
 */
import { encodeErrorResult } from "viem";
import { describe, expect, it } from "vitest";

import {
  AppRevertError,
  NodeBusyError,
  NodeUnreachableError,
  ResultUnavailableError,
  SessionRevokedError,
  SettlementLostError,
  SettlementTimeoutError,
  UnrecognisedRevertError,
  WriteOutsideDelegationError,
  WrongChainError,
  WrongNodeError,
  createInterludeClient,
  memoryStore,
} from "../src/index";
import { APP, BASE_CHAIN_ID, counterAbi, stack } from "./fake";

function clientFor(s: ReturnType<typeof stack>, overrides: Record<string, unknown> = {}) {
  return createInterludeClient({
    app: APP,
    abi: counterAbi,
    node: "http://node.test",
    transport: s.nodeTransport,
    base: s.base,
    store: memoryStore(),
    ...overrides,
  });
}

async function opened(s: ReturnType<typeof stack>, overrides: Record<string, unknown> = {}) {
  const client = clientFor(s, overrides);
  const session = await client.openSession({ wallet: s.wallet, scope: ["bump", "ping"] });
  return { client, session };
}

describe("F5: a failure while loading is not remembered", () => {
  it("asks for the base chain id again after a dropped connection", async () => {
    const s = stack();
    s.chain.chainIdFailures = 4; // past viem's own three retries
    const client = clientFor(s);

    await expect(client.baseChainId()).rejects.toThrow();
    await expect(client.baseChainId()).resolves.toBe(BASE_CHAIN_ID);
    // And the answer, once there is one, is kept.
    await client.baseChainId();
    expect(s.chain.calls.filter((m) => m === "eth_chainId")).toHaveLength(5); // 4 failed, 1 kept
  });

  it("asks for the hub again after a 429 from the public RPC", async () => {
    const s = stack();
    s.chain.hubFailures = 4;
    const client = clientFor(s);

    await expect(client.hubAddress()).rejects.toThrow();
    await expect(client.hubAddress()).resolves.toMatch(/^0x/);
  });

  it("asks the node for its chain id again after the 502 it serves while booting", async () => {
    const s = stack();
    let failures = 4;
    const inner = s.node.request;
    s.node.request = async (args) => {
      if (args.method === "eth_chainId" && failures-- > 0) throw new Error("502 Bad Gateway");
      return inner(args);
    };
    const client = clientFor(s);

    await expect(client.ephemeralChainId()).rejects.toThrow();
    await expect(client.ephemeralChainId()).resolves.toBe(4242);
  });

  it("opens a session once the node answers, on the same client", async () => {
    const s = stack();
    s.chain.chainIdFailures = 4; // past viem's own three retries
    const client = clientFor(s);

    await expect(client.openSession({ wallet: s.wallet, scope: ["bump"] })).rejects.toThrow();
    const session = await client.openSession({ wallet: s.wallet, scope: ["bump"] });
    expect((await session.send("bump", [1n])).result).toBe(1n);
  });
});

describe("F6: a lost response does not run the call twice", () => {
  it("finds the call by its hash when the transport resends it and hears 'nonce too low'", async () => {
    const s = stack();
    s.node.receiptOutput = true;
    const { session } = await opened(s);
    // The first delivery runs and its answer is lost; viem's own retry then sends the same
    // bytes, which the node refuses as a replay. That refusal used to make the SDK sign a new
    // transaction with a fresh nonce, and the node ran the call a second time.
    s.node.fault = (method, attempt) =>
      method === "interlude_sendTransaction" && attempt === 1 ? "lose-response" : undefined;

    const { result } = await session.send("bump", [5n]);

    expect(s.node.executed).toBe(1);
    expect(s.node.counter).toBe(5n);
    expect(result).toBe(5n);
  });

  it("says the call ran, rather than sending it again, when the receipt has no return data", async () => {
    const s = stack();
    const { session } = await opened(s);
    s.node.fault = (method, attempt) =>
      method === "interlude_sendTransaction" && attempt === 1 ? "lose-response" : undefined;

    const failure = await session.send("bump", [5n]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ResultUnavailableError);
    expect((failure as ResultUnavailableError).receipt.status).toBe("0x1");
    expect(s.node.executed).toBe(1);

    // The nonce moved with it: the next call is the next transaction, not a replay.
    s.node.fault = undefined;
    expect((await session.send("bump", [1n])).result).toBe(6n);
    expect(s.node.executed).toBe(2);
  });

  it("resends the same bytes when the request never arrived", async () => {
    const s = stack();
    const { session } = await opened(s);
    s.node.fault = (method, attempt) =>
      method === "interlude_sendTransaction" && attempt === 1 ? "drop-request" : undefined;

    expect((await session.send("bump", [2n])).result).toBe(2n);
    expect(s.node.executed).toBe(1);
  });

  it("still resynchronises when another tab really did use the nonce", async () => {
    const s = stack();
    const { session } = await opened(s);
    await session.send("bump", [1n]);

    // Another tab holding the same key sent six calls of its own, so this client's count is
    // stale. Its transaction is not on the node under any hash, so signing afresh is safe.
    s.node.nonces.set(session.sessionKey.toLowerCase(), 7);

    expect((await session.send("bump", [1n])).result).toBe(2n);
    expect(s.node.executed).toBe(2);
  });

  it("does not sign a new transaction when it cannot ask whether the first one ran", async () => {
    const s = stack();
    const { session } = await opened(s);
    // The call runs and its answer is lost; viem's retry hears "nonce too low"; and the lookup
    // that would settle it fails too. Unknown is not "never ran": signing afresh here used to be
    // a second execution whenever the lookup and the answer were lost together.
    s.node.fault = (method, attempt) =>
      method === "interlude_sendTransaction" && attempt === 1 ? "lose-response" : undefined;
    const inner = s.node.request;
    s.node.request = async (args) => {
      if (args.method === "eth_getTransactionReceipt") throw new Error("fetch failed");
      return inner(args);
    };

    await expect(session.send("bump", [5n])).rejects.toThrow(/nonce/);
    expect(s.node.executed).toBe(1);

    // The next call re-reads the nonce instead of reusing the spent one.
    s.node.request = inner;
    s.node.fault = undefined;
    expect((await session.send("bump", [1n])).result).toBe(6n);
    expect(s.node.executed).toBe(2);
  });

  it("fails honestly when the node cannot be reached at all", async () => {
    const s = stack();
    const { session } = await opened(s);
    const inner = s.node.request;
    s.node.request = async (args) => {
      if (args.method === "interlude_sendTransaction" || args.method === "eth_getTransactionReceipt") {
        throw new Error("fetch failed");
      }
      return inner(args);
    };

    await expect(session.send("bump", [1n])).rejects.toBeInstanceOf(NodeUnreachableError);
    expect(s.node.executed).toBe(0);
  });
});

describe("F7: settled means this call is in a committed batch", () => {
  it("resolves under steady traffic, where pendingDiffs is never empty", async () => {
    const s = stack();
    const { session } = await opened(s);
    s.node.steadyTraffic = true;

    const sent = await session.send("bump", [1n]);
    setTimeout(() => s.node.commit(), 30);

    const settled = await sent.settled;
    expect(settled.batchIndex).toBe(1);
    expect(settled.pendingDiffs.length).toBeGreaterThan(0);
  });

  it("does not resolve before the batch carrying the call is committed", async () => {
    const s = stack();
    const { client, session } = await opened(s);

    const first = await session.send("bump", [1n]);
    s.node.commit(); // batch 1 carries `first`
    const second = await session.send("bump", [1n]);

    await expect(
      client.waitSettled({ hash: second.hash, timeoutMs: 150, intervalMs: 20 }),
    ).rejects.toBeInstanceOf(SettlementTimeoutError);
    expect((await client.waitSettled({ hash: first.hash })).batchIndex).toBe(1);

    s.node.commit();
    expect((await second.settled).batchIndex).toBe(2);
  });

  it("rejects when a restarted node dropped the call, instead of calling it settled", async () => {
    const s = stack();
    const { session } = await opened(s);

    const sent = await session.send("bump", [1n]);
    s.node.restart(); // nothing pending any more, and no record of the call
    // Two heartbeats land without it: whatever the node had frozen is on chain by now.
    setTimeout(() => s.node.commit(), 100);
    setTimeout(() => s.node.commit(), 200);

    await expect(sent.settled).rejects.toBeInstanceOf(SettlementLostError);
  });

  it("calls a call lost once the node has not known it for lostAfterMs", async () => {
    const s = stack();
    const { client, session } = await opened(s);

    const sent = await session.send("bump", [1n]);
    s.node.restart();

    const started = Date.now();
    await expect(
      client.waitSettled({ hash: sent.hash, intervalMs: 10, lostAfterMs: 100 }),
    ).rejects.toBeInstanceOf(SettlementLostError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });

  it("keeps waiting for a call whose batch was frozen for its commit when the node restarted", async () => {
    const s = stack();
    const { session } = await opened(s);

    const sent = await session.send("bump", [1n]);
    // The batcher froze the batch and started publishing it; then the process restarted. The
    // receipt is gone, the batch is neither open nor committed, and the new process lands it.
    s.node.freeze();
    s.node.restart();
    setTimeout(() => s.node.commit(), 1_000);

    expect((await sent.settled).batchIndex).toBe(1);
  });

  it("keeps waiting across a restart that recovered the call from its journal", async () => {
    const s = stack();
    const { session } = await opened(s);

    const sent = await session.send("bump", [1n]);
    // The journal brought the open batch back, but receipts live in memory: the node has no
    // receipt for the call and will still commit it. That is not a lost call.
    s.node.restart({ journal: true });
    setTimeout(() => s.node.commit(), 60);

    expect((await sent.settled).batchIndex).toBe(1);
  });

  it("does not walk every batch the session committed while the call is still pending", async () => {
    const s = stack();
    const { client, session } = await opened(s);
    for (let i = 0; i < 30; i++) {
      await session.send("bump", [1n]);
      s.node.commit();
    }
    const sent = await session.send("bump", [1n]);

    // Only the hash, as a caller holding it from elsewhere would pass it.
    const before = s.node.calls.length;
    const waiting = client.waitSettled({ hash: sent.hash, intervalMs: 10 });
    setTimeout(() => s.node.commit(), 40);
    expect((await waiting).batchIndex).toBe(31);

    // Every earlier batch predates the call, and the first one looked at says so.
    const batchReads = s.node.calls.slice(before).filter((m) => m === "interlude_getBatch");
    expect(batchReads.length).toBeLessThan(15);
  });

  it("without a hash, waits for what was executed rather than for an idle node", async () => {
    const s = stack();
    const { client, session } = await opened(s);
    s.node.steadyTraffic = true;
    await session.send("bump", [1n]);

    const waiting = client.waitSettled({ timeoutMs: 2_000, intervalMs: 10 });
    setTimeout(() => s.node.commit(), 20);
    setTimeout(() => s.node.commit(), 40);
    const status = await waiting;
    expect(status.committedBatches).toBeGreaterThanOrEqual(2);
  });
});

describe("F9: the fast path is not given up on a transient failure", () => {
  it("keeps using interlude_sendTransaction after the probe hit a dropped connection", async () => {
    const s = stack();
    s.node.sessionFailures = 4; // past viem's own three retries
    const { session } = await opened(s);

    expect((await session.send("bump", [3n])).result).toBe(3n);
    expect((await session.send("bump", [1n])).result).toBe(4n);

    expect(s.node.calls).not.toContain("eth_sendRawTransaction");
    // No pre-flight simulation either: that is only for the compatible path.
    expect(s.node.calls.filter((m) => m === "eth_call")).toHaveLength(0);
  });

  it("does remember a node that says it has no such method", async () => {
    const s = stack();
    s.node.legacy = true;
    const { session } = await opened(s);

    expect((await session.send("bump", [2n])).result).toBe(2n);
    expect((await session.send("bump", [2n])).result).toBe(4n);

    expect(s.node.calls.filter((m) => m === "interlude_session")).toHaveLength(1);
    expect(s.node.calls.filter((m) => m === "eth_sendRawTransaction")).toHaveLength(2);
  });
});

describe("F13: the node's refusals come back typed", () => {
  it("waits out backpressure and sends the same call again", async () => {
    const s = stack();
    const { session } = await opened(s);
    s.node.fault = (method, attempt) =>
      method === "interlude_sendTransaction" && attempt <= 2 ? "busy" : undefined;

    expect((await session.send("bump", [1n])).result).toBe(1n);
    expect(s.node.executed).toBe(1);
  });

  it("gives up with NodeBusyError when the node stays busy", async () => {
    const s = stack();
    const { session } = await opened(s, { busyRetries: 1 });
    s.node.fault = () => "busy";

    const failure = await session.send("bump", [1n]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NodeBusyError);
    expect((failure as NodeBusyError).retryable).toBe(true);
    expect(s.node.executed).toBe(0);

    // Nothing ran, so the nonce was not spent and the next call goes straight through.
    s.node.fault = undefined;
    expect((await session.send("bump", [1n])).result).toBe(1n);
  });

  it("does not retry a call that can never fit", async () => {
    const s = stack();
    const { session } = await opened(s);
    let tries = 0;
    s.node.fault = () => {
      tries++;
      return "full";
    };

    const failure = await session.send("bump", [1n]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NodeBusyError);
    expect((failure as NodeBusyError).retryable).toBe(false);
    expect(tries).toBe(1);
  });

  it("waits out the node's rate limit (-32005) for as long as it asks, same transaction", async () => {
    const s = stack();
    const { session } = await opened(s);
    // Past viem's own retries, so the SDK's wait is the one that gets it through.
    s.node.fault = (method, attempt) =>
      method === "interlude_sendTransaction" && attempt <= 5 ? "limited" : undefined;

    expect((await session.send("bump", [4n])).result).toBe(4n);
    expect(s.node.executed).toBe(1);
  });

  it("reads an HTTP 429 as backpressure, not as a dead node", async () => {
    const s = stack();
    const { session } = await opened(s, { busyRetries: 0 });
    s.node.fault = () => "http-429";

    const failure = await session.send("bump", [1n]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NodeBusyError);
    expect((failure as NodeBusyError).kind).toBe("limit");
    expect(s.node.executed).toBe(0);

    s.node.fault = (_method, attempt) => (attempt === 1 ? "http-429" : undefined);
    const { session: again } = await opened(s);
    expect((await again.send("bump", [1n])).result).toBe(1n);
  });

  it("names a write outside the delegation", async () => {
    const s = stack();
    const { session } = await opened(s);
    s.node.fault = () => "outside";

    await expect(session.send("bump", [1n])).rejects.toBeInstanceOf(WriteOutsideDelegationError);
  });

  it("names a node that serves another app", async () => {
    const s = stack();
    s.node.serves = "0x000000000000000000000000000000000000dead";
    const { session } = await opened(s);

    const failure = await session.send("bump", [1n]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WrongNodeError);
    expect((failure as WrongNodeError).expected).toBe(APP);
  });
});

describe("F17: concurrent sends keep their order", () => {
  it("delivers twenty calls fired at once, in order, each exactly once", async () => {
    const s = stack();
    const { session } = await opened(s);
    // Each request takes a different time to reach the node, which is what reordered nonces
    // when every send went out as soon as it had one.
    s.node.jitter = () => Math.floor(Math.random() * 8);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => session.send("bump", [1n]).then((r) => r.result)),
    );

    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => BigInt(i + 1)));
    expect(s.node.executed).toBe(20);
    expect(s.node.counter).toBe(20n);
  });
});

describe("F8 and F12: revocation and the wallet's chain", () => {
  it("stops using a revoked session at once, and says why the node lags", async () => {
    const s = stack();
    const { client, session } = await opened(s);
    await session.send("bump", [1n]);

    await client.revokeAll(s.browserWallet, s.user.address);

    const failure = await session.send("bump", [1n]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionRevokedError);
    expect((failure as Error).message).toContain("pinned");
    expect(s.node.executed).toBe(1);
  });

  it("refuses to open a grant the pending revocation would kill", async () => {
    const s = stack();
    const { client } = await opened(s);
    s.chain.holdBumps = true;

    await client.revokeAll(s.browserWallet, s.user.address);
    await expect(
      client.openSession({ wallet: s.wallet, scope: ["bump"], force: true }),
    ).rejects.toBeInstanceOf(SessionRevokedError);

    s.chain.mine();
    const fresh = await client.openSession({ wallet: s.wallet, scope: ["bump"], force: true });
    expect(fresh.grant.epoch).toBe(1n);
  });

  it("refuses to revoke from a wallet on another network", async () => {
    const s = stack({ walletChainId: 1 });
    const client = clientFor(s);

    const failure = await client
      .revokeAll(s.browserWallet, s.user.address)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WrongChainError);
    expect((failure as WrongChainError).expected).toBe(BASE_CHAIN_ID);
    expect(s.chain.calls).not.toContain("eth_sendTransaction");
  });

  it("refuses to ask a browser wallet on another network to sign the grant", async () => {
    const s = stack({ walletChainId: 1 });
    const client = clientFor(s);

    await expect(
      client.openSession({ wallet: s.browserWallet, account: s.user.address, scope: ["bump"] }),
    ).rejects.toBeInstanceOf(WrongChainError);
  });

  it("lets a key held in process sign whatever chain its transport is on", async () => {
    const s = stack({ walletChainId: 1 });
    const client = clientFor(s);

    const session = await client.openSession({ wallet: s.wallet, scope: ["bump"] });
    expect((await session.send("bump", [1n])).result).toBe(1n);
  });
});

describe("F10: arguments are required when the function takes any", () => {
  it("still sends a function that takes none without an argument list", async () => {
    const s = stack();
    const { session } = await opened(s);

    await expect(session.send("ping")).resolves.toMatchObject({ result: undefined });
  });
});

describe("a node that answers a reverted eth_call with JSON-RPC error 3", () => {
  // Frozen(7), the app's own error.
  const frozen = encodeErrorResult({ abi: counterAbi, errorName: "Frozen", args: [7n] });

  it("surfaces a reverted read as the app's typed revert", async () => {
    const s = stack();
    const { client } = await opened(s);
    s.node.callReverts = frozen;

    const failure = await client.read("counter").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppRevertError);
    expect((failure as AppRevertError).errorName).toBe("Frozen");
    expect((failure as AppRevertError).args).toEqual([7n]);
  });

  it("surfaces a halt with no revert data as an unrecognised revert, not a viem error", async () => {
    const s = stack();
    const { client } = await opened(s);
    s.node.callReverts = "0x";

    await expect(client.read("counter")).rejects.toBeInstanceOf(UnrecognisedRevertError);
  });

  it("types the compatible path's pre-flight revert and sends nothing", async () => {
    const s = stack();
    s.node.legacy = true; // no interlude_sendTransaction: simulate, then send
    const { session } = await opened(s);
    s.node.callReverts = frozen;

    const failure = await session.send("bump", [1n]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppRevertError);
    expect((failure as AppRevertError).errorName).toBe("Frozen");
    expect(s.node.executed).toBe(0);
  });
});
