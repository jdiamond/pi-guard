# pi-guard

**Permission system for [pi](https://github.com/mariozechner/pi-coding-agent) tools**

pi-guard intercepts tool calls and prompts for approval before executing potentially dangerous operations. It provides fine-grained, pattern-based permissions for bash commands, file access, and any custom tool — with sensible defaults that let you start safely.

## Features

- **Bash command matching** — Parses shell commands with an AST parser, handles pipes, subshells, wrapper commands (`sudo`, `xargs`, `bash -c`, `find -exec`), and supports glob tokens in rules
- **Path matching** — Glob patterns for file read/write/edit permissions
- **Extensible** — Add matchers for any tool with `exact`, `glob`, or `bash` matching
- **Sensible defaults** — Reading is safe, writing is dangerous. Works out of the box
- **Layered configuration** — Default → user → project → env → profile → session, last match wins
- **Non-interactive support** — Denied commands are silently blocked in CI/CD; use `PI_GUARD` env var for automation
- **Session rules** — "Always allow for this session" without modifying config files

## Examples

When a tool call is covered by an `ask` rule, pi-guard intercepts it and prompts for approval. Commands get reformatted and abridged to make them easier to review. Allowed commands get ✔, unauthorized ones get ✖.

When the agent runs:

```bash
rm -rf dist/
```

The prompt looks like:

```
⚠️ Unapproved Commands

✖ rm -rf dist/

→ Allow
  Always allow rm (this session)
  Reject
```

For commands with pipes and subshells, each sub-command is checked independently. When the agent runs:

```bash
TOKEN=$(curl -s https://api.example.com/token | jq -r .access_token) && \
curl -H "Authorization: Bearer $TOKEN" https://api.example.com/data
```

The prompt looks like:

```
⚠️ Unapproved Commands

✔ TOKEN=$(...) &&
✖ curl -s https://api.example.com/token |
✔ jq -r .access_token

✖ curl -H "Authorization: Bearer $TOKEN" https://api.example.com/data

→ Allow
  Always allow curl (this session)
  Reject
```

Wrapper commands (`xargs`, `find -exec`) are expanded — the wrapper gets ✔, the inner command is checked on its own line. When the agent runs:

```bash
grep -rl 'TODO' src/ | xargs sed --in-place 's/TODO/DONE/g'
```

The prompt looks like:

```
⚠️ Unapproved Commands

✔ grep -rl 'TODO' src/ |
✔ xargs ...
✖ sed --in-place s/TODO/DONE/g

→ Allow
  Always allow sed (this session)
  Reject
```

Or with `find -exec`:

```bash
find src/ -name '*.test.ts' -exec rm {} \;
```

The prompt looks like:

```
⚠️ Unapproved Commands

✔ find src/ -name *.test.ts -exec ...
✖ rm {}

→ Allow
  Always allow rm (this session)
  Reject
```

For file operations, there's no command to parse — the prompt shows the path being accessed:

```
⚠️ Write Permission Required

src/lib/config.ts

→ Allow
  Always allow write (this session)
  Reject
```

For custom tools, the prompt shows the matched parameter value:

```
⚠️ web_fetch Permission Required

https://api.github.com/repos/jdiamond/pi-guard/issues

→ Allow
  Always allow web_fetch (this session)
  Reject
```

In non-interactive mode (e.g., CI), unauthorized commands are silently blocked without a prompt.

## Install

```bash
pi install npm:pi-guard
```

## Configuration

Configure in `~/.pi/agent/settings.json` or `.pi/settings.json` (project-level):

```json
{
  "guard": {
    "enabled": true,
    "matchers": {
      "spawn": { "param": "agent", "type": "exact" },
      "webfetch": { "param": "url", "type": "glob" }
    },
    "rules": {
      "*": "ask",
      "bash": {
        "*": "ask",
        "git status": "allow",
        "git log": "allow",
        "rm": "deny"
      },
      "read": {
        "*": "allow",
        "**/*.env": "deny",
        "**/*.pem": "deny"
      },
      "write": { "*": "ask" },
      "edit": { "*": "ask" },
      "spawn": {
        "build": "allow",
        "test": "allow",
        "*": "deny"
      },
      "webfetch": {
        "*": "ask",
        "https://github.com/*": "allow"
      }
    }
  }
}
```

### Shorthand

Disable all checks:

```json
{ "guard": { "enabled": false } }
```

Whole-tool action (no pattern matching needed):

```json
{ "guard": { "rules": { "write": "allow" } } }
```

### Environment variable

Set `PI_GUARD` to inject rules from outside (e.g., by pi-spawn or CI/CD):

```bash
PI_GUARD='{"*":"deny","bash":{"git diff":"allow"}}'
```

## Matchers

Matchers define how to extract and match input from a tool call. Each matcher has a `param` (which tool parameter to extract) and a `type` (how to match).

| Type | Description | Use case |
|------|-------------|----------|
| `bash` | Parse command, extract all commands, subsequence match | Bash commands |
| `glob` | `*` and `**` matching (paths, URLs) | File paths, URLs |
| `exact` | String equality | Enum values, agent names |

Tools without a matcher get simple allow/ask/deny for the whole tool.

### Bash matching

1. Parse the command with the unbash AST parser
2. Extract all commands from the AST (handles pipes, subshells, command substitutions, process substitutions, heredocs, `if`/`while`/`for`/`case`, functions)
3. Expand wrapper commands (`xargs rm` → `xargs` + `rm`, `sudo rm` → `sudo` + `rm`, `bash -c 'rm -rf /'` → `bash -c` + `rm`, `find -exec rm {} \;` → `find -exec` + `rm`)
4. For each command, check rules using **subsequence matching** — rule tokens must appear in order, extra arguments are allowed

> [!TIP]
> `"git log"` matches `git log`, `git log --oneline`, and `git log --oneline -10`. This means you can allow a command without enumerating every flag combination.

#### Wildcard tokens in bash rules

Tokens containing `*` or `?` are matched as globs against the corresponding command argument:

```json
"sed": "allow",
"sed -i*": "ask",
"sed --in-place*": "ask"
```

| Command | Result | Reason |
|---------|--------|--------|
| `sed -E 's/old/new/'` | allow | `sed` rule, no `-i` flag |
| `sed -i 's/old/new/'` | ask | `-i` matches glob `-i*` |
| `sed -i.bak 's/old/new/'` | ask | `-i.bak` matches glob `-i*` |

This only applies to `*`/`?` **inside** rule tokens. The bare `"*"` key is the catch-all for any command (see [Rule precedence](#rule-precedence)).

### Glob matching

Standard glob patterns:
- `*` matches anything except `/`
- `**` matches anything including `/`
- `?` matches a single character
- `~` expands to home directory

### Exact matching

Simple string equality. Rule `"build"` only matches input `build`.

## Actions

Each permission rule resolves to one of:

| Action | Behavior |
|--------|----------|
| `allow` | Run without approval |
| `ask` | Prompt for approval (block in non-interactive mode) |
| `deny` | Block the action |

## Rule precedence

```
default → user config → project config → env (PI_GUARD) → profile → session rules
```

**Last match wins** within a tool's rules. Put the catch-all `"*"` first, specific rules after:

```json
"bash": {
  "*": "ask",
  "git status": "allow",
  "git log": "allow",
  "rm": "deny"
}
```

## Default rules

See [src/defaults.ts](src/defaults.ts) for the built-in defaults.

The defaults follow a simple principle: **reading is safe, writing is dangerous**. Read-only bash commands (`ls`, `cat`, `git log`, `grep`, etc.) are allowed, while anything that modifies state asks for approval. Note that `sed` is allowed by default, but `sed -i*` (in-place edit) is set to `ask` since it modifies files. File reads are mostly allowed except for sensitive patterns (`*.env`, `*.pem`). All edits and writes require approval.

> [!TIP]
> To trust the agent with file modifications (useful in containers or trusted environments):
> ```json
> {
>   "guard": {
>     "rules": { "edit": "allow", "write": "allow" }
>   }
> }
> ```

## Profiles

Profiles let you define named rule overlays and switch between them during a session. Only one profile can be active at a time.

```json
{
  "guard": {
    "profiles": {
      "read-write": {
        "edit": { "*": "allow" },
        "write": { "*": "allow" }
      }
    }
  }
}
```

Activate with `/guard profile read-write`, deactivate with `/guard profile off`.

> [!WARNING]
> Profiles are layered between env and session rules. A profile with `"*": "allow"` will override specific rules from earlier layers (like `"rm": "deny"`) because `"*"` always matches last and wins.

### Footer status

pi-guard publishes its current state through Pi's standard extension status API
under the key `pi-guard`. Both the native Footer and compatible custom footers
such as Zentui can display it without a guard-specific integration:

- `guard: on` — enabled with no profile overlay (not necessarily read-only)
- `guard: read-write` — enabled with the named profile active
- `guard: off` — permission checks are disabled, even if a profile is selected

The status is published at session start and refreshed after `/guard` commands
and configured shortcuts. It is cleared on session shutdown and is not published
in non-interactive modes without UI support. This does not change permission
rules or persist the active profile across restarts/reloads.

In Zentui, use the Starship Footer and ensure `pi-guard` is not set to `off`
in `/zentui` → **Extensions**. Extension statuses appear on the right by default.

### Shortcuts

Define custom slash commands for quick access to guard actions:

```json
{
  "guard": {
    "profiles": {
      "read-write": {
        "edit": { "*": "allow" },
        "write": { "*": "allow" }
      }
    },
    "shortcuts": {
      "rw": "profile read-write",
      "ro": "profile off",
      "yolo": "disable",
      "safe": "enable"
    }
  }
}
```

Now `/rw` activates the read-write profile, `/ro` deactivates it, and `/yolo`/`/safe` quickly toggle the guard.

Shortcuts can reference any guard subcommand: `profile`, `list`, `toggle`, `enable`, or `disable`.

## Commands

| Command | Description |
|---------|-------------|
| `/guard enable` | Enable guard |
| `/guard disable` | Disable guard |
| `/guard toggle` | Toggle guard on/off |
| `/guard list` | Show current rules by provenance layer |
| `/guard profile` | Show active profile and available profiles |
| `/guard profile <name>` | Activate a profile |
| `/guard profile off` | Deactivate current profile |
