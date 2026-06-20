/**
 * context_status tool
 *
 * Reports context usage for the current conversation:
 * - Message count (in active chain)
 * - Total messages in file (including orphaned)
 * - Estimated token usage
 * - Chain depth breakdown (user/assistant/tool messages)
 * - Bloat indicators
 */

import fs from 'fs';
import {
  findConversationFile,
  readJsonl,
  readJsonlLine,
  walkChain,
  estimateTokens,
  getMessageContent
} from '../lib/jsonl.js';

export async function handleContextStatus(args) {
  const filePath = findConversationFile(args.conversation_id);
  if (!filePath) {
    return {
      content: [{ type: 'text', text: 'No conversation file found for this project.' }],
      isError: true
    };
  }

  const fileSize = fs.statSync(filePath).size;
  const isLarge = fileSize > 50 * 1024 * 1024;

  // Use lightweight mode for chain walking on large files
  const entries = readJsonl(filePath, { lightweight: isLarge });
  const chain = walkChain(entries);

  // Count message types in the active chain
  let userMessages = 0;
  let assistantMessages = 0;
  let toolMessages = 0;
  let otherMessages = 0;
  let totalTokens = 0;
  let thinkingTokens = 0;

  for (const entry of chain) {
    const type = entry.data.type;
    if (type === 'user') userMessages++;
    else if (type === 'assistant') assistantMessages++;
    else if (type === 'tool_result' || type === 'tool_use') toolMessages++;
    else otherMessages++;

    // For token estimation on large files, selectively parse chain messages
    if (isLarge) {
      // Use raw line length as rough token proxy (avoids full JSON parse)
      const lineLen = entry.rawLine ? entry.rawLine.length : 0;
      totalTokens += Math.ceil(lineLen / 4);
    } else {
      const content = getMessageContent(entry);
      totalTokens += estimateTokens(content);

      // Count thinking tokens separately
      if (entry.data.message && Array.isArray(entry.data.message.content)) {
        for (const block of entry.data.message.content) {
          if (block.type === 'thinking') {
            thinkingTokens += estimateTokens(block.thinking || '');
          }
        }
      }
    }
  }

  const orphanedMessages = entries.length - chain.length;
  const conversationId = filePath.match(/([a-f0-9-]+)\.jsonl$/)?.[1] || 'unknown';

  // Estimate context usage (rough: 200k token window)
  const contextWindow = 200000;
  const usagePercent = Math.min(100, Math.round((totalTokens / contextWindow) * 100));

  // Bloat detection
  const bloatIndicators = [];
  if (orphanedMessages > 10) {
    bloatIndicators.push(`${orphanedMessages} orphaned messages (can be pruned from file)`);
  }
  if (!isLarge && thinkingTokens > totalTokens * 0.3) {
    bloatIndicators.push(`Thinking blocks are ${Math.round((thinkingTokens / totalTokens) * 100)}% of context`);
  }
  if (userMessages > 0 && toolMessages / userMessages > 10) {
    bloatIndicators.push(`High tool message ratio (${toolMessages} tool vs ${userMessages} user)`);
  }

  const report = [
    `## Context Status`,
    ``,
    `**Conversation**: \`${conversationId}\``,
    `**File size**: ${(fileSize / 1024 / 1024).toFixed(1)} MB`,
    isLarge ? `*(large file — using lightweight parsing)*` : '',
    ``,
    `### Active Chain`,
    `- **Total messages**: ${chain.length}`,
    `- **User messages**: ${userMessages}`,
    `- **Assistant messages**: ${assistantMessages}`,
    `- **Tool messages**: ${toolMessages}`,
    otherMessages > 0 ? `- **Other**: ${otherMessages}` : '',
    ``,
    `### Token Estimate`,
    `- **Estimated tokens**: ~${totalTokens.toLocaleString()}${isLarge ? ' (rough — from line length)' : ''}`,
    !isLarge ? `- **Thinking tokens**: ~${thinkingTokens.toLocaleString()} (${totalTokens > 0 ? Math.round((thinkingTokens / totalTokens) * 100) : 0}%)` : '',
    `- **Context usage**: ~${usagePercent}% of 200k window`,
    ``,
    `### File Health`,
    `- **Total lines in file**: ${entries.length}`,
    `- **Orphaned messages**: ${orphanedMessages}`,
    bloatIndicators.length > 0
      ? `\n### Bloat Indicators\n${bloatIndicators.map(b => `- ⚠️ ${b}`).join('\n')}`
      : '- No bloat detected',
  ].filter(Boolean).join('\n');

  return {
    content: [{ type: 'text', text: report }]
  };
}
