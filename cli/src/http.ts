/**
 * Talking to things over the network, with a deadline and a sentence when it goes wrong.
 *
 * A bare `fetch` has neither. A control plane that hangs left `ship` hanging forever, and a
 * laptop with no network printed `TypeError: fetch failed` under forty lines of undici stack —
 * which says nothing about which host, or what to do next.
 */

/** Thrown with a message meant for the person at the terminal, not a stack. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

/** A deploy plus a machine can honestly take minutes; anything else that slow is stuck. */
export const DEPLOY_TIMEOUT_MS = 10 * 60_000;
export const QUICK_TIMEOUT_MS = 30_000;

export interface RequestOptions {
  timeoutMs: number;
  /** What is being asked, for the error: "the control plane", "the node". */
  what: string;
  /** Print a sign of life while waiting, for requests a human watches for minutes. */
  progress?: boolean;
  /** Injected by tests. */
  fetchImpl?: typeof fetch;
  /** Where progress goes. Injected by tests. */
  write?: (text: string) => void;
}

export async function request(
  url: string,
  init: RequestInit,
  options: RequestOptions,
): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch;
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const started = Date.now();

  // Dots on a terminal; an occasional line elsewhere, so a CI log shows it is still alive
  // without being a wall of dots.
  const tty = Boolean(process.stdout.isTTY);
  let printed = false;
  const ticker = options.progress
    ? setInterval(
        () => {
          printed = true;
          write(tty ? "." : `  still waiting (${Math.round((Date.now() - started) / 1000)}s)\n`);
        },
        tty ? 5_000 : 30_000,
      )
    : undefined;

  try {
    return await doFetch(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
  } catch (error) {
    throw explainNetworkError(error, url, options);
  } finally {
    if (ticker) clearInterval(ticker);
    if (printed && tty) write("\n");
  }
}

export function explainNetworkError(error: unknown, url: string, options: RequestOptions): Error {
  const origin = safeOrigin(url);
  const name = (error as { name?: string } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    const seconds = Math.round(options.timeoutMs / 1000);
    return new NetworkError(
      `${options.what} at ${origin} did not answer within ${seconds >= 120 ? `${Math.round(seconds / 60)} minutes` : `${seconds}s`}.`,
    );
  }
  // undici wraps the real reason: `TypeError: fetch failed` with `cause: { code: "ENOTFOUND" }`.
  const cause = (error as { cause?: { code?: string; message?: string } } | null)?.cause;
  const code = cause?.code;
  if (error instanceof TypeError || code) {
    const why =
      code === "ENOTFOUND" || code === "EAI_AGAIN"
        ? "the name does not resolve (offline, or a typo in the URL?)"
        : code === "ECONNREFUSED"
          ? "nothing is listening there"
          : code === "ECONNRESET" || code === "UND_ERR_SOCKET"
            ? "the connection was dropped"
            : (cause?.message ?? (error as Error).message);
    return new NetworkError(`cannot reach ${options.what} at ${origin}: ${why}.`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
