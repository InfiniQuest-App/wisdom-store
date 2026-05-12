/**
 * analyze_for_archive_v2 — two-pass turn-based archival planner
 *
 * Replaces v1's "shove everything to Sonnet, let LLM figure it out" approach
 * with a per-turn classify+summarize pass (Pass 1, Haiku) followed by a
 * cross-turn judgment pass (Pass 2, Haiku) over the collected summaries.
 *
 * Why this beats v1 structurally:
 *   - Pass 1 is N small calls (each ~1-5K tokens). Doesn't trigger the
 *     burst-rate caps that single 200K+ requests do on Max subscription.
 *   - Cache leverage: system prompt + classification rubric is identical
 *     across all Pass 1 calls; cache_control:ephemeral makes calls 2..N read
 *     from cache (~10x cheaper, lighter on rate-limit bucket).
 *   - Pass 2 input is just the summaries (~30-80KB) — fits anywhere, judges
 *     cross-turn patterns (duplicates, supersession, dead-ends).
 *   - Independent calls = parallelizable. Concurrency cap + exponential
 *     backoff on 429 keeps it polite.
 *
 * Output plan format identical to v1's per-uuid entries — so apply_archive_plan
 * and restore_archive_backup work unchanged. Turn-level decisions are expanded
 * into per-uuid actions before persist.
 *
 * Pass 1 summaries are persisted in the plan file (`passOne` field) so they
 * can be inspected for structural patterns (do certain entry types always end
 * up classified as "discardable"? candidates for pre-filter).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { randomUUID } from 'crypto';
import {
  findConversationFile,
  readJsonl,
  walkChain,
  readJsonlLine,
  getMessageContent
} from '../lib/jsonl.js';
import { getAnthropicClient, formatCost, PRICING } from '../lib/anthropic-client.js';
import { segmentTurns } from '../lib/turn-segmenter.js';
import { preFilterTurn } from '../lib/turn-prefilter.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const SONNET_MODEL = 'claude-sonnet-4-6';
const PLAN_TTL_MS = 24 * 60 * 60 * 1000;  // 24h — 1h was too short for real deliberation
const PASS1_CONCURRENCY = 5;
const PASS1_BACKOFF_INITIAL_MS = 2000;
const PASS1_BACKOFF_MAX_MS = 60_000;
const PASS1_MAX_RETRIES = 6;
const PER_TURN_MAX_CHARS = 12_000; // each turn is sent in full to Haiku (small)
const TOOL_OUTPUT_HEAD = 800;
const TOOL_OUTPUT_TAIL = 200;

const VALID_TURN_TYPES = [
  'file_read', 'code_edit', 'debug_attempt', 'planning', 'decision',
  'dead_end', 'tool_query', 'micro', 'system_or_meta', 'other'
];
const VALID_IMPORTANCE = ['load_bearing', 'supporting', 'discardable'];

const PASS1_SYSTEM = `You classify and summarize a single turn of a Claude Code conversation, producing structured metadata for a downstream archival planner.

A "turn" = one user prompt + the agent's response + any tool calls + their results, ending just before the next user prompt.

For each turn, you MUST submit (via the submit_turn_summary tool):
- type: one of ${VALID_TURN_TYPES.join(' | ')}
- summary: 1-3 sentences, what-happened-and-the-outcome (NOT a description of the user's prompt — the actual semantic outcome)
- key_artifacts: list of structured items the planner might compare across turns:
    {kind: "file_read", path, snippet_chars}
    {kind: "file_edit", path, what_changed_brief}
    {kind: "tool_use", name, args_brief}
    {kind: "decision", text}
    {kind: "search", target}
- duplicate_signal: short text identifying this turn for cross-turn duplicate detection (e.g. "read /path/to/file.js lines 1-100", "ran 'npm test'", "decided to use Redis")
- lesson: optional 1-sentence what-was-learned, only if meaningful (failed attempts especially)
- importance: one of ${VALID_IMPORTANCE.join(' | ')}
   - load_bearing: must be kept verbatim (decisions, current state, user intent, current file content the agent is actively working on)
   - supporting: useful context but droppable if duplicated or superseded later
   - discardable: tool output already incorporated, micro-exchange with no decision, system reminder, interrupted request

Be terse. Each summary should be readable in 5 seconds. Below are worked examples covering the common cases.

═══════════════════════════════════════════════════════════════════
EXAMPLE 1 — file_read of a single file (typical pattern: discardable if a later turn re-reads the same file)

Input turn: user asks "show me /src/auth.js", agent runs Read tool against /src/auth.js, gets back ~150 lines of code.

Correct submission:
{
  "type": "file_read",
  "summary": "Read /src/auth.js (151 lines) — JWT-based auth middleware with verifyToken/issueToken/refreshToken functions.",
  "key_artifacts": [
    {"kind": "file_read", "path": "/src/auth.js", "snippet_chars": 4823}
  ],
  "duplicate_signal": "Read /src/auth.js full file",
  "importance": "supporting"
}

Note: importance is "supporting" not "load_bearing" because if the conversation later re-reads /src/auth.js (because it was edited), the OLDER read is superseded and droppable. The planner uses duplicate_signal to detect that.

═══════════════════════════════════════════════════════════════════
EXAMPLE 2 — code_edit (load_bearing — represents current state of a file)

Input turn: user says "fix the bug in verifyToken", agent reads file, makes Edit tool call replacing a 5-line block, runs tests, all pass.

Correct submission:
{
  "type": "code_edit",
  "summary": "Fixed null-deref bug in verifyToken (/src/auth.js): added explicit check for missing 'sub' claim before accessing token.sub.user. Tests pass.",
  "key_artifacts": [
    {"kind": "file_edit", "path": "/src/auth.js", "what_changed_brief": "verifyToken: added null-check for token.sub before accessing .user"},
    {"kind": "tool_use", "name": "Bash", "args_brief": "npm test"}
  ],
  "duplicate_signal": "Edited /src/auth.js verifyToken null-check",
  "importance": "load_bearing"
}

═══════════════════════════════════════════════════════════════════
EXAMPLE 3 — debug_attempt that resolved (load_bearing IF lesson worth keeping; otherwise distill candidate)

Input turn: user reports "tests still failing on CI", agent runs npm test (passes locally), reads CI config, runs npm test in alpine docker, reproduces the failure ("module not found: bcrypt"), discovers bcrypt has native bindings that don't ship in alpine without python+make+g++, switches Dockerfile from alpine to debian-slim, CI green.

Correct submission:
{
  "type": "debug_attempt",
  "summary": "Reproduced CI test failure (bcrypt module-not-found) by running tests in alpine docker. Root cause: bcrypt's native bindings need python+make+g++ which alpine lacks. Switched Dockerfile to node:20-bullseye-slim; CI now green.",
  "key_artifacts": [
    {"kind": "tool_use", "name": "Bash", "args_brief": "docker run alpine npm test (reproduced failure)"},
    {"kind": "file_edit", "path": "Dockerfile", "what_changed_brief": "alpine → bullseye-slim base image"},
    {"kind": "decision", "text": "Use bullseye-slim instead of alpine for native-binding compatibility"}
  ],
  "duplicate_signal": "Resolved CI bcrypt failure by switching to bullseye-slim",
  "lesson": "alpine lacks python/make/g++ needed by bcrypt native bindings; use bullseye-slim or pre-install build-essentials when targeting alpine.",
  "importance": "load_bearing"
}

The lesson field is critical here — the planner uses it to decide whether to distill (keep the lesson, drop the long debug arc) or keep the full turn verbatim (if the user might re-read the debug session).

═══════════════════════════════════════════════════════════════════
EXAMPLE 4 — planning turn that gets superseded later (distill candidate)

Input turn: user asks "let's add caching to the API", agent proposes Redis with TTL of 1 hour, user agrees, agent starts setting up redis-server config, makes a few edits.

Correct submission:
{
  "type": "planning",
  "summary": "Decided to add Redis-backed response caching with 1h TTL. Started provisioning redis-server config and a cache-middleware skeleton.",
  "key_artifacts": [
    {"kind": "decision", "text": "Use Redis with 1h TTL for response cache"},
    {"kind": "file_edit", "path": "config/redis.yml", "what_changed_brief": "added Redis config block"}
  ],
  "duplicate_signal": "Decided on Redis caching with 1h TTL",
  "importance": "load_bearing"
}

If a LATER turn supersedes this (e.g., switches from Redis to in-memory LRU because Redis ops cost was too high), Pass 2 will see both turns' duplicate_signals and may distill this one to "Initially planned Redis 1h TTL; switched to in-memory LRU later — see turn N."

═══════════════════════════════════════════════════════════════════
EXAMPLE 5 — micro / interrupted / system_or_meta (discardable)

Input turn: user message is just "wait", or the user interrupted the agent mid-tool-call, or the turn is a system reminder reminding the agent to use task-tracking tools.

Correct submission:
{
  "type": "micro",
  "summary": "User interrupted mid-flow. No tool calls or decisions completed.",
  "key_artifacts": [],
  "duplicate_signal": "interrupted, no action taken",
  "importance": "discardable"
}

Or for system reminders:
{
  "type": "system_or_meta",
  "summary": "System reminder about task-tracking; no agent action.",
  "key_artifacts": [],
  "duplicate_signal": "system reminder (no semantic content)",
  "importance": "discardable"
}

These almost always classify as discardable. The planner aggressively drops them.

═══════════════════════════════════════════════════════════════════
GENERAL RULES:
- Be specific in summaries. "Read a file" is bad; "Read /src/auth.js (151 lines, JWT middleware)" is good.
- duplicate_signal should be normalizable: same content → same signal text. The planner does string matching across turns.
- Don't infer what didn't happen. If a tool was rejected before executing, say so.
- key_artifacts is for cross-turn comparison — include enough detail (path, name) for the planner to spot duplicates.

═══════════════════════════════════════════════════════════════════
EXAMPLE 6 — tool_query without decision (often discardable)

Input turn: user asks "what version of Postgres is on this machine?", agent runs Bash psql --version, reports "PostgreSQL 16.2", no decision or follow-up edits.

Correct submission:
{
  "type": "tool_query",
  "summary": "Reported PostgreSQL 16.2 (via psql --version). No decision or follow-up.",
  "key_artifacts": [
    {"kind": "tool_use", "name": "Bash", "args_brief": "psql --version → PostgreSQL 16.2"}
  ],
  "duplicate_signal": "checked psql version: PostgreSQL 16.2",
  "importance": "discardable"
}

These are pure information-fetch turns. They become discardable as soon as the answer is incorporated elsewhere or no longer needed. If the answer is referenced LATER in a decision, leave duplicate_signal precise so Pass 2 can see the reference and judge correctly.

═══════════════════════════════════════════════════════════════════
EXAMPLE 7 — dead_end (failed approach the agent abandoned — distill to preserve the lesson)

Input turn: user asks for performance fix, agent profiles the slow endpoint, identifies database query as bottleneck, proposes adding a covering index, runs EXPLAIN ANALYZE, observes that the index actually slows the query because the planner stops using a more selective partial-index that already exists. Agent reverts the index addition and notes the lesson.

Correct submission:
{
  "type": "dead_end",
  "summary": "Tried adding a covering index on orders(user_id, created_at) to speed slow query; EXPLAIN ANALYZE showed it caused the planner to stop using the existing partial-index on orders(user_id) WHERE archived=false, which was MORE selective. Reverted.",
  "key_artifacts": [
    {"kind": "tool_use", "name": "Bash", "args_brief": "EXPLAIN ANALYZE — covering index slower than partial"},
    {"kind": "decision", "text": "Revert covering-index addition; keep partial index"}
  ],
  "duplicate_signal": "tried covering index on orders(user_id, created_at), reverted",
  "lesson": "When a partial index already targets the hot subset, adding a wider covering index can make the planner stop using the partial — measure with EXPLAIN ANALYZE before adding.",
  "importance": "load_bearing"
}

dead_end + load_bearing is the most important combination for the planner. The lesson MUST survive any compaction. Pass 2 will typically distill these to a single sentence that retains the lesson, dropping the long debugging arc.

═══════════════════════════════════════════════════════════════════
ADDITIONAL CLASSIFICATION TIPS:

- An assistant message that is JUST text (no tool calls) is usually planning, decision, or micro depending on whether it commits to a course of action.
- A turn where the only tool calls are Read against files that were already read in a previous turn (no edits) is often supporting → could be discardable if nothing was learned.
- A turn that ends with the agent waiting for user clarification (no commits) is supporting at most.
- system-reminder content carrying project rules (e.g., "use these tools liberally") is system_or_meta, and importance depends on whether the rules were applied — usually discardable in retrospect.
- Sidechain entries (sub-agents like Explore, Plan) are full sub-conversations within a turn. Treat the whole sidechain as one substantive action; classify the parent turn based on the sidechain's outcome.

When in doubt about importance:
- Did this turn produce a decision, a code edit, or a discovered constraint? → load_bearing
- Could it be reconstructed from its outputs (e.g., re-running the tool) without losing semantic information? → supporting or discardable
- Was the only output structural (system reminder, interrupted call, throwaway query)? → discardable

═══════════════════════════════════════════════════════════════════
EXAMPLE 8 — search/grep that informs a later decision (importance depends on whether the answer survives)

Input turn: user asks "where do we handle session expiration?", agent runs Grep for 'session.*expire' across the repo, finds 3 hits in /src/auth.js and /src/middleware/session.js, summarizes the matches.

Correct submission:
{
  "type": "tool_query",
  "summary": "Searched 'session.*expire' across repo. Found 3 hits: /src/auth.js (refreshToken expiry check), /src/middleware/session.js (session-table cleanup, isExpired predicate).",
  "key_artifacts": [
    {"kind": "search", "target": "session.*expire (regex grep)"},
    {"kind": "tool_use", "name": "Grep", "args_brief": "session.*expire across repo"}
  ],
  "duplicate_signal": "grep session.*expire repo-wide",
  "importance": "supporting"
}

Note: importance is "supporting" (not "load_bearing") because this is an information-gathering step. If a later turn USES the search result to make a decision (e.g., "we'll add expiry to all three call-sites"), THAT decision turn becomes load_bearing — this search turn becomes droppable as background. The planner will see the duplicate_signal and judge based on whether the search was incorporated into a downstream decision.

═══════════════════════════════════════════════════════════════════
EXAMPLE 9 — multi-step planning turn with mixed actions (typical of long agent loops)

Input turn: user asks for a feature implementation. Agent reads 4 files to orient itself, runs grep for the relevant API surface, sketches the implementation in a TodoWrite call, then makes 2 file edits to set up scaffolding, runs tests (fail with the EXPECTED failure for unimplemented code), and ends by reporting progress to the user.

Correct submission:
{
  "type": "code_edit",
  "summary": "Set up scaffolding for /api/v2/users endpoint: read 4 files for orientation, grepped existing route patterns, created TodoWrite plan, added skeleton handler (/src/api/users.js) and route registration (/src/router.js). Tests fail as expected for unimplemented body. Reported progress.",
  "key_artifacts": [
    {"kind": "file_read", "path": "/src/router.js"},
    {"kind": "file_read", "path": "/src/api/users.js (existing)"},
    {"kind": "search", "target": "existing route patterns"},
    {"kind": "file_edit", "path": "/src/api/users.js", "what_changed_brief": "added v2 endpoint skeleton"},
    {"kind": "file_edit", "path": "/src/router.js", "what_changed_brief": "registered /api/v2/users route"},
    {"kind": "decision", "text": "v2/users follows existing v1 conventions"}
  ],
  "duplicate_signal": "scaffolded /api/v2/users endpoint",
  "importance": "load_bearing"
}

A multi-step turn like this is typically load_bearing because the file_edits represent current state. The READS at the start are SUPERSEDED by any later turn that re-reads the same files (because the files were just edited) — but Pass 2 will see the duplicate_signals on the file_read artifacts and judge accordingly.

═══════════════════════════════════════════════════════════════════
HANDLING EDGE CASES:

- Sidechain entries (sub-agents like Explore, Plan): treat the whole sidechain as one "tool_use" artifact representing the sub-agent's purpose; classify the parent turn based on what the sub-agent's result enabled.
- Tool errors that the agent recovered from: include the error in the summary (so the lesson isn't lost) but classify based on the recovery, not the failure.
- Tool calls rejected by the user (permission denial): summary should note the rejection; importance is usually supporting (the intent was logged even if the action wasn't taken).
- Very long agent text (> 1K chars of just thinking/explanation): summarize in 1 sentence. The full text is rarely worth preserving verbatim — the decision/edits in the SAME turn carry the load.
- Agent reports "task complete" or final-status messages: classify as decision/load_bearing if they contain the actual completion summary that downstream consumers need; classify as micro/discardable if they're just an "OK done" with no detail.

When unsure, err toward "supporting" + a precise duplicate_signal — the planner can recover from over-classification by relying on duplicate detection, but it can't recover from a missing summary if importance was wrongly set to "discardable".
`;

const PASS1_TOOL = {
  name: 'submit_turn_summary',
  description: 'Submit the structured summary + classification for one turn.',
  input_schema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: VALID_TURN_TYPES },
      summary: { type: 'string' },
      key_artifacts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string' },
            path: { type: 'string' },
            snippet_chars: { type: 'number' },
            what_changed_brief: { type: 'string' },
            name: { type: 'string' },
            args_brief: { type: 'string' },
            text: { type: 'string' },
            target: { type: 'string' }
          },
          required: ['kind']
        }
      },
      duplicate_signal: { type: 'string' },
      lesson: { type: 'string' },
      importance: { type: 'string', enum: VALID_IMPORTANCE }
    },
    required: ['type', 'summary', 'key_artifacts', 'duplicate_signal', 'importance']
  }
};

const PASS2_SYSTEM_DEFAULT = `You are an archival planner. You receive structured per-turn summaries of a Claude Code conversation, and you decide which turns to drop entirely, which to distill (replace with a 1-2 sentence summary), and which to keep verbatim (the implicit default).

LOAD-BEARING DEFINITION (the user's words):
> Keeping things essential to its job, as presumed from user messages. Typically having the latest content/state on files and plans it frequently touches, summary of reasons we changed directions / why we're going the direction we are now. Don't need duplicates, especially older copies. But simply pruning out older copies does run the risk of losing: what we tried that didn't work, why we didn't do X. Worth summarizing mistakes / pitfalls / reasons / current paths.

KEEP VERBATIM (action: "keep"):
- importance:"load_bearing" turns whose content is still load-bearing (not superseded later)
- the most recent ~30 turns (active state)
- direction-change rationale, decisions, current-state file content

DROP (action: "drop"):
- importance:"discardable" turns
- file_read of path X when a later file_read of path X exists
- duplicate searches/queries where a later one supersedes
- micro-exchanges with no decision
- tool_query turns whose result is already incorporated into a later decision

DISTILL (action: "distill", with 1-2 sentence \`distillation\`):
- failed_attempts / dead_ends with a recovered lesson
- superseded planning that has been replaced by newer planning
- long debugging arcs that resolved — capture root cause + fix in 1 sentence

CRITICAL: pure deletion of failed attempts is dangerous because the agent later forgets WHY they're on path Y and might re-suggest X. Prefer distill over drop for any turn whose lesson matters.

Output via submit_archival_plan with entries[] of {turn_id, action, distillation?, reason}. You MUST include EVERY turn with an explicit action. distillation is REQUIRED iff action=distill.

Default to action:"keep" when in doubt.`;

const PASS2_SYSTEM_AGGRESSIVE = `You are an AGGRESSIVE archival planner. The user has already accepted information loss in exchange for context window savings — they want the conversation cut down to its essential context (target ~50% of current size or below). You receive structured per-turn summaries and decide drop / distill / keep per turn.

LOAD-BEARING DEFINITION (the user's words):
> Keeping things essential to its job, as presumed from user messages. Typically having the latest content/state on files and plans it frequently touches, summary of reasons we changed directions / why we're going the direction we are now. Don't need duplicates, especially older copies. But simply pruning out older copies does run the risk of losing: what we tried that didn't work, why we didn't do X. Worth summarizing mistakes / pitfalls / reasons / current paths.

USER'S EXPLICIT CONSTRAINTS FOR THIS RUN:
- Target ~50% reduction in active chain. Be willing to drop more than you would in a conservative run.
- Distill aggressively to preserve lessons while shrinking byte count. A turn full of investigation that resolved into a one-sentence conclusion → distill, don't keep verbatim.
- Drop ANY duplicate (even minor): file_reads of the same path, status checks, "let me look at this again" turns.
- Drop ANY tool_query whose result is incorporated downstream — the decision itself preserves the conclusion.
- Drop ALL system_or_meta turns (system reminders, micro-exchanges, no-action turns).
- KEEP only: latest decisions per topic, the most recent ~20 turns of active state, and the user's most recent expressed intents/constraints/preferences.

DROP (action: "drop") — BE LIBERAL:
- importance:"discardable" turns: ALWAYS drop
- importance:"supporting" turns: drop unless the support is uniquely needed downstream
- file_read / search / tool_query turns: drop if the answer was incorporated into a later turn
- system_or_meta turns: ALWAYS drop
- micro-exchanges (just acknowledgments, "ok", "thanks"): ALWAYS drop
- Older versions of decisions superseded by later ones: drop the older

DISTILL (action: "distill", with 1-2 sentence \`distillation\`) — USE FREELY:
- debug_attempt / dead_end with a lesson: distill to capture the lesson
- planning turn superseded by later planning: distill to capture what was decided
- Long multi-step turns where the user only needs to know the outcome: distill
- Any turn classified "load_bearing" that's heavy on bytes but whose load-bearing element is one decision: distill to that decision

KEEP VERBATIM (action: "keep"):
- The MOST RECENT decision per ongoing topic
- The most recent ~20 turns (active state)
- User's expressed intents, constraints, preferences (especially recent)
- Direction-change rationale that's still current

CRITICAL: don't outright DELETE failed-attempt context — distill it instead. The lesson must survive even if the long arc doesn't.

Output via submit_archival_plan with entries[] of {turn_id, action, distillation?, reason}. You MUST include EVERY turn with an explicit action. distillation is REQUIRED iff action=distill.

Aim for: ~30-50% drop, ~15-30% distill, ~30-50% keep. If you find yourself keeping >60% of turns, you're being too conservative for this run.`;

const PASS2_SYSTEM = PASS2_SYSTEM_DEFAULT;

const PASS2_TOOL = {
  name: 'submit_archival_plan',
  description: 'Submit the cross-turn archival decisions.',
  input_schema: {
    type: 'object',
    properties: {
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            turn_id: { type: 'integer' },
            action: { type: 'string', enum: ['keep', 'drop', 'distill'], description: 'keep = no change (verbatim, default for active state); drop = remove all entries in this turn; distill = collapse to a 1-2 sentence summary' },
            distillation: { type: 'string', description: 'Required when action=distill. 1-2 sentences capturing the lesson/decision/outcome.' },
            reason: { type: 'string' }
          },
          required: ['turn_id', 'action', 'reason']
        }
      }
    },
    required: ['entries']
  }
};

function clipText(text, maxChars) {
  if (!text || text.length <= maxChars) return text || '';
  const head = text.slice(0, Math.floor(maxChars * 0.78));
  const tail = text.slice(-Math.floor(maxChars * 0.18));
  const dropped = text.length - head.length - tail.length;
  return `${head}\n... [${dropped} chars elided] ...\n${tail}`;
}

function stripLoneSurrogates(s) {
  if (typeof s !== 'string' || !s) return s;
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

function compactEntryForTurn(fullData) {
  const ts = (fullData.timestamp || '').slice(0, 19).replace('T', ' ');
  const role = fullData.message?.role || fullData.type || 'unknown';
  let body = '';
  const msg = fullData.message;
  if (msg && Array.isArray(msg.content)) {
    const parts = [];
    for (const block of msg.content) {
      if (block?.type === 'text') parts.push(block.text || '');
      else if (block?.type === 'thinking') parts.push(`[thinking: ${(block.thinking || '').slice(0, 300)}]`);
      else if (block?.type === 'tool_use') {
        const fp = block.input?.file_path ? ` ${block.input.file_path}` : '';
        const cmd = block.input?.command ? ` \`${String(block.input.command).split('\n')[0].slice(0, 100)}\`` : '';
        parts.push(`[tool_use ${block.name}${fp}${cmd}]`);
      } else if (block?.type === 'tool_result') {
        let txt = '';
        if (typeof block.content === 'string') txt = block.content;
        else if (Array.isArray(block.content)) txt = block.content.map(c => c.text || '').join('\n');
        const isErr = block.is_error ? '[ERROR] ' : '';
        if (txt.length > TOOL_OUTPUT_HEAD + TOOL_OUTPUT_TAIL + 100) {
          parts.push(`${isErr}[tool_result ${txt.length} chars] ${txt.slice(0, TOOL_OUTPUT_HEAD)}\n...elided...\n${txt.slice(-TOOL_OUTPUT_TAIL)}`);
        } else {
          parts.push(`${isErr}[tool_result] ${txt}`);
        }
      }
    }
    body = parts.join('\n');
  } else if (typeof msg?.content === 'string') {
    body = msg.content;
  } else if (typeof fullData.content === 'string') {
    body = fullData.content;
  }
  return `<entry uuid="${fullData.uuid || '?'}" role="${role}" ts="${ts}">\n${body}\n</entry>`;
}

function buildTurnPrompt(turn, fullEntries) {
  const turnBody = fullEntries.map(compactEntryForTurn).join('\n\n');
  const clipped = clipText(turnBody, PER_TURN_MAX_CHARS);
  return `TURN #${turn.turn_id} (${fullEntries.length} entries, ${turn.start_timestamp || '?'} → ${turn.end_timestamp || '?'})\n\n${clipped}`;
}

async function runPass1Once({ client, turn, fullEntries }) {
  const userText = stripLoneSurrogates(buildTurnPrompt(turn, fullEntries));
  const resp = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 1500,
    system: [
      { type: 'text', text: PASS1_SYSTEM, cache_control: { type: 'ephemeral' } }
    ],
    tools: [{ ...PASS1_TOOL, cache_control: { type: 'ephemeral' } }],
    tool_choice: { type: 'tool', name: 'submit_turn_summary' },
    messages: [{ role: 'user', content: userText }]
  });
  const tu = resp.content.find(b => b.type === 'tool_use');
  if (!tu) {
    return { error: `no tool_use returned, stop_reason=${resp.stop_reason}`, usage: resp.usage };
  }
  return { summary: tu.input, usage: resp.usage };
}

async function runPass1WithBackoff(args) {
  let attempt = 0;
  let backoff = PASS1_BACKOFF_INITIAL_MS;
  while (attempt <= PASS1_MAX_RETRIES) {
    try {
      return await runPass1Once(args);
    } catch (e) {
      const status = e.status;
      if (status === 429 || status === 529) {
        if (attempt === PASS1_MAX_RETRIES) {
          return { error: `Pass 1 failed after ${PASS1_MAX_RETRIES} retries on HTTP ${status}: ${e.message}`, usage: null };
        }
        await new Promise(r => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, PASS1_BACKOFF_MAX_MS);
        attempt++;
        continue;
      }
      return { error: `Pass 1 HTTP ${status || '?'}: ${e.message}`, usage: null };
    }
  }
  return { error: 'unreachable', usage: null };
}

async function runPass1Concurrent({ client, turnsWithFullEntries, concurrency, onProgress }) {
  const results = new Array(turnsWithFullEntries.length);
  let cursor = 0;
  let usageIn = 0, usageOut = 0, usageCacheRead = 0, usageCacheWrite = 0;

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= turnsWithFullEntries.length) return;
      const { turn, fullEntries } = turnsWithFullEntries[idx];
      const r = await runPass1WithBackoff({ client, turn, fullEntries });
      results[idx] = r;
      if (r.usage) {
        usageIn += r.usage.input_tokens || 0;
        usageOut += r.usage.output_tokens || 0;
        usageCacheRead += r.usage.cache_read_input_tokens || 0;
        usageCacheWrite += r.usage.cache_creation_input_tokens || 0;
      }
      if (onProgress) onProgress(idx + 1, turnsWithFullEntries.length);
    }
  }

  const workers = Array.from({ length: concurrency }, worker);
  await Promise.all(workers);
  return { results, usage: { input_tokens: usageIn, output_tokens: usageOut, cache_read_input_tokens: usageCacheRead, cache_creation_input_tokens: usageCacheWrite } };
}

function canonicalStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

function archiveDirsFor(jsonlPath) {
  const dir = path.dirname(jsonlPath);
  return { plans: path.join(dir, '.archive-plans') };
}

export async function handleAnalyzeForArchiveV2(args = {}) {
  const filePath = findConversationFile(args.conversation_id);
  if (!filePath) {
    return { content: [{ type: 'text', text: 'No conversation file found.' }], isError: true };
  }

  const allowApiKey = args.allowApiKey === true;
  const aggressive = args.aggressive === true;
  const pass2SystemPrompt = aggressive ? PASS2_SYSTEM_AGGRESSIVE : PASS2_SYSTEM_DEFAULT;
  let clientResult;
  try { clientResult = getAnthropicClient({ allowApiKey }); }
  catch (e) { return { content: [{ type: 'text', text: `Auth: ${e.message}` }], isError: true }; }
  const { client, authMode, billing, subscriptionType } = clientResult;

  const fileStat = fs.statSync(filePath);
  const entries = readJsonl(filePath);
  const chain = walkChain(entries);
  if (chain.length === 0) {
    return { content: [{ type: 'text', text: 'Conversation chain is empty.' }], isError: true };
  }

  const allTurns = segmentTurns(chain, readJsonlLine, filePath);
  const maxTurns = Number.isInteger(args.max_turns) && args.max_turns > 0
    ? Math.min(args.max_turns, allTurns.length)
    : allTurns.length;
  const turnsToProcess = allTurns.slice(0, maxTurns);

  // Eagerly resolve full entries for each turn (Pass 1 needs the full bodies).
  const turnsWithFullEntries = turnsToProcess.map(turn => ({
    turn,
    fullEntries: turn.entries.map(e => readJsonlLine(filePath, e.line) || e.data)
  }));

  // Apply heuristic pre-filter: turns that are obviously discardable get a
  // synthetic summary without a Haiku call (~30% cost savings on typical
  // orchestrator/worker conversations, validated 100% precision on loop168).
  // Pre-filtered turns still flow into Pass 2 with their synthetic summary so
  // cross-turn judgment stays complete.
  const turnsForHaiku = [];
  const prefilteredSummaries = []; // { turn_id, ... synthetic Pass 1 shape }
  let prefilteredCount = 0;
  for (const tw of turnsWithFullEntries) {
    const synth = (args.disable_prefilter === true)
      ? null
      : preFilterTurn(tw.turn, tw.fullEntries);
    if (synth) {
      prefilteredSummaries.push({
        turn_id: tw.turn.turn_id,
        first_uuid: tw.turn.first_uuid,
        last_uuid: tw.turn.last_uuid,
        entry_count: tw.turn.entries.length,
        ...synth
      });
      prefilteredCount++;
    } else {
      turnsForHaiku.push(tw);
    }
  }

  // ---- Pass 1: per-turn classify+summarize ----
  const concurrency = Number.isInteger(args.concurrency) && args.concurrency > 0
    ? Math.min(args.concurrency, 10)
    : PASS1_CONCURRENCY;

  const t0 = Date.now();
  const { results: pass1Results, usage: pass1Usage } = await runPass1Concurrent({
    client,
    turnsWithFullEntries: turnsForHaiku,
    concurrency
  });
  const pass1Elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const pass1Entries = [];
  const pass1Failed = [];
  for (let i = 0; i < pass1Results.length; i++) {
    const r = pass1Results[i];
    const t = turnsForHaiku[i].turn;  // index into the Haiku-only subset
    if (r.error) {
      pass1Failed.push({ turn_id: t.turn_id, error: r.error });
      pass1Entries.push({ turn_id: t.turn_id, error: r.error, first_uuid: t.first_uuid, last_uuid: t.last_uuid });
    } else {
      pass1Entries.push({
        turn_id: t.turn_id,
        first_uuid: t.first_uuid,
        last_uuid: t.last_uuid,
        entry_count: t.entries.length,
        ...r.summary
      });
    }
  }
  // Merge in the pre-filtered synthetic summaries; sort by turn_id so Pass 2 sees
  // the conversation in chronological order.
  pass1Entries.push(...prefilteredSummaries);
  pass1Entries.sort((a, b) => a.turn_id - b.turn_id);

  // ---- Pass 2: cross-turn judgment ----
  const summariesForPass2 = pass1Entries
    .filter(e => !e.error)
    .map(e => `TURN ${e.turn_id} [${e.type}, importance=${e.importance}]\nsummary: ${e.summary}\nduplicate_signal: ${e.duplicate_signal || ''}\n${e.lesson ? 'lesson: ' + e.lesson : ''}\nartifacts: ${JSON.stringify(e.key_artifacts || [])}`)
    .join('\n\n');

  let pass2Resp, pass2Plan = [], pass2Error = null;
  try {
    pass2Resp = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 16384,  // Haiku 4.5 max output. 8K was insufficient for a 250-turn explicit-decision schema.
      system: [{ type: 'text', text: pass2SystemPrompt, cache_control: { type: 'ephemeral' } }],
      tools: [PASS2_TOOL],
      tool_choice: { type: 'tool', name: 'submit_archival_plan' },
      messages: [{ role: 'user', content: `Total turns: ${turnsToProcess.length}. Plan archival actions per turn.\n\n${summariesForPass2}` }]
    });
    const tu = pass2Resp.content.find(b => b.type === 'tool_use');
    if (tu) {
      pass2Plan = tu.input?.entries || [];
      // If output was truncated (stop_reason='max_tokens'), surface it — Pass 2's
      // entries list may be incomplete and downstream apply will under-act.
      if (pass2Resp.stop_reason === 'max_tokens' && pass2Plan.length < turnsToProcess.length) {
        pass2Error = `Pass 2 hit max_tokens with only ${pass2Plan.length}/${turnsToProcess.length} decisions — output truncated. Re-run with smaller max_turns or wait for prompt-tightening.`;
      }
    } else pass2Error = `Pass 2 returned no tool_use, stop_reason=${pass2Resp.stop_reason}`;
  } catch (e) {
    pass2Error = `Pass 2 HTTP ${e.status || '?'}: ${e.message}`;
  }

  // Translate turn-level decisions → per-uuid plan entries
  const turnById = new Map(turnsToProcess.map(t => [t.turn_id, t]));
  const validUuidEntries = [];
  const skippedTurns = [];
  for (const entry of pass2Plan) {
    const t = turnById.get(entry.turn_id);
    if (!t) { skippedTurns.push({ turn_id: entry.turn_id, reason: 'turn not in processed set' }); continue; }
    if (entry.action === 'keep') {
      // Explicit-keep: no per-uuid entries needed. The chain entries stay verbatim.
      // Tracked here for audit completeness only.
      continue;
    }
    if (entry.action === 'distill') {
      if (!entry.distillation) {
        skippedTurns.push({ turn_id: entry.turn_id, reason: 'distill without distillation' });
        continue;
      }
      // Per-turn distill = collapse the whole turn into a single distillation entry
      // on the FIRST uuid; drop the rest of the entries.
      const [first, ...rest] = t.entries;
      validUuidEntries.push({
        uuid: first.data.uuid, action: 'distill',
        distillation: entry.distillation,
        reason: `[turn ${t.turn_id}] ${entry.reason}`
      });
      for (const e of rest) {
        validUuidEntries.push({
          uuid: e.data.uuid, action: 'drop',
          reason: `[turn ${t.turn_id}] (collapsed into distill on first uuid)`
        });
      }
      continue;
    }
    if (entry.action === 'drop') {
      for (const e of t.entries) {
        validUuidEntries.push({
          uuid: e.data.uuid, action: 'drop',
          reason: `[turn ${t.turn_id}] ${entry.reason}`
        });
      }
      continue;
    }
    // Unknown action — skip with explicit log so it surfaces in the plan file
    skippedTurns.push({ turn_id: entry.turn_id, reason: `unknown action: ${entry.action}` });
  }

  // ---- Persist plan ----
  const planId = randomUUID();
  const lastMessageUuid = chain[chain.length - 1].data.uuid;
  const planCore = {
    planId,
    jsonlPath: filePath,
    jsonlBytes: fileStat.size,
    jsonlMessages: chain.length,
    lastMessageUuid,
    entries: validUuidEntries
  };
  const checksum = crypto.createHash('sha256').update(canonicalStringify(planCore)).digest('hex');

  const pass1CostStr = formatCost(HAIKU_MODEL, pass1Usage.input_tokens, pass1Usage.output_tokens);
  const cacheReadDollars = (pass1Usage.cache_read_input_tokens / 1_000_000) * 0.08;
  const cacheWriteDollars = (pass1Usage.cache_creation_input_tokens / 1_000_000) * 1.00;
  const pass2CostStr = pass2Resp ? formatCost(HAIKU_MODEL, pass2Resp.usage.input_tokens, pass2Resp.usage.output_tokens) : '(failed)';

  const fullPlan = {
    ...planCore,
    checksum,
    createdAt: Date.now(),
    schemaVersion: 'v2-two-pass',
    authMode, billing, subscriptionType,
    turnsProcessed: turnsToProcess.length,
    turnsTotal: allTurns.length,
    pass1: {
      cost: pass1CostStr,
      cacheReadTokens: pass1Usage.cache_read_input_tokens,
      cacheWriteTokens: pass1Usage.cache_creation_input_tokens,
      cacheReadDollarsApprox: cacheReadDollars,
      cacheWriteDollarsApprox: cacheWriteDollars,
      elapsedSec: pass1Elapsed,
      failedTurns: pass1Failed,
      prefilteredCount,
      summaries: pass1Entries  // for inspection — pattern mining etc.
    },
    pass2: {
      cost: pass2CostStr,
      error: pass2Error,
      turnDecisions: pass2Plan,
      skippedTurns
    }
  };

  const dirs = archiveDirsFor(filePath);
  fs.mkdirSync(dirs.plans, { recursive: true });
  const planPath = path.join(dirs.plans, `${planId}.json`);
  fs.writeFileSync(planPath, JSON.stringify(fullPlan, null, 2));

  const dropCount = validUuidEntries.filter(e => e.action === 'drop').length;
  const distillCount = validUuidEntries.filter(e => e.action === 'distill').length;
  // Pass 2 turn-level keep/drop/distill counts (action audit log)
  const turnKept = pass2Plan.filter(e => e.action === 'keep').length;
  const turnDropped = pass2Plan.filter(e => e.action === 'drop').length;
  const turnDistilled = pass2Plan.filter(e => e.action === 'distill').length;
  const turnUnknown = pass2Plan.filter(e => !['keep','drop','distill'].includes(e.action)).length;

  const lines = [
    `## analyze_for_archive_v2 — Plan Generated (two-pass)`,
    ``,
    `**Plan ID**: \`${planId}\``,
    `**Checksum**: \`${checksum.slice(0, 16)}...\``,
    `**Plan file**: \`${planPath}\``,
    `**Conversation**: ${path.basename(filePath)} (${(fileStat.size / 1024).toFixed(0)} KB)`,
    `**Chain**: ${chain.length} entries, ${allTurns.length} turns total, ${turnsToProcess.length} processed`,
    ``,
    `### Pass 1 (per-turn Haiku classify+summarize)`,
    `- Pre-filtered (no Haiku): ${prefilteredCount}/${turnsToProcess.length} turns (${(100*prefilteredCount/turnsToProcess.length).toFixed(0)}%)`,
    `- Haiku calls: ${turnsForHaiku.length}, concurrency: ${concurrency}, elapsed: ${pass1Elapsed}s`,
    `- Cost: ${pass1CostStr}`,
    `- Cache reads: ${pass1Usage.cache_read_input_tokens.toLocaleString()} tokens (~$${cacheReadDollars.toFixed(4)})`,
    `- Cache writes: ${pass1Usage.cache_creation_input_tokens.toLocaleString()} tokens (~$${cacheWriteDollars.toFixed(4)})`,
    `- Failed turns: ${pass1Failed.length}${pass1Failed.length ? ' (' + pass1Failed.map(f => f.turn_id).join(',') + ')' : ''}`,
    ``,
    `### Pass 2 (cross-turn Haiku judgment)`,
    `- Cost: ${pass2CostStr}`,
    pass2Error ? `- ERROR: ${pass2Error}` : `- Turn-level decisions: ${pass2Plan.length}`,
    `- Skipped turns (invalid): ${skippedTurns.length}`,
    ``,
    `### Pass 2 turn-level decisions (audit)`,
    `- Keep verbatim: ${turnKept} turns`,
    `- Drop entirely: ${turnDropped} turns`,
    `- Distill: ${turnDistilled} turns`,
    turnUnknown ? `- ⚠️ Unknown action (skipped): ${turnUnknown} turns` : '',
    ``,
    `### Per-uuid plan (for apply_archive_plan)`,
    `- Drop entries: ${dropCount}`,
    `- Distill entries: ${distillCount}`,
    `- Kept entries: ${chain.length - dropCount - distillCount}`,
    ``,
    `### Type breakdown (from Pass 1 — useful for spotting structural patterns)`,
    ...((() => {
      const byType = {};
      for (const e of pass1Entries) {
        if (e.error) continue;
        const k = `${e.type}/${e.importance}`;
        byType[k] = (byType[k] || 0) + 1;
      }
      return Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`);
    })()),
    ``,
    `### Sample turn summaries (first 5)`,
    ...pass1Entries.slice(0, 5).filter(e => !e.error).map(e =>
      `**Turn ${e.turn_id}** [${e.type}, ${e.importance}]: ${e.summary}\n  duplicate_signal: ${e.duplicate_signal || '(none)'}\n  ${e.lesson ? 'lesson: ' + e.lesson : ''}`
    ),
    ``,
    `Next: \`apply_archive_plan({ planId: "${planId}", checksum: "${checksum}", confirm: true })\` (works unchanged with v2 plans).`,
  ].filter(l => l !== '').join('\n');

  return { content: [{ type: 'text', text: lines }] };
}

export const V2_INTERNALS = { canonicalStringify, archiveDirsFor, PASS1_SYSTEM, PASS2_SYSTEM_DEFAULT, PASS2_SYSTEM_AGGRESSIVE };
