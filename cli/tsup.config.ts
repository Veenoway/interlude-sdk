import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  // A `bin` entry has to be executable on its own, and npm only makes the file executable — it
  // does not add the line that tells the kernel what to run it with.
  banner: { js: "#!/usr/bin/env node" },
});
