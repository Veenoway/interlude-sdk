import type { Address, Hex } from "viem";

import type { SessionGrant } from "./grant";

/**
 * Where a session key and its grant live between page loads.
 *
 * The key alone would be useless: restoring it without the signed grant would mean prompting
 * the wallet again on every refresh, which is the popup this whole scheme exists to remove. So
 * the two are stored together and a refresh costs nothing.
 */
export interface SessionStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** What is written: enough to send calls again, and nothing else. */
export interface StoredSession {
  app: Address;
  baseChainId: number;
  privateKey: Hex;
  signature: Hex;
  grant: SessionGrant;
}

export function memoryStore(): SessionStore {
  const entries = new Map<string, string>();
  return {
    get: (key) => entries.get(key) ?? null,
    set: (key, value) => void entries.set(key, value),
    remove: (key) => void entries.delete(key),
  };
}

/**
 * A `Storage` from the browser, `sessionStorage` by default.
 *
 * `sessionStorage` and not `localStorage`, deliberately, and there is no option for the latter:
 * the key dies with the tab, so a session that outlives the user's visit does not exist. What a
 * leaked key can do until its grant expires is bounded by the grant, not by where it was kept
 * — `withSession` is not payable and the scope names the functions — but a key that survives a
 * closed tab is a key nobody is watching.
 */
export function webStorageStore(storage: Storage): SessionStore {
  return {
    get: (key) => {
      try {
        return storage.getItem(key);
      } catch {
        // Private-mode Safari throws on read as well as write.
        return null;
      }
    },
    set: (key, value) => {
      try {
        storage.setItem(key, value);
      } catch {
        // A session that cannot be persisted still works; it just will not survive a refresh.
      }
    },
    remove: (key) => {
      try {
        storage.removeItem(key);
      } catch {
        /* as above */
      }
    },
  };
}

/** `sessionStorage` where there is one, memory where there is not, so Node and SSR work. */
export function defaultStore(): SessionStore {
  try {
    if (typeof globalThis.sessionStorage !== "undefined") {
      return webStorageStore(globalThis.sessionStorage);
    }
  } catch {
    /* a sandboxed iframe can throw merely on touching the property */
  }
  return memoryStore();
}

/**
 * One entry per app, per base chain, per user.
 *
 * The granter is part of the key so that switching accounts in the wallet does not hand the new
 * account the previous one's grant, which would fail with `SessionNotSignedByGranter` on the
 * first call and look like a signing bug.
 */
export function storageKey(app: Address, baseChainId: number, granter: Address): string {
  return `interlude.session.${baseChainId}.${app.toLowerCase()}.${granter.toLowerCase()}`;
}

export function encodeSession(session: StoredSession): string {
  return JSON.stringify({
    app: session.app,
    baseChainId: session.baseChainId,
    privateKey: session.privateKey,
    signature: session.signature,
    grant: {
      ...session.grant,
      expiry: session.grant.expiry.toString(),
      epoch: session.grant.epoch.toString(),
      selectors: [...session.grant.selectors],
    },
  });
}

/** Anything that does not parse into a whole session is treated as absent, not as an error. */
export function decodeSession(raw: string | null): StoredSession | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const grant = parsed.grant as Record<string, unknown> | undefined;
    if (!grant) return null;

    const session: StoredSession = {
      app: parsed.app as Address,
      baseChainId: Number(parsed.baseChainId),
      privateKey: parsed.privateKey as Hex,
      signature: parsed.signature as Hex,
      grant: {
        granter: grant.granter as Address,
        sessionKey: grant.sessionKey as Address,
        expiry: BigInt(grant.expiry as string),
        epoch: BigInt(grant.epoch as string),
        anyFunction: Boolean(grant.anyFunction),
        selectors: grant.selectors as Hex[],
      },
    };

    if (!session.privateKey || !session.signature || !session.grant.granter) return null;
    return session;
  } catch {
    return null;
  }
}
