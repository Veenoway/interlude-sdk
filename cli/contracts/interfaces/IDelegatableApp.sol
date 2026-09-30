// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Types} from "./Types.sol";

/// @notice What the hub is allowed to call on an app. Nothing else crosses the boundary.
/// @dev The EVM has no way for one contract to write another's storage, so the app must keep
///      these four hub-only entry points open. Everything heavy lives in the hub.
///
///      Only the calls that let a session *start* or *land state* are strict: the lock at open
///      and `applyDelegatedDiffs` at commit. The calls on the way out (the final unlock and
///      the unwind after a slash) are made with a fixed gas budget and a refusal is logged
///      (`AppCallbackFailed`) rather than obeyed, so an app that reverts cannot keep a
///      validator's stake and capacity locked forever.
interface IDelegatableApp {
    /// @notice Apply committed state diffs. The hub has already checked slot permissions.
    function applyDelegatedDiffs(Types.SlotDiff[] calldata diffs) external;

    /// @notice Undo a batch: write each slot's `oldValue` back.
    /// @dev Called newest-batch-first after fraud is confirmed, possibly over several
    ///      transactions. The hub has already checked the list against the fold it stored.
    ///      The app has stayed locked since the session opened, so nothing but the hub's own
    ///      commits ever wrote these slots and `oldValue` is exactly what was there before.
    function revertDelegatedDiffs(Types.SlotDiff[] calldata diffs) external;

    /// @notice Write `value` into `slot` without checking what is there.
    /// @dev No longer called by the hub. It used to re-assert every overlay slot after a slash
    ///      to cover writes made after undelegate; the app now stays locked until the challenge
    ///      window has passed, so there are no such writes, and re-asserting slots only honest
    ///      batches touched is what let a late slash clobber legitimate state. Kept so the app
    ///      ABI does not move.
    function syncDelegatedSlot(bytes32 slot, bytes32 value) external;

    /// @notice Flip the app's local lock so `whenNotDelegated` stays a cheap storage read.
    /// @dev `true` once, when the session opens. `false` once, when it is fully over: stake
    ///      released after the challenge window, or slash paid out. Never in between, so the
    ///      app cannot be written on the base chain while a dispute could still rewind it.
    function onDelegationChanged(bytes32 partition, bool delegated) external;
}
