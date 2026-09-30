// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Delegatable} from "@interludelayer/contracts/Delegatable.sol";
import {IInterludeHub} from "@interludelayer/contracts/interfaces/IInterludeHub.sol";
import {Types} from "@interludelayer/contracts/interfaces/Types.sol";
import {ClickerInterludeSurface} from "./ClickerInterludeSurface.sol";

/// @title Clicker
/// @notice Everyone clicks, everyone's count goes up, and so does the total. Small on purpose:
///         every line that is here because of Interlude is marked, and there are five of them.
///
///         Once delegated, the node holds `clicks` and `total`. A click is a transaction on the
///         node, signed by a session key the user granted once, with no gas and no wallet
///         prompt, answered in about a millisecond. The node commits the resulting storage
///         diffs back to this same contract on Monad every few seconds, under a validator's
///         signature and bond, where anyone can challenge them.
///
/// @dev The five Interlude lines, and why each is there:
///
///        1. `/// @custom:interlude global` above each variable the node should hold. It is read
///           by `interlude gen`, which writes `ClickerInterludeSurface.sol` from solc's own
///           storage layout. "global" means the whole contract moves as one partition, which
///           is the only shape the hosted node serves.
///        2. `is ClickerInterludeSurface`: the generated file. It declares no state, so it moves
///           nothing, and `interlude check` fails if the layout drifts from what it recorded.
///        3. `_registerInterludeSurface()` in the constructor, which tells `delegateAll()` which
///           slots to hand over. Forget it and the delegation hands over nothing.
///        4. `whenNotDelegated(Types.GLOBAL)` on every function that writes delegated state.
///           While the node holds the state, a write on Monad would fork the two copies and the
///           next commit would be refused; the modifier refuses it first. On the node it is a
///           no-op. Plain Solidity storage cannot guard itself, so this is on you: every writer.
///        5. `_actor()` wherever `msg.sender` would go. A session call reaches this contract as
///           a self-call from `withSession`, so `msg.sender` is the contract itself; `_actor()`
///           is the user who signed the grant, and plain `msg.sender` when there is no session.
///
///      Adding state: put it below the existing variables, annotate it if the node should hold
///      it, then `npm run gen` (rewrites the surface) and `npm run check` (proves it matches).
///      Inserting a variable above a delegated one moves every slot below it; `check` is what
///      catches that before a node is handed the wrong storage.
///
///      Mapping keys must be computed at runtime (`clicks[_actor()]` is). A key that is a
///      compile-time constant lets the optimizer fold the slot hash into a literal, the node
///      never sees the hash happen, and it has to refuse the write. Use `immutable`, not
///      `constant`, for a fixed key.
contract Clicker is ClickerInterludeSurface {
    /// @custom:interlude global
    /// @dev Clicks per address. Slot 0: the surface asserts that number.
    mapping(address => uint256) internal clicks;

    /// @custom:interlude global
    /// @dev Everyone's clicks. Slot 1, in the same partition as `clicks`, because `click()`
    ///      writes both in one call and two separately delegated partitions cannot be.
    uint256 internal total;

    /// @notice Emitted on the node for each click, and visible to any `eth_getLogs` there.
    event Clicked(address indexed who, uint256 clicks, uint256 total);

    /// @dev The hub is the only constructor argument, so `interlude ship` needs no `args` and
    ///      the hosted deployer fills it in. Adding arguments means listing them in
    ///      `interlude.toml`; nothing guesses them for you.
    constructor(IInterludeHub hub_) Delegatable(hub_) {
        _registerInterludeSurface();
    }

    /// @notice One more click for whoever signed the session, and one more for everyone.
    /// @return mine the caller's new count, so the page can show it without a second read
    function click() external whenNotDelegated(Types.GLOBAL) returns (uint256 mine) {
        address who = _actor();
        mine = ++clicks[who];
        uint256 all = ++total;
        // click() makes no external call; forge's linter cannot see into _actor() and assumes
        // it might (it only reads transient storage), so it flags the emit. Silenced here only.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Clicked(who, mine, all);
    }

    function clicksOf(address who) external view returns (uint256) {
        return clicks[who];
    }

    function totalClicks() external view returns (uint256) {
        return total;
    }
}
