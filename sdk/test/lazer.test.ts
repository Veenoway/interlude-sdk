import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, pad, stringToHex } from "viem";
import { generatePrivateKey } from "viem/accounts";

import { LAZER_DOMAIN, lazerDigest, signLazerReport } from "../src/lazer";

describe("the local Lazer envelope", () => {
  it("pins the domain as Solidity bytes32 of the string, not a hash of it", () => {
    expect(LAZER_DOMAIN).toBe(pad(stringToHex("interlude.lazer.v1"), { size: 32, dir: "right" }));
    expect(LAZER_DOMAIN).not.toBe(keccak256(stringToHex("interlude.lazer.v1")));
  });

  it("hashes the report the same way LazerLocal does", () => {
    const report = { feedId: 2, price: 100n * 10n ** 8n, published: 1_700_000_000n };
    expect(lazerDigest(report)).toBe(
      keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "uint32" }, { type: "int64" }, { type: "uint64" }],
          [LAZER_DOMAIN, report.feedId, report.price, report.published],
        ),
      ),
    );
  });

  it("packs 96-byte ABI body plus a 65-byte signature", async () => {
    const update = await signLazerReport(generatePrivateKey(), {
      feedId: 2,
      price: 110n * 10n ** 8n,
      published: 1_700_000_001n,
    });
    expect(update.length).toBe(2 + 2 * (96 + 65));
  });
});
