import {
  decodeAbiParameters,
  decodeFunctionResult,
  defineChain,
  encodeFunctionData,
  keccak256,
  slice,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Client,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type ContractFunctionReturnType,
  type Hex,
  type Transport,
  type WalletClient,
} from "viem";
import {
  addChain,
  call,
  getChainId,
  getTransactionCount,
  readContract,
  switchChain,
  writeContract,
} from "viem/actions";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { delegatableAbi, delegatableErrorsAbi, GLOBAL_PARTITION, hubAbi } from "./abi";
import {
  InterludeError,
  NodeBusyError,
  NodeUnreachableError,
  ResultUnavailableError,
  SelectorOutOfSessionScopeError,
  SessionEpochStaleError,
  SessionExpiredError,
  SessionNotSignedByGranterError,
  SessionRevokedError,
  SessionUnusableError,
  WrongChainError,
  WrongNodeError,
  WrongSessionKeyError,
  decodeRevert,
  type RevertContext,
} from "./errors";
import {
  grantCovers,
  resolveScope,
  sessionGrantDigest,
  signSessionGrant,
  type ScopeEntry,
  type SessionGrant,
} from "./grant";
import {
  decodeSession,
  defaultStore,
  encodeSession,
  storageKey,
  type SessionStore,
  type StoredSession,
} from "./storage";
import {
  classifyNodeError,
  createNodeClient,
  createSendRouter,
  getReceipt,
  interludeCommit,
  interludeSession,
  isMethodNotFound,
  rpcCode,
  sendCompatible,
  sendFast,
  sleep,
  succeeded,
  waitSettled,
  type InterludeReceipt,
  type NodeClient,
  type SessionStatus,
  type SettledStatus,
  type WaitSettledOptions,
} from "./transport";
import { createAppliedFeed, type AppliedCall, type AppliedFeed, type WatchOptions } from "./watch";

/** One hour. Short enough that a forgotten tab stops mattering, long enough to play in. */
export const DEFAULT_EXPIRY_SECONDS = 3600;

/**
 * Fixed rather than estimated. Gas is free here and an `eth_estimateGas` round trip before every
 * call would cost more than the call itself; the ceiling is the EIP-7825 per-transaction cap the
 * ephemeral EVM enforces, the same one the base chain does.
 */
const DEFAULT_GAS = 5_000_000n;

/** A grant this close to expiry is treated as spent: better one prompt than a failed call. */
const DEFAULT_EXPIRY_MARGIN_SECONDS = 15;

/** How many times a call the node parked for backpressure is sent again before giving up. */
const DEFAULT_BUSY_RETRIES = 5;

/** The longest single wait `send` sits through for backpressure before handing it back. */
const MAX_BUSY_WAIT_MS = 5_000;

/** A watched view is re-read at most this often, however many calls land in between. */
const DEFAULT_WATCH_MIN_INTERVAL_MS = 50;

/** How often a watched view polls while the node's socket is down. */
const DEFAULT_WATCH_FALLBACK_MS = 500;

/**
 * Base chains the SDK can add to a wallet by itself.
 *
 * Spelled out rather than imported from `viem/chains`, so that a host on an older viem that
 * predates the entry still builds.
 */
const KNOWN_BASE_CHAINS: Record<number, Chain> = {
  10143: defineChain({
    id: 10143,
    name: "Monad Testnet",
    nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
    blockExplorers: {
      default: { name: "Monad Explorer", url: "https://testnet.monadexplorer.com" },
    },
    testnet: true,
  }),
};

type Writable = "nonpayable" | "payable";
type Readable = "view" | "pure";

/**
 * A function's arguments as a rest parameter: required when it takes any, optional when it
 * takes none.
 *
 * `send("move")` for a `move(uint256)` used to compile, because `args` was optional for every
 * function, and failed at run time in the ABI encoder. An ABI that is not `as const` has
 * unknown arguments, so they stay optional there rather than becoming impossible to omit.
 */
export type ArgsParameter<TArgs> = readonly [] extends TArgs ? [args?: TArgs] : [args: TArgs];

export interface SendResult<TResult> {
  /** The inner call's return value, decoded out of the wrapper's `bytes`. */
  result: TResult;
  receipt: InterludeReceipt;
  hash: Hex;
  /** Wall clock for the whole call: waiting its turn, signing with the session key, the round trip. */
  latencyMs: number;
  /**
   * Resolves when a batch carrying this transaction is committed on the base chain, with the
   * batch's index. Rejects with `SettlementLostError` if the node forgets the transaction (a
   * restart that dropped what it had not committed; see `WaitSettledOptions.lostAfterMs` for
   * the grace a frozen batch gets), and with `SettlementTimeoutError` after
   * 60 s. Lazy: unused `settled` does not poll.
   */
  settled: Promise<SettledStatus>;
}

export interface Session<TAbi extends Abi> {
  /** The end user. What the app's `_actor()` returns, and whose state moves. */
  readonly granter: Address;
  /** The generated key that signs every call. Holds no funds and never needs any. */
  readonly sessionKey: Address;
  readonly grant: SessionGrant;
  readonly signature: Hex;
  readonly expiresAt: Date;
  /** True when this session was restored from storage rather than freshly signed. */
  readonly restored: boolean;

  isExpired(): boolean;
  /** Whether the grant admits a function, by name, signature or selector. */
  covers(entry: ScopeEntry): boolean;

  /**
   * One gasless call. Calls from one session key go out one at a time, in the order they were
   * made, so their nonces reach the node in order however many are awaited at once.
   */
  send<TFunctionName extends ContractFunctionName<TAbi, Writable>>(
    functionName: TFunctionName,
    ...args: ArgsParameter<ContractFunctionArgs<TAbi, Writable, TFunctionName>>
  ): Promise<SendResult<ContractFunctionReturnType<TAbi, Writable, TFunctionName>>>;

  /** Forget the key and the grant. The grant stays valid on chain until it expires. */
  discard(): void;
}

