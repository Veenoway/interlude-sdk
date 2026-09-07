import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Abi, Address, Hex } from "viem";

import {
  ArtifactError,
  compiledContracts,
  findProjectRoot,
  forgeBuild,
  readArtifactAt,
} from "./artifacts.js";
import { parseConfig } from "./config.js";
import { ensureRemapping, findInterludeContracts } from "./remappings.js";
import { fail, note, ok, pairs, say, step } from "./ui.js";

/** Public control plane. Override with INTERLUDE_CONTROL_URL only for a laptop. */
export const DEFAULT_CONTROL_URL = "https://control.interludelayer.xyz";

export function controlUrl(argv: string[] = []): string {
  return (flag(argv, "--control") ?? process.env.INTERLUDE_CONTROL_URL ?? DEFAULT_CONTROL_URL).replace(
    /\/$/,
    "",
  );
}

/**
 * Compile locally, send us the bytecode, get a node URL back.
 *
 * No key, no invite, no message to us. The URL is public; we pay; a rate limit
 * is what stops a loop from draining the faucet wallet.
 */
export async function ship(argv: string[]): Promise<void> {
  const control = controlUrl(argv);

  const projectRoot = findProjectRoot(process.cwd());
  wire(projectRoot);

  if (!argv.includes("--no-build")) {
    step("compiling");
    await forgeBuild(projectRoot);
  }

  const { name, artifact } = pickContract(projectRoot, flag(argv, "--contract"));
  if (!artifact.abi.some((item) => item.type === "function" && item.name === "delegateAll")) {
    fail(`${name} has no delegateAll. Inherit Delegatable and run interlude gen.`);
  }

  step(`sending ${name} to us — we deploy and run the node`);
  const session = await publish(control, artifact.bytecode, artifact.abi, flag(argv, "--stake"));
  ok(session.url);

  pairs([
    ["app", session.app],
    ["node", session.url],
  ]);
  say("");
  note("point the SDK at that node. no faucet, no key, no hub to copy.");
}

async function publish(
  control: string,
  bytecode: Hex,
  abi: Abi,
  stake?: string,
): Promise<{ app: Address; url: string }> {
  const slim = abi.filter(
    (item) =>
      item.type === "constructor" || (item.type === "function" && item.name === "delegateAll"),
  );
  const response = await fetch(`${control}/apps`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bytecode, abi: slim, ...(stake ? { stake } : {}) }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    app?: Address;
    url?: string;
    error?: string;
  };
  if (!response.ok || !body.app || !body.url) {
    fail(body.error ?? `control ${response.status}`);
  }
  return { app: body.app, url: body.url };
}

function pickContract(projectRoot: string, wanted?: string) {
  const toml = join(projectRoot, "interlude.toml");
  const named =
    wanted ??
    (existsSync(toml) ? parseConfig(readFileSync(toml, "utf8"), toml).app.contract : undefined);

  const outDir = join(projectRoot, "out");
  const candidates = compiledContracts(outDir)
    .filter((contract) => contract.source.startsWith(`${sourceDir(projectRoot)}/`))
    .filter((contract) =>
      readArtifactAt(contract.artifactPath).abi.some(
        (item) => item.type === "function" && item.name === "delegateAll",
      ),
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  const chosen = named
    ? candidates.find((contract) => contract.name === named)
    : candidates.length === 1
      ? candidates[0]
      : undefined;

  if (!chosen) {
    const list = candidates.map((c) => `  ${c.name}`).join("\n");
    fail(
      named
        ? `no delegatable contract named ${named}`
        : `this project has ${candidates.length} delegatable contracts. pass --contract <name>:\n${list}`,
    );
  }
  if (!chosen) fail("no contract");
  return { name: chosen.name, artifact: readArtifactAt(chosen.artifactPath) };
}

function sourceDir(projectRoot: string): string {
  const config = join(projectRoot, "foundry.toml");
  if (!existsSync(config)) return "src";
  const found = /^\s*src\s*=\s*["']([^"']+)["']/m.exec(readFileSync(config, "utf8"));
  return found?.[1]?.replace(/\/$/, "") ?? "src";
}

function wire(projectRoot: string): void {
  try {
    ensureRemapping(projectRoot, findInterludeContracts(projectRoot));
  } catch (error) {
    if (error instanceof ArtifactError) return;
    throw error;
  }
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}
