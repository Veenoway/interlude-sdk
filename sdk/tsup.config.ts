import { readFile, writeFile } from "node:fs/promises";
import { defineConfig } from "tsup";

/**
 * The React entry is hooks and a provider, so under the Next.js App Router it has to be a client
 * module. Prepended after the build rather than set as a `banner`: the banner applies to every
 * entry, and the core entry must stay importable from a server component, and rollup's
 * tree-shaking pass drops module-level directives it finds inside a bundle.
 */
const CLIENT_ENTRIES = ["dist/react.js", "dist/react.cjs"];

export default defineConfig({
  entry: { index: "src/index.ts", react: "src/react/index.tsx" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  treeshake: true,
  // React and viem are the host application's, not ours: two copies of viem would mean two
  // account caches, and two copies of React is a hook error.
  external: ["react", "viem"],
  async onSuccess() {
    for (const file of CLIENT_ENTRIES) {
      const code = await readFile(file, "utf8").catch(() => undefined);
      if (code === undefined || code.startsWith('"use client"')) continue;
      await writeFile(file, `"use client";\n${code}`);
    }
  },
});
