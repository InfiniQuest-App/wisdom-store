/**
 * Turn segmentation for Claude Code conversation chains.
 *
 * A "turn" = one user-typed prompt + the agent's response + any tool calls and
 * their results, ending just before the next user-typed prompt. Each turn is
 * the natural unit for analyze_for_archive_v2's per-turn classify+summarize pass.
 *
 * Boundary heuristic (validated against real claudeCode JSONLs):
 *   - A new turn starts at any chain entry of type "user" whose message.content
 *     is either a plain string OR an array containing at least one block that's
 *     NOT a tool_result (i.e., real user input, not tool-call follow-up).
 *   - Everything between two such boundaries belongs to the prior turn.
 *
 * Tool-result-only user messages don't open a new turn — they're the runtime's
 * way of feeding tool output back into the assistant within the SAME turn.
 *
 * For files >50MB, walkChain returns lightweight entries (uuid/parentUuid/type
 * /timestamp only). Pass a `readFullLine(filePath, lineIndex)` callback to
 * resolve the full message body when classifying boundaries.
 */

function isRealUserInput(fullEntry) {
  if (!fullEntry || fullEntry.type !== 'user') return false;
  const content = fullEntry.message?.content;
  if (typeof content === 'string') return true;
  if (Array.isArray(content)) {
    // Real user input has at least one non-tool_result block.
    for (const block of content) {
      if (typeof block === 'string') return true;
      if (block?.type && block.type !== 'tool_result') return true;
    }
    return false;
  }
  return false;
}

/**
 * @param {Array} chain - chain entries from walkChain (root → leaf order)
 * @param {(filePath: string, lineIndex: number) => object} readFullLine - resolves full line
 * @param {string} filePath - JSONL path (passed through to readFullLine)
 * @returns {Array<{turn_id, entries, first_uuid, last_uuid, start_timestamp, end_timestamp, has_real_user_input}>}
 */
export function segmentTurns(chain, readFullLine, filePath) {
  const turns = [];
  let current = null;

  for (const entry of chain) {
    const lightweightType = entry.data.type;
    let isBoundary = false;

    if (lightweightType === 'user') {
      // Need to re-read the full line to check whether this is real user input
      // or a tool_result-only follow-up.
      const full = readFullLine(filePath, entry.line) || entry.data;
      isBoundary = isRealUserInput(full);
    }

    if (isBoundary || current === null) {
      if (current) {
        current.last_uuid = current.entries[current.entries.length - 1].data.uuid;
        current.end_timestamp = current.entries[current.entries.length - 1].data.timestamp || null;
        turns.push(current);
      }
      current = {
        turn_id: turns.length + 1,
        entries: [entry],
        first_uuid: entry.data.uuid,
        last_uuid: entry.data.uuid,
        start_timestamp: entry.data.timestamp || null,
        end_timestamp: entry.data.timestamp || null,
        has_real_user_input: isBoundary
      };
    } else {
      current.entries.push(entry);
    }
  }

  if (current) {
    current.last_uuid = current.entries[current.entries.length - 1].data.uuid;
    current.end_timestamp = current.entries[current.entries.length - 1].data.timestamp || null;
    turns.push(current);
  }

  return turns;
}

export const TURN_SEGMENTER_INTERNALS = { isRealUserInput };
