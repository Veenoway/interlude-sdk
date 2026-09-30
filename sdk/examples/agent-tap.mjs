/**
 * Headless tap agents: join the book, then buy/sell in a loop.
 *
 * Reads the same env `scripts/tap-demo.sh` writes:
 *
 *   pnpm --filter @interludelayer-sdk/sdk build
 *   pnpm --filter @interludelayer-sdk/sdk exec node examples/agent-tap.mjs
 *
 * Optional: INTERLUDE_TAP / INTERLUDE_NODE / INTERLUDE_BASE_RPC,
 *           AGENT_COUNT (default 5), AGENT_MS_MIN / AGENT_MS_MAX (default 50 / 500).
 */
import { createPublicClient, createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const { createInterludeClient, memoryStore } = await import("../dist/index.js").catch(() => {
  console.error("The SDK is not built: run `pnpm --filter @interludelayer-sdk/sdk build` first.");
  process.exit(1);
});

const NODE = process.env.INTERLUDE_NODE ?? process.env.INTERLUDE_TAP_NODE ?? "http://127.0.0.1:8556";
const APP = process.env.INTERLUDE_TAP ?? process.env.INTERLUDE_APP;
const BASE_RPC =
  process.env.INTERLUDE_BASE_RPC ??
  process.env.INTERLUDE_TAP_BASE_RPC ??
  "http://127.0.0.1:8547";
const COUNT = Number(process.env.AGENT_COUNT ?? 5);
const INTERVAL_MIN = Number(process.env.AGENT_MS_MIN ?? 50);
const INTERVAL_MAX = Number(process.env.AGENT_MS_MAX ?? 500);
const SIZES = [10, 50, 100];

if (!APP) {
  console.error("Set INTERLUDE_TAP (or INTERLUDE_APP) to the TapBook address.");
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
];

const base = createPublicClient({ transport: http(BASE_RPC) });

console.log("tap     ", APP);
console.log("node    ", NODE);
console.log("agents  ", COUNT, `every ${INTERVAL_MIN}–${INTERVAL_MAX}ms`);

async function runAgent(index) {
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = createWalletClient({ account, transport: http(BASE_RPC) });
  const interlude = createInterludeClient({
    app: APP,
    abi,
    node: NODE,
    base,
    store: memoryStore(),
  });

  const session = await interlude.openSession({
    wallet,
    scope: ["join", "buy", "sell"],
    force: true,
  });

  await session.send("join");
  console.log(`agent ${index}  ${account.address}  joined`);

  let side = index % 2 === 0 ? "buy" : "sell";
  for (;;) {
    const size = SIZES[Math.floor(Math.random() * SIZES.length)];
    try {
      const cash = await interlude.node.readContract({
        address: APP,
        abi,
        functionName: "cashOf",
        args: [account.address],
      });
      const inv = await interlude.node.readContract({
        address: APP,
        abi,
        functionName: "invOf",
        args: [account.address],
      });

      let next = side;
      if (next === "buy" && cash < BigInt(size)) next = "sell";
      if (next === "sell" && inv < BigInt(size)) next = "buy";
      if (
        (next === "buy" && cash < BigInt(size)) ||
        (next === "sell" && inv < BigInt(size))
      ) {
        await sleep(INTERVAL_MIN + Math.random() * (INTERVAL_MAX - INTERVAL_MIN));
        continue;
      }

      const result =
        next === "buy"
          ? await session.send("buy", [BigInt(size)])
          : await session.send("sell", [BigInt(size)]);

      console.log(
        `agent ${index}  ${next.padEnd(4)} ${String(size).padStart(3)}  ${result.latencyMs.toFixed(1)} ms`,
      );
      if (Math.random() < 0.7) side = next === "buy" ? "sell" : "buy";
    } catch (err) {
      console.log(`agent ${index}  err  ${err instanceof Error ? err.message : err}`);
      side = side === "buy" ? "sell" : "buy";
    }
    await sleep(INTERVAL_MIN + Math.random() * (INTERVAL_MAX - INTERVAL_MIN));
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

await Promise.all(
  Array.from({ length: Math.max(1, Math.min(COUNT, 8)) }, (_, i) =>
    sleep(i * 200).then(() => runAgent(i + 1)),
  ),
);
