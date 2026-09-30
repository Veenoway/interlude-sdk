import { describe, expect, it } from "vitest";
import {
  GLOBAL_PARTITION,
  nodeHealth,
  readAppStatus,
  statusRows,
  type ChainReader,
} from "../src/status.js";

const APP = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const HUB = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const ADMIN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OWNER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const VALIDATOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function chain(options: { pendingOwner?: string | "missing"; status?: number }): ChainReader & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    async readContract({ address, functionName, args }) {
      calls.push(`${address}.${functionName}(${(args ?? []).join(",")})`);
      if (functionName === "owner") return ADMIN;
      if (functionName === "hub") return HUB;
      if (functionName === "pendingOwner") {
        if (options.pendingOwner === "missing") throw new Error("execution reverted");
        return options.pendingOwner ?? "0x0000000000000000000000000000000000000000";
      }
      if (functionName === "sessionOf") {
        return {
          validator: VALIDATOR,
          resolver: ADMIN,
          status: options.status ?? 1,
          spec: 1,
          epoch: 3n,
          batchIndex: 17n,
          baseBlock: 100n,
          lastExecTimestamp: 0n,
          lastCommitAt: 1_000n,
          maxBatchInterval: 3600n,
          expiresAt: 0n,
          maxDiffsPerCommit: 256,
        };
      }
      throw new Error(`unexpected ${functionName}`);
    },
  };
}

describe("interlude status", () => {
  it("reads owner and hub from the app, and the session from that hub", async () => {
    const reader = chain({ pendingOwner: OWNER });
    const status = await readAppStatus(reader, APP);
    expect(reader.calls).toContain(`${HUB}.sessionOf(${APP},${GLOBAL_PARTITION})`);
    expect(status).toMatchObject({
      app: APP,
      hub: HUB,
      owner: ADMIN,
      pendingOwner: OWNER,
      delegation: { status: "Active", epoch: 3n, batches: 17n, validator: VALIDATOR },
    });
  });

  it("points at a pending owner that has not accepted yet", async () => {
    const rows = statusRows(await readAppStatus(chain({ pendingOwner: OWNER }), APP), 1_012);
    const byLabel = Object.fromEntries(rows);
    expect(byLabel["pending owner"]).toBe(`${OWNER} — has not called acceptOwnership() yet`);
    expect(byLabel["delegation"]).toBe("Active");
    expect(byLabel["epoch"]).toBe("3");
    expect(byLabel["last commit"]).toBe("1970-01-01T00:16:40.000Z (12s ago)");
  });

  it("still reads an app from before two-step ownership", async () => {
    const rows = Object.fromEntries(
      statusRows(await readAppStatus(chain({ pendingOwner: "missing" }), APP)),
    );
    expect(rows["pending owner"]).toMatch(/no two-step ownership/);
  });

  it("says None and stops there for an app that is not delegated", async () => {
    const rows = Object.fromEntries(statusRows(await readAppStatus(chain({ status: 0 }), APP)));
    expect(rows["delegation"]).toBe("None");
    expect(rows["epoch"]).toBeUndefined();
  });
});

describe("the node's /health", () => {
  it("reports what the node says", async () => {
    let asked = "";
    const health = await nodeHealth("https://node.example/", (async (url: string) => {
      asked = url;
      return new Response(JSON.stringify({ ok: true, committedBatches: 4 }));
    }) as unknown as typeof fetch);
    expect(asked).toBe("https://node.example/health");
    expect(health).toEqual({ ok: true, detail: '{"ok":true,"committedBatches":4}' });
  });

  it("treats a 502 and an unreachable node as results, not crashes", async () => {
    expect(
      await nodeHealth("https://n.example", (async () =>
        new Response("bad gateway", { status: 502 })) as unknown as typeof fetch),
    ).toEqual({ ok: false, detail: "HTTP 502 bad gateway" });

    const down = await nodeHealth("https://n.example", (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch);
    expect(down.ok).toBe(false);
    expect(down.detail).toMatch(/nothing is listening there/);
  });
});
