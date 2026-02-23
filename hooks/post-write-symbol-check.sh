#!/bin/bash
#
# PostToolUse hook for Write/Edit - checks for code errors and hallucinated symbols
# Two-stage check:
#   1. oxlint (scope analysis) - catches undefined vars, unreachable code, etc.
#   2. symbol-check.mjs (project registry) - catches hallucinated imports, symbols, API routes
#

# Read JSON input from stdin
INPUT=$(cat)

# Extract file_path from tool_input
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Only check code files
case "$FILE_PATH" in
  *.js|*.mjs|*.cjs|*.jsx|*.ts|*.tsx|*.py|*.go|*.rs) ;;
  *) exit 0 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
WARNINGS=""
HAS_ERRORS=0

# --- Stage 1: oxlint (scope analysis, ~50-100ms) ---
# Only for JS/TS files, only on Write (Edit would flag pre-existing errors)
if [ "$TOOL_NAME" != "Edit" ]; then
case "$FILE_PATH" in
  *.js|*.mjs|*.cjs|*.jsx|*.ts|*.tsx)
    OXLINT_CONFIG="$SCRIPT_DIR/.oxlintrc.json"
    # Try common oxlint locations
    OXLINT=""
    for candidate in \
      "$HOME/.npm-global/bin/oxlint" \
      "/usr/local/bin/oxlint" \
      "$(which oxlint 2>/dev/null)"; do
      if [ -x "$candidate" ]; then
        OXLINT="$candidate"
        break
      fi
    done

    if [ -n "$OXLINT" ] && [ -f "$OXLINT_CONFIG" ]; then
      # Run oxlint, capture only error lines (not warnings)
      OXLINT_OUTPUT=$("$OXLINT" --format unix -c "$OXLINT_CONFIG" "$FILE_PATH" 2>&1 | grep '\[Error/' | head -15)
      if [ -n "$OXLINT_OUTPUT" ]; then
        FILENAME=$(basename "$FILE_PATH")
        WARNINGS="${WARNINGS}oxlint found errors in ${FILENAME}:\n"
        while IFS= read -r line; do
          # Extract just the message part after the file path
          MSG=$(echo "$line" | sed "s|^.*${FILENAME}:[0-9]*:[0-9]*: ||")
          LINENUM=$(echo "$line" | grep -oP ':\K[0-9]+(?=:[0-9]+:)')
          WARNINGS="${WARNINGS}  - line ${LINENUM}: ${MSG}\n"
        done <<< "$OXLINT_OUTPUT"
        HAS_ERRORS=1
      fi
    fi
    ;;
esac
fi # end TOOL_NAME != Edit

# --- Stage 2: symbol-check.mjs (project registry) ---
# Find project root (look for .wisdom dir)
find_project_root() {
  local dir
  dir="$(dirname "$FILE_PATH")"
  while [ "$dir" != "/" ]; do
    if [ -d "$dir/.wisdom" ]; then
      echo "$dir"
      return
    fi
    dir="$(dirname "$dir")"
  done
  echo ""
}

PROJECT_ROOT="$(find_project_root)"
if [ -n "$PROJECT_ROOT" ]; then
  SYMBOLS_FILE="$PROJECT_ROOT/.wisdom/symbols.json"
  if [ -f "$SYMBOLS_FILE" ]; then
    if [ "$TOOL_NAME" = "Edit" ]; then
      DIFF_CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
      SYMBOL_OUTPUT=$(echo "$DIFF_CONTENT" | node "$SCRIPT_DIR/symbol-check.mjs" "$FILE_PATH" "$SYMBOLS_FILE" --diff-only 2>&1)
    else
      SYMBOL_OUTPUT=$(node "$SCRIPT_DIR/symbol-check.mjs" "$FILE_PATH" "$SYMBOLS_FILE" 2>&1)
    fi
    SYMBOL_EXIT=$?

    if [ $SYMBOL_EXIT -eq 2 ] && [ -n "$SYMBOL_OUTPUT" ]; then
      WARNINGS="${WARNINGS}${SYMBOL_OUTPUT}\n"
      HAS_ERRORS=1
    fi
  fi
fi

# --- Stage 3: tsc type checking (~500ms, JS/TS only, Write only) ---
# Catches: wrong arg counts, undefined functions, invalid property access, type mismatches
# Only on Write (Edit is too noisy with partial file context)
if [ "$TOOL_NAME" != "Edit" ]; then
case "$FILE_PATH" in
  *.js|*.mjs|*.cjs|*.jsx|*.ts|*.tsx)
    TSC_OUTPUT=$("$SCRIPT_DIR/tsc-check.sh" "$FILE_PATH" 2>&1)
    TSC_EXIT=$?
    if [ $TSC_EXIT -eq 2 ] && [ -n "$TSC_OUTPUT" ]; then
      WARNINGS="${WARNINGS}${TSC_OUTPUT}\n"
      HAS_ERRORS=1
    fi
    ;;
esac
fi

# Output combined warnings
if [ $HAS_ERRORS -eq 1 ]; then
  echo -e "$WARNINGS" >&2
  exit 2
fi
