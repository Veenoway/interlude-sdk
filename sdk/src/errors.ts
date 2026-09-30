import { decodeErrorResult, type Abi, type Address, type Hex } from "viem";

import { delegatableErrorsAbi } from "./abi";

export class InterludeError extends Error {
  override name = "InterludeError";
}

/** The scope handed to `openSession` names something the ABI does not. */
export class InvalidScopeError extends InterludeError {
  override name = "InvalidScopeError";
}

/** The node could not be reached, or answered something that was not a response. */
export class NodeUnreachableError extends InterludeError {
  override name = "NodeUnreachableError";
  constructor(
    readonly url: string,
    override readonly cause: unknown,
  ) {
    super(
      `the Interlude node at ${url} did not answer: ${describe(cause)}. ` +
        `Check the url and that the node is serving this app.`,
    );
  }
}

/**
 * `waitSettled` ran out of time with diffs still pending.
 *
 * The node answered; Monad has not taken the batch. Commits may have stopped, or the interval
 * is longer than the timeout you passed.
 */
export class SettlementTimeoutError extends InterludeError {
  override name = "SettlementTimeoutError";
  constructor(
    readonly pending: number,
    readonly committedBatches: number,
    readonly timeoutMs: number,
  ) {
    super(
      `pending diffs did not settle in ${timeoutMs}ms (still ${pending}, batch ${committedBatches})`,
    );
  }
}

/**
 * The transaction `settled` was waiting for is gone: the node no longer has a receipt for it and
 * no batch it committed carries it.
 *
 * That is what a node restart that dropped its pending state looks like. The call executed and
 * answered, but it was never committed and never will be, so the page should say so rather than
 * report it settled because `pendingDiffs` happens to be empty on a fresh node.
 */
export class SettlementLostError extends InterludeError {
  override name = "SettlementLostError";
  constructor(
    readonly hash: Hex,
    readonly committedBatches: number,
  ) {
    super(
      `transaction ${hash} is not in any batch this node committed (${committedBatches} so far) ` +
        `and the node no longer knows it, so it will never settle. The node most likely ` +
        `restarted and dropped what it had not committed yet; send the call again.`,
    );
  }
}

/** A stored session exists but does not match what was asked for, or is no longer usable. */
export class SessionUnusableError extends InterludeError {
  override name = "SessionUnusableError";
}

/**
 * The node refused a transaction to keep its next commit sellable: the open batch is full, or
 * this call would push the pending diffs over `maxDiffsPerCommit`.
 *
 * Nothing executed and the nonce was not consumed. `retryable` is the node's own verdict: true
 * means the next commit makes room, and `send` already waited and retried before throwing this;
 * false means this one call is too large to ever fit, and retrying it is pointless.
 */
