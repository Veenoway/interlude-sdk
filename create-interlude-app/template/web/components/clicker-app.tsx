"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { SettlementLostError } from "@interludelayer-sdk/sdk";
import {
  InterludeProvider,
  SCOPE,
  config,
  configProblem,
  interlude,
  useSession,
  useSessionCall,
  useWatch,
} from "@/lib/interlude";
import { connect, ensureChain, injected, walletFor, type ConnectedWallet } from "@/lib/wallet";

/**
 * The whole app: connect, sign once, click.
 *
 * Three numbers on screen, each from a different place, and the gap between them is the point:
 *   - your count moves the instant you click (optimistic, local);
 *   - the node's answer comes back in one round trip, ~40 ms, a few ms of it on the node
 *     (live, `useWatch`);
 *   - Monad catches up every few seconds, when the node commits (settled, `waitSettled`).
 */
export function ClickerApp() {
  const node = useNodeCheck();
  if (configProblem) return <Setup problem={configProblem} />;
  if (node.wrongNode) return <Setup problem={node.wrongNode} />;
  return <Connected notice={node.unreachable} />;
}

function Connected({ notice }: { notice: string | null }) {
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const { data: liveTotal } = useWatch("totalClicks");
  const total = useOptimisticCounter(liveTotal);
  const settlement = useSettlement();

  const onConnect = async () => {
    setConnecting(true);
    setProblem(null);
    try {
      setWallet(await connect());
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setConnecting(false);
    }
  };

  // A session belongs to one account. When the wallet switches account, rebind: the provider
  // restores that account's stored session if it has one, and otherwise asks it to sign.
  useEffect(() => {
    if (!wallet) return;
    const provider = injected();
    const onAccounts = (accounts: readonly Address[]) => {
      const next = accounts[0];
      if (!next) {
        setWallet(null);
        return;
      }
      walletFor(provider, next).then(setWallet, (error) => setProblem(messageOf(error)));
    };
    provider.on("accountsChanged", onAccounts);
    return () => provider.removeListener("accountsChanged", onAccounts);
  }, [wallet]);

  return (
    <InterludeProvider wallet={wallet} scope={SCOPE}>
      <main className="page">
        <header className="bar">
          <strong>__APP_NAME__</strong>
          {wallet ? (
            <span className="chip" title={wallet.account.address}>
              {short(wallet.account.address)} on {wallet.chain?.name ?? "the base chain"}
            </span>
          ) : (
            <button className="secondary" onClick={onConnect} disabled={connecting}>
              {connecting ? "Connecting..." : "Connect wallet"}
            </button>
          )}
        </header>

        {wallet ? (
          <Game
            key={wallet.account.address}
            wallet={wallet}
            total={total}
            onClicked={settlement.track}
          />
        ) : (
          <p className="lede">
            Connect a wallet, sign once, then click as fast as you like: every click is a
            transaction on an Interlude node, with no gas and no wallet prompt, settled on Monad
            a few seconds later. You need no MON to play.
          </p>
        )}

        {problem && <p className="error">{problem}</p>}
        {notice && <p className="error">{notice}</p>}

        <Scoreboard total={total.value} settlement={settlement} />
      </main>
    </InterludeProvider>
  );
}

function Game({
  wallet,
  total,
  onClicked,
}: {
  wallet: ConnectedWallet;
  total: OptimisticCounter;
  onClicked: (click: SentClick) => void;
}) {
  const me = wallet.account.address;
  const { session, open, isOpening, isRestoring, error: sessionError } = useSession();
  const click = useSessionCall("click");
  const { data: liveMine } = useWatch("clicksOf", [me]);
  const mine = useOptimisticCounter(liveMine);
  const [latencies, setLatencies] = useState<number[]>([]);

  const onOpen = async () => {
    // The wallet may have been moved to another chain since it connected, and a grant can only
    // be signed on the base chain.
    if (wallet.chain) await ensureChain(wallet, wallet.chain).catch(() => undefined);
    await open();
  };

  const onClick = async () => {
    mine.bump();
    total.bump();
    const sent = await click.send();
    if (!sent) {
      mine.drop();
      total.drop();
      return;
    }
    mine.confirm(sent.result);
    setLatencies((prior) => [...prior.slice(-19), sent.latencyMs]);
    onClicked({ hash: sent.hash, blockNumber: Number(BigInt(sent.receipt.blockNumber)) });
  };

  if (isRestoring) return <p className="lede">Looking for a session you already signed...</p>;

  if (!session) {
    return (
      <section className="stage">
        <p className="lede">
          One signature opens a session: a key generated in this tab that may call{" "}
          <code>click</code> and nothing else, for the next hour. Your wallet is not asked again.
        </p>
        <button className="primary" onClick={onOpen} disabled={isOpening}>
          {isOpening ? "Check your wallet..." : "Open a session"}
        </button>
        {sessionError && <p className="error">{sessionError.message}</p>}
      </section>
    );
  }

  const last = latencies[latencies.length - 1];
  return (
    <section className="stage">
      <button className="clicker" onClick={onClick} aria-label="Click">
        <span className="count">{mine.value.toString()}</span>
        <span className="hint">your clicks</span>
      </button>
      <p className="latency">
        {last === undefined
          ? "No gas, no prompt. Click."
          : `last ${formatMs(last)} · median ${formatMs(median(latencies))} over ${latencies.length}`}
      </p>
      {click.error && <p className="error">{click.error.message}</p>}
      <p className="small">
        Session key {short(session.sessionKey)} · expires{" "}
        {session.expiresAt.toLocaleTimeString()}
      </p>
    </section>
  );
}

