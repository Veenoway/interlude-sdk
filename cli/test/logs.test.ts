/**
 * `interlude logs --follow` against a local WebSocket server that answers the way interlude-rpc
 * does: jsonrpsee's subscription id, then one `AppliedCall` per notification, in the shape
 * `packages/node/crates/interlude-rpc/src/node.rs` serializes (camelCase, lowercase hex, a JSON
 * number for the block). Those frames are the ones a node started by `interlude dev` sent on
 * 2026-09-28: `{"id":1,"result":3635806317827512}`, then `"method":"interlude_subscribe"` with
 * `params.subscription` that same number. One notification that node sent is below verbatim.
 * What is asserted is what the command prints, and that it prints nothing at all when there is
 * no node to hear.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAbi, toFunctionSelector } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { abiModule } from "../src/abi.js";
import {
  asAppliedCall,
  chooseNode,
  follow,
  formatCall,
  functionNames,
  LogsError,
  parseAbiText,
  refusal,
  socketUrl,
  unreachable,
  type AppliedCall,
  type Socket,
  type SocketFactory,
} from "../src/logs.js";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(pkg, "node_modules", ".bin", "tsx");
const entry = join(pkg, "src", "index.ts");

// `ws` has no bundled types, and this needs four members of it.
interface PeerSocket {
  on(event: "message", listener: (data: Buffer) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
interface PeerServer {
  on(event: "connection", listener: (socket: PeerSocket) => void): void;
  on(event: "listening", listener: () => void): void;
  address(): { port: number };
  close(callback?: () => void): void;
  clients: Set<PeerSocket>;
}
const ws = createRequire(import.meta.url)("ws") as {
  WebSocket: new (url: string) => Socket;
  WebSocketServer: new (options: { port: number; host: string }) => PeerServer;
};

const ABI = parseAbi([
  "function play()",
  "function tap(uint256 x)",
  "function tap(uint256 x, uint256 y)",
  "function score() view returns (uint256)",
]);

const APP = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const SENDER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const PLAY = toFunctionSelector("function play()");

/** One call as the node pushes it: every field of `AppliedCall`. */
function applied(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    app: APP,
    hash: `0x${n.toString(16).padStart(64, "0")}`,
    from: SENDER,
    to: APP,
    selector: PLAY,
    input: PLAY,
    output: "0x",
    logs: [{ address: APP, topics: [`0x${"11".repeat(32)}`], data: "0x" }],
    blockNumber: 40 + n,
    succeeded: true,
    ...overrides,
  };
}

// --- a node on loopback ------------------------------------------------------

type OnSubscribe = (socket: PeerSocket, request: { id: unknown; method: string; params: unknown }) => void;

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

async function fakeNode(onSubscribe: OnSubscribe): Promise<string> {
  const server = new ws.WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as { id: unknown; method: string; params: unknown };
      onSubscribe(socket, request);
    });
  });
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.close();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

/** Accept the way jsonrpsee does (a numeric id), send `calls`, then hang up. */
function streams(calls: Record<string, unknown>[], subscription = 3_792_615_022_145_541): OnSubscribe {
  return (socket, request) => {
    if (request.method !== "interlude_subscribe") return;
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: subscription }));
    for (const call of calls) {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "interlude_subscribe",
          params: { subscription, result: call },
        }),
      );
    }
    setTimeout(() => socket.close(1000, "bye"), 50);
  };
}

