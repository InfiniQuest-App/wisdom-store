# wisdom-store

An MCP server that gives AI coding assistants persistent memory, context control, and anti-hallucination tools.

> **Early release** — actively developed, APIs may change. Expect rough edges.

## What it does

**Context control** — Trim conversation context live (no restart needed), inject curated knowledge into sessions, monitor context usage.

**Persistent knowledge** — Save lessons, patterns, cautions, and edge cases to flat files that survive across sessions. Organize by project section, file, or globally.

**Project indexing** — AST-based symbol extraction (via [@ast-grep/napi](https://github.com/nicolo-ribaudo/ast-grep-napi)), API route detection, HTML page inventory. Produces a compact project overview designed to give Claude a detailed map of your project for a fraction of your context window.

**Anti-hallucination** — Symbol registry with fuzzy matching catches hallucinated function names, typos, and unknown symbols. Includes a post-write hook that automatically warns about hallucinated imports, file paths, function calls, and API routes after every edit.

## Tools (11)

### Context Control

| Tool | Description |
|------|-------------|
| `context_status` | Check context usage — message count, estimated tokens, bloat indicators |
| `prune_context` | Trim old messages live. Modes: `oldest_percent`, `before_message`, `after_phrase` |
| `inject_context` | Insert curated context as a new conversation root. Requires `/resume` to reload |

### Persistent Knowledge

| Tool | Description |
|------|-------------|
| `save_wisdom` | Persist lessons, patterns, cautions, edge cases, or decisions to `.wisdom/` files |
| `get_wisdom` | Load wisdom for a file, section, or keyword. Call with no args for project overview |
| `update_plan` | Document feature plans with files, decisions, and status |
| `list_wisdom` | Browse what wisdom exists — sections, plans, patterns, sidecars |

### Project Index

| Tool | Description |
|------|-------------|
| `reindex_project` | Scan project, extract symbols via AST, save to `.wisdom/symbols.json` |
| `get_project_overview` | Compact project map — file tree, symbols, API routes, HTML pages. Always fresh |

### Anti-Hallucination

| Tool | Description |
|------|-------------|
| `check_symbols` | Cross-reference symbols against registry. Reports: confirmed, fuzzy match (typo?), or unknown (hallucinated?) |
| `refresh_symbols` | Re-scan and update the symbol registry |

## Install

```bash
git clone https://github.com/InfiniQuest-App/wisdom-store.git
cd wisdom-store
npm install
```

Add to your `~/.claude.json` or project `.mcp.json` (see [`examples/mcp.json`](examples/mcp.json)):

```json
{
  "mcpServers": {
    "wisdom-store": {
      "command": "node",
      "args": ["/path/to/wisdom-store/src/mcp-server/index.js"],
      "env": {}
    }
  }
}
```

Restart Claude Code or run `/mcp` to connect.

### Teaching Claude to use it

Copy the relevant sections from [`examples/CLAUDE.md`](examples/CLAUDE.md) into your project's `CLAUDE.md`. This teaches Claude when to load wisdom, save knowledge, check symbols, and manage context.

## Hooks

The `hooks/` directory contains Claude Code hooks that integrate with wisdom-store automatically.

Add to your settings file — `~/.claude/settings.json` (global), `.claude/settings.json` (project), or `.claude/settings.local.json` (personal per-project). Replace `/path/to/wisdom-store` with your actual clone path.

### Post-Write Hallucination Check

Automatically checks for hallucinations after every Write/Edit:
- Import paths pointing to files that don't exist
- Imported symbols not in the project registry
- Standalone function calls to unknown symbols
- API routes not found in the project index

Requires `.wisdom/symbols.json` — run `get_project_overview` once to generate it (auto-refreshes on each call). Only fires for code files (`.js`, `.ts`, `.py`, `.go`, `.rs`).

### Pre-Compact Save Reminder

Reminds Claude to save important findings to wisdom-store before context gets compacted. Fires on both manual (`/compact`) and automatic compaction. Only fires in projects with a `.wisdom/` directory.

### Setup

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit",
        "hooks": [{
          "type": "command",
          "command": "/path/to/wisdom-store/hooks/post-write-symbol-check.sh",
          "timeout": 10
        }]
      },
      {
        "matcher": "Write",
        "hooks": [{
          "type": "command",
          "command": "/path/to/wisdom-store/hooks/post-write-symbol-check.sh",
          "timeout": 10
        }]
      }
    ],
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [{
          "type": "command",
          "command": "/path/to/wisdom-store/hooks/pre-compact-save-reminder.sh",
          "timeout": 10
        }]
      }
    ]
  }
}
```

## How it works

### Storage

Everything is flat files in a `.wisdom/` directory at your project root:

```
.wisdom/
  index.json           # Project metadata + file list
  symbols.json         # Symbol registry (functions, classes, exports, routes)
  sections/            # Knowledge organized by topic
    auth.md
    estimates.md
  plans/               # Feature plans
    v2-migration.md
  patterns/            # Reusable patterns
    error-handling.md