function Scoreboard({ total, settlement }: { total: bigint; settlement: Settlement }) {
  return (
    <section className="scoreboard">
      <div>
        <span className="label">Everyone, live on the node</span>
        <span className="value">{total.toString()}</span>
      </div>
      <div>
        <span className="label">Everyone, settled on Monad</span>
        <span className="value">
          {settlement.settledTotal === undefined ? "..." : settlement.settledTotal.toString()}
        </span>
        <span className={settlement.waiting > 0 ? "status pending" : "status done"}>
          {settlement.waiting > 0
            ? `${settlement.waiting} of your clicks on their way to Monad`
            : settlement.lastSettledAt
              ? `all your clicks settled ${new Date(settlement.lastSettledAt).toLocaleTimeString()}`
              : "commits land every few seconds"}
        </span>
        {settlement.problem && <span className="error">{settlement.problem}</span>}
      </div>
      <p className="small">
        app {short(config.app)} · node {config.node}
      </p>
    </section>
  );
}

function Setup({ problem }: { problem: string }) {
  return (
    <main className="page">
      <h1>__APP_NAME__</h1>
      <p className="error">{problem}</p>
      <p className="lede">This page needs to know which app and which node to talk to.</p>
      <pre className="code">{`cd ../contracts
npm run build
npx @interludelayer-sdk/cli ship --owner <your address> --out ../web/.env.local

# then restart this dev server: Next.js reads .env.local at start-up
npm run dev`}</pre>
      <p className="small">
        Or copy web/.env.example to web/.env.local and fill in the three values yourself.
      </p>
    </main>
  );
}

// --- hooks -----------------------------------------------------------------

interface NodeCheck {
  /** The node answers for another contract: nothing on this page can work against it. */
  wrongNode: string | null;
  /** The node has not answered yet. Asked again until it does. */
  unreachable: string | null;
}

/**
 * Which contract the node serves, asked once on load.
 *
 * A node serves one contract, and the commonest setup mistake is a node URL from somewhere else:
 * a public demo's, or an earlier ship's. Every call then fails with `WrongNodeError`, and until
 * the first click the page would only show a quiet 0. `status().app` says it up front.
 */
function useNodeCheck(): NodeCheck {
  const [check, setCheck] = useState<NodeCheck>({ wrongNode: null, unreachable: null });

  useEffect(() => {
    if (configProblem) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const ask = async () => {
      try {
        const status = await interlude.status();
        if (cancelled) return;
        setCheck({
          wrongNode:
            status.app.toLowerCase() === config.app.toLowerCase()
              ? null
              : `The node at ${config.node} serves ${status.app}, not ${config.app}. Each node ` +
                `serves one contract: NEXT_PUBLIC_INTERLUDE_NODE has to be the node ship printed ` +
                `for NEXT_PUBLIC_INTERLUDE_APP.`,
          unreachable: null,
        });
      } catch (error) {
        if (cancelled) return;
        console.warn(error); // the whole story (status, URL) for the console; the page says less
        setCheck({
          wrongNode: null,
          unreachable:
            `The node at ${config.node} is not answering yet. A 502 in the first few minutes ` +
            `after ship is its machine starting. Asking again every 5 s.`,
        });
        retry = setTimeout(() => void ask(), 5_000);
      }
    };

    void ask();
    return () => {
      cancelled = true;
      if (retry !== undefined) clearTimeout(retry);
    };
  }, []);

  return check;
}

