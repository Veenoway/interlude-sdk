import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Abi,
  Account,
  Address,
  ContractFunctionArgs,
  ContractFunctionName,
  ContractFunctionReturnType,
  Hex,
  WalletClient,
} from "viem";
import type { ArgsParameter, InterludeClient, SendResult, Session } from "../client";
import type { ScopeEntry } from "../grant";
import type { SessionStatus } from "../transport";

type Writable = "nonpayable" | "payable";
type Readable = "view" | "pure";

export interface InterludeProviderProps {
  /**
   * The user's wallet. Prompted once, when `open()` is called, and never again for the life of
   * the session.
   */
  wallet?: WalletClient | null;
  /** Which account grants, when the wallet client does not carry one. */
  account?: Account | Address;
  /** The functions the session key may call. Names, signatures or selectors. */
  scope?: readonly ScopeEntry[];
  anyFunction?: boolean;
  expirySeconds?: number;
  /**
   * Sign a fresh grant shortly before the current one expires, so a long game does not stop on
   * `SessionExpiredError`. Off by default because a browser wallet prompts for it: a popup the
   * user did not ask for is worse than an expiry they can see coming. `true` renews 60 s early;
   * a grant this provider signed that lives less than twice the lead renews halfway through.
   */
  autoRenew?: boolean | { beforeSeconds?: number };
  /** Also switch the wallet to the base chain when opening, rather than failing on another one. */
  ensureChain?: boolean;
  children: ReactNode;
}

export interface UseSession<TAbi extends Abi> {
  session: Session<TAbi> | null;
  /** Looking for a stored session. True on the first render after a page load. */
  isRestoring: boolean;
  /** Waiting on the user's wallet. The only moment a session costs an interaction. */
  isOpening: boolean;
  error: Error | null;
  /** Prompt for a grant, or hand back the session already in hand. */
  open: () => Promise<Session<TAbi> | undefined>;
  /**
   * `hub.bumpSessionEpoch()`: every grant this user ever signed, for every app, dead on the base
   * chain at once, and this client stops using them.
   *
   * Not an instant kill switch on a node, and not something to put behind a casual button: a
   * node reads the epoch at the block its delegation was pinned to, so until the app owner
   * reopens the delegation it keeps honouring the old grant for whoever holds the key (its
   * expiry is the bound), and it refuses the user's next grant with `SessionEpochStaleError`
   * — the user cannot play on that node until then. See `InterludeClient.revokeAll`.
   */
  revoke: () => Promise<Hex | undefined>;
  /** Drop the key locally. The grant stays valid on chain until it expires. */
  discard: () => void;
}

/** A hook's `data`: the view's or the function's decoded return, once there is one. */
type Returned<
  TAbi extends Abi,
  TMutability extends Writable | Readable,
  TFunctionName extends ContractFunctionName<TAbi, TMutability>,
> = ContractFunctionReturnType<TAbi, TMutability, TFunctionName>;

/**
 * Hooks bound to one client, and therefore to one app's ABI.
 *
 * A factory rather than free hooks because React context cannot be generic: erased to `Abi`,
 * `send('move', [3n])` would take a `string` and a `readonly unknown[]` and check nothing. Bind
 * the client once, next to where it is configured, and every call site is typed off the ABI.
 */
