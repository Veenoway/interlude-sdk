import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Abi, Address } from "viem";
import { describe, expect, it } from "vitest";
import { ArtifactError } from "../src/artifacts.js";
import { mergeEnv } from "../src/env.js";
import { NetworkError } from "../src/http.js";
import { Bail } from "../src/ui.js";
import {
  controlUrl,
  DEFAULT_CONTROL_URL,
  envFor,
  nextSteps,
  parseShipRegion,
  planShip,
  postApp,
  readShipRecords,
  previousShip,
  rememberShip,
  ShipError,
  ShipFailure,
  shipFingerprint,
  type PlanInput,
  type ShipPayload,
  type ShipResult,
} from "../src/ship.js";
import type { AppConfig } from "../src/config.js";

describe("where ship talks", () => {
  it("needs no env and no message from us", () => {
    const previous = process.env.INTERLUDE_CONTROL_URL;
    delete process.env.INTERLUDE_CONTROL_URL;
    try {
      expect(controlUrl([])).toBe(DEFAULT_CONTROL_URL);
    } finally {
      if (previous === undefined) delete process.env.INTERLUDE_CONTROL_URL;
      else process.env.INTERLUDE_CONTROL_URL = previous;
    }
  });

  it("accepts the eight floors", () => {
    expect(parseShipRegion(undefined)).toBeUndefined();
    expect(parseShipRegion("EU")).toBe("eu");
    expect(parseShipRegion("ny")).toBe("ny");
    expect(parseShipRegion("sa")).toBe("sa");
    expect(parseShipRegion("tokyo")).toBe("tokyo");
    expect(parseShipRegion("mumbai")).toBe("mumbai");
    expect(parseShipRegion("africa")).toBe("africa");
    expect(() => parseShipRegion("dubai")).toThrow(Bail);
  });
});

// --- what gets sent --------------------------------------------------------

const HUB_ONLY: Abi = [
  {
    type: "constructor",
    stateMutability: "nonpayable",
    inputs: [{ name: "hub_", type: "address", internalType: "contract IInterludeHub" }],
  },
  { type: "function", name: "delegateAll", stateMutability: "payable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "credit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "who", type: "address", internalType: "address" },
      { name: "amount", type: "uint256", internalType: "uint256" },
    ],
    outputs: [],
  },
];

const WITH_STAKE: Abi = [
  {
    type: "constructor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "hub_", type: "address", internalType: "contract IInterludeHub" },
      { name: "minBet", type: "uint256", internalType: "uint256" },
    ],
  },
  { type: "function", name: "delegateAll", stateMutability: "payable", inputs: [], outputs: [] },
];

const BYTECODE = "0x6080604052" as const;
// Not one of anvil's accounts: their keys are public, and ship is told to refuse them as owner.
const OWNER = "0x25912EA7D8B2B27cfE46b8F2BB197741a72B9802";

function app(overrides: Partial<AppConfig> = {}): AppConfig {
  return { contract: "Game", args: [], delegate: "all", setup: [], ...overrides };
}

function plan(overrides: Partial<PlanInput> = {}) {
  return planShip({
    contract: "Game",
    abi: HUB_ONLY,
    bytecode: BYTECODE,
    label: "game",
    ...overrides,
  });
}

