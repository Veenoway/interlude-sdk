import { type Hex, keccak256, encodeAbiParameters, concat, toHex } from "viem";
import { sign } from "viem/accounts";

/** `bytes32("interlude.lazer.v1")` — the Solidity string, not a hash of it. */
export const LAZER_DOMAIN =
  "0x696e7465726c7564652e6c617a65722e76310000000000000000000000000000" as Hex;

export type LazerReport = {
  feedId: number;
  price: bigint;
  published: bigint;
};

export function lazerDigest(report: LazerReport): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint32" }, { type: "int64" }, { type: "uint64" }],
      [LAZER_DOMAIN, report.feedId, report.price, report.published],
    ),
  );
}

/**
 * Pack a signed print the Tape contract will accept.
 *
 * Live Pyth Lazer is a different envelope (fee, signer registry). This is the Interlude
 * shape: the bytes go in the app call so a replay does not invent a price.
 */
export async function signLazerReport(privateKey: Hex, report: LazerReport): Promise<Hex> {
  const { r, s, v } = await sign({ hash: lazerDigest(report), privateKey });
  const body = encodeAbiParameters(
    [{ type: "uint32" }, { type: "int64" }, { type: "uint64" }],
    [report.feedId, report.price, report.published],
  );
  const vb = Number(v) < 27 ? Number(v) + 27 : Number(v);
  return concat([body, r, s, toHex(vb, { size: 1 })]);
}
