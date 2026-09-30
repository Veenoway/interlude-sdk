// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDelegatableApp} from "./interfaces/IDelegatableApp.sol";
import {IInterludeHub} from "./interfaces/IInterludeHub.sol";
import {Types} from "./interfaces/Types.sol";
import {Delegated} from "./libraries/Delegated.sol";
import {DelegatedLayout} from "./libraries/DelegatedLayout.sol";
import {Session} from "./libraries/Session.sol";

/// @title Delegatable
/// @notice The thin half of Interlude: inherit this in your app. All the security logic
///         (bonds, challenges, slashing, sequencing) lives in the hub, not here.
/// @dev Declare delegated state with the `Delegated` types and register it in your
///      constructor. After that:
///
///        - writes carry the guard on their own, so it cannot be forgotten;
///        - `delegateAll()` and `delegateKey(key)` work out the slots themselves.
///
///      Two things have to stay in the app, because the EVM gives no way around them: a
///      contract can only `sstore` its own storage, and only it can `sload` it. So the app
///      performs the writes and checks each diff's expected old value; the hub owns the rest.
///
///      **The hub is not upgradeable, and `hub` below is immutable.** Keeping the security
///      logic in one audited contract means a bug there is fixed once, but fixing it means
///      deploying a new hub, and an app built against the old one has to be redeployed (or,
///      behind a proxy, upgraded to an implementation naming the new hub) to use it. There is
///      no admin switch that repoints or pauses apps: that switch would be a key able to move
///      every app's state.
///
///      **Exits keep the app locked.** After `undelegate` (or any other end of a session) the
///      delegated state stays read-only on the base chain until the challenge window has
///      passed and anyone calls `hub.releaseStake(app, partition)`. A fraud found in that
///      window is rewound exactly; one found after users had already moved funds could not be.
abstract contract Delegatable is IDelegatableApp {
    IInterludeHub public immutable hub;

    error OnlyOwner();
    error OnlyHub();
    error OnlyBaseChain();
    error DelegatedWritesDisabled();
    error OldValueMismatch();
    error ReservedSlot();
    error AlreadyRegistered();
    error AlreadyInitialized();
    error NotInitialized();
    /// @dev `delegateKey(0)` would name partition zero, which is `Types.GLOBAL`: the lock of
    ///      every global variable, not one key's.
    error KeyIsGlobalPartition();
    /// @dev The validator's terms, read in the same transaction the delegation opens in, fall
    ///      outside what `_acceptTerms` allows. Same transaction, so there is no window for the
    ///      validator to change them between the owner's look and the open.
    error TermsRejected(address validator);
    /// @dev Only the address named by `transferOwnership` can complete the hand-over.
    error NotPendingOwner();

    /// @dev Same shape as the ownership events tooling already indexes.
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event SlashBeneficiarySet(address indexed beneficiary);

    /// @dev The inner call is shorter than a selector, so it would land on the fallback and
    ///      there would be nothing for a grant's scope to name.
    error MalformedSessionCall();
    /// @dev The inner call names a function no grant may ever reach. See `_isSessionBlocked`.
    error PrivilegedSelector();
    /// @dev A session is already open on this call stack. Refused rather than stacked, so
    ///      there is at most one actor per stack and no order in which two could be confused.
    error SessionAlreadyOpen();
    error SessionGranterIsZero();
    error SessionKeyIsZero();
    /// @dev The caller is not the key the grant names. A grant is presented by its own key and
    ///      by nobody else, so a leaked grant without its key is inert.
    error WrongSessionKey();
    error SessionExpired();
    /// @dev A grant with no selectors and no wildcard. Refused so that the empty grant, which
    ///      is what a bug or a truncated payload produces, authorises nothing at all.
    error EmptySessionScope();
    /// @dev The call names a function the grant's scope does not cover. Raised by the wrapper
    ///      for the call it was handed, and again by `_actor()` for an external self-call that
    ///      arrived at a different function.
    error SelectorOutOfSessionScope();
    /// @dev The granter has called `hub.bumpSessionEpoch()` since signing.
    error SessionEpochStale();
    /// @dev The signature is well formed but was not made by the granter. Also what a grant
    ///      signed for another app or another chain reverts with: both are bound through the
    ///      EIP-712 domain, so presenting one here simply recovers somebody else.
    error SessionNotSignedByGranter();
    /// @dev `_actor()` had nothing to return. Unreachable through any call the EVM can make,
    ///      and checked anyway because every caller of `_actor()` treats it as an identity.
    error NoActor();

    /// @notice Escape hatch for state held in plain storage rather than a `Delegated` type.
    /// @dev Prefer the typed wrappers. This modifier is only as good as your memory.
    modifier whenNotDelegated(bytes32 partition) {
        DelegatedLayout.Layout storage l = DelegatedLayout.layout();
        if (block.chainid == l.baseChainId && l.locked[partition]) {
            revert DelegatedWritesDisabled();
        }
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != DelegatedLayout.layout().owner) revert OnlyOwner();
        _;
    }

    modifier onlyHub() {
        if (msg.sender != address(hub)) revert OnlyHub();
        if (block.chainid != DelegatedLayout.layout().baseChainId) revert OnlyBaseChain();
        _;
    }

    /// @dev `hub` is immutable, so it lives in the implementation's bytecode and a proxy
    ///      delegatecalling into it reads the same value. That is what we want: the hub is a
    ///      singleton per chain. Everything else is namespaced storage, set by the
    ///      initializer rather than the constructor so proxies work.
    constructor(IInterludeHub hub_) {
        hub = hub_;
        _initDelegatable(msg.sender);
    }

    /// @notice Set owner and base chain. Call this from your initializer if your app sits
    ///         behind a proxy, since a constructor writes the implementation's storage, not
    ///         the proxy's.
    /// @dev Registration is separate and also has to be redone in the initializer: the
    ///      registry lives in storage, so a proxy that skips it can delegate nothing.
    function _initDelegatable(address owner_) internal {
        DelegatedLayout.Layout storage l = DelegatedLayout.layout();
        if (l.initialized) revert AlreadyInitialized();
        l.initialized = true;
        l.owner = owner_;
        l.baseChainId = block.chainid;
        emit OwnershipTransferred(address(0), owner_);
    }

    // --- registration (constructor or initializer) -----------------------

    /// @notice One shared partition for this variable: the whole app moves together.
    function _registerGlobal(Delegated.Uint256Slot h) internal {
        _register(Delegated.Uint256Slot.unwrap(h), DelegatedLayout.Kind.GlobalScalar);
    }

    function _registerGlobal(Delegated.Bytes32Slot h) internal {
        _register(Delegated.Bytes32Slot.unwrap(h), DelegatedLayout.Kind.GlobalScalar);
    }

    function _registerGlobal(Delegated.AddressSlot h) internal {
        _register(Delegated.AddressSlot.unwrap(h), DelegatedLayout.Kind.GlobalScalar);
    }

    /// @notice The whole mapping moves as one partition. Use for shared books and pools.
    function _registerGlobalMapping(Delegated.MapUint256Slot h) internal {
        _register(Delegated.MapUint256Slot.unwrap(h), DelegatedLayout.Kind.GlobalMapping);
    }

    /// @notice Each key is its own partition: room 42 can run on a node while 43 stays here.
    ///         Also how per-user delegation works, with the user address as the key.
    function _registerPerKey(Delegated.MapUint256Slot h) internal {
        _register(Delegated.MapUint256Slot.unwrap(h), DelegatedLayout.Kind.PerKeyMapping);
    }

    /// @notice The smallest stake this app will be held for. Declared beside the state it
    ///         protects, because it is the same question asked twice: what is here, and what is
    ///         it worth.
    /// @dev The hub refuses to open a delegation whose validator posts less, and the figure is
    ///      frozen into the delegation, so a validator cannot lower it afterwards.
    ///
    ///      Left at zero, an app accepts whatever the validator chose. That is the default and
    ///      it is only safe for state nobody would pay to corrupt. The stake is the entire
    ///      downside of cheating: an app guarding more value than the stake has made fraud a
    ///      calculation rather than a risk, and no amount of challenge machinery fixes that.
    function _requireStake(uint256 amount) internal {
        DelegatedLayout.layout().minStake = amount;
    }

    function _register(bytes32 slot, DelegatedLayout.Kind kind) private {
        if (DelegatedLayout.isReserved(slot)) revert ReservedSlot();
        DelegatedLayout.Layout storage l = DelegatedLayout.layout();
        // Registering before init would file slots under a zero base chain, which disables
        // the write guard everywhere.
        if (!l.initialized) revert NotInitialized();
        if (l.kind[slot] != DelegatedLayout.Kind.None) revert AlreadyRegistered();
        l.kind[slot] = kind;

        if (kind == DelegatedLayout.Kind.GlobalScalar) {
            l.globalSlots.push(slot);
        } else if (kind == DelegatedLayout.Kind.GlobalMapping) {
            l.globalMappingBases.push(slot);
        } else {
            l.perKeyBases.push(slot);
        }
    }

    // --- delegation (no slots, no config) --------------------------------

    /// @notice Hand every global variable to the validator Interlude operates.
    /// @dev Payable because a validator may charge a delegation fee; read it from
    ///      `hub.termsOf(validator).delegationFee` and forward it. Anything sent above the fee
    ///      is credited to `slashBeneficiary()` in the hub (`hub.withdrawPayout()`).
    function delegateAll() external payable onlyOwner {
        DelegatedLayout.Layout storage l = DelegatedLayout.layout();
        _open(Types.GLOBAL, l.globalSlots, l.globalMappingBases, address(0));
    }

    /// @notice Hand one instance, one room or one user, to the node and leave the rest here.
    /// @dev Delegates the exact derived slots for `key`, never the whole mapping, so the
    ///      validator gets no rights over anybody else's entry. Key zero is refused: it is the
    ///      global partition's lock, not a key's.
    function delegateKey(bytes32 key) external payable onlyOwner {
        if (key == Types.GLOBAL) revert KeyIsGlobalPartition();
        _open(key, _slotsForKey(key), new bytes32[](0), address(0));
    }

    function delegateAllTo(address validator) external payable onlyOwner {
        DelegatedLayout.Layout storage l = DelegatedLayout.layout();
        _open(Types.GLOBAL, l.globalSlots, l.globalMappingBases, validator);
    }

    function delegateKeyTo(bytes32 key, address validator) external payable onlyOwner {
        if (key == Types.GLOBAL) revert KeyIsGlobalPartition();
        _open(key, _slotsForKey(key), new bytes32[](0), validator);
    }

    /// @notice End the session. The state stays locked here until the challenge window has
    ///         passed and `hub.releaseStake(address(this), partition)` has run; anyone may
    ///         call that, so a user waiting to withdraw does not depend on the owner.
    function undelegate(bytes32 partition) external onlyOwner {
        hub.closeDelegation(partition);
    }

    /// @notice Raw delegation for state that is not held in a `Delegated` type.
    /// @dev Unsafe by design: nothing checks that the slots you name are actually guarded.
    ///      Only reach for this if the typed wrappers genuinely cannot express your layout.
    function delegateRaw(
        bytes32 partition,
        bytes32[] calldata slots,
        bytes32[] calldata mappingBases,
        address validator
    ) external payable onlyOwner {
        _open(partition, slots, mappingBases, validator);
    }

    /// @dev Every delegation goes through here, so every one checks the terms it is about to
    ///      be held to in the same transaction that opens it. A validator that rewrote its
    ///      terms between the owner reading them and this call gets refused here rather than
    ///      silently accepted.
    function _open(
        bytes32 partition,
        bytes32[] memory slots,
        bytes32[] memory mappingBases,
        address validator
    ) private {
        address v = validator == address(0) ? hub.defaultValidator() : validator;
        if (v != address(0)) {
            Types.Terms memory t = hub.termsOf(v);
            // A validator that never published terms is the hub's to refuse, with its own
            // error; there is nothing here to judge.
            if (t.resolver != address(0) && !_acceptTerms(t)) revert TermsRejected(v);
        }
        hub.openDelegation{value: msg.value}(
            partition,
            slots,
            mappingBases,
            validator,
            slashBeneficiary(),
            DelegatedLayout.layout().minStake
        );
    }

    /// @notice Whether this app will be held to `t`. Override to demand more (or less) than
    ///         the defaults, and call `super` to keep them.
    /// @dev The hub already bounds every term to protocol limits (a bond that is neither zero
    ///      nor ten times the stake, windows that can neither lapse at once nor overflow).
    ///      These defaults are the app's side of the bargain, set where the protocol floor is
    ///      too thin for state worth protecting:
    ///
    ///        - `challengeWindow` of at least an hour: this is how long a watcher has, after
    ///          the session ends, to find fraud before the stake walks;
    ///        - `resolutionWindow` of at least fifteen minutes: every dispute move runs on it,
    ///          and a watcher that cannot answer in time loses a dispute it was right about.
    ///
    ///      `stakePerDelegation` is not here: `_requireStake` states that floor and the hub
    ///      enforces it. Neither is the fee, which is bounded by what the owner sends.
    function _acceptTerms(Types.Terms memory t) internal view virtual returns (bool) {
        return t.challengeWindow >= ACCEPT_MIN_CHALLENGE_WINDOW
            && t.resolutionWindow >= ACCEPT_MIN_RESOLUTION_WINDOW;
    }

    uint64 private constant ACCEPT_MIN_CHALLENGE_WINDOW = 1 hours;
    uint64 private constant ACCEPT_MIN_RESOLUTION_WINDOW = 15 minutes;

    // --- ownership --------------------------------------------------------

    /// @notice Name a new owner. Nothing changes until that address calls `acceptOwnership`,
    ///         so a typo cannot hand the app to nobody. Zero cancels a pending hand-over.
    /// @dev Two steps because the owner is the delegation's only controller: it alone can
    ///      `undelegate`, and an app deployed through a factory or a CI key needs a way to end
    ///      up owned by the team that runs it.
    function transferOwnership(address newOwner) external onlyOwner {
        DelegatedLayout.Layout storage l = DelegatedLayout.layout();
        l.pendingOwner = newOwner;
        emit OwnershipTransferStarted(l.owner, newOwner);
    }

    function acceptOwnership() external {
        DelegatedLayout.Layout storage l = DelegatedLayout.layout();
        if (msg.sender != l.pendingOwner || msg.sender == address(0)) revert NotPendingOwner();
        address previous = l.owner;
        l.owner = msg.sender;
        l.pendingOwner = address(0);
        emit OwnershipTransferred(previous, msg.sender);
    }

    function pendingOwner() public view returns (address) {
        return DelegatedLayout.layout().pendingOwner;
    }

    /// @notice Who receives the app's half of a slashed stake (and any fee overpayment).
    ///         The owner unless set otherwise.
    /// @dev Read when a delegation opens and frozen into it, so changing it does not reach a
    ///      live session. Worth setting when the owner is an operator key rather than the
    ///      people the app's users trust: the owner of an app deployed for you may be the very
    ///      party a slash is punishing.
    function slashBeneficiary() public view returns (address) {
        DelegatedLayout.Layout storage l = DelegatedLayout.layout();
        address b = l.slashBeneficiary;
        return b == address(0) ? l.owner : b;
    }

    /// @param beneficiary zero to go back to the owner
    function setSlashBeneficiary(address beneficiary) external onlyOwner {
        DelegatedLayout.layout().slashBeneficiary = beneficiary;
        emit SlashBeneficiarySet(slashBeneficiary());
    }

    function _slotsForKey(bytes32 key) private view returns (bytes32[] memory slots) {
        bytes32[] storage bases = DelegatedLayout.layout().perKeyBases;
        slots = new bytes32[](bases.length);
        for (uint256 i; i < bases.length; ++i) {
            slots[i] = keccak256(abi.encode(key, bases[i]));
        }
    }

    // --- hub callbacks ---------------------------------------------------

    /// @inheritdoc IDelegatableApp
    function applyDelegatedDiffs(Types.SlotDiff[] calldata diffs) external onlyHub {
        for (uint256 i; i < diffs.length; ++i) {
            _applyDiff(diffs[i]);
        }
        _afterCommit(diffs);
    }

    /// @inheritdoc IDelegatableApp
    function revertDelegatedDiffs(Types.SlotDiff[] calldata diffs) external onlyHub {
        uint256 i = diffs.length;
        while (i > 0) {
            unchecked {
                --i;
            }
            _revertDiff(diffs[i]);
        }
    }

    /// @inheritdoc IDelegatableApp
    function syncDelegatedSlot(bytes32 slot, bytes32 value) external onlyHub {
        if (DelegatedLayout.isReserved(slot)) revert ReservedSlot();
        assembly {
            sstore(slot, value)
        }
    }

    /// @inheritdoc IDelegatableApp
    function onDelegationChanged(bytes32 partition, bool delegated) external onlyHub {
        DelegatedLayout.layout().locked[partition] = delegated;
    }

    /// @dev App hook after a batch lands (invariant checks, checkpoints…). Default: no-op.
    function _afterCommit(Types.SlotDiff[] calldata) internal virtual {}

    // --- session keys ----------------------------------------------------

    /// @dev Set in the packed session word when the grant named no particular function, so
    ///      the selector recorded beside the actor is not a fence for anything.
    uint256 private constant SESSION_WILDCARD = 1 << 192;

    /// @notice Run `call` on this contract as `g.granter`, on the authority of `g` and `sig`.
    /// @dev **Inside the wrapped call `msg.sender` is the app itself, not the user.** The call
    ///      is a self-call (`address(this).call`), so any function that trusts `msg.sender` —
    ///      an inherited ERC-20 `transfer`, an `onlyOwner` on an app that owns itself — acts
    ///      with the app's own authority, on the app's own balances. Anyone can sign an
    ///      `anyFunction` grant naming themselves as granter, so that authority is anyone's.
    ///      Read the caller with `_actor()`, never `msg.sender`, in anything a session can
    ///      reach, and keep everything else behind `_isSessionBlocked`. Its defaults refuse
    ///      the delegation and ownership controls, the standard token-moving selectors
    ///      (ERC-20/721/1155, and the ERC-1363, ERC-777, ERC-4626 and burn extensions) and
    ///      the common self-`delegatecall` batchers (`multicall`). They are a list of known
    ///      names, not a proof: only the outer selector is checked, so **any function that
    ///      forwards caller-supplied calldata to `this` — by `call` or `delegatecall` — or
    ///      spends the app's own balance under a name not on that list must be added to it**
    ///      by the app, or the grant reaches whatever that function can reach.
    ///
    ///      The point of the wrapper is that it changes nothing about the app's ABI. The
    ///      developer's functions keep their signatures, their selectors and their existing
    ///      callers; the only edit inside them is `_actor()` where `msg.sender` used to be.
    ///      A direct call with no grant still works, because `_actor()` falls back to
    ///      `msg.sender`. So adding session keys to an app is one identifier per function, and
    ///      a frontend that does not use them never notices.
    ///
    ///      **Which chain id the grant is bound to.** The base chain's, taken from the app's
    ///      own storage, never `block.chainid`. The transaction runs on the ephemeral chain,
    ///      but the ephemeral chain id is a node configuration value: it is not fixed at
    ///      deployment, and the same app served by a second session could be given a different
    ///      one. A user cannot be asked to sign a grant naming an id that means nothing to
    ///      them and might change. The base chain is where the state settles and is recorded
    ///      once, at deployment, so binding to it makes one signature valid on both the fast
    ///      path and the settlement path while still pinning the grant to exactly one
    ///      deployment: two chains cannot share a `(baseChainId, address)` pair, even where
    ///      the same bytecode sits at the same address on both.
    ///
    ///      **No value.** Deliberately not payable. Forwarding value would need a spend limit
    ///      to be worth anything, a spend limit needs a counter of what has been spent, and a
    ///      counter is the state a stateless grant exists to avoid. A session key moves state,
    ///      not money.
    ///
    ///      **Reentrancy.** Only one session may be open per call stack, so a hostile contract
    ///      reached from inside a session call cannot open a second one. It can still call the
    ///      app back directly, and `_actor()` is what makes that harmless.
    /// @param g the grant, signed by the end user
    /// @param sig the granter's EIP-712 signature over `g`
    /// @param call abi-encoded call to one of this contract's own functions
    /// @return result whatever `call` returned, and its revert verbatim if it reverted
    function withSession(Types.SessionGrant calldata g, bytes calldata sig, bytes calldata call)
        external
        returns (bytes memory result)
    {
        if (call.length < 4) revert MalformedSessionCall();
        bytes4 selector = bytes4(call[:4]);
        if (_isSessionBlocked(selector)) revert PrivilegedSelector();
        if (_session() != 0) revert SessionAlreadyOpen();

        _assertGrant(g, sig, selector);
        _openSession(g.granter, selector, g.anyFunction);

        (bool ok, bytes memory ret) = address(this).call(call);

        // Cleared here and not left to the end of the transaction. Transient storage does
        // clear itself then, but `withSession` returning does not end the transaction, and a
        // direct call arriving afterwards must not find an actor still open. On the revert
        // path below the frame unwinds and takes the write with it.
        _closeSession();

        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }

    /// @notice The end user this call is acting for. Write this where `msg.sender` would go.
    /// @dev Three facts have to hold together, and none is enough alone.
    ///
    ///      The recorded actor is only trusted when the call arrived through the wrapper's own
    ///      self-call. Otherwise a session call that touches an untrusted contract, an NFT
    ///      hook, a token callback, would let that contract call the app straight back while
    ///      the actor is still set and spend the granter's state as the granter.
    ///
    ///      It is only trusted for the function the grant was presented for. `this.other()`
    ///      from inside a session call arrives with exactly the sender the wrapper's own call
    ///      does, so the selector is the only thing separating them, and without it a grant
    ///      naming one function would reach every function that one can call on `this`. That
    ///      is authority the same code path does not have off the session: called directly,
    ///      `this.other()` resolves `_actor()` to the contract itself, so an app tested
    ///      without a grant would never show the difference.
    ///
    ///      And with no session open it is `msg.sender`, which is what makes the whole scheme
    ///      opt-in: an app can be written against `_actor()` from day one and behave exactly
    ///      as it would have with `msg.sender` until somebody signs a grant.
    function _actor() internal view returns (address actor) {
        if (msg.sender == address(this)) {
            uint256 session = _session();
            if (session != 0) {
                if (session & SESSION_WILDCARD == 0 && bytes4(uint32(session >> 160)) != msg.sig) {
                    revert SelectorOutOfSessionScope();
                }
                actor = address(uint160(session));
            }
        }
        if (actor == address(0)) actor = msg.sender;
        if (actor == address(0)) revert NoActor();
    }

    /// @notice Selectors the wrapper refuses to reach, whatever a grant's scope says.
    /// @dev Not redundant with the scope. The self-call arrives with `msg.sender ==
    ///      address(this)`, so an app that is its own owner would let a session straight
    ///      through `onlyOwner` and undelegate itself; and a user tricked into signing an
    ///      `anyFunction` grant would otherwise be handing over the delegation controls along
    ///      with the game. A grant should never be able to reach the machinery that decides
    ///      what a grant is worth.
    ///
    ///      The same self-call is why the standard token and ownership selectors are refused
    ///      too. An app that inherits an ERC-20, ERC-721 or ERC-1155 and holds its own tokens
    ///      would otherwise hand them to whoever signs a grant for `transfer`, `approve` or
    ///      `setApprovalForAll`, because inside the call `msg.sender` is the app. Refusing
    ///      them costs an app nothing: a session is for the app's own game functions, written
    ///      against `_actor()`, never for the token plumbing.
    ///
    ///      The token list covers the extensions that move or destroy the caller's balance
    ///      under another name: ERC-1363 `transferAndCall` / `transferFromAndCall` /
    ///      `approveAndCall`, ERC-20/721 `burn` / `burnFrom`, ERC-4626 `deposit` / `mint` /
    ///      `withdraw` / `redeem` (which spend or pay out the app's shares and assets), and
    ///      ERC-777 `send` / `operatorSend` / `burn` / `operatorBurn` / `authorizeOperator`.
    ///
    ///      Batchers are refused for a different reason: only the outer selector is checked
    ///      here. OpenZeppelin's `Multicall` (and Uniswap's deadline and block-hash variants)
    ///      `delegatecall`s `this` with each entry, and a `delegatecall` keeps `msg.sender`, so
    ///      `multicall([transfer(thief, all)])` would run `transfer` as the app while the
    ///      wrapper only ever saw `multicall`. Any other function of the app that forwards
    ///      caller-supplied calldata to itself has the same shape and must be added by the
    ///      app; a name this list does not know is a name it cannot refuse.
    ///
    ///      Override to add your own privileged functions, and return `super` so these stay
    ///      covered. The scope is the user's fence; this is the app's.
    function _isSessionBlocked(bytes4 selector) internal view virtual returns (bool) {
        return _isDelegationControl(selector) || _isOwnershipControl(selector)
            || _isTokenMovement(selector) || _isTokenExtension(selector) || _isSelfBatcher(selector);
    }

    function _isDelegationControl(bytes4 selector) private pure returns (bool) {
        return selector == this.withSession.selector
            || selector == this.applyDelegatedDiffs.selector
            || selector == this.revertDelegatedDiffs.selector
            || selector == this.syncDelegatedSlot.selector
            || selector == this.onDelegationChanged.selector
            || selector == this.delegateAll.selector || selector == this.delegateKey.selector
            || selector == this.delegateAllTo.selector || selector == this.delegateKeyTo.selector
            || selector == this.undelegate.selector || selector == this.delegateRaw.selector;
    }

    function _isOwnershipControl(bytes4 selector) private pure returns (bool) {
        return selector == this.transferOwnership.selector
            || selector == this.acceptOwnership.selector
            || selector == this.setSlashBeneficiary.selector || selector == RENOUNCE_OWNERSHIP;
    }

    /// @dev ERC-20 and ERC-721 share `transferFrom` and `approve`, so one entry covers both.
    function _isTokenMovement(bytes4 selector) private pure returns (bool) {
        return selector == TRANSFER || selector == TRANSFER_FROM || selector == APPROVE
            || selector == INCREASE_ALLOWANCE || selector == DECREASE_ALLOWANCE
            || selector == PERMIT || selector == SET_APPROVAL_FOR_ALL
            || selector == SAFE_TRANSFER_FROM || selector == SAFE_TRANSFER_FROM_WITH_DATA
            || selector == SAFE_TRANSFER_FROM_1155 || selector == SAFE_BATCH_TRANSFER_FROM_1155;
    }

    bytes4 private constant TRANSFER = bytes4(keccak256("transfer(address,uint256)"));
    bytes4 private constant TRANSFER_FROM =
        bytes4(keccak256("transferFrom(address,address,uint256)"));
    bytes4 private constant APPROVE = bytes4(keccak256("approve(address,uint256)"));
    bytes4 private constant INCREASE_ALLOWANCE =
        bytes4(keccak256("increaseAllowance(address,uint256)"));
    bytes4 private constant DECREASE_ALLOWANCE =
        bytes4(keccak256("decreaseAllowance(address,uint256)"));
    bytes4 private constant PERMIT =
        bytes4(keccak256("permit(address,address,uint256,uint256,uint8,bytes32,bytes32)"));
    bytes4 private constant SET_APPROVAL_FOR_ALL =
        bytes4(keccak256("setApprovalForAll(address,bool)"));
    bytes4 private constant SAFE_TRANSFER_FROM =
        bytes4(keccak256("safeTransferFrom(address,address,uint256)"));
    bytes4 private constant SAFE_TRANSFER_FROM_WITH_DATA =
        bytes4(keccak256("safeTransferFrom(address,address,uint256,bytes)"));
    bytes4 private constant SAFE_TRANSFER_FROM_1155 =
        bytes4(keccak256("safeTransferFrom(address,address,uint256,uint256,bytes)"));
    bytes4 private constant SAFE_BATCH_TRANSFER_FROM_1155 =
        bytes4(keccak256("safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)"));
    bytes4 private constant RENOUNCE_OWNERSHIP = bytes4(keccak256("renounceOwnership()"));

    /// @dev ERC-1363, burnable, ERC-4626 and ERC-777: each of these moves, spends or destroys
    ///      the calling account's tokens, and inside a session the calling account is the app.
    function _isTokenExtension(bytes4 selector) private pure returns (bool) {
        return selector == TRANSFER_AND_CALL || selector == TRANSFER_AND_CALL_WITH_DATA
            || selector == TRANSFER_FROM_AND_CALL || selector == TRANSFER_FROM_AND_CALL_WITH_DATA
            || selector == APPROVE_AND_CALL || selector == APPROVE_AND_CALL_WITH_DATA
            || selector == BURN || selector == BURN_FROM || selector == VAULT_DEPOSIT
            || selector == VAULT_MINT || selector == VAULT_WITHDRAW || selector == VAULT_REDEEM
            || selector == SEND_777 || selector == OPERATOR_SEND_777 || selector == BURN_777
            || selector == OPERATOR_BURN_777 || selector == AUTHORIZE_OPERATOR_777;
    }

    /// @dev Functions that run caller-supplied calldata against `this`. See `_isSessionBlocked`.
    function _isSelfBatcher(bytes4 selector) private pure returns (bool) {
        return
            selector == MULTICALL || selector == MULTICALL_DEADLINE
                || selector == MULTICALL_BLOCKHASH;
    }

    bytes4 private constant TRANSFER_AND_CALL =
        bytes4(keccak256("transferAndCall(address,uint256)"));
    bytes4 private constant TRANSFER_AND_CALL_WITH_DATA =
        bytes4(keccak256("transferAndCall(address,uint256,bytes)"));
    bytes4 private constant TRANSFER_FROM_AND_CALL =
        bytes4(keccak256("transferFromAndCall(address,address,uint256)"));
    bytes4 private constant TRANSFER_FROM_AND_CALL_WITH_DATA =
        bytes4(keccak256("transferFromAndCall(address,address,uint256,bytes)"));
    bytes4 private constant APPROVE_AND_CALL = bytes4(keccak256("approveAndCall(address,uint256)"));
    bytes4 private constant APPROVE_AND_CALL_WITH_DATA =
        bytes4(keccak256("approveAndCall(address,uint256,bytes)"));
    bytes4 private constant BURN = bytes4(keccak256("burn(uint256)"));
    bytes4 private constant BURN_FROM = bytes4(keccak256("burnFrom(address,uint256)"));
    bytes4 private constant VAULT_DEPOSIT = bytes4(keccak256("deposit(uint256,address)"));
    bytes4 private constant VAULT_MINT = bytes4(keccak256("mint(uint256,address)"));
    bytes4 private constant VAULT_WITHDRAW = bytes4(keccak256("withdraw(uint256,address,address)"));
    bytes4 private constant VAULT_REDEEM = bytes4(keccak256("redeem(uint256,address,address)"));
    bytes4 private constant SEND_777 = bytes4(keccak256("send(address,uint256,bytes)"));
    bytes4 private constant OPERATOR_SEND_777 =
        bytes4(keccak256("operatorSend(address,address,uint256,bytes,bytes)"));
    bytes4 private constant BURN_777 = bytes4(keccak256("burn(uint256,bytes)"));
    bytes4 private constant OPERATOR_BURN_777 =
        bytes4(keccak256("operatorBurn(address,uint256,bytes,bytes)"));
    bytes4 private constant AUTHORIZE_OPERATOR_777 =
        bytes4(keccak256("authorizeOperator(address)"));
    bytes4 private constant MULTICALL = bytes4(keccak256("multicall(bytes[])"));
    bytes4 private constant MULTICALL_DEADLINE = bytes4(keccak256("multicall(uint256,bytes[])"));
    bytes4 private constant MULTICALL_BLOCKHASH = bytes4(keccak256("multicall(bytes32,bytes[])"));

    /// @notice The digest a granter signs. Exposed so a frontend can check its own EIP-712
    ///         encoding against the contract's rather than discovering a mismatch as a revert.
    function sessionDigest(Types.SessionGrant calldata g) external view returns (bytes32) {
        return Session.digest(g, address(this), DelegatedLayout.layout().baseChainId);
    }

    /// @dev Ordered by what it costs to find out. The signature is checked before the epoch
    ///      because recovery is cheaper than a cold cross-contract read, and every check
    ///      before either of them is arithmetic on calldata.
    function _assertGrant(Types.SessionGrant calldata g, bytes calldata sig, bytes4 selector)
        private
        view
    {
        if (g.granter == address(0)) revert SessionGranterIsZero();
        if (g.sessionKey == address(0)) revert SessionKeyIsZero();
        if (msg.sender != g.sessionKey) revert WrongSessionKey();
        if (block.timestamp >= g.expiry) revert SessionExpired();

        if (!g.anyFunction) {
            bytes4[] calldata allowed = g.selectors;
            if (allowed.length == 0) revert EmptySessionScope();

            uint256 i;
            for (; i < allowed.length; ++i) {
                if (allowed[i] == selector) break;
            }
            if (i == allowed.length) revert SelectorOutOfSessionScope();
        }

        bytes32 digest = Session.digest(g, address(this), DelegatedLayout.layout().baseChainId);
        if (Session.recover(digest, sig) != g.granter) revert SessionNotSignedByGranter();

        // On the node this read falls through to the pinned block, so it is the same value a
        // resolver replaying the batch will see. That is also its limit: a bump lands on the
        // base chain at once, but a session already running reads at its pin and only picks it
        // up when the next delegation moves the pin. Expiry is what bounds a live session.
        if (g.epoch != hub.sessionEpochOf(g.granter)) revert SessionEpochStale();
    }

    /// @dev Transient storage, so there is no slot left holding a stale identity after the
    ///      transaction and no `SSTORE` on a path that runs on every session call.
    ///
    ///      These want Cancun or later, and both ends clear that bar. Monad states bytecode
    ///      compatibility with Ethereum at the Fusaka fork, whose execution revision is
    ///      Osaka, and its execution client gates EIP-1153 on a revision floor of Cancun, so
    ///      the two opcodes are live on every Monad revision rather than only the current
    ///      one. Neither appears in Monad's list of divergences from Ethereum nor in its
    ///      repricing table, so they cost what they cost anywhere else. The off-chain
    ///      executor's revm spec is past Cancun too, which is what lets the same bytecode
    ///      run on the fast path and on the settlement path.
    ///
    ///      Actor and scope share one word rather than one slot each. They are one fact: a
    ///      frame holding an identity without the fence that admits it, or the other way
    ///      round, is a state no caller should be able to produce, and two slots is two ways
    ///      to produce it. Low 160 bits the granter, the next 32 the selector.
    function _session() private view returns (uint256 session) {
        bytes32 slot = DelegatedLayout.SESSION_SLOT;
        assembly {
            session := tload(slot)
        }
    }

    function _openSession(address actor, bytes4 selector, bool anyFunction) private {
        uint256 session = uint256(uint160(actor)) | (uint256(uint32(selector)) << 160);
        if (anyFunction) session |= SESSION_WILDCARD;
        bytes32 slot = DelegatedLayout.SESSION_SLOT;
        assembly {
            tstore(slot, session)
        }
    }

    function _closeSession() private {
        bytes32 slot = DelegatedLayout.SESSION_SLOT;
        assembly {
            tstore(slot, 0)
        }
    }

    // --- views -----------------------------------------------------------

    function owner() public view returns (address) {
        return DelegatedLayout.layout().owner;
    }

    function isPartitionLocked(bytes32 partition) public view returns (bool) {
        return DelegatedLayout.layout().locked[partition];
    }

    function isEphemeral() public view returns (bool) {
        return block.chainid != DelegatedLayout.layout().baseChainId;
    }

    /// @notice Every slot `delegateAll()` would hand over. Useful to audit an app's surface.
    function delegatedSurface()
        external
        view
        returns (bytes32[] memory globalSlots, bytes32[] memory globalMaps, bytes32[] memory perKey)
    {
        DelegatedLayout.Layout storage l = DelegatedLayout.layout();
        return (l.globalSlots, l.globalMappingBases, l.perKeyBases);
    }

    function _applyDiff(Types.SlotDiff calldata d) private {
        bytes32 slot = d.slot;
        if (DelegatedLayout.isReserved(slot)) revert ReservedSlot();

        bytes32 current;
        assembly {
            current := sload(slot)
        }
        // Only the app can read its own storage, so this check cannot live in the hub.
        if (current != d.oldValue) revert OldValueMismatch();

        bytes32 newValue = d.newValue;
        assembly {
            sstore(slot, newValue)
        }
    }

    function _revertDiff(Types.SlotDiff calldata d) private {
        bytes32 slot = d.slot;
        if (DelegatedLayout.isReserved(slot)) revert ReservedSlot();

        // The hub already authenticated this list against the fold it stored at commit, and
        // the partition has been locked since the session opened, so nothing but the hub's
        // own commits can have moved this slot. Written unconditionally all the same: a
        // confirmed slash has to land, and an extra `current == newValue` check is one more
        // way for it not to. Apply still checks `oldValue`: a bad commit must not land.
        bytes32 oldValue = d.oldValue;
        assembly {
            sstore(slot, oldValue)
        }
    }
}
