// @vitest-environment jsdom
/**
 * The hooks against a scripted client, in a DOM: the state transitions the live suite cannot
 * pin down because a real node answers too quickly to catch them in between.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

import type { InterludeClient, Session } from "../src/index";
import { createInterludeHooks } from "../src/react/index";
import { counterAbi } from "./fake";

type Client = InterludeClient<typeof counterAbi>;

const ALICE: Address = "0x000000000000000000000000000000000000a11c";
const BOB: Address = "0x0000000000000000000000000000000000000b0b";

function fakeSession(granter: Address, expiresInMs = 3_600_000): Session<typeof counterAbi> {
  return {
    granter,
    sessionKey: granter,
    grant: {} as never,
    signature: "0x",
    expiresAt: new Date(Date.now() + expiresInMs),
    restored: true,
    isExpired: () => false,
    covers: () => true,
    send: vi.fn() as never,
    discard: vi.fn(),
  };
}

function fakeClient(overrides: Partial<Client>): Client {
  return {
    restoreSession: async () => null,
    openSession: async () => fakeSession(ALICE),
    read: async () => 0n,
    watchRead: () => () => {},
    status: async () => ({}) as never,
    ...overrides,
  } as Client;
}

let root: Root | null = null;

async function mount(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
}

async function settle(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
});

describe("F14: switching accounts", () => {
  it("drops the previous account's session before the next one restores", async () => {
    const client = fakeClient({
      // Alice's session is in storage; Bob's restore is still on the network.
      restoreSession: (granter: Address) =>
        granter === ALICE ? Promise.resolve(fakeSession(ALICE)) : new Promise(() => {}),
    } as Partial<Client>);
    const { InterludeProvider, useSession } = createInterludeHooks(client);

    let seen: { session: Session<typeof counterAbi> | null; isRestoring: boolean } | null = null;
    function Probe() {
      const { session, isRestoring } = useSession();
      seen = { session, isRestoring };
      return null;
    }

    await mount(
      <InterludeProvider account={ALICE}>
        <Probe />
      </InterludeProvider>,
    );
    await settle();
    expect(seen!.session?.granter).toBe(ALICE);

    await act(async () =>
      root!.render(
        <InterludeProvider account={BOB}>
          <Probe />
        </InterludeProvider>,
      ),
    );

    // Alice's key would otherwise sign Bob's next call.
    expect(seen!.session).toBeNull();
    expect(seen!.isRestoring).toBe(true);
  });
});

describe("the read hooks' loading flags", () => {
  it("does not report a disabled watch as loading", async () => {
    const watchRead = vi.fn(() => () => {});
    const { useWatch } = createInterludeHooks(fakeClient({ watchRead } as Partial<Client>));

    let loading: boolean | undefined;
    function Probe() {
      loading = useWatch("counter", undefined, { enabled: false }).isLoading;
      return null;
    }
    await mount(<Probe />);
    await settle();

    expect(loading).toBe(false);
    expect(watchRead).not.toHaveBeenCalled();
  });

  it("does not flash isLoading on every poll once it has a value", async () => {
    let n = 0n;
    const { useRead } = createInterludeHooks(
      fakeClient({ read: (async () => ++n) as never } as Partial<Client>),
    );

    const loading: boolean[] = [];
    let fetching = false;
    function Probe() {
      const read = useRead("counter", undefined, { pollMs: 15 });
      if (read.data !== undefined) loading.push(read.isLoading);
      fetching ||= read.isFetching;
      return null;
    }
    await mount(<Probe />);
    // Several short `act`s rather than one long one, so each poll's render is flushed and seen.
    for (let i = 0; i < 8; i++) await settle(20);

    expect(n).toBeGreaterThan(2n);
    expect(loading.every((flag) => flag === false)).toBe(true);
    expect(fetching).toBe(true);
  });
});

describe("autoRenew", () => {
  it("signs a fresh grant before the current one expires", async () => {
    const openSession = vi.fn(async (_options: unknown) => fakeSession(ALICE));
    const client = fakeClient({
      restoreSession: async () => fakeSession(ALICE, 1_000),
      openSession,
    } as Partial<Client>);
    const { InterludeProvider } = createInterludeHooks(client);

    await mount(
      <InterludeProvider account={ALICE} wallet={{} as never} autoRenew={{ beforeSeconds: 0.95 }}>
        {null}
      </InterludeProvider>,
    );
    await settle(150);

    expect(openSession).toHaveBeenCalledTimes(1);
    expect(openSession.mock.calls[0]![0]).toMatchObject({ force: true });
  });

  it("does not prompt again and again when the grant lives no longer than the renew lead", async () => {
    // expirySeconds 30 with autoRenew's 60 s lead: every fresh grant was already due for renewal.
    const openSession = vi.fn(async (_options: unknown) => ({
      ...fakeSession(ALICE, 30_000),
      restored: false,
    }));
    const client = fakeClient({ restoreSession: async () => null, openSession } as Partial<Client>);
    const { InterludeProvider, useSession } = createInterludeHooks(client);

    let open: (() => Promise<unknown>) | undefined;
    function Probe() {
      open = useSession().open;
      return null;
    }
    await mount(
      <InterludeProvider account={ALICE} wallet={{} as never} autoRenew expirySeconds={30}>
        <Probe />
      </InterludeProvider>,
    );
    await settle();
    await act(async () => {
      await open!();
    });
    await settle(200);

    // One signature for the open, and the renewal waits for half the grant's life (15 s).
    expect(openSession).toHaveBeenCalledTimes(1);
  });
});
