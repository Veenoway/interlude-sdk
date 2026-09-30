/**
 * The commands themselves, run the way a user runs them, in a Foundry project whose path has a
 * space and an accent in it — the shape of `~/Library/Application Support/...` or a home
 * directory named after a person.
 *
 * `ship` talks to a fake control plane on loopback, so what is asserted is the request the CLI
 * really sends and what it really prints, and nothing leaves the machine.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(pkg, "node_modules", ".bin", "tsx");
const entry = join(pkg, "src", "index.ts");
const forgeAvailable = spawnSync("forge", ["--version"]).status === 0;

// Not one of anvil's accounts: their keys are public, and ship is told to refuse them as owner.
const OWNER = "0x25912EA7D8B2B27cfE46b8F2BB197741a72B9802";
// anvil's account #3, which the 0.2.0 README put under [app] as its example owner.
const ANVIL_3 = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const APP = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

interface Run {
  code: number | null;
  out: string;
}

function cli(args: string[], cwd: string, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(tsx, [entry, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => resolve({ code, out }));
  });
}

function foundryProject(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "my dapp é-")));
  writeFileSync(
    join(dir, "foundry.toml"),
    `[profile.default]\nsrc = "src"\nout = "out"\nlibs = ["lib"]\n`,
  );
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const YOUR_APP = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Delegatable} from "@interludelayer/contracts/Delegatable.sol";
import {IInterludeHub} from "@interludelayer/contracts/interfaces/IInterludeHub.sol";
import {Types} from "@interludelayer/contracts/interfaces/Types.sol";

contract YourApp is Delegatable {
    /// @custom:interlude global
    uint256 internal score;

    constructor(IInterludeHub hub_) Delegatable(hub_) {}

    function play() external whenNotDelegated(Types.GLOBAL) {
        score += 1;
    }
}
`;

const ROOMS = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Delegatable} from "@interludelayer/contracts/Delegatable.sol";
import {IInterludeHub} from "@interludelayer/contracts/interfaces/IInterludeHub.sol";

contract Rooms is Delegatable {
    /// @custom:interlude per-key
    mapping(uint256 => uint256) internal seats;

    constructor(IInterludeHub hub_) Delegatable(hub_) {}
}
`;

// --- a control plane that records what it was sent ------------------------

let control: Server;
let controlUrl = "";
const received: unknown[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: {} };

beforeAll(async () => {
  control = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined });
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", () => resolve()));
  const address = control.address();
  controlUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => {
  control.close();
});

describe("dev checks before it builds anything", () => {
  it("stops on a missing node binary before compiling or starting a chain", async () => {
    const dir = foundryProject({
      "src/YourApp.sol": YOUR_APP,
      "interlude.toml": `[app]\ncontract = "YourApp"\nargs = ["$HUB"]\n[chain]\nport = 23571\n[node]\nport = 23572\n`,
    });
    const run = await cli(["dev"], dir, { INTERLUDE_NODE_BIN: "/no/such/interlude-node" });
    expect(run.code).toBe(1);
    expect(run.out).toMatch(/INTERLUDE_NODE_BIN points at \/no\/such\/interlude-node/);
    // Nothing downstream happened: no compile, no chain.
    expect(run.out).not.toMatch(/== compiling/);
    expect(run.out).not.toMatch(/base chain on/);
    expect(existsSync(join(dir, "out"))).toBe(false);
  }, 60_000);

  it("is not stopped by an [app] owner it never uses, even one of anvil's accounts", async () => {
    const dir = foundryProject({
      "src/YourApp.sol": YOUR_APP,
      "interlude.toml":
        `[app]\ncontract = "YourApp"\nargs = ["$HUB"]\nowner = "${ANVIL_3}"\n` +
        `[chain]\nport = 23573\n[node]\nport = 23574\n`,
    });
    const run = await cli(["dev"], dir, { INTERLUDE_NODE_BIN: "/no/such/interlude-node" });
    // Past the config, as far as the preflight: the file was read and the owner line ignored.
    expect(run.code).toBe(1);
    expect(run.out).not.toMatch(/anvil's default account/);
    expect(run.out).toMatch(/INTERLUDE_NODE_BIN points at \/no\/such\/interlude-node/);
  }, 60_000);
});

describe.skipIf(!forgeAvailable)("in a project whose path has a space and an accent", () => {
  let dir = "";

  beforeAll(() => {
    dir = foundryProject({ "src/YourApp.sol": YOUR_APP, "src/Rooms.sol": ROOMS });
  });

  it("init refuses a per-key contract, and writes one with --local for dev", async () => {
    const refused = await cli(["init", "--contract", "Rooms"], dir);
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/Rooms hands storage over per key/);
    expect(refused.out).toMatch(/interlude init --contract Rooms --local/);
    expect(existsSync(join(dir, "interlude.toml"))).toBe(false);

    const local = await cli(["init", "--contract", "Rooms", "--local"], dir);
    expect(local.code, local.out).toBe(0);
    expect(readFileSync(join(dir, "interlude.toml"), "utf8")).toMatch(/`interlude ship` cannot/);
  }, 180_000);

  it("ship refuses a per-key contract before it sends anything", async () => {
    const before = received.length;
    const run = await cli(
      ["ship", "--contract", "Rooms", "--no-build", "--control", controlUrl, "--name", "r"],
      dir,
    );
    expect(run.code).toBe(1);
    expect(run.out).toMatch(/hosted node\s+serves the whole contract as one partition, GLOBAL/);
    expect(received.length).toBe(before);
  }, 60_000);

  it("init writes the hub argument and ship sends it, with the owner, then writes .env.local", async () => {
    const init = await cli(["init", "--contract", "YourApp", "--force"], dir);
    expect(init.code, init.out).toBe(0);
    expect(readFileSync(join(dir, "remappings.txt"), "utf8")).toBe(
      "@interludelayer/contracts/=lib/interlude/\n",
    );

    answer = {
      status: 200,
      body: {
        app: APP,
        url: "https://il-eu-test.example",
        name: "test",
        region: "eu",
        owner: OWNER,
        ownershipPending: true,
      },
    };
    const before = received.length;
    const run = await cli(
      [
        "ship",
        "--no-build",
        "--control",
        controlUrl,
        "--name",
        "test",
        "--owner",
        OWNER,
        "--out",
        ".env.local",
        "--rpc",
        "https://rpc.example",
      ],
      dir,
    );
    expect(run.code, run.out).toBe(0);
    const sent = received[before] as {
      method: string;
      url: string;
      body: { name: string; args: string[]; owner: string; abi: { type: string; name?: string }[] };
    };
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("/apps");
    expect(sent.body.name).toBe("test");
    expect(sent.body.args).toEqual(["$HUB"]);
    expect(sent.body.owner).toBe(OWNER);
    expect(sent.body.abi.some((item) => item.name === "play")).toBe(true);

    expect(run.out).toContain(`cast send ${APP} "acceptOwnership()" --rpc-url https://rpc.example`);
    expect(readFileSync(join(dir, ".env.local"), "utf8")).toBe(
      `NEXT_PUBLIC_INTERLUDE_APP=${APP}\n` +
        `NEXT_PUBLIC_INTERLUDE_NODE=https://il-eu-test.example\n` +
        `NEXT_PUBLIC_INTERLUDE_BASE_RPC=https://rpc.example\n`,
    );

    // The same build again is the same app: no second deploy unless asked.
    const again = await cli(
      ["ship", "--no-build", "--control", controlUrl, "--name", "test", "--owner", OWNER],
      dir,
    );
    expect(again.code).toBe(1);
    expect(again.out).toMatch(new RegExp(`already shipped as ${APP}`));
    expect(again.out).toMatch(/--again/);
    expect(received.length).toBe(before + 1);
  }, 180_000);

  it("keeps the app address when control fails after deploying", async () => {
    answer = {
      status: 502,
      body: { error: "the machine did not start", app: APP, retry: `interlude sessions create ${APP}` },
    };
    const run = await cli(
      ["ship", "--no-build", "--control", controlUrl, "--name", "test", "--again"],
      dir,
    );
    expect(run.code).toBe(1);
    expect(run.out).toMatch(new RegExp(`app\\s+${APP}`));
    expect(run.out).toContain(`interlude sessions create ${APP}`);
    expect(run.out).toMatch(/the machine did not start/);
    expect(run.out).not.toMatch(/at .*\.ts:\d+/); // no stack
  }, 60_000);

  it("says which host could not be reached, without a stack", async () => {
    const run = await cli(
      ["ship", "--no-build", "--control", "http://127.0.0.1:23599", "--name", "x", "--again"],
      dir,
    );
    expect(run.code).toBe(1);
    expect(run.out).toMatch(/cannot reach the control plane at http:\/\/127\.0\.0\.1:23599: nothing is listening there/);
    expect(run.out).not.toMatch(/TypeError|undici/);
  }, 60_000);

  it("abi writes the typed module", async () => {
    const run = await cli(["abi", "--contract", "YourApp", "--no-build", "--out", "web/abi.ts"], dir);
    expect(run.code, run.out).toBe(0);
    const text = readFileSync(join(dir, "web", "abi.ts"), "utf8");
    expect(text).toMatch(/export const abi = \[/);
    expect(text).toMatch(/"name": "play"/);
    expect(text.trimEnd().endsWith("] as const;")).toBe(true);
  }, 60_000);

  it("abi finds the contract through interlude.toml whose owner is one of anvil's accounts", async () => {
    await withTomlOwner(dir, ANVIL_3, async () => {
      const run = await cli(["abi", "--no-build", "--out", "web/from-toml.ts"], dir);
      expect(run.code, run.out).toBe(0);
      expect(readFileSync(join(dir, "web", "from-toml.ts"), "utf8")).toMatch(/"name": "play"/);
    });
  }, 60_000);

  it("ship lets one of anvil's accounts own an app behind a control plane on this machine", async () => {
    answer = {
      status: 200,
      body: {
        app: APP,
        url: "http://127.0.0.1:8545",
        name: "local",
        owner: ANVIL_3,
        ownershipPending: true,
      },
    };
    const before = received.length;
    const run = await cli(
      ["ship", "--no-build", "--control", controlUrl, "--name", "local", "--owner", ANVIL_3],
      dir,
    );
    expect(run.code, run.out).toBe(0);
    expect((received[before] as { body: { owner: string } }).body.owner).toBe(ANVIL_3);
  }, 60_000);

  it("ship refuses one of anvil's accounts as owner behind any other control plane", async () => {
    const before = received.length;
    const publicControl = ["--control", "https://control.example", "--name", "x", "--again"];
    const flagged = await cli(["ship", "--no-build", ...publicControl, "--owner", ANVIL_3], dir);
    expect(flagged.code).toBe(1);
    expect(flagged.out).toContain(`--owner ${ANVIL_3} is anvil's default account #3`);
    expect(flagged.out).not.toMatch(/cannot reach the control plane/);

    await withTomlOwner(dir, ANVIL_3, async () => {
      const fromToml = await cli(["ship", "--no-build", ...publicControl], dir);
      expect(fromToml.code).toBe(1);
      expect(fromToml.out).toMatch(new RegExp(`owner ${ANVIL_3} is anvil's default account #3`));
      expect(fromToml.out).not.toMatch(/cannot reach the control plane/);
    });
    expect(received.length).toBe(before);
  }, 60_000);
});

/** Run `body` with `owner = "..."` under [app] in the project's interlude.toml, then put it back. */
async function withTomlOwner(dir: string, owner: string, body: () => Promise<void>): Promise<void> {
  const path = join(dir, "interlude.toml");
  const original = readFileSync(path, "utf8");
  expect(original).toMatch(/^\[app\]$/m);
  writeFileSync(path, original.replace(/^\[app\]$/m, `[app]\nowner = "${owner}"`));
  try {
    await body();
  } finally {
    writeFileSync(path, original);
  }
}