interface OptimisticCounter {
  value: bigint;
  /** A click left: show it now. */
  bump: () => void;
  /** It failed: take it back. */
  drop: () => void;
  /** The node answered with the exact count. */
  confirm: (exact: bigint) => void;
}

/**
 * A counter that moves on the click, not on the answer.
 *
 * Shown as the larger of what the node last reported and a local floor. Counters here only go
 * up, so "the larger" is always right: the live value overtakes the floor as soon as the node's
 * push arrives, and a click that fails lowers the floor it raised.
 */
function useOptimisticCounter(live: unknown): OptimisticCounter {
  const reported = typeof live === "bigint" ? live : 0n;
  const [floor, setFloor] = useState(0n);
  const reportedRef = useRef(reported);
  reportedRef.current = reported;

  const bump = useCallback(() => setFloor((f) => max(f, reportedRef.current) + 1n), []);
  const drop = useCallback(() => setFloor((f) => (f > 0n ? f - 1n : 0n)), []);
  const confirm = useCallback((exact: bigint) => setFloor((f) => max(f, exact)), []);
  return { value: max(reported, floor), bump, drop, confirm };
}

/** What the settlement follower needs from a click the node answered. */
interface SentClick {
  hash: Hex;
  /** The ephemeral block it ran in, so the batch search can stop early. */
  blockNumber: number;
}

interface Settlement {
  /** This tab's clicks the node has not committed to Monad yet. */
  waiting: number;
  settledTotal: bigint | undefined;
  lastSettledAt: number | undefined;
  problem: string | null;
  track: (click: SentClick) => void;
}

/**
 * When Monad has what the node answered — click by click.
 *
 * `waitSettled({ hash })` follows one transaction into a committed batch on Monad, and rejects
 * with `SettlementLostError` if the node forgot it (a restart that dropped what it had not
 * committed yet). The form without a hash only waits for "nothing pending, or two more batches":
 * it cannot tell a click that settled from one a restarted node lost, so this page would say
 * "settled" for clicks that never reached Monad.
 *
 * One follower at a time, oldest click first: clicks that land while it waits join the queue.
 * The first wait lasts until the next commit; the clicks that went out in the same batch then
 * resolve on their first look, so this costs a couple of requests per click, not a poll each.
 */
function useSettlement(): Settlement {
  const [waiting, setWaiting] = useState(0);
  const [settledTotal, setSettledTotal] = useState<bigint>();
  const [lastSettledAt, setLastSettledAt] = useState<number>();
  const [problem, setProblem] = useState<string | null>(null);
  const queue = useRef<SentClick[]>([]);
  const lost = useRef(0);
  const following = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setSettledTotal(await interlude.readSettled("totalClicks"));
    } catch {
      // A public RPC hiccup; the next poll will do.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const track = useCallback(
    (click: SentClick) => {
      queue.current.push(click);
      setWaiting(queue.current.length);
      if (following.current) return;
      following.current = true;
      void (async () => {
        try {
          while (queue.current.length > 0) {
            const next = queue.current[0]!;
            try {
              await interlude.waitSettled({ ...next, timeoutMs: 120_000 });
              setLastSettledAt(Date.now());
            } catch (error) {
              if (!(error instanceof SettlementLostError)) throw error;
              // Gone for good: the node restarted before committing it. Say so, and move on.
              lost.current += 1;
            }
            queue.current.shift();
            setWaiting(queue.current.length);
            setProblem(
              lost.current > 0
                ? `${lost.current} of your clicks never reached Monad: the node restarted before committing them.`
                : null,
            );
            if (queue.current.length === 0) await refresh();
          }
        } catch (error) {
          // Commits stopped, or the node is unreachable. The queue stays; the next click resumes it.
          setProblem(`Not settled yet: ${messageOf(error)}`);
        } finally {
          following.current = false;
        }
      })();
    },
    [refresh],
  );

  return { waiting, settledTotal, lastSettledAt, problem, track };
}

// --- formatting ------------------------------------------------------------

function max(...values: bigint[]): bigint {
  return values.reduce((a, b) => (b > a ? b : a));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function formatMs(ms: number): string {
  return ms < 10 ? `${ms.toFixed(2)} ms` : `${Math.round(ms)} ms`;
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function messageOf(error: unknown): string {
  const shortMessage = (error as { shortMessage?: string } | null)?.shortMessage;
  if (shortMessage) return shortMessage;
  return error instanceof Error ? error.message : String(error);
}
