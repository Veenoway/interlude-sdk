/**
 * `packages/contracts/src/examples/Players.sol`, as a frontend would hold it.
 *
 * The whole surface: one function that moves the caller's own square, one view, and the app's
 * own revert. Nothing here mentions sessions, because the app does not: `move` keeps its
 * signature and its selector, and the only edit session keys cost it is `_actor()` where
 * `msg.sender` would have gone.
 */
export const playersAbi = [
  {
    type: "function",
    name: "move",
    stateMutability: "nonpayable",
    inputs: [{ name: "steps", type: "uint256" }],
    outputs: [{ name: "square", type: "uint256" }],
  },
  {
    type: "function",
    name: "squareOf",
    stateMutability: "view",
    inputs: [{ name: "player", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "squareSlot",
    stateMutability: "pure",
    inputs: [{ name: "player", type: "address" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "error",
    name: "TooFar",
    inputs: [
      { name: "steps", type: "uint256" },
      { name: "max", type: "uint256" },
    ],
  },
] as const;
