/**
 * `delegatableErrorsAbi`: the session machinery's reverts, decoded by name whatever ABI the
 * client was given.
 *
 * Written out by hand, it fell behind Delegatable: `KeyIsGlobalPartition`, `TermsRejected` and
 * `NotPendingOwner` decoded as the app's own rule (`AppRevertError`) against a compiled ABI, and
 * not at all against a hand-written one. So the list is derived here from the Solidity sources,
 * and checked against the compiled artifacts when `forge build` has left ones that are fresh.
 * Both need the repository; the SDK's mirror has neither, and these checks skip there.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeErrorResult,
  keccak256,
  parseAbi,
  toFunctionSignature,
  type Abi,
  type AbiFunction,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";

import {
  DelegatableError,
  NotRegisteredError,
  decodeRevert,
  delegatableAbi,
  delegatableErrorsAbi,
} from "../src/index";

type AbiError = Extract<Abi[number], { type: "error" }>;

const contracts = fileURLToPath(new URL("../../contracts/", import.meta.url));
const repo = resolve(contracts, "../..");
const delegatableSource = join(contracts, "src/Delegatable.sol");
const counterSource = join(contracts, "src/examples/Counter.sol");
const artifact = (name: string) => join(contracts, "out", `${name}.sol`, `${name}.json`);

const ours = (delegatableErrorsAbi as Abi).filter(
  (item): item is AbiError => item.type === "error",
);

describe("delegatableErrorsAbi", () => {
  it("decodes Delegatable's ownership and terms reverts by name", () => {
    // Encoded from their Solidity signatures, not from the list under test.
    const declared = parseAbi([
      "error KeyIsGlobalPartition()",
      "error NotPendingOwner()",
      "error TermsRejected(address validator)",
    ]);
    const validator = "0x00000000000000000000000000000000000000aa";
    const reverts: [string, Hex][] = [
      [
        "KeyIsGlobalPartition",
        encodeErrorResult({ abi: declared, errorName: "KeyIsGlobalPartition" }),
      ],
      ["NotPendingOwner", encodeErrorResult({ abi: declared, errorName: "NotPendingOwner" })],
      [
        "TermsRejected",
        encodeErrorResult({ abi: declared, errorName: "TermsRejected", args: [validator] }),
      ],
    ];
    for (const [errorName, data] of reverts) {
      // An app ABI with no errors at all: the name has to come from the SDK's own list.
      const error = decodeRevert(data, []);
      expect(error, errorName).toBeInstanceOf(DelegatableError);
      expect((error as DelegatableError).errorName).toBe(errorName);
    }
  });

  it("keeps TermsRejected's validator, in args and in the message", () => {
    const validator = "0x00000000000000000000000000000000000000aa";
    const data = encodeErrorResult({
      abi: parseAbi(["error TermsRejected(address validator)"]),
      errorName: "TermsRejected",
      args: [validator],
    });
    const error = decodeRevert(data, []) as DelegatableError;
    expect(error).toBeInstanceOf(DelegatableError);
    expect(error.args.map((arg) => String(arg).toLowerCase())).toEqual([validator]);
    expect(error.message.toLowerCase()).toContain(`termsrejected(${validator})`);
    // An error with no arguments reads as it always has.
    const bare = decodeRevert(
      encodeErrorResult({ abi: parseAbi(["error OnlyOwner()"]) }),
      [],
    ) as DelegatableError;
    expect(bare.args).toEqual([]);
    expect(bare.message).toBe(
      "the app reverted with OnlyOwner, raised by Delegatable rather than by the app.",
    );
  });

  it("decodes NotRegistered, the write guard every app writing a Delegated variable has", () => {
    const data = encodeErrorResult({ abi: parseAbi(["error NotRegistered()"]) });
    expect(decodeRevert(data, [])).toBeInstanceOf(NotRegisteredError);
  });

  it("names each error once", () => {
    const signatures = ours.map(signature);
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it.skipIf(!existsSync(delegatableSource))(
    "is every error Delegatable, what it inherits and the libraries it builds on declare",
    () => {
      const declared = sourceErrors(delegatableSource);
      // The three it had missed, so a parser that found nothing cannot pass by agreeing.
      expect(declared.map(describeError)).toEqual(
        expect.arrayContaining([
          "KeyIsGlobalPartition()",
          "NotPendingOwner()",
          "TermsRejected(address validator)",
        ]),
      );
      expect(sorted(ours)).toEqual(sorted(declared));
    },
  );

  it.skipIf(!fresh(artifact("Delegatable")) || !fresh(artifact("DelegatedLayout")))(
    "is every error Delegatable compiles with, and the write guard's, argument names included",
    () => {
      // Delegatable's artifact carries Session's errors, which `withSession` raises, but not
      // `NotRegistered`: only a `Delegated` write reaches that, and those are in the app.
      const compiled = [
        ...compiledErrors(artifact("Delegatable")),
        ...compiledErrors(artifact("DelegatedLayout")),
      ];
      expect(sorted(ours)).toEqual(sorted(compiled));
    },
  );

  it.skipIf(!existsSync(counterSource) || !fresh(artifact("Counter")))(
    "is exactly what an app that writes a Delegated variable compiles with beyond its own",
    () => {
      const own = new Set(sourceErrorsOf(counterSource).map(describeError));
      const inherited = compiledErrors(artifact("Counter")).filter(
        (error) => !own.has(describeError(error)),
      );
      expect(sorted(ours)).toEqual(sorted(inherited));
    },
  );
});

describe("delegatableAbi", () => {
  it("carries delegatableErrorsAbi whole", () => {
    const errors = (delegatableAbi as Abi).filter((item) => item.type === "error");
    expect(errors).toEqual([...delegatableErrorsAbi]);
  });

  it.skipIf(!fresh(artifact("Delegatable")))(
    "declares each function as Delegatable compiles it",
    () => {
      const compiled = new Map(
        (JSON.parse(readFileSync(artifact("Delegatable"), "utf8")) as { abi: Abi }).abi
          .filter((item): item is AbiFunction => item.type === "function")
          .map((item) => [item.name, item] as const),
      );
      for (const item of delegatableAbi) {
        if (item.type !== "function") continue;
        const real = compiled.get(item.name);
        expect(real, item.name).toBeDefined();
        expect(toFunctionSignature(item)).toBe(toFunctionSignature(real!));
        expect(item.stateMutability, item.name).toBe(real!.stateMutability);
        expect(
          item.outputs.map((output) => output.type),
          item.name,
        ).toEqual(real!.outputs.map((output) => output.type));
      }
    },
  );
});

// --- the sources ---------------------------------------------------------

/**
 * The errors declared by the contract in `entry`, by every contract and interface it inherits,
 * and by every library it imports, following the libraries' own imports too. An interface it
 * only calls (the hub's) is not followed: those errors are the hub's, not the app's.
 */
