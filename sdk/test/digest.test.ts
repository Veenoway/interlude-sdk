import { beforeAll, describe, expect, it } from "vitest";
import {
  concatHex,
  createPublicClient,
  encodeAbiParameters,
  http,
  keccak256,
  padHex,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import { delegatableAbi } from "../src/abi";
import { sessionGrantDigest, type SessionGrant } from "../src/grant";

const rpc = process.env.INTERLUDE_BASE_RPC ?? "http://127.0.0.1:8545";
const app = (process.env.INTERLUDE_APP ?? "") as Address;

/**
 * Spelled out rather than imported, exactly as `Session.t.sol` does it.
 *
 * A test that took the SDK's own encoding as its reference would agree with itself and pass
 * while every real grant failed to verify.
 */
const DOMAIN_TYPEHASH = keccak256(
  toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);
const GRANT_TYPEHASH = keccak256(
  toHex(
    "SessionGrant(address granter,address sessionKey,uint64 expiry,uint64 epoch,bool anyFunction,bytes4[] selectors)",
  ),
);

/**
 * EIP-712 by hand, from the type strings above and nothing else.
 *
 * The selector array is hashed as its members alone, each right-padded to 32 bytes, with no
 * offset and no length word. That is what `Session.hashGrant` gets out of `abi.encodePacked`,
 * and it is the one field of this encoding where a library could plausibly disagree.
 */
function digestByHand(grant: SessionGrant, appAddress: Address, chainId: number): Hex {
  const selectors = keccak256(
    concatHex(grant.selectors.map((s) => padHex(s, { size: 32, dir: "right" }))),
  );

  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bool" },
        { type: "bytes32" },
      ],
      [
        GRANT_TYPEHASH,
        grant.granter,
        grant.sessionKey,
        grant.expiry,
        grant.epoch,
        grant.anyFunction,
        selectors,
      ],
    ),
  );

  const domain = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        DOMAIN_TYPEHASH,
        keccak256(toHex("Interlude")),
        keccak256(toHex("1")),
        BigInt(chainId),
        appAddress,
      ],
    ),
  );

  return keccak256(concatHex(["0x1901", domain, structHash]));
}

function grant(overrides: Partial<SessionGrant> = {}): SessionGrant {
  return {
    granter: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    sessionKey: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
    expiry: 1_800_000_000n,
    epoch: 0n,
    anyFunction: false,
    selectors: ["0x57b36371"],
    ...overrides,
  };
}

const cases: Array<[string, SessionGrant]> = [
  ["one selector", grant()],
  ["two selectors", grant({ selectors: ["0x57b36371", "0xdeadbeef"] })],
  [
    "five selectors",
    grant({ selectors: ["0x00000000", "0xffffffff", "0x11223344", "0x57b36371", "0x0badf00d"] }),
  ],
  ["a wildcard with no selectors at all", grant({ anyFunction: true, selectors: [] })],
  ["no selectors and no wildcard, which the app refuses but still hashes", grant({ selectors: [] })],
  [
    "the extremes of both uint64 fields",
    grant({ expiry: 2n ** 64n - 1n, epoch: 2n ** 64n - 1n, anyFunction: true }),
  ],
  [
    "zero addresses",
    grant({
      granter: "0x0000000000000000000000000000000000000000",
      sessionKey: "0x0000000000000000000000000000000000000000",
    }),
  ],
];

describe("the grant digest", () => {
  let base: PublicClient;
  let chainId: number;

  beforeAll(async () => {
    base = createPublicClient({ transport: http(rpc) });
    chainId = await base.getChainId();
    expect(app, "INTERLUDE_APP must name a deployed Delegatable app").toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  /**
   * The check that matters: the contract exposes `sessionDigest` so a client can find out
   * before asking a user to sign, rather than by watching every call revert.
   */
  it.each(cases)("matches the app's own sessionDigest: %s", async (_name, g) => {
    const onChain = await base.readContract({
      address: app,
      abi: delegatableAbi,
      functionName: "sessionDigest",
      args: [g],
    });

    expect(sessionGrantDigest(g, { app, baseChainId: chainId })).toBe(onChain);
  });

  it.each(cases)("matches an independent EIP-712 encoding: %s", (_name, g) => {
    expect(sessionGrantDigest(g, { app, baseChainId: chainId })).toBe(
      digestByHand(g, app, chainId),
    );
  });

  /**
   * The `bytes4[]` field on its own, since it is where a silent mismatch would live: viem has
   * to hash the members alone, each right-padded, with neither the offset nor the length word
   * `abi.encode` would have added.
   */
  it("hashes bytes4[] as its members alone, not as abi.encode would", () => {
    const selectors: Hex[] = ["0x57b36371", "0xdeadbeef", "0x00000000"];

    const packed = keccak256(concatHex(selectors.map((s) => padHex(s, { size: 32, dir: "right" }))));
    const encoded = keccak256(encodeAbiParameters([{ type: "bytes4[]" }], [selectors]));

    // The two really do differ, so agreeing with the wrong one would be a silent mismatch
    // rather than a loud one: `abi.encode` prepends an offset and a length that EIP-712 has no
    // room for.
    expect(packed).not.toBe(encoded);

    // And what viem's typed-data encoder produces is built on the first of them.
    expect(sessionGrantDigest(grant({ selectors }), { app, baseChainId: chainId })).toBe(
      digestByHand(grant({ selectors }), app, chainId),
    );
  });

  it("pins the grant to one deployment", async () => {
    const g = grant();
    const here = sessionGrantDigest(g, { app, baseChainId: chainId });

    expect(sessionGrantDigest(g, { app, baseChainId: chainId + 1 })).not.toBe(here);
    expect(
      sessionGrantDigest(g, {
        app: "0x0000000000000000000000000000000000000001",
        baseChainId: chainId,
      }),
    ).not.toBe(here);
  });
});