export interface OpenSessionOptions {
  /** The user's wallet. Prompted exactly once, for the grant. */
  wallet: WalletClient;
  /** Which account signs, if the wallet client does not carry one. */
  account?: Account | Address;
  /** Function names, full signatures or 4-byte selectors this key may call. */
  scope?: readonly ScopeEntry[];
  /**
   * A key that may call anything the app does not privilege.
   *
   * Explicit because it is a footgun: a grant is meant to say "only `move`", and that is what
   * the wallet prompt should show. It is also the only grant that survives an app's own
   * external self-calls.
   */
  anyFunction?: boolean;
  expirySeconds?: number;
  /** Sign a new grant even if a usable one is in storage. */
  force?: boolean;
  /**
   * Check the locally computed EIP-712 digest against the app's own `sessionDigest` before
   * asking the user to sign. One extra read, and it turns a silent encoding mismatch into a
   * throw naming both digests.
   */
  assertDigest?: boolean;
  /**
   * Ask the wallet to switch to (or add) the base chain when it is on another one, instead of
   * throwing `WrongChainError`. A browser wallet refuses to sign a grant whose EIP-712 domain
   * names another chain than the active one, with a message that names neither.
   */
  ensureChain?: boolean;
}

export interface InterludeClientConfig<TAbi extends Abi> {
  /** The `Delegatable` app. Also the EIP-712 `verifyingContract`. */
  app: Address;
  /** The app's ABI. Used for encoding, for decoding, and to resolve a scope from names. */
  abi: TAbi;
  /** The node's JSON-RPC url. Also what an unreachable-node error names. */
  node: string;
  /**
   * How to reach it, when a plain POST to `node` is not it: an API key, a proxy of your own.
   *
   * Used for reads and for sends alike. Transactions are protected either way — before a call
   * is ever signed again the SDK looks the first one up by its hash — but a transport that
   * does not retry on its own is what keeps a lost response to one round trip.
   */
  transport?: Transport;
  /**
   * A viem client on the base chain.
   *
   * Needed for three reads no node can answer: the chain id the grant is bound to, the hub
   * address, and the granter's session epoch. It is also where a revocation is sent.
   */
  base: Client;
  store?: SessionStore;
  expirySeconds?: number;
  /** How close to its expiry a grant is abandoned rather than used. Default 15 seconds. */
  expiryMarginSeconds?: number;
  gas?: bigint;
  /**
   * Force the transport. Left unset the SDK probes and uses `interlude_sendTransaction` when
   * the node serves it, which is where the single-round-trip latency comes from. A probe that
   * fails for a reason other than "no such method" is not remembered, so a node that was
   * booting when the page loaded is not treated as an old one for the rest of the tab.
   */
  fastPath?: boolean;
  /**
   * Passed as the first argument to `interlude_commit` when the node was started with
   * `INTERLUDE_COMMIT_TOKEN`. Leave unset against a local node.
   */
  commitToken?: string;
  /**
   * How many times a call the node refused for backpressure (`NodeBusyError`, retryable) is
   * sent again before the error is thrown: a full batch waits 150 ms, doubling; a rate limit
   * (-32005, HTTP 429) waits what the node's `retryAfterSecs` asks, unless that is over 5 s.
   * Always the same signed transaction. Default 5; 0 throws on the first refusal.
   */
  busyRetries?: number;
  /** Tuning for `watchRead` / `useWatch`. */
  watch?: {
    /** A view is re-read at most this often, however many calls land. Default 50 ms. */
    minIntervalMs?: number;
    /** How often a view polls while the socket is down. Default 500 ms. */
    fallbackMs?: number;
  };
}

export interface InterludeClient<TAbi extends Abi> {
  readonly app: Address;
  readonly abi: TAbi;
  /** The node client used for reads. Sends go through a transport that never retries. */
  readonly node: NodeClient;
  readonly base: Client;

  /** The base chain's id, which is what the grant's EIP-712 domain names. */
  baseChainId(): Promise<number>;
  /** The chain id the node presents. Not the base chain's, or the app's write guard stays on. */
  ephemeralChainId(): Promise<number>;
  /** Read from the app itself: `Delegatable` exposes it, so nobody has to configure it. */
  hubAddress(): Promise<Address>;
  /** The epoch a grant from `user` has to name to be live. */
  epochOf(user: Address): Promise<bigint>;

  /** What the node is serving, and what is waiting to be committed. */
  status(): Promise<SessionStatus>;
  /**
   * Wait until what was sent is committed on the base chain.
   *
   * Pass `hash` (a `send` result's `hash`) to follow that one transaction into a committed
   * batch; that is what `SendResult.settled` does, and the only form that notices a call a
   * restarted node dropped. Without it, waits for everything the node had executed when this
   * was called. Times out rather than hanging if commits have stopped.
   */
  waitSettled(options?: WaitSettledOptions): Promise<SettledStatus>;
  /** Publish the pending diffs now instead of waiting out the node's interval. */
  commit(): Promise<{ transactionHash: Hex }>;

  /**
   * A view call against the node's live state, which is ahead of the chain's.
   *
   * Live only for state the node holds: a view over delegated slots reads what the node has
   * executed, while anything else it touches is read at the block the delegation was pinned.
   */
  read<TFunctionName extends ContractFunctionName<TAbi, Readable>>(
    functionName: TFunctionName,
    ...args: ArgsParameter<ContractFunctionArgs<TAbi, Readable, TFunctionName>>
  ): Promise<ContractFunctionReturnType<TAbi, Readable, TFunctionName>>;

  /**
   * Hear every call as the node runs it.
   *
   * The payload is what the ephemeral EVM just did — app, calldata, return, logs — the same
   * for every contract. Re-read a view in the callback, or use `watchRead`. A node that does
   * not serve the socket falls back to polling so a page still moves. Every watcher on a client
   * shares one socket.
   */
  watch(onCall: (call: AppliedCall) => void, options?: WatchOptions): () => void;