function sourceErrors(entry: string): AbiError[] {
  const found = new Map<string, AbiError>();
  const visited = new Set<string>();
  const visit = (path: string) => {
    if (visited.has(path)) return;
    visited.add(path);
    const text = solidity(path);
    const unit = declaration(path, text);
    for (const error of declaredErrors(text)) found.set(describeError(error), error);

    const imported = imports(path, text);
    for (const parent of unit.parents) {
      if (!imported.has(parent)) throw new Error(`${path}: ${parent} is not imported by name`);
    }
    for (const [name, file] of imported) {
      if (unit.parents.includes(name) || declaration(file, solidity(file)).kind === "library") {
        visit(file);
      }
    }
  };
  visit(entry);
  return [...found.values()];
}

/** The errors one file declares, and nothing it imports. */
function sourceErrorsOf(path: string): AbiError[] {
  return declaredErrors(solidity(path));
}

/** The file with its comments gone, so NatSpec that mentions an error is not read as one. */
function solidity(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

function declaration(path: string, text: string) {
  const units = [
    ...text.matchAll(/\b(contract|interface|library)\s+(\w+)(?:\s+is\s+([^{]+?))?\s*\{/g),
  ];
  if (units.length !== 1) {
    throw new Error(`${path}: expected one contract, interface or library, found ${units.length}`);
  }
  const [, kind, name, parents = ""] = units[0]!;
  return {
    kind: kind!,
    name: name!,
    // `is Base(arg)` names Base.
    parents: parents
      .split(",")
      .map((parent) => parent.trim().replace(/\(.*$/s, ""))
      .filter(Boolean),
  };
}

/** Each name a file imports, mapped to the file it comes from. */
function imports(path: string, text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const [statement] of text.matchAll(/\bimport\b[^;]*;/g)) {
    const named = /^import\s*\{([^}]*)\}\s*from\s*"([^"]+)"\s*;$/.exec(statement);
    if (!named || !named[2]!.startsWith(".")) {
      // A remapped or wildcard import would be skipped silently; better to say so.
      throw new Error(`${path}: cannot follow \`${statement}\`; extend this walk`);
    }
    const file = resolve(dirname(path), named[2]!);
    for (const part of named[1]!.split(",")) {
      const [name, alias] = part.trim().split(/\s+as\s+/);
      if (name) map.set((alias ?? name).trim(), file);
    }
  }
  return map;
}