async function closedPort(): Promise<number> {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface Heard {
  lines: string[];
  status: string[];
  error?: LogsError;
}

async function hear(
  node: string,
  socket: SocketFactory,
  extra: { names?: Map<string, string>; json?: boolean; connectTimeoutMs?: number } = {},
): Promise<Heard> {
  const heard: Heard = { lines: [], status: [] };
  let n = 0;
  const following = follow({
    node,
    socket,
    write: (line) => heard.lines.push(line),
    status: (line) => heard.status.push(line),
    now: () => new Date(Date.UTC(2026, 8, 28, 12, 4, 7, 123 + 10 * n++)),
    ...extra,
  });
  try {
    await following.done;
  } catch (error) {
    heard.error = error as LogsError;
  }
  return heard;
}

// --- the line -----------------------------------------------------------------

describe("the line for one applied call", () => {
  const call = asAppliedCall(applied(1))!;
  const at = new Date("2026-09-28T12:04:07.123Z");

  it("prints what the node sent, and when it arrived", () => {
    expect(formatCall(call, at)).toBe(
      `12:04:07.123  ok      ${PLAY}     block 41  from ${SENDER}  tx 0x${"0".repeat(63)}1`,
    );
  });

  it("names the function from an ABI, and spells out an overload", () => {
    const names = functionNames(ABI);
    expect(names.get(PLAY)).toBe("play");
    expect(names.get(toFunctionSelector("function tap(uint256)"))).toBe("tap(uint256)");
    expect(names.get(toFunctionSelector("function tap(uint256,uint256)"))).toBe("tap(uint256,uint256)");
    // The widest name here is tap(uint256,uint256), 20 characters: the column is that wide.
    expect(formatCall(call, at, names)).toMatch(/^12:04:07\.123 {2}ok {6}play {18}block 41 {2}from /);
  });

  it("says failed, not reverted, and keeps a selector no ABI entry names", () => {
    // The node's `succeeded` is revm's is_success(): false for a revert and for a halt (out of
    // gas, an invalid opcode) alike, and the notification does not say which.
    const failed = asAppliedCall(applied(2, { succeeded: false, selector: "0xdeadbeef" }))!;
    expect(formatCall(failed, at, functionNames(ABI))).toContain("  failed  0xdeadbeef  ");
    expect(formatCall(failed, at)).not.toContain("reverted");
  });

  it("says so when the calldata had no selector, without moving the columns", () => {
    const bare = asAppliedCall(applied(3, { selector: "0x", input: "0x" }))!;
    expect(formatCall(bare, at)).toContain("  (no selector)  block 43");
    const failed = asAppliedCall(applied(2, { succeeded: false }))!;
    const short = new Map([[PLAY, "go"]]);
    for (const names of [undefined, short, functionNames(ABI)]) {
      const columns = [call, bare, failed].map((one) => formatCall(one, at, names).indexOf("block "));
      expect(new Set(columns).size, `names: ${names ? [...names.values()] : "none"}`).toBe(1);
    }
  });

  it("reads a notification a real node sent, and calls an out-of-gas halt failed", () => {
    // Verbatim from the node `interlude dev` ran for the create-interlude-app Clicker on
    // 2026-09-28 (interlude-node built for hub v3), for a click() sent with a 22000 gas limit:
    // the node ran out of gas, which is a halt and not a revert, and sent succeeded: false.
    const halted = JSON.parse(
      '{"app":"0xdc64a140aa3e981100a9beca4e685f962f0cf6c9",' +
        '"hash":"0x40af0ff26ccbb447a508d55dbaf723a6c715dd7c018f1d74325e3480fdd5e0ba",' +
        '"from":"0x70997970c51812dc3a010c7d01b50e0d17dc79c8",' +
        '"to":"0xdc64a140aa3e981100a9beca4e685f962f0cf6c9","selector":"0x7d55923d",' +
        '"input":"0x7d55923d","output":"0x","logs":[],"blockNumber":3118,"succeeded":false}',
    ) as unknown;
    const click = functionNames(parseAbi(["function click() returns (uint256)"]));
    expect(formatCall(asAppliedCall(halted)!, at, click)).toBe(
      "12:04:07.123  failed  click          block 3118  " +
        "from 0x70997970c51812dc3a010c7d01b50e0d17dc79c8  " +
        "tx 0x40af0ff26ccbb447a508d55dbaf723a6c715dd7c018f1d74325e3480fdd5e0ba",
    );
  });

  it("has no latency or gas column: the node sends neither", () => {
    expect(formatCall(call, at)).not.toMatch(/\bms\b|gas=/);
  });

  it("refuses to read a notification that is missing a field, rather than printing a default", () => {
    expect(asAppliedCall(applied(1))).toEqual({
      app: APP,
      hash: `0x${"0".repeat(63)}1`,
      from: SENDER,
      to: APP,
      selector: PLAY,
      blockNumber: 41,
      succeeded: true,
    });
    for (const missing of ["hash", "from", "selector", "blockNumber", "succeeded"]) {
      const partial = applied(1);
      delete partial[missing];
      expect(asAppliedCall(partial), missing).toBeUndefined();
    }
    expect(asAppliedCall(applied(1, { blockNumber: "41" }))).toBeUndefined();
    expect(asAppliedCall(null)).toBeUndefined();
  });
});

describe("--abi", () => {
  it("reads a JSON array, a forge artifact and the module `interlude abi` writes", () => {
    expect(parseAbiText(JSON.stringify(ABI))).toEqual(ABI);
    expect(parseAbiText(JSON.stringify({ abi: ABI, bytecode: { object: "0x" } }))).toEqual(ABI);
    expect(parseAbiText(abiModule("Grid", ABI))).toEqual(ABI);
    expect(parseAbiText("not an abi")).toBeUndefined();
    expect(parseAbiText(JSON.stringify({ bytecode: "0x" }))).toBeUndefined();
  });
});

describe("which node", () => {
  it("takes --node, then INTERLUDE_NODE_URL", () => {
    expect(chooseNode(["--follow", "--node", "http://a"], { INTERLUDE_NODE_URL: "http://b" })).toEqual({
      url: "http://a",
      from: "--node",
    });
    expect(chooseNode(["--follow"], { INTERLUDE_NODE_URL: "http://b" })).toEqual({
      url: "http://b",
      from: "INTERLUDE_NODE_URL",
    });
  });

  it("then the node ship last gave this project, and otherwise none: there is no public default", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "interlude-logs-")));
    expect(chooseNode(["--follow"], {}, dir)).toBeUndefined();

    writeFileSync(join(dir, "foundry.toml"), "[profile.default]\n");
    mkdirSync(join(dir, ".interlude"));
    const shipped = (records: unknown[]) =>
      writeFileSync(join(dir, ".interlude", "shipped.json"), JSON.stringify(records));
    shipped([{ fingerprint: "0x01", app: APP, name: "x", at: "then", complete: false }]);
    expect(chooseNode(["--follow"], {}, dir)).toBeUndefined();

    shipped([
      { fingerprint: "0x01", app: APP, url: "https://first.example", name: "x", at: "a", complete: true },
      { fingerprint: "0x02", app: SENDER, url: "https://second.example", name: "y", at: "b", complete: true },
      { fingerprint: "0x03", app: APP, name: "z", at: "c", complete: false },
    ]);
    const chosen = chooseNode(["--follow"], {}, join(dir));
    expect(chosen?.url).toBe("https://second.example");
    expect(chosen?.from).toContain(SENDER);
  });

  it("opens the socket on the node's own port, wss for https", () => {
    expect(socketUrl("http://127.0.0.1:8555")).toBe("ws://127.0.0.1:8555/");
    expect(socketUrl("https://il-eu.example.dev")).toBe("wss://il-eu.example.dev/");
    expect(socketUrl("wss://node.example/rpc")).toBe("wss://node.example/rpc");
    expect(() => socketUrl("127.0.0.1:8555")).toThrow(LogsError);
    expect(() => socketUrl("ftp://node.example")).toThrow(/not an http\(s\) or ws\(s\) URL/);
  });
});

