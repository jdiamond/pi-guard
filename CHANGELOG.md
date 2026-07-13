# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- **Custom TUI approval dialog** — Replaced the built-in `ctx.ui.select` prompt
  with a custom pi-tui component. The dialog shows a styled title, optional body,
  and command list with `SelectList` choices at the bottom. Allowed commands are
  rendered in the success color, unallowed commands in the warning color, and all
  content is left-aligned inside a bordered frame.
- **Clearer approval choice labels** — The "Always allow" options are now labeled
  "Temporarily allow ... (this session only)" and "Permanently allow ... (save to
  settings.json)", making them easier to distinguish from "Allow" at a glance.
- **Persistent bash rules and command-level session rules** — New "Always allow
  (save to settings.json)" option persists patterns to `~/.pi/agent/settings.json`.
  Both session and persistent options now open an editor pre-filled with
  unauthorized command patterns — trim, wildcard, or delete lines before
  confirming. Cancel returns to the approval select.

## [1.4.0] - 2026-07-11

### Added

- **herdr integration** — Emits `herdr:blocked` events with `active: true/false` around each approval prompt so herdr can track when pi-guard is blocking execution.
- **Pipeline and redirect operators in approval prompts** — Commands connected by `|`, `&&`, `||`, or `;` now show the operator at the end of each line. Commands from different structural contexts (e.g., outer command vs. subshell expansion) are separated by blank lines. Previously these operators were silently dropped.
  ```
  ✖ cat foo |
  ✔ grep bar |
  ✖ wc -l
  ```
- **Subshell elision in approval prompts** — Command expansions (`$()`, backticks) and process substitutions (`<()`, `>()`) in the outer command are replaced with `...` to avoid duplication, since the inner commands are displayed on their own lines.
  ```
  ✖ echo $(...)

  ✖ sort out
  ```
- **Wrapper command expansion** — Commands like `xargs`, `sudo`, `bash -c`, `find -exec`, and `fd -x` that embed sub-commands are now expanded and each sub-command is independently checked against rules. For example, `xargs rm` is now checked as both `xargs` (allowed) and `rm` (ask). Nested wrappers are also handled (`sudo xargs rm` → checks `rm` through both).
- Wrapper display in approval prompts — Expanded wrapper commands show `...` in place of the sub-command to avoid redundancy. For example, `xargs rm` displays as `xargs ...` with `rm` shown separately.
- `xargs` and `fd` added to default allow rules — safe wrappers whose sub-commands are independently checked.
- Glob patterns (`*` and `?`) in bash command rule tokens — e.g., `"sed -i*": "ask"` matches `-i`, `-i.bak`, and any other `-i` variant.
- Default rules: `sed` is allowed; `sed -i*`, `sed -I*`, and `sed --in-place*` (in-place edits) require approval.

### Changed

- **Custom tool approval prompts now show all parameters** — Previously only the first parameter value was displayed with no key label (e.g. a bare `"1"` for `git_add_pr_comment`). Now all non-`undefined` parameters are shown as `key: value` pairs, one per line, with type-aware formatting: strings are truncated at 200 chars, arrays are comma-joined, booleans and numbers are shown as-is, and `undefined` values are omitted.
- Bare assignments (commands with prefix assignments but no command name, e.g. `TOKEN=$(...)`) are now shown in approval prompts instead of being silently dropped. Previously, `TOKEN=$(curl ... | jq ...) && curl ...` would only display the inner and outer `curl` commands — the assignment line was invisible.
- Removed `"find -exec": "ask"` from default rules — sub-commands inside `-exec` are now independently checked by wrapper expansion, making the blanket rule redundant.
- `isSubsequence` now supports glob wildcards in tokens (via `minimatch`) instead of exact string matching only.
- **Package renamed** — `@mariozechner/pi-coding-agent` → `@earendil-works/pi-coding-agent` (0.79.1). The old package is deprecated.
- **Dependencies updated and pinned:** `minimatch` 10.2.5, `unbash` 4.0.0, `typebox` 1.1.39, `@biomejs/biome` 2.4.16, `typescript` 6.0.3, `@types/node` 25.9.1.
- **Removed `@types/minimatch`** — minimatch 10.x ships its own types.

### Fixed

