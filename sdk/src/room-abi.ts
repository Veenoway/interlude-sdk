/**
 * The public Room's floor, as a client holds it: `packages/contracts/src/examples/Room.sol`.
 *
 * Exported so the README's snippets and the examples run as written against the public floors
 * (`PUBLIC_DEMO_FLOORS`), without first copying an ABI out of the repository. It is the floor and
 * nothing else: walking, hitting, the reads that show where everyone stands, and every error Room
 * itself declares. Without those errors a wall came back as four bytes (`0x105d8ccf`) instead of
 * `Edge`. The salons (`create`, `enter`, `ready`, `begin`, …) and their events are left out on
 * purpose, to keep what a CommonJS consumer loads small; `apps/demo/lib/room-abi.ts` has them.
 *
 * None of it mentions sessions. The session machinery's own reverts are decoded from
 * `delegatableErrorsAbi` whatever ABI the client was given.
 */
export const roomAbi = [
  {
    type: "function",
    name: "join",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "move",
    stateMutability: "nonpayable",
    inputs: [{ name: "dir", type: "uint8" }],
    outputs: [],
  },
  {
    type: "function",
    name: "jump",
    stateMutability: "nonpayable",
    inputs: [{ name: "dir", type: "uint8" }],
    outputs: [],
  },
  {
    type: "function",
    name: "hit",
    stateMutability: "nonpayable",
    inputs: [{ name: "dir", type: "uint8" }],
    outputs: [],
  },
  {
    type: "function",
    name: "leave",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "where",
    stateMutability: "view",
    inputs: [{ name: "who", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "hearts",
    stateMutability: "view",
    inputs: [{ name: "who", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "scoreOf",
    stateMutability: "view",
    inputs: [{ name: "who", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "lootOf",
    stateMutability: "view",
    inputs: [{ name: "who", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "takenCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "floor",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "who", type: "address[]" },
      { name: "cells", type: "uint256[]" },
      { name: "pts", type: "uint256[]" },
      { name: "hp", type: "uint256[]" },
    ],
  },
  { type: "error", name: "AlreadyIn", inputs: [] },
  { type: "error", name: "NotIn", inputs: [] },
  { type: "error", name: "Full", inputs: [] },
  { type: "error", name: "NoSuchDir", inputs: [] },
  { type: "error", name: "Edge", inputs: [] },
  { type: "error", name: "Occupied", inputs: [] },
  { type: "error", name: "Nobody", inputs: [] },
  { type: "error", name: "BadSeats", inputs: [] },
  { type: "error", name: "Busy", inputs: [] },
  { type: "error", name: "NoLobby", inputs: [] },
  { type: "error", name: "WrongCode", inputs: [] },
  { type: "error", name: "NotInLobby", inputs: [] },
  { type: "error", name: "NotLive", inputs: [] },
  { type: "error", name: "NotReady", inputs: [] },
  { type: "error", name: "TooFew", inputs: [] },
  { type: "error", name: "MatchOn", inputs: [] },
  { type: "error", name: "NoMatch", inputs: [] },
  { type: "error", name: "NotStale", inputs: [] },
] as const;