describe("why a node refused", () => {
  const at = "ws://127.0.0.1:1/";
  it("tells an old or foreign node from a busy one", () => {
    expect(refusal(at, { code: -32601, message: "Method not found" })).toMatch(
      /has no interlude_subscribe \(-32601 Method not found\)\. It is not an Interlude node/,
    );
    expect(refusal(at, { code: -32602, message: 'unknown subscription "x"' })).toMatch(
      /refused interlude_subscribe\("applied"\) \(-32602/,
    );
    expect(
      refusal(at, { code: -32005, message: "too many requests", data: { retryAfterSecs: 3 } }),
    ).toMatch(/rate-limiting this caller .* Try again in 3s/);
  });

  it("tells a node turning the socket away from one that is not there", () => {
    expect(unreachable(at, "Unexpected server response: 429")).toMatch(
      /^ws:\/\/127\.0\.0\.1:1\/ turned the WebSocket away \(Unexpected server response: 429\): this machine has too many sockets open/,
    );
    expect(unreachable(at, "Unexpected server response: 429")).not.toContain("Is the node running");
    expect(unreachable(at, "connect ECONNREFUSED 127.0.0.1:1")).toMatch(
      /^could not open a WebSocket to ws:\/\/127\.0\.0\.1:1\/: connect ECONNREFUSED 127\.0\.0\.1:1\.\n {2}Is the node running/,
    );
    expect(unreachable("ws://127.0.0.1:429/", "connect ECONNREFUSED 127.0.0.1:429")).toContain(
      "Is the node running",
    );
    expect(unreachable(at, "")).toMatch(/^could not open a WebSocket to ws:\/\/127\.0\.0\.1:1\/\.\n/);
  });
});

// --- following a node ------------------------------------------------------------

const implementations: [string, SocketFactory | undefined][] = [
  ["the ws package (Node 20)", (url) => new ws.WebSocket(url)],
  [
    "the global WebSocket (Node 22+)",
    typeof (globalThis as { WebSocket?: unknown }).WebSocket === "function"
      ? (url) => new (globalThis as unknown as { WebSocket: new (url: string) => Socket }).WebSocket(url)
      : undefined,
  ],
];

for (const [name, socket] of implementations) {
  describe.skipIf(!socket)(`following a node through ${name}`, () => {
    const open = socket!;

    it("prints one line per call the node pushes, then says the node hung up", async () => {
      const node = await fakeNode(streams([applied(1), applied(2, { succeeded: false })]));
      const heard = await hear(node, open, { names: functionNames(ABI) });
      expect(heard.lines).toEqual([
        `12:04:07.123  ok      ${"play".padEnd(20)}  block 41  from ${SENDER}  tx 0x${"0".repeat(63)}1`,
        `12:04:07.133  failed  ${"play".padEnd(20)}  block 42  from ${SENDER}  tx 0x${"0".repeat(63)}2`,
      ]);
      expect(heard.status[0]).toMatch(/^following ws:\/\/127\.0\.0\.1:\d+\/ \(interlude_subscribe "applied"\)/);
      expect(heard.error?.message).toMatch(/closed the stream \(code 1000, bye\)/);
    });

    it("--json passes the notification through as sent, plus receivedAt and the ABI's name", async () => {
      const call = applied(7);
      const node = await fakeNode(streams([call]));
      const heard = await hear(node, open, { json: true, names: functionNames(ABI) });
      expect(heard.lines).toHaveLength(1);
      expect(JSON.parse(heard.lines[0]!)).toEqual({
        receivedAt: "2026-09-28T12:04:07.123Z",
        function: "play",
        ...call,
      });
    });

    it("--json without --abi adds receivedAt and nothing else", async () => {
      const call = applied(8);
      const node = await fakeNode(streams([call]));
      const heard = await hear(node, open, { json: true });
      expect(JSON.parse(heard.lines[0]!)).toEqual({ receivedAt: "2026-09-28T12:04:07.123Z", ...call });
    });

    it("skips a notification that is not an applied call instead of inventing its fields", async () => {
      const node = await fakeNode(streams([{ hello: "world" }, applied(3)]));
      const heard = await hear(node, open);
      expect(heard.lines).toHaveLength(1);
      expect(heard.lines[0]).toContain("block 43");
      expect(heard.status).toContain(
        'skipped a notification that is not an applied call: {"hello":"world"}',
      );
    });

    it("ignores notifications for another subscription", async () => {
      const notify = (subscription: string, result: unknown) =>
        JSON.stringify({ jsonrpc: "2.0", method: "interlude_subscribe", params: { subscription, result } });
      const node = await fakeNode((peer, request) => {
        peer.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "0xabc" }));
        peer.send(notify("0xdef", applied(1)));
        peer.send(notify("0xabc", applied(2)));
        setTimeout(() => peer.close(), 50);
      });
      const heard = await hear(node, open);
      expect(heard.lines).toHaveLength(1);
      expect(heard.lines[0]).toContain("block 42");
    });

    it("prints nothing and says why when nothing listens there", async () => {
      const port = await closedPort();
      const heard = await hear(`http://127.0.0.1:${port}`, open);
      expect(heard.lines).toEqual([]);
      expect(heard.status).toEqual([]);
      expect(heard.error).toBeInstanceOf(LogsError);
      expect(heard.error?.message).toContain(`could not open a WebSocket to ws://127.0.0.1:${port}/`);
      expect(heard.error?.message).toContain("Is the node running, and is this its RPC URL?");
    });

    it("prints nothing when the node does not serve interlude_subscribe", async () => {
      const node = await fakeNode((peer, request) => {
        const error = { code: -32601, message: "Method not found" };
        peer.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, error }));
      });
      const heard = await hear(node, open);
      expect(heard.lines).toEqual([]);
      expect(heard.error?.message).toMatch(/has no interlude_subscribe \(-32601 Method not found\)/);
    });

    it("prints nothing when the socket opens and the subscription is never answered", async () => {
      const node = await fakeNode(() => undefined);
      const heard = await hear(node, open, { connectTimeoutMs: 300 });
      expect(heard.lines).toEqual([]);
      expect(heard.error?.message).toMatch(/did not answer interlude_subscribe within 0\.3s/);
    });

    it("prints nothing when the URL is an HTTP server that does not upgrade", async () => {
      const server = createServer((_req, res) => {
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const heard = await hear(`http://127.0.0.1:${port}`, open);
      expect(heard.lines).toEqual([]);
      expect(heard.error?.message).toContain(`could not open a WebSocket to ws://127.0.0.1:${port}/`);
    });

    it("stops cleanly when asked", async () => {
      const node = await fakeNode((peer, request) =>
        peer.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: 1 })),
      );
      const status: string[] = [];
      const following = follow({ node, socket: open, write: () => undefined, status: (l) => status.push(l) });
      while (status.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      following.stop();
      await expect(following.done).resolves.toBeUndefined();
    });
  });
}

