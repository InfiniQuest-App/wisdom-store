/**
 * orphan-summarizer.js
 *
 * Heuristic summarizer for messages about to be orphaned by prune_context.
 * Pure JS, no API calls — extracts structural facts (files touched, tools used,
 * bash commands, user-decision messages) and groups them into segments so the
 * caller can progressively reveal specific ranges via inspect_pruned_messages.
 *
 * Reads the JSONL file directly because walkChain returns lightweight entries for
 * large files (>50MB) — only chain-critical fields. We need full message bodies
 * to extract tool calls, files touched, and decision text.
 */

import fs from 'fs';
import { getMessageContent } from './jsonl.js';

const DEFAULT_SEGMENT_SIZE = 200;

// Patterns that strongly suggest a user message is a decision / instruction
// (not an info request or back-and-forth chatter).
const DECISION_PATTERNS = [
  /\b(let'?s|go with|ship|do it|proceed|build it|implement|fix it|push it)\b/i,
  /\b(yes,?\s|approved|confirmed|go ahead)\b/i,
  /^(do|make|fix|build|add|remove|update|create|implement|ship|push|commit)\s/i,
];

function isDecisionLike(text) {
  if (!text || text.length < 5) return false;
  if (text.length > 500) return false; // long messages aren't usually quick decisions
  return DECISION_PATTERNS.some(p => p.test(text));
}

// Walk a message's content array and extract tool_use blocks
function extractToolUses(msg) {
  const out = [];
  const content = msg?.message?.content;
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (block?.type === 'tool_use') {
      out.push({ name: block.name, input: block.input || {} });
    }
  }
  return out;
}

/**
 * Detect whether a message is a "real user turn" — a human-typed message that
 * starts a new turn. Tool-result messages are also user-role but aren't real
 * turns; we ignore them so turn counts reflect actual human prompts.
 */
export function isRealUserTurn(msg) {
  const role = msg?.message?.role || msg?.type;
  if (role !== 'user') return false;
  const content = msg?.message?.content;
  if (typeof content === 'string' && content.trim().length > 0) return true;
  if (Array.isArray(content)) {
    // Real turn if any block is a text block (not just tool_results)
    return content.some(b => b?.type === 'text' && (b.text || '').trim().length > 0);
  }
  return false;
}

/**
 * Walk messages and assign a turn_id to each based on real-user-turn boundaries.
 * Returns an array parallel to messages: turnIds[i] = turn id (1-indexed) of messages[i].
 * Messages before the first real user turn get turn_id 0.
 */
export function assignTurnIds(messages) {
  const turnIds = new Array(messages.length).fill(0);
  let currentTurn = 0;
  for (let i = 0; i < messages.length; i++) {
    if (isRealUserTurn(messages[i])) currentTurn++;
    turnIds[i] = currentTurn;
  }
  return turnIds;
}

// For a single segment of messages, build a summary.
// turnIds is parallel to messages — turnIds[i] is the 1-indexed turn id of messages[i].
function summarizeSegment(messages, startIdx, turnIds) {
  const filesTouched = new Set();
  const toolCounts = {};
  const bashSamples = [];
  const userDecisions = []; // [{ turn_id, text }]
  const assistantHighlights = [];
  let firstTs = null;
  let lastTs = null;
  let firstTurn = null;
  let lastTurn = null;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const turnId = turnIds[i];
    if (turnId > 0) {
      if (firstTurn === null) firstTurn = turnId;
      lastTurn = turnId;
    }

    const ts = m.timestamp;
    if (ts && !firstTs) firstTs = ts;
    if (ts) lastTs = ts;

    // Tool uses
    for (const tu of extractToolUses(m)) {
      toolCounts[tu.name] = (toolCounts[tu.name] || 0) + 1;
      if (tu.input.file_path) filesTouched.add(tu.input.file_path);
      if (tu.name === 'Bash' && tu.input.command && bashSamples.length < 5) {
        const cmd = String(tu.input.command).split('\n')[0].slice(0, 120);
        const desc = tu.input.description ? ` # ${tu.input.description}` : '';
        bashSamples.push(cmd + desc);
      }
    }

    // User decisions / assistant highlights — work from extracted text
    const role = m?.message?.role || m?.type;
    const text = (getMessageContent({ data: m }) || '').trim();
    if (!text) continue;

    if (role === 'user' && isDecisionLike(text)) {
      const oneLine = text.split('\n')[0].slice(0, 200);
      if (userDecisions.length < 6) userDecisions.push({ turn_id: turnId, text: oneLine });
    } else if (role === 'assistant' && text.length > 80 && assistantHighlights.length < 3) {
      const oneLine = text.split('\n')[0].slice(0, 160);
      assistantHighlights.push({ turn_id: turnId, text: oneLine });
    }
  }

  return {
    msg_range: [startIdx + 1, startIdx + messages.length], // 1-indexed
    turn_range: firstTurn !== null ? [firstTurn, lastTurn] : null,
    time_range: firstTs && lastTs ? [firstTs, lastTs] : null,
    files_touched: [...filesTouched].slice(0, 15),
    files_touched_count: filesTouched.size,
    tools_used: toolCounts,
    bash_samples: bashSamples,
    user_decisions: userDecisions,
    assistant_highlights: assistantHighlights,
  };
}

