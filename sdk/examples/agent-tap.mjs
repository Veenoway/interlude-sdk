/**
 * Headless agents on Interlude Exchange: each joins the order book for a seat of demo balances,
 * then trades market orders on it, each one timed, and the run ends with what they measured.
 *
 * No browser, no faucet, no wallet: every agent makes a key of its own, signs one EIP-712 grant
 * with it (join, buy, sell) and nothing else ever asks for a signature. By default it trades on
 * the live Paris book of https://demo.interludelayer.xyz/exchange, beside the house agents of
 * whoever has the page open, for a minute. The page's "Plug your agent" shows the same thing in
 * twenty lines.
 *
 * It runs against the built package, so build it first:
 *
 *   pnpm --filter @interludelayer-sdk/sdk build
 *   pnpm --filter @interludelayer-sdk/sdk exec node examples/agent-tap.mjs
 *
 * Optional:
 *   INTERLUDE_TAP (or INTERLUDE_APP), INTERLUDE_NODE (or INTERLUDE_TAP_NODE): another book and the
 *     node that serves it; override both together, since a node serves one contract. A laptop
 *     book from scripts/tap-demo.sh prints all three, INTERLUDE_BASE_RPC included.
 *   INTERLUDE_BASE_RPC (or INTERLUDE_TAP_BASE_RPC): the base chain's RPC.
 *   AGENT_COUNT (default 2, at most 8), AGENT_MS_MIN / AGENT_MS_MAX (default 300 / 900): agents,
 *     and each one's wait between two orders.
 *   AGENT_SECONDS (default 60; 0 runs until ctrl-c).
 *
 * Fair use: the book's commits to Monad are paid from one gas budget an hour that everybody on it
 * shares, and the node refuses a signer past 100 transactions a second. The defaults send about
 * three orders a second; a few agents at that pace trade all day.
 */
