import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * Self-contained flat ESLint config for the `glassray` CLI. Deliberately does
 * NOT extend a workspace preset — the package must be liftable into its own
 * public repo with zero changes.
 */
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", ".turbo/**", "assets/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
);
