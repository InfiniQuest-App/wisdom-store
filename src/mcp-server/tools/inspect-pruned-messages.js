/**
 * inspect_pruned_messages tool
 *
 * Companion to prune_context. After a prune, the orphaned messages are still in
 * the JSONL file (parentUuid:null on the new root means Claude doesn't see them,
 * but they're physically there). This tool lets the caller progressively reveal
 * any segment of that orphaned content — useful when prune_context's structural
 * summary mentions something interesting and you want to see the actual messages.
 *
 * Two modes:
 *   - segment_id: 1-indexed segment number from the prune_context response,
 *     200 messages per segment by default (matches the summarizer)
 *   - message_range: explicit [start, end] 1-indexed message numbers
 */

import fs from 'fs';
import { findConversationFile, getMessageContent } from '../lib/jsonl.js';
import { assignTurnIds, summarizeTurn, formatTurnSummary } from '../lib/orphan-summarizer.js';

const DEFAULT_SEGMENT_SIZE = 200;
const MAX_OUTPUT_MESSAGES = 100; // safety cap

function formatMessage(msg, idx) {
  const role = msg?.message?.role || msg?.type || 'unknown';
  const ts = msg.timestamp ? ` [${msg.timestamp.slice(0, 19).replace('T', ' ')}]` : '';
  // getMessageContent expects the {data: ...} entry wrapper, not the raw message data
  const text = (getMessageContent({ data: msg }) || '').trim();

  // Tool uses
  const toolBlocks = [];
  const content = msg?.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'tool_use') {
        const fp = block.input?.file_path ? ` ${block.input.file_path}` : '';
        const cmd = block.input?.command ? ` \`${String(block.input.command).split('\n')[0].slice(0, 80)}\`` : '';
        const desc = block.input?.description ? ` (${String(block.input.description).slice(0, 60)})` : '';
        toolBlocks.push(`  🔧 ${block.name}${fp}${cmd}${desc}`);
      }
    }
  }

  const textOneLine = text.split('\n')[0].slice(0, 200);
  const more = text.split('\n').length > 1 || text.length > 200 ? ` … (+${text.split('\n').length - 1} more lines)` : '';
  const lines = [`**[${idx}] ${role}**${ts}`];
  if (textOneLine) lines.push(`  ${textOneLine}${more}`);
  if (toolBlocks.length > 0) lines.push(...toolBlocks);
  return lines.join('\n');
}