export class NodeBusyError extends InterludeError {
  override name = "NodeBusyError";
  /**
   * `"batch"`: the open batch is full, as above. `"limit"`: the node's front door refused the
   * request before looking at it — too many requests from this caller or this signer, too many
   * in flight (JSON-RPC -32005, or HTTP 429) — and `retryAfterMs` is how long it asked for.
   */
  readonly kind: "batch" | "limit";
  readonly retryAfterMs: number | undefined;
  constructor(
    readonly retryable: boolean,
    readonly detail: string,
    override readonly cause?: unknown,
    options?: { kind?: "batch" | "limit"; retryAfterMs?: number },
  ) {
    const kind = options?.kind ?? "batch";
    super(
      kind === "limit"
        ? `the node is rate limiting this caller (${detail}). The SDK waited and retried where ` +
            `it could; slow down, or try again in a moment.`
        : retryable
          ? `the node's open batch has no room for this call until its next commit (${detail}). ` +
            `The SDK retried with backoff and gave up; try again in a moment, or lower the rate.`
          : `this call can never fit in one batch (${detail}): it writes more than the ` +
            `delegation's maxDiffsPerCommit allows. Split the work into smaller calls.`,
    );
    this.kind = kind;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/**
 * The node at this url serves a different app than the client was configured with.
 *
 * Every node serves exactly one contract. The usual cause is a copied `node` url from another
 * floor, or an `app` address from a previous deployment.
 */
export class WrongNodeError extends InterludeError {
  override name = "WrongNodeError";
  constructor(
    readonly url: string,
    readonly served?: Address,
    readonly expected?: Address,
  ) {
    super(
      `the Interlude node at ${url} serves ${served ?? "another app"}, not ` +
        `${expected ?? "the app this call was addressed to"}. Each node serves one contract: ` +
        `pass the node url that was printed for your app, or the app address this node was ` +
        `started for.`,
    );
  }
}

/**
 * The call ran and tried to write state the delegation does not cover, so the node dropped it
 * whole: another contract's storage, or a slot of this app that was never delegated.
 *
 * Not a revert of the app's own rules. With a per-key delegation it usually means the session's
 * granter is not the key this node was delegated for.
 */
export class WriteOutsideDelegationError extends InterludeError {
  override name = "WriteOutsideDelegationError";
  constructor(
    readonly detail: string,
    override readonly cause?: unknown,
  ) {
    super(
      `the node refused the call because it writes outside the delegation (${detail}). The ` +
        `node can only commit the state it was handed: with a per-key delegation, check that ` +
        `the user is the key that was delegated; otherwise delegate the slot or the mapping.`,
    );
  }
}

/**
 * The wallet is connected to another chain than the base chain the app lives on.
 *
 * Checked before anything is sent or signed: an on-chain write sent to the wrong network would
 * "succeed" against an empty address, and a wallet asked to sign a grant for another chain
 * refuses with a message that names neither chain. `client.ensureChain(wallet)` switches, or
 * adds, the base chain.
 */
export class WrongChainError extends InterludeError {
  override name = "WrongChainError";
  constructor(
    readonly expected: number,
    readonly actual: number,
    readonly action: string,
  ) {
    super(
      `${action} has to happen on chain ${expected}, the app's base chain, but the wallet is ` +
        `on chain ${actual}. Switch networks in the wallet (client.ensureChain(wallet) asks it ` +
        `to) and try again; nothing was sent or signed.`,
    );
  }
}

/**
 * This session's grant was revoked with `revokeAll`, so the client refuses to use its key.
 *
 * The honest part is in the message: the revocation is final on the base chain, but a node
 * reads the session epoch at the block its delegation was pinned to. Until that delegation is
 * reopened the node still accepts the old grant from whoever holds the key, and refuses a fresh
 * grant with `SessionEpochStale`. The grant's expiry is what bounds a stolen key meanwhile.
 */
export class SessionRevokedError extends InterludeError {
  override name = "SessionRevokedError";
  constructor(
    readonly granter: Address,
    readonly grantEpoch: bigint,
  ) {
    super(
      `the session grant from ${granter} (epoch ${grantEpoch}) was revoked with revokeAll(), ` +
        `so this client will not sign with its key again. Note the node's lag: it reads the ` +
        `epoch at the block its delegation was pinned to, so until the delegation is reopened ` +
        `the node still honours the old grant for whoever holds the key (its expiry bounds ` +
        `that), and refuses a new grant with SessionEpochStale.`,
    );
  }
}

/**
 * The call executed on the node, but its response was lost on the way back and the node's
 * stored receipt does not carry return data, so there is no result to decode.
 *
 * Thrown instead of sending again: the SDK found the transaction by its hash, so it knows the
 * call happened, and re-signing it would have run the action twice. `receipt` says whether it
 * succeeded.
 */
export class ResultUnavailableError extends InterludeError {
  override name = "ResultUnavailableError";
  constructor(
    readonly hash: Hex,
    readonly receipt: { status: Hex; transactionHash: Hex },
  ) {
    super(
      `the call ${hash} executed on the node (status ${receipt.status}) but its response was ` +
        `lost, and the node's receipt carries no return data. It was not sent again, so do not ` +
        `retry it blindly: read the state it changed instead.`,
    );
  }
}

// --- reverts the session machinery raises --------------------------------
//
// Every one of these is a named error in `Delegatable` or `Session`. They arrive as four bytes
// of revert data, which is worth nothing to a developer, so each becomes a sentence naming what
// to do about it.

export class SessionExpiredError extends InterludeError {
  override name = "SessionExpiredError";
  constructor(readonly expiry?: bigint) {
    super(
      `the grant expired${expiry ? ` at ${new Date(Number(expiry) * 1000).toISOString()}` : ""}. ` +
        `Open a new session; the user signs once and plays on.`,
    );
  }
}

/**
 * Raised twice by the contract, for two different mistakes, and they need different answers.
 *
 * `grant` is the call naming a function the scope does not list, which the SDK catches before
 * signing. `selfCall` is an app dispatching through `this.other()`: the actor is only trusted
 * for the selector the grant was presented for, so the inner frame cannot resolve `_actor()`.
 */
export class SelectorOutOfSessionScopeError extends InterludeError {
  override name = "SelectorOutOfSessionScopeError";
  constructor(
    readonly source: "grant" | "selfCall",
    readonly selector: Hex,
    readonly functionName?: string,
  ) {
    super(
      source === "grant"
        ? `this session's grant does not cover ${label(selector, functionName)}. ` +
            `Open a session whose scope includes it, or one with anyFunction.`
        : `${label(selector, functionName)} reverted with SelectorOutOfSessionScope even though ` +
            `the grant covers it, which is what an external self-call looks like: an app that ` +
            `dispatches work through this.other() hands the inner frame a different msg.sig, ` +
            `and the actor is only trusted for the selector the grant was presented for. ` +
            `Listing the inner selector in the scope does not help, because the recorded ` +
            `selector is the outer one. Call each function under its own grant, or open the ` +
            `session with anyFunction, which is the only grant that carries an actor through a ` +
            `self-call.`,
    );
  }
}

export class SessionEpochStaleError extends InterludeError {
  override name = "SessionEpochStaleError";
  /**
   * True when the hub agrees with the grant and it is the node that is behind: it pinned its
   * delegation before the user's last `bumpSessionEpoch()`, and a fresh grant will keep being
   * refused until the delegation is reopened. Signing again does not help in that case.
   */
  readonly pinnedByNode: boolean;
  constructor(
    readonly grantEpoch: bigint,
    readonly hubEpoch?: bigint,
  ) {
    super(explainEpoch(grantEpoch, hubEpoch));
    this.pinnedByNode = hubEpoch !== undefined && hubEpoch === grantEpoch;
  }
}

export class WrongSessionKeyError extends InterludeError {
  override name = "WrongSessionKeyError";
  constructor(
    readonly expected: Address,
    readonly got: Address,
  ) {
    super(
      `the grant names ${expected} as its session key but the call was signed by ${got}. ` +
        `A grant is only ever presented by its own key, so a grant restored without the key ` +
        `that goes with it is inert: open a new session.`,
    );
  }
}

export class PrivilegedSelectorError extends InterludeError {
  override name = "PrivilegedSelectorError";
  constructor(
    readonly selector: Hex,
    readonly functionName?: string,
  ) {
    super(
      `${label(selector, functionName)} is one of the functions no grant may reach, whatever ` +
        `its scope says: the delegation controls and the hub callbacks. Call it from the app ` +
        `owner's own wallet on the base chain.`,
    );
  }
}

export class SessionAlreadyOpenError extends InterludeError {
  override name = "SessionAlreadyOpenError";
  constructor() {
    super(
      `a session is already open on this call stack. withSession refuses to nest, so a ` +
        `contract reached from inside a session call cannot open one of its own.`,
    );
  }
}

export class EmptySessionScopeError extends InterludeError {
  override name = "EmptySessionScopeError";
  constructor() {
    super(
      `the grant names no selectors and is not a wildcard, so it authorises nothing. ` +
        `Pass a scope to openSession.`,
    );
  }
}

export class SessionGranterIsZeroError extends InterludeError {
  override name = "SessionGranterIsZeroError";
  constructor() {
    super(`the grant names the zero address as its granter. Connect a wallet first.`);
  }
}

export class SessionKeyIsZeroError extends InterludeError {
  override name = "SessionKeyIsZeroError";
  constructor() {
    super(`the grant names the zero address as its session key.`);
  }
}

export class MalformedSessionCallError extends InterludeError {
  override name = "MalformedSessionCallError";
  constructor() {
    super(
      `the wrapped call is shorter than a selector, so it would land on the app's fallback ` +
        `and there would be nothing for the grant's scope to name.`,
    );
  }
}

export class SessionNotSignedByGranterError extends InterludeError {
  override name = "SessionNotSignedByGranterError";
  constructor(readonly granter?: Address) {
    super(
      `the signature is well formed but does not recover to ${granter ?? "the granter"}. ` +
        `That is also what a grant signed for another app or another chain looks like, since ` +
        `both are bound through the EIP-712 domain: check that the app address and the base ` +
        `chain id the grant was signed under are the ones this call is going to.`,
    );
  }
}

export class NoActorError extends InterludeError {
  override name = "NoActorError";
  constructor() {
    super(`the app asked for an actor and there was none.`);
  }
}

export class BadSessionSignatureError extends InterludeError {
  override name = "BadSessionSignatureError";
  constructor() {
    super(`the grant's signature is not 65 bytes, or recovers nobody.`);
  }
}

export class MalleableSessionSignatureError extends InterludeError {
  override name = "MalleableSessionSignatureError";
  constructor() {
    super(
      `the grant's signature has a high s value. Every signature has a twin that recovers the ` +
        `same address, and only the low one is accepted so that one grant has one encoding.`,
    );
  }
}

/**
 * The app's write guard, which is armed on the base chain and off on the ephemeral one.
 *
 * Overwhelmingly this means the transaction went to the base chain RPC rather than to the node.
 */
export class DelegatedWritesDisabledError extends InterludeError {
  override name = "DelegatedWritesDisabledError";
  constructor() {
    super(
      `this state is delegated, so the app refuses to write it here. Send the call to the ` +
        `Interlude node's url rather than to the base chain, and let the node commit it.`,
    );
  }
}

export class NotRegisteredError extends InterludeError {
  override name = "NotRegisteredError";
  constructor() {
    super(
      `the app wrote a Delegated variable it never registered. Register it in the ` +
        `constructor or the initializer.`,
    );
  }
}

/**
 * One of `Delegatable`'s access or bookkeeping reverts, which a session call rarely sees.
 *
 * `args` are the error's own, decoded: `TermsRejected` carries the validator whose terms refused.
 */
export class DelegatableError extends InterludeError {
  override name = "DelegatableError";
  constructor(
    readonly errorName: string,
    readonly args: readonly unknown[] = [],
  ) {
    const called = args.length ? `${errorName}(${args.map(format).join(", ")})` : errorName;
    super(`the app reverted with ${called}, raised by Delegatable rather than by the app.`);
  }
}

/** The app's own revert, decoded against its ABI: its name and its arguments. */
export class AppRevertError extends InterludeError {
  override name = "AppRevertError";
  constructor(
    readonly errorName: string,
    readonly args: readonly unknown[],
    readonly data: Hex,
  ) {
    super(
      `the app reverted with ${errorName}(${args.map(format).join(", ")}). ` +
        `This is the app's own rule, not the session machinery's.`,
    );
  }
}

/** Revert data that matched nothing in the ABI. */
export class UnrecognisedRevertError extends InterludeError {
  override name = "UnrecognisedRevertError";
  constructor(readonly data: Hex) {
    super(
      `the call reverted with data no error in the ABI matches: ${data}. ` +
        `If the app declares this error, pass its full ABI to createInterludeClient.`,
    );
  }
}

// --- decoding ------------------------------------------------------------

export interface RevertContext {
  /** The app function the call was wrapped around, for a message that names it. */
  selector?: Hex;
  functionName?: string;
  granter?: Address;
  sessionKey?: Address;
  signer?: Address;
  expiry?: bigint;
  grantEpoch?: bigint;
  hubEpoch?: bigint;
  /**
   * Whether the SDK already checked the selector against the grant before signing. It did,
   * unless the caller went around `Session.send`, which is what tells a
   * `SelectorOutOfSessionScope` coming back from the node apart from one the SDK would have
   * caught: the remaining cause is an external self-call inside the app.
   */
  scopeCheckedLocally?: boolean;
}

/**
 * Turn revert data into something a developer can act on.
 *
 * Tried against the session machinery's errors first and the app's ABI second. The order
 * matters only for an app that happens to declare an error of the same name, and in that case
 * the session machinery is the likelier author: it runs on every call.
 */
export function decodeRevert(
  data: Hex,
  abi: Abi | readonly unknown[],
  context: RevertContext = {},
): InterludeError {
  if (!data || data === "0x") {
    return new UnrecognisedRevertError(data);
  }

  const session = decodeAgainst(data, delegatableErrorsAbi);
  if (session) return sessionError(session.errorName, session.args ?? [], context);

  // Also covers `Error(string)` and `Panic(uint256)`, which viem knows without being told.
  const own = decodeAgainst(data, abi);
  if (own) return new AppRevertError(own.errorName, own.args ?? [], data);

  return new UnrecognisedRevertError(data);
}

function decodeAgainst(
  data: Hex,
  abi: Abi | readonly unknown[],
): { errorName: string; args?: readonly unknown[] } | null {
  try {
    return decodeErrorResult({ abi: abi as Abi, data });
  } catch {
    return null;
  }
}

function sessionError(
  errorName: string,
  args: readonly unknown[],
  ctx: RevertContext,
): InterludeError {
  const selector = ctx.selector ?? "0x00000000";

  switch (errorName) {
    case "SessionExpired":
      return new SessionExpiredError(ctx.expiry);
    case "SelectorOutOfSessionScope":
      return new SelectorOutOfSessionScopeError(
        ctx.scopeCheckedLocally ? "selfCall" : "grant",
        selector,
        ctx.functionName,
      );
    case "SessionEpochStale":
      return new SessionEpochStaleError(ctx.grantEpoch ?? 0n, ctx.hubEpoch);
    case "WrongSessionKey":
      return new WrongSessionKeyError(
        ctx.sessionKey ?? "0x0000000000000000000000000000000000000000",
        ctx.signer ?? "0x0000000000000000000000000000000000000000",
      );
    case "PrivilegedSelector":
      return new PrivilegedSelectorError(selector, ctx.functionName);
    case "SessionAlreadyOpen":
      return new SessionAlreadyOpenError();
    case "EmptySessionScope":
      return new EmptySessionScopeError();
    case "SessionGranterIsZero":
      return new SessionGranterIsZeroError();
    case "SessionKeyIsZero":
      return new SessionKeyIsZeroError();
    case "MalformedSessionCall":
      return new MalformedSessionCallError();
    case "SessionNotSignedByGranter":
      return new SessionNotSignedByGranterError(ctx.granter);
    case "NoActor":
      return new NoActorError();
    case "BadSessionSignature":
      return new BadSessionSignatureError();
    case "MalleableSessionSignature":
      return new MalleableSessionSignatureError();
    case "DelegatedWritesDisabled":
      return new DelegatedWritesDisabledError();
    case "NotRegistered":
      return new NotRegisteredError();
    default:
      return new DelegatableError(errorName, args);
  }
}

function explainEpoch(grantEpoch: bigint, hubEpoch?: bigint): string {
  const head = `the grant names session epoch ${grantEpoch}, which the app no longer accepts`;

  if (hubEpoch === undefined) {
    return (
      `${head}. That is what bumpSessionEpoch() does: it invalidates every grant the user has ` +
      `signed, for every app at once. Open a new session to sign a fresh one.`
    );
  }
  if (hubEpoch !== grantEpoch) {
    return (
      `${head}: the hub now reports ${hubEpoch}, so the user revoked their session keys with ` +
      `bumpSessionEpoch(). Open a new session to sign a fresh grant.`
    );
  }
  // The hub agrees with the grant, so the mismatch is the node's, not the user's.
  return (
    `${head}, even though the hub reports ${hubEpoch} on the base chain. The node reads the ` +
    `epoch at the block its delegation pinned, so a bump made after that block is not visible ` +
    `to it yet and a grant naming the new epoch looks stale from where it stands. Signing ` +
    `again will not help: it clears only when the app owner reopens the delegation. The ` +
    `same lag means the revoked grant still works on this node until it expires.`
  );
}

function label(selector: Hex, functionName?: string): string {
  return functionName ? `${functionName} (${selector})` : selector;
}

function format(value: unknown): string {
  return typeof value === "bigint" ? value.toString() : String(value);
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
