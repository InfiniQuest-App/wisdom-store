/**
 * analyze_for_archive tool
 *
 * Calls the Anthropic API (against Mike's Pro/Max OAuth) to produce a structured
 * trim plan over a Claude Code conversation JSONL. Output is a list of {uuid,
 * action, distillation?, reason} entries — only entries that REQUIRE action
 * are included; everything else is implicit-keep. The plan is persisted to
 * `<conversation_dir>/.archive-plans/<planId>.json` so apply_archive_plan
 * can later validate (checksum + drift) and execute it.
 *
 * Why a compact decision-skeleton rather than raw JSONL: a real session can
 * easily be 30MB / 7M+ tokens — that's bigger than even the 1M-context window.
 * We pre-process every chain entry into a compact line containing role,
 * timestamp, and a content excerpt. Long tool outputs are head+tail-clipped
 * (LLM still sees the bulk of meaningful messages). This shrinks a 30MB JSONL
 * to typically <500KB of LLM input — well inside 1M context.
 *
 * Auth: OAuth via getAnthropicClient. Refuses cleanly without `allowApiKey:true`
 * if no OAuth credential is available — Mike's stated preference.
 *
 * Cost is always reported (Mike: visibility-by-default, no opt-in dance).
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
import { getAnthropicClient, formatCost } from '../lib/anthropic-client.js';

const SONNET_MODEL = 'claude-sonnet-4-6';
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const TOOL_OUTPUT_HEAD = 600;
const TOOL_OUTPUT_TAIL = 200;
const PER_ENTRY_MAX_CHARS = 4000;
const PLAN_TTL_MS = 60 * 60 * 1000; // 1 hour

function archiveDirsFor(jsonlPath) {
  const dir = path.dirname(jsonlPath);
  return {
    plans: path.join(dir, '.archive-plans'),
    backups: path.join(dir, '.archive-backups')
  };
}

function clipText(text, maxChars) {
  if (!text || text.length <= maxChars) return text || '';
  const head = text.slice(0, Math.floor(maxChars * 0.75));
  const tail = text.slice(-Math.floor(maxChars * 0.20));
  const dropped = text.length - head.length - tail.length;
  return `${head}\n... [${dropped} chars elided] ...\n${tail}`;
}

/**
 * Build a single compact line per chain entry. The LLM sees enough to decide
 * keep/drop/distill without us shipping the full JSON wrapping for every entry.
 */
