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
    event ResolutionVoted(
        address indexed app,
        bytes32 indexed partition,
        address indexed voter,
        bytes32 claimedRoot,
        bool fraudConfirmed,
        uint8 votesFor,
        uint8 threshold
    );
    event CommitteeSet(address indexed validator, address[] members, uint8 threshold);
    event Bisected(
        address indexed app,
        bytes32 indexed partition,
        uint32 start,
        uint32 end,
        uint32 mid,
        bytes32 midRoot
    );
    event BisectionPicked(
        address indexed app, bytes32 indexed partition, uint32 start, uint32 end, bool goLeft
    );
    event StepProven(address indexed app, bytes32 indexed partition, uint32 index, bytes32 endRoot);
    event StepCountered(
        address indexed app, bytes32 indexed partition, uint32 index, bytes32 counterRoot
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

    /// @dev The hub told an app its lock is released, or asked it to undo a batch, and the app
    ///      refused. The hub finishes its own transition regardless: an app that reverts on the
    ///      way out would otherwise hold the validator's stake and capacity hostage. The app is
    ///      always given the full callback budget first, so an honest app never lands here
    ///      because somebody sent the transaction with too little gas.
    event AppCallbackFailed(address indexed app, bytes32 indexed partition, bytes4 selector);
    /// @dev A dismissed challenge gave the time it held the session frozen back to the
    ///      challenge window, so squatting the one dispute slot never runs the window down.
    event StakeUnlockExtended(address indexed app, bytes32 indexed partition, uint64 stakeUnlockAt);
    /// @dev A bisection clock ran out. `loser` is the party whose turn it was: the challenger
    ///      in `AwaitPick` / `AwaitCounter`, the validator in `AwaitMid` / `AwaitProve`.
    event MoveTimedOut(
        address indexed app,
        bytes32 indexed partition,
        Types.BisectPhase phase,
        address indexed loser
    );
    /// @dev A challenger that lost its dispute forfeits its bond, and the bond is burned rather
    ///      than paid to the validator: a validator that profits from challenges against itself
    ///      can squat the dispute slot with an accomplice for free.
    event ChallengeBondForfeited(
        address indexed app, bytes32 indexed partition, address indexed challenger, uint256 amount
    );
    /// @dev A fraud verdict is in and the unwind is paged: batches `stopBatch..nextBatch` still
    ///      have to be reverted with `continueUnwind` before the slash pays out.
    event UnwindPending(
        address indexed app, bytes32 indexed partition, uint256 nextBatch, uint256 stopBatch
    );
    /// @dev `ValidatorSlashed` without the context a watcher needs to tie it to a dispute.
    ///      Kept alongside rather than replacing it, so existing listeners still match.
    event DelegationSlashed(
        address indexed app,
        bytes32 indexed partition,
        address indexed validator,
        address challenger,
        uint256 batchIndex,
        uint256 stake
    );

    // --- governance (v1 runs a curated validator set) ---
    function allowValidator(address validator, bool allowed) external;
    function allowResolver(address resolver, bool allowed) external;
    function setDefaultValidator(address validator) external;

    // --- validators (bond once, publish terms once, serve many delegations) ---
    function register(Types.Terms calldata terms) external payable;
    function setTerms(Types.Terms calldata terms) external;
    function setCommittee(address[] calldata members, uint8 threshold) external;
    function depositBond() external payable;
    function withdrawBond(uint256 amount) external;
    function bondOf(address validator) external view returns (uint256 bond, uint256 reserved);
    function termsOf(address validator) external view returns (Types.Terms memory);
    function committeeOf(address validator)
        external
        view
        returns (address[] memory members, uint8 threshold);
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

    /// @notice The owner ends the session. Rollup-style: the app stays locked on the base
    ///         chain, and the stake reserved, until the challenge window has passed and anyone
    ///         calls `releaseStake`. Nothing a later fraud verdict rewinds can have been built on.
    function closeDelegation(bytes32 partition) external;

    /// @notice The validator steps down. The same exit as `closeDelegation`: a validator that
    ///         could unlock the app in the block it resigns could let users withdraw against a
    ///         fraud it committed a block earlier.
    function resignDelegation(address app, bytes32 partition) external;

    // --- called by anyone ---
    /// @param log the fold `batch.txRoot` commits to (hash, block, clock).
    ///        Required: `hashTxLog(log)` must equal the root.
    /// @param raws the EIP-2718 bytes each `log[i].txHash` is keccak of. Same length as
    ///        `log`. Calldata is the publication; they are not re-emitted in `BatchLog`.
    function commit(
        Types.Batch calldata batch,
        Types.SlotDiff[] calldata diffs,
        Types.TxEntry[] calldata log,
        bytes[] calldata raws,
        bytes calldata sig
    ) external;

    /// @notice End a session that stopped honouring its own terms: its lease (`expiresAt`) is
    ///         over, or it has gone longer than `maxBatchInterval` (plus a short grace) without
    ///         a commit. A live node sends empty heartbeat commits, so idle users do not make it
    ///         killable; a dead node does.
    function forceClose(address app, bytes32 partition) external;

    /// @notice After the challenge window of an exit (extended by any time a dismissed
    ///         dispute held it frozen): free the stake and unlock the app. Anyone may call it,
    ///         including a user waiting to withdraw, and it costs the same however many slots
    ///         the session wrote. The app's unlock callback cannot make it revert.
    function releaseStake(address app, bytes32 partition) external;

    /// @notice Dispute a batch by naming the state root replaying it actually produces.
    /// @dev The claim cannot be checked by the hub, which has the signed bytes from `commit`
    ///      but cannot execute them. It is required anyway: it makes the challenger say
    ///      something falsifiable, and it is what the resolver must answer.
    ///      `interlude-watcher` prints the value to pass here. The validator and the judges of
    ///      the session cannot challenge it: nobody may sit on both sides of a dispute.
    function challenge(address app, bytes32 partition, uint256 batchIndex, bytes32 claimedRoot)
        external
        payable;

    /// @param claimedRoot the claim being ruled on, which must be the one under dispute
    /// @param unwind diffs of each batch from the last commit back towards the disputed one,
    ///        newest first. When a fraud vote settles the dispute this may be the whole list or
    ///        any newest-first prefix of it (even empty); the rest is paged in with
    ///        `continueUnwind`. Empty on a vote that does not yet reach the threshold, and
    ///        empty on dismiss.
    function resolveChallenge(
        address app,
        bytes32 partition,
        bytes32 claimedRoot,
        bool fraudConfirmed,
        Types.SlotDiff[][] calldata unwind
    ) external;

    /// @dev The four dispute moves each run on their own clock: a move must land by
    ///      `moveDeadlineOf(app, partition)` or it reverts `MoveExpired`, and every accepted
    ///      move restarts the clock for the other side at `now + resolutionWindow`.
    function bisect(address app, bytes32 partition, bytes32 midRoot) external;
    function pick(address app, bytes32 partition, bool goLeft) external;
    function proveStep(
        address app,
        bytes32 partition,
        Types.SlotDiff[] calldata prefix,
        Types.SlotDiff[] calldata step
    ) external;
    function counterStep(
        address app,
        bytes32 partition,
        Types.SlotDiff[] calldata prefix,
        Types.SlotDiff[] calldata step
    ) external;
    /// @notice The validator's clock ran out in `AwaitMid` / `AwaitProve`: slash and unwind.
    /// @param unwind a newest-first prefix of the batches to revert, as for
    ///        `resolveChallenge`; the rest is paged in with `continueUnwind`.
    function timeoutBisection(address app, bytes32 partition, Types.SlotDiff[][] calldata unwind)
        external;
    function bisectionOf(address app, bytes32 partition)
        external
        view
        returns (Types.BisectGame memory);

    /// @notice Until when the party whose turn it is may still move in the open fraud dispute.
    /// @dev Every move (`bisect`, `pick`, `proveStep`, `counterStep`) must land at or before
    ///      this second and restarts the clock for the other side at `now + resolutionWindow`;
    ///      a move after it reverts `MoveExpired`. Whose turn it is follows from
    ///      `bisectionOf(...).phase`: the validator's in `AwaitMid` / `AwaitProve` (after the
    ///      deadline, `timeoutBisection` slashes it), the challenger's in `AwaitPick` /
    ///      `AwaitCounter` (after the deadline, `timeoutChallenge` burns its bond), and the
    ///      judges' in `Vote` (after the deadline, `timeoutChallenge` ends the session without
    ///      a verdict). Equal to `challengeOf(...).deadline` while a fraud dispute is open.
    /// @return deadline last second (inclusive) the current mover may act; zero when no
    ///         fraud dispute is open, or once its verdict is being unwound
    function moveDeadlineOf(address app, bytes32 partition) external view returns (uint64 deadline);

    /// @notice Revert the next newest-first slice of a convicted session's batches.
    /// @dev Permissionless. After a fraud verdict the unwind is paged so no single transaction
    ///      has to carry every batch since the disputed one; each entry is checked against the
    ///      fold the hub stored at commit. The slash pays out, the stake is taken and the app is
    ///      unlocked in the call that reverts the disputed batch itself.
    function continueUnwind(address app, bytes32 partition, Types.SlotDiff[][] calldata unwind)
        external;

    /// @notice Whether a convicted session still has batches to unwind, and which.
    /// @return pending true between the verdict and the last page
    /// @return nextBatch newest batch still to revert (the next `unwind[0]`)
    /// @return stopBatch the disputed batch, the last one to revert
    function unwindStatusOf(address app, bytes32 partition)
        external
        view
        returns (bool pending, uint256 nextBatch, uint256 stopBatch);
    function batchTxCount(address app, bytes32 partition, uint256 batchIndex)
        external
        view
        returns (uint32);

    function sessionCommittee(address app, bytes32 partition)
        external
        view
        returns (address[] memory members, uint8 threshold);

    function resolutionVote(address app, bytes32 partition, address voter)
        external
        view
        returns (uint8);

    function resolutionTally(address app, bytes32 partition)
        external
        view
        returns (uint8 fraud, uint8 dismiss);

    /// @notice A clock ran out on a turn that was not the validator's. `AwaitPick` /
    ///         `AwaitCounter`: the challenger walked away, its bond is burned and the session
    ///         resumes. `Vote`: the judges never answered; the challenger is refunded less
    ///         `timeoutPenaltyBps` and the session exits the ordinary way (locked until
    ///         `releaseStake`). On the validator's turn this reverts `GameNotReady`; that
    ///         timeout is `timeoutBisection`.
    function timeoutChallenge(address app, bytes32 partition) external;

    /// @notice Dispute a batch whose transactions the node will not serve.
    /// @dev Refused (`LogPublishedAtCommit`) for every batch this hub accepted: `commit` takes
    ///      the log and the raw transactions as calldata and checks them against `txRoot`, so
    ///      nothing a validator commits can be withheld. Kept, with `serveBatchLog` and
    ///      `timeoutAvailability`, so the ABI does not move.
    function challengeAvailability(address app, bytes32 partition, uint256 batchIndex)
        external
        payable;

    /// @notice Post the transactions of the disputed batch. Anyone who has them.
    /// @dev Unreachable while `challengeAvailability` refuses every batch; bounded by the
    ///      dispute's deadline anyway.
    function serveBatchLog(address app, bytes32 partition, Types.TxEntry[] calldata entries)
        external;

    /// @notice The window closed and nobody posted the log. Slash the validator and unwind.
    /// @dev Unreachable while `challengeAvailability` refuses every batch.
    function timeoutAvailability(address app, bytes32 partition, Types.SlotDiff[][] calldata unwind)
        external;

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

    /// @notice Merkle root of this batch's post-state. `commit` requires `batch.stateRoot`
    ///         to equal this. Empty is zero.
    function hashOverlay(Types.SlotDiff[] calldata diffs) external pure returns (bytes32);

    /// @notice Last committed value for `slot` in this session's overlay, if the hub has one.
    function overlayOf(address app, bytes32 partition, bytes32 slot)
        external
        view
        returns (bytes32 value, bool present);
}