describe("the body ship sends", () => {
  it("sends the whole ABI, the args, setup and owner — the new POST /apps contract", () => {
    const { payload } = plan({
      app: app({
        args: ["$HUB"],
        setup: [{ signature: "credit(address,uint256)", args: [OWNER, "1000"] }],
      }),
      owner: OWNER,
      region: "eu",
    });
    expect(payload).toEqual({
      name: "game",
      bytecode: BYTECODE,
      abi: HUB_ONLY,
      args: ["$HUB"],
      setup: [{ signature: "credit(address,uint256)", args: [OWNER, "1000"] }],
      owner: OWNER,
      region: "eu",
    });
  });

  it("fills a hub-only constructor without being told, because there is nothing to guess", () => {
    const { payload, notes } = plan();
    expect(payload.args).toEqual(["$HUB"]);
    expect(notes.join(" ")).toMatch(/one constructor argument is the hub/);
    expect(payload).not.toHaveProperty("setup");
    expect(payload).not.toHaveProperty("owner");
  });

  it("refuses to let the server guess a constructor it cannot know", () => {
    // The server used to fill the first uint with a 0.1 MON stake, whatever it meant.
    expect(() => plan({ abi: WITH_STAKE })).toThrow(ShipError);
    expect(() => plan({ abi: WITH_STAKE })).toThrow(
      /will not guess them[\s\S]*args = \["\$HUB", "<fill in: uint256 minBet>"\]/,
    );
  });

  it("sends the args interlude.toml gives, as strings", () => {
    const { payload } = plan({ abi: WITH_STAKE, app: app({ args: ["$HUB", "5000"] }) });
    expect(payload.args).toEqual(["$HUB", "5000"]);
  });

  it("checks the args against the constructor before anything is deployed", () => {
    expect(() => plan({ abi: WITH_STAKE, app: app({ args: ["$HUB"] }) })).toThrow(
      /takes 2 argument\(s\)[\s\S]*gives 1/,
    );
    expect(() => plan({ abi: WITH_STAKE, app: app({ args: ["$HUB", "lots"] }) })).toThrow(
      /wants uint256, got "lots"/,
    );
    expect(() =>
      plan({ abi: WITH_STAKE, app: app({ args: ["$HUB", "<fill in: uint256 minBet>"] }) }),
    ).toThrow(ArtifactError);
    expect(() =>
      plan({ abi: WITH_STAKE, app: app({ args: ["$HUB", "<fill in: uint256 minBet>"] }) }),
    ).toThrow(/still <fill in: uint256 minBet> in interlude.toml/);
  });

  it("refuses the placeholders only dev can fill", () => {
    expect(() => plan({ app: app({ args: ["$ADMIN"] }) })).toThrow(/\$ADMIN, which only `interlude dev` knows/);
    expect(() =>
      plan({ app: app({ args: ["$HUB"], setup: [{ signature: "credit(address,uint256)", args: ["$APP", "1"] }] }) }),
    ).toThrow(/\$APP/);
  });

  it("checks setup calls too, and refuses one that attaches value", () => {
    expect(() =>
      plan({ app: app({ setup: [{ signature: "credit(address,uint256)", args: [OWNER] }] }) }),
    ).toThrow(/takes 2 argument\(s\) and gives 1/);
    expect(() =>
      plan({ app: app({ setup: [{ signature: "credit(address,uint256)", args: ["bob", "1"] }] }) }),
    ).toThrow(/wants an address/);
    expect(() =>
      plan({
        app: app({ setup: [{ signature: "credit(address,uint256)", args: [OWNER, "1"], value: "5" }] }),
      }),
    ).toThrow(/attaches value/);
  });

  it("refuses an owner that is not an address, and a stake that is not wei", () => {
    expect(() => plan({ owner: "me" })).toThrow(/--owner me is not an address/);
    expect(() => plan({ stake: "0.1" })).toThrow(/whole number of wei/);
  });
});

describe("per-key, which the hosted node does not serve", () => {
  it("is refused before the deploy, not discovered after it", () => {
    expect(() => plan({ perKey: ["src/Game.sol calls _registerPerKey"] })).toThrow(
      /per key[\s\S]*GLOBAL[\s\S]*@custom:interlude global/,
    );
  });

  it("covers a config that delegates one key", () => {
    expect(() => plan({ app: app({ delegate: `0x${"11".repeat(32)}` }) })).toThrow(
      /delegate = "all" only/,
    );
  });
});

// --- what comes back -------------------------------------------------------

const APP = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

function payload(): ShipPayload {
  return plan({ owner: OWNER }).payload;
}

describe("the answer from control", () => {
  it("posts the payload as JSON to /apps", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ app: APP, url: "https://n.example", name: "game" }));
    }) as unknown as typeof fetch;
    await postApp("https://control.example", payload(), { fetchImpl, write: () => {} });
    expect(seen?.url).toBe("https://control.example/apps");
    expect(seen?.init.method).toBe("POST");
    expect(JSON.parse(String(seen?.init.body))).toEqual(payload());
    expect(seen?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reads owner, ownershipPending and warnings", async () => {
    const result = await postApp(
      "https://control.example",
      payload(),
      {
        fetchImpl: fakeFetch(200, {
          app: APP,
          url: "https://node.example",
          name: "game",
          region: "eu",
          owner: OWNER,
          ownershipPending: true,
          warnings: ["stake capped", 42],
        }),
        write: () => {},
      },
    );
    expect(result).toEqual({
      app: APP,
      url: "https://node.example",
      name: "game",
      region: "eu",
      owner: OWNER,
      ownershipPending: true,
      warnings: ["stake capped"],
    });
  });

  it("keeps the app address when control fails after deploying it", async () => {
    const failure = await postApp("https://control.example", payload(), {
      fetchImpl: fakeFetch(502, {
        error: "fly would not start the machine",
        app: APP,
        retry: `interlude sessions create ${APP}`,
      }),
      write: () => {},
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ShipFailure);
    expect((failure as ShipFailure).app).toBe(APP);
    expect((failure as ShipFailure).retry).toBe(`interlude sessions create ${APP}`);
    expect((failure as ShipFailure).message).toBe("fly would not start the machine");
  });

  it("suggests the retry itself when an older control omits it", async () => {
    const failure = (await postApp("https://c.example", payload(), {
      fetchImpl: fakeFetch(500, { error: "boom", app: APP }),
      write: () => {},
    }).catch((error: unknown) => error)) as ShipFailure;
    expect(failure.retry).toBe(`interlude sessions create ${APP}`);
  });

  it("reports a failure before any deploy without inventing an app", async () => {
    const failure = (await postApp("https://c.example", payload(), {
      fetchImpl: fakeFetch(400, { error: "constructor takes uint256 minBet and no args were given" }),
      write: () => {},
    }).catch((error: unknown) => error)) as ShipFailure;
    expect(failure.status).toBe(400);
    expect(failure.app).toBeUndefined();
    expect(failure.message).toMatch(/no args were given/);
  });

  it("turns a dead network into a sentence, not an undici stack", async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    }) as typeof fetch;
    const failure = await postApp("https://control.example", payload(), {
      fetchImpl,
      write: () => {},
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NetworkError);
    expect((failure as Error).message).toBe(
      "cannot reach the control plane at https://control.example: the name does not resolve (offline, or a typo in the URL?).",
    );
  });

  it("gives up after its deadline instead of hanging forever", async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      });
    }) as typeof fetch;
    const failure = await postApp("https://control.example", payload(), {
      fetchImpl,
      write: () => {},
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NetworkError);
    expect((failure as Error).message).toMatch(/did not answer within 10 minutes/);
  });
});

