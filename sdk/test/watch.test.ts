/**
 * `watch` / `watchRead` against a scripted socket: how many sockets, how many reads, and in
 * what order the values arrive (audit F11, and the reconnect loop in F20-28).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInterludeClient, createAppliedFeed, memoryStore } from "../src/index";
import { APP, counterAbi, stack } from "./fake";

type Mode = "subscribe" | "refuse" | "hang-up" | "rate-limit";

/** A WebSocket whose server side the test scripts. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static mode: Mode = "subscribe";
  /** In "rate-limit" mode: how many subscribes get -32005 before the node lets one through. */
  static limited = 0;
  /** When each subscribe request arrived, for checking the client waited as asked. */
  static asked: number[] = [];

  readonly url: string;
  closed = false;
  private listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
    setTimeout(() => {
      if (FakeSocket.mode === "hang-up") this.close();
      else this.emit("open", {});
    }, 1);
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string) {
    const { id } = JSON.parse(data) as { id: number };
    FakeSocket.asked.push(Date.now());
    setTimeout(() => {
      if (FakeSocket.mode === "rate-limit" && FakeSocket.limited > 0) {
        FakeSocket.limited--;
        // What interlude-rpc's CallerGuard answers when a caller spent its budget (limit.rs).
        this.emit("message", {
          data: JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32005,
              message: "too many requests from this caller; retry later",
              data: { retryAfterSecs: 1 },
            },
          }),
        });
      } else if (FakeSocket.mode === "refuse") {
        this.emit("message", {
          data: JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }),
        });
      } else {
        this.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id, result: "0x1" }) });
      }
    }, 1);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    setTimeout(() => this.emit("close", {}), 0);
  }

  /** The node announcing one applied call. */
  applied(n = 1) {
    this.emit("message", {
      data: JSON.stringify({
        jsonrpc: "2.0",
        method: "interlude_subscription",
        params: {
          subscription: "0x1",
          result: { hash: `0x${n.toString(16).padStart(64, "0")}`, from: APP, to: APP, blockNumber: n },
        },
      }),
    });
  }

  private emit(type: string, event: { data?: unknown }) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  FakeSocket.instances = [];
  FakeSocket.mode = "subscribe";
  FakeSocket.limited = 0;
  FakeSocket.asked = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;
});

afterEach(() => {
  delete (globalThis as { WebSocket?: unknown }).WebSocket;
});

function watched() {
  const s = stack();
  const client = createInterludeClient({
    app: APP,
    abi: counterAbi,
    node: "http://node.test",
    transport: s.nodeTransport,
    base: s.base,
    store: memoryStore(),
  });
  const reads = () => s.node.calls.filter((m) => m === "eth_call").length;
  return { s, client, reads };
}

describe("F11: one socket and bounded reads per client", () => {
  it("shares one socket between every watcher on a client", async () => {
    const { client } = watched();
    const stops = [
      client.watchRead("counter", undefined, () => {}),
      client.watchRead("counter", undefined, () => {}),
      client.watchRead("counterOf", [APP], () => {}),
      client.watch(() => {}),
      client.watch(() => {}),
    ];
    await sleep(20);

    expect(FakeSocket.instances).toHaveLength(1);

    for (const stop of stops) stop();
    await sleep(5);
    expect(FakeSocket.instances[0]!.closed).toBe(true);
  });

  it("collapses a burst of applied calls into a trailing read", async () => {
    const { s, client, reads } = watched();
    const seen: bigint[] = [];
    const stop = client.watchRead("counter", undefined, (value) => seen.push(value));
    await sleep(20);
    const before = reads();

    for (let i = 1; i <= 100; i++) {
      s.node.counter = BigInt(i);
      FakeSocket.instances[0]!.applied(i);
    }
    await sleep(150);

    // A read per call used to be a hundred requests; at most one leading and one trailing now.
    expect(reads() - before).toBeLessThanOrEqual(2);
    expect(seen.at(-1)).toBe(100n);
    stop();
  });

  it("gives watchers of the same view one read between them", async () => {
    const { s, client, reads } = watched();
    const a: bigint[] = [];
    const b: bigint[] = [];
    const stopA = client.watchRead("counter", undefined, (value) => a.push(value));
    const stopB = client.watchRead("counter", undefined, (value) => b.push(value));
    await sleep(80);
    const before = reads();

    s.node.counter = 7n;
    FakeSocket.instances[0]!.applied();
    await sleep(80);

    expect(reads() - before).toBe(1);
    expect(a.at(-1)).toBe(7n);
    expect(b.at(-1)).toBe(7n);
    stopA();
    stopB();
  });

  it("never lets an older reply overwrite a newer value", async () => {
    const { s, client } = watched();
    // The first read is slow and answers with the state as of when it was asked; the call that
    // lands meanwhile triggers a second read that would have answered first.
    const inner = s.node.request;
    let first = true;
    s.node.request = async (args) => {
      if (args.method === "eth_call" && first) {
        first = false;
        const answer = await inner(args);
        await sleep(80);
        return answer;
      }
      return inner(args);
    };

    const seen: bigint[] = [];
    const stop = client.watchRead("counter", undefined, (value) => seen.push(value));
    await sleep(10);
    s.node.counter = 1n;
    FakeSocket.instances[0]!.applied();
    await sleep(200);

    expect(seen.at(-1)).toBe(1n);
    for (let i = 1; i < seen.length; i++) expect(seen[i]! >= seen[i - 1]!).toBe(true);
    stop();
  });
});