export async function handleInspectPrunedMessages(args) {
  const filePath = findConversationFile(args.conversation_id);
  if (!filePath) {
    return {
      content: [{ type: 'text', text: 'No conversation file found.' }],
      isError: true
    };
  }

  // Read the full file directly (readJsonl auto-degrades to lightweight mode for
  // files >50MB, which strips the message body we want to inspect). One-shot read +
  // parse only the lines we'll actually need is acceptable for an interactive tool.
  const content = fs.readFileSync(filePath, 'utf8');
  const allLines = content.split('\n');
  const messages = [];
  for (const line of allLines) {
    if (!line.trim()) continue;
    try {
      const data = JSON.parse(line);
      if (data?.uuid !== undefined) messages.push({ data });
    } catch (_) { /* skip malformed */ }
  }

  // Determine the message range to return. Four modes, in priority order:
  //   message_range  → explicit [start, end] message indices
  //   segment_id     → standard 200-message chunks (matches summarizer)
  //   turn_range     → [N, M] turn IDs → message indices spanning all messages in those turns
  //   turn_id        → single turn N → message indices for just that turn
  let start, end;
  if (args.message_range && Array.isArray(args.message_range) && args.message_range.length === 2) {
    [start, end] = args.message_range;
    if (start < 1 || end < start) {
      return {
        content: [{ type: 'text', text: `Invalid message_range: [${start}, ${end}]. Expected [start, end] both >= 1, end >= start.` }],
        isError: true
      };
    }
  } else if (args.segment_id) {
    const segSize = args.segment_size || DEFAULT_SEGMENT_SIZE;
    start = (args.segment_id - 1) * segSize + 1;
    end = args.segment_id * segSize;
  } else if (args.turn_range || args.turn_id !== undefined) {
    // Resolve turn IDs to message indices via assignTurnIds across the full message array
    const rawMessages = messages.map(m => m.data);
    const turnIds = assignTurnIds(rawMessages);

    // turn_id branch has 4 sub-modes — defaults to lightweight turn summary
    if (args.turn_id !== undefined && !args.turn_range) {
      const turnId = args.turn_id;
      if (turnId < 1) {
        return {
          content: [{ type: 'text', text: `Invalid turn_id: ${turnId}. Must be >= 1.` }],
          isError: true
        };
      }

      // Need the turn summary to resolve action_id / action_range, OR to return as default
      const turnSummary = summarizeTurn(rawMessages, turnIds, turnId);
      if (!turnSummary) {
        return {
          content: [{ type: 'text', text: `Turn ${turnId} not found. Conversation has ${Math.max(...turnIds, 0)} real user turns.` }],
          isError: true
        };
      }

      if (args.action_id !== undefined || args.action_range) {
        // Drill into specific action(s) within the turn — return raw messages for that range
        let firstAction, lastAction;
        if (args.action_range && Array.isArray(args.action_range) && args.action_range.length === 2) {
          [firstAction, lastAction] = args.action_range;
        } else {
          firstAction = lastAction = args.action_id;
        }
        const totalActions = turnSummary.actions.length;
        if (firstAction < 1 || firstAction > totalActions || lastAction < firstAction || lastAction > totalActions) {
          return {
            content: [{ type: 'text', text: `Invalid action range [${firstAction}, ${lastAction}]. Turn ${turnId} has ${totalActions} actions (1-indexed).` }],
            isError: true
          };
        }
        // Resolve to message indices via the action's msg_index
        start = turnSummary.actions[firstAction - 1].msg_index;
        end = turnSummary.actions[lastAction - 1].msg_index;
      } else if (args.full === true) {
        // Return all raw messages in the turn
        let firstIdx = -1, lastIdx = -1;
        for (let i = 0; i < turnIds.length; i++) {
          if (turnIds[i] === turnId) {
            if (firstIdx === -1) firstIdx = i;
            lastIdx = i;
          }
        }
        start = firstIdx + 1;
        end = lastIdx + 1;
      } else {
        // Default for turn_id: return the lightweight turn summary
        return {
          content: [{ type: 'text', text: formatTurnSummary(turnSummary, args.conversation_id) }]
        };
      }
    } else {
      // turn_range branch — multiple turns, no action sub-selection
      const [firstTurn, lastTurn] = args.turn_range;
      if (firstTurn < 1 || lastTurn < firstTurn) {
        return {
          content: [{ type: 'text', text: `Invalid turn_range: [${firstTurn}, ${lastTurn}]. Expected [start, end] both >= 1, end >= start.` }],
          isError: true
        };
      }
      let startIdx = -1, endIdx = -1;
      for (let i = 0; i < turnIds.length; i++) {
        if (turnIds[i] >= firstTurn && turnIds[i] <= lastTurn) {
          if (startIdx === -1) startIdx = i;
          endIdx = i;
        }
      }
      if (startIdx === -1) {
        return {
          content: [{ type: 'text', text: `No messages found for turns ${firstTurn}–${lastTurn}. Conversation has ${Math.max(...turnIds, 0)} real user turns.` }],
          isError: true
        };
      }
      start = startIdx + 1;
      end = endIdx + 1;
    }
  } else {
    return {
      content: [{ type: 'text', text: 'Provide one of: segment_id, message_range [start, end], turn_id, or turn_range [start, end].' }],
      isError: true
    };
  }

  // Clamp to actual range
  if (end > messages.length) end = messages.length;
  if (start > messages.length) {
    return {
      content: [{ type: 'text', text: `Out of range: requested message ${start} but conversation only has ${messages.length} messages total.` }],
      isError: true
    };
  }

  const slice = messages.slice(start - 1, end);
  if (slice.length > MAX_OUTPUT_MESSAGES) {
    return {
      content: [{ type: 'text', text: `Range too large: ${slice.length} messages requested, max is ${MAX_OUTPUT_MESSAGES}. Use a narrower message_range.` }],
      isError: true
    };
  }

  const header = `## Inspecting messages ${start}–${end} (${slice.length} of ${messages.length} total)`;
  const body = slice.map((m, i) => formatMessage(m.data, start + i)).join('\n\n');
  return {
    content: [{ type: 'text', text: `${header}\n\n${body}` }]
  };
}