describe("what to do next", () => {
  const base: ShipResult = { app: APP, url: "https://node.example", name: "game", warnings: [] };

  it("prints the exact acceptOwnership command while ownership is pending", () => {
    const steps = nextSteps(
      { ...base, owner: OWNER, ownershipPending: true },
      { rpc: "https://testnet-rpc.monad.xyz", requestedOwner: OWNER },
    );
    expect(steps.commands).toEqual([
      `cast send ${APP} "acceptOwnership()" --rpc-url https://testnet-rpc.monad.xyz --interactive`,
    ]);
    expect(steps.notes.join(" ")).toMatch(/Interlude's deploy key is still the owner/);
  });

  it("says loudly who owns it when nobody asked", () => {
    const steps = nextSteps({ ...base }, { rpc: "x" });
    expect(steps.warnings.join(" ")).toMatch(/owned by Interlude's deploy key, not by you/);
    expect(steps.commands).toEqual([]);
  });

  it("notices when an owner was asked for and not confirmed", () => {
    const steps = nextSteps({ ...base }, { rpc: "x", requestedOwner: OWNER });
    expect(steps.warnings.join(" ")).toMatch(/control did not confirm it/);
  });

  it("passes control's warnings through", () => {
    const steps = nextSteps({ ...base, warnings: ["stake capped to 0.1"] }, { rpc: "x" });
    expect(steps.warnings[0]).toBe("stake capped to 0.1");
  });
});

describe("ship --out", () => {
  it("merges the three NEXT_PUBLIC values into an existing env file", () => {
    const dir = mkdtempSync(join(tmpdir(), "interlude-out-"));
    const path = join(dir, ".env.local");
    writeFileSync(path, "# mine\nNEXT_PUBLIC_OTHER=1\nNEXT_PUBLIC_INTERLUDE_APP=0xold\n");
    mergeEnv(
      path,
      envFor(
        { app: APP, url: "https://node.example", name: "g", warnings: [] },
        "https://testnet-rpc.monad.xyz",
      ),
    );
    expect(readFileSync(path, "utf8")).toBe(
      "# mine\nNEXT_PUBLIC_OTHER=1\n" +
        `NEXT_PUBLIC_INTERLUDE_APP=${APP}\n` +
        "NEXT_PUBLIC_INTERLUDE_NODE=https://node.example\n" +
        "NEXT_PUBLIC_INTERLUDE_BASE_RPC=https://testnet-rpc.monad.xyz\n",
    );
  });
});

describe("shipping the same build twice", () => {
  it("is recognised by what gets deployed, not by where the node runs", () => {
    const a = plan({ app: app({ args: ["$HUB"] }), region: "eu", label: "one" }).payload;
    const b = plan({ app: app({ args: ["$HUB"] }), region: "tokyo", label: "two" }).payload;
    const c = plan({ app: app({ args: ["$HUB"] }), owner: OWNER }).payload;
    expect(shipFingerprint(a)).toBe(shipFingerprint(b));
    expect(shipFingerprint(a)).not.toBe(shipFingerprint(c));
  });

  it("keeps the working deploy when a later --again of the same build fails half-way", () => {
    const dir = mkdtempSync(join(tmpdir(), "interlude-shipped-"));
    const fingerprint = shipFingerprint(payload());
    const OTHER = "0x1111111111111111111111111111111111111111" as Address;
    rememberShip(dir, { fingerprint, app: APP, url: "https://good", name: "g", at: "first", complete: true });
    rememberShip(dir, { fingerprint, app: OTHER, name: "g", at: "again", complete: false });
    const records = readShipRecords(dir);
    expect(records.map((entry) => entry.app)).toEqual([APP, OTHER]);
    // The next plain `ship` points at the one whose node works.
    expect(previousShip(records, fingerprint)).toMatchObject({ app: APP, url: "https://good" });
  });

  it("remembers the app, including one whose node never came up", () => {
    const dir = mkdtempSync(join(tmpdir(), "interlude-shipped-"));
    const fingerprint = shipFingerprint(payload());
    rememberShip(dir, { fingerprint, app: APP, name: "g", at: "then", complete: false });
    rememberShip(dir, { fingerprint, app: APP, url: "https://n", name: "g", at: "now", complete: true });
    expect(readShipRecords(dir)).toEqual([
      { fingerprint, app: APP, url: "https://n", name: "g", at: "now", complete: true },
    ]);
  });
});
