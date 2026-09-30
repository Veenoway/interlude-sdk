import { mnemonicToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  WELL_KNOWN_DEV_ACCOUNTS,
  isLoopbackUrl,
  parseConfig,
  refuseWellKnownOwner,
  substitute,
  wellKnownDevAccount,
} from "../src/config.js";
import { firstHour, hubArgumentIndex, starterConfig } from "../src/starter.js";

const AT = "interlude.toml";

describe("the smallest thing a project can say about itself", () => {
  it("is a contract and its constructor arguments", () => {
    const config = parseConfig(`[app]\ncontract = "Counter"\nargs = ["$HUB"]\n`, AT);

    expect(config.app.contract).toBe("Counter");
    expect(config.app.args).toEqual(["$HUB"]);
    // Everything else has to have a default, or the smallest config is not small.
    expect(config.app.delegate).toBe("all");
    expect(config.chain.port).toBe(8547);
    expect(config.node.port).toBe(8555);
    expect(config.node.chainId).toBe(4242);
  });

  it("accepts a number where a string is wanted, because args = [1000] is what people write", () => {
    const config = parseConfig(`[app]\ncontract = "C"\nargs = [1000, true]\n`, AT);
    expect(config.app.args).toEqual(["1000", "true"]);
  });
});

describe("refusals", () => {
  it("names what a file with no [app] section is missing, and shows the fix", () => {
    expect(() => parseConfig(`[node]\nport = 8555\n`, AT)).toThrow(/no \[app\] section/);
    expect(() => parseConfig(`[node]\nport = 8555\n`, AT)).toThrow(/contract = "Counter"/);
  });

  /// Both would mean two bootstraps: this command's and the script's, each deploying a hub.
  it("will not take a contract and a script at once", () => {
    expect(() =>
      parseConfig(`[app]\ncontract = "C"\nscript = "script/S.s.sol"\n`, AT),
    ).toThrow(/Pick one/);
  });

  it("wants one or the other", () => {
    expect(() => parseConfig(`[app]\nargs = []\n`, AT)).toThrow(/either contract/);
  });

  it("takes only a partition it can name", () => {
    expect(() => parseConfig(`[app]\ncontract = "C"\ndelegate = "some"\n`, AT)).toThrow(
      /neither "all" nor a 32-byte key/,
    );
    const key = `0x${"ab".repeat(32)}`;
    expect(parseConfig(`[app]\ncontract = "C"\ndelegate = "${key}"\n`, AT).app.delegate).toBe(key);
  });

  it("says which line of TOML is wrong rather than throwing a parser's words", () => {
    expect(() => parseConfig(`[app\ncontract =`, AT)).toThrow(ConfigError);
    expect(() => parseConfig(`[app\ncontract =`, AT)).toThrow(/is not valid TOML/);
  });
});

describe("setup calls", () => {
  it("keeps them in the order they were written, because seeding often depends on order", () => {
    const config = parseConfig(
      `[app]\ncontract = "C"\n\n[[setup]]\nsignature = "a()"\nargs = []\n\n` +
        `[[setup]]\nsignature = "b(uint256)"\nargs = [1]\n`,
      AT,
    );
    expect(config.app.setup.map((call) => call.signature)).toEqual(["a()", "b(uint256)"]);
    expect(config.app.setup[1]?.args).toEqual(["1"]);
  });

  it("insists on a signature, since a call with no name is not a call", () => {
    expect(() => parseConfig(`[app]\ncontract = "C"\n\n[[setup]]\nargs = []\n`, AT)).toThrow(
      /needs signature/,
    );
  });
});

