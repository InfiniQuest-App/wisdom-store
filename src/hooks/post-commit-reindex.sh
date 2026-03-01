#!/bin/bash
#
# PostToolUse (Bash) hook - reindexes symbols after git commit.
# Ships with wisdom-store MCP. Add to ~/.claude/settings.json:
#
#   { "matcher": "Bash", "hooks": [{ "type": "command",
#     "command": "<path-to-wisdom-store>/src/hooks/post-commit-reindex.sh",
#     "timeout": 15 }] }
#

INPUT=$(cat)

# Only trigger on git commit commands
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
case "$COMMAND" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac

CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
if [ -z "$CWD" ]; then
  exit 0
fi

# Find .wisdom dir
WISDOM_DIR=""
DIR="$CWD"
while [ "$DIR" != "/" ]; do
  if [ -d "$DIR/.wisdom" ]; then
    WISDOM_DIR="$DIR/.wisdom"
    break
  fi
  DIR="$(dirname "$DIR")"
done

if [ -z "$WISDOM_DIR" ]; then
  exit 0
fi

PROJECT_ROOT="$(dirname "$WISDOM_DIR")"

# Find wisdom-store install (relative to this script)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WISDOM_STORE="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ ! -f "$WISDOM_STORE/src/mcp-server/lib/indexer.js" ]; then
  exit 0
fi

# Reindex in background
(
  cd "$WISDOM_STORE" && node --input-type=module -e "
    import { scanProject, writeSymbols } from './src/mcp-server/lib/indexer.js';
    const symbols = await scanProject('$PROJECT_ROOT', { maxDepth: 8, maxFiles: 2000 });
    writeSymbols('$WISDOM_DIR', symbols);
  " 2>/dev/null
) &

exit 0