function compactLineForEntry(entry, fullData) {
  const data = fullData || entry.data;
  const uuid = data.uuid || '?';
  const ts = (data.timestamp || '').slice(0, 19).replace('T', ' ');
  const role = data.message?.role || data.type || 'unknown';

  const msg = data.message;
  let body = '';
  let actionLabel = '';

  if (msg && Array.isArray(msg.content)) {
    const parts = [];
    for (const block of msg.content) {
      if (block?.type === 'text') {
        parts.push(block.text || '');
      } else if (block?.type === 'thinking') {
        parts.push(`[thinking: ${(block.thinking || '').slice(0, 300)}]`);
      } else if (block?.type === 'tool_use') {
        const fp = block.input?.file_path ? ` ${block.input.file_path}` : '';
        const cmd = block.input?.command ? ` \`${String(block.input.command).split('\n')[0].slice(0, 100)}\`` : '';
        actionLabel = `[tool_use ${block.name}${fp}${cmd}]`;
        parts.push(actionLabel);
      } else if (block?.type === 'tool_result') {
        let txt = '';
        if (typeof block.content === 'string') txt = block.content;
        else if (Array.isArray(block.content)) txt = block.content.map(c => c.text || '').join('\n');
        const isErr = block.is_error ? '[ERROR] ' : '';
        // Tool outputs get aggressive head+tail clipping — the brief flags
        // these as the bulk of bloat and "DROP entirely once incorporated".
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
  } else if (typeof data.content === 'string') {
    body = data.content;
  }

  body = clipText(body, PER_ENTRY_MAX_CHARS);
  return `<entry uuid="${uuid}" role="${role}" ts="${ts}">\n${body}\n</entry>`;
}

const SYSTEM_PROMPT = `You are an archival planner for Claude Code conversation logs. You produce a TRIM PLAN that decides, for each message in a conversation, whether it should be kept verbatim (the default — implicit), DROPPED entirely, or DISTILLED (replaced by a 1-2 sentence summary that preserves a load-bearing lesson).

LOAD-BEARING DEFINITION (the user's words, follow them):

> Keeping things essential to its job, as presumed from user messages. Typically having the latest context/content on files and plans it frequently touches, summary of reasons we changed directions / why we're going the direction we are now. Don't need duplicates, especially older copies. But simply pruning out older copies does run the risk of losing: what we tried that didn't work, why we didn't do X. Worth summarizing mistakes / pitfalls / reasons / current paths.

KEEP VERBATIM (do not list — these are the implicit default for any uuid you don't include):
- User intent + goals (early task brief, scope decisions)
- Latest content/state for files and plans the session frequently touches
- Decisions made (architecture, naming, scope cuts)
- Direction-change rationale ("why we changed from X to Y")
- Constraints discovered ("this fails because Z")
- Recent ~30 turns (the active state)
- File paths + symbols currently being worked on
- system-reminder content carrying project rules

DROP entirely (action: "drop"):
- Older copies of files when a newer copy exists later in the conversation
- Large tool outputs (file dumps, web fetches, log captures) ONCE their conclusion has been incorporated into a later message
- Pure back-and-forth without decisions (clarifying micro-exchanges)
- Duplicate file reads

DISTILL (action: "distill", with a 1-2 sentence \`distillation\` field):
- Failed attempts that taught a lesson — capture "we tried X, it didn't work because Y, so we went with Z"
- Superseded plans the conversation has moved past
- Long debugging arcs that resolved — capture root cause and fix in a sentence

THE CRITICAL RULE: pure deletion of failed attempts is dangerous because the assistant later forgets WHY they're on path Y and might re-suggest X. When in doubt between drop and distill, prefer distill.

DISTILLATION CONSTRAINT: never select a single entry containing a tool_use OR tool_result block for action: "distill" — distilling an assistant tool_use would orphan the paired tool_result in the next message; distilling a user tool_result would leave an in-flight tool_use unanswered. For tool-call arcs you want to compress, use action: "drop" on the entire arc (assistant tool_use + user tool_result + any subsequent assistant interpretation), and let an EARLIER user/assistant text-only message carry the distillation summary if needed.

Output format: emit a single JSON object with shape { entries: [...] } where each entry is { uuid, action: "drop"|"distill", distillation?: string, reason: string }. Only include entries that need action. Do NOT include entries you would keep verbatim. The \`reason\` field is REQUIRED for every entry. \`distillation\` is REQUIRED iff action is "distill".`;

function buildUserPrompt({ purpose, compactBody, jsonlMessages }) {
  return [
    purpose ? `PURPOSE OF THE SESSION (use this to judge what's load-bearing):\n${purpose}\n` : '',
    `The conversation has ${jsonlMessages} chain messages. Produce a trim plan in the JSON format described in the system prompt. Only include entries that need action (drop or distill). Implicit-keep is the default.\n`,
    `CONVERSATION (compact decision-skeleton — long tool outputs are head+tail clipped):\n`,
    compactBody
  ].filter(Boolean).join('\n');
}

const TRIM_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          uuid: { type: 'string', description: 'The uuid of the chain entry' },
          action: { type: 'string', enum: ['drop', 'distill'] },
          distillation: { type: 'string', description: '1-2 sentence summary; required iff action is "distill"' },
          reason: { type: 'string', description: 'Why this entry needs this action' }
        },
        required: ['uuid', 'action', 'reason']
      }
    }
  },
  required: ['entries']
};

async function derivePurposeWithHaiku(client, userMessages) {
  const transcript = userMessages.slice(0, 50).map((m, i) => `[user ${i + 1}] ${m}`).join('\n\n');
  const resp = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 400,
    system: 'You summarize Claude Code session purpose in 3-5 sentences. Focus on what the user is trying to accomplish, what files/areas they care about, and the overall goal. Be concrete, not generic. Output the summary directly with no preamble.',
    messages: [{ role: 'user', content: `Summarize the purpose of this Claude Code session based on these user messages:\n\n${transcript}` }]
  });
  const text = resp.content.find(b => b.type === 'text')?.text || '';
  return {
    purpose: text.trim(),
    cost: formatCost(HAIKU_MODEL, resp.usage.input_tokens, resp.usage.output_tokens)
  };
}

