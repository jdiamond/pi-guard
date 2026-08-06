pi-guard is a pi extension that adds permission gating for tools. It intercepts `tool_call` events and prompts the user before executing commands or file operations based on configurable rules.

**Bash commands:** Bash input is parsed with the `unbash` AST parser. Commands in pipelines, shell substitutions, wrappers, and other nested constructs are extracted and evaluated independently; do not assess safety from raw shell text alone.

**Default behavior:** inspect `src/defaults.ts` before assessing or changing built-in allowed commands. It is the source of truth for default rules.

**Rule precedence (last match wins):** default → user config → project config → PI_GUARD env var → session rules

**Testing:** `node --test test/<file>.ts` for a single test file, `npm test` for the full suite

**Type checking:** `npm run typecheck`

**Linting:** `npm run lint` to check, `npm run lint:fix` to auto-fix, `npm run lint -- <file>` for a single file

**Formatting:** `npm run format:check` to check, `npm run format` for auto-fix, `npm run format -- <file>` for a single file

**Check (static only):** `npm run check` (typecheck + lint + format:check)

**Verify (everything):** `npm run verify` (check + test)

**No `npx` or `tsx`.** This project uses Node's built-in type stripping. For single-file targeting, use scripts like `npm run lint -- <file>` passthrough. Never reach for `npx` or `tsx` as a workaround.

**No non-null assertions (`!`).** Use early returns, `assert.ok` guards, or explicit `undefined` checks instead. For test helpers that need to narrow away `undefined`, use `assert.ok` before accessing the value — don't use `!` to silence the type checker.