  /**
   * Re-read a view every time the node applies a call, and once on subscribe.
   *
   * Any view: `boardOf`, `floor`, `balanceOf`. The socket does not know the function. It
   * only says that state moved, then this reads the live value. Watchers of the same view with
   * the same arguments share one read; at most one read per view is in flight, a burst of calls
   * collapses into one trailing read, and a response older than one already delivered is
   * dropped, so a value never goes backwards.
   */
  watchRead<TFunctionName extends ContractFunctionName<TAbi, Readable>>(
    functionName: TFunctionName,
    args: ContractFunctionArgs<TAbi, Readable, TFunctionName> | undefined,
    onValue: (value: ContractFunctionReturnType<TAbi, Readable, TFunctionName>) => void,
    onError?: (error: Error) => void,
  ): () => void;

  /** The same view call against the base chain: the last committed value. */
  readSettled<TFunctionName extends ContractFunctionName<TAbi, Readable>>(
    functionName: TFunctionName,
    ...args: ArgsParameter<ContractFunctionArgs<TAbi, Readable, TFunctionName>>
  ): Promise<ContractFunctionReturnType<TAbi, Readable, TFunctionName>>;

  /**
   * Restore the stored session if there is one, and only prompt the wallet when there is not.
   *
   * This is what makes a refresh free: the key and its signed grant were stored together, so
   * the user keeps playing with no wallet interaction at all.
   */
  openSession(options: OpenSessionOptions): Promise<Session<TAbi>>;
  /** Restore without ever prompting. `null` when there is nothing usable to restore. */
  restoreSession(
    granter: Address,
    options?: { scope?: readonly ScopeEntry[]; anyFunction?: boolean },
  ): Promise<Session<TAbi> | null>;

  /**
   * The panic button: invalidate every grant this user has signed, for every app, in one
   * transaction on the base chain.
   *
   * Read the limit before wiring it to a button. The base chain forgets the grants at once and
   * this client refuses to use them again (`SessionRevokedError`). A node, however, reads the
   * session epoch at the block its delegation was pinned to: until the app owner reopens the
   * delegation it still accepts the old grant from whoever holds the key — its expiry is the
   * bound on a stolen key — and it refuses any new grant with `SessionEpochStaleError`
   * (`pinnedByNode: true`), so the user cannot play on that node until then.
   */
  revokeAll(wallet: WalletClient, account?: Account | Address): Promise<Hex>;

  /**
   * Put the wallet on the base chain: switch, or add the chain first if the wallet does not
   * know it. Resolves when the wallet reports the right chain; throws `WrongChainError` when it
   * cannot get there.
   */
  ensureChain(wallet: WalletClient): Promise<void>;

  /** The digest the app computes for a grant, for comparing against the SDK's own. */
  sessionDigestOnChain(grant: SessionGrant): Promise<Hex>;
  /** The digest the SDK signs. */
  sessionDigest(grant: SessionGrant): Promise<Hex>;

  /** Owner-only, on the base chain: hand the app's global state to the node. */
  delegateAll(
    wallet: WalletClient,
    options?: { account?: Account | Address; value?: bigint },
  ): Promise<Hex>;
  /** Owner-only: hand one key's partition over and leave the rest on chain. */
  delegateKey(
    wallet: WalletClient,
    key: Hex,
    options?: { account?: Account | Address; value?: bigint },
  ): Promise<Hex>;
  /** Owner-only, on Monad: lift the lock when the session is done. Stake stays reserved. */
  undelegate(
    wallet: WalletClient,
    partition?: Hex,
    options?: { account?: Account | Address },
  ): Promise<Hex>;
  /**
   * After the challenge window: free the validator's reserved stake.
   * Permissionless once `stakeUnlockAt` has passed; reverts with `StakeStillLocked` before that.
   * Does not wait — call it when the window is over (or from a keeper).
   */
  releaseStake(
    wallet: WalletClient,
    partition?: Hex,
    options?: { account?: Account | Address },
  ): Promise<Hex>;
}

/**
 * Everything one session key needs to send in order: its place in the nonce sequence and the
 * tail of its queue.
 *
 * Per key and per client rather than per `Session` object, because restoring the same stored
 * session twice yields two objects signing with one key, and two counters for one key is how
 * nonces collide.
 */
interface Lane {
  nonce: number | undefined;
  tail: Promise<void>;
}

/** What one delivery of one signed transaction came to. */
type Delivery =
  | { kind: "receipt"; receipt: InterludeReceipt; recovered: boolean }
  | { kind: "no-fast-path" }
  | { kind: "nonce"; error: unknown };

