import { defineChain, type Chain } from "viem";

/**
 * Monad testnet, written out rather than imported from `viem/chains`, so the page does not
 * depend on which viem release first shipped it and the explorer link is the one used here.
 */
export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
  blockExplorers: {
    default: { name: "Monad Explorer", url: "https://testnet.monadexplorer.com" },
  },
  testnet: true,
});

/**
 * The chain the wallet has to be on to sign a session grant.
 *
 * A grant is EIP-712 data whose domain names the *base* chain (where the app is deployed), not
 * the node's. Wallets refuse to sign typed data for a chain other than the one they are on, so
 * the page moves the wallet there first. The id comes from the RPC rather than from config:
 * `interlude ship` means Monad testnet, `interlude dev` means a local anvil, and asking the RPC
 * cannot disagree with either.
 */
export function baseChain(id: number, rpc: string): Chain {
  if (id === monadTestnet.id) return monadTestnet;
  return defineChain({
    id,
    name: id === 31337 ? "Local anvil (interlude dev)" : `Base chain ${id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    testnet: true,
  });
}
