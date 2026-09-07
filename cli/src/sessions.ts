import { isAddress } from "viem";

import { controlUrl } from "./ship.js";
import { fail, note, ok, pairs, say, step } from "./ui.js";

/**
 * Ask the operator control plane for a node URL.
 *
 * The partner never talks to Fly. They deploy against the public hub, call delegateAll,
 * then this — or they wait: the control plane watches DelegationOpened and spawns on its own.
 */
export async function sessions(argv: string[]): Promise<void> {
  const command = argv[0];
  if (command !== "create" && command !== "get") {
    fail("usage: interlude sessions create <app>  |  interlude sessions get <app>");
  }

  const app = argv[1];
  if (!app || !isAddress(app)) fail("pass the delegated app address");

  const url = controlUrl(argv);
  const token = flag(argv, "--token") ?? process.env.INTERLUDE_CONTROL_TOKEN;
  step(command === "create" ? `asking for a node at ${app}` : `looking up ${app}`);
  // Token is optional: POST /sessions is authorised by the hub (Active + our validator).

  const response = await fetch(
    command === "create" ? `${url}/sessions` : `${url}/sessions/${app}`,
    {
      method: command === "create" ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(command === "create" ? { body: JSON.stringify({ app }) } : {}),
    },
  );

  const body = (await response.json().catch(() => ({}))) as {
    url?: string;
    name?: string;
    status?: string;
    error?: string;
  };

  if (!response.ok) {
    fail(body.error ?? `control ${response.status}`);
  }
  if (!body.url) fail("control answered without a url");

  ok(body.url);
  pairs([
    ["app", app],
    ["node", body.url],
    ...(body.name ? ([["fly", body.name]] as [string, string][]) : []),
    ...(body.status ? ([["status", body.status]] as [string, string][]) : []),
  ]);
  if (command === "create") {
    note("point the SDK at that node. commits settle on our validator.");
    say("");
  }
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}
