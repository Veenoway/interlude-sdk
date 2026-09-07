import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeFunctionData,
  slice,
  type Abi,
  type Account,
  type Address,
  type Client,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type ContractFunctionReturnType,
  type Hex,
  type Transport,
  type WalletClient,
} from "viem";
import { call, getChainId, getTransactionCount, readContract, writeContract } from "viem/actions";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { delegatableAbi, delegatableErrorsAbi, hubAbi } from "./abi";
import {
  InterludeError,
  SelectorOutOfSessionScopeError,
  SessionEpochStaleError,
  SessionExpiredError,
  SessionNotSignedByGranterError,
  SessionUnusableError,
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
  createNodeClient,
  interludeCommit,
  interludeSession,
  sendCompatible,
  sendFast,
  succeeded,
  type InterludeReceipt,
  type SessionStatus,
} from "./transport";
import { watchApplied, type AppliedCall } from "./watch";

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

type Writable = "nonpayable" | "payable";
type Readable = "view" | "pure";

export interface SendResult<TResult> {
  /** The inner call's return value, decoded out of the wrapper's `bytes`. */
  result: TResult;
  receipt: InterludeReceipt;
  hash: Hex;
  /** Wall clock for the whole call: signing with the session key and the round trip. */
  latencyMs: number;
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

  send<
    TFunctionName extends ContractFunctionName<TAbi, Writable>,
    TArgs extends ContractFunctionArgs<TAbi, Writable, TFunctionName>,
  >(
    functionName: TFunctionName,
    args?: TArgs,
  ): Promise<SendResult<ContractFunctionReturnType<TAbi, Writable, TFunctionName, TArgs>>>;

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
}

export interface InterludeClientConfig<TAbi extends Abi> {
  /** The `Delegatable` app. Also the EIP-712 `verifyingContract`. */
  app: Address;
  /** The app's ABI. Used for encoding, for decoding, and to resolve a scope from names. */
  abi: TAbi;
  /** The node's JSON-RPC url. Also what an unreachable-node error names. */
  node: string;
  /** How to reach it, when a plain POST to `node` is not it: an API key, a proxy of your own. */
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
   * Force the transport. Left unset the SDK probes once and uses `interlude_sendTransaction`
   * when the node serves it, which is where the single-round-trip latency comes from.
   */
  fastPath?: boolean;
  /**
   * Passed as the first argument to `interlude_commit` when the node was started with
   * `INTERLUDE_COMMIT_TOKEN`. Leave unset against a local node.
   */
  commitToken?: string;
}

export interface InterludeClient<TAbi extends Abi> {
  readonly app: Address;
  readonly abi: TAbi;
  readonly node: ReturnType<typeof createNodeClient>;
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
  /** Publish the pending diffs now instead of waiting out the node's interval. */
  commit(): Promise<{ transactionHash: Hex }>;

  /** A view call against the node's live state, which is ahead of the chain's. */
  read<
    TFunctionName extends ContractFunctionName<TAbi, Readable>,
    TArgs extends ContractFunctionArgs<TAbi, Readable, TFunctionName>,
  >(
    functionName: TFunctionName,
    args?: TArgs,
  ): Promise<ContractFunctionReturnType<TAbi, Readable, TFunctionName, TArgs>>;

  /**
   * Hear every call as the node runs it.
   *
   * The payload is what the ephemeral EVM just did — app, calldata, return, logs — the same
   * for every contract. Re-read a view in the callback, or use `watchRead`. A node that does
   * not serve the socket falls back to polling so a page still moves.
   */
  watch(onCall: (call: AppliedCall) => void): () => void;

  /**
   * Re-read a view every time the node applies a call, and once on subscribe.
   *
   * Any view: `boardOf`, `floor`, `balanceOf`. The socket does not know the function. It
   * only says that state moved, then this reads the live value.
   */
  watchRead<
    TFunctionName extends ContractFunctionName<TAbi, Readable>,
    TArgs extends ContractFunctionArgs<TAbi, Readable, TFunctionName>,
  >(
    functionName: TFunctionName,
    args: TArgs | undefined,
    onValue: (
      value: ContractFunctionReturnType<TAbi, Readable, TFunctionName, TArgs>,
    ) => void,
    onError?: (error: Error) => void,
  ): () => void;

