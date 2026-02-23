#!/bin/bash
#
# Stage 3: TypeScript type checker for JS/TS files
# Runs tsc --checkJs to catch: wrong arg counts, undefined functions,
# invalid property access, type mismatches.
#
# ~500ms per file. Only runs on Write (not Edit — too noisy on partial files).
# Filters output to only show errors from the target file and suppresses
# known noise codes (missing modules, implicit any, etc.)
#
# PERFORMANCE NOTE: For faster checks (~21ms), a persistent TS Language Service
# daemon could hold the type checker in memory. See:
# https://github.com/microsoft/TypeScript/wiki/Using-the-Language-Service-API
# Architecture: HTTP server + Language Service → post-write hook calls via curl.
# The 500ms cold start is from parsing 51K lines of lib definitions each time.
#

FILE_PATH="$1"
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Find tsc binary
TSC=""
for candidate in \
  "./node_modules/.bin/tsc" \
  "$HOME/.npm-global/bin/tsc" \
  "/usr/local/bin/tsc" \
  "$(which tsc 2>/dev/null)"; do
  if [ -x "$candidate" ] 2>/dev/null; then
    TSC="$candidate"
    break
  fi
done

if [ -z "$TSC" ]; then
  exit 0  # tsc not found, skip silently
fi

# Find @types/node for Node.js globals (setTimeout, Buffer, etc.)
# Check project node_modules first, then global
TYPEROOTS=""
if [ -d "./node_modules/@types/node" ]; then
  TYPEROOTS="./node_modules/@types"
elif [ -d "$HOME/.npm-global/lib/node_modules/@types/node" ]; then
  # typeRoots expects dirs containing type packages directly
  # Global @types are under a different structure, so symlink
  TYPES_DIR="/tmp/tsc-types-$$"
  mkdir -p "$TYPES_DIR"
  ln -sf "$HOME/.npm-global/lib/node_modules/@types/node" "$TYPES_DIR/node"
  TYPEROOTS="$TYPES_DIR"
fi

# Auto-detect JS vs TS
# TS files get full type checking (typed params, interfaces, return types, null safety)
# JS files need --checkJs --allowJs and have weaker inference (untyped params = any)
IS_TS=0
case "$FILE_PATH" in
  *.ts|*.tsx) IS_TS=1 ;;
esac

# Also check if a tsconfig.json exists nearby (TS project with JS files still benefits)
TSCONFIG=""
DIR="$(dirname "$FILE_PATH")"
while [ "$DIR" != "/" ]; do
  if [ -f "$DIR/tsconfig.json" ]; then
    TSCONFIG="$DIR/tsconfig.json"
    break
  fi
  DIR="$(dirname "$DIR")"
done

# Build tsc args
TSC_ARGS=(--noEmit --skipLibCheck)

if [ -n "$TSCONFIG" ]; then
  # Project has a tsconfig — use --project to inherit all settings.
  # This checks all project files but we filter output to our file only.
  TSC_ARGS+=(--project "$TSCONFIG")
  # Override: don't let strict tsconfigs block us with too many errors
  TSC_ARGS+=(--skipLibCheck)
else
  # No tsconfig — use sensible defaults and check just our file
  TSC_ARGS+=(--target es2022 --moduleResolution node --lib es2022)
  if [ $IS_TS -eq 0 ]; then
    # JS files need these flags for tsc to check them
    TSC_ARGS+=(--checkJs --allowJs)
  fi
  if [ -n "$TYPEROOTS" ]; then
    TSC_ARGS+=(--types node --typeRoots "$TYPEROOTS")
  fi
fi

# Run tsc and capture output
# With --project: tsc checks all files (we filter to ours below)
# Without --project: pass our file directly
if [ -n "$TSCONFIG" ]; then
  TSC_OUTPUT=$("$TSC" "${TSC_ARGS[@]}" 2>&1)
else
  TSC_OUTPUT=$("$TSC" "${TSC_ARGS[@]}" "$FILE_PATH" 2>&1)
fi
TSC_EXIT=$?

# Clean up temp dir if created
[ -d "${TYPES_DIR:-}" ] && rm -rf "$TYPES_DIR"

if [ $TSC_EXIT -eq 0 ] || [ -z "$TSC_OUTPUT" ]; then
  exit 0
fi

# --- Filter output ---
# Only keep errors from the target file (not transitive dependencies)
FILENAME=$(basename "$FILE_PATH")

# Error codes to KEEP (real issues):
#   TS2304 - Cannot find name (undefined var/function)
#   TS2339 - Property does not exist on type
#   TS2551 - Did you mean...? (typo suggestions)
#   TS2554 - Expected N arguments, but got M
#   TS2345 - Argument type mismatch
#   TS2322 - Type not assignable
#   TS2741 - Property missing in type (TS only — needs typed params)
#   TS2532 - Object is possibly undefined (TS only — null safety)
#
# JS-only noise to suppress (not useful without type annotations):
#   TS7006 - Parameter implicitly has 'any' type
#
# Always suppress (environment/config noise, not hallucinations):
#   TS2307 - Cannot find module (missing types/packages)
#   TS2580 - Cannot find name 'process' (needs @types/node)
#   TS2584 - Cannot find name 'console' (needs @types/node)
#   TS2585 - 'Promise' only refers to a type (lib target)
#   TS2792 - Cannot find module (moduleResolution suggestion)
#   TS2468 - Cannot find global value (lib target)
#   TS2688 - Cannot find type definition file

# Always filter: only errors from target file, suppress env noise
FILTERED=$(echo "$TSC_OUTPUT" | grep "$FILENAME" | grep -vE 'TS2307|TS2580|TS2584|TS2585|TS2792|TS2468|TS2688')

# JS files: also suppress implicit-any noise (every untyped param triggers this)
if [ $IS_TS -eq 0 ]; then
  FILTERED=$(echo "$FILTERED" | grep -vE 'TS7006')
fi

if [ -z "$FILTERED" ]; then
  exit 0
fi

# Format for Claude
WARNINGS="tsc type check found issues in ${FILENAME}:\n"
while IFS= read -r line; do
  # Extract line number and message: "file(line,col): error TSXXXX: message"
  LINENUM=$(echo "$line" | grep -oP '\((\d+),' | tr -d '(,')
  MSG=$(echo "$line" | sed "s|^.*error ||")
  WARNINGS="${WARNINGS}  - line ${LINENUM}: ${MSG}\n"
done <<< "$FILTERED"

echo -e "$WARNINGS" >&2
exit 2
