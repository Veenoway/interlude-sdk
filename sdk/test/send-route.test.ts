/**
 * Which transport a send goes over after the socket loses one.
 *
 * It used to be HTTP for the rest of the page: one delivery lost on the socket (a phone changing
 * networks, a proxy dropping an idle connection) and every later tap paid an HTTP request instead
 * of a frame on an open socket. Now the socket rests and is tried again. The router is tested on
 * its own with a clock in hand; the client is tested with the router's clients swapped for the
 * fake node, so the wiring — a lost send rests the socket, a delivered one resets the rest — is
 * the real client's.
 */
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";

import { createPublicClient, custom, type Transport } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  make: undefined as undefined | ((url: string, via: "ws" | "http", socket: number) => unknown),
  now: undefined as undefined | (() => number),
  nodeTransport: undefined as undefined | Transport,
}));

vi.mock("../src/transport", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/transport")>();
  return {
    ...real,
    // Reads go to the fake node, as `config.transport` would send them, without setting it:
    // with a transport of the app's own the router is not used at all.
    createNodeClient: (url: string, transport?: Transport) =>
      hooks.nodeTransport ? real.createNodeClient(url, hooks.nodeTransport) : real.createNodeClient(url, transport),
    createSendRouter: (url: string, options: Parameters<typeof real.createSendRouter>[1] = {}) =>
      real.createSendRouter(url, {
        ...options,
        ...(hooks.make ? { make: hooks.make as never } : {}),
        ...(hooks.now ? { now: hooks.now } : {}),
      }),
  };
});

import {
  createInterludeClient,
  createSendClient,
  createSendRouter,
  memoryStore,
  SEND_SOCKET_REST_MAX_MS,
  SEND_SOCKET_REST_MS,
  type NodeClient,
} from "../src/index";
import { sendSocketUrl } from "../src/transport";
import { APP, counterAbi, stack } from "./fake";

afterEach(() => {
  hooks.make = undefined;
  hooks.now = undefined;
  hooks.nodeTransport = undefined;
  vi.unstubAllGlobals();
});

describe("the send router", () => {
  let clock = 0;
  let made: [string, number][] = [];
  let closed: number[] = [];
  const router = () =>
    createSendRouter("http://node.test", {
      now: () => clock,
      make: (_url, via, socket) => {
        made.push([via, socket]);
        return { via, socket } as unknown as NodeClient;
      },
      close: (_client, socket) => closed.push(socket),
    });

  beforeEach(() => {
    clock = 1_000_000;
    made = [];
    closed = [];
  });

  it("sends over the page's socket, and keeps the one client", () => {
    const r = router();
    expect(r.client().via).toBe("ws");
    expect(r.client().client).toBe(r.client().client);
    expect(made).toEqual([["ws", 0]]);
  });

  it("rests the socket after a loss, then tries a fresh one", () => {
    const r = router();
    r.client();
    r.lost("ws");
    expect(r.client().via).toBe("http");
    clock += SEND_SOCKET_REST_MS - 1;
    expect(r.client().via).toBe("http");
    clock += 1;
    expect(r.client().via).toBe("ws");
    // Not the socket that lost the send: viem would hand that one back, dead, from its cache.
    expect(made).toEqual([
      ["ws", 0],
      ["http", 0],
      ["ws", 1],
    ]);
  });

  it("doubles the rest for each loss in a row, up to a minute, and starts over after an arrival", () => {
    const r = router();
    const restAfterLoss = () => {
      r.client();
      r.lost("ws");
      const from = clock;
      while (r.client().via === "http") clock += 250;
      return clock - from;
    };
    expect(restAfterLoss()).toBe(SEND_SOCKET_REST_MS);
    expect(restAfterLoss()).toBe(SEND_SOCKET_REST_MS * 2);
    expect(restAfterLoss()).toBe(SEND_SOCKET_REST_MS * 4);
    for (let i = 0; i < 6; i++) restAfterLoss();
    expect(restAfterLoss()).toBe(SEND_SOCKET_REST_MAX_MS);

    r.delivered("ws");
    expect(restAfterLoss()).toBe(SEND_SOCKET_REST_MS);
  });

  it("does not rest the socket for a send HTTP lost", () => {
    const r = router();
    r.lost("http");
    expect(r.client().via).toBe("ws");
  });

  it("closes a socket it replaced, and never the page's first", () => {
    const r = router();
    const lose = () => {
      r.client();
      r.lost("ws");
      clock += SEND_SOCKET_REST_MAX_MS;
    };
    lose();
    expect(r.client().via).toBe("ws");
    // Socket 1 replaced socket 0, which the reads share: nothing closed.
    expect(closed).toEqual([]);
    lose();
    r.client();
    expect(closed).toEqual([1]);
    lose();
    r.client();
    expect(closed).toEqual([1, 2]);
  });

  it("connects a socket tried again at a URL of its own", () => {
    expect(sendSocketUrl("http://node.test", 0)).toBe("ws://node.test/");
    expect(sendSocketUrl("https://node.test/rpc?key=abc", 2)).toBe(
      "wss://node.test/rpc?key=abc&interlude_send=2",
    );
    // Node has no WebSocket of its own before 22; the transport is only built, never opened.
    vi.stubGlobal("WebSocket", class {});
    expect(createSendClient("http://node.test", "ws").transport.type).toBe("webSocket");
    expect(createSendClient("http://node.test", "http").transport.type).toBe("http");
  });
});

