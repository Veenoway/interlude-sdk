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
 * Every named revert an app inherits: `Delegatable`'s own, and those of the libraries it builds
 * on (`Session`, which checks a grant's signature, and `DelegatedLayout`, the write guard every
 * `Delegated` write runs).
 *
 * Concatenated onto the app's own ABI before decoding a revert, because a hand-written ABI
 * naming only the app's functions would leave the session machinery's failures undecodable.
 * `test/abi.test.ts` derives this list from the contracts' sources, and from their compiled
 * artifacts when there are some, so it cannot drift from what the contracts declare.
 */
export const delegatableErrorsAbi = [
  // Delegatable, in the order it declares them.
  { type: "error", name: "OnlyOwner", inputs: [] },
  { type: "error", name: "OnlyHub", inputs: [] },
  { type: "error", name: "OnlyBaseChain", inputs: [] },
  { type: "error", name: "DelegatedWritesDisabled", inputs: [] },
  { type: "error", name: "OldValueMismatch", inputs: [] },
  { type: "error", name: "ReservedSlot", inputs: [] },
  { type: "error", name: "AlreadyRegistered", inputs: [] },
  { type: "error", name: "AlreadyInitialized", inputs: [] },
  { type: "error", name: "NotInitialized", inputs: [] },
  { type: "error", name: "KeyIsGlobalPartition", inputs: [] },
  { type: "error", name: "TermsRejected", inputs: [{ name: "validator", type: "address" }] },
  { type: "error", name: "NotPendingOwner", inputs: [] },
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
  // Session: a grant signature it cannot accept, malformed or with a high s.
  { type: "error", name: "BadSessionSignature", inputs: [] },
  { type: "error", name: "MalleableSessionSignature", inputs: [] },
  // DelegatedLayout: a `Delegated` write, on the base chain, to a variable the app never
  // registered. Not in Delegatable's own ABI, since only the app's writes reach it, but in that
  // of every app that writes one. The guard's other error, `DelegatedWritesDisabled`, is the
  // same selector as Delegatable's, above.
  { type: "error", name: "NotRegistered", inputs: [] },
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
  {
    type: "function",
    name: "releaseStake",
    stateMutability: "nonpayable",
    inputs: [
      { name: "app", type: "address" },
      { name: "partition", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

/** `bytes32(0)`: the partition covering a whole contract. */
export const GLOBAL_PARTITION =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
