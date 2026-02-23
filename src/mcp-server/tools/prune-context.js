/**
 * prune_context tool
 *
 * Trims conversation context by setting parentUuid:null on a target message.
 * Everything before that message becomes orphaned and invisible to Claude.
 * Works LIVE — no restart needed (Claude re-reads the chain on each message).
 *
 * Modes:
 * - before_message: trim before message N (1-indexed in chain)
 * - oldest_percent: trim the oldest N% of messages
 * - after_phrase: find a message containing a unique phrase, make it the new root
 */

import {
  findConversationFile,
  readJsonl,
  walkChain,
  rewriteLine,
  estimateTokens,
  getMessageContent
} from '../lib/jsonl.js';

export async function handlePruneContext(args) {
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

  let targetIndex; // Index into the chain array
  let targetEntry;

  if (args.mode === 'before_message') {
    if (!args.message_number || args.message_number < 1 || args.message_number > chain.length) {
      return {
        content: [{ type: 'text', text: `Invalid message_number: ${args.message_number}. Chain has ${chain.length} messages (1-indexed).` }],
        isError: true
      };
    }
    targetIndex = args.message_number - 1; // Convert to 0-indexed
    targetEntry = chain[targetIndex];

  } else if (args.mode === 'oldest_percent') {
    if (!args.percent || args.percent <= 0 || args.percent >= 100) {
      return {
        content: [{ type: 'text', text: `Invalid percent: ${args.percent}. Must be between 0 and 100 (exclusive).` }],
        isError: true
      };
    }
    targetIndex = Math.floor(chain.length * (args.percent / 100));
    if (targetIndex < 1) targetIndex = 1; // Don't orphan nothing
    if (targetIndex >= chain.length) targetIndex = chain.length - 1; // Keep at least the last message
    targetEntry = chain[targetIndex];

  } else if (args.mode === 'after_phrase') {
    if (!args.phrase) {
      return {
        content: [{ type: 'text', text: 'phrase is required for after_phrase mode.' }],
        isError: true
      };
    }
    const phrase = args.phrase.toLowerCase();
    // Search from oldest to newest, find the first message containing the phrase
    for (let i = 0; i < chain.length; i++) {
      const content = getMessageContent(chain[i]).toLowerCase();
      if (content.includes(phrase)) {
        targetIndex = i;
        targetEntry = chain[i];
        break;
      }
    }
    if (targetEntry === undefined) {
      return {
        content: [{ type: 'text', text: `No message found containing phrase: "${args.phrase}"` }],
        isError: true
      };
    }

  } else {
    return {
      content: [{ type: 'text', text: `Invalid mode: ${args.mode}. Use "before_message", "oldest_percent", or "after_phrase".` }],
      isError: true
    };
  }

  // Calculate what we're pruning
  const prunedMessages = targetIndex;
  let prunedTokens = 0;
  for (let i = 0; i < targetIndex; i++) {
    prunedTokens += estimateTokens(getMessageContent(chain[i]));
  }

  // Set parentUuid to null on the target message
  const newData = { ...targetEntry.data, parentUuid: null };
  rewriteLine(filePath, targetEntry.line, newData);

  const report = [
    `## Context Pruned`,
    ``,
    `**Mode**: ${args.mode}${args.mode === 'before_message' ? ` (message ${args.message_number})` : args.mode === 'oldest_percent' ? ` (${args.percent}%)` : ` (phrase: "${args.phrase}")`}`,
    `**Messages orphaned**: ${prunedMessages} of ${chain.length}`,
    `**Estimated tokens freed**: ~${prunedTokens.toLocaleString()}`,
    `**New chain root**: message ${targetIndex + 1} (${targetEntry.data.type})`,
    ``,
    `The pruned messages are orphaned but still in the file.`,
    `Context change takes effect on the next message (no restart needed).`,
  ].join('\n');

  return {
    content: [{ type: 'text', text: report }]
  };
}