/**
 * viem's socket cache, for real: a local WebSocket server that answers JSON-RPC and counts the
 * connections made to it. `ws` is viem's own dependency (its Node WebSocket), reached through
 * viem so that the SDK does not need one of its own.
 */
interface Ws {
  WebSocket: unknown;
  WebSocketServer: new (options: { host: string; port: number }) => {
    on(event: "listening", listener: () => void): void;
    on(
      event: "connection",
      listener: (
        socket: { on(event: string, listener: (data?: unknown) => void): void; send(data: string): void },
        request: { url?: string },
      ) => void,
    ): void;
    address(): AddressInfo | string | null;
    close(done: () => void): void;
  };
}

function socketServer() {
  const fromViem = createRequire(createRequire(import.meta.url).resolve("viem"));
  const ws = fromViem("ws") as Ws;
  const server = new ws.WebSocketServer({ host: "127.0.0.1", port: 0 });
  const connections: { url: string; open: boolean }[] = [];
  server.on("connection", (socket, request) => {
    const connection = { url: request.url ?? "", open: true };
    connections.push(connection);
    socket.on("close", () => {
      connection.open = false;
    });
    socket.on("message", (data) => {
      const { id } = JSON.parse(String(data)) as { id: number };
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1" }));
    });
  });
  const ready = new Promise<string>((resolve) =>
    server.on("listening", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );
  return { ws, server, connections, ready };
}

async function until(done: () => boolean, what: string) {
  const started = Date.now();
  while (!done()) {
    if (Date.now() - started > 5_000) throw new Error(`never happened: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("a socket tried again, over a real connection", () => {
  it("is a new connection, not the one viem cached, and the one it replaces is closed", async () => {
    const node = socketServer();
    const url = await node.ready;
    vi.stubGlobal("WebSocket", node.ws.WebSocket);
    let clock = 9_000_000;
    const r = createSendRouter(url, { now: () => clock });
    const ask = async () => {
      const { client, via } = r.client();
      expect(via).toBe("ws");
      expect(await client.request({ method: "eth_chainId" })).toBe("0x1");
      return client;
    };

    const first = await ask();
    expect(node.connections.map((c) => c.url)).toEqual(["/"]);

    // A lost send, the rest, and the socket again: a second connection. With the socket keyed
    // by the transport's `key` alone, viem answered from the first one (or from a dead one).
    r.lost("ws");
    clock += SEND_SOCKET_REST_MS;
    await ask();
    expect(node.connections.map((c) => c.url)).toEqual(["/", "/?interlude_send=1"]);

    // Again: a third connection, and the second is closed. The first never is: reads use it.
    r.lost("ws");
    clock += SEND_SOCKET_REST_MS * 2;
    await ask();
    expect(node.connections.map((c) => c.url)).toEqual([
      "/",
      "/?interlude_send=1",
      "/?interlude_send=2",
    ]);
    const [reads, replaced, fresh] = node.connections;
    await until(() => replaced?.open === false, "the replaced socket closed");
    expect(reads?.open).toBe(true);
    expect(fresh?.open).toBe(true);

    type Closable = { getRpcClient(): Promise<{ close(): void }> };
    (await (first.transport as unknown as Closable).getRpcClient()).close();
    (await (r.client().client.transport as unknown as Closable).getRpcClient()).close();
    await new Promise<void>((resolve) => node.server.close(() => resolve()));
  });
});

describe("a client whose socket loses a send", () => {
  it("resends over HTTP, then goes back to a fresh socket once the rest is over", async () => {
    const s = stack();
    let clock = 5_000_000;
    const made: [string, number][] = [];
    hooks.now = () => clock;
    hooks.nodeTransport = s.nodeTransport;
    hooks.make = (_url, via, socket) => {
      made.push([via, socket]);
      return createPublicClient({ transport: custom({ request: (args) => s.node.request(args) }, { retryCount: 0 }) });
    };

    const client = createInterludeClient({
      app: APP,
      abi: counterAbi,
      node: "http://node.test",
      base: s.base,
      store: memoryStore(),
    });
    const session = await client.openSession({ wallet: s.wallet, scope: ["bump"] });

    await session.send("bump", [1n]);
    expect(made).toEqual([["ws", 0]]);

    // The socket drops the next send before the node sees it: the same bytes go again over HTTP.
    s.node.fault = (method, attempt) =>
      method === "interlude_sendTransaction" && attempt === 1 ? "drop-request" : undefined;
    await session.send("bump", [1n]);
    expect(s.node.executed).toBe(2);
    expect(made).toEqual([
      ["ws", 0],
      ["http", 0],
    ]);

    // Resting: the next send stays on HTTP.
    s.node.fault = undefined;
    await session.send("bump", [1n]);
    expect(made).toHaveLength(2);

    // Rested: back over a fresh socket, where the page used to stay on HTTP for good.
    clock += SEND_SOCKET_REST_MS;
    await session.send("bump", [1n]);
    expect(made).toEqual([
      ["ws", 0],
      ["http", 0],
      ["ws", 1],
    ]);
    expect(s.node.executed).toBe(4);
  });
});
