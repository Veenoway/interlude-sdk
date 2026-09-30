/**
 * Compile-time checks, run by `tsc --noEmit` rather than by vitest (audit F10).
 *
 * Each `@ts-expect-error` is a call that has to be refused: if the SDK ever accepts it again,
 * the directive itself becomes the error and the typecheck fails.
 */
import type {
  Abi,
  Account,
  Address,
  HttpTransport,
  PublicClient,
  Transport,
  WalletClient,
} from "viem";
import type { monadTestnet } from "viem/chains";

import type { InterludeClient, Session, roomAbi } from "../src/index";
import type { InterludeProviderProps, createInterludeHooks } from "../src/react/index";
import type { counterAbi } from "./fake";

declare const session: Session<typeof counterAbi>;
declare const client: InterludeClient<typeof counterAbi>;
declare const hooks: ReturnType<typeof createInterludeHooks<typeof counterAbi>>;
declare const loose: Session<Abi>;
declare const room: Session<typeof roomAbi>;
declare const roomClient: InterludeClient<typeof roomAbi>;
declare const who: Address;

export async function sendArguments() {
  // A function that takes arguments has to be given them.
  // @ts-expect-error bump(uint256) needs its argument
  await session.send("bump");
  // @ts-expect-error and of the right type
  await session.send("bump", ["1"]);

  const { result } = await session.send("bump", [1n]);
  const total: bigint = result;

  // A function that takes none can be called without an argument list, or with an empty one.
  await session.send("ping");
  await session.send("ping", []);

  // An ABI that is not `as const` knows nothing about arguments, so they stay optional there.
  await loose.send("anything");

  return total;
}

export async function readArguments() {
  // @ts-expect-error counterOf(address) needs its argument
  await client.read("counterOf");
  const value: bigint = await client.read("counterOf", [who]);
  const plain: bigint = await client.read("counter");
  return value + plain;
}

export function hookData() {
  const call = hooks.useSessionCall("bump");
  // `data` is the function's return type now, not `unknown`.
  const total: bigint | undefined = call.data;
  // @ts-expect-error bump needs its argument here too
  void call.send();
  void call.send([2n]);

  const read = hooks.useRead("counterOf", [who]);
  const value: bigint | undefined = read.data;
  const watched = hooks.useWatch("counter");
  const live: bigint | undefined = watched.data;
  return [total, value, live, read.isFetching];
}

export async function roomCalls() {
  // The exported Room ABI is `as const`, so the README's snippets are typed off it.
  await room.send("join");
  await room.send("move", [1]);
  // @ts-expect-error move(uint8) needs its direction
  await room.send("move");
  // @ts-expect-error the salons are not in the exported slice
  await room.send("create", [4]);
  const cell: bigint = await roomClient.read("where", [who]);
  return cell;
}

export function wagmiWallet() {
  // wagmi's `useWalletClient().data` is viem's WalletClient narrowed to the config's transport
  // and chain, with an account, or undefined while it connects. The README hands it to the
  // provider as is, so both shapes have to be accepted without a cast.
  const narrowed = null as unknown as WalletClient<HttpTransport, typeof monadTestnet, Account>;
  const anyTransport = null as unknown as WalletClient<Transport, typeof monadTestnet, Account>;
  const connecting = undefined as
    | WalletClient<HttpTransport, typeof monadTestnet, Account>
    | undefined;
  const reader = null as unknown as PublicClient;
  const props: InterludeProviderProps[] = [
    { wallet: narrowed, children: null },
    { wallet: anyTransport, children: null },
    { wallet: connecting, children: null },
    // @ts-expect-error a public client cannot sign the grant
    { wallet: reader, children: null },
  ];
  return props;
}
