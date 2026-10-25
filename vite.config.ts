// Vite+ workspace config: formatting (Oxfmt) and linting (Oxlint) for the whole repository, enforced by
// `vp check` (run through `npm run check`, together with the TypeScript and Vue type checks). The UI's own
// build config lives in apps/rh-client-browser/vite.config.ts.
import { defineConfig } from "vite-plus";

// Recorded data, generated files and text that must keep its exact bytes (prompts, notes, fixtures).
const untouched = [
  "**/node_modules/**",
  "**/dist/**",
  "projects/**",
  "data/**",
  "data-*/**",
  "openspec/**",
  "**/*.md",
  "package-lock.json",
  "apps/rh-server/prompt_engineering/**",
  "apps/rh-server/vault-template/**",
  "apps/rh-server/tests/fixtures/papers/**",
];

export default defineConfig({
  fmt: {
    printWidth: 120,
    tabWidth: 2,
    ignorePatterns: untouched,
  },
  lint: {
    ignorePatterns: untouched,
    plugins: ["typescript", "unicorn", "oxc", "vue"],
    categories: { correctness: "error", suspicious: "warn" },
    rules: {
      // Tests and fixtures use `any` to poke at internals.
      "typescript/no-explicit-any": "off",
      // Express 5 forwards rejected promises from async handlers to the error middleware itself.
      "oxc/no-async-endpoint-handlers": "off",
    },
    overrides: [
      {
        files: ["**/tests/**", "**/*.test.ts"],
        rules: { "no-unused-vars": "off" },
      },
    ],
  },
});
