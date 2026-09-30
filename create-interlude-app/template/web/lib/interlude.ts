import { createPublicClient, http, isAddress, zeroAddress, type Address } from "viem";
import { createInterludeClient } from "@interludelayer-sdk/sdk";
import { createInterludeHooks } from "@interludelayer-sdk/sdk/react";
import { abi } from "./abi";
import { monadTestnet } from "./chain";

/**
 * The three values `interlude ship --out ../web/.env.local` writes.
 *
 * Read with their full literal names: Next.js inlines `process.env.NEXT_PUBLIC_*` at build time
 * only where the name is spelled out, so a lookup through a variable would be `undefined` in the
 * browser.
 */
const APP = process.env.NEXT_PUBLIC_INTERLUDE_APP?.trim() ?? "";
const NODE = process.env.NEXT_PUBLIC_INTERLUDE_NODE?.trim() ?? "";
const BASE_RPC =
  process.env.NEXT_PUBLIC_INTERLUDE_BASE_RPC?.trim() || monadTestnet.rpcUrls.default.http[0];

/** Why the page cannot talk to a node yet, or null when it can. */
export const configProblem: string | null = !APP
  ? "NEXT_PUBLIC_INTERLUDE_APP is not set."
  : !isAddress(APP) || APP === zeroAddress
    ? `NEXT_PUBLIC_INTERLUDE_APP is "${APP}", which is not a contract address.`
    : !NODE
      ? "NEXT_PUBLIC_INTERLUDE_NODE is not set."
      : null;

export const config = {
  app: (configProblem ? zeroAddress : APP) as Address,
  node: NODE || "http://127.0.0.1:8555",
  baseRpc: BASE_RPC,
};

/**
 * The base chain, read-only. The SDK asks it three things no node can answer: the chain id a
 * grant is bound to, the hub's address, and the user's session epoch. Settled reads go here too.
 */
export const base = createPublicClient({ transport: http(config.baseRpc) });

/**
 * One client for the app. Built even when the env is missing, so the hooks below always exist;
 * the page renders the setup screen instead of mounting the provider in that case, and nothing
 * here touches the network until it is used.
 */
export const interlude = createInterludeClient({
  app: config.app,
  abi,
  node: config.node,
  base,
});

/**
 * Hooks bound to Clicker's ABI, so `useSessionCall("click")` and `useWatch("clicksOf", [me])`
 * are checked against the contract: a typo in a function name is a type error, not a revert.
 */
export const { InterludeProvider, useSession, useSessionCall, useWatch, useInterlude } =
  createInterludeHooks(interlude);

/** What a session key may call. Everything else in the ABI stays out of its reach. */
export const SCOPE = ["click"] as const;