- Redirect formatting in approval prompts preserves original spacing — `> /tmp/file` is no longer squished to `>/tmp/file`. The formatter now uses source slices for redirect spans instead of reconstructing from AST tokens.
- **unbash 4.0.0 compatibility** — unbash 4.0.0 made inner substitution script `pos`/`end` absolute in the original source (previously relative to the extracted inner text). pi-guard now re-parses the extracted inner text with unbash to get fresh AST nodes with relative positions, avoiding position mismatches in command display and rule matching.

## [1.3.0] - 2026-04-25

### Fixed

- `globMatch` now matches dot files (e.g., `*.env` matches `.env`) thanks to @tdiam
- `pi install npm:pi-guard` now works — `unbash` is a proper npm dependency instead of a Git target, fixing install failures where `tsc` wasn't available (#2)

### Changed

- Default rules for `read` now use `**/*.env` and `**/*.pem` to deny access in nested directories too, thanks to @tdiam

## [1.2.0] - 2026-04-19

### Added

- **Profiles** — Named rule overlays that can be activated during a session. Useful for switching between permission modes (e.g., read-only vs read-write) without editing config.
- **Shortcuts** — Custom commands that activate profiles or deactivate them. Define `/rw` to activate a "read-write" profile, `/ro` to deactivate.
- `/guard profile` — Show active profile and available profiles
- `/guard profile <name>` — Activate a profile by name
- `/guard profile off` — Deactivate current profile
- `/guard enable` — Enable guard
- `/guard disable` — Disable guard

### Changed

- `/guard list` now shows rules organized by provenance layer (default → user → project → environment → profile → session) instead of merged effective rules.
- Rule precedence corrected: `default → user → project → env → profile → session`. Session rules now correctly override env (`PI_GUARD`).
- Configuration (user, project, env) is now loaded once at extension startup instead of on every tool call, improving performance.

## [1.1.0] - 2026-04-01

### Added

- Safe bash commands — whitelisted commands that bypass permission checks (`echo`, `printf`, `true`, `false`, `pwd`, `cd`, etc.)
- `gh` CLI support — built-in matcher for GitHub CLI commands with subsequence matching
- `find -exec` rule — requires explicit approval for `find -exec` commands
- Matchers and rules for optional tools `grep`, `find`, and `ls`
- GitHub Actions workflow for trusted npm publishing via OIDC

### Fixed

- `/guard list` now shows effective rules (previously showed only base config)

### Changed

- Consolidated default configuration into `defaults.ts` for single source of truth
- Simplified README

## [1.0.0] - 2026-03-28

### Added

- General-purpose permission system for pi tools, replacing `pi-unbash`.
- Built-in matchers for core tools:
  - `bash` — Parses commands with unbash AST parser, extracts all commands, uses subsequence matching. Rule tokens must appear in order but extra flags/arguments are permitted. Example: `"git log"` matches `git log`, `git log --oneline`, `git log --oneline -10`.
  - `glob` — Standard glob matching with `*` and `**` support, `?` for single character, and `~` home directory expansion. For file paths, URLs, etc.
  - `exact` — Simple string equality for enum values, agent names, etc.
- Extensible matchers via configuration — add permission checking for any tool by defining a `param` and `type` in settings.
- Three permission actions: `allow` (run without approval), `ask` (prompt user), `deny` (block the action).
- Rule precedence in merge order: `DEFAULT_CONFIG → user config → project config → PI_GUARD → session rules`. Last match wins within each layer.
- `PI_GUARD` environment variable for injecting rules from outside (e.g., CI/CD, pi-spawn).
- Project-level settings from `.pi/settings.json` — share team rules via version control.
- `/guard toggle` — Enable or disable the guard system.
- `/guard list` — Display current configuration including all rule layers.
- Session-scoped approvals — "Always allow X (this session)" option in approval prompts without persisting to disk.
- Comprehensive bash command extraction — handles pipes, subshells, command substitutions, process substitutions, redirects, heredocs, arithmetic expansions, and control flow structures (`if`, `while`, `for`, `case`, functions).
- Smart command display — path-aware elision for long paths, preserves original quoting, handles heredocs and redirects.
- Block messages for user rejection vs security policy vs non-interactive mode.
