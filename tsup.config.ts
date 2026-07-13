import { defineConfig } from "tsup";

/**
 * Bundles the `glassray` CLI into a single executable `dist/bin.js`. The package
 * is intentionally self-contained (no workspace / `@helix/*` coupling), so this
 * config carries no `noExternal` — there is nothing external to inline. tsup
 * detects the entry's `#!/usr/bin/env node` shebang and marks the output
 * executable. The bundled skill asset (`assets/skill/SKILL.md`) is resolved at
 * runtime relative to `import.meta.url`, so it is NOT bundled — it ships
 * alongside `dist/` via the package's `files` allowlist.
 */
export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: true,
});