/**
 * Summarize an array of messages (about to be orphaned) into segments.
 *
 * @param {Array} messages - Messages in chronological order, parsed from JSONL chain
 * @param {number} segmentSize - Messages per segment (default 200)
 * @returns {Array} segments with structured summary fields
 */
export function summarizeOrphanedMessages(messages, segmentSize = DEFAULT_SEGMENT_SIZE) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const turnIds = assignTurnIds(messages);
  const segments = [];
  for (let i = 0; i < messages.length; i += segmentSize) {
    const slice = messages.slice(i, Math.min(i + segmentSize, messages.length));
    const sliceTurnIds = turnIds.slice(i, Math.min(i + segmentSize, messages.length));
    segments.push({
      id: segments.length + 1,
      ...summarizeSegment(slice, i, sliceTurnIds),
    });
  }
  return segments;
}

/**
 * Convenience: load full message bodies for a set of line indices in a JSONL file,
 * then summarize. Handles the large-file case where walkChain returned lightweight
 * entries that don't include the message body.
 *
 * @param {string} filePath - Absolute path to the conversation JSONL
 * @param {number[]} lineIndices - Non-empty-line indices to load (from chain[i].line)
 * @param {number} segmentSize - Messages per segment (default 200)
 * @returns {Array} segments with structured summary fields
 */
export function summarizeOrphanedFromFile(filePath, lineIndices, segmentSize = DEFAULT_SEGMENT_SIZE) {
  if (!Array.isArray(lineIndices) || lineIndices.length === 0) return [];
  const wanted = new Set(lineIndices);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const messages = [];
  let nonEmptyIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (wanted.has(nonEmptyIdx)) {
      try { messages.push(JSON.parse(lines[i])); } catch (_) { /* skip malformed */ }
    }
    nonEmptyIdx++;
  }
  // Preserve original chronological order from lineIndices ordering
  return summarizeOrphanedMessages(messages, segmentSize);
}

/**
 * Format a summary array into a markdown block suitable for tool-response embedding.
 * Compact-but-informative — designed to give the caller enough signal to decide
 * whether they need to inspect_pruned_messages on a specific segment.
 */
export function formatSummary(segments, conversationId) {
  if (!segments || segments.length === 0) return '';
  const lines = [
    ``,
    `### 📜 Pruned content summary (${segments.length} segment${segments.length === 1 ? '' : 's'})`,
    ``,
    `Reveal options for any segment or sub-range below:`,
    `  - Whole segment: \`inspect_pruned_messages({ conversation_id: "${conversationId}", segment_id: N })\``,
    `  - Single turn:   \`inspect_pruned_messages({ conversation_id: "${conversationId}", turn_id: N })\``,
    `  - Turn range:    \`inspect_pruned_messages({ conversation_id: "${conversationId}", turn_range: [N, M] })\``,
    `  - Message range: \`inspect_pruned_messages({ conversation_id: "${conversationId}", message_range: [N, M] })\``,
    ``,
  ];

  for (const seg of segments) {
    const tools = Object.entries(seg.tools_used)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([n, c]) => `${n}×${c}`)
      .join(', ');
    const timeStr = seg.time_range
      ? `${seg.time_range[0].slice(0, 16).replace('T', ' ')} → ${seg.time_range[1].slice(0, 16).replace('T', ' ')}`
      : 'unknown time';
    const turnStr = seg.turn_range
      ? ` · turns ${seg.turn_range[0]}${seg.turn_range[0] === seg.turn_range[1] ? '' : '–' + seg.turn_range[1]}`
      : '';
    lines.push(`---`);
    lines.push(`**Segment ${seg.id}** — msgs ${seg.msg_range[0]}–${seg.msg_range[1]}${turnStr} · ${timeStr}`);
    if (tools) lines.push(`- Tools: ${tools}`);
    if (seg.files_touched_count > 0) {
      const filesLine = seg.files_touched.length === seg.files_touched_count
        ? seg.files_touched.join(', ')
        : `${seg.files_touched.join(', ')} … (+${seg.files_touched_count - seg.files_touched.length} more)`;
      lines.push(`- Files (${seg.files_touched_count}): ${filesLine}`);
    }
    if (seg.bash_samples.length > 0) {
      lines.push(`- Bash samples:`);
      for (const cmd of seg.bash_samples) lines.push(`  - \`${cmd}\``);
    }
    if (seg.user_decisions.length > 0) {
      lines.push(`- User decisions/instructions:`);
      for (const d of seg.user_decisions) {
        const turnTag = d.turn_id ? `turn ${d.turn_id}: ` : '';
        lines.push(`  - ${turnTag}"${d.text}"`);
      }
    }
    if (seg.assistant_highlights.length > 0) {
      lines.push(`- Assistant highlights:`);
      for (const h of seg.assistant_highlights) {
        const turnTag = h.turn_id ? `turn ${h.turn_id}: ` : '';
        lines.push(`  - ${turnTag}"${h.text}"`);
      }
    }
  }
  return lines.join('\n');
}
