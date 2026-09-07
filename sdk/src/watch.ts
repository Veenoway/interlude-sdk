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

/**
 * Hear every call as it lands, not on a timer.
 *
 * Opens `interlude_subscribe("applied")`. If the socket dies or the node is too old to
 * serve it, the optional `fallback` runs so a page still moves — just slower.
 */
export function watchApplied(
  nodeUrl: string,
  onCall: (call: AppliedCall) => void,
  options?: { fallback?: () => void; fallbackMs?: number },
): () => void {
  let stopped = false;
  let socket: WebSocket | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let nextId = 1;
  let wait = 250;

  const stopFallback = () => {
    if (fallbackTimer !== undefined) {
      clearInterval(fallbackTimer);
      fallbackTimer = undefined;
    }
  };

  const startFallback = () => {
    if (stopped || !options?.fallback || fallbackTimer !== undefined) return;
    options.fallback();
    fallbackTimer = setInterval(() => {
      if (!stopped) options.fallback?.();
    }, options.fallbackMs ?? 80);
  };

  const open = () => {
    if (stopped || typeof WebSocket === "undefined") {
      startFallback();
      return;
    }

    let target: string;
    try {
      target = nodeSocketUrl(nodeUrl);
    } catch {
      startFallback();
      return;
    }

    const ws = new WebSocket(target);
    socket = ws;
    const id = nextId++;

    ws.addEventListener("open", () => {
      if (stopped) {
        ws.close();
        return;
      }
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "interlude_subscribe",
          params: ["applied"],
        }),
      );
    });

    ws.addEventListener("message", (event) => {
      const parsed = parseFrame(event.data);
      if (!parsed) return;
      if (parsed.kind === "error" && parsed.id === id) {
        startFallback();
        ws.close();
        return;
      }
      if (parsed.kind === "result" && parsed.id === id) {
        stopFallback();
        wait = 250;
        return;
      }
      if (parsed.kind === "call") {
        stopFallback();
        wait = 250;
        onCall(parsed.call);
      }
    });

    ws.addEventListener("error", () => {
      // `close` follows. Do not double-schedule.
    });

    ws.addEventListener("close", () => {
      if (socket === ws) socket = null;
      if (stopped) return;
      startFallback();
      retry = setTimeout(open, wait);
      wait = Math.min(wait * 2, 2000);
    });
  };

  open();

  return () => {
    stopped = true;
    stopFallback();
    if (retry !== undefined) clearTimeout(retry);
    socket?.close();
    socket = null;
  };
}

type Frame =
  | { kind: "result"; id: number }
  | { kind: "error"; id: number }
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
    return { kind: "error", id: record.id };
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