describe("following a node through the ws package, which says why a socket failed", () => {
  it("prints nothing and says the node turned the socket away when it answers 429", async () => {
    // What the node answers an upgrade from a caller over INTERLUDE_WS_PER_CALLER (lib.rs,
    // too_many_sockets) or out of request budget (limit.rs, too_many).
    const server = createServer((_req, res) => res.end());
    server.on("upgrade", (_req, socket) => {
      socket.end(
        "HTTP/1.1 429 Too Many Requests\r\nretry-after: 5\r\ncontent-length: 44\r\n\r\n" +
          "Too many open WebSockets from this caller.\n",
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const heard = await hear(`http://127.0.0.1:${port}`, (url) => new ws.WebSocket(url));
    expect(heard.lines).toEqual([]);
    expect(heard.status).toEqual([]);
    expect(heard.error?.message).toMatch(
      new RegExp(`^ws://127\\.0\\.0\\.1:${port}/ turned the WebSocket away \\(Unexpected server response: 429\\)`),
    );
  });
});

// --- the command, run the way a user runs it ---------------------------------------

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], cwd: string, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(tsx, [entry, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1", INTERLUDE_NODE_URL: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("interlude logs --follow", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "interlude-logs-cli-")));

  it("exits 1 and prints nothing on stdout without a live node", async () => {
    const port = await closedPort();
    const run = await cli(["logs", "--follow", "--node", `http://127.0.0.1:${port}`], cwd);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(`could not open a WebSocket to ws://127.0.0.1:${port}/`);
    expect(run.stderr).not.toMatch(/session\.send|gas=0|\d+ms/);
  }, 30_000);

  it("exits 1 and asks which node when none is given and nothing was shipped here", async () => {
    const run = await cli(["logs", "--follow"], cwd);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/which node\? Pass --node <url>/);
  }, 30_000);

  it("streams what a node sends, on this Node's WebSocket", async () => {
    const node = await fakeNode(streams([applied(5)]));
    const abiPath = join(cwd, "abi.ts");
    writeFileSync(abiPath, abiModule("Grid", ABI));
    const run = await cli(["logs", "--follow", "--node", node, "--abi", abiPath], cwd);
    expect(run.stdout).toMatch(
      new RegExp(`^\\d\\d:\\d\\d:\\d\\d\\.\\d{3} {2}ok {6}play {18}block 45 {2}from ${SENDER} {2}tx 0x0{63}5\\n$`),
    );
    expect(run.stderr).toMatch(/following ws:\/\/127\.0\.0\.1:\d+\/ \(interlude_subscribe "applied"\)/);
    // The node hung up: that is the end of the stream, not a success.
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/closed the stream \(code 1000, bye\)/);
  }, 30_000);

  it("says what the columns are, and nothing about latency", async () => {
    const run = await cli(["logs", "--help"], cwd);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("interlude logs --follow [--node <url>] [--abi <file>] [--json]");
    expect(run.stdout).toContain("<time>  <status>  <function>  block <n>  from <sender>  tx <hash>");
    expect(run.stdout).toContain("status    ok, or failed: the node's succeeded flag");
    expect(run.stdout).toMatch(/plus two keys\s+this command adds: receivedAt and, with --abi, function/);
    expect(run.stdout).toMatch(/falls far behind the node misses\s+calls, and the node does not say which/);
    expect(run.stdout).not.toMatch(/recorded|session\.send|reverted/);
  }, 30_000);
});
