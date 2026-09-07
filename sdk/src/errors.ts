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

/** A stored session exists but does not match what was asked for, or is no longer usable. */
export class SessionUnusableError extends InterludeError {
  override name = "SessionUnusableError";
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
  constructor(
    readonly grantEpoch: bigint,
    readonly hubEpoch?: bigint,
  ) {
    super(explainEpoch(grantEpoch, hubEpoch));
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

/** One of `Delegatable`'s access or bookkeeping reverts, which a session call rarely sees. */
export class DelegatableError extends InterludeError {
  override name = "DelegatableError";
  constructor(readonly errorName: string) {
    super(`the app reverted with ${errorName}, raised by Delegatable rather than by the app.`);
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
  if (session) return sessionError(session.errorName, context);

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

function sessionError(errorName: string, ctx: RevertContext): InterludeError {
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
      return new DelegatableError(errorName);
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
    `to it yet and a grant naming the new epoch looks stale from where it stands. It clears ` +
    `when the delegation is reopened; until then the old grant's expiry is what bounds it.`
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
