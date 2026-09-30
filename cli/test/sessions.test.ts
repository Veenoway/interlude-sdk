import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeFunctionData,
  encodeFunctionResult,
  parseAbi,
  recoverMessageAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createBody,
  epochCommand,
  optInFor,
  optInMessage,
  parseOptInSignature,
  signCommand,
} from "../src/sessions.js";
import { controlUrl, DEFAULT_CONTROL_URL } from "../src/ship.js";
import type { ChainReader } from "../src/status.js";

const APP = "0x28C583542854f2E0b32930E5252687F6fA8D5d91" as Address;
const HUB = "0xDf840A85DB56430970b32f0e3210cabB5CD1F270" as Address;
const owner = privateKeyToAccount(`0x${"33".repeat(32)}`);

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(pkg, "node_modules", ".bin", "tsx");
const entry = join(pkg, "src", "index.ts");

function chain(epoch: bigint): ChainReader {
  return {
    readContract: async ({ functionName }) => {
      if (functionName === "owner") return owner.address;
      if (functionName === "hub") return HUB;
      if (functionName === "pendingOwner") throw new Error("no pendingOwner");
      return {
        validator: "0x0000000000000000000000000000000000000001",
        status: 1,
        epoch,
        batchIndex: 0n,
        lastCommitAt: 0n,
        maxBatchInterval: 3600n,
        expiresAt: 0n,
      };
    },
  };
}

describe("interlude sessions", () => {
  it("talks to the public control plane by default", () => {
    const previous = process.env.INTERLUDE_CONTROL_URL;
    delete process.env.INTERLUDE_CONTROL_URL;
    try {
      expect(controlUrl([])).toBe(DEFAULT_CONTROL_URL);
    } finally {
      if (previous === undefined) delete process.env.INTERLUDE_CONTROL_URL;
      else process.env.INTERLUDE_CONTROL_URL = previous;
    }
  });

  it("builds the exact message control recovers the owner from", async () => {
    const message = optInMessage(APP, 4n);
    expect(message).toBe(`interlude:provision:${APP.toLowerCase()}:4`);
    // `cast wallet sign` is EIP-191, which is what viem's signMessage produces and what control's
    // recoverMessageAddress undoes.
    const signature = await owner.signMessage({ message });
    expect(await recoverMessageAddress({ message, signature })).toBe(owner.address);
    expect(signCommand(message)).toBe(`cast wallet sign --interactive "${message}"`);
  });

  it("reads owner and epoch from the chain for the opt-in it prints", async () => {
    const optIn = await optInFor(chain(7n), APP, "https://rpc.example");
    expect(optIn).toMatchObject({ owner: owner.address, hub: HUB, epoch: 7n, message: optInMessage(APP, 7n) });
    const text = optIn.lines.join("\n");
    expect(text).toContain(signCommand(optInMessage(APP, 7n)));
    expect(text).toContain(`interlude sessions create ${APP} --signature 0x...`);
    expect(text).toContain(epochCommand(HUB, APP, "https://rpc.example"));
  });

  it("refuses a signature that is not 65 bytes of hex before sending it", () => {
    expect(() => parseOptInSignature("0x1234")).toThrow(/65-byte/);
    expect(() => parseOptInSignature(`0x${"zz".repeat(65)}`)).toThrow(/65-byte/);
    expect(parseOptInSignature(`0x${"ab".repeat(65)}`)).toBe(`0x${"ab".repeat(65)}`);
    expect(parseOptInSignature(undefined)).toBeUndefined();
  });

  it("sends the signature and no name (control ignores names; /apps chose the label)", () => {
    const signature = `0x${"ab".repeat(65)}` as Hex;
    expect(createBody(APP, "eu", signature)).toEqual({ app: APP, region: "eu", signature });
    expect(createBody(APP)).toEqual({ app: APP });
  });
});

describe("interlude sessions create, against a fake control plane and chain", () => {
  let server: Server;
  let base = "";
  const posted: unknown[] = [];

  const APP_ABI = parseAbi([
    "function owner() view returns (address)",
    "function pendingOwner() view returns (address)",
    "function hub() view returns (address)",
  ]);
  const HUB_ABI = parseAbi([
    "struct Session { address validator; address resolver; uint8 status; uint8 spec; uint256 epoch; uint256 batchIndex; uint64 baseBlock; uint64 lastExecTimestamp; uint64 lastCommitAt; uint64 maxBatchInterval; uint64 expiresAt; uint32 maxDiffsPerCommit; }",
    "function sessionOf(address app, bytes32 partition) view returns (Session)",
  ]);

  function rpc(body: { id: number; method: string; params: [{ to: string; data: Hex }] }) {
    if (body.method === "eth_chainId") return { jsonrpc: "2.0", id: body.id, result: "0x279f" };
    if (body.method !== "eth_call") return { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "nope" } };
    const { data } = body.params[0];
    try {
      const call = decodeFunctionData({ abi: APP_ABI, data });
      if (call.functionName === "pendingOwner") {
        return { jsonrpc: "2.0", id: body.id, error: { code: 3, message: "execution reverted", data: "0x" } };
      }
      const value = call.functionName === "owner" ? owner.address : HUB;
      return { jsonrpc: "2.0", id: body.id, result: encodeFunctionResult({ abi: APP_ABI, functionName: call.functionName, result: value }) };
    } catch {
      const result = encodeFunctionResult({
        abi: HUB_ABI,
        functionName: "sessionOf",
        result: {
          validator: "0x0000000000000000000000000000000000000001",
          resolver: "0x0000000000000000000000000000000000000002",
          status: 1,
          spec: 1,
          epoch: 5n,
          batchIndex: 0n,
          baseBlock: 0n,
          lastExecTimestamp: 0n,
          lastCommitAt: 0n,
          maxBatchInterval: 3600n,
          expiresAt: 0n,
          maxDiffsPerCommit: 64,
        },
      });
      return { jsonrpc: "2.0", id: body.id, result };
    }
  }

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/rpc") {
          res.end(JSON.stringify(rpc(JSON.parse(raw))));
          return;
        }
        const body = JSON.parse(raw) as { signature?: string };
        posted.push(body);
        if (!body.signature) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: "control only runs nodes for apps it deployed or whose owner opted in" }));
          return;
        }
        res.end(JSON.stringify({ app: APP, url: "https://il-x.fly.dev", name: "il-x", status: "starting" }));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  function cli(args: string[]): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      const child = spawn(tsx, [entry, ...args], {
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (out += chunk));
      child.on("close", (code) => resolve({ code, out }));
    });
  }

  it("prints the exact message and the cast command when control asks for the opt-in", async () => {
    const run = await cli(["sessions", "create", APP, "--control", base, "--rpc", `${base}/rpc`]);
    expect(run.code).toBe(1);
    expect(run.out).toContain(`interlude:provision:${APP.toLowerCase()}:5`);
    expect(run.out).toContain(`cast wallet sign --interactive "interlude:provision:${APP.toLowerCase()}:5"`);
    expect(run.out).toContain(owner.address);
  }, 30_000);

  it("sends --signature and prints the node", async () => {
    const signature = await owner.signMessage({ message: optInMessage(APP, 5n) });
    const run = await cli(["sessions", "create", APP, "--signature", signature, "--control", base]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("https://il-x.fly.dev");
    expect(posted[posted.length - 1]).toEqual({ app: APP, signature });
  }, 30_000);
});
