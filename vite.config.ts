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
    // Name rules Oxlint has no built-in for (the code-aesthetic skill): lint/code-aesthetic.mjs.
    jsPlugins: ["./lint/code-aesthetic.mjs"],
    categories: { correctness: "error", suspicious: "warn" },
    rules: {
      // Tests and fixtures use `any` to poke at internals.
      "typescript/no-explicit-any": "off",
      // Express 5 forwards rejected promises from async handlers to the error middleware itself.
      "oxc/no-async-endpoint-handlers": "off",
      // Code aesthetics (the code-aesthetic skill; CODE_STYLE.md): warnings until STYLE_REPORT.md is empty, then errors.
      "max-depth": ["error", { max: 3 }],
      "max-nested-callbacks": ["error", { max: 3 }],
      complexity: ["error", { max: 15 }],
      "max-lines-per-function": ["error", { max: 80, skipBlankLines: true, skipComments: true }],
      "max-lines": ["error", { max: 400, skipBlankLines: true, skipComments: true }],
      "max-params": ["error", { max: 4 }],
      "no-else-return": "error",
      "no-nested-ternary": "error",
      "unicorn/no-nested-ternary": "off",
      "unicorn/no-lonely-if": "error",
      "aesthetic/no-single-letter": "error",
      "aesthetic/no-abbreviations": "error",
      "aesthetic/no-utils-module": "error",
    },
    overrides: [
      {
        files: ["**/tests/**", "**/*.test.ts", "**/e2e/**"],
        rules: {
          "no-unused-vars": "off",
          // Tests are long lists of steps and assertions; the nesting and naming rules still apply.
          "max-lines-per-function": "off",
          "max-lines": "off",
          complexity: "off",
        },
      },
      {
        // Vendored from pi-durable-news-agent (NOTICE.md): kept close to upstream.
        files: ["packages/durable-agent/**", "packages/jev/**"],
        rules: {
          "max-depth": "off",
          "max-nested-callbacks": "off",
          complexity: "off",
          "max-lines-per-function": "off",
          "max-lines": "off",
          "max-params": "off",
          "no-nested-ternary": "off",
          "unicorn/no-lonely-if": "off",
          "no-else-return": "off",
          "aesthetic/no-single-letter": "off",
          "aesthetic/no-abbreviations": "off",
          "aesthetic/no-utils-module": "off",
        },
      },
    ],
  },
});
