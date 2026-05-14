# Session Hand-off Template

A curated end-of-session message authored by the session itself, for the next session to pick up from. Cheaper and more accurate than `/compact`:

- **Author knows what mattered.** `/compact`'s summarizer infers relevance from outside; the session knows which decisions were real vs. dead-ends, which files matter, what the next move is.
- **File pointers beat snapshots.** "Re-read `src/foo.js`" ages well; an inline summary of that file goes stale the moment someone edits it.
- **Cheap.** One in-context message (uses cached prompt) vs. a full-chain LLM pass. Empirically observed: ~1% of the 5-hour rate-limit window for a hand-off vs. ~6% for `/compact` on a large session.
- **Safe.** Orphaned messages stay on disk in the JSONL; nothing is destroyed. The next session can grep the original transcript if the hand-off has gaps.

## Workflow

1. Session approaches context or TTL limit.
2. Trigger (manual or dashboard automation) sends a prompt to the session asking it to author a hand-off using this template.
3. Session writes the hand-off as its assistant response — the chain now ends with `[user: write handoff] → [assistant: handoff]`.
4. On resume, call `mcp__wisdom-store__prune_to_handoff`. It scans the chain newest-first for the marker, walks back to the user message that prompted the hand-off, and sets `parentUuid:null` on it. Everything before becomes orphaned.
5. Next session opens with the hand-off as its starting context. CLAUDE.md is auto-loaded by Claude Code on every turn — no need for the hand-off to repeat it.

## Marker convention

The hand-off MUST begin with the literal line `## SESSION HANDOFF`. The `prune_to_handoff` tool scans for this string. Override via the `marker` arg if you author a custom template.

## Prompt

Send this to the session as a user message (verbatim, or with light prefacing like "context is at X% —"):

> Time to write a hand-off — for your next-session SELF, picking up your role with the knowledge, voice, and stances you've built. This is not a task brief for a different worker; it's how past-you tells future-you "this is who you are and how you operate."
>
> Write the hand-off IN this response (don't save to a file — your response itself becomes the hand-off, sitting in the JSONL where the next session will read it). Start with the literal heading `## SESSION HANDOFF` (the prune tool scans for it).
>
> Cover at minimum:
>
> - **Who you are + working style.** Your role / project / session ID, how you collaborate with the human (preferences, things they find annoying, what they want pushback on), and how you coordinate with other sessions (orchestrators, peer workers).
> - **State.** What just finished, what's in flight, what's blocked.
> - **Files that matter.** Paths + one-line why. Point at paths; don't summarize their contents.
> - **Settled decisions worth not re-deriving.** Trade-offs past-you made that future-you would re-litigate without this context.
> - **Open decisions.** Things still up for debate, with options + your lean (if any).
> - **Pending external state.** Job IDs, plan IDs, scheduled wakeups, open PRs, ongoing threads with other sessions.
> - **Concrete first move.** One sentence: "Read X, then do Y."
>
> End with a `### Considered Omitting` section: things you almost cut but kept just in case. This is the safety net — if next-session-you thinks the hand-off is missing something, they'll glance here before grepping the orphaned transcript.
>
> Before finalizing, re-read your own draft and ask: would future-me, with no in-process memory of how this work happened, be confused or need to grep? Watch for things future-you would mistake for live state — shared secrets that may have rotated, rules from this task being read as standing session rules, references to files or artifacts that no longer exist. Fix any gaps in-place.
>
> Trust your judgment on structure. Keep it concrete and file-path-anchored.

## Dashboard automation hook (claudeLoop)

The `claudeLoop` dashboard already tracks per-tmux-session context % and has the plumbing to send messages to a tmux session. To wire automated hand-offs:

1. **Threshold detection** — extend the existing context-tracker (e.g. `dashboard-condense.js`) to flag sessions crossing a configurable threshold (suggested: 75% context OR 30 min before TTL expiry, whichever first).
2. **Trigger** — when threshold crosses, POST to the existing `/api/tmux-send-key` (or sister endpoint) with the verbatim template prompt above. Existing send-keys plumbing in `dashboard/claude-loop-unified-dashboard.js` already supports this.
3. **Resume** — on next session start, an orchestrator-side hook (or manual user click in the dashboard) calls `mcp__wisdom-store__prune_to_handoff` against the new session's conversation file. The chain is now lean.

### Why this is better than scheduling /compact via tmux

- `/compact` re-pays the cost of summarizing the whole transcript every time. The hand-off uses cached context — the marginal cost of generating ~500-1000 tokens of structured output is tiny.
- `/compact` runs synchronously and blocks the session for minutes on large transcripts. The hand-off is a normal turn — it streams.
- The hand-off is human-readable and auditable in the JSONL. If the prune is wrong, you can see exactly what the session intended to preserve.

## Recovery

If the hand-off turns out to have gaps after pruning:

- Orphans remain in the JSONL file. Use `mcp__wisdom-store__inspect_pruned_messages` to surface specific dropped segments.
- Or grep the JSONL directly: `grep -F 'distinctive phrase' ~/.claude/projects/<hash>/<conv-uuid>.jsonl`.
- The orphaned messages are invisible to Claude Code's chain walker but still on disk indefinitely.

## See also

- `src/mcp-server/tools/prune-to-handoff.js` — implementation
- `src/mcp-server/tools/sandwich-prune.js` — related tool (preserves both ends, drops middle)
- `src/mcp-server/tools/prune-context.js` — related tool (drops oldest N% or by phrase)
