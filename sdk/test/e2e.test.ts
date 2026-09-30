/**
 * The whole thing against a real node: anvil as the base chain, `Players` delegated, the Rust
 * node serving it. `scripts/sdk-e2e.sh` stands all of that up and points this suite at it.
 *
 * Ordered on purpose and run in one file, because it is one story: a user opens a session,
 * plays, reloads the page, settles, and then hits every wall the contract puts up. The last
 * test revokes, which is the end of the road for every session in this file.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";

import {
  AppRevertError,
  SelectorOutOfSessionScopeError,
  SessionEpochStaleError,
  SessionExpiredError,
  SettlementTimeoutError,
  createInterludeClient,
  createNodeClient,
  decodeRevert,
  decodeSession,
  delegatableAbi,
  delegatableErrorsAbi,
  memoryStore,
  sendFast,
  storageKey,
  succeeded,
  webStorageStore,
  type InterludeClient,
  type Session,
  type SessionStore,
} from "../src/index";
import { LIVE } from "./live";
import { playersAbi } from "./players";

const baseRpc = process.env.INTERLUDE_BASE_RPC ?? "http://127.0.0.1:8545";
const nodeRpc = process.env.INTERLUDE_NODE_RPC ?? "http://127.0.0.1:8546";
const app = (process.env.INTERLUDE_APP ?? "") as Address;
/**
 * anvil's fourth account, which is the one the deploy script delegates a partition for.
 *
 * Distinct from the admin, the validator and the resolver, so a passing assertion here cannot
 * be one of those accounts' authority standing in for the granter's.
 */