```

Wisdom is stored at three levels:

- **Project** — `.wisdom/sections/`, `.wisdom/plans/`, `.wisdom/patterns/` for knowledge about this project
- **File-specific** — Sidecar files next to source: `myfile.js` gets `myfile.js.wisdom`
- **Global** — `~/.claude/wisdom/` for cross-project lessons (use `scope: "global"` with `save_wisdom`)

### Context manipulation

`prune_context` works by setting `parentUuid: null` on a target message in the JSONL conversation file, orphaning everything before it. This takes effect live on the next message — no restart needed.

`inject_context` appends a new message with `parentUuid: null` as a fresh root. Requires `/resume` to reload. A helper script (`hooks/send-resume.sh`) is included as a starting point for tmux automation, but manual `/resume` is the most reliable approach.

### AST extraction

Uses `@ast-grep/napi` (tree-sitter based) for JavaScript/TypeScript/TSX. Extracts functions, classes, variables, exports, interfaces, types, enums. Regex fallback for Python, Go, and Rust.

The project overview is designed to be context-efficient — compact enough to fit in a single tool response while covering file tree, symbols, routes, and pages.

## Example output

Running `get_project_overview` on this repo:

```
# Project Overview

## Files (16)
Total: 3,093 lines

- hooks/: symbol-check.mjs (273L)
- src/mcp-server/: index.js (371L)
- src/mcp-server/lib/: indexer.js (643L), jsonl.js (276L), wisdom.js (325L)
- src/mcp-server/tools/: check-symbols.js (87L), context-status.js (123L),
    get-project-overview.js (58L), get-wisdom.js (179L), inject-context.js (177L),
    list-wisdom.js (144L), prune-context.js (125L), refresh-symbols.js (15L),
    reindex-project.js (92L), save-wisdom.js (106L), update-plan.js (99L)

## Symbols
Functions: 62, Classes/Types: 0, Exports: 40

### Exports
- appendLine — src/mcp-server/lib/jsonl.js:273
- checkSymbols — src/mcp-server/lib/indexer.js:543
- findConversationFile — src/mcp-server/lib/jsonl.js:30
- generateOverview — src/mcp-server/lib/indexer.js:450
- handleCheckSymbols — src/mcp-server/tools/check-symbols.js:24
- handlePruneContext — src/mcp-server/tools/prune-context.js:23
- scanProject — src/mcp-server/lib/indexer.js:50
- walkChain — src/mcp-server/lib/jsonl.js:160
  ... (40 exports total)
```

## Typical workflow

```
1. Start working on a task
2. get_project_overview → understand the codebase
3. get_wisdom for relevant files/sections → load past knowledge
4. Work on the task
5. save_wisdom to persist new insights
6. check_symbols after writing code → catch hallucinations
7. If context gets large: save_wisdom → prune_context → continue
```

## Language support

| Language | AST extraction | Regex fallback |
|----------|---------------|----------------|
| JavaScript (.js, .mjs, .cjs, .jsx) | Full | - |
| TypeScript (.ts, .tsx) | Full | - |
| Python (.py) | - | Functions, classes, methods |
| Go (.go) | - | Functions, types, variables |
| Rust (.rs) | - | Functions, structs, enums, traits |
| HTML (.html) | - | Page titles, structure |

## Requirements

- Node.js 18+
- Claude Code (for MCP integration and hooks)

## License

MIT
