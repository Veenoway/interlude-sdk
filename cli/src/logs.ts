/**
 * `interlude logs --follow`: every call a node runs, as the node reports it.
 *
 * One `interlude_subscribe("applied")` socket, and one line per notification. Every field on the
 * line is one the node sent (`AppliedCall` in packages/node/crates/interlude-rpc/src/node.rs),
 * except the time, which is when this machine received it and says so. Nothing is measured here
 * and nothing is filled in: this used to print a recorded sample, with a latency and a gas figure
 * nobody had measured, whenever the socket failed — which on Node 20, with no global WebSocket,
 * was every time. A node that cannot be reached or will not stream is now an error, and the
 * command exits 1 without printing a line.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { toFunctionSelector, toFunctionSignature, type Abi, type AbiFunction } from "viem";

import { findProjectRoot } from "./artifacts.js";
import { flag } from "./project.js";
import { readShipRecords } from "./ship.js";
import { dim, fail, say } from "./ui.js";

/** How long the socket has to open and the node to accept the subscription. */
export const CONNECT_TIMEOUT_MS = 10_000;

const SUBSCRIBE_ID = 1;

const USAGE = "interlude logs --follow [--node <url>] [--abi <file>] [--json]";

const HELP =
  `${USAGE}\n\n` +
  `Stream every call a node runs, as the node reports it (interlude_subscribe "applied").\n` +
  `One line per call:\n\n` +
  `  <time>  <status>  <function>  block <n>  from <sender>  tx <hash>\n\n` +
  `  time      when this machine received the notification (UTC), not a latency\n` +
  `  status    ok, or failed: the node's succeeded flag, which is false for a revert and\n` +
  `            for a halt such as running out of gas\n` +
  `  function  its name from --abi, else the 4-byte selector the node sent\n` +
  `  block     the node's block. Which batch settles it is decided at commit, and the\n` +
  `            notification does not carry it\n\n` +
  `  --node <url>  the node's RPC URL, http(s) or ws(s). Default: INTERLUDE_NODE_URL, then the\n` +
  `                node \`interlude ship\` last gave this project (.interlude/shipped.json)\n` +
  `  --abi <file>  a JSON ABI, a forge artifact (out/X.sol/X.json) or the module\n` +
  `                \`interlude abi --out\` wrote, to name functions\n` +
  `  --json        one JSON object per call: the node's notification as sent, plus two keys\n` +
  `                this command adds: receivedAt and, with --abi, function\n\n` +
  `Only what the node sends is printed. A follower that falls far behind the node misses\n` +
  `calls, and the node does not say which. When the node cannot be reached or refuses the\n` +
  `subscription, this exits 1 with the reason and prints nothing on stdout.`;

/** A reason `logs` stopped, in a sentence for the reader. */
export class LogsError extends Error {}

/**
 * What interlude-rpc pushes after every call (`AppliedCall`, camelCase). `input`, `output` and
 * `logs` are carried by `--json` as sent; the line prints the rest.
 */
export interface AppliedCall {
  app: string;
  hash: string;
  from: string;
  to: string;
  selector: string;
  blockNumber: number;
  succeeded: boolean;
}

/**
 * The notification's `result`, if it has the shape the node sends. Anything missing is a reason
 * not to print the line at all, rather than a field to print as zero or "ok".
 */
export function asAppliedCall(value: unknown): AppliedCall | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const hex = (key: string) =>
    typeof record[key] === "string" && /^0x[0-9a-fA-F]*$/.test(record[key] as string);
  if (!["app", "hash", "from", "to", "selector"].every(hex)) return undefined;
  if (typeof record.blockNumber !== "number" || !Number.isSafeInteger(record.blockNumber)) {
    return undefined;
  }
  if (typeof record.succeeded !== "boolean") return undefined;
  return {
    app: record.app as string,
    hash: record.hash as string,
    from: record.from as string,
    to: record.to as string,
    selector: record.selector as string,
    blockNumber: record.blockNumber,
    succeeded: record.succeeded,
  };
}

