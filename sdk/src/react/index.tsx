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
  Hex,
  WalletClient,
} from "viem";
import type { InterludeClient, SendResult, Session } from "../client";
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
  /** `hub.bumpSessionEpoch()`: every grant this user ever signed, for every app, dead at once. */
  revoke: () => Promise<Hex | undefined>;
  /** Drop the key locally. The grant stays valid on chain until it expires. */
  discard: () => void;
}

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
    const { wallet, account, scope, anyFunction, expirySeconds, children } = props;

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

    useEffect(() => {
      if (!granter) {
        setSession(null);
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

    const open = useCallback(async () => {
      if (!wallet) {
        setError(new Error("connect a wallet before opening a session"));
        return undefined;
      }

      setOpening(true);
      setError(null);
      try {
        const opened = await client.openSession({
          wallet,
          ...(account !== undefined ? { account } : {}),
          ...(scopeRef.current !== undefined ? { scope: scopeRef.current } : {}),
          ...(anyFunction !== undefined ? { anyFunction } : {}),
          ...(expirySeconds !== undefined ? { expirySeconds } : {}),
        });
        setSession(opened);
        return opened;
      } catch (cause) {
        setError(asError(cause));
        return undefined;
      } finally {
        setOpening(false);
      }
    }, [wallet, account, scopeKey, anyFunction, expirySeconds]);

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
  function useSessionCall<
    TFunctionName extends ContractFunctionName<TAbi, Writable>,
    TArgs extends ContractFunctionArgs<TAbi, Writable, TFunctionName>,
  >(functionName: TFunctionName) {
    const { session } = useSession();
    const [state, setState] = useState<{
      data: unknown;
      error: Error | null;
      isPending: boolean;
      latencyMs: number | undefined;
    }>({ data: undefined, error: null, isPending: false, latencyMs: undefined });

    const send = useCallback(
      async (args?: TArgs) => {
        if (!session) {
          const error = new Error("no session is open: call open() first");
          setState((prior) => ({ ...prior, error, isPending: false }));
          return undefined;
        }

        setState((prior) => ({ ...prior, isPending: true, error: null }));
        try {
          const result = await session.send(functionName, args);
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

  /** A view call against the node's live state, optionally re-read on an interval. */
  function useRead<
    TFunctionName extends ContractFunctionName<TAbi, Readable>,
    TArgs extends ContractFunctionArgs<TAbi, Readable, TFunctionName>,
  >(functionName: TFunctionName, args?: TArgs, options?: { pollMs?: number; enabled?: boolean }) {
    const [data, setData] = useState<unknown>(undefined);
    const [error, setError] = useState<Error | null>(null);
    const [isLoading, setLoading] = useState(false);
    const [tick, setTick] = useState(0);

    const key = stableKey(args);
    const enabled = options?.enabled ?? true;
    const pollMs = options?.pollMs;
    const argsRef = useRef(args);
    argsRef.current = args;

    useEffect(() => {
      if (!enabled) return;

      let cancelled = false;
      setLoading(true);
      client
        .read(functionName, argsRef.current)
        .then((value) => {
          if (!cancelled) {
            setData(value);
            setError(null);
          }
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(asError(cause));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
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
    return { data, error, isLoading, refetch };
  }

  /**
   * What the node is serving and what it still owes the chain.
   *
   * Enough for a status indicator, and the fastest way to find out whether a node is serving
   * the app a frontend thinks it is.
   */
  function useNodeStatus(options?: { pollMs?: number }) {
    const [status, setStatus] = useState<SessionStatus | null>(null);
    const [error, setError] = useState<Error | null>(null);
    const pollMs = options?.pollMs ?? 2000;

    useEffect(() => {
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
    }, [pollMs]);

    return { status, error };
  }

  /**
   * A view that updates when the node applies a call, not on a timer.
   *
   * Same shape as `useRead`. Any function on the ABI. The socket is app-agnostic.
   */
  function useWatch<
    TFunctionName extends ContractFunctionName<TAbi, Readable>,
    TArgs extends ContractFunctionArgs<TAbi, Readable, TFunctionName>,
  >(functionName: TFunctionName, args?: TArgs, options?: { enabled?: boolean }) {
    const [data, setData] = useState<unknown>(undefined);
    const [error, setError] = useState<Error | null>(null);
    const [isLoading, setLoading] = useState(true);

    const key = stableKey(args);
    const enabled = options?.enabled ?? true;
    const argsRef = useRef(args);
    argsRef.current = args;

    useEffect(() => {
      if (!enabled) return;
      setLoading(true);
      const stop = client.watchRead(
        functionName,
        argsRef.current,
        (value) => {
          setData(value);
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
  return JSON.stringify(args ?? null, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}
