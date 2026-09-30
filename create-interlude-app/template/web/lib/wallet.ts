import {
  createWalletClient,
  custom,
  type Address,
  type Chain,
  type EIP1193Provider,
  type WalletClient,
} from "viem";
import { base, config } from "./interlude";
import { baseChain } from "./chain";

/** A wallet client that knows its account and its chain, which is what a grant needs. */
export type ConnectedWallet = WalletClient & { account: { address: Address } };

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

/** The injected wallet (MetaMask, Rabby, Phantom, a browser's own), or a sentence if none. */
export function injected(): EIP1193Provider {
  const provider = typeof window === "undefined" ? undefined : window.ethereum;
  if (!provider) {
    throw new Error("No wallet in this browser. Install MetaMask, Rabby or Phantom, then connect.");
  }
  return provider;
}

/**
 * Ask for an account and move the wallet to the base chain.
 *
 * The user needs no MON for anything this page does: opening a session is one signature, and
 * every click after it is a gasless call to the node. MON is only for base-chain transactions,
 * such as revoking every session at once.
 */
export async function connect(): Promise<ConnectedWallet> {
  const provider = injected();
  const [address] = await createWalletClient({ transport: custom(provider) }).requestAddresses();
  if (!address) throw new Error("The wallet returned no account.");
  return walletFor(provider, address);
}

/** The same wallet, re-bound: after an account switch, or before signing a grant. */
export async function walletFor(provider: EIP1193Provider, address: Address) {
  const chain = baseChain(await base.getChainId(), config.baseRpc);
  const wallet = createWalletClient({ account: address, chain, transport: custom(provider) });
  await ensureChain(wallet, chain);
  return wallet as ConnectedWallet;
}

/**
 * Put the wallet on `chain`, adding it first if the wallet has never heard of it.
 *
 * Without this the grant signature fails with a chain-mismatch error that names neither chain,
 * which is the most common way a first session goes wrong.
 */
export async function ensureChain(wallet: WalletClient, chain: Chain): Promise<void> {
  let current: number | undefined;
  try {
    current = await wallet.getChainId();
  } catch {
    // Some injected wallets answer late on first load; switching anyway is harmless.
  }
  if (current === chain.id) return;
  try {
    await wallet.switchChain({ id: chain.id });
  } catch {
    await wallet.addChain({ chain });
    await wallet.switchChain({ id: chain.id });
  }
}