  /** The same view call against the base chain: the last committed value. */
  readSettled<
    TFunctionName extends ContractFunctionName<TAbi, Readable>,
    TArgs extends ContractFunctionArgs<TAbi, Readable, TFunctionName>,
  >(
    functionName: TFunctionName,
    args?: TArgs,
  ): Promise<ContractFunctionReturnType<TAbi, Readable, TFunctionName, TArgs>>;

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
   */
  revokeAll(wallet: WalletClient, account?: Account | Address): Promise<Hex>;

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
}

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

  // Everything the app itself can be asked for is asked for once. None of it can change for a
  // given deployment, and a read per call would show up in the latency this SDK exists to keep.
  let baseChainIdOnce: Promise<number> | undefined;
  let ephemeralChainIdOnce: Promise<number> | undefined;
  let hubOnce: Promise<Address> | undefined;
  let fastPath: boolean | undefined = config.fastPath;
  let fastPathProbe: Promise<boolean> | undefined;

  /** The app's ABI plus every revert it inherits, so a decode covers both authors. */
  const decodable = [...abi, ...delegatableErrorsAbi] as unknown as Abi;

  function expired(expiry: bigint): boolean {
    return BigInt(Math.floor(Date.now() / 1000)) + margin >= expiry;
  }

  function baseChainId(): Promise<number> {
    baseChainIdOnce ??= Promise.resolve(base.chain?.id ?? getChainId(base));
    return baseChainIdOnce;
  }

  function ephemeralChainId(): Promise<number> {
    ephemeralChainIdOnce ??= getChainId(node);
    return ephemeralChainIdOnce;
  }

  function hubAddress(): Promise<Address> {
    hubOnce ??= readContract(base, { address: app, abi: delegatableAbi, functionName: "hub" });
    return hubOnce;
  }

  /**
   * Whether the node serves the single-round-trip send.
   *
   * Probed with `interlude_session`, which is on the same trait and changes nothing: a probe
   * that submitted a transaction to find out would have to decide what to do with it.
   */
  async function hasFastPath(): Promise<boolean> {
    if (fastPath !== undefined) return fastPath;
    fastPathProbe ??= interludeSession(node, url).then(
      () => true,
      () => false,
    );
    fastPath = await fastPathProbe;
    return fastPath;
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

  async function readOn<
    TFunctionName extends ContractFunctionName<TAbi, Readable>,
    TArgs extends ContractFunctionArgs<TAbi, Readable, TFunctionName>,
  >(
    client: Client,
    functionName: TFunctionName,
    args?: TArgs,
  ): Promise<ContractFunctionReturnType<TAbi, Readable, TFunctionName, TArgs>> {
    return readContract(client, {
      address: app,
      abi,
      functionName,
      args,
    } as never) as Promise<ContractFunctionReturnType<TAbi, Readable, TFunctionName, TArgs>>;
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

    const privateKey = generatePrivateKey();
    const sessionAccount = privateKeyToAccount(privateKey);
    const chainId = await baseChainId();

    const grant: SessionGrant = {
      granter,
      sessionKey: sessionAccount.address,
      expiry: BigInt(Math.floor(Date.now() / 1000) + (options.expirySeconds ?? expirySeconds)),
      epoch: await epochOf(granter),
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
    let nonce: number | undefined;

    async function nextNonce(): Promise<number> {
      nonce ??= await getTransactionCount(node, { address: sessionAccount.address });
      return nonce++;
    }

    async function submit(data: Hex): Promise<{ receipt: InterludeReceipt; simulated?: Hex }> {
      const chainId = await ephemeralChainId();

      for (let attempt = 0; attempt < 3; attempt++) {
        const fast = await hasFastPath();

        // Simulating first is only for the compatible path, where the receipt carries no return
        // data and this is the only way left to learn what the call answered. It has to happen
        // before the send, or it would read the state the send left behind.
        const simulated = fast
          ? undefined
          : (await call(node, { account: sessionAccount.address, to: app, data })).data;

        const claimed = await nextNonce();
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

        try {
          if (!fast) return { receipt: await sendCompatible(node, url, raw), simulated };

          const receipt = await sendFast(node, url, raw);
          if (receipt) return { receipt };

          // The method is not there after all, so nothing ran and the nonce is still free.
          fastPath = false;
          nonce = claimed;
        } catch (error) {
          // The node keeps the nonce, so a client that lost track of it (another tab, a
          // restarted node) has to resynchronise rather than fail the call.
          if (attempt === 0 && isNonceComplaint(error)) {
            nonce = undefined;
            continue;
          }
          throw error;
        }
      }

      throw new InterludeError(`${url} accepted neither transport for this call`);
    }

    async function send<
      TFunctionName extends ContractFunctionName<TAbi, Writable>,
      TArgs extends ContractFunctionArgs<TAbi, Writable, TFunctionName>,
    >(
      functionName: TFunctionName,
      args?: TArgs,
    ): Promise<SendResult<ContractFunctionReturnType<TAbi, Writable, TFunctionName, TArgs>>> {
      const started = now();

      const inner = encodeFunctionData({ abi, functionName, args } as never);
      const selector = slice(inner, 0, 4);

      // Both checked here rather than left to the contract: the revert costs a round trip and
      // says four bytes, and the SDK knows the answer before it sends.
      if (!grantCovers(grant, selector)) {
        throw new SelectorOutOfSessionScopeError("grant", selector, String(functionName));
      }
      if (expired(grant.expiry)) {
        store.remove(key);
        throw new SessionExpiredError(grant.expiry);
      }

      const data = encodeFunctionData({
        abi: delegatableAbi,
        functionName: "withSession",
        args: [grant, signature, inner],
      });

      const { receipt, simulated } = await submit(data);
      const latencyMs = now() - started;

      if (!succeeded(receipt)) {
        throw await explain(receipt.output ?? simulated ?? (await revertData(data)), {
          selector,
          functionName: String(functionName),
          granter: grant.granter,
          sessionKey: grant.sessionKey,
          signer: sessionAccount.address,
          expiry: grant.expiry,
          grantEpoch: grant.epoch,
          scopeCheckedLocally: true,
        });
      }

      const output = receipt.output ?? simulated;
      if (output === undefined) {
        throw new InterludeError(
          "the node answered with a receipt but no return data, and the call could not be " +
            "simulated to recover it",
        );
      }

      return {
        result: decodeInner<TFunctionName, TArgs>(functionName, output),
        receipt,
        hash: receipt.transactionHash,
        latencyMs,
      };
    }

    /**
     * Last resort on the compatible path: an ordinary receipt says a transaction failed and
     * nothing about why, so the call is replayed as `eth_call` for its revert data.
     */
    async function revertData(data: Hex): Promise<Hex> {
      try {
        return (await call(node, { account: sessionAccount.address, to: app, data })).data ?? "0x";
      } catch {
        return "0x";
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

    function decodeInner<
      TFunctionName extends ContractFunctionName<TAbi, Writable>,
      TArgs extends ContractFunctionArgs<TAbi, Writable, TFunctionName>,
    >(
      functionName: TFunctionName,
      output: Hex,
    ): ContractFunctionReturnType<TAbi, Writable, TFunctionName, TArgs> {
      // `withSession` returns `bytes`, so the inner call's own return value is one ABI layer in.
      const [innerReturn] = decodeAbiParameters([{ type: "bytes" }], output);
      return decodeFunctionResult({
        abi,
        functionName,
        data: innerReturn,
      } as never) as ContractFunctionReturnType<TAbi, Writable, TFunctionName, TArgs>;
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

    const hash = await writeContract(wallet, {
      address: await hubAddress(),
      abi: hubAbi,
      functionName: "bumpSessionEpoch",
      account: signer,
      chain: wallet.chain ?? null,
    });

    // The grant in storage is dead the moment this lands, and keeping it would only produce a
    // `SessionEpochStale` on the next call.
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
    commit: () => interludeCommit(node, url, config.commitToken),
    read: (functionName, args) => readOn(node, functionName, args),
    readSettled: (functionName, args) => readOn(base, functionName, args),
    watch: (onCall) => watchApplied(url, onCall),
    watchRead: (functionName, args, onValue, onError) => {
      const pull = () => {
        void readOn(node, functionName, args).then(onValue, (cause: unknown) => {
          onError?.(cause instanceof Error ? cause : new Error(String(cause)));
        });
      };
      pull();
      return watchApplied(url, () => pull(), { fallback: pull, fallbackMs: 400 });
    },
    openSession,
    restoreSession,
    revokeAll,
    sessionDigest,
    sessionDigestOnChain,
    delegateAll: (wallet, options) => delegate(wallet, "delegateAll", [], options),
    delegateKey: (wallet, key, options) => delegate(wallet, "delegateKey", [key], options),
  };
}

function isNonceComplaint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /nonce/i.test(message);
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
