// @vitest-environment jsdom
/**
 * The hooks against the same live node, in a DOM.
 *
 * jsdom brings a real `sessionStorage`, so this is also the only test of the default store: no
 * `store` is passed anywhere below, and the session still survives a remount.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";

import { createInterludeClient, type SendResult, type Session } from "../src/index";
import { createInterludeHooks } from "../src/react/index";
import { playersAbi } from "./players";

const baseRpc = process.env.INTERLUDE_BASE_RPC ?? "http://127.0.0.1:8545";
const nodeRpc = process.env.INTERLUDE_NODE_RPC ?? "http://127.0.0.1:8546";
const app = (process.env.INTERLUDE_APP ?? "") as Address;
/**
 * The player whose partition the deploy script delegated, which the node is serving.
 *
 * It has to be that one: a session for anybody else would write to a slot outside the
 * delegation and the node would refuse the transaction whole, before the app's own rules or
 * these hooks came into it.
 */
const userPk = (process.env.INTERLUDE_PLAYER_PK ??
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6") as Hex;

const user = privateKeyToAccount(userPk);

/**
 * `timeout: 0` because of jsdom, not because of anything the SDK does.
 *
 * jsdom installs its own `AbortController` while `Request` stays Node's, and Node refuses a
 * signal from another implementation, so viem's request timeout makes every call throw before
 * it is sent. Turning the timeout off removes the signal. A browser has one implementation of
 * both and needs none of this.
 */
const transport = http(nodeRpc, { timeout: 0 });
const base: PublicClient = createPublicClient({
  chain: anvil,
  transport: http(baseRpc, { timeout: 0 }),
});

let prompts = 0;
const wallet: WalletClient = new Proxy(
  createWalletClient({ account: user, chain: anvil, transport: http(baseRpc) }),
  {
    get(target, property, receiver) {
      if (property === "signTypedData") {
        return (...args: unknown[]) => {
          prompts++;
          return (target.signTypedData as (...a: unknown[]) => unknown)(...args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  },
);

const client = createInterludeClient({ app, abi: playersAbi, node: nodeRpc, transport, base });
const { InterludeProvider, useSession, useSessionCall, useRead, useNodeStatus } =
  createInterludeHooks(client);

/** What the component under test saw on its last render. */
interface Seen {
  session: Session<typeof playersAbi> | null;
  isRestoring: boolean;
  open: () => Promise<Session<typeof playersAbi> | undefined>;
  send: (args?: readonly [bigint]) => Promise<SendResult<unknown> | undefined>;
  data: unknown;
  latencyMs: number | undefined;
  error: Error | null;
  square: unknown;
  serving: Address | undefined;
}

let seen: Seen | null = null;
let root: Root | null = null;

function Probe() {
  const session = useSession();
  const move = useSessionCall("move");
  const square = useRead("squareOf", [user.address]);
  const status = useNodeStatus({ pollMs: 500 });

  seen = {
    session: session.session,
    isRestoring: session.isRestoring,
    open: session.open,
    send: move.send,
    data: move.data,
    latencyMs: move.latencyMs,
    error: session.error ?? move.error,
    square: square.data,
    serving: status.status?.app,
  };
  return null;
}

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <InterludeProvider wallet={wallet} scope={["move"]}>
        <Probe />
      </InterludeProvider>,
    );
  });
}

/** Effects settle across network round trips, so waiting has to happen inside `act`. */
async function waitFor(predicate: () => boolean, what: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    // A hook that failed will sit in its error state for the whole timeout otherwise, and the
    // report would say "timed out" when the answer is in the error.
    if (seen?.error) throw new Error(`waiting for ${what}: ${seen.error.message}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("the React hooks", () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    expect(app, "INTERLUDE_APP must name the deployed Players").toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(typeof globalThis.sessionStorage, "jsdom should provide sessionStorage").toBe("object");
    sessionStorage.clear();
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
  });

  it("opens on demand, sends, and reports the latency", async () => {
    await render();
    await waitFor(() => seen?.isRestoring === false, "the restore attempt to finish");

    // Nothing was stored yet, so there is nothing to restore and no prompt has happened.
    expect(seen?.session).toBeNull();
    expect(prompts).toBe(0);

    await act(async () => {
      await seen!.open();
    });
    await waitFor(() => seen?.session != null, "the session to open");
    expect(prompts).toBe(1);

    const before = await client.read("squareOf", [user.address]);
    await act(async () => {
      await seen!.send([2n]);
    });
    await waitFor(() => seen?.data != null, "the call to return");

    expect(seen?.error).toBeNull();
    expect(seen?.data).toBe(before + 2n);
    expect(seen?.latencyMs).toBeGreaterThan(0);
    expect(prompts).toBe(1);

    // The key and the grant went to sessionStorage together, which is what the next test needs.
    expect(sessionStorage.length).toBe(1);
  });

  it("restores from sessionStorage on a remount, with no prompt", async () => {
    await render();
    await waitFor(() => seen?.session != null, "the stored session to come back");

    expect(prompts).toBe(1);
    expect(seen?.session?.restored).toBe(true);

    const before = await client.read("squareOf", [user.address]);
    await act(async () => {
      await seen!.send([1n]);
    });
    await waitFor(() => seen?.data === before + 1n, "the restored session to move the square");
    expect(prompts).toBe(1);
  });

  it("reads the app and the node's own status", async () => {
    await render();
    await waitFor(() => seen?.square != null, "the view call");
    await waitFor(() => seen?.serving != null, "the node status");

    expect(seen?.square).toBe(await client.read("squareOf", [user.address]));
    expect(seen?.serving?.toLowerCase()).toBe(app.toLowerCase());
  });
});