const playerPk = (process.env.INTERLUDE_PLAYER_PK ??
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6") as Hex;

/** anvil's fifth account, for the one test that revokes and cannot put it back. */
const otherPk = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" as Hex;

const player = privateKeyToAccount(playerPk);

/** Counts what the user is asked to do. The claim is: once, for the whole session. */
let prompts = 0;

const base: PublicClient = createPublicClient({ chain: anvil, transport: http(baseRpc) });
const wallet: WalletClient = countingWallet(
  createWalletClient({ account: player, chain: anvil, transport: http(baseRpc) }),
);

/** One tab's `sessionStorage`, which is what has to survive a reload and nothing more. */
const tab = fakeSessionStorage();

const latencies: number[] = [];

function newClient(store = webStorageStore(tab), overrides = {}): InterludeClient<typeof playersAbi> {
  return createInterludeClient({
    app,
    abi: playersAbi,
    node: nodeRpc,
    base,
    store,
    ...overrides,
  });
}

describe.skipIf(!LIVE)("a session key against a live node", () => {
  let client: InterludeClient<typeof playersAbi>;
  let session: Session<typeof playersAbi>;

  beforeAll(async () => {
    expect(app, "INTERLUDE_APP must name the deployed Players").toMatch(/^0x[0-9a-fA-F]{40}$/);
    client = newClient();

    // If this is wrong nothing below means anything: the node has to be serving this app.
    const status = await client.status();
    expect(status.app.toLowerCase()).toBe(app.toLowerCase());
    expect(status.chainId).not.toBe(await client.baseChainId());
  });

  afterAll(() => {
    if (latencies.length === 0) return;
    const sorted = [...latencies].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    console.log(
      `\n  ${sorted.length} session calls: median ${at(0.5)?.toFixed(3)}ms, ` +
        `p95 ${at(0.95)?.toFixed(3)}ms, min ${sorted[0]?.toFixed(3)}ms, ` +
        `max ${sorted[sorted.length - 1]?.toFixed(3)}ms (signing plus one round trip)\n`,
    );
  });

  it("opens a session with exactly one wallet signature", async () => {
    session = await client.openSession({ wallet, scope: ["move"] });

    expect(prompts).toBe(1);
    expect(session.restored).toBe(false);
    expect(session.granter.toLowerCase()).toBe(player.address.toLowerCase());
    expect(session.sessionKey.toLowerCase()).not.toBe(player.address.toLowerCase());
    expect(session.covers("move")).toBe(true);
    expect(session.grant.epoch).toBe(await client.epochOf(player.address));
  });

  /** The digest the SDK signs has to be the one the app computes, or nothing verifies. */
  it("agrees with the app about the digest it signed", async () => {
    expect(await client.sessionDigest(session.grant)).toBe(
      await client.sessionDigestOnChain(session.grant),
    );
  });

  it("moves the granter's own square, and asks the wallet for nothing more", async () => {
    const before = await client.read("squareOf", [player.address]);

    const first = await session.send("move", [3n]);
    const second = await session.send("move", [2n]);
    latencies.push(first.latencyMs, second.latencyMs);

    // The decoded return value of the inner call, back through the wrapper's `bytes`.
    expect(first.result).toBe(before + 3n);
    expect(second.result).toBe(before + 5n);

    expect(await client.read("squareOf", [player.address])).toBe(before + 5n);
    // The actor is the granter, not the key that signed. If this were the other way round the
    // write would land on a slot the delegation does not cover and the node would refuse it.
    expect(await client.read("squareOf", [session.sessionKey])).toBe(0n);
    expect(prompts).toBe(1);
  });

  it("sends a burst of calls with nothing but the session key", async () => {
    const before = await client.read("squareOf", [player.address]);

    for (let i = 0; i < 25; i++) {
      const { result, receipt, latencyMs } = await session.send("move", [1n]);
      latencies.push(latencyMs);
      expect(result).toBe(before + BigInt(i + 1));
      expect(succeeded(receipt)).toBe(true);
    }

    expect(await client.read("squareOf", [player.address])).toBe(before + 25n);
    expect(prompts).toBe(1);

    // 27 calls so far and one slot to write: the whole point of the ephemeral layer.
    const status = await client.status();
    expect(status.pendingDiffs).toHaveLength(1);
    expect(status.pendingDiffs[0]?.slot.toLowerCase()).toBe(
      (await client.read("squareSlot", [player.address])).toLowerCase(),
    );

    await expect(client.waitSettled({ timeoutMs: 250, intervalMs: 80 })).rejects.toThrow(
      SettlementTimeoutError,
    );
  });

  it("reports what the node is serving", async () => {
    const status = await client.status();

    expect(status.validator).not.toBe("0x0000000000000000000000000000000000000000");
    expect(status.baseBlock).toBeGreaterThan(0);
    expect(status.ephemeralBlock).toBeGreaterThan(0);
    expect(status.committedBatches).toBe(0);
  });

  /**
   * A reload keeps the tab's storage and loses everything else, so a fresh client with the same
   * storage is what a refresh looks like. No prompt is the entire user-visible point.
   */
  it("restores the key and its grant across a reload, with no prompt", async () => {
    const reloaded = newClient();
    const restored = await reloaded.restoreSession(player.address, { scope: ["move"] });

    expect(restored).not.toBeNull();
    expect(restored?.restored).toBe(true);
    expect(restored?.sessionKey).toBe(session.sessionKey);
    expect(restored?.signature).toBe(session.signature);
    expect(prompts).toBe(1);

    const before = await reloaded.read("squareOf", [player.address]);
    const { result } = await restored!.send("move", [1n]);
    expect(result).toBe(before + 1n);
    expect(prompts).toBe(1);

    // And `openSession` prefers it too, which is why a developer never has to choose.
    const reopened = await reloaded.openSession({ wallet, scope: ["move"] });
    expect(reopened.sessionKey).toBe(session.sessionKey);
    expect(prompts).toBe(1);
  });

  it("bubbles the app's own revert back as the app's own error", async () => {
    // `move` caps at 6 steps. The revert crosses the wrapper verbatim, and it has to come back
    // as TooFar(7, 6) rather than as an opaque blob.
    await expect(session.send("move", [7n])).rejects.toThrowError(AppRevertError);

    const failure = await session.send("move", [7n]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppRevertError);
    expect((failure as AppRevertError).errorName).toBe("TooFar");
    expect((failure as AppRevertError).args).toEqual([7n, 6n]);
  });

  it("settles on the base chain when the node commits", async () => {
    // Tracked by its own hash: `settled` resolves only once a committed batch carries it.
    const sent = await session.send("move", [1n]);
    const ephemeral = await client.read("squareOf", [player.address]);
    expect(await client.readSettled("squareOf", [player.address])).not.toBe(ephemeral);

    const { transactionHash } = await client.commit();
    expect(transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    await base.waitForTransactionReceipt({ hash: transactionHash });

    expect(await client.readSettled("squareOf", [player.address])).toBe(ephemeral);
    expect((await client.status()).pendingDiffs).toHaveLength(0);
    const settled = await client.waitSettled({ timeoutMs: 5_000 });
    expect(settled.pendingDiffs).toHaveLength(0);

    const mine = await sent.settled;
    expect(mine.committedBatches).toBeGreaterThanOrEqual(1);
    // A node that keeps its transaction log names the batch; one that does not still settles.
    if (mine.batchIndex !== undefined) expect(mine.batchIndex).toBe(mine.committedBatches);
  });

  /**
   * The transport an ordinary Ethereum node forces: send, then ask again for the receipt. Kept
   * working, and measured beside the fast path because the difference is the point of having
   * one.
   */
  it("still works without interlude_sendTransaction, more slowly", async () => {
    const compatible = newClient(webStorageStore(tab), { fastPath: false });
    const restored = await compatible.restoreSession(player.address, { scope: ["move"] });
    expect(restored).not.toBeNull();

    const before = await compatible.read("squareOf", [player.address]);
    const slow: number[] = [];
    for (let i = 0; i < 5; i++) {
      const { result, latencyMs } = await restored!.send("move", [1n]);
      expect(result).toBe(before + BigInt(i + 1));
      slow.push(latencyMs);
    }

    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    console.log(
      `\n  compatible path median ${median(slow).toFixed(3)}ms ` +
        `against fast path median ${median(latencies).toFixed(3)}ms\n`,
    );
  });

  // --- the walls -------------------------------------------------------

  it("refuses a call the grant does not cover, before it costs a round trip", async () => {
    const store = memoryStore();
    const narrow = newClient(store);
    // A selector the app does not have, so the grant is well formed and admits nothing `move`
    // needs. `Players` has one writable function, so this is the only way to be out of scope.
    const scoped = await narrow.openSession({ wallet, scope: ["0xdeadbeef"], force: true });

    const failure = await scoped.send("move", [1n]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SelectorOutOfSessionScopeError);
    expect((failure as SelectorOutOfSessionScopeError).source).toBe("grant");

    // And the contract refuses the same call when that check is skipped, which is what the
    // local one is standing in for.
    const receipt = await presentGrant(narrow, scoped, await keyIn(store, narrow, scoped));
    expect(succeeded(receipt)).toBe(false);
    expect(decode(receipt.output)).toBeInstanceOf(SelectorOutOfSessionScopeError);
  });

  it("refuses an expired grant, locally and on the node", async () => {
    const store = memoryStore();
    const stale = newClient(store);
    const expired = await stale.openSession({
      wallet,
      scope: ["move"],
      expirySeconds: -60,
      force: true,
    });
    // Read before the call: the SDK drops a session it knows is finished, so that nothing
    // restores it later, and the key would be gone by then.
    const key = await keyIn(store, stale, expired);

    await expect(expired.send("move", [1n])).rejects.toThrowError(SessionExpiredError);

    const receipt = await presentGrant(stale, expired, key);
    expect(succeeded(receipt)).toBe(false);
    expect(decode(receipt.output)).toBeInstanceOf(SessionExpiredError);
  });

  /**
   * The panic button, and the two halves of what it does.
   *
   * On the base chain a bump is immediate, so the SDK stops restoring the stored grant at once
   * and the user signs again. The node reads the epoch at the block its delegation pinned, so
   * the grant it will accept is still the old one until that pin moves: a fresh grant naming
   * the new epoch is what comes back as `SessionEpochStale`, and the error has to say so
   * rather than leave a developer chasing a selector hash.
   *
   * Revoked on a second account rather than the player's, since a bump cannot be undone and
   * the tests above would then depend on running first.
   */
  it("stops restoring a revoked session, and explains the node's pin", async () => {
    const other = privateKeyToAccount(otherPk);
    const otherWallet = createWalletClient({
      account: other,
      chain: anvil,
      transport: http(baseRpc),
    });

    const store = memoryStore();
    const revoking = newClient(store);
    await revoking.openSession({ wallet: otherWallet, scope: ["move"], force: true });
    expect(await revoking.restoreSession(other.address, { scope: ["move"] })).not.toBeNull();

    const before = await revoking.epochOf(other.address);
    const hash = await revoking.revokeAll(otherWallet);
    await base.waitForTransactionReceipt({ hash });
    expect(await revoking.epochOf(other.address)).toBe(before + 1n);

    expect(await revoking.restoreSession(other.address, { scope: ["move"] })).toBeNull();

    const reopened = await revoking.openSession({
      wallet: otherWallet,
      scope: ["move"],
      force: true,
    });
    expect(reopened.grant.epoch).toBe(before + 1n);

    const failure = await reopened.send("move", [1n]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionEpochStaleError);
    expect((failure as SessionEpochStaleError).grantEpoch).toBe(before + 1n);
    expect((failure as SessionEpochStaleError).hubEpoch).toBe(before + 1n);
    expect((failure as Error).message).toContain("pinned");

    // The player's own session is untouched, so nothing above depends on running first.
    expect(await client.restoreSession(player.address, { scope: ["move"] })).not.toBeNull();
  });
});

// --- helpers -------------------------------------------------------------

/** Present a grant without the SDK's own checks, to find out what the contract does with it. */
async function presentGrant(
  client: InterludeClient<typeof playersAbi>,
  session: Session<typeof playersAbi>,
  privateKey: Hex,
) {
  const key = privateKeyToAccount(privateKey);
  const node = createNodeClient(nodeRpc);

  const data = encodeFunctionData({
    abi: delegatableAbi,
    functionName: "withSession",
    args: [
      session.grant,
      session.signature,
      encodeFunctionData({ abi: playersAbi, functionName: "move", args: [1n] }),
    ],
  });

  const raw = await key.signTransaction({
    type: "eip1559",
    chainId: await client.ephemeralChainId(),
    nonce: await node.getTransactionCount({ address: key.address }),
    to: client.app,
    data,
    value: 0n,
    gas: 2_000_000n,
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
  });

  const receipt = await sendFast(node, nodeRpc, raw);
  expect(receipt, "the node has to serve interlude_sendTransaction").not.toBeNull();
  return receipt!;
}

/**
 * The session key itself, read back out of the store the client wrote it to.
 *
 * The same path a restored session takes, which is what makes it fair to use here.
 */
async function keyIn(
  store: SessionStore,
  client: InterludeClient<typeof playersAbi>,
  session: Session<typeof playersAbi>,
): Promise<Hex> {
  const stored = decodeSession(
    store.get(storageKey(client.app, await client.baseChainId(), session.granter)),
  );
  expect(stored, "the session should have been written to its store").not.toBeNull();
  return stored!.privateKey;
}

function decode(data: Hex | undefined) {
  return decodeRevert(data ?? "0x", [...playersAbi, ...delegatableErrorsAbi]);
}

function countingWallet(inner: WalletClient): WalletClient {
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "signTypedData") {
        return (...args: unknown[]) => {
          prompts++;
          return (target.signTypedData as (...a: unknown[]) => unknown)(...args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/** `sessionStorage` as a plain object, so a reload can be simulated in Node. */
function fakeSessionStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => void entries.delete(key),
    setItem: (key: string, value: string) => void entries.set(key, value),
  };
}
