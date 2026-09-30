// Interlude in 60 seconds: a throwaway key walks the public Paris Room with no gas, then waits
// for Monad to carry its steps. Anywhere: `npm i @interludelayer-sdk/sdk viem && node try.mjs`.
// In this repository, build first: `pnpm --filter @interludelayer-sdk/sdk build`.
import { createInterludeClient, memoryStore, roomAbi } from "@interludelayer-sdk/sdk";
import { createPublicClient, createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

const account = privateKeyToAccount(generatePrivateKey()); // fresh, never funded: no MON needed
const interlude = createInterludeClient({
  app: "0xA116fcaEC711c9D8f64DA409CBE3AF673Fb9084C", // the Paris Room, on hub v3
  abi: roomAbi,
  node: "https://rpc.interludelayer.xyz", // the node that serves that Room, and only it
  base: createPublicClient({ chain: monadTestnet, transport: http() }),
  store: memoryStore(),
});

// The one signature: an EIP-712 grant letting a session key call these three for an hour.
const wallet = createWalletClient({ account, chain: monadTestnet, transport: http() });
const session = await interlude.openSession({ wallet, scope: ["join", "move", "leave"] });
console.log("player  ", account.address);

// Join, walk a square (east, south, west, north), then free the cell for the next visitor. A
// wall or another body refuses a step, by name.
const steps = [["join", []], ...[1, 2, 3, 0].map((dir) => ["move", [dir]]), ["leave", []]];
const sent = [];
for (const [fn, args] of steps) {
  const label = `${fn} ${args.join("")}`.padEnd(8);
  try {
    sent.push(await session.send(fn, args));
    console.log(label, `${sent.at(-1).latencyMs.toFixed(1)} ms`);
  } catch (error) {
    console.log(label, "refused:", error.errorName ?? error.message);
  }
}
if (sent.length === 0) process.exit(1);

// The node commits what it holds every few seconds, so the walk can straddle two commits.
console.log("waiting for the node to commit that to Monad...");
const links = new Map();
for (const call of sent) {
  const { batchIndex, settlementHash } = await call.settled;
  links.set(batchIndex, `https://testnet.monadscan.com/tx/${settlementHash}`);
}
for (const [batch, link] of links) console.log(`batch ${batch}`.padEnd(8), link);
process.exit(0); // on Node 22+ the client holds a WebSocket to the node open for the next call
