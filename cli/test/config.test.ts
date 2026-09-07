import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig, substitute } from "../src/config.js";
import { starterConfig } from "../src/starter.js";

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
    expect(config.app.args).toEqual(["$HUB", "0"]);
    expect(config.node.chainId).toBe(4242);
  });

  it("parses for a constructor that takes nothing at all", () => {
    const config = parseConfig(starterConfig("Bare", "src/Bare.sol", []), AT);
    expect(config.app.args).toEqual([]);
  });
});