export function createInterludeClient<TAbi extends Abi>(
  config: InterludeClientConfig<TAbi>,
): InterludeClient<TAbi> {
  const { app, abi, base } = config;
  const url = config.node;
  const node = createNodeClient(url, config.transport);
  const store = config.store ?? defaultStore();
  const gas = config.gas ?? DEFAULT_GAS;
  const expirySeconds = config.expirySeconds ?? DEFAULT_EXPIRY_SECONDS;
  const margin = BigInt(config.expiryMarginSeconds ?? DEFAULT_EXPIRY_MARGIN_SECONDS);
  const busyRetries = config.busyRetries ?? DEFAULT_BUSY_RETRIES;
  const watchMinInterval = config.watch?.minIntervalMs ?? DEFAULT_WATCH_MIN_INTERVAL_MS;
  const watchFallbackMs = config.watch?.fallbackMs ?? DEFAULT_WATCH_FALLBACK_MS;

  // Everything the app itself can be asked for is asked for once. None of it can change for a
  // given deployment, and a read per call would show up in the latency this SDK exists to keep.
  // Only answers are kept: a failure — the node's 502 while it boots, a 429 from a public RPC —
  // is forgotten, so the next call asks again instead of the tab being dead until a reload.
  const baseChainId = remember(async () => base.chain?.id ?? (await getChainId(base)));
  const ephemeralChainId = remember(() => getChainId(node));
  const hubAddress = remember(() =>
    readContract(base, { address: app, abi: delegatableAbi, functionName: "hub" }),
  );

  let fastPath: boolean | undefined = config.fastPath;
  let probing: Promise<boolean> | undefined;

  // Sends go through a transport that never retries or falls back by itself; see
  // `createSendClient`. A socket that loses a send rests: sends go over HTTP for a while, longer
  // for each loss in a row, and then over a fresh socket again (`createSendRouter`). A transport
  // the app handed in is used as it is, for everything.
  const router = config.transport ? undefined : createSendRouter(url);
  const sender = (): { client: Client; via: "ws" | "http" | "custom" } =>
    router ? router.client() : { client: node, via: "custom" };
  const sendLost = (via: "ws" | "http" | "custom") => {
    if (router && via !== "custom") router.lost(via);
  };
  const sendArrived = (via: "ws" | "http" | "custom") => {
    if (router && via !== "custom") router.delivered(via);
  };

  const lanes = new Map<string, Lane>();
  const laneOf = (key: Address): Lane => {
    const id = key.toLowerCase();
    let lane = lanes.get(id);
    if (!lane) {
      lane = { nonce: undefined, tail: Promise.resolve() };
      lanes.set(id, lane);
    }
    return lane;
  };

  /**
   * Grants this client has revoked, by granter: every grant naming an epoch at or below the
   * value is dead here, whatever a node that pinned earlier would still accept.
   */
  const revokedThrough = new Map<string, bigint>();

  /** The app's ABI plus every revert it inherits, so a decode covers both authors. */
  const decodable = [...abi, ...delegatableErrorsAbi] as unknown as Abi;

  function expired(expiry: bigint): boolean {
    return BigInt(Math.floor(Date.now() / 1000)) + margin >= expiry;
  }

  function isRevoked(grant: SessionGrant): boolean {
    const through = revokedThrough.get(grant.granter.toLowerCase());
    return through !== undefined && grant.epoch <= through;
  }

  /**
   * Whether the node serves the single-round-trip send.
   *
   * Probed with `interlude_session`, which is on the same trait and changes nothing: a probe
   * that submitted a transaction to find out would have to decide what to do with it. Only two
   * answers are kept — it answered, or it said it has no such method. Anything else (a dropped
   * connection, a node still booting) says nothing about the method, so the fast path is tried
   * and the probe runs again next time; `sendFast` itself degrades if the method is missing.
   */
  async function hasFastPath(): Promise<boolean> {
    if (fastPath !== undefined) return fastPath;
    probing ??= (async () => {
      try {
        const status = await interludeSession(node, url);
        if (status.app && status.app.toLowerCase() !== app.toLowerCase()) {
          throw new WrongNodeError(url, status.app, app);
        }
        fastPath = true;
        return true;
      } catch (error) {
        if (error instanceof WrongNodeError) throw error;
        if (isMethodNotFound(error)) {
          fastPath = false;
          return false;
        }
        return true;
      } finally {
        probing = undefined;
      }
    })();
    return probing;
  }

  async function epochOf(user: Address): Promise<bigint> {
    return readContract(base, {
      address: await hubAddress(),
      abi: hubAbi,
      functionName: "sessionEpochOf",
      args: [user],
    });
  }

  async function sessionDigest(grant: SessionGrant): Promise<Hex> {
    return sessionGrantDigest(grant, { app, baseChainId: await baseChainId() });
  }

  async function sessionDigestOnChain(grant: SessionGrant): Promise<Hex> {
    return readContract(base, {
      address: app,
      abi: delegatableAbi,
      functionName: "sessionDigest",
      args: [grant],
    });
  }

  /**
   * A view call, with a revert coming back as the app's own error.
   *
   * The node answers a reverted `eth_call` the standard way, JSON-RPC error 3 "execution
   * reverted" with the revert bytes as `data` (it used to hand them back as the call's result,
   * which viem then failed to decode as a return value). Those bytes are decoded against the
   * app's ABI and Delegatable's errors, exactly like a failed `send`, so a `read` that reverts
   * with `Frozen(7)` throws `AppRevertError` "Frozen" rather than viem's generic wrapper. A
   * halt with no data at all becomes `UnrecognisedRevertError("0x")`.
   */
  async function readOn(client: Client, functionName: string, args: unknown): Promise<unknown> {
    try {
      return await readContract(client, { address: app, abi, functionName, args } as never);
    } catch (error) {
      if (client === node) {
        const typed = classifyNodeError(error, url);
        if (typed) throw typed;
      }
      if (rpcCode(error) === EXECUTION_REVERTED) {
        throw decodeRevert(revertDataOf(error) ?? "0x", decodable, { functionName });
      }
      throw error;
    }
  }

  /** The chain the wallet is on now, or `undefined` when it will not say. */
  async function walletChainId(wallet: WalletClient): Promise<number | undefined> {
    try {
      return await getChainId(wallet);
    } catch {
      return wallet.chain?.id;
    }
  }

  /**
   * Refuse to send a base-chain transaction from a wallet on another network.
   *
   * `revokeAll` on the wrong network used to "succeed" against whatever lives at the hub's
   * address there — usually nothing — and then clear the stored session as if it had worked.
   */
  async function assertWalletChain(wallet: WalletClient, action: string): Promise<void> {
    const expected = await baseChainId();
    const actual = await walletChainId(wallet);
    if (actual !== undefined && actual !== expected) {
      throw new WrongChainError(expected, actual, action);
    }
  }

  async function ensureChain(wallet: WalletClient): Promise<void> {
    const expected = await baseChainId();
    const actual = await walletChainId(wallet);
    if (actual === expected) return;

    try {
      await switchChain(wallet, { id: expected });
    } catch (error) {
      const chain = base.chain?.id === expected ? base.chain : KNOWN_BASE_CHAINS[expected];
      // 4902 is EIP-3326's "this wallet does not know that chain": add it, which also switches.
      if (!chain || !isUnknownChain(error)) {
        throw new WrongChainError(expected, actual ?? -1, "switching the wallet's network");
      }
      await addChain(wallet, { chain });
      await switchChain(wallet, { id: expected }).catch(() => undefined);
    }

    const now = await walletChainId(wallet);
    if (now !== undefined && now !== expected) {
      throw new WrongChainError(expected, now, "switching the wallet's network");
    }
  }

  async function openSession(options: OpenSessionOptions): Promise<Session<TAbi>> {
    const account = options.account ?? options.wallet.account;
    if (!account) {
      throw new SessionUnusableError(
        "openSession needs an account: either pass one, or use a wallet client that carries one",
      );
    }
    const granter = typeof account === "string" ? account : account.address;

    if (!options.force) {
      const restored = await restoreSession(granter, {
        ...(options.scope !== undefined ? { scope: options.scope } : {}),
        ...(options.anyFunction !== undefined ? { anyFunction: options.anyFunction } : {}),
      });
      if (restored) return restored;
    }

    const selectors = resolveScope(abi, options.scope ?? []);
    const anyFunction = options.anyFunction ?? false;
    if (!anyFunction && selectors.length === 0) {
      throw new SessionUnusableError(
        "a grant with no selectors and no anyFunction authorises nothing, and the app refuses " +
          "it: pass a scope, for instance scope: ['move']",
      );
    }

    const chainId = await baseChainId();

    // A key held in process signs whatever domain it is given. A browser wallet does not: it
    // refuses a grant whose EIP-712 chain id is not its active chain, with an error naming
    // neither. Say which chains, before the prompt, or switch when asked to.
    if (typeof account === "string" || account.type === "json-rpc") {
      if (options.ensureChain) await ensureChain(options.wallet);
      else await assertWalletChain(options.wallet, "signing the session grant");
    }

    const epoch = await epochOf(granter);
    const through = revokedThrough.get(granter.toLowerCase());
    if (through !== undefined && epoch <= through) {
      // The revocation this client sent has not landed yet, so the hub still reports the old
      // epoch, and a grant naming it would be dead the moment it did.
      throw new SessionRevokedError(granter, epoch);
    }

    const privateKey = generatePrivateKey();
    const sessionAccount = privateKeyToAccount(privateKey);

    const grant: SessionGrant = {
      granter,
      sessionKey: sessionAccount.address,
      expiry: BigInt(Math.floor(Date.now() / 1000) + (options.expirySeconds ?? expirySeconds)),
      epoch,
      anyFunction,
      selectors,
    };

    if (options.assertDigest) {
      const local = sessionGrantDigest(grant, { app, baseChainId: chainId });
      const onChain = await sessionDigestOnChain(grant);
      if (local.toLowerCase() !== onChain.toLowerCase()) {
        throw new InterludeError(
          `the grant digest this SDK computed (${local}) is not the one ${app} computes ` +
            `(${onChain}), so a signature over it would not verify. This means the EIP-712 ` +
            `encoding or the base chain id is wrong; nothing was signed.`,
        );
      }
    }

    const signature = await signSessionGrant(options.wallet, account, grant, {
      app,
      baseChainId: chainId,
    });

    const stored: StoredSession = { app, baseChainId: chainId, privateKey, signature, grant };
    store.set(storageKey(app, chainId, granter), encodeSession(stored));

    return makeSession(stored, false);
  }

  async function restoreSession(
    granter: Address,
    options?: { scope?: readonly ScopeEntry[]; anyFunction?: boolean },
  ): Promise<Session<TAbi> | null> {
    const chainId = await baseChainId();
    const key = storageKey(app, chainId, granter);
    const stored = decodeSession(store.get(key));
    if (!stored) return null;

    const discard = () => {
      store.remove(key);
      return null;
    };

    if (stored.app.toLowerCase() !== app.toLowerCase()) return discard();
    if (stored.baseChainId !== chainId) return discard();
    if (stored.grant.granter.toLowerCase() !== granter.toLowerCase()) return discard();
    if (expired(stored.grant.expiry)) return discard();
    if (isRevoked(stored.grant)) return discard();

    // The stored key has to be the one the grant names, or every call reverts with
    // `WrongSessionKey`: a grant is only ever presented by its own key.
    let sessionKey: Address;
    try {
      sessionKey = privateKeyToAccount(stored.privateKey).address;
    } catch {
      return discard();
    }
    if (sessionKey.toLowerCase() !== stored.grant.sessionKey.toLowerCase()) return discard();

    if (options?.anyFunction && !stored.grant.anyFunction) return discard();
    if (options?.scope?.length) {
      const wanted = resolveScope(abi, options.scope);
      if (!wanted.every((selector) => grantCovers(stored.grant, selector))) return discard();
    }

    // Read on the base chain, where a bump is visible immediately. A grant the user revoked
    // must cost a fresh signature rather than a revert on the next call.
    if ((await epochOf(granter)) !== stored.grant.epoch) return discard();

    return makeSession(stored, true);
  }

  function makeSession(stored: StoredSession, restored: boolean): Session<TAbi> {
    const { grant, signature, privateKey } = stored;
    const sessionAccount = privateKeyToAccount(privateKey);
    const key = storageKey(app, stored.baseChainId, grant.granter);
    // Kept locally and only fetched once. The node reports it, but asking per call would add a
    // round trip to every call, which is the whole thing being optimised away here.
    const lane = laneOf(sessionAccount.address);

    /** Run `job` after every call this key already has in flight. */
    function enqueue<T>(job: () => Promise<T>): Promise<T> {
      const result = lane.tail.then(job);
      lane.tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }

    async function submit(
      data: Hex,
      context: RevertContext,
    ): Promise<{ receipt: InterludeReceipt; simulated?: Hex; recovered: boolean }> {
      const chainId = await ephemeralChainId();
      let fast = await hasFastPath();
      let resynced = false;

      for (let attempt = 0; attempt < 4; attempt++) {
        // Simulating first is only for the compatible path, where the receipt carries no return
        // data and this is the only way left to learn what the call answered. It has to happen
        // before the send, or it would read the state the send left behind.
        const simulated = fast ? undefined : await simulate(data, context);

        lane.nonce ??= await getTransactionCount(node, { address: sessionAccount.address });
        const claimed = lane.nonce;
        const raw = await sessionAccount.signTransaction({
          type: "eip1559",
          chainId,
          nonce: claimed,
          to: app,
          data,
          value: 0n,
          gas,
          maxFeePerGas: 0n,
          maxPriorityFeePerGas: 0n,
        });

        const outcome = await deliver(raw, fast);
        if (outcome.kind === "receipt") {
          // Whatever the receipt says, the transaction ran, so its nonce is spent.
          lane.nonce = claimed + 1;
          return { receipt: outcome.receipt, recovered: outcome.recovered, ...(simulated ? { simulated } : {}) };
        }
        if (outcome.kind === "no-fast-path") {
          // The method is not there after all, so nothing ran and the nonce is still free.
          fastPath = false;
          fast = false;
          continue;
        }
        // The node keeps the nonce, so a client that lost track of it (another tab, a restarted
        // node) has to resynchronise rather than fail the call. `deliver` already established
        // that this transaction never ran, so signing a new one cannot run the call twice.
        if (resynced) throw outcome.error;
        resynced = true;
        lane.nonce = undefined;
      }

      throw new InterludeError(`${url} accepted neither transport for this call`);
    }

    /**
     * Get one signed transaction to the node, exactly once.
     *
     * Everything here resends the same signed bytes, never a new transaction: the node refuses
     * a copy of something it already ran, so the worst a resend can do is be refused. When the
     * outcome is unclear — the response was lost, or the node complains about the nonce — the
     * transaction is looked up by its hash before anything else. Found means it ran, and its
     * receipt is the answer. That is the difference between a flaky network costing one
     * round trip and it running the user's action twice.
     */
    async function deliver(raw: Hex, fast: boolean): Promise<Delivery> {
      const hash = keccak256(raw);
      let busy = 0;
      let resent = false;

      for (;;) {
        const { client, via } = sender();
        try {
          if (fast) {
            const receipt = await sendFast(client, url, raw);
            sendArrived(via);
            return receipt ? { kind: "receipt", receipt, recovered: false } : { kind: "no-fast-path" };
          }
          const receipt = await sendCompatible(client, url, raw, node);
          sendArrived(via);
          return { kind: "receipt", receipt, recovered: false };
        } catch (error) {
          if (error instanceof NodeBusyError && error.retryable && busy < busyRetries) {
            // Backpressure: nothing ran and the nonce is free. The next commit makes room, or
            // the rate limiter's window rolls over; the node says how long when it knows. A
            // wait longer than a tap can reasonably hang on is the caller's to decide.
            const wait = error.retryAfterMs ?? Math.min(150 * 2 ** busy, 2000);
            if (wait <= MAX_BUSY_WAIT_MS) {
              busy++;
              await sleep(Math.max(wait, 50));
              continue;
            }
          }

          const lost = error instanceof NodeUnreachableError;
          if (lost || isNonceComplaint(error)) {
            const known = await getReceipt(node, url, hash).catch(() => undefined);
            if (known) return { kind: "receipt", receipt: known, recovered: true };
            // Only a node that answered "no such transaction" licenses signing a new one. A
            // lookup that itself failed leaves open that this one ran, and a fresh signature
            // for it would be the double execution this function exists to prevent.
            if (!lost && known === null) return { kind: "nonce", error };
            if (!lost) {
              lane.nonce = undefined;
              throw error;
            }
            if (known === null && !resent) {
              // The node answered and has never seen it: the request did not arrive. Same
              // bytes again, over plain HTTP in case the socket is what failed — which rests
              // the socket for later sends too, and only for a while.
              resent = true;
              sendLost(via);
              continue;
            }
            // Could not even ask. Whether it ran is unknown, so the next call re-reads the
            // nonce from the node instead of guessing.
            lane.nonce = undefined;
            throw error;
          }

          if (error instanceof WrongNodeError && !error.expected) {
            throw new WrongNodeError(url, error.served, app);
          }
          throw error;
        }
      }
    }

    /**
     * The compatible path's pre-flight: what the call would return.
     *
     * A call that would revert comes back as JSON-RPC error 3 with the revert bytes as `data`
     * and is refused here with the decoded, typed error before anything is signed or sent.
     * (Older nodes handed the bytes back as the result; the send then failed on its receipt
     * and `explain` decoded the same bytes from `simulated`.) The node's own
     * refusals (rate limit, full batch, wrong app) are typed first, as the SDK's errors rather
     * than viem's.
     */
    async function simulate(data: Hex, context: RevertContext): Promise<Hex> {
      try {
        return (await call(node, { account: sessionAccount.address, to: app, data })).data ?? "0x";
      } catch (error) {
        const typed = classifyNodeError(error, url);
        if (typed) throw typed;
        const revert = revertDataOf(error);
        if (revert) throw await explain(revert, context);
        throw error;
      }
    }

    async function send<TFunctionName extends ContractFunctionName<TAbi, Writable>>(
      functionName: TFunctionName,
      ...rest: ArgsParameter<ContractFunctionArgs<TAbi, Writable, TFunctionName>>
    ): Promise<SendResult<ContractFunctionReturnType<TAbi, Writable, TFunctionName>>> {
      const started = now();
      const args = rest[0];

      const inner = encodeFunctionData({ abi, functionName, args } as never);
      const selector = slice(inner, 0, 4);

      // Checked here rather than left to the contract: the revert costs a round trip and says
      // four bytes, and the SDK knows the answer before it sends.
      if (!grantCovers(grant, selector)) {
        throw new SelectorOutOfSessionScopeError("grant", selector, String(functionName));
      }
      if (expired(grant.expiry)) {
        store.remove(key);
        throw new SessionExpiredError(grant.expiry);
      }
      if (isRevoked(grant)) {
        store.remove(key);
        throw new SessionRevokedError(grant.granter, grant.epoch);
      }

      const data = encodeFunctionData({
        abi: delegatableAbi,
        functionName: "withSession",
        args: [grant, signature, inner],
      });

      const context: RevertContext = {
        selector,
        functionName: String(functionName),
        granter: grant.granter,
        sessionKey: grant.sessionKey,
        signer: sessionAccount.address,
        expiry: grant.expiry,
        grantEpoch: grant.epoch,
        scopeCheckedLocally: true,
      };

      const { receipt, simulated, recovered } = await enqueue(() => {
        // Checked again at the head of the queue: a revocation can land while a call waits.
        if (isRevoked(grant)) throw new SessionRevokedError(grant.granter, grant.epoch);
        return submit(data, context);
      });
      const latencyMs = now() - started;

      if (!succeeded(receipt)) {
        throw await explain(receipt.output ?? simulated ?? (await revertData(data)), context);
      }

      const output = receipt.output ?? simulated;
      if (output === undefined) {
        if (recovered) throw new ResultUnavailableError(receipt.transactionHash, receipt);
        throw new InterludeError(
          "the node answered with a receipt but no return data, and the call could not be " +
            "simulated to recover it",
        );
      }

      const blockNumber = Number(BigInt(receipt.blockNumber));
      return {
        result: decodeInner(functionName, output) as ContractFunctionReturnType<
          TAbi,
          Writable,
          TFunctionName
        >,
        receipt,
        hash: receipt.transactionHash,
        latencyMs,
        settled: lazySettled(() =>
          waitSettled(node, url, { hash: receipt.transactionHash, blockNumber }),
        ),
      };
    }

    /**
     * Last resort on the compatible path: an ordinary receipt says a transaction failed and
     * nothing about why, so the call is replayed as `eth_call` for its revert data.
     */
    async function revertData(data: Hex): Promise<Hex> {
      try {
        return (await call(node, { account: sessionAccount.address, to: app, data })).data ?? "0x";
      } catch (error) {
        return revertDataOf(error) ?? "0x";
      }
    }

    async function explain(data: Hex, context: RevertContext): Promise<InterludeError> {
      const error = decodeRevert(data, decodable, context);

      // A revoked grant looks the same as a node whose pinned block predates the revocation,
      // and the difference is what the developer needs, so it costs one read to say which.
      if (error instanceof SessionEpochStaleError) {
        const hubEpoch = await epochOf(grant.granter).catch(() => undefined);
        store.remove(key);
        return new SessionEpochStaleError(grant.epoch, hubEpoch);
      }
      if (
        error instanceof SessionExpiredError ||
        error instanceof WrongSessionKeyError ||
        error instanceof SessionNotSignedByGranterError
      ) {
        // Nothing about this session will start working again, so it should not be restored.
        store.remove(key);
      }
      return error;
    }

    function decodeInner(functionName: string, output: Hex): unknown {
      // `withSession` returns `bytes`, so the inner call's own return value is one ABI layer in.
      const [innerReturn] = decodeAbiParameters([{ type: "bytes" }], output);
      return decodeFunctionResult({ abi, functionName, data: innerReturn } as never);
    }

    return {
      granter: grant.granter,
      sessionKey: sessionAccount.address,
      grant,
      signature,
      expiresAt: new Date(Number(grant.expiry) * 1000),
      restored,
      isExpired: () => expired(grant.expiry),
      covers: (entry) => {
        try {
          const [selector] = resolveScope(abi, [entry]);
          return selector !== undefined && grantCovers(grant, selector);
        } catch {
          return false;
        }
      },
      send,
      discard: () => store.remove(key),
    };
  }

  async function revokeAll(wallet: WalletClient, account?: Account | Address): Promise<Hex> {
    const signer = account ?? wallet.account;
    if (!signer) throw new SessionUnusableError("revokeAll needs an account to send from");
    const granter = typeof signer === "string" ? signer : signer.address;

    await assertWalletChain(wallet, "revokeAll");
    const hub = await hubAddress();
    const epoch = await epochOf(granter);

    const hash = await writeContract(wallet, {
      address: hub,
      abi: hubAbi,
      functionName: "bumpSessionEpoch",
      account: signer,
      chain: wallet.chain ?? null,
    });

    // The grant in storage is dead the moment this lands, and keeping it would only produce a
    // `SessionEpochStale` on the next call. Sessions already in memory stop here too: the node
    // would still take them (see the method's comment), and this client is the one place that
    // can refuse to.
    const through = revokedThrough.get(granter.toLowerCase());
    revokedThrough.set(granter.toLowerCase(), through !== undefined && through > epoch ? through : epoch);
    store.remove(storageKey(app, await baseChainId(), granter));
    return hash;
  }

  async function delegate(
    wallet: WalletClient,
    functionName: "delegateAll" | "delegateKey",
    args: readonly [] | readonly [Hex],
    options?: { account?: Account | Address; value?: bigint },
  ): Promise<Hex> {
    const signer = options?.account ?? wallet.account;
    if (!signer) throw new SessionUnusableError("delegating needs the app owner's account");
    await assertWalletChain(wallet, functionName);

    return writeContract(wallet, {
      address: app,
      abi: delegatableAbi,
      functionName,
      args,
      account: signer,
      chain: wallet.chain ?? null,
      ...(options?.value !== undefined ? { value: options.value } : {}),
    } as never);
  }

  // One socket per client, opened by the first watcher and closed by the last.
  let feed: AppliedFeed | undefined;
  const feedOf = () => (feed ??= createAppliedFeed(url));
  const views = new Map<string, WatchedView>();

  function watchRead(
    functionName: string,
    args: unknown,
    onValue: (value: never) => void,
    onError?: (error: Error) => void,
  ): () => void {
    const id = `${functionName}:${stableKey(args)}`;
    let view = views.get(id);
    if (!view) {
      view = watchView(
        () => readOn(node, functionName, args),
        (trigger) => feedOf().subscribe(trigger, { fallback: trigger, fallbackMs: watchFallbackMs }),
        watchMinInterval,
        () => views.delete(id),
      );
      views.set(id, view);
    }
    return view.add(onValue as (value: unknown) => void, onError);
  }

  return {
    app,
    abi,
    node,
    base,
    baseChainId,
    ephemeralChainId,
    hubAddress,
    epochOf,
    status: () => interludeSession(node, url),
    waitSettled: (options) => waitSettled(node, url, options),
    commit: () => interludeCommit(node, url, config.commitToken),
    read: ((functionName: string, args?: unknown) => readOn(node, functionName, args)) as never,
    readSettled: ((functionName: string, args?: unknown) =>
      readOn(base, functionName, args)) as never,
    watch: (onCall, options) => feedOf().subscribe(onCall, options),
    watchRead: watchRead as never,
    openSession,
    restoreSession,
    revokeAll,
    ensureChain,
    sessionDigest,
    sessionDigestOnChain,
    delegateAll: (wallet, options) => delegate(wallet, "delegateAll", [], options),
    delegateKey: (wallet, key, options) => delegate(wallet, "delegateKey", [key], options),
    undelegate: async (wallet, partition = GLOBAL_PARTITION, options) => {
      const signer = options?.account ?? wallet.account;
      if (!signer) throw new SessionUnusableError("undelegate needs the app owner's account");
      await assertWalletChain(wallet, "undelegate");
      return writeContract(wallet, {
        address: app,
        abi: delegatableAbi,
        functionName: "undelegate",
        args: [partition],
        account: signer,
        chain: wallet.chain ?? null,
      });
    },
    releaseStake: async (wallet, partition = GLOBAL_PARTITION, options) => {
      const signer = options?.account ?? wallet.account;
      if (!signer) throw new SessionUnusableError("releaseStake needs an account");
      await assertWalletChain(wallet, "releaseStake");
      return writeContract(wallet, {
        address: await hubAddress(),
        abi: hubAbi,
        functionName: "releaseStake",
        args: [app, partition],
        account: signer,
        chain: wallet.chain ?? null,
      });
    },
  };
}