describe("the socket's reconnects", () => {
  it("stops reconnecting when the node refuses the subscription, and polls instead", async () => {
    FakeSocket.mode = "refuse";
    let polls = 0;
    const feed = createAppliedFeed("http://node.test");
    const stop = feed.subscribe(() => {}, { fallback: () => polls++, fallbackMs: 20 });
    await sleep(300);

    // It used to reconnect every 250 ms-2 s for as long as the page was open.
    expect(feed.sockets).toBe(1);
    expect(feed.live).toBe(false);
    expect(polls).toBeGreaterThan(3);
    stop();
  });

  it("backs off between reconnects to a socket that keeps dropping", async () => {
    FakeSocket.mode = "hang-up";
    const feed = createAppliedFeed("http://node.test");
    const stop = feed.subscribe(() => {});
    await sleep(900);

    // 250 ms, then 500 ms: two reconnects in 0.9 s, not a tight loop.
    expect(feed.sockets).toBeGreaterThanOrEqual(2);
    expect(feed.sockets).toBeLessThanOrEqual(3);
    stop();
  });

  it("stops polling once the socket is subscribed", async () => {
    let polls = 0;
    const feed = createAppliedFeed("http://node.test");
    const stop = feed.subscribe(() => {}, { fallback: () => polls++, fallbackMs: 10 });
    await sleep(40);

    expect(feed.live).toBe(true);
    expect(polls).toBe(0);
    stop();
  });

  it("comes back to the socket after a rate-limited subscribe, when the node said to", async () => {
    // The node rate-limits interlude_subscribe. One -32005 used to switch the feed to
    // "unsupported" for good: every watcher on the page polled from then on.
    FakeSocket.mode = "rate-limit";
    FakeSocket.limited = 1;
    let polls = 0;
    const feed = createAppliedFeed("http://node.test");
    const stop = feed.subscribe(() => {}, { fallback: () => polls++, fallbackMs: 20 });
    await sleep(300);

    // Refused: polling meanwhile, and not already knocking again at the 250 ms backoff.
    expect(feed.live).toBe(false);
    expect(feed.sockets).toBe(1);
    expect(polls).toBeGreaterThan(3);

    await sleep(1_000);
    expect(feed.sockets).toBe(2);
    expect(feed.live).toBe(true);
    // retryAfterSecs: 1 was honoured.
    expect(FakeSocket.asked[1]! - FakeSocket.asked[0]!).toBeGreaterThanOrEqual(950);

    // Live again, so the fallback stopped.
    const settled = polls;
    await sleep(100);
    expect(polls).toBe(settled);
    stop();
  });

  it("treats an unknown topic (-32602) as permanent, like a missing method", async () => {
    const feed = createAppliedFeed("http://node.test");
    // Swap the reply for this one feed: the node knows the method but not the topic.
    FakeSocket.mode = "refuse";
    const original = FakeSocket.prototype.send;
    FakeSocket.prototype.send = function (this: FakeSocket, data: string) {
      const { id } = JSON.parse(data) as { id: number };
      setTimeout(() => {
        (this as unknown as { emit: (t: string, e: { data?: unknown }) => void }).emit("message", {
          data: JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown subscription" } }),
        });
      }, 1);
    };
    try {
      const stop = feed.subscribe(() => {}, { fallback: () => {}, fallbackMs: 20 });
      await sleep(600);
      expect(feed.sockets).toBe(1);
      expect(feed.live).toBe(false);
      stop();
    } finally {
      FakeSocket.prototype.send = original;
    }
  });

  it("asks a refusing node again once every listener has left and a new one arrives", async () => {
    FakeSocket.mode = "refuse";
    const feed = createAppliedFeed("http://node.test");
    const first = feed.subscribe(() => {}, { fallback: () => {}, fallbackMs: 20 });
    await sleep(50);
    expect(feed.sockets).toBe(1);
    first();

    // The node was upgraded meanwhile.
    FakeSocket.mode = "subscribe";
    const second = feed.subscribe(() => {}, { fallback: () => {}, fallbackMs: 20 });
    await sleep(50);
    expect(feed.sockets).toBe(2);
    expect(feed.live).toBe(true);
    second();
  });
});