import { createPublicClient, createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const { createInterludeClient, memoryStore } = await import("../dist/index.js").catch(() => {
  console.error("The SDK is not built: run `pnpm --filter @interludelayer-sdk/sdk build` first.");
  process.exit(1);
});

/** The Paris book of Interlude Exchange, and the node that serves it. */
const LIVE_BOOK = "0x69b1Ff7d02fb9fc48FD0Abe39801D45D0984d5A6";
const LIVE_NODE = "https://il2-eu-69b1ff7d02fb9fc4.fly.dev";

const APP = process.env.INTERLUDE_TAP ?? process.env.INTERLUDE_APP ?? LIVE_BOOK;
const NODE = process.env.INTERLUDE_NODE ?? process.env.INTERLUDE_TAP_NODE ?? LIVE_NODE;
const BASE_RPC =
  process.env.INTERLUDE_BASE_RPC ?? process.env.INTERLUDE_TAP_BASE_RPC ?? "https://testnet-rpc.monad.xyz";
const COUNT = Math.max(1, Math.min(Number(process.env.AGENT_COUNT ?? 2), 8));
const INTERVAL_MIN = Number(process.env.AGENT_MS_MIN ?? 300);
const INTERVAL_MAX = Math.max(INTERVAL_MIN, Number(process.env.AGENT_MS_MAX ?? 900));
const SECONDS = Number(process.env.AGENT_SECONDS ?? 60);
/** A market buy spends this much USD; a market sell sells this much DEMO. */
const SIZES = [5, 10, 20];

if ((APP === LIVE_BOOK) !== (NODE === LIVE_NODE)) {
  console.error("Set INTERLUDE_TAP and INTERLUDE_NODE together: a node serves one book.");
  process.exit(1);
}

const abi = [
  {
    type: "function",
    name: "join",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "stack", type: "uint256" }],
  },
  {
    type: "function",
    name: "buy",
    stateMutability: "nonpayable",
    inputs: [{ name: "quoteIn", type: "uint256" }],
    outputs: [{ name: "baseOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "sell",
    stateMutability: "nonpayable",
    inputs: [{ name: "baseIn", type: "uint256" }],
    outputs: [{ name: "quoteOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "cashOf",
    stateMutability: "view",
    inputs: [{ name: "who", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "invOf",
    stateMutability: "view",
    inputs: [{ name: "who", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  // What the book answers when it refuses an order, so the error says which.
  { type: "error", name: "NoLiquidity", inputs: [] },
  { type: "error", name: "AlreadySeated", inputs: [] },
  { type: "error", name: "HouseEmpty", inputs: [] },
  { type: "error", name: "SeatRateLimited", inputs: [{ name: "retryAfterSecs", type: "uint256" }] },
  {
    type: "error",
    name: "InsufficientCash",
    inputs: [
      { name: "held", type: "uint256" },
      { name: "wanted", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "InsufficientInv",
    inputs: [
      { name: "held", type: "uint256" },
      { name: "wanted", type: "uint256" },
    ],
  },
];

const base = createPublicClient({ transport: http(BASE_RPC) });
const until = SECONDS > 0 ? Date.now() + SECONDS * 1000 : Number.POSITIVE_INFINITY;
/** Round trips of the orders that traded, send to receipt, in ms. */
const filled = [];
let refused = 0;

console.log("book    ", APP);
console.log("node    ", NODE);
console.log("agents  ", COUNT, `· an order every ${INTERVAL_MIN}-${INTERVAL_MAX} ms each`, SECONDS > 0 ? `· ${SECONDS} s` : "· until ctrl-c");

async function runAgent(index) {
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = createWalletClient({ account, transport: http(BASE_RPC) });
  const interlude = createInterludeClient({ app: APP, abi, node: NODE, base, store: memoryStore() });

  // One signature, for the whole run: the session key signs every order after it.
  const session = await interlude.openSession({ wallet, scope: ["join", "buy", "sell"] });
  const joined = await session.send("join");
  console.log(`agent ${index}  ${account.address}  seated: ${joined.result} DEMO and ${joined.result} USD · ${Math.round(joined.latencyMs)} ms`);

  let side = index % 2 === 0 ? "sell" : "buy";
  while (Date.now() < until) {
    const size = SIZES[Math.floor(Math.random() * SIZES.length)];
    try {
      const [cash, inv] = await Promise.all([
        interlude.read("cashOf", [account.address]),
        interlude.read("invOf", [account.address]),
      ]);
      // A buy spends USD, a sell spends DEMO: take the other side when this one is dry.
      if (side === "buy" && cash < BigInt(size)) side = "sell";
      if (side === "sell" && inv < BigInt(size)) side = "buy";
      const { result, latencyMs, receipt } = await session.send(side, [BigInt(size)]);
      const traded = receipt.logs.length > 0;
      if (traded) filled.push(latencyMs);
      console.log(
        `agent ${index}  ${side.padEnd(4)} ${String(size).padStart(3)} → ${String(result).padStart(3)} ${side === "buy" ? "DEMO" : "USD "}  ${latencyMs.toFixed(1)} ms`,
      );
      if (Math.random() < 0.7) side = side === "buy" ? "sell" : "buy";
    } catch (err) {
      refused += 1;
      console.log(`agent ${index}  refused  ${err instanceof Error ? err.message.split("\n")[0] : err}`);
      side = side === "buy" ? "sell" : "buy";
    }
    await sleep(INTERVAL_MIN + Math.random() * (INTERVAL_MAX - INTERVAL_MIN));
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

const runs = await Promise.allSettled(
  Array.from({ length: COUNT }, (_, i) => sleep(i * 250).then(() => runAgent(i + 1))),
);
for (const [i, run] of runs.entries()) {
  if (run.status === "rejected") console.log(`agent ${i + 1}  stopped: ${run.reason?.message ?? run.reason}`);
}
const p50 = percentile(filled, 50);
const p95 = percentile(filled, 95);
console.log(
  `done    ${filled.length} orders filled, ${refused} refused` +
    (p50 === null ? "" : ` · order to fill p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms (send to receipt, from here)`),
);
// The client keeps a connection to the node open (a WebSocket on Node 22+): end the process here.
process.exit(runs.every((run) => run.status === "fulfilled") ? 0 : 1);
