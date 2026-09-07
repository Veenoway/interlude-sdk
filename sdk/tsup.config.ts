import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", react: "src/react/index.tsx" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  treeshake: true,
  // React and viem are the host application's, not ours: two copies of viem would mean two
  // account caches, and two copies of React is a hook error.
  external: ["react", "viem"],
});
