/**
 * A headless agent on the public Room.
 *
 * No browser, no React, no faucet. The agent is the granter: it signs one
 * EIP-712 grant, joins the floor, then walks. Watch the explorer for the
 * steps, then the settle on Monad.
 *
 *   pnpm --filter @interludelayer-sdk/sdk exec node examples/agent-room.mjs
 *
 * Optional: INTERLUDE_NODE, INTERLUDE_ROOM, INTERLUDE_BASE_RPC.
 */
import { createPublicClient, createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createInterludeClient, memoryStore } from "../dist/index.js";

const NODE = process.env.INTERLUDE_NODE ?? "https://rpc.interludelayer.xyz";
const APP = process.env.INTERLUDE_ROOM ?? "0x28C583542854f2E0b32930E5252687F6fA8D5d91";
const BASE_RPC = process.env.INTERLUDE_BASE_RPC ?? "https://testnet-rpc.monad.xyz";
const EXPLORER = "https://demo.interludelayer.xyz/explorer";

const abi = [
  {
    type: "function",
    name: "join",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "move",
    stateMutability: "nonpayable",
    inputs: [{ name: "dir", type: "uint8" }],
    outputs: [],
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
  scope: ["join", "move"],
});

console.log("agent   ", session.granter);
console.log("app     ", APP);
console.log("node    ", NODE);
console.log("grant   signed once. every step after this is the session key.");

const joined = await session.send("join");
console.log("join    ", joined.latencyMs.toFixed(1), "ms");
console.log("watch   ", EXPLORER);

for (const dir of [1, 2, 3, 0]) {
  try {
    const stepped = await session.send("move", [dir]);
    console.log("move    ", dir, stepped.latencyMs.toFixed(1), "ms");
  } catch (err) {
    console.log("move    ", dir, err instanceof Error ? err.message : err);
  }
}