/** What the function column says for calldata shorter than four bytes (the node sends `0x`). */
const NO_SELECTOR = "(no selector)";

/**
 * The function column is at least this wide: a bare selector (`0x` and four bytes) and the
 * no-selector label both fit, so a column never moves from one line to the next.
 */
const FUNCTION_WIDTH = NO_SELECTOR.length;

/**
 * `succeeded: false` is revm's `!is_success()`: a revert, or a halt such as out of gas. The
 * notification does not say which, so the line does not either.
 */
const STATUS = { ok: "ok", failed: "failed" } as const;

/** A function's name, or its selector when no ABI names it. */
export function functionLabel(selector: string, names?: ReadonlyMap<string, string>): string {
  if (selector === "0x") return NO_SELECTOR;
  return names?.get(selector.toLowerCase()) ?? selector;
}

export function formatCall(
  call: AppliedCall,
  receivedAt: Date,
  names?: ReadonlyMap<string, string>,
): string {
  const width = Math.max(FUNCTION_WIDTH, ...[...(names?.values() ?? [])].map((name) => name.length));
  const stamp = receivedAt.toISOString().slice(11, 23);
  const status = (call.succeeded ? STATUS.ok : STATUS.failed).padEnd(STATUS.failed.length);
  const fn = functionLabel(call.selector, names).padEnd(width);
  return `${stamp}  ${status}  ${fn}  block ${call.blockNumber}  from ${call.from}  tx ${call.hash}`;
}

/**
 * `--json`: the node's notification untouched, plus the two keys this command adds and the help
 * names — when it arrived and, from `--abi`, the function's name.
 */
export function formatCallJson(
  result: Record<string, unknown>,
  call: AppliedCall,
  receivedAt: Date,
  names?: ReadonlyMap<string, string>,
): string {
  const named = names?.get(call.selector.toLowerCase());
  return JSON.stringify({
    receivedAt: receivedAt.toISOString(),
    ...(named ? { function: named } : {}),
    ...result,
  });
}

// --- naming functions -------------------------------------------------------

/** Selector to name, or to the full signature where the ABI overloads the name. */
export function functionNames(abi: Abi): Map<string, string> {
  const functions = abi.filter((item): item is AbiFunction => item.type === "function");
  const seen = new Map<string, number>();
  for (const fn of functions) seen.set(fn.name, (seen.get(fn.name) ?? 0) + 1);
  const names = new Map<string, string>();
  for (const fn of functions) {
    const overloaded = (seen.get(fn.name) ?? 0) > 1;
    names.set(toFunctionSelector(fn).toLowerCase(), overloaded ? toFunctionSignature(fn) : fn.name);
  }
  return names;
}

/** A JSON ABI, a forge artifact, or the `export const abi = [...] as const` of `interlude abi`. */
export function parseAbiText(text: string): Abi | undefined {
  const module = /export const abi = ([\s\S]*?) as const;?\s*$/.exec(text)?.[1];
  for (const candidate of [text, module]) {
    if (candidate === undefined) continue;
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    const abi = Array.isArray(value) ? value : (value as { abi?: unknown } | null)?.abi;
    if (Array.isArray(abi)) return abi as Abi;
  }
  return undefined;
}

function readAbi(path: string): Abi {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new LogsError(`cannot read --abi ${path}: ${(error as Error).message}`);
  }
  const abi = parseAbiText(text);
  if (!abi) {
    throw new LogsError(
      `${path} is not an ABI. Pass a JSON ABI, a forge artifact (out/X.sol/X.json) or the ` +
        `module \`interlude abi --out\` wrote.`,
    );
  }
  return abi;
}

// --- which node -------------------------------------------------------------

export interface NodeChoice {
  url: string;
  /** Where the URL came from, printed so nobody mistakes one node's traffic for another's. */
  from: string;
}

/**
 * `--node`, then INTERLUDE_NODE_URL, then the node `ship` last gave this project. There is no
 * public default: following somebody else's node would print real calls that are not yours.
 */
