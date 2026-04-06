/**
 * restore_context tool (uncompact)
 *
 * Reverses a compaction by re-linking the pre-compact message chain.
 * The compact summary is orphaned and the full conversation history is restored.
 *
 * Strategy:
 * 1. Find the compact_boundary message (has subtype: "compact_boundary" or isCompactSummary)
 * 2. Find the logicalParentUuid on the boundary (points to last pre-compact message)
 * 3. Find the first message AFTER the summary (the one the user/Claude sent post-compact)
 * 4. Reparent that message to the logicalParentUuid
 * 5. Orphan the compact_boundary and summary by setting their parentUuid to a dead ref
 *
 * If no messages exist after the summary, we need to send a throwaway message first.
 * The dashboard integration handles that via tmux.
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

export async function handleRestoreContext(args) {
  const filePath = findConversationFile(args.conversation_id);
  if (!filePath) {
    return {
      content: [{ type: 'text', text: 'No conversation file found for this project.' }],
      isError: true
    };
  }

  const entries = readJsonl(filePath);
  const chain = walkChain(entries);

  if (chain.length === 0) {
    return {
      content: [{ type: 'text', text: 'Conversation chain is empty.' }],
      isError: true
    };
  }

  // Find the compact boundary and summary in the current chain
  let boundaryIdx = -1;
  let summaryIdx = -1;
  let logicalParentUuid = null;

  for (let i = 0; i < chain.length; i++) {
    const d = chain[i].data;

    // Compact boundary: has subtype "compact_boundary" or type "system" with "Conversation compacted"
    if (d.subtype === 'compact_boundary' ||
        (d.type === 'system' && d.content === 'Conversation compacted')) {
      boundaryIdx = i;
      logicalParentUuid = d.logicalParentUuid || null;
    }

    // Compact summary: has isCompactSummary flag or content starts with "This session is being continued"
    if (d.isCompactSummary === true ||
        (d.type === 'user' && typeof d.message?.content === 'string' &&
         d.message.content.startsWith('This session is being continued'))) {
      summaryIdx = i;
    }
  }

  if (boundaryIdx === -1 && summaryIdx === -1) {
    return {
      content: [{ type: 'text', text: 'No compaction found in the current conversation chain. Nothing to restore.' }]
    };
  }

  // The compact point is whichever we found (boundary is before summary)
  const compactStartIdx = boundaryIdx >= 0 ? boundaryIdx : summaryIdx;
  const compactEndIdx = summaryIdx >= 0 ? summaryIdx : boundaryIdx;

  // We need logicalParentUuid to know where to reconnect
  if (!logicalParentUuid) {
    // Try to find it from the boundary message's full data
    if (boundaryIdx >= 0) {
      const fullData = readJsonlLine(filePath, chain[boundaryIdx].line);
      if (fullData) logicalParentUuid = fullData.logicalParentUuid;
    }
  }

  if (!logicalParentUuid) {
    return {
      content: [{ type: 'text', text: 'Cannot restore: compact boundary has no logicalParentUuid — the link to the pre-compact chain is missing.' }],
      isError: true
    };
  }

  // Verify the logical parent exists in the file (it should be orphaned but still present)
  const logicalParentEntry = entries.find(e => e.data.uuid === logicalParentUuid);
  if (!logicalParentEntry) {
    return {
      content: [{ type: 'text', text: `Cannot restore: the pre-compact message ${logicalParentUuid} is not in the JSONL file (may have been pruned).` }],
      isError: true
    };
  }

  // Find the first message AFTER the compact summary
  const firstPostCompactIdx = compactEndIdx + 1;

  if (firstPostCompactIdx >= chain.length) {
    // No messages after the summary — caller needs to send one first
    return {
      content: [{
        type: 'text',
        text: `⚠️ No messages exist after the compact summary. To restore:\n` +
          `1. Send any message to the session (e.g. "stand by")\n` +
          `2. Wait for Claude to respond\n` +
          `3. Call restore_context again\n\n` +
          `Or use the dashboard button which handles this automatically.\n\n` +
          `Compact summary is at chain position ${compactEndIdx + 1}/${chain.length}\n` +
          `Pre-compact chain target: ${logicalParentUuid.slice(0, 8)}...`
      }]
    };
  }

  // Reparent the first post-compact message to the pre-compact chain
  const firstPostCompact = chain[firstPostCompactIdx];
  const fullPostData = readJsonlLine(filePath, firstPostCompact.line);
  if (!fullPostData) {
    return {
      content: [{ type: 'text', text: 'Failed to read the post-compact message.' }],
      isError: true
    };
  }

  // Rewrite: point post-compact message to the pre-compact parent
  const newPostData = { ...fullPostData, parentUuid: logicalParentUuid };
  rewriteLine(filePath, firstPostCompact.line, newPostData);

  // Orphan the compact boundary and summary by breaking them out of the chain
  // Set boundary's parentUuid to null (it may already be) and summary's parent to a dead ref
  if (boundaryIdx >= 0) {
    const fullBoundary = readJsonlLine(filePath, chain[boundaryIdx].line);
    if (fullBoundary) {
      rewriteLine(filePath, chain[boundaryIdx].line, {
        ...fullBoundary,
        parentUuid: null,
        _orphanedByRestore: true
      });
    }
  }

  // Count what was restored
  // Walk back from logicalParentUuid to see how many messages are in the old chain
  const byUuid = new Map(entries.map(e => [e.data.uuid, e]));
  let restoredCount = 0;
  let cur = logicalParentEntry;
  while (cur) {
    restoredCount++;
    if (!cur.data.parentUuid) break;
    cur = byUuid.get(cur.data.parentUuid) || null;
  }

  // Estimate tokens restored
  let restoredTokens = 0;
  cur = logicalParentEntry;
  const visited = new Set();
  while (cur && !visited.has(cur.data.uuid)) {
    visited.add(cur.data.uuid);
    const content = getMessageContent(cur);
    restoredTokens += estimateTokens(content);
    if (!cur.data.parentUuid) break;
    cur = byUuid.get(cur.data.parentUuid) || null;
  }

  return {
    content: [{
      type: 'text',
      text: `✅ Context restored! Full conversation history re-linked.\n\n` +
        `• Restored ${restoredCount} messages (~${Math.round(restoredTokens / 1000)}k tokens)\n` +
        `• Compact summary orphaned (still in file for reference)\n` +
        `• Re-linked at: ${logicalParentUuid.slice(0, 8)}... → ${firstPostCompact.data.uuid.slice(0, 8)}...\n\n` +
        `The change takes effect on Claude's next message (no restart needed).`
    }]
  };
}
