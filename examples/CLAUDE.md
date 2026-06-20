# Example CLAUDE.md — Wisdom Store Integration

# Copy the sections below into your project's CLAUDE.md to teach Claude
# how to use the wisdom-store tools effectively.

## Project Memory (wisdom-store)

This project uses wisdom-store for persistent memory and anti-hallucination.

### Starting a session
- Call `get_wisdom()` (no args) at the start of each session to load project knowledge
- Call `get_wisdom(file_path)` before editing unfamiliar files to check for known gotchas
- Call `get_project_overview` if you need to understand the codebase structure

### While working
- After writing code that references existing symbols, call `check_symbols` to verify you haven't hallucinated function names or imports
- If `check_symbols` reports unknowns after you intentionally added new code, call `refresh_symbols` to update the registry

### Saving knowledge
- When you discover something non-obvious (tricky bug, important constraint, useful pattern), call `save_wisdom` to persist it
- Use `file_path` for file-specific notes, `section` for topic areas, `scope: "global"` for cross-project lessons
- Use `update_plan` to document feature plans with status, files, and design decisions

### Context management
- Call `context_status` if you suspect context is getting large
- If usage is >70%, save important findings with `save_wisdom` first, then use `prune_context` to trim old messages
- After pruning, continue working — the trim takes effect immediately

### Tool feedback
- If a wisdom-store tool gives a false positive, feels clunky, or could work better, log it: `save_wisdom({ content: "description of the issue or idea", section: "tool-feedback" })`
- Examples worth logging: symbol-check flagging a valid builtin, save_wisdom losing context, get_wisdom returning stale data, missing language support in the indexer, ideas for new tools or better defaults
- Periodically check `get_wisdom(section: "tool-feedback")` to see if patterns emerge that should be fixed

### What NOT to do
- Don't save session-specific or temporary information as wisdom
- Don't call `reindex_project` unless the project structure has significantly changed
- Don't skip `get_wisdom` at session start — it contains lessons from previous sessions that prevent repeating mistakes
