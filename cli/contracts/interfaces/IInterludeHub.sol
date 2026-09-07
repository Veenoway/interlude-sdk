// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Types} from "./Types.sol";

interface IInterludeHub {
    event BondDeposited(address indexed validator, uint256 amount);
    event BondWithdrawn(address indexed validator, uint256 amount);
    event DelegationOpened(
        address indexed app, bytes32 indexed partition, address indexed validator, uint256 stake
    );
    /// @dev `txRoot` is in the event so a watcher can follow which inputs each batch claims
    ///      without a call per batch. Following commits is the whole job of one.
    event Committed(
        address indexed app,
        bytes32 indexed partition,
        uint256 batchIndex,
        bytes32 stateRoot,
        bytes32 txRoot
    );
    /// @dev The fold preimage, posted with the commit. Calldata is the publication: anyone
    ///      who can read the chain can reconstruct `txRoot` without asking the node.
    event BatchLog(
        address indexed app,
        bytes32 indexed partition,
        uint256 indexed batchIndex,
        Types.TxEntry[] entries
    );
    event DelegationClosing(address indexed app, bytes32 indexed partition, uint64 stakeUnlockAt);
    event DelegationForceClosed(address indexed app, bytes32 indexed partition, address by);
    event StakeReleased(address indexed app, bytes32 indexed partition, uint256 amount);
    /// @dev Both roots are in the event so the dispute is legible from logs alone: what the
    ///      validator signed, and what the challenger says it should have been. A watcher that
    ///      already replayed the batch can tell at once whether it agrees with the challenger.
    event Challenged(
        address indexed app,
        bytes32 indexed partition,
        uint256 batchIndex,
        address challenger,
        bytes32 publishedRoot,
        bytes32 claimedRoot
    );
    /// @dev Carries the claim so the ruling is on record against a specific number rather than
    ///      against whichever dispute happened to be open.
    event ChallengeResolved(
        address indexed app, bytes32 indexed partition, bytes32 claimedRoot, bool fraudConfirmed
    );
    event ValidatorSlashed(address indexed validator, uint256 amount);
    event ChallengeTimedOut(address indexed app, bytes32 indexed partition);
    event StateUnwound(
        address indexed app, bytes32 indexed partition, uint256 fromBatch, uint256 toBatch
    );
    /// @dev A withheld log, not a wrong answer. The batch has a `txRoot` and nobody has posted
    ///      the transactions that hash to it.
    event AvailabilityChallenged(
        address indexed app, bytes32 indexed partition, uint256 batchIndex, address challenger
    );
    /// @dev Anyone with the log can post it. The bond goes to whoever did, so a watcher that
    ///      kept a copy is paid for putting it on chain.
    event BatchLogServed(
        address indexed app, bytes32 indexed partition, uint256 batchIndex, address servedBy
    );
    event AvailabilityTimedOut(address indexed app, bytes32 indexed partition);
    event PayoutWithdrawn(address indexed to, uint256 amount);
    event SessionEpochBumped(address indexed user, uint256 epoch);

    // --- governance (v1 runs a curated validator set) ---
    function allowValidator(address validator, bool allowed) external;
    function allowResolver(address resolver, bool allowed) external;
    function setDefaultValidator(address validator) external;

    // --- validators (bond once, publish terms once, serve many delegations) ---
    function register(Types.Terms calldata terms) external payable;
    function setTerms(Types.Terms calldata terms) external;
    function depositBond() external payable;
    function withdrawBond(uint256 amount) external;
    function bondOf(address validator) external view returns (uint256 bond, uint256 reserved);
    function termsOf(address validator) external view returns (Types.Terms memory);
    function defaultValidator() external view returns (address);

    // --- called by the app ---
    /// @param validator zero to take the default validator Interlude operates
    /// @param minStake the smallest stake the app will accept being held for; the call reverts
    ///        if the validator's terms offer less. Zero accepts whatever the validator posts.
    function openDelegation(
        bytes32 partition,
        bytes32[] calldata slots,
        bytes32[] calldata mappingBases,
        address validator,
        address beneficiary,
        uint256 minStake
    ) external payable;

