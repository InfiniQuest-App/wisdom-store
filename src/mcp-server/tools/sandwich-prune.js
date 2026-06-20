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
 *   4. Write the dropped middle to a timestamped sidecar backup file
 *      (`<conversation>.middle-backup-<unixSec>.jsonl`) — full reversibility.
 *   5. Re-link: the first recent entry's parentUuid is rewritten to point to
 *      either an inserted bridge system message, or directly to the last early
 *      entry. Middle entries become orphaned (and optionally physically removed).
 *
 * The default bridge message leads with the backup FILENAME (durable across
 * path changes) and includes the absolute path as a hint plus the message
 * count and timestamp range — anyone reading the conversation later can
 * grep/find the filename to recover the dropped content.
 *
 * Pairs with `inspect_pruned_messages` (when `remove_middle_orphans: false`)
 * for progressive disclosure of the dropped middle from the live file.
 *
 * Determinism note: when the JSONL has multiple leaves (from prior prunes,
 * branches, or sidechains), `walkChain` picks the leaf with the latest
 * `timestamp`. So "the active chain" is always the most-recently-written
 * branch — this tool inherits that rule and operates on whichever chain
 * `walkChain` selects. If you need to prune a non-latest branch, you'll
 * need to manipulate the chain selection upstream first.
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  findConversationFile,
  readJsonl,
  readJsonlLine,
  walkChain,
  estimateTokens,
  getMessageContent
} from '../lib/jsonl.js';

const VALID_ROOT_TYPES = new Set(['user', 'system']);

function fmtTs(ts) {
  if (!ts || typeof ts !== 'string') return '?';
  return ts.slice(0, 16).replace('T', ' ');
}

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
  // segment until we find a valid one.
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

  // Single file scan: collect outputLines (rewrite target) AND a uuid→raw-line
  // map for middle entries (so we can assemble the backup in chain order without
  // N additional file reads).
  const middleUuids = new Set(middleEntries.map(e => e.data.uuid).filter(Boolean));
  const middleLineByUuid = new Map();
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
    if (u && middleUuids.has(u)) {
      middleLineByUuid.set(u, line);
      if (removeMiddleOrphans) continue;
      outputLines.push(line);
      continue;
    }
    if (u && u === firstRecent.data.uuid) {
      outputLines.push(JSON.stringify({ ...fullFirstRecent }));  // placeholder; rewritten below
      continue;
    }
    outputLines.push(line);
  }

  // Build backup content in CHAIN order (file order may not match after prior prunes/branches).
  const backupOrderedLines = [];
  for (const e of middleEntries) {
    const line = middleLineByUuid.get(e.data.uuid);
    if (line) backupOrderedLines.push(line);
  }

  // Backup file path: timestamped sidecar next to the conversation file.
  // Each invocation gets a fresh second-granularity timestamp; if two prunes land in
  // the same second we append a short suffix to avoid clobbering an existing backup.
  const unixSec = Math.floor(Date.now() / 1000);
  let backupPath = `${filePath}.middle-backup-${unixSec}.jsonl`;
  if (fs.existsSync(backupPath)) {
    backupPath = `${filePath}.middle-backup-${unixSec}-${process.pid}.jsonl`;
  }
  const backupFilename = path.basename(backupPath);
  const backupDir = path.dirname(backupPath);

  // Compute timestamp range of dropped segment for the bridge message.
  const firstMiddleTs = fmtTs(middleEntries[0]?.data.timestamp);
  const lastMiddleTs = fmtTs(middleEntries[middleEntries.length - 1]?.data.timestamp);

  // Build optional bridge placeholder. Default message leads with the backup FILENAME
  // (durable across path changes — someone can `find` it 6 months from now), with
  // the absolute path as a hint and the segment metadata for at-a-glance context.
  let bridgeEntry = null;
  if (insertBridge) {
    const bridgeMessage = args.bridge_message ||
      `[Pruned segment: ${middleEntries.length} messages, ${firstMiddleTs} → ${lastMiddleTs}. ` +
      `Backup file: ${backupFilename}. Located at: ${backupDir} (path may have moved).]`;
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
      _backupFile: backupFilename,
      _backupPath: backupPath,
      _orphanedRange: {
        firstChainIdx: keepFirstN + 1,
        lastChainIdx: recentStartIdx,
        count: middleEntries.length,
        firstTimestamp: middleEntries[0]?.data.timestamp,
        lastTimestamp: middleEntries[middleEntries.length - 1]?.data.timestamp
      }
    };
  }

  // Now that we have the bridge uuid, finalize first_recent's new parentUuid and
  // patch the placeholder we wrote into outputLines during the scan.
  const newParentForFirstRecent = bridgeEntry ? bridgeEntry.uuid : lastEarly.data.uuid;
  const rewrittenFirstRecent = { ...fullFirstRecent, parentUuid: newParentForFirstRecent };
  for (let i = 0; i < outputLines.length; i++) {
    let parsed;
    try { parsed = JSON.parse(outputLines[i]); } catch { continue; }
    if (parsed.uuid === firstRecent.data.uuid) {
      outputLines[i] = JSON.stringify(rewrittenFirstRecent);
      break;
    }
  }
  if (bridgeEntry) outputLines.push(JSON.stringify(bridgeEntry));

  // Write backup FIRST. If main rewrite fails, the backup is harmlessly present.
  // Backup files are themselves valid JSONL and can be inspected directly.
  fs.writeFileSync(backupPath, backupOrderedLines.join('\n') + (backupOrderedLines.length ? '\n' : ''));

  // Race guard: a live writer (Claude Code appending) could have grown the file
  // since we opened it. Refuse rather than clobber appended messages. (Backup
  // already written but is harmless — caller can retry.)
  //
  // Pattern (size-based race guard + atomic tmp+rename) mirrors prune_context.js
  // and lib/jsonl.js's rewriteLine — if you fix one, fix all.
  // TODO: extract a shared rewriteJsonl({drop, replace, append}) utility so
  // these tools (and any future ones) share one tested implementation.
  const sizeNow = fs.statSync(filePath).size;
  if (sizeNow !== sizeBefore) {
    throw new Error(
      `sandwich_prune: file ${filePath} was modified concurrently ` +
      `(size ${sizeBefore} → ${sizeNow}). Aborting to avoid overwriting writer's data. ` +
      `Backup at ${backupPath} is intact. Retry the prune.`
    );
  }

  // Atomic main-file rewrite via tmp + rename.
  const tmpPath = filePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmpPath, outputLines.join('\n') + '\n');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw e;
  }

  const sizeAfter = fs.statSync(filePath).size;
  const backupSize = fs.statSync(backupPath).size;

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
    `**Middle backup**: \`${backupPath}\` (${middleEntries.length} entries, ${(backupSize / 1024).toFixed(0)} KB)`,
    `**Bridge entry uuid**: ${bridgeEntry ? bridgeEntry.uuid : '(none — direct re-link)'}`,
    `**Orphaned chain range**: messages ${keepFirstN + 1}–${recentStartIdx} (1-indexed in original chain)`,
    `**Timestamp range orphaned**: ${firstMiddleTs} → ${lastMiddleTs}`,
    `**Middle physically removed from live file**: ${removeMiddleOrphans ? 'yes' : 'no — still in live file as orphans (also in backup)'}`,
    ``,
    `Recovery: the backup file is itself valid JSONL and can be inspected/replayed directly.`,
    `Use \`inspect_pruned_messages\` against the live file (only if \`remove_middle_orphans: false\`).`,
    `Context change takes effect on the next message (no restart needed).`,
  ].join('\n');

  return {
    content: [{ type: 'text', text: report }]
  };
}
