// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {DelegatedLayout} from "./DelegatedLayout.sol";

/// @title Delegated
/// @notice Storage handles for state that can be handed to an ephemeral node.
/// @dev Solana transfers account ownership to the delegation program and the runtime then
///      refuses writes from the original program: nothing to remember, nothing to forget.
///      The EVM has no equivalent: storage always belongs to the contract, and any variable
///      it can name, it can write.
///
///      So the app never names one. A handle is a *constant* holding a slot number, not a
///      storage variable, and the value lives at that slot with no Solidity name bound to it.
///      The only way to reach it is through these functions, which carry the guard. Writing
///      past them takes deliberate inline assembly, which is no longer a thing a developer
///      does by accident.
///
///      A first attempt wrapped the value in a struct. That failed: Solidity struct members
///      have no visibility, so `score._value = 42` compiled and skipped the guard entirely.
///
///      Naming slots by hash also removes two whole classes of bug: no collision with the
///      compiler's own slot assignment, and no variable packing. Packing would put two values in
///      one slot, which slot-level delegation cannot express.
library Delegated {
    type Uint256Slot is bytes32;
    type Bytes32Slot is bytes32;
    type AddressSlot is bytes32;
    type MapUint256Slot is bytes32;

    /// @notice Derive a handle from a name. Use a constant: `keccak256("MyGame.score")`.
    function asUint256(bytes32 id) internal pure returns (Uint256Slot) {
        return Uint256Slot.wrap(id);
    }

    function asBytes32(bytes32 id) internal pure returns (Bytes32Slot) {
        return Bytes32Slot.wrap(id);
    }

    function asAddress(bytes32 id) internal pure returns (AddressSlot) {
        return AddressSlot.wrap(id);
    }

    function asMapUint256(bytes32 id) internal pure returns (MapUint256Slot) {
        return MapUint256Slot.wrap(id);
    }

    // --- Uint256 ---------------------------------------------------------

    function get(Uint256Slot h) internal view returns (uint256 v) {
        bytes32 s = Uint256Slot.unwrap(h);
        assembly {
            v := sload(s)
        }
    }

    function set(Uint256Slot h, uint256 v) internal {
        bytes32 s = Uint256Slot.unwrap(h);
        DelegatedLayout.assertWritable(s, bytes32(0));
        assembly {
            sstore(s, v)
        }
    }

    function add(Uint256Slot h, uint256 delta) internal {
        set(h, get(h) + delta);
    }

    function sub(Uint256Slot h, uint256 delta) internal {
        set(h, get(h) - delta);
    }

    // --- Bytes32 / Address -----------------------------------------------

    function get(Bytes32Slot h) internal view returns (bytes32 v) {
        bytes32 s = Bytes32Slot.unwrap(h);
        assembly {
            v := sload(s)
        }
    }

    function set(Bytes32Slot h, bytes32 v) internal {
        bytes32 s = Bytes32Slot.unwrap(h);
        DelegatedLayout.assertWritable(s, bytes32(0));
        assembly {
            sstore(s, v)
        }
    }

    function get(AddressSlot h) internal view returns (address v) {
        bytes32 s = AddressSlot.unwrap(h);
        assembly {
            v := sload(s)
        }
    }

    function set(AddressSlot h, address v) internal {
        bytes32 s = AddressSlot.unwrap(h);
        DelegatedLayout.assertWritable(s, bytes32(0));
        assembly {
            sstore(s, v)
        }
    }

    // --- MapUint256 ------------------------------------------------------

    /// @dev Same derivation Solidity uses for `mapping(bytes32 => uint256)`, so the node and
    ///      the hub compute the same slot with no special case.
    function entry(MapUint256Slot h, bytes32 key) internal pure returns (bytes32) {
        return keccak256(abi.encode(key, MapUint256Slot.unwrap(h)));
    }

    function get(MapUint256Slot h, bytes32 key) internal view returns (uint256 v) {
        bytes32 s = entry(h, key);
        assembly {
            v := sload(s)
        }
    }

    function get(MapUint256Slot h, uint256 key) internal view returns (uint256) {
        return get(h, bytes32(key));
    }

    function get(MapUint256Slot h, address key) internal view returns (uint256) {
        return get(h, keyOf(key));
    }

    function set(MapUint256Slot h, bytes32 key, uint256 v) internal {
        DelegatedLayout.assertWritableMapping(MapUint256Slot.unwrap(h), key);
        bytes32 s = entry(h, key);
        assembly {
            sstore(s, v)
        }
    }

    function add(MapUint256Slot h, bytes32 key, uint256 delta) internal {
        set(h, key, get(h, key) + delta);
    }

    function sub(MapUint256Slot h, bytes32 key, uint256 delta) internal {
        set(h, key, get(h, key) - delta);
    }

    function add(MapUint256Slot h, uint256 key, uint256 delta) internal {
        add(h, bytes32(key), delta);
    }

    function add(MapUint256Slot h, address key, uint256 delta) internal {
        add(h, keyOf(key), delta);
    }

    // --- introspection ---------------------------------------------------

    /// @notice True when this value lives on the ephemeral node, so an on-chain read is the
    ///         last committed snapshot rather than the live value.
    function isStale(Uint256Slot) internal view returns (bool) {
        return DelegatedLayout.layout().locked[bytes32(0)];
    }

    function isStale(MapUint256Slot h, bytes32 key) internal view returns (bool) {
        bytes32 base = MapUint256Slot.unwrap(h);
        return DelegatedLayout.layout().locked[DelegatedLayout.partitionOf(base, key)];
    }

    function keyOf(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }
}
