/**
 * sandwich_prune tool
 *
 * Surgical pruning that preserves BOTH the start AND end of a conversation,
 * dropping the middle bloat. Better than `prune_context(oldest_percent)` for
 * long-running sessions where the original task brief (top) and recent working
 * state (bottom) both matter.
 *
 * Strategy:
 *   1. Walk the active chain from leaf back to root.
 *   2. Keep `keep_first_n` chain entries at the start (early/top bread).
 *   3. Keep `keep_recent_n` chain entries at the end (recent/bottom bread).
 *   4. Re-link: the first recent entry's parentUuid is rewritten to point to
 *      either an inserted bridge system message, or directly to the last early
 *      entry. Middle entries become orphaned (and optionally physically removed).
 *
 * Pairs with `inspect_pruned_messages` (when `remove_middle_orphans: false`)
 * for progressive disclosure of the dropped middle.
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import {
  findConversationFile,
  readJsonl,
  readJsonlLine,
  walkChain,
  estimateTokens,
  getMessageContent
} from '../lib/jsonl.js';

const VALID_ROOT_TYPES = new Set(['user', 'system']);

export async function handleSandwichPrune(args = {}) {
  const filePath = findConversationFile(args.conversation_id);
  if (!filePath) {
    return {
      content: [{ type: 'text', text: 'No conversation file found for this project.' }],
      isError: true
    };
  }

  const keepFirstN = Number.isInteger(args.keep_first_n) ? args.keep_first_n : 5;
  const keepRecentN = Number.isInteger(args.keep_recent_n) ? args.keep_recent_n : 50;
  const insertBridge = args.insert_bridge_placeholder !== false;
  const removeMiddleOrphans = args.remove_middle_orphans !== false;

  if (keepFirstN < 1 || keepRecentN < 1) {
    return {
      content: [{ type: 'text', text: `keep_first_n and keep_recent_n must each be >= 1 (got ${keepFirstN}, ${keepRecentN}). Use prune_context for one-sided trimming.` }],
      isError: true
    };
  }

  const sizeBefore = fs.statSync(filePath).size;
  const entries = readJsonl(filePath);
  const chain = walkChain(entries);

  if (chain.length === 0) {
    return {
      content: [{ type: 'text', text: 'Conversation chain is empty.' }],
      isError: true
    };
  }

  if (chain.length <= keepFirstN + keepRecentN) {
    return {
      content: [{
        type: 'text',
        text: [
          `## Sandwich Prune — NO-OP`,
          ``,
          `**File**: \`${filePath}\``,
          `Chain length is ${chain.length}, but \`keep_first_n\` (${keepFirstN}) + \`keep_recent_n\` (${keepRecentN}) = ${keepFirstN + keepRecentN}.`,
          `Nothing to prune from the middle.`
        ].join('\n')
      }]
    };
  }

  const earlySegment = chain.slice(0, keepFirstN);
  let recentStartIdx = chain.length - keepRecentN;

  // Validate first_recent type — Claude Code refuses to resume from a chain root
  // that isn't 'user' or 'system' (assistant messages can't be roots). If the
  // candidate first-recent entry is the wrong type, walk forward inside the recent
  // segment until we find a valid one. This shrinks the recent segment slightly
  // but guarantees a working chain.
  let firstRecent = chain[recentStartIdx];
  let firstRecentFull = readJsonlLine(filePath, firstRecent.line);
  let firstRecentType = firstRecentFull?.type || firstRecent.data.type;

  while (!VALID_ROOT_TYPES.has(firstRecentType) && recentStartIdx < chain.length - 1) {
    recentStartIdx++;
    firstRecent = chain[recentStartIdx];
    firstRecentFull = readJsonlLine(filePath, firstRecent.line);
    firstRecentType = firstRecentFull?.type || firstRecent.data.type;
  }

  if (!VALID_ROOT_TYPES.has(firstRecentType)) {
    return {
      content: [{ type: 'text', text: `No user/system entry found in the recent segment to anchor the new chain root. firstRecentType=${firstRecentType}` }],
      isError: true
    };
  }

  if (recentStartIdx <= keepFirstN) {
    return {
      content: [{
        type: 'text',
        text: `## Sandwich Prune — NO-OP\n\nAfter type-validation walk, recent segment boundary collapsed into early segment. Nothing to prune.`
      }]
    };
  }

  const lastEarly = earlySegment[earlySegment.length - 1];
  const recentSegment = chain.slice(recentStartIdx);
  const middleEntries = chain.slice(keepFirstN, recentStartIdx);

  // Re-read full lines for boundary entries (CRITICAL: walkChain returns lightweight
  // data for files >50MB — only uuid/parentUuid/type/timestamp. Spreading that subset
  // and writing it back would destroy the actual message body and all other content.)
  const fullLastEarly = readJsonlLine(filePath, lastEarly.line) || lastEarly.data;
  const fullFirstRecent = firstRecentFull || readJsonlLine(filePath, firstRecent.line) || firstRecent.data;

  // Build the optional bridge placeholder. Mirror per-entry metadata
  // (cwd/sessionId/version/gitBranch) from the last early entry so it slots into
  // the chain without looking foreign to Claude Code's reader.
  let bridgeEntry = null;
  if (insertBridge) {
    const bridgeMessage = args.bridge_message ||
      `[Conversation segment pruned for context. ${middleEntries.length} message(s) orphaned. See ${args.conversation_id || 'this'}.jsonl backup for full history.]`;
    const sessionId = fullLastEarly?.sessionId || filePath.match(/([a-f0-9-]+)\.jsonl$/)?.[1];
    bridgeEntry = {
      parentUuid: lastEarly.data.uuid,
      isSidechain: false,
      userType: 'external',
      cwd: fullLastEarly?.cwd || process.cwd(),
      sessionId,
      version: fullLastEarly?.version || '2.1.50',
      gitBranch: fullLastEarly?.gitBranch || '',
      type: 'system',
      message: {
        role: 'system',
        content: bridgeMessage
      },
      content: bridgeMessage,
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      _sandwichPruneBridge: true,
      _orphanedRange: {
        firstChainIdx: keepFirstN + 1,
        lastChainIdx: recentStartIdx,
        count: middleEntries.length
      }
    };
  }

  const newParentForFirstRecent = bridgeEntry ? bridgeEntry.uuid : lastEarly.data.uuid;
  const rewrittenFirstRecent = { ...fullFirstRecent, parentUuid: newParentForFirstRecent };

  // Single whole-file rewrite covers both modes. We unify rather than do
  // rewriteLine+appendLine for the orphan-keep mode because appendLine prepends
  // '\n' which (when the file ends with '\n') introduces a blank line — and the
  // lightweight reader uses raw line indices while readJsonlLine uses non-empty
  // count. A blank line desyncs them, breaking later inspection of the bridge.
  // Whole-file rewrite avoids the blank entirely.
  const middleUuids = removeMiddleOrphans
    ? new Set(middleEntries.map(e => e.data.uuid).filter(Boolean))
    : new Set();

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const outputLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    let parsed;
    try { parsed = JSON.parse(line); }
    catch { outputLines.push(line); continue; }

    const u = parsed.uuid;
    if (u && middleUuids.has(u)) continue;
    if (u && u === firstRecent.data.uuid) {
      outputLines.push(JSON.stringify(rewrittenFirstRecent));
      continue;
    }
    outputLines.push(line);
  }

  if (bridgeEntry) outputLines.push(JSON.stringify(bridgeEntry));

  // Race guard: a live writer (Claude Code appending) could have grown the file
  // since we opened it. Refuse rather than clobber appended messages.
  const sizeNow = fs.statSync(filePath).size;
  if (sizeNow !== sizeBefore) {
    throw new Error(
      `sandwich_prune: file ${filePath} was modified concurrently ` +
      `(size ${sizeBefore} → ${sizeNow}). Aborting to avoid overwriting writer's data. Retry the prune.`
    );
  }

  const tmpPath = filePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmpPath, outputLines.join('\n') + '\n');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw e;
  }

  const sizeAfter = fs.statSync(filePath).size;

  let tokensRemoved = 0;
  for (const e of middleEntries) {
    tokensRemoved += estimateTokens(getMessageContent(e));
  }

  const newChainLength = keepFirstN + (bridgeEntry ? 1 : 0) + recentSegment.length;

  const report = [
    `## Sandwich Prune Complete`,
    ``,
    `**File**: \`${filePath}\``,
    `**Original chain length**: ${chain.length}`,
    `**New chain length**: ${newChainLength} (${keepFirstN} early + ${bridgeEntry ? '1 bridge + ' : ''}${recentSegment.length} recent)`,
    `**Middle messages orphaned**: ${middleEntries.length}`,
    `**Estimated tokens freed (chain content)**: ~${tokensRemoved.toLocaleString()}`,
    `**File size**: ${(sizeBefore / 1024).toFixed(0)} KB → ${(sizeAfter / 1024).toFixed(0)} KB`,
    `**Bridge entry uuid**: ${bridgeEntry ? bridgeEntry.uuid : '(none — direct re-link)'}`,
    `**Orphaned chain range**: messages ${keepFirstN + 1}–${recentStartIdx} (1-indexed in original chain)`,
    `**Middle physically removed**: ${removeMiddleOrphans ? 'yes' : 'no — orphaned entries still in file'}`,
    ``,
    removeMiddleOrphans
      ? `Middle entries are gone from disk. Restore is not possible from this file.`
      : `Use \`inspect_pruned_messages\` with the same conversation_id to view orphaned content.`,
    `Context change takes effect on the next message (no restart needed).`,
  ].join('\n');

  return {
    content: [{ type: 'text', text: report }]
  };
}
