// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title DelegatedLayout
/// @notice The app-side bookkeeping shared by `Delegatable` and the `Delegated` types.
/// @dev Lives in a namespaced region the hub refuses to delegate, so a validator can never
///      rewrite the owner, the locks or the registry that decides what is locked.
///
///      Internal library functions are inlined into the app, so `layout()` reads the app's
///      own storage. That is what lets the typed wrappers enforce the guard themselves.
library DelegatedLayout {
    bytes32 internal constant NS = keccak256("interlude.delegatable.storage");
    uint256 internal constant NS_SIZE = 16;

    /// @dev Where `Delegatable` records the session a call is running under: the end user it
    ///      acts for, and the function the grant admitted it through.
    ///
    ///      It is held in *transient* storage, which is a separate address space, so it could
    ///      have taken any number without colliding with `Layout`. Taking one inside the
    ///      reserved region anyway costs nothing and means `isReserved` already refuses it:
    ///      the slot can never be delegated, and a committed diff naming it is rejected at
    ///      both ends. An actor a validator could write would be an actor it could impersonate.
    ///
    ///      The last slot of the region, so growing `Layout` can never reach it.
    bytes32 internal constant SESSION_SLOT = bytes32(uint256(NS) + NS_SIZE - 1);

    /// @dev How a registered variable maps to a partition.
    ///      `PerKeyMapping` is the one that makes rooms and per-user state work: the key is
    ///      the partition, so `pot[42]` and `pot[43]` are delegated independently.
    enum Kind {
        None,
        GlobalScalar,
        GlobalMapping,
        PerKeyMapping
    }

    /// @param minStake the smallest stake this app will let a validator hold it for. The hub
    ///        refuses a delegation whose terms fall below it. Zero means the app takes whatever
    ///        the validator has chosen to post, which is only reasonable for state that is not
    ///        worth stealing: the stake is what a validator forfeits for cheating, so an app
    ///        holding more value than that makes fraud profitable arithmetic.
    struct Layout {
        address owner;
        bool initialized;
        uint256 baseChainId;
        mapping(bytes32 => bool) locked;
        mapping(bytes32 => Kind) kind;
        bytes32[] globalSlots;
        bytes32[] globalMappingBases;
        bytes32[] perKeyBases;
        uint256 minStake;
    }

    error DelegatedWritesDisabled();
    error NotRegistered();

    /// @notice Emitted on the ephemeral chain only, naming the mapping entry a write touched.
    /// @dev A commit names the slots it changed. For a mapping entry that slot is
    ///      `keccak256(abi.encode(key, base))`, and the hub re-derives it to check the write
    ///      belongs to a delegated mapping — which means the node has to supply the key, and a
    ///      hash cannot be inverted to recover one.
    ///
    ///      The app is the only party that ever holds both halves, right here at the write. So
    ///      it says so, instead of leaving the node to guess from calldata and silently miss
    ///      any key computed rather than passed in.
    ///
    ///      Never emitted on the base chain: there the write is either guarded or reverted, and
    ///      nobody is watching. Gas is free on the ephemeral side, so this costs Monad nothing.
    event DelegatedMappingWrite(bytes32 indexed base, bytes32 key);

    function layout() internal pure returns (Layout storage l) {
        bytes32 slot = NS;
        assembly {
            l.slot := slot
        }
    }

    function isReserved(bytes32 slot) internal pure returns (bool) {
        uint256 base = uint256(NS);
        uint256 s = uint256(slot);
        return s >= base && s < base + NS_SIZE;
    }

    /// @notice The guard. Called by every write in `Delegated`, so it cannot be forgotten.
    /// @param base the variable's own slot (a scalar's slot, or a mapping's base slot)
    /// @param key the mapping key, ignored for scalars and global mappings
    function assertWritable(bytes32 base, bytes32 key) internal view {
        Layout storage l = layout();
        // On the ephemeral chain there is nothing to protect: this is the hot path.
        if (block.chainid != l.baseChainId) return;

        Kind k = l.kind[base];
        if (k == Kind.None) revert NotRegistered();

        bytes32 partition = k == Kind.PerKeyMapping ? key : bytes32(0);
        if (l.locked[partition]) revert DelegatedWritesDisabled();
    }

    /// @notice The guard for a mapping entry, which also announces the key off-chain.
    /// @dev Same single `SLOAD` as `assertWritable`, so the base chain pays nothing extra: the
    ///      announcement happens on the branch the base chain never takes.
    function assertWritableMapping(bytes32 base, bytes32 key) internal {
        Layout storage l = layout();
        if (block.chainid != l.baseChainId) {
            // Ephemeral. There is no lock to apply here, but the node cannot commit this write
            // without knowing which key produced the slot.
            emit DelegatedMappingWrite(base, key);
            return;
        }

        Kind k = l.kind[base];
        if (k == Kind.None) revert NotRegistered();

        bytes32 partition = k == Kind.PerKeyMapping ? key : bytes32(0);
        if (l.locked[partition]) revert DelegatedWritesDisabled();
    }

    function partitionOf(bytes32 base, bytes32 key) internal view returns (bytes32) {
        return layout().kind[base] == Kind.PerKeyMapping ? key : bytes32(0);
    }
}
