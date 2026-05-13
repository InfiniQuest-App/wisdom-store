/**
 * Per-block content summarizer for refetch-markers mode.
 * Two strategies:
 *   - Heuristic (free): "first line of each double-whitespace-separated section"
 *     Works decently across markdown, code, JSON, Bash output, prose.
 *   - LLM (Haiku, cached): proper 2-3 sentence summary focused on
 *     what an agent would need to know.
 *
 * The LLM strategy uses a cacheable system prompt (>4096 tokens with worked
 * examples) — first call writes cache, subsequent calls read it. Empirically
 * verified earlier: Haiku 4.5 cache minimum is ~4096 tokens.
 */

import { formatCost } from './anthropic-client.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

// ============================================================
// Heuristic strategy: section-based summary
// ============================================================

/**
 * Universal section detector: split on double-whitespace (markdown sections,
 * code blocks separated by blank lines, JSON top-level keys, prose paragraphs,
 * Bash output stages). Take the first non-empty line of each section, up to N.
 */
export function heuristicSectionSummary(content, { maxSections = 8, maxFirstLineChars = 120 } = {}) {
  if (!content || typeof content !== 'string') return '';
  const sections = content.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  const summaries = [];
  for (const section of sections.slice(0, maxSections)) {
    // First non-empty line of the section
    const firstLine = section.split('\n').map(l => l.trim()).find(l => l.length > 0);
    if (firstLine) {
      summaries.push(firstLine.length > maxFirstLineChars
        ? firstLine.slice(0, maxFirstLineChars) + '...'
        : firstLine);
    }
  }
  if (sections.length > maxSections) {
    summaries.push(`... [${sections.length - maxSections} more sections]`);
  }
  return summaries.join('\n  ');
}

// ============================================================
// LLM strategy: Haiku per-block summary with cached system prompt
// ============================================================

