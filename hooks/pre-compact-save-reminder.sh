#!/bin/bash
#
# PreCompact hook - reminds Claude to save important context to wisdom-store
# before conversation context gets compacted.
#
# Only fires in projects that have a .wisdom/ directory (wisdom-store active).
#

# Read JSON input from stdin
INPUT=$(cat)

# Get the working directory from the hook input
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

if [ -z "$CWD" ]; then
  exit 0
fi

# Check if this project uses wisdom-store
find_wisdom_dir() {
  local dir="$CWD"
  while [ "$dir" != "/" ]; do
    if [ -d "$dir/.wisdom" ]; then
      echo "$dir/.wisdom"
      return
    fi
    dir="$(dirname "$dir")"
  done
  echo ""
}

WISDOM_DIR="$(find_wisdom_dir)"
if [ -z "$WISDOM_DIR" ]; then
  exit 0
fi

# Check if compaction is manual or auto
MATCHER=$(echo "$INPUT" | jq -r '.matcher // "auto"')

cat >&2 <<'MSG'
Context is about to be compacted. Before continuing, consider saving important findings from this session:
- Use save_wisdom to persist any lessons, patterns, or decisions discovered during this session
- Use save_wisdom with file_path for file-specific notes on files you've been working with
- Use update_plan if you've been working on a feature plan
Check get_wisdom() first to avoid saving duplicates.
MSG

exit 2
