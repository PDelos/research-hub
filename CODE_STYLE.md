# Code style

This repository follows the **code-aesthetic** rules (from the CodeAesthetic videos; the skill lives in
`~/.claude/skills/code-aesthetic/`): no nesting past three levels (inversion and extraction), honest names (no single
letters outside tiny lambdas and loop indexes, no abbreviations, units in names, no `utils`), code over comments
(documentation and "why" comments stay), abstraction only when it pays for its coupling, composition over
inheritance, dependency injection, no premature optimization, pure functions where they help.

## What enforces it

- **The formatter** (`vp fmt`, Oxfmt) owns layout.
- **The linter** (`vp lint`, Oxlint; rules in `vite.config.ts`), all as **errors**, so `npm run check` fails on a
  new violation:
  - size and shape: `max-depth` 3, `max-nested-callbacks` 3, `complexity` 15, `max-lines-per-function` 80,
    `max-lines` 400, `max-params` 4;
  - flow: `no-else-return`, `no-nested-ternary`, `unicorn/no-lonely-if`;
  - names, from our plugin `lint/code-aesthetic.mjs`: `aesthetic/no-single-letter`, `aesthetic/no-abbreviations`,
    `aesthetic/no-utils-module`.
- Vendored packages (`packages/durable-agent`, `packages/jev`) are out of scope. Tests skip the size rules (they are
  lists of steps) but keep nesting and names.
- Line counts skip blank lines and comments, so a well-documented file is not punished.

## How the code is organised as a result

- A plugin's `main.ts` wires its parts and returns its exports. Its tables live in a `store.ts` (or a named store
  module), its long procedures in modules named for what they do (`review.ts`, `benchmarks.ts`, `procedures.ts`,
  `sources.ts`), and its view builders beside them (`slots.ts`, `sections.ts`).
- Route files list routes; checking a body and building a view are named functions above the router.
- Agent tools are defined in constructors; their bodies are methods.
- A module that re-exports names it moved (`export * from`, `export { … } from`) keeps importers unchanged.

## Not checked by any rule (kept by hand)

Reviewed during the cleanup and in code review:

- Small helpers duplicated across plugins (`jsonObject`, `str`, cosine similarity, the "spent since" cost query):
  keep the duplication unless a third copy appears (abstraction only when it pays).
- Comments that repeat the code instead of saying why.
- Numbers that mean something (thresholds, limits) as named constants; plain timeouts and sizes may stay inline with
  their unit in the name.

## Warnings left (Oxlint's default "suspicious" category, not the rules above)

`npx vp lint . 2>&1 | grep warning` lists them. At the end of the cleanup: `unicorn/consistent-function-scoping` 31
(functions that capture nothing could move to module scope), `unicorn/no-array-sort` 22 and `no-array-reverse` 4
(`toSorted`/`toReversed` instead of mutating), `no-shadow` 8 (mostly tests and vendored code), `no-underscore-dangle`
4, `no-unmodified-loop-condition` 2, `preserve-caught-error` 1 (vendored). They fit rule 8 (functional where it
helps) and can be cleared the same way when someone touches those files.