const LLM_SUMMARY_SYSTEM = `You summarize a single tool_result content block from a Claude Code conversation. The summary will replace the original content in the conversation chain (which is being condensed for context-window reasons), but the agent can re-fetch the original via the tool you'll be told about.

Your output must be 2-3 sentences focused on what an AGENT WOULD NEED TO KNOW or DO based on this content. Preserve concrete identifiers (file paths, function names, error types, decisions, key data values). Do NOT editorialize. Do NOT include "this content shows" or "the agent" in your summary — write the summary as a standalone description of what's in the content.

The user message will give you:
- Tool name + args (so you know what was being read/queried)
- The original content (the thing you're summarizing)

Below are worked examples covering common content types. Match the OUTPUT format exactly.

═══════════════════════════════════════════════════════════════════
EXAMPLE 1 — TypeScript source code

Tool: Read
Args: { "file_path": "/src/auth.js" }
Content (256 lines):
import { z } from 'zod';
import jwt from 'jsonwebtoken';

const TokenSchema = z.object({
  sub: z.string(),
  exp: z.number(),
  iat: z.number(),
  scope: z.array(z.string())
});

export async function verifyToken(rawToken, opts = {}) {
  if (!rawToken) throw new Error('TOKEN_MISSING');
  const decoded = jwt.verify(rawToken, getKey(opts.kid));
  const parsed = TokenSchema.parse(decoded);
  if (parsed.exp * 1000 < Date.now()) throw new Error('TOKEN_EXPIRED');
  return parsed;
}

export async function issueToken(payload, opts = {}) {
  const expiresIn = opts.expiresIn ?? '1h';
  return jwt.sign(payload, getKey(opts.kid), { expiresIn, algorithm: 'RS256' });
}

export async function refreshToken(rawToken, opts = {}) {
  const decoded = await verifyToken(rawToken, opts);
  return issueToken({ sub: decoded.sub, scope: decoded.scope }, opts);
}

function getKey(kid) {
  return loadKeyFromVault(kid || 'default');
}

CORRECT OUTPUT:
TypeScript JWT auth module at /src/auth.js. Exports verifyToken (validates + parses via Zod TokenSchema, throws TOKEN_MISSING/TOKEN_EXPIRED), issueToken (signs RS256 with expiresIn arg), refreshToken (verify+reissue). Uses jsonwebtoken + zod; key lookup via loadKeyFromVault.

═══════════════════════════════════════════════════════════════════
EXAMPLE 2 — Markdown plan/instructions

Tool: Read
Args: { "file_path": "/proj/PHASE_2_MIGRATION.md" }
Content (340 lines):
# Phase 2: CouchDB → PostgreSQL Migration

This phase migrates the user_logs collection from CouchDB to PostgreSQL...

## Step 2.1 — Schema design
Create the user_logs table with columns: user_id (uuid), timestamp (timestamptz), event_type (text), payload (jsonb)...

## Step 2.2 — Sync framework integration
Wire the user_logs sync adapter into the SyncOrchestrator pattern from RepairOp...

## Step 2.3 — Index strategy
Add covering index on (user_id, timestamp DESC) for the most common query pattern...

## Step 2.4 — Cutover strategy
Use shadow-write pattern: write to both CouchDB and Postgres for 48 hours, then cut over reads...

## Acceptance criteria
- [ ] All user_logs queries return identical results from both stores during shadow window
- [ ] No P0 ingestion lag observed
- [ ] Rollback plan tested

CORRECT OUTPUT:
Phase 2 migration plan for user_logs (CouchDB → PostgreSQL). Four steps: schema design with (user_id, timestamp, event_type, payload jsonb); sync adapter via RepairOp's SyncOrchestrator; covering index on (user_id, timestamp DESC); shadow-write cutover over 48h. Three acceptance criteria including identical-results validation and tested rollback.

═══════════════════════════════════════════════════════════════════
EXAMPLE 3 — Bash command output (test results)

Tool: Bash
Args: { "command": "npm test" }
Content (180 lines):
> repairop@1.2.3 test
> jest --coverage

PASS  src/auth/__tests__/verifyToken.test.js
PASS  src/auth/__tests__/issueToken.test.js
FAIL  src/auth/__tests__/refreshToken.test.js
  ● refreshToken › rejects expired tokens
    expect(received).rejects.toThrow(expected)
    Expected: "TOKEN_EXPIRED"
    Received: "TOKEN_MISSING"

      45 |   it('rejects expired tokens', async () => {
      46 |     const expired = makeExpiredToken();
    > 47 |     await expect(refreshToken(expired)).rejects.toThrow('TOKEN_EXPIRED');
         |                                                ^
      48 |   });

PASS  src/api/__tests__/health.test.js
... (172 more lines of test output)

Test Suites: 1 failed, 12 passed, 13 total
Tests:       1 failed, 47 passed, 48 total

CORRECT OUTPUT:
npm test run. 47 passed, 1 failed in src/auth/__tests__/refreshToken.test.js — "rejects expired tokens" expected TOKEN_EXPIRED but got TOKEN_MISSING (line 47 of refreshToken.test.js, suggests refreshToken doesn't validate exp before re-issuing).

═══════════════════════════════════════════════════════════════════
EXAMPLE 4 — JSON config

Tool: Read
Args: { "file_path": "/etc/orchestrator-config.json" }
Content (80 lines):
{
  "version": 3,
  "rateLimit": {
    "perMinute": 60,
    "perHour": 1000,
    "burstAllowance": 10
  },
  "workers": {
    "maxConcurrent": 5,
    "idleTimeoutMinutes": 10,
    "spawnDelayMs": 500
  },
  "logging": {
    "level": "info",
    "destination": "stdout",
    "format": "json"
  },
  "mcp": {
    "endpoints": ["worker", "wisdom-store"],
    "timeoutMs": 30000
  },
  "dashboard": {
    "url": "http://192.168.1.2:3335",
    "refreshIntervalSec": 5,
    "instantResponse": true
  }
}

CORRECT OUTPUT:
Orchestrator config v3 at /etc/orchestrator-config.json. Top-level keys: rateLimit (60/min, 1000/hr, burst 10), workers (max 5 concurrent, 10min idle timeout), logging (info level, json stdout), mcp (worker + wisdom-store endpoints, 30s timeout), dashboard (instantResponse:true at http://192.168.1.2:3335).

═══════════════════════════════════════════════════════════════════
EXAMPLE 5 — DB query result

Tool: mcp__cpr-api-proxy__db_query
Args: { "query": "SELECT user_id, COUNT(*) AS events FROM user_logs WHERE event_type = 'login' GROUP BY user_id ORDER BY events DESC LIMIT 10" }
Content (12 rows):
**10 row(s)** [VPS production (10.10.0.1)] | Columns: user_id, events

  | user_id                                | events |
  | uuid-aaa1-...                          |   2847 |
  | uuid-bbb2-...                          |   1923 |
  | uuid-ccc3-...                          |   1456 |
  | uuid-ddd4-...                          |    988 |
  | uuid-eee5-...                          |    742 |
  | uuid-fff6-...                          |    611 |
  | uuid-aaa7-...                          |    503 |
  | uuid-bbb8-...                          |    489 |
  | uuid-ccc9-...                          |    367 |
  | uuid-ddd0-...                          |    298 |

CORRECT OUTPUT:
Top-10 users by login event count from production user_logs. Range: 2847 (uuid-aaa1) down to 298 (uuid-ddd0). Median around 600-700 events; ratio of top to bottom ~9.5x suggests heavy long-tail of login activity.

═══════════════════════════════════════════════════════════════════
EXAMPLE 6 — Multi-file Grep result

Tool: Grep
Args: { "pattern": "session.*expire", "path": "/src" }
Content:
/src/auth.js:23:  if (parsed.exp * 1000 < Date.now()) throw new Error('TOKEN_EXPIRED');
/src/middleware/session.js:67:  function isExpired(session) { return session.expiresAt < new Date(); }
/src/middleware/session.js:91:  // Sweep expired sessions hourly
/src/db/migrations/004_session_expiry.sql:1:  ALTER TABLE sessions ADD COLUMN expires_at TIMESTAMPTZ NOT NULL;
/src/db/migrations/004_session_expiry.sql:2:  CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CORRECT OUTPUT:
Grep "session.*expire" matched 5 lines across 3 files: /src/auth.js (TOKEN_EXPIRED throw at L23), /src/middleware/session.js (isExpired check L67, sweep comment L91), /src/db/migrations/004_session_expiry.sql (expires_at column + index migration).

═══════════════════════════════════════════════════════════════════
EXAMPLE 7 — Long agent-style text response (rare for tool_result, but cover it)

Tool: WebFetch
Args: { "url": "https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking" }
Content (4500 chars of markdown):
# Extended Thinking
Extended thinking gives Claude enhanced reasoning capabilities for complex tasks...
## Supported models
Extended thinking is supported in: claude-opus-4, claude-sonnet-4, claude-haiku-4.5...
## How it works
When extended thinking is enabled, the model performs a thinking step before...
## Token costs
Thinking tokens are billed at the same rate as input tokens for the model in use...
## Working with tool use
Extended thinking is compatible with tool use, but with these constraints...

CORRECT OUTPUT:
Anthropic docs page on Extended Thinking. Supported by claude-opus-4, sonnet-4, haiku-4.5. Adds a thinking step before output (billed at input-token rate). Compatible with tool use under documented constraints. Page covers usage examples, token costs, and tool-use integration patterns.

═══════════════════════════════════════════════════════════════════
EXAMPLE 8 — MCP query returning a list of structured items

Tool: mcp__orchestrator__list_workers
Args: {}
Content:
[
  { "sessionId": "claude-loop170", "status": "active", "lastActivity": "2026-05-12T18:30:00Z", "currentTask": "iq-feedback-widget" },
  { "sessionId": "claude-loop171", "status": "active", "lastActivity": "2026-05-12T18:25:00Z", "currentTask": "repairop-iq-integration" },
  { "sessionId": "claude-loop172", "status": "idle", "lastActivity": "2026-05-12T17:50:00Z", "currentTask": null },
  { "sessionId": "claude-loop173", "status": "active", "lastActivity": "2026-05-12T18:32:00Z", "currentTask": "iq-group-management-ui" },
  { "sessionId": "claude-loop174", "status": "completed", "lastActivity": "2026-05-12T16:00:00Z", "currentTask": "reactions-research" }
]

CORRECT OUTPUT:
List of 5 workers from orchestrator. Active: loop170 (iq-feedback-widget), loop171 (repairop-iq-integration), loop173 (iq-group-management-ui). Idle: loop172. Completed: loop174 (reactions-research). Most recent activity: loop173 at 18:32.

═══════════════════════════════════════════════════════════════════

GENERAL RULES:

- Output the SUMMARY ONLY — no preamble, no "Here's a summary", no quotation marks around it.
- 2-3 sentences max. Densely packed with concrete identifiers.
- Lead with the content type / file purpose, then key facts/structure.
- Preserve: file paths, function/class names, error messages, key data values, decisions, counts/totals.
- For test/error output: name the failure + its specific error message.
- For DB results: row count, column names, range/median of any numeric columns.
- For lists: count + identifying details of first/last + any notable groupings.
- For code: file role + main exports/functions + relevant imports.
- For configs: top-level keys + key values that look load-bearing.
- For markdown plans: phase/step structure + acceptance criteria if present.

When in doubt: imagine an agent reading just this 2-3 sentence summary — what's the minimum it needs to know to either (a) act correctly without re-fetching, or (b) realize it needs to re-fetch?`;