export function chooseNode(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): NodeChoice | undefined {
  const given = flag(argv, "--node");
  if (given !== undefined) return { url: given, from: "--node" };
  const fromEnv = env["INTERLUDE_NODE_URL"];
  if (fromEnv) return { url: fromEnv, from: "INTERLUDE_NODE_URL" };
  let root: string;
  try {
    root = findProjectRoot(cwd);
  } catch {
    return undefined;
  }
  const shipped = [...readShipRecords(root)]
    .reverse()
    .find((record) => record.complete && typeof record.url === "string" && record.url !== "");
  if (!shipped?.url) return undefined;
  return { url: shipped.url, from: `the node \`interlude ship\` gave ${shipped.app}` };
}

/** The node's HTTP URL as a WebSocket: jsonrpsee serves both on one port. https becomes wss. */
export function socketUrl(node: string): string {
  let url: URL;
  try {
    url = new URL(node);
  } catch {
    throw new LogsError(
      `--node ${node} is not a URL. Pass the node's RPC URL: http://127.0.0.1:8555 for ` +
        `\`interlude dev\`, or the one \`interlude ship\` / \`interlude sessions get <app>\` printed.`,
    );
  }
  if (url.protocol === "https:" || url.protocol === "wss:") url.protocol = "wss:";
  else if (url.protocol === "http:" || url.protocol === "ws:") url.protocol = "ws:";
  else {
    throw new LogsError(`--node ${node} is not an http(s) or ws(s) URL.`);
  }
  return url.toString();
}

// --- the socket -------------------------------------------------------------

/** The part of a WebSocket this uses: the WHATWG one Node 22 has, and the `ws` package's. */
export interface Socket {
  addEventListener(type: string, listener: (event: never) => void): void;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string) => Socket;

type SocketClass = new (url: string) => Socket;

/**
 * The `ws` package, on every Node. Node 20 has no global WebSocket; Node 22's reports a failed
 * connection as a bare error event, where `ws` says why ("connect ECONNREFUSED 127.0.0.1:8555",
 * "Unexpected server response: 404") — and why is the whole message when a node cannot be
 * reached. viem already depends on it, so an install normally holds one copy for both. The
 * global is the fallback for a build that bundled the CLI without its dependencies.
 */
export function defaultSocketFactory(): SocketFactory {
  let Impl: SocketClass | undefined;
  try {
    Impl = (createRequire(import.meta.url)("ws") as { WebSocket: SocketClass }).WebSocket;
  } catch {
    Impl = (globalThis as { WebSocket?: SocketClass }).WebSocket;
  }
  if (typeof Impl !== "function") {
    throw new LogsError("no WebSocket here: install the `ws` package, or run on Node 22 or later.");
  }
  const Socket = Impl;
  return (url) => new Socket(url);
}

export interface FollowOptions {
  node: string;
  /** Selector to name, from `--abi`. */
  names?: ReadonlyMap<string, string>;
  json?: boolean;
  /** One line per call. */
  write: (line: string) => void;
  /** Everything that is not a call: the node followed, a notification skipped. */
  status: (line: string) => void;
  socket?: SocketFactory;
  connectTimeoutMs?: number;
  now?: () => Date;
}

export interface Following {
  /** Rejects with a `LogsError` when the stream cannot start or ends; resolves after `stop()`. */
  done: Promise<void>;
  stop(): void;
}

type RpcError = { code?: unknown; message?: unknown; data?: unknown };

type Frame =
  | { kind: "answer"; id: unknown; result?: unknown; error?: RpcError }
  | { kind: "notification"; subscription: unknown; result: unknown }
  | { kind: "other" };

