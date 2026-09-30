import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import { ArtifactError } from "../src/artifacts.js";
import { assertPortFree, devPreflight, findNodeBinary } from "../src/processes.js";

describe("finding the node binary", () => {
  it("refuses to pretend a missing node is on PATH", async () => {
    const previousPath = process.env.PATH;
    const previousBin = process.env.INTERLUDE_NODE_BIN;
    process.env.PATH = "/no/such/bin";
    delete process.env.INTERLUDE_NODE_BIN;
    try {
      await expect(findNodeBinary("/tmp")).rejects.toBeInstanceOf(ArtifactError);
      await expect(findNodeBinary("/tmp")).rejects.toThrow(/does not ship the Rust node/);
    } finally {
      process.env.PATH = previousPath;
      if (previousBin === undefined) delete process.env.INTERLUDE_NODE_BIN;
      else process.env.INTERLUDE_NODE_BIN = previousBin;
    }
  });
});

function hold(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

describe("dev's preflight", () => {
  it("names a port that is already taken, and the setting that moves it", async () => {
    const { server, port } = await hold();
    try {
      await expect(assertPortFree(port, "the base chain", "[chain] port")).rejects.toThrow(
        new RegExp(`port ${port}, where the base chain would listen, is already taken[\\s\\S]*\\[chain\\] port`),
      );
    } finally {
      server.close();
    }
  });

  it("notices a listener on every address, not only on 127.0.0.1", async () => {
    for (const host of ["0.0.0.0", "::", "::1"]) {
      const server = createServer();
      const listening = await new Promise<boolean>((resolve) => {
        server.once("error", () => resolve(false));
        server.listen(0, host, () => resolve(true));
      });
      if (!listening) continue; // no IPv6 on this machine
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      try {
        await expect(assertPortFree(port, "the node", "[node] port"), host).rejects.toThrow(/already taken/);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });

  it("passes a free port and leaves it free", async () => {
    const { server, port } = await hold();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(assertPortFree(port, "the node", "[node] port")).resolves.toBeUndefined();
    await expect(assertPortFree(port, "the node", "[node] port")).resolves.toBeUndefined();
  });

  it("checks ports before it goes looking for (or building) a node", async () => {
    const { server, port } = await hold();
    const previousBin = process.env.INTERLUDE_NODE_BIN;
    // A binary that does not exist: if the port check did not come first, this would be the error.
    process.env.INTERLUDE_NODE_BIN = "/no/such/interlude-node";
    try {
      await expect(devPreflight({ chain: port, node: port + 1 }, "/tmp")).rejects.toThrow(
        /already taken/,
      );
      await expect(devPreflight({ chain: port, node: port }, "/tmp")).rejects.toThrow(
        /both \d+\. They have to differ/,
      );
    } finally {
      server.close();
      if (previousBin === undefined) delete process.env.INTERLUDE_NODE_BIN;
      else process.env.INTERLUDE_NODE_BIN = previousBin;
    }
  });

  it("returns the binary when everything is there", async () => {
    const previousBin = process.env.INTERLUDE_NODE_BIN;
    process.env.INTERLUDE_NODE_BIN = process.execPath; // any file that exists
    try {
      const a = await hold();
      const b = await hold();
      await new Promise<void>((r) => a.server.close(() => r()));
      await new Promise<void>((r) => b.server.close(() => r()));
      await expect(devPreflight({ chain: a.port, node: b.port }, "/tmp")).resolves.toBe(
        process.execPath,
      );
    } finally {
      if (previousBin === undefined) delete process.env.INTERLUDE_NODE_BIN;
      else process.env.INTERLUDE_NODE_BIN = previousBin;
    }
  });
});