export function createInterludeHooks<TAbi extends Abi>(client: InterludeClient<TAbi>) {
  const Context = createContext<UseSession<TAbi> | null>(null);

  function InterludeProvider(props: InterludeProviderProps) {
    const { wallet, account, scope, anyFunction, expirySeconds, autoRenew, ensureChain, children } =
      props;

    const [session, setSession] = useState<Session<TAbi> | null>(null);
    const [isRestoring, setRestoring] = useState(false);
    const [isOpening, setOpening] = useState(false);
    const [error, setError] = useState<Error | null>(null);

    const granter = addressOf(account) ?? wallet?.account?.address;
    // Compared by value: a caller writing `scope={['move']}` inline would otherwise restore on
    // every render.
    const scopeKey = (scope ?? []).join(",");
    const scopeRef = useRef(scope);
    scopeRef.current = scope;
    // Which granter the session in state belongs to, so an `open()` that resolves after the
    // user switched accounts does not install the previous account's session.
    const granterRef = useRef(granter);
    granterRef.current = granter;
    // When this provider signed each session it opened, so auto-renew knows the grant's whole
    // lifetime. A restored session's is unknown: it was signed on an earlier visit.
    const openedAt = useRef(new WeakMap<Session<TAbi>, number>());

    useEffect(() => {
      // Whatever session was in state belongs to the previous account (or the previous scope).
      // Keeping it while the new one restores would send the next call as the old user.
      setSession(null);
      setError(null);
      if (!granter) {
        setRestoring(false);
        return;
      }

      let cancelled = false;
      setRestoring(true);

      // Restoring never prompts, which is the point: the key and its signed grant were stored
      // together, so a refresh mid-game costs the user nothing.
      client
        .restoreSession(granter, {
          ...(scopeRef.current !== undefined ? { scope: scopeRef.current } : {}),
          ...(anyFunction !== undefined ? { anyFunction } : {}),
        })
        .then((restored) => {
          if (!cancelled) setSession(restored);
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(asError(cause));
        })
        .finally(() => {
          if (!cancelled) setRestoring(false);
        });

      return () => {
        cancelled = true;
      };
    }, [granter, scopeKey, anyFunction]);

    const openWith = useCallback(
      async (force: boolean) => {
        if (!wallet) {
          setError(new Error("connect a wallet before opening a session"));
          return undefined;
        }

        const forGranter = granterRef.current;
        setOpening(true);
        setError(null);
        try {
          const opened = await client.openSession({
            wallet,
            ...(account !== undefined ? { account } : {}),
            ...(scopeRef.current !== undefined ? { scope: scopeRef.current } : {}),
            ...(anyFunction !== undefined ? { anyFunction } : {}),
            ...(expirySeconds !== undefined ? { expirySeconds } : {}),
            ...(ensureChain !== undefined ? { ensureChain } : {}),
            ...(force ? { force } : {}),
          });
          if (granterRef.current?.toLowerCase() !== forGranter?.toLowerCase()) return undefined;
          if (!openedAt.current.has(opened)) openedAt.current.set(opened, Date.now());
          setSession(opened);
          return opened;
        } catch (cause) {
          setError(asError(cause));
          return undefined;
        } finally {
          setOpening(false);
        }
      },
      // `scopeKey` stands in for `scope`, which is read through its ref.
      [wallet, account, scopeKey, anyFunction, expirySeconds, ensureChain],
    );

    const open = useCallback(() => openWith(false), [openWith]);

    const revoke = useCallback(async () => {
      if (!wallet) return undefined;
      try {
        const hash = await client.revokeAll(wallet, account);
        setSession(null);
        return hash;
      } catch (cause) {
        setError(asError(cause));
        return undefined;
      }
    }, [wallet, account]);

    const discard = useCallback(() => {
      session?.discard();
      setSession(null);
    }, [session]);

    const renewBefore =
      autoRenew === true ? 60 : autoRenew ? (autoRenew.beforeSeconds ?? 60) : undefined;
    useEffect(() => {
      if (renewBefore === undefined || !session) return;
      const expiresAt = session.expiresAt.getTime();
      let lead = renewBefore * 1000;
      const signedAt = openedAt.current.get(session);
      if (signedAt !== undefined) {
        // A grant signed here, whose whole life is known. When `renewBefore` is most or all of
        // it (`expirySeconds={30}` with the default 60 s), renewing that early is due the moment
        // it is signed, and so is the next one: a wallet prompt after another. Renew halfway
        // through its life instead.
        lead = Math.min(lead, (expiresAt - signedAt) / 2);
      }
      const due = expiresAt - lead - Date.now();
      const timer = setTimeout(() => void openWith(true), Math.max(0, due));
      return () => clearTimeout(timer);
    }, [session, renewBefore, openWith]);

    const value = useMemo<UseSession<TAbi>>(
      () => ({ session, isRestoring, isOpening, error, open, revoke, discard }),
      [session, isRestoring, isOpening, error, open, revoke, discard],
    );

    return createElement(Context.Provider, { value }, children);
  }

  function useInterlude(): InterludeClient<TAbi> {
    return client;
  }

  function useSession(): UseSession<TAbi> {
    const value = useContext(Context);
    if (!value) throw new Error("useSession must be used inside <InterludeProvider>");
    return value;
  }

  /**
   * One app function, ready to call.
   *
   * `send` resolves rather than rejects on failure and puts the error in `error`, so a bare
   * `onClick={() => move.send([3n])}` cannot produce an unhandled rejection. Use
   * `session.send` directly where a throw is wanted.
   */
  function useSessionCall<TFunctionName extends ContractFunctionName<TAbi, Writable>>(
    functionName: TFunctionName,
  ) {
    type Result = Returned<TAbi, Writable, TFunctionName>;
    const { session } = useSession();
    const [state, setState] = useState<{
      data: Result | undefined;
      error: Error | null;
      isPending: boolean;
      latencyMs: number | undefined;
    }>({ data: undefined, error: null, isPending: false, latencyMs: undefined });

    const send = useCallback(
      async (
        ...args: ArgsParameter<ContractFunctionArgs<TAbi, Writable, TFunctionName>>
      ): Promise<SendResult<Result> | undefined> => {
        if (!session) {
          const error = new Error("no session is open: call open() first");
          setState((prior) => ({ ...prior, error, isPending: false }));
          return undefined;
        }

        setState((prior) => ({ ...prior, isPending: true, error: null }));
        try {
          const result = await session.send(functionName, ...args);
          setState({
            data: result.result,
            error: null,
            isPending: false,
            latencyMs: result.latencyMs,
          });
          return result;
        } catch (cause) {
          setState((prior) => ({ ...prior, error: asError(cause), isPending: false }));
          return undefined;
        }
      },
      [session, functionName],
    );

    const reset = useCallback(
      () => setState({ data: undefined, error: null, isPending: false, latencyMs: undefined }),
      [],
    );

    return { ...state, send, reset };
  }

  /**
   * A view call against the node's live state, optionally re-read on an interval.
   *
   * `isLoading` is true only until the first value for these arguments arrives, so a poll does
   * not flash a spinner every `pollMs`; `isFetching` is true whenever a read is in flight.
   * `args` may be `undefined` while it is not known yet; pass `enabled: false` to hold the read.
   */
  function useRead<
    TFunctionName extends ContractFunctionName<TAbi, Readable>,
    TArgs extends ContractFunctionArgs<TAbi, Readable, TFunctionName>,
  >(functionName: TFunctionName, args?: TArgs, options?: { pollMs?: number; enabled?: boolean }) {
    type Result = Returned<TAbi, Readable, TFunctionName>;
    const [data, setData] = useState<Result | undefined>(undefined);
    const [error, setError] = useState<Error | null>(null);
    const [isLoading, setLoading] = useState(false);
    const [isFetching, setFetching] = useState(false);
    const [tick, setTick] = useState(0);

    const key = stableKey(args);
    const enabled = options?.enabled ?? true;
    const pollMs = options?.pollMs;
    const argsRef = useRef(args);
    argsRef.current = args;
    // The key the data in state was read for. A new key is a new question, and it is loading
    // until it has an answer; a repeat of the same one is only fetching.
    const loadedKey = useRef<string | null>(null);
    const request = useRef(0);

    useEffect(() => {
      if (!enabled) {
        setLoading(false);
        setFetching(false);
        return;
      }

      let cancelled = false;
      const seq = ++request.current;
      const identity = `${String(functionName)}:${key}`;
      if (loadedKey.current !== identity) setLoading(true);
      setFetching(true);
      const read = client.read as unknown as (name: string, args?: unknown) => Promise<unknown>;
      read(functionName, argsRef.current)
        .then((value) => {
          if (cancelled || seq !== request.current) return;
          loadedKey.current = identity;
          setData(value as Result);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (!cancelled && seq === request.current) setError(asError(cause));
        })
        .finally(() => {
          if (!cancelled && seq === request.current) {
            setLoading(false);
            setFetching(false);
          }
        });

      return () => {
        cancelled = true;
      };
    }, [functionName, key, enabled, tick]);

    useEffect(() => {
      if (!pollMs || !enabled) return;
      const timer = setInterval(() => setTick((n) => n + 1), pollMs);
      return () => clearInterval(timer);
    }, [pollMs, enabled]);

    const refetch = useCallback(() => setTick((n) => n + 1), []);
    return { data, error, isLoading, isFetching, refetch };
  }

  /**
   * What the node is serving and what it still owes the chain.
   *
   * Enough for a status indicator, and the fastest way to find out whether a node is serving
   * the app a frontend thinks it is.
   */
  function useNodeStatus(options?: { pollMs?: number; enabled?: boolean }) {
    const [status, setStatus] = useState<SessionStatus | null>(null);
    const [error, setError] = useState<Error | null>(null);
    const pollMs = options?.pollMs ?? 2000;
    const enabled = options?.enabled ?? true;

    useEffect(() => {
      if (!enabled) return;
      let cancelled = false;

      const poll = () => {
        client
          .status()
          .then((next) => {
            if (!cancelled) {
              setStatus(next);
              setError(null);
            }
          })
          .catch((cause: unknown) => {
            if (!cancelled) setError(asError(cause));
          });
      };

      poll();
      const timer = setInterval(poll, pollMs);
      return () => {
        cancelled = true;
        clearInterval(timer);
      };
    }, [pollMs, enabled]);

    return { status, error };
  }

  /**
   * A view that updates when the node applies a call, not on a timer.
   *
   * Same shape as `useRead`. Any function on the ABI. The socket is app-agnostic, and every
   * `useWatch` on a client shares it; hooks watching the same view share one read.
   */
  function useWatch<
    TFunctionName extends ContractFunctionName<TAbi, Readable>,
    TArgs extends ContractFunctionArgs<TAbi, Readable, TFunctionName>,
  >(functionName: TFunctionName, args?: TArgs, options?: { enabled?: boolean }) {
    type Result = Returned<TAbi, Readable, TFunctionName>;
    const enabled = options?.enabled ?? true;
    const [data, setData] = useState<Result | undefined>(undefined);
    const [error, setError] = useState<Error | null>(null);
    // Not loading when there is nothing to load: a disabled watch used to report `true` forever.
    const [isLoading, setLoading] = useState(enabled);

    const key = stableKey(args);
    const argsRef = useRef(args);
    argsRef.current = args;

    useEffect(() => {
      if (!enabled) {
        setLoading(false);
        return;
      }
      setLoading(true);
      const stop = client.watchRead(
        functionName,
        argsRef.current,
        (value) => {
          setData(value as Result);
          setError(null);
          setLoading(false);
        },
        (cause) => {
          setError(cause);
          setLoading(false);
        },
      );
      return stop;
    }, [functionName, key, enabled]);

    return { data, error, isLoading };
  }

  return {
    InterludeProvider,
    useInterlude,
    useSession,
    useSessionCall,
    useRead,
    useWatch,
    useNodeStatus,
  };
}

function addressOf(account?: Account | Address): Address | undefined {
  if (!account) return undefined;
  return typeof account === "string" ? account : account.address;
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/** Args as a dependency: `JSON.stringify` alone throws on the bigints an ABI call is full of. */
function stableKey(args: unknown): string {
  return JSON.stringify(args ?? null, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}
