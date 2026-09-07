import { pad, type Address, type Hex } from "viem";

/**
 * The partition key an app's per-user state is delegated under.
 *
 * `Delegated.keyOf`: the address, left-padded to 32 bytes. A per-key mapping makes each key its
 * own partition, so one player's state can run on a node while everybody else's stays put.
 */
export function keyOf(address: Address): Hex {
  return pad(address, { size: 32 });
}
