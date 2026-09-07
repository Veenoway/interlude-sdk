import { describe, expect, it } from "vitest";
import { ArtifactError } from "../src/artifacts.js";
import { findNodeBinary } from "../src/processes.js";

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
