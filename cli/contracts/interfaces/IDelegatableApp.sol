// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Types} from "./Types.sol";

/// @notice What the hub is allowed to call on an app. Nothing else crosses the boundary.
/// @dev The EVM has no way for one contract to write another's storage, so the app must keep
///      this narrow, hub-only door open. Everything heavy lives in the hub.
interface IDelegatableApp {
    /// @notice Apply committed state diffs. The hub has already checked slot permissions.
    function applyDelegatedDiffs(Types.SlotDiff[] calldata diffs) external;

    /// @notice Undo a batch: each slot must still hold `newValue`, then `oldValue` is written.
    /// @dev Called newest-batch-first after fraud is confirmed, so the chain of `oldValue`s
    ///      walks back to the state from before the disputed batch.
    function revertDelegatedDiffs(Types.SlotDiff[] calldata diffs) external;

    /// @notice Flip the app's local lock so `whenNotDelegated` stays a cheap storage read.
    function onDelegationChanged(bytes32 partition, bool delegated) external;
}
