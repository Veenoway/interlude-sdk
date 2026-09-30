/**
 * A headless agent on the public Clock.
 *
 * No browser, no React, no faucet. The agent is the granter: it signs one
 * EIP-712 grant, opens a board, then presses. Watch the explorer for the
 * presses, then the settle on Monad.
 *
 * It runs against the built package, so build it first:
 *
 *   pnpm --filter @interludelayer-sdk/sdk build
 *   INTERLUDE_CLOCK=0x… INTERLUDE_NODE=https://… \
 *     pnpm --filter @interludelayer-sdk/sdk exec node examples/agent-clock.mjs
 *
 * Required: INTERLUDE_CLOCK (the Clock's address) and INTERLUDE_NODE (the node that serves
 * that Clock). There is no default: every node serves exactly one contract, and the public
 * url this used to default to serves the Room, which refuses a Clock call with `WrongTarget`.
 * The names `interlude ship --out` writes (NEXT_PUBLIC_INTERLUDE_APP, _NODE, _BASE_RPC) are read
 * too, so a shipped Clock's .env.local works as is.
 * Optional: INTERLUDE_BASE_RPC, AGENT_PRESSES.
 */
import { createPublicClient, createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const { createInterludeClient, memoryStore } = await import("../dist/index.js").catch(() => {
  console.error("The SDK is not built: run `pnpm --filter @interludelayer-sdk/sdk build` first.");
  process.exit(1);
});

const NODE = process.env.INTERLUDE_NODE ?? process.env.NEXT_PUBLIC_INTERLUDE_NODE;
const APP = process.env.INTERLUDE_CLOCK ?? process.env.NEXT_PUBLIC_INTERLUDE_APP;
const BASE_RPC =
  process.env.INTERLUDE_BASE_RPC ??
  process.env.NEXT_PUBLIC_INTERLUDE_BASE_RPC ??
  "https://testnet-rpc.monad.xyz";
if (!NODE || !APP) {
  console.error(
    "Set INTERLUDE_CLOCK to the Clock's address and INTERLUDE_NODE to the node serving it " +
      "(both printed by `interlude ship`).",
  );
  process.exit(1);
}
const PRESSES = Number(process.env.AGENT_PRESSES ?? 12);
const BUDGET_MS = 60_000;
const EXPLORER = "https://demo.interludelayer.xyz/explorer";

const board = {
  name: "b",
  type: "tuple",
  components: [
    { name: "player", type: "address" },
    { name: "whiteMs", type: "uint32" },
    { name: "blackMs", type: "uint32" },
    { name: "pressedAt", type: "uint40" },
    { name: "presses", type: "uint32" },
    { name: "turn", type: "uint8" },
    { name: "status", type: "uint8" },
  ],
};

const abi = [
  {
    type: "function",
    name: "open",
    stateMutability: "nonpayable",
    inputs: [{ name: "budgetMs", type: "uint32" }],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "press",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [board],
  },
];

const account = privateKeyToAccount(generatePrivateKey());
const base = createPublicClient({ transport: http(BASE_RPC) });
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
  scope: ["open", "press"],
});

console.log("agent   ", session.granter);
console.log("app     ", APP);
console.log("node    ", NODE);
console.log("grant   signed once. every press after this is the session key.");

const opened = await session.send("open", [BUDGET_MS]);
const boardId = opened.result;
console.log("board   ", boardId.toString());
console.log("open    ", opened.latencyMs.toFixed(1), "ms");
console.log("watch   ", EXPLORER);

const latencies = [];
for (let i = 0; i < PRESSES; i++) {
  const { result, latencyMs } = await session.send("press", [boardId]);
  latencies.push(latencyMs);
  console.log(
    `press ${String(i + 1).padStart(2, "0")}  ${latencyMs.toFixed(1)} ms   turn=${result.turn}  n=${result.presses}`,
  );
}

const mean = latencies.reduce((s, n) => s + n, 0) / latencies.length;
console.log("mean    ", mean.toFixed(1), "ms over", latencies.length, "presses");
console.log("settle  the next commit on the node lands this on Monad. same address.");