function declaredErrors(text: string): AbiError[] {
  return [...text.matchAll(/\berror\s+(\w+)\s*\(([^)]*)\)\s*;/g)].map(([, name, params]) => ({
    type: "error",
    name: name!,
    inputs: params!
      .split(",")
      .map((param) => param.trim())
      .filter(Boolean)
      .map((param) => {
        const [type, ...rest] = param.split(/\s+/);
        return { type: canonical(type!), name: rest.at(-1) ?? "" };
      }),
  }));
}

/** The ABI's spelling of a Solidity parameter type. Structs and enums are not handled. */
function canonical(type: string): string {
  const spelled = type.replace(/^(u?int)(?=$|\[)/, "$1256");
  if (!/^(address|bool|string|bytes\d*|u?int\d+)(\[\d*\])*$/.test(spelled)) {
    throw new Error(`error parameter of type ${type}: extend this parser`);
  }
  return spelled;
}

// --- the artifacts -------------------------------------------------------

function compiledErrors(path: string): AbiError[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { abi: Abi }).abi.filter(
    (item): item is AbiError => item.type === "error",
  );
}

/**
 * Whether `forge build` left this artifact from the sources as they are now: every source its
 * metadata names still hashes to what it recorded. A stale one would test the SDK against a
 * contract that no longer exists, so its checks skip; the source checks above still run.
 */
function fresh(path: string): boolean {
  if (!existsSync(path)) return false;
  const { rawMetadata } = JSON.parse(readFileSync(path, "utf8")) as { rawMetadata?: string };
  if (!rawMetadata) return false;
  const { sources } = JSON.parse(rawMetadata) as {
    sources: Record<string, { keccak256: Hex }>;
  };
  return Object.entries(sources).every(([source, { keccak256: recorded }]) => {
    // Relative to the Foundry root: the repository's, or packages/contracts' own.
    const file = [join(repo, source), join(contracts, source)].find((candidate) =>
      existsSync(candidate),
    );
    return file !== undefined && keccak256(new Uint8Array(readFileSync(file))) === recorded;
  });
}

// --- comparing -----------------------------------------------------------

/** `Name(type name,type name)`: the selector's signature, with the argument names kept. */
function describeError(error: AbiError): string {
  const params = error.inputs.map((input) => [input.type, input.name].filter(Boolean).join(" "));
  return `${error.name}(${params.join(",")})`;
}

function signature(error: AbiError): string {
  return `${error.name}(${error.inputs.map((input) => input.type).join(",")})`;
}

/** Deduplicated and sorted, so a list compares by what it holds and not by its order. */
function sorted(errors: readonly AbiError[]): string[] {
  return [...new Set(errors.map(describeError))].sort();
}
