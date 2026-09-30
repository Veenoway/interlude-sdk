/**
 * A headless agent on the public Room.
 *
 * No browser, no React, no faucet. The agent is the granter: it signs one
 * EIP-712 grant, joins the floor, walks, then leaves. Watch the explorer for
 * the steps, then the settle on Monad.
 *
 * It runs against the built package, so build it first:
 *
 *   pnpm --filter @interludelayer-sdk/sdk build
 *   pnpm --filter @interludelayer-sdk/sdk exec node examples/agent-room.mjs
 *
 * Optional: INTERLUDE_NODE, INTERLUDE_ROOM, INTERLUDE_BASE_RPC. The defaults are the Paris
 * Room and the node that serves it; override both together, since a node serves one contract.
 */
import { createPublicClient, createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const sdk = await import("../dist/index.js").catch(() => undefined);
// A build from before 0.2.1 has no `roomAbi`, which is as good as no build here.
if (!sdk?.roomAbi) {
  console.error(
    "The SDK is not built, or predates roomAbi: " +
      "run `pnpm --filter @interludelayer-sdk/sdk build` first.",
  );
  process.exit(1);
}
const { createInterludeClient, memoryStore, roomAbi } = sdk;

const NODE = process.env.INTERLUDE_NODE ?? "https://rpc.interludelayer.xyz";
const APP = process.env.INTERLUDE_ROOM ?? "0xA116fcaEC711c9D8f64DA409CBE3AF673Fb9084C";
const BASE_RPC = process.env.INTERLUDE_BASE_RPC ?? "https://testnet-rpc.monad.xyz";
const EXPLORER = "https://demo.interludelayer.xyz/explorer";

const account = privateKeyToAccount(generatePrivateKey());
const base = createPublicClient({ transport: http(BASE_RPC) });
const wallet = createWalletClient({ account, transport: http(BASE_RPC) });

const interlude = createInterludeClient({
  app: APP,
  // Room's functions and its errors: a step off the floor is reported as `Edge`, not as the
  // four bytes `0x105d8ccf` a function-only ABI left undecoded.
  abi: roomAbi,
  node: NODE,
  base,
  store: memoryStore(),
});

const session = await interlude.openSession({
  wallet,
  scope: ["join", "move", "leave"],
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

// Every run is a fresh key, so a body left standing would hold its cell until the owner resets
// the floor. Enough runs like that and the public Room answers `Full` to everyone.
const left = await session.send("leave");
console.log("leave   ", left.latencyMs.toFixed(1), "ms");
// On Node 22+ the client keeps a WebSocket to the node open, which would keep this process alive.
process.exit(0);
