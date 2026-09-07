import {
  hashTypedData,
  toFunctionSelector,
  type Abi,
  type Account,
  type Address,
  type Hex,
  type TypedDataDefinition,
  type WalletClient,
} from "viem";

import { InvalidScopeError } from "./errors";

/**
 * A user's signed permission for a key it does not control to act as it.
 *
 * Mirrors `Types.SessionGrant`. Nothing registers it anywhere: it travels in the calldata of
 * every call that presents it, which is why a resolver replaying a batch reaches the same
 * verdict from the same bytes.
 */
export interface SessionGrant {
  /** The end user whose state is at stake, and what the app's `_actor()` returns. */
  granter: Address;
  /** The only address allowed to present this grant, and the key that signs the transactions. */
  sessionKey: Address;
  /** Unix seconds, exclusive. */
  expiry: bigint;
  /** The granter's `hub.sessionEpochOf` at signing time. */
  epoch: bigint;
  anyFunction: boolean;
  selectors: readonly Hex[];
}

/**
 * The name a wallet shows the signer, and the version beside it.
 *
 * Deliberately the protocol rather than the app: the app is already pinned by
 * `verifyingContract`. Both are hashed into the domain separator, so editing either one
 * invalidates every grant anybody has signed.
 */
export const SESSION_DOMAIN_NAME = "Interlude";
export const SESSION_DOMAIN_VERSION = "1";

/**
 * The EIP-712 struct, field for field and in order, as `Session.GRANT_TYPEHASH` spells it.
 *
 * `bytes4[]` is the field to be careful with. EIP-712 hashes a dynamic array as its members
 * alone, each padded to 32 bytes, with no offset and no length word, which is what
 * `Session.hashGrant` gets from `abi.encodePacked`. viem's encoder agrees, and
 * `test/digest.test.ts` checks that against the deployed contract rather than assuming it.
 */
export const SESSION_GRANT_TYPES = {
  SessionGrant: [
    { name: "granter", type: "address" },
    { name: "sessionKey", type: "address" },
    { name: "expiry", type: "uint64" },
    { name: "epoch", type: "uint64" },
    { name: "anyFunction", type: "bool" },
    { name: "selectors", type: "bytes4[]" },
  ],
} as const;

export interface GrantScope {
  /** The app the grant is for, which EIP-712 pins through `verifyingContract`. */
  app: Address;
  /**
   * The base chain's id, never the ephemeral one.
   *
   * The ephemeral id is node configuration and can differ between two sessions serving the same
   * app, so a grant bound to it would be a signature over something the user cannot check. The
   * base chain is recorded once, at deployment.
   */
  baseChainId: number;
}

export function sessionGrantTypedData(
  grant: SessionGrant,
  { app, baseChainId }: GrantScope,
): TypedDataDefinition<typeof SESSION_GRANT_TYPES, "SessionGrant"> {
  return {
    domain: {
      name: SESSION_DOMAIN_NAME,
      version: SESSION_DOMAIN_VERSION,
      chainId: baseChainId,
      verifyingContract: app,
    },
    types: SESSION_GRANT_TYPES,
    primaryType: "SessionGrant",
    message: {
      granter: grant.granter,
      sessionKey: grant.sessionKey,
      expiry: grant.expiry,
      epoch: grant.epoch,
      anyFunction: grant.anyFunction,
      selectors: [...grant.selectors],
    },
  };
}

/** The digest the granter signs, and the one `Delegatable.sessionDigest` returns. */
export function sessionGrantDigest(grant: SessionGrant, scope: GrantScope): Hex {
  return hashTypedData(sessionGrantTypedData(grant, scope));
}

/** Prompt the user's wallet once. Every call afterwards is signed by the session key. */
export async function signSessionGrant(
  wallet: WalletClient,
  account: Account | Address,
  grant: SessionGrant,
  scope: GrantScope,
): Promise<Hex> {
  return wallet.signTypedData({
    account,
    ...sessionGrantTypedData(grant, scope),
  });
}

/** A function name, a full signature, or a 4-byte selector. */
export type ScopeEntry = string;

/**
 * Resolve what the developer wrote into the selectors a grant carries.
 *
 * Names are looked up in the ABI so that a typo is a throw at session-open time rather than a
 * `SelectorOutOfSessionScope` revert on the first call.
 */
export function resolveScope(abi: Abi | readonly unknown[], scope: readonly ScopeEntry[]): Hex[] {
  const functions = (abi as Abi).filter(
    (item): item is Extract<Abi[number], { type: "function" }> => item.type === "function",
  );

  return scope.map((entry) => {
    if (/^0x[0-9a-fA-F]{8}$/.test(entry)) return entry.toLowerCase() as Hex;
    if (entry.includes("(")) return toFunctionSelector(entry);

    const matches = functions.filter((item) => item.name === entry);
    const [only] = matches;
    if (!only) {
      throw new InvalidScopeError(
        `the ABI has no function named "${entry}", so no selector could be put in the grant`,
      );
    }
    if (matches.length > 1) {
      throw new InvalidScopeError(
        `"${entry}" is overloaded in this ABI; name the full signature, ` +
          `for instance "${entry}(${(matches[0]?.inputs ?? []).map((i) => i.type).join(",")})"`,
      );
    }
    return toFunctionSelector(only);
  });
}

/** Whether a grant admits `selector`, checked before a call is signed rather than after. */
export function grantCovers(grant: SessionGrant, selector: Hex): boolean {
  if (grant.anyFunction) return true;
  const wanted = selector.toLowerCase();
  return grant.selectors.some((s) => s.toLowerCase() === wanted);
}
