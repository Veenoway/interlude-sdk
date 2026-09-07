// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Types} from "../interfaces/Types.sol";

/// @title Session
/// @notice EIP-712 hashing and recovery for `Types.SessionGrant`.
/// @dev Split from `Delegatable` so a frontend, an SDK or a resolver can compute the same
///      digest from the same bytes without deploying anything, and so the type strings live in
///      one place. A grant's whole security rests on the signer having seen these exact fields,
///      which means the type strings are load-bearing and must never be edited casually: change
///      one and every outstanding grant stops verifying.
///
///      Recovery is hand-rolled because nothing vetted is vendored in `lib/` and pulling in a
///      library for sixty bytes of `ecrecover` handling would be a worse trade than getting the
///      three checks below right. Those three are the whole difficulty: length, malleability
///      and the zero return.
library Session {
    /// @dev The name a wallet shows the user. Deliberately the protocol rather than the app:
    ///      the app is already pinned by `verifyingContract`, and one recognisable name across
    ///      every Interlude app is worth more to a signer than a per-app string.
    bytes32 internal constant DOMAIN_NAME = keccak256("Interlude");
    bytes32 internal constant DOMAIN_VERSION = keccak256("1");

    bytes32 internal constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 internal constant GRANT_TYPEHASH = keccak256(
        "SessionGrant(address granter,address sessionKey,uint64 expiry,uint64 epoch,bool anyFunction,bytes4[] selectors)"
    );

    /// @dev secp256k1n / 2. Both `s` and `n - s` satisfy the curve equation, so every signature
    ///      has a twin that recovers the same address. Accepting both would mean one grant has
    ///      two valid encodings, and anything that dedupes or logs by signature bytes could be
    ///      fed the same authorisation twice under two different identities.
    uint256 internal constant HALF_ORDER =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    error BadSessionSignature();
    error MalleableSessionSignature();

    /// @param app the contract the grant is for. `address(this)` in the app, which is the proxy
    ///        rather than the implementation when there is one, and that is the correct answer:
    ///        the proxy is where the state lives.
    /// @param chainId the base chain's id, not the ephemeral one. See `Delegatable.withSession`.
    function domainSeparator(address app, uint256 chainId) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, DOMAIN_NAME, DOMAIN_VERSION, chainId, app));
    }

    /// @dev `abi.encodePacked` on the selector array rather than `abi.encode`: EIP-712 hashes a
    ///      dynamic array as the members alone, each padded to 32 bytes, with no offset and no
    ///      length. `abi.encode` would prepend both and produce a digest no wallet computes.
    function hashGrant(Types.SessionGrant calldata g) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                GRANT_TYPEHASH,
                g.granter,
                g.sessionKey,
                g.expiry,
                g.epoch,
                g.anyFunction,
                keccak256(abi.encodePacked(g.selectors))
            )
        );
    }

    function digest(Types.SessionGrant calldata g, address app, uint256 chainId)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(app, chainId), hashGrant(g)));
    }

    /// @notice Who signed `d`, or a revert. Never the zero address.
    /// @dev `ecrecover` returns zero rather than reverting on a signature it cannot resolve, so
    ///      a caller that compares the result against an attacker-supplied address would treat
    ///      garbage as a valid signature from `address(0)`.
    function recover(bytes32 d, bytes calldata sig) internal pure returns (address signer) {
        if (sig.length != 65) revert BadSessionSignature();

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }

        if (uint256(s) > HALF_ORDER) revert MalleableSessionSignature();
        if (v != 27 && v != 28) revert BadSessionSignature();

        signer = ecrecover(d, v, r, s);
        if (signer == address(0)) revert BadSessionSignature();
    }
}
