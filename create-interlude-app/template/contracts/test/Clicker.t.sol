// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IInterludeHub} from "@interludelayer/contracts/interfaces/IInterludeHub.sol";
import {Types} from "@interludelayer/contracts/interfaces/Types.sol";
import {Clicker} from "../src/Clicker.sol";

/// @dev The handful of Foundry cheatcodes these tests use, declared here instead of installing
///      forge-std, so `forge test` works straight after `npm run build` with nothing else to
///      fetch. Swap in `forge-std/Test.sol` whenever you want the full kit.
interface Vm {
    function prank(address sender) external;
    function chainId(uint256 newChainId) external;
    function expectRevert(bytes4 revertData) external;
    function load(address target, bytes32 slot) external view returns (bytes32);
    function addr(uint256 privateKey) external pure returns (address);
    function sign(uint256 privateKey, bytes32 digest)
        external
        pure
        returns (uint8 v, bytes32 r, bytes32 s);
}

/// @dev Stands in for the hub in the one read a session makes of it: the granter's epoch. The
///      real hub also bonds validators, takes commits and runs disputes; none of that is under
///      test here, and a test that needs it wants `interlude dev`.
contract EpochZeroHub {
    function sessionEpochOf(address) external pure returns (uint256) {
        return 0;
    }
}

/// @dev Clicker plus a way to read the slot numbers `npm run gen` wrote into
///      `ClickerInterludeSurface.sol`. It declares no state, so its storage layout is Clicker's.
contract ClickerWithSlots is Clicker {
    constructor(IInterludeHub hub_) Clicker(hub_) {}

    function generatedSlots() external pure returns (bytes32 clicksSlot, bytes32 totalSlot) {
        return (CLICKS_SLOT, TOTAL_SLOT);
    }
}

