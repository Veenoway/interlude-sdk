import type { Address } from "viem";

/** Public control. Override only for a laptop. */
export const DEFAULT_CONTROL_URL = "https://control.interludelayer.xyz";

export type PublicFloor = {
  region: string;
  city: string;
  app: Address;
  node: string;
};

/**
 * The eight public demo worlds. One writer per contract.
 * Keep in sync with `apps/demo/lib/floors.ts` and `apps/web/shared/content/content.ts`.
 */
export const PUBLIC_DEMO_FLOORS: Record<string, PublicFloor> = {
  us: {
    region: "us",
    city: "California",
    app: "0xE06Db057640F5FAF1deE30E9FD53540411B9B3D2",
    node: "https://rpc.us.interludelayer.xyz",
  },
  ny: {
    region: "ny",
    city: "New York",
    app: "0xce3A662cBa0B277D9A75D5D865CaF12C208792a1",
    node: "https://rpc.ny.interludelayer.xyz",
  },
  eu: {
    region: "eu",
    city: "Paris",
    app: "0xA116fcaEC711c9D8f64DA409CBE3AF673Fb9084C",
    node: "https://rpc.interludelayer.xyz",
  },
  asia: {
    region: "asia",
    city: "Singapore",
    app: "0x9310a3F8E0a9051046D6C845EbF7dDa6F17F6cde",
    node: "https://rpc.asia.interludelayer.xyz",
  },
  tokyo: {
    region: "tokyo",
    city: "Tokyo",
    app: "0xA20de0A1cF5dD0eDE3F99e111a482a3b031FbCa9",
    node: "https://rpc.tokyo.interludelayer.xyz",
  },
  mumbai: {
    region: "mumbai",
    city: "Mumbai",
    app: "0x9377D42C264B2206BAEC5ECF0dd63e60E00fD4b5",
    node: "https://rpc.mumbai.interludelayer.xyz",
  },
  africa: {
    region: "africa",
    city: "Johannesburg",
    app: "0x50FFCC5D9ACD1E9091a19577482d0ABbe5E1DB21",
    node: "https://rpc.africa.interludelayer.xyz",
  },
  sa: {
    region: "sa",
    city: "São Paulo",
    app: "0xf33e33db59ca9a9a3d5f6bbed1a4a8d75c29e478",
    node: "https://rpc.sa.interludelayer.xyz",
  },
};

export type FloorTable = Record<string, { app: Address; node: string; city?: string }>;

/**
 * Smart router: ask control which region is nearest, then return that floor.
 *
 * `createInterludeClient` does not do this itself. Call this first, then pass
 * `app` and `node`. For your own app, ship one node and skip this. For eight
 * worlds like the public demo, pass your own `floors` map.
 */
export async function nearestFloor(
  floors: FloorTable = PUBLIC_DEMO_FLOORS,
  options?: { control?: string; fallback?: string; timeoutMs?: number },
): Promise<{ region: string; app: Address; node: string; city?: string }> {
  const control = (options?.control ?? DEFAULT_CONTROL_URL).replace(/\/$/, "");
  const fallback = options?.fallback ?? "eu";
  let region: string | null = null;
  // Bounded: this runs before a page can do anything, and a control plane that accepts the
  // connection and never answers would otherwise hold the page on a blank screen. Past the
  // deadline the fallback floor is a better answer than none.
  const abort = typeof AbortController !== "undefined" ? new AbortController() : undefined;
  const timer = abort ? setTimeout(() => abort.abort(), options?.timeoutMs ?? 2500) : undefined;
  try {
    const response = await fetch(`${control}/near`, abort ? { signal: abort.signal } : undefined);
    const body = (await response.json()) as { region?: string | null };
    if (typeof body.region === "string" && body.region) region = body.region;
  } catch {
    region = null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const key = region && floors[region] ? region : floors[fallback] ? fallback : Object.keys(floors)[0];
  if (!key) throw new Error("nearestFloor: no floors");
  const floor = floors[key]!;
  return { region: key, app: floor.app, node: floor.node, city: floor.city };
}
