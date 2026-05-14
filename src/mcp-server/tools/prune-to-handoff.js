/**
 * prune_to_handoff tool
 *
 * Companion to the "session writes its own hand-off near end-of-life" workflow.
 *
 * Flow:
 *   1. A session approaching context/TTL limit is prompted (manually or by the
 *      claudeLoop dashboard automation) to write a structured hand-off message
 *      that includes a stable marker line (default "## SESSION HANDOFF").
 *   2. The session writes the hand-off as its assistant response. The chain now
 *      ends with: [...prior turns] → [user: write handoff] → [assistant: handoff].
 *   3. On resume, this tool is called. It scans the chain newest-first for the
 *      marker, walks back to the user message that prompted the hand-off, and
 *      sets parentUuid:null on that user message. Everything before becomes
 *      orphaned — the next session's context is just (handoff request) +
 *      (handoff response) + whatever comes next.
 *
 * Why a curated hand-off beats /compact:
 *   - The session knows what mattered; the summarizer guesses from outside.
 *   - File pointers in the hand-off don't go stale; inline summaries do.
 *   - Cheap: one in-context message vs. a full-chain LLM pass.
 *   - The orphaned JSONL stays on disk; nothing is destroyed.
 *
 * Marker convention: any text the hand-off template anchors on. Default
 * "## SESSION HANDOFF" matches the template in docs/handoff-template.md.
 * Override via `marker` arg if you use a custom template.
 */

import {
  findConversationFile,
  readJsonl,
  readJsonlLine,
  walkChain,
  rewriteLine,
  estimateTokens,
  getMessageContent
} from '../lib/jsonl.js';

const VALID_ROOT_TYPES = new Set(['user', 'system']);
const DEFAULT_MARKER = '## SESSION HANDOFF';

export async function handlePruneToHandoff(args = {}) {
  const filePath = findConversationFile(args.conversation_id);
  if (!filePath) {
    return {
      content: [{ type: 'text', text: 'No conversation file found for this project.' }],
      isError: true
    };
  }

  const marker = (args.marker || DEFAULT_MARKER).trim();
  if (!marker) {
    return {
      content: [{ type: 'text', text: 'marker arg cannot be empty.' }],
      isError: true
    };
  }
  const dryRun = args.dry_run === true;

  const entries = readJsonl(filePath);
  const chain = walkChain(entries);

  if (chain.length === 0) {
    return {
      content: [{ type: 'text', text: 'Conversation chain is empty.' }],
      isError: true
    };
  }

  // Scan newest-first for the marker. Re-read full bodies from disk because
  // chain entries may be lightweight for files >50MB.
  let markerIdx = -1;
  for (let i = chain.length - 1; i >= 0; i--) {
    const full = readJsonlLine(filePath, chain[i].line);
    if (!full) continue;
    // getMessageContent expects the chain-entry shape { data: ... }
    const text = getMessageContent({ data: full });
    if (text && text.includes(marker)) {
      markerIdx = i;
      break;
    }
  }

  if (markerIdx === -1) {
    return {
      content: [{
        type: 'text',
        text: `No hand-off marker "${marker}" found in any chain message. Did the session write a hand-off? (See docs/handoff-template.md for the expected format.)`
      }],
      isError: true
    };
  }

  // Walk back from the marker to find the nearest user message — that becomes
  // the new chain root, so next session sees [user: prompt for handoff] →
  // [assistant: handoff] as its starting context.
  let anchorIdx = -1;
  let anchorEntry = null;
  let anchorFull = null;
  let anchorType = null;
  for (let i = markerIdx; i >= 0; i--) {
    const full = readJsonlLine(filePath, chain[i].line) || chain[i].data;
    const t = full?.type || chain[i].data.type;
    if (VALID_ROOT_TYPES.has(t)) {
      anchorIdx = i;
      anchorEntry = chain[i];
      anchorFull = full;
      anchorType = t;
      break;
    }
  }

  if (anchorIdx === -1) {
    return {
      content: [{
        type: 'text',
        text: `Found hand-off marker at chain index ${markerIdx}, but no user/system message exists at or before it to anchor as the new chain root.`
      }],
      isError: true
    };
  }

  const orphanedCount = anchorIdx;
  let orphanedTokens = 0;
  for (let i = 0; i < anchorIdx; i++) {
    orphanedTokens += estimateTokens(getMessageContent(chain[i]));
  }
  const keptCount = chain.length - anchorIdx;

  // Snippet of the hand-off (first ~400 chars after the marker) for the report.
  const markerFull = readJsonlLine(filePath, chain[markerIdx].line);
  const handoffText = getMessageContent({ data: markerFull }) || '';
  const markerOffset = handoffText.indexOf(marker);
  const snippet = handoffText
    .slice(markerOffset, markerOffset + 400)
    .replace(/\s+$/, '')
    + (handoffText.length - markerOffset > 400 ? '\n…(truncated)' : '');

  if (dryRun) {
    return {
      content: [{
        type: 'text',
        text: [
          `## Prune to Hand-off — DRY RUN`,
          ``,
          `**File**: \`${filePath}\``,
          `**Marker**: \`${marker}\` found at chain index ${markerIdx + 1} of ${chain.length}`,
          `**New chain root**: chain index ${anchorIdx + 1} (${anchorType})`,
          `**Would orphan**: ${orphanedCount} of ${chain.length} messages (~${orphanedTokens.toLocaleString()} tokens)`,
          `**Would keep**: ${keptCount} messages from anchor to leaf`,
          ``,
          `### Hand-off snippet`,
          `\`\`\``,
          snippet,
          `\`\`\``,
          ``,
          `Run again with \`dry_run: false\` (or omit) to apply.`
        ].join('\n')
      }]
    };
  }

  // Apply: set parentUuid:null on the anchor entry. rewriteLine handles the
  // race-guard + atomic tmp-rename internally.
  const newData = { ...anchorFull, parentUuid: null };
  rewriteLine(filePath, anchorEntry.line, newData);

  return {
    content: [{
      type: 'text',
      text: [
        `## Prune to Hand-off Complete`,
        ``,
        `**File**: \`${filePath}\``,
        `**Marker**: \`${marker}\` matched at chain index ${markerIdx + 1} of ${chain.length}`,
        `**New chain root**: chain index ${anchorIdx + 1} (${anchorType})`,
        `**Messages orphaned**: ${orphanedCount} (~${orphanedTokens.toLocaleString()} tokens freed)`,
        `**Messages remaining in chain**: ${keptCount}`,
        ``,
        `Orphans remain in the JSONL file (recoverable via inspect_pruned_messages or grep).`,
        `Context change takes effect on the next message (no restart needed).`,
        `CLAUDE.md is auto-loaded by Claude Code on every turn — no need for the hand-off to repeat it.`,
        ``,
        `### Hand-off snippet (now the chain root context)`,
        `\`\`\``,
        snippet,
        `\`\`\``
      ].join('\n')
    }]
  };
}
