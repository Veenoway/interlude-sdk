// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Shared types for the ephemeral layer.
library Types {
    /// @notice A delegation covers one partition of one app.
    ///         `bytes32(0)` means "the whole contract".
    bytes32 internal constant GLOBAL = bytes32(0);

    enum Status {
        None,
        Active,
        Exiting,
        Challenged
    }

    /// @notice Why a session is `Challenged`.
    /// @dev Two different questions share the freeze. A fraud challenge names a root and waits
    ///      on a resolver. An availability challenge names a batch and waits on the log: anyone
    ///      who has the transactions can post them, and if nobody does the validator is slashed
    ///      without a judge. Mixing the two exits would let a withheld log hide behind a
    ///      resolver who never answers.
    enum ChallengeKind {
        None,
        Fraud,
        Availability
    }

    /// @notice The EVM rule set a session executes under.
    /// @dev The third thing a replay needs, beside `baseBlock` and `execTimestamp`: those pin
    ///      what the node read and when, and this pins the rules it read them under. Gas costs,
    ///      precompiles and memory pricing all move between hardforks, so a node and a replayer
    ///      that disagree here reach different answers on identical inputs — and a legitimate
    ///      disagreement about the rules would read as fraud.
    ///
    ///      An enum rather than a free integer, so the ABI decoder refuses a value the hub has
    ///      no name for. A validator able to declare rules nobody can identify would be
    ///      answerable to nothing: a replayer that cannot reproduce an execution cannot
    ///      contradict it either.
    enum Spec {
        Unset,
        MonadTen
    }

    /// @param isMapping true if `slot` is `keccak256(abi.encode(key, mappingBase))`.
    struct SlotDiff {
        bytes32 slot;
        bytes32 oldValue;
        bytes32 newValue;
        bool isMapping;
        bytes32 mappingBase;
        bytes32 key;
    }

    /// @notice A validator publishes its terms once; every delegation it takes runs on them.
    /// @dev Apps never negotiate any of this. They pick a validator (or take the default) and
    ///      the hub copies these terms into the delegation. Because a validator sets its own
    ///      terms, nobody can lock its bond on conditions it never agreed to.
    /// @param resolver adjudicates challenges against this validator
    /// @param stakePerDelegation reserved from the shared bond for each delegation
    /// @param challengeBond what a challenger must put at risk
    /// @param maxBatchInterval silence longer than this lets anyone force the session closed
    /// @param maxDelegationDuration how long a session may run before anyone can force it
    ///        closed, whatever it has been committing. `maxBatchInterval` only catches a node
    ///        that stops talking; a node that keeps committing while refusing to serve anybody
    ///        resets that clock forever, so the app stays locked and the only way out is the
    ///        owner. This bounds that, and the hub caps it so a validator cannot pick forever.
    /// @param challengeWindow how long the stake stays locked after a session ends
    /// @param resolutionWindow how long the resolver has to adjudicate
    /// @param delegationFee charged on open, so spamming sessions is not free
    /// @param maxDelegations how many sessions this validator will serve at once
    /// @param timeoutPenaltyBps share of the challenger's bond forfeited if the resolver
    ///        never answers, so stalling a session repeatedly costs money
    /// @param open whether it is accepting new delegations at all
    struct Terms {
        address resolver;
        /// @dev Which EVM rules this validator's software implements. Declared by the validator
        ///      because the validator is what executes; snapshotted into each delegation at
        ///      open, so upgrading it later cannot change the rules a running session began
        ///      under.
        Spec spec;
        uint256 stakePerDelegation;
        uint256 challengeBond;
        uint256 delegationFee;
        uint64 maxBatchInterval;
        uint64 maxDelegationDuration;
        uint64 challengeWindow;
        uint64 resolutionWindow;
        uint32 maxDiffsPerCommit;
        uint32 maxDelegations;
        uint16 timeoutPenaltyBps;
        bool open;
    }

    /// @notice A committed batch. Grouped so the commit call stays inside the stack limit.
    /// @param execTimestamp the timestamp the node executed under. Recorded so a resolver
    ///        replays the batch under exactly the same clock the node used.
    /// @param txRoot binds the batch to the transactions that produced it. `commit` posts the
    ///        entries and checks they fold to this root, so the list is on the chain rather
    ///        than served later from the node's disk. This is what makes the log the validator
    ///        posted the log it signed for.
    struct Batch {
        address app;
        bytes32 partition;
        uint256 batchIndex;
        bytes32 stateRoot;
        bytes32 txRoot;
        uint64 execTimestamp;
    }

    /// @notice One transaction of a batch, as the node executed it.
    /// @dev The hash rather than the signed bytes, because that is all the hub needs to identify
    ///      it and the bytes are self-authenticating: anyone handed them can check they hash to
    ///      this. Keeping calldata small matters — a challenge submits the whole batch.
    /// @param txHash keccak256 of the EIP-2718 encoding, which is the transaction's own hash
    /// @param blockNumber the ephemeral block it ran in
    /// @param execTimestamp the clock it ran under, which is *not* the batch's. Blocks close
    ///        every few milliseconds between two commits, so a transaction that read TIMESTAMP
    ///        is only reproducible from the value it saw rather than the batch's trailing one.
    struct TxEntry {
        bytes32 txHash;
        uint64 blockNumber;
        uint64 execTimestamp;
    }

    /// @notice Everything a node needs to serve a session, or a replayer to re-derive it, and
    ///         nothing else.
    /// @dev Deliberately not the hub's `Delegation`. That struct is internal bookkeeping —
    ///      stakes, bonds, challenge state — and every field added to it used to break the
    ///      node's hand-written ABI mirror. This is the narrow surface off-chain code binds
    ///      to, so the hub's accounting can grow without anybody having to re-mirror it.
    /// @param baseBlock the block every read outside the delegated set must be taken at
    /// @param lastExecTimestamp the clock of the last accepted batch; the next may not go below
    /// @param expiresAt when the session can be force-closed however alive it looks
    struct Session {
        address validator;
        address resolver;
        Status status;
        /// @dev Read by the node at boot and checked against the rules it actually implements.
        ///      Recording it would be worth nothing on its own: the value only binds because
        ///      the node refuses to serve a session whose declared rules are not its own.
        Spec spec;
        uint256 epoch;
        uint256 batchIndex;
        uint64 baseBlock;
        uint64 lastExecTimestamp;
        uint64 lastCommitAt;
        uint64 maxBatchInterval;
        uint64 expiresAt;
        uint32 maxDiffsPerCommit;
    }

    /// @notice An open dispute, in full, so anybody can redo the work behind it.
    /// @dev The hub cannot re-execute the EVM, so it cannot decide which of the two roots below
    ///      is right — that is still a resolver's call. What it can do is refuse to let the
    ///      question be vague. Both numbers are on record before anybody rules, so the
    ///      resolver's answer is reproducible by anyone holding the batch's transactions, and a
    ///      resolver that rules against the arithmetic is visibly doing so.
    /// @param batchIndex the batch under dispute. Its transactions are fixed by
    ///        `batchTxRoot(app, partition, batchIndex)`, so what is being replayed is not in
    ///        question either.
    /// @param publishedRoot what the validator signed for that batch
    /// @param claimedRoot what the challenger says replaying those transactions produces.
    ///        Necessarily different from `publishedRoot` on a fraud challenge. Zero on an
    ///        availability challenge, which disputes the missing log rather than the arithmetic.
    /// @param kind fraud waits on a resolver; availability waits on `serveBatchLog`.
    struct Challenge {
        address challenger;
        uint256 batchIndex;
        bytes32 publishedRoot;
        bytes32 claimedRoot;
        uint256 bond;
        uint64 deadline;
        ChallengeKind kind;
    }

    /// @notice A user's signed permission for a key it does not control to act as it.
    /// @dev Carried in calldata, never registered anywhere. A grant in a registry would be
    ///      state the node has to read, which means state that has to be pinned and kept in
    ///      step with a resolver's replay. A grant in calldata is self-contained: the resolver
    ///      re-verifies the same signature over the same bytes and reaches the same verdict.
    ///
    ///      The app and the chain are bound by the EIP-712 domain rather than by fields here,
    ///      so a grant signed for one deployment cannot be presented to another.
    /// @param granter the end user whose state is at stake, and what `_actor()` returns.
    ///        Not the app's owner: the owner owns the delegation, the granter owns the state.
    /// @param sessionKey the only address allowed to present this grant, and the key that
    ///        signs the ephemeral transactions carrying it
    /// @param expiry unix seconds, exclusive. Short is the point; this is the only bound that
    ///        holds without anybody having to act.
    /// @param epoch the granter's `hub.sessionEpochOf` value at signing time. Bumping it
    ///        invalidates every grant the granter has ever signed, in one transaction.
    /// @param anyFunction a key that may call anything. Explicit, because it is a footgun: a
    ///        grant is meant to say "only `move`", and the wallet prompt should show which.
    /// @param selectors the functions this key may call. Empty with `anyFunction` unset
    ///        authorises nothing and is refused, so an under-filled grant cannot be a wildcard
    ///        by accident.
    struct SessionGrant {
        address granter;
        address sessionKey;
        uint64 expiry;
        uint64 epoch;
        bool anyFunction;
        bytes4[] selectors;
    }
}
