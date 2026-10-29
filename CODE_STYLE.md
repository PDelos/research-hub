# Code style

This repository follows the **code-aesthetic** rules (from the CodeAesthetic videos; the skill lives in
`~/.claude/skills/code-aesthetic/`): no nesting past three levels (inversion and extraction), honest names (no single
letters outside tiny lambdas and loop indexes, no abbreviations, units in names, no `utils`), code over comments
(documentation and "why" comments stay), abstraction only when it pays for its coupling, composition over
inheritance, dependency injection, no premature optimization, pure functions where they help.

## What enforces it

- **The formatter** (`vp fmt`, Oxfmt) owns layout.
- **The linter** (`vp lint`, Oxlint; rules in `vite.config.ts`): `max-depth` 3, `max-nested-callbacks` 3,
  `complexity` 15, `max-lines-per-function` 80, `max-lines` 400, `max-params` 4, `no-else-return`, `no-nested-ternary`,
  `unicorn/no-lonely-if`, and the name rules of our plugin `lint/code-aesthetic.mjs` (`aesthetic/no-single-letter`,
  `aesthetic/no-abbreviations`, `aesthetic/no-utils-module`).
- Rules with work left are **warnings**; `vp lint .` lists every open item, and a rule becomes an **error** when it
  reaches zero. Errors now: the three name rules, `max-depth`, `max-nested-callbacks`, `max-params`, `no-nested-ternary`, `no-else-return`, `unicorn/no-lonely-if`. Vendored packages (`packages/durable-agent`, `packages/jev`) are out of scope; tests skip the size
  rules (they are lists of steps) but keep nesting and names.

To see what is open: `npx vp lint . 2>&1 | grep -E "aesthetic|max-|complexity|nested-ternary"`.

## Not checked by any rule (kept by hand)

Reviewed during the cleanup and in code review:

- Small helpers duplicated across plugins (`jsonObject`, `str`, cosine similarity): keep the duplication unless a
  third copy appears (abstraction only when it pays).
- Comments that repeat the code instead of saying why.
- Numbers that mean something (thresholds, limits) as named constants; plain timeouts and sizes may stay inline with
  their unit in the name.