// --- watched views -------------------------------------------------------

interface WatchedView {
  add(onValue: (value: unknown) => void, onError?: (error: Error) => void): () => void;
}

/**
 * One live view, shared by everyone watching it.
 *
 * The node can apply a few hundred calls a second and each one says "state moved". Reading
 * once per call per watcher was more requests than the node would serve a page, and replies
 * racing each other could put an older value on screen after a newer one. So: one read in
 * flight at a time, calls arriving meanwhile collapse into a single trailing read, reads start
 * at most every `minIntervalMs`, and every reply carries a sequence number so one that is older
 * than what was already delivered is dropped.
 */
function watchView(
  read: () => Promise<unknown>,
  listen: (trigger: () => void) => () => void,
  minIntervalMs: number,
  onClose: () => void,
): WatchedView {
  const listeners = new Set<{ onValue: (value: unknown) => void; onError?: (error: Error) => void }>();
  let latest: { value: unknown } | undefined;
  let inflight = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastStart = -Infinity;
  let issued = 0;
  let applied = 0;
  let retryWait = 400;
  let stopListening: (() => void) | undefined;
  let closed = false;

  const trigger = () => {
    if (closed) return;
    if (inflight) {
      dirty = true;
      return;
    }
    if (timer !== undefined) return;
    const gap = now() - lastStart;
    if (gap >= minIntervalMs) start();
    else timer = setTimeout(start, minIntervalMs - gap);
  };

  function start() {
    timer = undefined;
    if (closed) return;
    inflight = true;
    dirty = false;
    lastStart = now();
    const seq = ++issued;
    read().then(
      (value) => {
        if (closed || seq <= applied) return;
        applied = seq;
        retryWait = 400;
        latest = { value };
        for (const listener of [...listeners]) listener.onValue(value);
      },
      (cause: unknown) => {
        if (closed) return;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        for (const listener of [...listeners]) listener.onError?.(error);
        // Nothing delivered yet means the page is sitting on "loading", and waiting for the
        // next call to land may mean waiting forever on a quiet node: retry on a backoff.
        if (latest === undefined) {
          dirty = false;
          timer = setTimeout(start, retryWait);
          retryWait = Math.min(retryWait * 2, 5000);
        }
      },
    ).finally(() => {
      inflight = false;
      if (dirty && !closed) {
        dirty = false;
        trigger();
      }
    });
  }

  return {
    add(onValue, onError) {
      const listener = { onValue, ...(onError ? { onError } : {}) };
      listeners.add(listener);
      if (stopListening === undefined) {
        stopListening = listen(trigger);
        trigger();
      } else if (latest !== undefined) {
        const value = latest.value;
        queueMicrotask(() => {
          if (listeners.has(listener)) onValue(value);
        });
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        closed = true;
        if (timer !== undefined) clearTimeout(timer);
        stopListening?.();
        onClose();
      };
    },
  };
}