export async function summarizeContentWithHaiku(client, { toolName, toolArgs, content }) {
  const userPrompt = `Tool: ${toolName}
Args: ${JSON.stringify(toolArgs || {})}
Content (${content.length} chars):
${content.slice(0, 25000)}${content.length > 25000 ? '\n... [content truncated for prompt size; original is ' + content.length + ' chars] ...' : ''}`;

  try {
    const resp = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 250,
      system: [{ type: 'text', text: LLM_SUMMARY_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }]
    });
    const textBlock = resp.content.find(b => b.type === 'text');
    return {
      summary: textBlock?.text?.trim() || '',
      usage: resp.usage,
      cost: formatCost(HAIKU_MODEL, resp.usage.input_tokens, resp.usage.output_tokens)
    };
  } catch (e) {
    return { summary: null, error: `HTTP ${e.status || '?'}: ${e.message}`, usage: null };
  }
}

/**
 * Concurrent summarization with backoff. Returns array aligned with input order.
 * Falls back to heuristicSectionSummary on individual call failures (so the run
 * never fully fails — worst case some blocks get heuristic summaries instead).
 */
export async function summarizeBlocksConcurrent(client, blocks, { concurrency = 5, onProgress } = {}) {
  const results = new Array(blocks.length);
  let cursor = 0;
  let totalUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= blocks.length) return;
      const b = blocks[idx];
      let attempts = 0;
      const maxAttempts = 4;
      let backoff = 1000;
      while (attempts < maxAttempts) {
        const r = await summarizeContentWithHaiku(client, b);
        if (r.summary != null) {
          results[idx] = r;
          if (r.usage) {
            totalUsage.input_tokens += r.usage.input_tokens || 0;
            totalUsage.output_tokens += r.usage.output_tokens || 0;
            totalUsage.cache_read_input_tokens += r.usage.cache_read_input_tokens || 0;
            totalUsage.cache_creation_input_tokens += r.usage.cache_creation_input_tokens || 0;
          }
          break;
        }
        if (r.error?.includes('429') || r.error?.includes('529')) {
          await new Promise(res => setTimeout(res, backoff));
          backoff = Math.min(backoff * 2, 30000);
          attempts++;
          continue;
        }
        // Non-retryable error → fall back to heuristic
        results[idx] = { summary: heuristicSectionSummary(b.content), error: r.error, fallback: true };
        break;
      }
      if (!results[idx]) {
        // Exhausted retries → heuristic fallback
        results[idx] = { summary: heuristicSectionSummary(b.content), error: 'rate-limited after retries', fallback: true };
      }
      if (onProgress) onProgress(idx + 1, blocks.length);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return { results, usage: totalUsage };
}
