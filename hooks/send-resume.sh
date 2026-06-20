#!/usr/bin/env bash
# Send /resume + Enter to a tmux session running Claude Code.
# Useful after inject_context to reload the conversation.
#
# Usage: ./send-resume.sh <tmux-session-name>
# Example: ./send-resume.sh claude-loop1
#
# If you run Claude Code inside tmux, this is a starting point for
# automating the /resume step after context injection. Timing may
# need adjustment for your setup. Without automation, just type
# /resume manually in the Claude Code session.

SESSION="$1"

if [ -z "$SESSION" ]; then
  echo "Usage: $0 <tmux-session-name>"
  echo "Example: $0 claude-loop1"
  exit 1
fi

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Error: tmux session '$SESSION' not found"
  echo "Available sessions:"
  tmux list-sessions 2>/dev/null || echo "  (no tmux sessions running)"
  exit 1
fi

tmux send-keys -t "$SESSION" '/resume'
sleep 2
tmux send-keys -t "$SESSION" Enter
# Second Enter to confirm the session selection menu
sleep 3
tmux send-keys -t "$SESSION" Enter

echo "Sent /resume to tmux session '$SESSION'"