/// @notice What makes Clicker safe to hand to a node, checked without one.
///
///         The node runs this same bytecode on its own chain id, so "on the node" below is
///         `vm.chainId` changed away from the chain the contract was deployed on, and "the hub
///         delegates" is the hub's own callback, sent from the hub's address.
contract ClickerTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// Same selector wherever the error is declared, so this does not depend on which Interlude
    /// file declares it.
    bytes4 internal constant DELEGATED_WRITES_DISABLED =
        bytes4(keccak256("DelegatedWritesDisabled()"));
    bytes4 internal constant ONLY_HUB = bytes4(keccak256("OnlyHub()"));

    /// Any id other than the deployment's. 4242 is the node's default.
    uint256 internal constant NODE_CHAIN_ID = 4242;

    EpochZeroHub internal hub;
    Clicker internal clicker;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        hub = new EpochZeroHub();
        clicker = new Clicker(IInterludeHub(address(hub)));
    }

    function test_clicksCountPerAddressAndInTotal() public {
        vm.prank(alice);
        _eq(clicker.click(), 1, "alice's first click returns her new count");
        vm.prank(alice);
        clicker.click();
        vm.prank(bob);
        clicker.click();

        _eq(clicker.clicksOf(alice), 2, "alice");
        _eq(clicker.clicksOf(bob), 1, "bob");
        _eq(clicker.totalClicks(), 3, "total");
    }

    /// @dev The generated surface registers `clicks` and `total`, and the slots it names are
    ///      where solc really put them. The slot numbers come from the generated file itself, so
    ///      adding variables and running `npm run gen` keeps this passing. It fails when the
    ///      surface is stale (run `npm run gen` and read what moved) or stops handing these two
    ///      over. Rename either variable and `gen` renames its `_SLOT` constant too: update
    ///      `ClickerWithSlots` above to match.
    function test_theSurfaceHandsOverTheSlotsSolcAssigned() public {
        ClickerWithSlots app = new ClickerWithSlots(IInterludeHub(address(hub)));
        (bytes32 clicksSlot, bytes32 totalSlot) = app.generatedSlots();
        (bytes32[] memory globalSlots, bytes32[] memory globalMaps, bytes32[] memory perKey) =
            app.delegatedSurface();
        _has(globalMaps, clicksSlot, "clicks, handed over as one whole mapping");
        _has(globalSlots, totalSlot, "total, handed over as one scalar");
        _eq(perKey.length, 0, "nothing per key: the hosted node serves GLOBAL only");

        vm.prank(alice);
        app.click();
        bytes32 aliceSlot = keccak256(abi.encode(alice, clicksSlot));
        _eq(uint256(vm.load(address(app), aliceSlot)), 1, "alice's entry where the hub looks");
        _eq(uint256(vm.load(address(app), totalSlot)), 1, "total where the hub looks");
    }

    /// @dev While the node holds the state, a click on Monad would fork the two copies. The
    ///      modifier refuses it, and this is the test that fails if a writer loses it.
    function test_aBaseChainClickIsRefusedWhileTheNodeHoldsTheState() public {
        _delegate();

        vm.prank(alice);
        vm.expectRevert(DELEGATED_WRITES_DISABLED);
        clicker.click();
    }

    /// @dev The same bytecode on the node's chain id, same delegation: accepted.
    function test_theNodeAcceptsClicksWhileDelegated() public {
        _delegate();
        vm.chainId(NODE_CHAIN_ID);

        vm.prank(alice);
        clicker.click();
        _eq(clicker.totalClicks(), 1, "counted on the node");
    }

    /// @dev What a commit does on Monad: the hub applies the node's `(slot, old, new)` diffs to
    ///      this contract, and the values are then simply there, read by plain Solidity.
    function test_aCommitFromTheHubLandsTheNodesDiffs() public {
        _delegate();

        Types.SlotDiff[] memory diffs = new Types.SlotDiff[](2);
        diffs[0] = _mappingDiff(alice, 0, 7);
        diffs[1] = _scalarDiff(1, 0, 7);

        vm.prank(address(hub));
        clicker.applyDelegatedDiffs(diffs);

        _eq(clicker.clicksOf(alice), 7, "alice, as the node counted her");
        _eq(clicker.totalClicks(), 7, "total, as the node counted it");
    }

    function test_onlyTheHubCanWriteDiffs() public {
        Types.SlotDiff[] memory diffs = new Types.SlotDiff[](1);
        diffs[0] = _scalarDiff(1, 0, 1e18);

        vm.prank(alice);
        vm.expectRevert(ONLY_HUB);
        clicker.applyDelegatedDiffs(diffs);
    }

    /// @dev Why `_actor()` and not `msg.sender`: a session call arrives from the session key,
    ///      through `withSession`, as a self-call. The click has to be credited to the user who
    ///      signed the grant, not to the key and not to the contract.
    function test_aSessionClickIsCreditedToTheGranter() public {
        uint256 granterKey = 0xA11CE5;
        uint256 sessionKey = 0x5E5510;
        address granter = vm.addr(granterKey);
        address key = vm.addr(sessionKey);

        bytes4[] memory scope = new bytes4[](1);
        scope[0] = Clicker.click.selector;
        Types.SessionGrant memory grant = Types.SessionGrant({
            granter: granter,
            sessionKey: key,
            expiry: uint64(block.timestamp + 1 hours),
            epoch: 0,
            anyFunction: false,
            selectors: scope
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(granterKey, clicker.sessionDigest(grant));

        _delegate();
        vm.chainId(NODE_CHAIN_ID);
        vm.prank(key);
        clicker.withSession(grant, abi.encodePacked(r, s, v), abi.encodeCall(Clicker.click, ()));

        _eq(clicker.clicksOf(granter), 1, "credited to the granter");
        _eq(clicker.clicksOf(key), 0, "not to the session key");
        _eq(clicker.clicksOf(address(clicker)), 0, "not to the contract");
    }

    // --- helpers ---------------------------------------------------------

    /// @dev The hub's callback when a delegation opens. `delegateAll()` ends in exactly this
    ///      call once the hub has bonded a validator for the app.
    function _delegate() internal {
        vm.prank(address(hub));
        clicker.onDelegationChanged(Types.GLOBAL, true);
    }

    /// @dev `clicks[who]`: a mapping entry, with the key the hub re-derives the slot from.
    function _mappingDiff(address who, uint256 oldValue, uint256 newValue)
        internal
        pure
        returns (Types.SlotDiff memory)
    {
        bytes32 key = bytes32(uint256(uint160(who)));
        return Types.SlotDiff({
            slot: keccak256(abi.encode(key, bytes32(uint256(0)))),
            oldValue: bytes32(oldValue),
            newValue: bytes32(newValue),
            isMapping: true,
            mappingBase: bytes32(uint256(0)),
            key: key
        });
    }

    function _scalarDiff(uint256 slot, uint256 oldValue, uint256 newValue)
        internal
        pure
        returns (Types.SlotDiff memory)
    {
        return Types.SlotDiff({
            slot: bytes32(slot),
            oldValue: bytes32(oldValue),
            newValue: bytes32(newValue),
            isMapping: false,
            mappingBase: bytes32(0),
            key: bytes32(0)
        });
    }

    function _has(bytes32[] memory registered, bytes32 slot, string memory what) internal pure {
        for (uint256 i = 0; i < registered.length; ++i) {
            if (registered[i] == slot) return;
        }
        revert(string.concat(what, ": slot ", _str(uint256(slot)), " is not registered"));
    }

    function _eq(uint256 got, uint256 want, string memory what) internal pure {
        if (got != want) {
            revert(string.concat(what, ": got ", _str(got), ", want ", _str(want)));
        }
    }

    function _str(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        bytes memory out;
        while (value != 0) {
            out = abi.encodePacked(bytes1(uint8(48 + value % 10)), out);
            value /= 10;
        }
        return string(out);
    }
}
