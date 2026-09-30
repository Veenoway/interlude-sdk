import type { Address, Hex } from "viem";

/** One log the call left, in the ordinary Ethereum shape. */
export type AppliedLog = {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
};

/**
 * What the node just executed. Not a view of any particular app.
 *
 * Same payload whether the contract is a clock, a room or something you have not written yet.
 * Decode `logs` / `output` against your ABI, or call `watchRead` for a view.
 */
export type AppliedCall = {
  app: Address;
  hash: Hex;
  from: Address;
  to: Address;
  selector: Hex;
  input: Hex;
  output: Hex;
  logs: readonly AppliedLog[];
  blockNumber: number;
  succeeded: boolean;
};

/**
 * The same URL the HTTP client already has, as a WebSocket.
 *
 * jsonrpsee serves both on one port. A page that POSTs to `http://127.0.0.1:8556` opens
 * `ws://127.0.0.1:8556` for `interlude_subscribe`. https becomes wss.
 */
export function nodeSocketUrl(httpUrl: string): string {
  const url = new URL(httpUrl, "http://localhost");
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  return url.toString();
}

export interface WatchOptions {
  /** Runs on a timer while the socket is down, so a page still moves — just slower. */
  fallback?: () => void;
  /**
   * How often `fallback` runs while the socket is down. Default 1000 ms: every tick is a
   * request per watcher, and a page of watchers polling at 80 ms was a load test.
   */
  fallbackMs?: number;
}

/**
 * One `interlude_subscribe("applied")` socket, shared by every listener on a node.
 *
 * A socket per hook meant five hooks on a page were five sockets carrying the same frames, and
 * a node caps connections well before a busy page does. The socket opens with the first
 * listener and closes with the last.
 */
export interface AppliedFeed {
  subscribe(onCall: (call: AppliedCall) => void, options?: WatchOptions): () => void;
  /** Whether the socket is subscribed right now. False while connecting, down, or refused. */
  readonly live: boolean;
  /** How many sockets this feed has opened in its life. For tests and for a status line. */
  readonly sockets: number;
}

/** Reconnect delays: quick for a blip, capped so a dead node is not hammered. */
const FIRST_WAIT_MS = 250;
const MAX_WAIT_MS = 30_000;
const DEFAULT_FALLBACK_MS = 1000;

type Phase = "idle" | "connecting" | "live" | "down" | "unsupported";

interface Listener {
  onCall: (call: AppliedCall) => void;
  fallback?: () => void;
  fallbackMs: number;
  timer?: ReturnType<typeof setInterval>;
}

/**
 * Hear every call as it lands, not on a timer, through one socket per node.
 *
 * If the socket dies it reconnects with a backoff capped at 30 s, and every listener's
 * `fallback` polls meanwhile. How the node refuses the subscription decides what happens next:
 *
 * - "method not found" (-32601) or "invalid params" (-32602) means the node is too old to serve
 *   `interlude_subscribe("applied")`. Asking again will not change its answer, so the feed stops
 *   reconnecting and stays on the fallback until its last listener leaves. A later subscriber
 *   probes once more — the node may have been upgraded in the meantime.
 * - anything else — above all the node's -32005 rate limit, which a room of players behind one
 *   IP or a reconnect during a burst of calls will hit — is transient. The feed polls, waits at
 *   least the `retryAfterSecs` the node asked for (and at least its backoff), and tries the
 *   socket again. Treating a rate limit as "unsupported" used to leave every watcher on the page
 *   polling for good after one busy second.
 */
export function createAppliedFeed(nodeUrl: string): AppliedFeed {
  const listeners = new Set<Listener>();
  let phase: Phase = "idle";
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let wait = FIRST_WAIT_MS;
  let nextId = 1;
  let opened = 0;

  const polling = () => phase === "down" || phase === "unsupported";

  const startFallback = (listener: Listener) => {
    const fallback = listener.fallback;
    if (!fallback || listener.timer !== undefined) return;
    safely(fallback);
    listener.timer = setInterval(() => safely(fallback), listener.fallbackMs);
  };

  const stopFallback = (listener: Listener) => {
    if (listener.timer === undefined) return;
    clearInterval(listener.timer);
    listener.timer = undefined;
  };

  const enter = (next: Phase) => {
    phase = next;
    for (const listener of listeners) {
      if (polling()) startFallback(listener);
      else stopFallback(listener);
    }
  };

  /** Reconnect after the backoff, or after `atLeastMs` if the node asked for longer. */
  const schedule = (atLeastMs = 0) => {
    if (retry !== undefined || listeners.size === 0) return;
    retry = setTimeout(open, Math.min(Math.max(wait, atLeastMs), MAX_WAIT_MS));
    wait = Math.min(wait * 2, MAX_WAIT_MS);
  };

  function open() {
    retry = undefined;
    if (listeners.size === 0 || phase === "unsupported") return;
    if (typeof WebSocket === "undefined") {
      enter("unsupported");
      return;
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(nodeSocketUrl(nodeUrl));
    } catch {
      enter("down");
      schedule();
      return;
    }
    socket = ws;
    opened++;
    const id = nextId++;
    // A reconnect keeps polling until the new socket is subscribed; a first connect waits.
    if (phase !== "down") phase = "connecting";

    ws.addEventListener("open", () => {
      if (socket !== ws) {
        ws.close();
        return;
      }
      ws.send(
        JSON.stringify({ jsonrpc: "2.0", id, method: "interlude_subscribe", params: ["applied"] }),
      );
    });

    ws.addEventListener("message", (event) => {
      if (socket !== ws) return;
      const parsed = parseFrame(event.data);
      if (!parsed) return;
      if (parsed.kind === "error" && parsed.id === id) {
        socket = null;
        ws.close();
        if (isPermanentRefusal(parsed.code)) {
          // The node does not serve this subscription. The fallback carries the page from here.
          enter("unsupported");
          return;
        }
        // Rate limited or briefly unwell: poll meanwhile and come back when it said to.
        enter("down");
        schedule(parsed.retryAfterMs);
        return;
      }
      if (parsed.kind === "result" && parsed.id === id) {
        wait = FIRST_WAIT_MS;
        enter("live");
        return;
      }
      if (parsed.kind === "call") {
        if (phase !== "live") {
          wait = FIRST_WAIT_MS;
          enter("live");
        }
        for (const listener of [...listeners]) safely(() => listener.onCall(parsed.call));
      }
    });

    ws.addEventListener("error", () => {
      // `close` follows. Do not double-schedule.
    });

    ws.addEventListener("close", () => {
      if (socket !== ws) return;
      socket = null;
      if (listeners.size === 0 || phase === "unsupported") return;
      enter("down");
      schedule();
    });
  }

  const shutdown = () => {
    if (retry !== undefined) clearTimeout(retry);
    retry = undefined;
    const ws = socket;
    socket = null;
    ws?.close();
    // "unsupported" is forgotten too: the next subscriber asks the node again, once.
    phase = "idle";
    wait = FIRST_WAIT_MS;
  };

  return {
    subscribe(onCall, options) {
      const listener: Listener = {
        onCall,
        fallbackMs: options?.fallbackMs ?? DEFAULT_FALLBACK_MS,
        ...(options?.fallback ? { fallback: options.fallback } : {}),
      };
      listeners.add(listener);
      if (polling()) startFallback(listener);
      if (socket === null && retry === undefined && phase !== "unsupported") open();

      return () => {
        if (!listeners.delete(listener)) return;
        stopFallback(listener);
        if (listeners.size === 0) shutdown();
      };
    },
    get live() {
      return phase === "live";
    },
    get sockets() {
      return opened;
    },
  };
}