describe("placeholders", () => {
  it("fills in what is known", () => {
    expect(substitute("$HUB", { $HUB: "0xabc" })).toBe("0xabc");
    expect(substitute("a-$APP-b", { $APP: "0xdef" })).toBe("a-0xdef-b");
  });

  /**
   * The alternative is a literal dollar sign reaching the chain, which fails somewhere with no
   * mention of the config file that caused it.
   */
  it("refuses one that names something which does not exist yet", () => {
    expect(() => substitute("$APP", { $HUB: "0xabc" })).toThrow(/is not known yet/);
    expect(() => substitute("$APP", { $HUB: "0xabc" })).toThrow(/\[\[setup\]\]/);
  });
});

describe("the file init writes", () => {
  /**
   * Generated config that does not parse is the worst first impression available: the reader has
   * done nothing wrong and the next command fails. This is here because the first version had
   * exactly that bug — a trailing comment inside a single-line array ate the closing bracket.
   */
  it("parses, which is not free: comments and arrays disagree in TOML", () => {
    const generated = starterConfig("Chips", "src/Chips.sol", [
      { type: "address", name: "hub_" },
      { type: "uint256", name: "stakeFloor" },
    ]);

    const config = parseConfig(generated, AT);
    expect(config.app.contract).toBe("Chips");
    expect(config.app.args).toEqual(["$HUB", "<fill in: uint256 stakeFloor>"]);
    expect(config.node.chainId).toBe(4242);
  });

  it("parses for a constructor that takes nothing at all", () => {
    const config = parseConfig(starterConfig("Bare", "src/Bare.sol", []), AT);
    expect(config.app.args).toEqual([]);
  });

  /**
   * `init` used to write "0" for every argument it could not know, and "$HUB" for every address.
   * A zero stake and a second hub address both deploy without complaint and are both wrong, so
   * what it cannot know is now left visibly unfinished — and dev and ship refuse it by name.
   */
  it("never writes a value it had to guess", () => {
    const generated = starterConfig("Market", "src/Market.sol", [
      { type: "address", name: "treasury", internalType: "address" },
      { type: "address", name: "h", internalType: "contract IInterludeHub" },
      { type: "uint256", name: "fee", internalType: "uint256" },
    ]);
    expect(parseConfig(generated, AT).app.args).toEqual([
      "<fill in: address treasury>",
      "$HUB",
      "<fill in: uint256 fee>",
    ]);
  });

  it("names the hub by parameter name when the type does not say", () => {
    expect(hubArgumentIndex([{ type: "uint256" }, { type: "address", name: "hub_" }])).toBe(1);
    expect(hubArgumentIndex([{ type: "address", name: "a" }, { type: "address", name: "b" }])).toBe(
      -1,
    );
    expect(hubArgumentIndex([{ type: "uint256" }, { type: "address", name: "x" }])).toBe(1);
  });

  it("says in the file that a per-key contract is for dev, not ship", () => {
    const generated = starterConfig("Rooms", "src/Rooms.sol", [{ type: "address", name: "hub_" }], {
      perKey: true,
    });
    expect(generated).toMatch(/cannot — the hosted node serves the whole\n# contract \(GLOBAL\) only/);
    expect(parseConfig(generated, AT).app.args).toEqual(["$HUB"]);
  });
});

describe("owner under [app]", () => {
  const MINE = "0x25912EA7D8B2B27cfE46b8F2BB197741a72B9802";
  const ANVIL_3 = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
  const withOwner = (owner: string) =>
    `[app]\ncontract = "C"\nargs = ["$HUB"]\nowner = "${owner}"\n`;

  it("is read, for ship", () => {
    expect(parseConfig(withOwner(MINE), AT).app.owner).toBe(MINE);
  });

  it("is refused when it is not an address, naming a placeholder, not somebody's account", () => {
    const message = refusal(() => parseConfig(withOwner("me"), AT));
    expect(message).toMatch(/owner = "me" is not an address/);
    // It used to suggest anvil's account #3, whose key is public: copied as is, that address
    // would have been offered the app on Monad testnet.
    expect(message).toMatch(/owner = "0xYourWallet"/);
    expect(message).not.toMatch(/0x90F79bf6/i);
  });

  it("is read even when it is one of anvil's accounts: dev and abi parse this file too", () => {
    // Refusing it here stopped `interlude dev` and `interlude abi`, which never use the owner,
    // for a line the 0.2.0 README told people to write. Whether it may own the app depends on
    // the control plane ship talks to, which this file does not name.
    expect(parseConfig(withOwner(ANVIL_3), AT).app.owner).toBe(ANVIL_3);
  });
});

describe("anvil's well-known accounts", () => {
  const ANVIL_3 = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
  const MINE = "0x25912EA7D8B2B27cfE46b8F2BB197741a72B9802";
  const PUBLIC_CONTROL = "https://control.interludelayer.xyz";

  it("are the ten the test mnemonic derives", () => {
    const mnemonic = "test test test test test test test test test test test junk";
    const derived = Array.from({ length: 10 }, (_, addressIndex) =>
      mnemonicToAccount(mnemonic, { addressIndex }).address.toLowerCase(),
    );
    expect([...WELL_KNOWN_DEV_ACCOUNTS]).toEqual(derived);
    expect(wellKnownDevAccount(ANVIL_3)).toBe(3);
    expect(wellKnownDevAccount(MINE)).toBeUndefined();
  });

  it("may not own an app behind the public control plane, or behind one ship cannot place", () => {
    expect(() => refuseWellKnownOwner(ANVIL_3, "--owner")).toThrow(`--owner ${ANVIL_3} is anvil's`);
    expect(() => refuseWellKnownOwner(ANVIL_3, "--owner", PUBLIC_CONTROL)).toThrow(ConfigError);
    expect(() => refuseWellKnownOwner(ANVIL_3, "--owner", "http://10.0.0.5:8080")).toThrow(
      ConfigError,
    );
  });

  it("are recognised however they are checksummed, and named by their index", () => {
    for (const [index, account] of WELL_KNOWN_DEV_ACCOUNTS.entries()) {
      for (const spelled of [account, `0x${account.slice(2).toUpperCase()}`]) {
        const refuse = () => refuseWellKnownOwner(spelled, "[app] owner", PUBLIC_CONTROL);
        expect(refuse).toThrow(ConfigError);
        expect(refuse).toThrow(`anvil's default account #${index}. Its private key is public`);
      }
    }
  });

  it("may own one on a control plane on this machine, where the chain is a local one", () => {
    const local = [
      "http://127.0.0.1:8080",
      "http://localhost:3000",
      "http://[::1]:9",
      "http://app.localhost",
    ];
    for (const control of local) {
      expect(() => refuseWellKnownOwner(ANVIL_3, "--owner", control), control).not.toThrow();
    }
  });

  it("does not mistake a lookalike host for this machine", () => {
    expect(isLoopbackUrl("http://127.0.0.1.example.com")).toBe(false);
    expect(isLoopbackUrl("http://localhost.example.com")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
    expect(isLoopbackUrl("http://127.0.0.1:8080/")).toBe(true);
  });

  it("leaves every other owner alone, wherever it ships", () => {
    expect(() => refuseWellKnownOwner(MINE, "--owner")).not.toThrow();
    expect(() => refuseWellKnownOwner(MINE, "--owner", PUBLIC_CONTROL)).not.toThrow();
  });
});

/** The message a call throws, so several things can be said about one refusal. */
function refusal(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a refusal, and nothing was thrown");
}

describe("the starter contract init prints", () => {
  it("asks for the compiler the vendored sources need", () => {
    const text = firstHour("src");
    expect(text).toContain("pragma solidity ^0.8.28;");
    expect(text).not.toContain("0.8.24");
    expect(text).toMatch(/cancun/);
    expect(text).toMatch(/a fresh `forge init` Counter does not/);
  });

  it("does not claim a remapping it failed to write", () => {
    expect(firstHour("src", false)).toMatch(/could not be written/);
    expect(firstHour("src", false)).not.toMatch(/The remapping is written/);
  });
});