    function closeDelegation(bytes32 partition) external;

    function resignDelegation(address app, bytes32 partition) external;

    // --- called by anyone ---
    /// @param log the transactions `batch.txRoot` folds. Required: `hashTxLog(log)` must
    ///        equal the root, so a validator cannot sign a root and withhold the list.
    function commit(
        Types.Batch calldata batch,
        Types.SlotDiff[] calldata diffs,
        Types.TxEntry[] calldata log,
        bytes calldata sig
    ) external;

    /// @notice Liveness escape hatch: the validator went silent past `maxBatchInterval`, or
    ///         the session has run past `maxDelegationDuration` whatever it has committed.
    function forceClose(address app, bytes32 partition) external;

    function releaseStake(address app, bytes32 partition) external;

    /// @notice Dispute a batch by naming the state root replaying it actually produces.
    /// @dev The claim cannot be checked by the hub, which never sees the transactions. It is
    ///      required anyway: it makes the challenger say something falsifiable, and it is what
    ///      the resolver must answer. `interlude-watcher` prints the value to pass here.
    function challenge(address app, bytes32 partition, uint256 batchIndex, bytes32 claimedRoot)
        external
        payable;

    /// @param claimedRoot the claim being ruled on, which must be the one under dispute
    /// @param unwind diffs of each batch from the last commit back to the disputed one.
    ///        Required when `fraudConfirmed` is true; empty otherwise. The hub checks each
    ///        list against the diffs it applied, then writes `oldValue` back.
    function resolveChallenge(
        address app,
        bytes32 partition,
        bytes32 claimedRoot,
        bool fraudConfirmed,
        Types.SlotDiff[][] calldata unwind
    ) external;

    function timeoutChallenge(address app, bytes32 partition) external;

    /// @notice Dispute a batch whose transactions the node will not serve.
    /// @dev The hub cannot fetch the log. It can freeze the session and wait: anyone who has
    ///      the transactions posts them with `serveBatchLog`, and if the window closes empty
    ///      the validator is slashed. A batch with no `txRoot` has nothing to withhold.
    function challengeAvailability(address app, bytes32 partition, uint256 batchIndex)
        external
        payable;

    /// @notice Post the transactions of the disputed batch. Anyone who has them.
    function serveBatchLog(address app, bytes32 partition, Types.TxEntry[] calldata entries)
        external;

    /// @notice The window closed and nobody posted the log. Slash the validator and unwind.
    function timeoutAvailability(
        address app,
        bytes32 partition,
        Types.SlotDiff[][] calldata unwind
    ) external;

    function withdrawPayout() external;

    // --- called by a user, about its own session keys ---

    /// @notice Invalidate every session grant the caller has signed, for every app at once.
    function bumpSessionEpoch() external returns (uint256 epoch);

    /// @notice The epoch a grant from `user` must name to still be live.
    /// @dev Read by `Delegatable.withSession` on both chains. Held here, and not in the app,
    ///      because hub storage is delegatable to nobody: a validator can never write it, so
    ///      the value a node reads at the pinned block is the value the granter last set.
    function sessionEpochOf(address user) external view returns (uint256);

    // --- views ---
    function statusOf(address app, bytes32 partition) external view returns (Types.Status);
    function isPartitionDelegated(address app, bytes32 partition) external view returns (bool);

    /// @notice The narrow surface a node or a replayer reads. See `Types.Session`.
    function sessionOf(address app, bytes32 partition) external view returns (Types.Session memory);

    /// @notice The open dispute in full, so a third party can redo it. See `Types.Challenge`.
    function challengeOf(address app, bytes32 partition)
        external
        view
        returns (Types.Challenge memory);

    /// @notice Fold of the diffs the hub applied for this batch. Independent of `stateRoot`.
    function batchDiffRoot(address app, bytes32 partition, uint256 batchIndex)
        external
        view
        returns (bytes32);

    /// @notice The same fold `commit` stores. Empty is zero.
    function hashDiffs(Types.SlotDiff[] calldata diffs) external pure returns (bytes32);
}