/**
 * Hear every call as it lands, on a socket of its own.
 *
 * Opens `interlude_subscribe("applied")`. If the socket dies or the node is too old to
 * serve it, the optional `fallback` runs so a page still moves — just slower. A client's
 * `watch` / `watchRead` share one socket instead; this is for a caller with no client.
 */
export function watchApplied(
  nodeUrl: string,
  onCall: (call: AppliedCall) => void,
  options?: WatchOptions,
): () => void {
  return createAppliedFeed(nodeUrl).subscribe(onCall, options);
}

/** A listener that throws must not take the feed, or the other listeners, down with it. */
function safely(run: () => void): void {
  try {
    run();
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}

/**
 * Refusals that asking again cannot change: the node has no such method (-32601) or no such
 * topic (-32602). Every other code — -32005 above all — is worth retrying.
 */
function isPermanentRefusal(code: number | undefined): boolean {
  return code === -32601 || code === -32602;
}

type Frame =
  | { kind: "result"; id: number }
  | { kind: "error"; id: number; code?: number; retryAfterMs: number }
  | { kind: "call"; call: AppliedCall };

function parseFrame(raw: unknown): Frame | null {
  let text: string;
  if (typeof raw === "string") text = raw;
  else if (raw instanceof ArrayBuffer) text = new TextDecoder().decode(raw);
  else return null;

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;

  if (typeof record.id === "number" && record.error) {
    const error = record.error as { code?: unknown; data?: unknown };
    const data = error && typeof error === "object" ? (error.data as Record<string, unknown>) : undefined;
    const secs = data && typeof data === "object" ? Number(data.retryAfterSecs) : NaN;
    return {
      kind: "error",
      id: record.id,
      ...(typeof error?.code === "number" ? { code: error.code } : {}),
      retryAfterMs: Number.isFinite(secs) && secs > 0 ? secs * 1000 : 0,
    };
  }
  if (typeof record.id === "number" && "result" in record) {
    return { kind: "result", id: record.id };
  }

  const params = record.params;
  if (!params || typeof params !== "object") return null;
  const result = (params as { result?: unknown }).result;
  const call = asApplied(result);
  return call ? { kind: "call", call } : null;
}

function asApplied(value: unknown): AppliedCall | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.hash !== "string" || typeof record.from !== "string") return null;
  if (typeof record.to !== "string") return null;
  const blockNumber =
    typeof record.blockNumber === "number"
      ? record.blockNumber
      : typeof record.blockNumber === "string"
        ? Number(record.blockNumber)
        : 0;
  const logs = Array.isArray(record.logs)
    ? record.logs.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const log = item as Record<string, unknown>;
        if (typeof log.address !== "string" || typeof log.data !== "string") return [];
        const topics = Array.isArray(log.topics)
          ? log.topics.filter((topic): topic is Hex => typeof topic === "string")
          : [];
        return [{ address: log.address as Address, topics, data: log.data as Hex }];
      })
    : [];
  return {
    app: (typeof record.app === "string" ? record.app : record.to) as Address,
    hash: record.hash as Hex,
    from: record.from as Address,
    to: record.to as Address,
    selector: typeof record.selector === "string" ? (record.selector as Hex) : "0x",
    input: typeof record.input === "string" ? (record.input as Hex) : "0x",
    output: typeof record.output === "string" ? (record.output as Hex) : "0x",
    logs,
    blockNumber: Number.isFinite(blockNumber) ? blockNumber : 0,
    succeeded: record.succeeded !== false,
  };
}
