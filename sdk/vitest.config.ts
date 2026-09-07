import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Both suites talk to one anvil and one node, and the end-to-end one owns a session key's
    // nonce sequence. Running files at the same time would interleave them.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