function readFrame(data: unknown): Frame | undefined {
  // jsonrpsee sends text frames; a binary one is decoded rather than dropped.
  let text: string;
  if (typeof data === "string") text = data;
  else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString("utf8");
  else if (data instanceof Uint8Array) text = Buffer.from(data).toString("utf8");
  else return undefined;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { kind: "other" };
  const record = body as Record<string, unknown>;
  if ("id" in record && ("result" in record || "error" in record)) {
    return {
      kind: "answer",
      id: record.id,
      result: record.result,
      ...(record.error && typeof record.error === "object" ? { error: record.error as RpcError } : {}),
    };
  }
  const params = record.params as { subscription?: unknown; result?: unknown } | undefined;
  if (params && typeof params === "object" && "subscription" in params && "result" in params) {
    return { kind: "notification", subscription: params.subscription, result: params.result };
  }
  return { kind: "other" };
}

/** Why the node would not subscribe, and what to do about it. */
export function refusal(ws: string, error: RpcError): string {
  const code = typeof error.code === "number" ? error.code : undefined;
  const said = `${code ?? "error"}${typeof error.message === "string" ? ` ${error.message}` : ""}`;
  if (code === -32601) {
    return (
      `${ws} has no interlude_subscribe (${said}). It is not an Interlude node, or one too old ` +
      `to stream the calls it runs: point --node at an Interlude node, or upgrade this one.`
    );
  }
  if (code === -32602) {
    return (
      `${ws} refused interlude_subscribe("applied") (${said}). This node does not stream ` +
      `applied calls; upgrade it.`
    );
  }
  if (code === -32005) {
    const data = error.data as { retryAfterSecs?: unknown } | undefined;
    const secs = typeof data?.retryAfterSecs === "number" ? data.retryAfterSecs : undefined;
    const when = secs ? ` in ${secs}s` : " shortly";
    return `${ws} is rate-limiting this caller (${said}). Try again${when}.`;
  }
  return `${ws} refused interlude_subscribe (${said}).`;
}

const REACH_HINT =
  `  Is the node running, and is this its RPC URL? \`interlude dev\` serves one on ` +
  `http://127.0.0.1:8555; \`interlude sessions get <app>\` prints a hosted one.\n` +
  `  The node streams on the port it serves JSON-RPC on. A proxy in front of it has to pass ` +
  `WebSocket upgrades.`;

/**
 * Why no socket opened. A 429 is the node reached and turning this caller away — too many
 * sockets open from here (`INTERLUDE_WS_PER_CALLER`, 64 by default) or its request budget spent —
 * which "is the node running?" would send the reader looking in the wrong place for.
 */
export function unreachable(ws: string, reason: string): string {
  if (/server response: 429\b/.test(reason)) {
    return (
      `${ws} turned the WebSocket away (${reason}): this machine has too many sockets open to ` +
      `it, or has spent its request budget. Close other followers of this node and try again ` +
      `in a few seconds.`
    );
  }
  const why = reason ? `: ${reason}` : "";
  return `could not open a WebSocket to ${ws}${why}.\n${REACH_HINT}`;
}

/** What an error or close event says, from either WebSocket implementation. */
function eventReason(event: unknown): string {
  const e = event as {
    message?: unknown;
    error?: { message?: unknown; cause?: { message?: unknown } };
    reason?: unknown;
  };
  for (const text of [e?.message, e?.error?.message, e?.error?.cause?.message, e?.reason]) {
    if (typeof text === "string" && text.trim() !== "") return text.trim();
  }
  return "";
}

/**
 * Subscribe and print each call as it arrives.
 *
 * Nothing is written through `write` until the node has accepted the subscription and sent a
 * notification, so a node that is down, wrong or refusing leaves stdout empty.
 */
