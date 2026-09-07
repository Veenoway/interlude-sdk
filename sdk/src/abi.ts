/**
 * The slices of `Delegatable` and `InterludeHub` the SDK talks to.
 *
 * Written out here rather than imported from a Foundry artifact so that installing the SDK does
 * not drag a build of the contracts along with it, and so a frontend bundles four fragments
 * instead of a hundred.
 */

/** The grant tuple, as `withSession` takes it in calldata. */
const sessionGrantComponents = [
  { name: "granter", type: "address" },
  { name: "sessionKey", type: "address" },
  { name: "expiry", type: "uint64" },
  { name: "epoch", type: "uint64" },
  { name: "anyFunction", type: "bool" },
  { name: "selectors", type: "bytes4[]" },
] as const;

/**
 * Every named revert an app inherits from `Delegatable` and `Session`.
 *
 * Concatenated onto the app's own ABI before decoding a revert, because a hand-written ABI
 * naming only the app's functions would leave the session machinery's failures undecodable.
 */
export const delegatableErrorsAbi = [
  { type: "error", name: "OnlyOwner", inputs: [] },
  { type: "error", name: "OnlyHub", inputs: [] },
  { type: "error", name: "OnlyBaseChain", inputs: [] },
  { type: "error", name: "DelegatedWritesDisabled", inputs: [] },
  { type: "error", name: "OldValueMismatch", inputs: [] },
  { type: "error", name: "ReservedSlot", inputs: [] },
  { type: "error", name: "AlreadyRegistered", inputs: [] },
  { type: "error", name: "AlreadyInitialized", inputs: [] },
  { type: "error", name: "NotInitialized", inputs: [] },
  { type: "error", name: "NotRegistered", inputs: [] },
  { type: "error", name: "MalformedSessionCall", inputs: [] },
  { type: "error", name: "PrivilegedSelector", inputs: [] },
  { type: "error", name: "SessionAlreadyOpen", inputs: [] },
  { type: "error", name: "SessionGranterIsZero", inputs: [] },
  { type: "error", name: "SessionKeyIsZero", inputs: [] },
  { type: "error", name: "WrongSessionKey", inputs: [] },
  { type: "error", name: "SessionExpired", inputs: [] },
  { type: "error", name: "EmptySessionScope", inputs: [] },
  { type: "error", name: "SelectorOutOfSessionScope", inputs: [] },
  { type: "error", name: "SessionEpochStale", inputs: [] },
  { type: "error", name: "SessionNotSignedByGranter", inputs: [] },
  { type: "error", name: "NoActor", inputs: [] },
  { type: "error", name: "BadSessionSignature", inputs: [] },
  { type: "error", name: "MalleableSessionSignature", inputs: [] },
] as const;

export const delegatableAbi = [
  {
    type: "function",
    name: "withSession",
    stateMutability: "nonpayable",
    inputs: [
      { name: "g", type: "tuple", components: sessionGrantComponents },
      { name: "sig", type: "bytes" },
      { name: "call", type: "bytes" },
    ],
    outputs: [{ name: "result", type: "bytes" }],
  },
  {
    type: "function",
    name: "sessionDigest",
    stateMutability: "view",
    inputs: [{ name: "g", type: "tuple", components: sessionGrantComponents }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "hub",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "isPartitionLocked",
    stateMutability: "view",
    inputs: [{ name: "partition", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "delegateAll",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "delegateKey",
    stateMutability: "payable",
    inputs: [{ name: "key", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "undelegate",
    stateMutability: "nonpayable",
    inputs: [{ name: "partition", type: "bytes32" }],
    outputs: [],
  },
  ...delegatableErrorsAbi,
] as const;

export const hubAbi = [
  {
    type: "function",
    name: "sessionEpochOf",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "bumpSessionEpoch",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "epoch", type: "uint256" }],
  },
  {
    type: "function",
    name: "isPartitionDelegated",
    stateMutability: "view",
    inputs: [
      { name: "app", type: "address" },
      { name: "partition", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/** `bytes32(0)`: the partition covering a whole contract. */
export const GLOBAL_PARTITION =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