// --- helpers -------------------------------------------------------------

/**
 * A lazily computed value that is kept once it resolves, and forgotten if it rejects.
 *
 * Concurrent callers share the one request in flight. A rejected promise left in a `??=` cache
 * poisons the client for the life of the page; this asks again instead.
 */
function remember<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

function isNonceComplaint(error: unknown): boolean {
  if (error instanceof NodeUnreachableError) return false;
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth++) {
    const message = current instanceof Error ? current.message : String(current);
    if (/nonce/i.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function isUnknownChain(error: unknown): boolean {
  return rpcCode(error) === 4902 || /unrecognized chain|unknown chain|4902/i.test(String(error));
}

/** The JSON-RPC code for "execution reverted" (EIP-1474 / geth), with the revert bytes as `data`. */
const EXECUTION_REVERTED = 3;

/** Revert data wherever viem put it in a failed `eth_call`. */
function revertDataOf(error: unknown): Hex | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth++) {
    const data = (current as { data?: unknown }).data;
    if (typeof data === "string" && /^0x[0-9a-fA-F]*$/.test(data) && data.length >= 10) {
      return data as Hex;
    }
    if (data && typeof data === "object" && typeof (data as { data?: unknown }).data === "string") {
      return (data as { data: Hex }).data;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Args as a map key: `JSON.stringify` alone throws on the bigints an ABI call is full of. */
function stableKey(args: unknown): string {
  return JSON.stringify(args ?? null, (_key, value: unknown) =>
    typeof value === "bigint" ? `${value}n` : value,
  );
}

/** Do not poll the node unless someone actually awaits settlement. */
function lazySettled(start: () => Promise<SettledStatus>): Promise<SettledStatus> {
  let running: Promise<SettledStatus> | undefined;
  const begin = () => {
    running ??= new Promise<void>((resolve) => setTimeout(resolve, 50)).then(start);
    return running;
  };
  return {
    then(onFulfilled, onRejected) {
      return begin().then(onFulfilled, onRejected);
    },
    catch(onRejected) {
      return begin().catch(onRejected);
    },
    finally(onFinally) {
      return begin().finally(onFinally);
    },
    [Symbol.toStringTag]: "Promise",
  } as Promise<SettledStatus>;
}