export function follow(options: FollowOptions): Following {
  const ws = socketUrl(options.node);
  const open = options.socket ?? defaultSocketFactory();
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;

  let socket: Socket | undefined;
  let stopped = false;
  let opened = false;
  let subscription: unknown;
  let subscribed = false;
  let lastError = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settle!: { resolve: () => void; reject: (error: LogsError) => void };

  const done = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });

  let finished = false;
  const finish = (error?: LogsError) => {
    if (finished) return;
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
    try {
      socket?.close();
    } catch {
      // Already closed.
    }
    if (error) settle.reject(error);
    else settle.resolve();
  };

  try {
    socket = open(ws);
  } catch (error) {
    const why = (error as Error).message;
    finish(new LogsError(`could not open a WebSocket to ${ws}: ${why}\n${REACH_HINT}`));
    return { done, stop: () => undefined };
  }

  timer = setTimeout(() => {
    finish(
      new LogsError(
        opened
          ? `${ws} opened a WebSocket and did not answer interlude_subscribe within ` +
              `${timeoutMs / 1000}s. It may not be an Interlude node.`
          : `no WebSocket to ${ws} within ${timeoutMs / 1000}s.\n${REACH_HINT}`,
      ),
    );
  }, timeoutMs);

  socket.addEventListener("open", () => {
    opened = true;
    socket!.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: SUBSCRIBE_ID,
        method: "interlude_subscribe",
        params: ["applied"],
      }),
    );
  });

  socket.addEventListener("message", (event: { data?: unknown }) => {
    if (finished) return;
    const frame = readFrame(event.data);
    if (!frame || frame.kind === "other") return;
    if (frame.kind === "answer") {
      if (frame.id !== SUBSCRIBE_ID || subscribed) return;
      if (frame.error) {
        finish(new LogsError(refusal(ws, frame.error)));
        return;
      }
      subscribed = true;
      subscription = frame.result;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      options.status(
        `following ${ws} (interlude_subscribe "applied"). Times are when each call reached ` +
          `this machine, UTC. Ctrl-C to stop.`,
      );
      return;
    }
    if (!subscribed || String(frame.subscription) !== String(subscription)) return;
    const call = asAppliedCall(frame.result);
    if (!call) {
      const raw = JSON.stringify(frame.result) ?? String(frame.result);
      const shown = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
      options.status(`skipped a notification that is not an applied call: ${shown}`);
      return;
    }
    const at = now();
    options.write(
      options.json
        ? formatCallJson(frame.result as Record<string, unknown>, call, at, options.names)
        : formatCall(call, at, options.names),
    );
  });

  socket.addEventListener("error", (event: unknown) => {
    lastError = eventReason(event) || lastError;
  });

  socket.addEventListener("close", (event: { code?: unknown; reason?: unknown }) => {
    if (stopped) {
      finish();
      return;
    }
    const code = typeof event.code === "number" ? event.code : undefined;
    const reason = eventReason(event) || lastError;
    const how = [code !== undefined ? `code ${code}` : "", reason].filter(Boolean).join(", ");
    const said = how ? ` (${how})` : "";
    if (subscribed) {
      finish(new LogsError(`${ws} closed the stream${said}. Run the command again to reconnect.`));
    } else if (opened) {
      finish(
        new LogsError(
          `${ws} accepted the WebSocket and closed it before answering interlude_subscribe` +
            `${said}. It may not be an Interlude node.`,
        ),
      );
    } else {
      finish(new LogsError(unreachable(ws, reason)));
    }
  });

  return {
    done,
    stop() {
      stopped = true;
      finish();
    },
  };
}

// --- the command ------------------------------------------------------------

export async function logs(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    say(HELP);
    return;
  }
  if (!argv.includes("--follow")) {
    fail(`usage: ${USAGE}`);
  }

  const node = chooseNode(argv);
  if (!node) {
    fail(
      `which node? Pass --node <url> (http://127.0.0.1:8555 for \`interlude dev\`), set ` +
        `INTERLUDE_NODE_URL, or run this in a project \`interlude ship\` has shipped.`,
    );
  }

  try {
    const abiPath = flag(argv, "--abi");
    const names = abiPath ? functionNames(readAbi(abiPath)) : undefined;
    const status = (line: string) => process.stderr.write(`${dim(line)}\n`);
    if (node.from !== "--node") status(`node from ${node.from}: ${node.url}`);
    const following = follow({
      node: node.url,
      ...(names ? { names } : {}),
      json: argv.includes("--json"),
      write: (line) => process.stdout.write(`${line}\n`),
      status,
    });
    await following.done;
  } catch (error) {
    if (error instanceof LogsError) fail(error.message);
    throw error;
  }
}