function canonicalStringify(obj) {
  // Deterministic JSON serialization for checksum stability: sort keys recursively.
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

export async function handleAnalyzeForArchive(args = {}) {
  const filePath = findConversationFile(args.conversation_id);
  if (!filePath) {
    return {
      content: [{ type: 'text', text: 'No conversation file found for this project/session.' }],
      isError: true
    };
  }

  const allowApiKey = args.allowApiKey === true;
  let clientResult;
  try {
    clientResult = getAnthropicClient({ allowApiKey });
  } catch (e) {
    return {
      content: [{ type: 'text', text: `Auth error: ${e.message}` }],
      isError: true
    };
  }
  const { client, authMode, billing, subscriptionType } = clientResult;

  const fileStat = fs.statSync(filePath);
  const entries = readJsonl(filePath);
  const chain = walkChain(entries);
  if (chain.length === 0) {
    return {
      content: [{ type: 'text', text: 'Conversation chain is empty — nothing to analyze.' }],
      isError: true
    };
  }

  // Build compact decision-skeleton. For each chain entry, re-read full line so
  // we have message body even on >50MB files (lightweight reader returns a stub).
  const compactLines = [];
  for (const e of chain) {
    const full = readJsonlLine(filePath, e.line) || e.data;
    compactLines.push(compactLineForEntry(e, full));
  }
  const compactBody = compactLines.join('\n\n');

  // Approximate input-size guard (4 chars/token rule of thumb).
  const compactBytes = Buffer.byteLength(compactBody);
  const approxInputTokens = Math.ceil(compactBytes / 4);
  if (approxInputTokens > 950_000) {
    return {
      content: [{
        type: 'text',
        text: `Compact decision-skeleton is ~${approxInputTokens.toLocaleString()} tokens, exceeds the 1M-context budget. ` +
              `JSONL has ${chain.length} entries; consider running sandwich_prune first to reduce size, then re-running analyze_for_archive on the trimmed file.`
      }],
      isError: true
    };
  }

  // Optional purpose pre-derivation via Haiku
  let derivedPurpose;
  let derivePurposeCost;
  if (args.derivePurpose !== false && !args.purpose) {
    try {
      const userMsgs = chain
        .filter(e => e.data.type === 'user')
        .map(e => {
          const full = readJsonlLine(filePath, e.line) || e.data;
          return getMessageContent({ data: full });
        })
        .filter(t => t && t.trim().length > 0);
      const result = await derivePurposeWithHaiku(client, userMsgs);
      derivedPurpose = result.purpose;
      derivePurposeCost = result.cost;
    } catch (e) {
      // Graceful: continue without a derived purpose. Surface status so caller
      // knows whether it was rate-limit, auth, or genuine API issue.
      const status = e.status ? `HTTP ${e.status} ` : '';
      derivedPurpose = null;
      derivePurposeCost = `(haiku purpose-derivation failed: ${status}${e.message})`;
    }
  }
  const purpose = args.purpose || derivedPurpose || '';

  // Main planning call (Sonnet 4.6, 1M context).
  let resp;
  try {
    resp = await client.messages.create({
      model: SONNET_MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools: [{
        name: 'submit_trim_plan',
        description: 'Submit the structured trim plan with action-required entries.',
        input_schema: TRIM_PLAN_SCHEMA
      }],
      tool_choice: { type: 'tool', name: 'submit_trim_plan' },
      messages: [{
        role: 'user',
        content: buildUserPrompt({ purpose, compactBody, jsonlMessages: chain.length })
      }]
    });
  } catch (e) {
    const status = e.status || '';
    const detail = e.error?.error?.message || e.error?.message || e.message || String(e);
    let hint = '';
    if (status === 429) hint = ' Rate-limited against your Claude subscription. Wait a few minutes and retry, or use a smaller conversation. Subscription rate limits apply per-user, not per-tool.';
    else if (status === 401) hint = ' Auth failed — re-authenticate via Claude Code (run /login).';
    else if (status === 400) hint = ' Bad request — likely the compact skeleton exceeded the 1M token window despite the pre-check. Try sandwich_prune first.';
    return {
      content: [{ type: 'text', text: `Sonnet planning call failed: HTTP ${status} ${detail}.${hint}` }],
      isError: true
    };
  }

  const toolUseBlock = resp.content.find(b => b.type === 'tool_use');
  if (!toolUseBlock) {
    return {
      content: [{ type: 'text', text: `Sonnet did not return a tool_use block. Raw stop_reason=${resp.stop_reason}.` }],
      isError: true
    };
  }
  const planEntries = toolUseBlock.input?.entries || [];

  // Validate entries against actual chain uuids — drop any hallucinated ones.
  const chainUuids = new Set(chain.map(e => e.data.uuid).filter(Boolean));
  const validEntries = [];
  const hallucinated = [];
  for (const entry of planEntries) {
    if (!entry.uuid || !chainUuids.has(entry.uuid)) {
      hallucinated.push(entry.uuid || '<missing>');
      continue;
    }
    if (entry.action !== 'drop' && entry.action !== 'distill') {
      hallucinated.push(`${entry.uuid}:bad-action(${entry.action})`);
      continue;
    }
    if (entry.action === 'distill' && !entry.distillation) {
      hallucinated.push(`${entry.uuid}:missing-distillation`);
      continue;
    }
    if (!entry.reason) {
      hallucinated.push(`${entry.uuid}:missing-reason`);
      continue;
    }
    validEntries.push(entry);
  }

  const dropCount = validEntries.filter(e => e.action === 'drop').length;
  const distillCount = validEntries.filter(e => e.action === 'distill').length;
  const lastMessageUuid = chain[chain.length - 1].data.uuid;

  const planId = randomUUID();
  const cost = formatCost(SONNET_MODEL, resp.usage.input_tokens, resp.usage.output_tokens);

  // Compute deterministic checksum BEFORE adding fields that aren't part of the
  // plan itself (createdAt, costs, etc.) — only hash the load-bearing payload.
  const planCore = {
    planId,
    jsonlPath: filePath,
    jsonlBytes: fileStat.size,
    jsonlMessages: chain.length,
    lastMessageUuid,
    entries: validEntries
  };
  const checksum = crypto.createHash('sha256').update(canonicalStringify(planCore)).digest('hex');

  const fullPlan = {
    ...planCore,
    checksum,
    createdAt: Date.now(),
    purpose,
    derivedPurpose: derivedPurpose || undefined,
    cost,
    derivePurposeCost: derivePurposeCost || undefined,
    authMode,
    billing,
    subscriptionType,
    sonnetUsage: resp.usage,
    hallucinatedDropped: hallucinated
  };

  // Persist plan next to the conversation file (survives MCP restarts).
  const dirs = archiveDirsFor(filePath);
  fs.mkdirSync(dirs.plans, { recursive: true });
  const planPath = path.join(dirs.plans, `${planId}.json`);
  fs.writeFileSync(planPath, JSON.stringify(fullPlan, null, 2));

  // Estimate reduction: drops contribute their full byte cost, distills replace
  // potentially-large entries with ~1-2 sentence summaries. We approximate
  // distill savings as 90% of the original entry's char count.
  let estimatedBytesFreed = 0;
  for (const e of validEntries) {
    const chainEntry = chain.find(c => c.data.uuid === e.uuid);
    if (!chainEntry) continue;
    const full = readJsonlLine(filePath, chainEntry.line);
    const lineSize = JSON.stringify(full || {}).length;
    if (e.action === 'drop') estimatedBytesFreed += lineSize;
    else estimatedBytesFreed += Math.floor(lineSize * 0.9);
  }
  const estimatedReductionPct = fileStat.size > 0
    ? Math.round((estimatedBytesFreed / fileStat.size) * 100)
    : 0;

  // Compose the user-facing response. Include only the surface a caller needs
  // to decide whether to apply: the plan id, checksum, summary stats, and a
  // sample of the entries (so they can spot-check). Full plan is on disk.
  const lines = [
    `## analyze_for_archive — Plan Generated`,
    ``,
    `**Plan ID**: \`${planId}\``,
    `**Checksum**: \`${checksum.slice(0, 16)}...\` (full in plan file)`,
    `**Plan file**: \`${planPath}\``,
    `**Auth**: ${authMode} (${billing}${subscriptionType ? `, ${subscriptionType}` : ''})`,
    ``,
    `**Conversation**: ${path.basename(filePath)}`,
    `**File size**: ${(fileStat.size / 1024).toFixed(0)} KB`,
    `**Chain length**: ${chain.length} messages`,
    `**Last message uuid**: ${lastMessageUuid}`,
    ``,
    `**Plan stats**:`,
    `- Drop: ${dropCount}`,
    `- Distill: ${distillCount}`,
    `- Implicit-keep: ${chain.length - dropCount - distillCount}`,
    `- Estimated reduction: ~${estimatedReductionPct}%`,
    hallucinated.length ? `- Hallucinated/invalid entries dropped from plan: ${hallucinated.length}` : '',
    ``,
    derivedPurpose ? `**Derived purpose** (Haiku pre-pass${derivePurposeCost ? `, ${derivePurposeCost}` : ''}):\n${derivedPurpose}\n` : '',
    `**Cost (Sonnet plan call)**: ${cost}`,
    derivePurposeCost && derivedPurpose ? `**Cost (Haiku purpose-pass)**: ${derivePurposeCost}` : '',
    ``,
    `Sample entries (first 5 of ${validEntries.length}):`,
    ...validEntries.slice(0, 5).map((e, i) =>
      `${i + 1}. [${e.action}] ${e.uuid.slice(0, 8)}... — ${e.reason}` +
      (e.distillation ? `\n   distillation: ${e.distillation}` : '')
    ),
    ``,
    `Next: \`apply_archive_plan({ planId: "${planId}", checksum: "${checksum}", confirm: true })\`.`,
    `Plan expires after ${PLAN_TTL_MS / 60000} minutes; re-run analyze if it does.`,
  ].filter(l => l !== '').join('\n');

  return {
    content: [{ type: 'text', text: lines }]
  };
}

export const ANALYZE_INTERNALS = {
  archiveDirsFor,
  canonicalStringify,
  compactLineForEntry,
  PLAN_TTL_MS
};
