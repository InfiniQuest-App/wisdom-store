/**
 * condense_jsonl_blocks tool — heuristic per-block condenser.
 *
 * Companion / pre-pass to analyze_for_archive_v2. Operates per-block (within
 * a chain entry) rather than per-turn, so it can drop e.g. a 200KB base64
 * screenshot inside an otherwise-load-bearing decision turn without losing
 * the decision content. Zero LLM calls, zero rate-limit risk, fully reversible.
 *
 * Three heuristic modes (all run by default; opt out via `modes` arg):
 *   - "images":         base64 image data in tool_results → marker
 *   - "memory-reads":   older reads of memory-style files → marker
 *   - "identical-reads": older reads of any path with byte-identical content → marker
 *
 * Safety:
 *   - dry_run:true (default false) reports what would change without mutating
 *   - Backup written to .condense-backups/<convId>.<epoch>.jsonl before any
 *     mutation; last 3 retained (matches sandwich_prune backup convention)
 *   - Atomic via shared rewriteJsonl utility (race-guard + tmp+rename)
 *   - Idempotent: running twice produces no additional changes (markers
 *     don't re-match the heuristics)
 */

import fs from 'fs';
import path from 'path';
import {
  findConversationFile,
  readJsonl,
  walkChain,
  readJsonlLine
} from '../lib/jsonl.js';
import { rewriteJsonl } from '../lib/jsonl-mutate.js';
import { buildCondensePlan, findMatchingV2Plan } from '../lib/jsonl-condense.js';
import { segmentTurns } from '../lib/turn-segmenter.js';
import { loadCondenseMeta, saveCondenseMeta, markBlockCondensed, summarizeMeta } from '../lib/condense-meta.js';

const VALID_MODES = new Set(['images', 'memory-reads', 'identical-reads', 'thinking', 'stale-reads', 'mcp-snapshots', 'refetch-markers', 'tool-args']);
const BACKUP_RETENTION = 3;

function pruneOldBackups(backupDir, convId) {
  let backups;
  try {
    backups = fs.readdirSync(backupDir)
      .filter(f => f.startsWith(`${convId}.`) && f.endsWith('.jsonl'))
      .map(f => ({ name: f, full: path.join(backupDir, f), mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
  if (backups.length <= BACKUP_RETENTION) return [];
  const toDelete = backups.slice(BACKUP_RETENTION);
  for (const b of toDelete) {
    try { fs.unlinkSync(b.full); } catch {}
  }
  return toDelete.map(b => b.name);
}

export async function handleCondenseJsonlBlocks(args = {}) {
  // Explicit path overrides UUID-based lookup. Useful for testing on a copy
  // (where multiple files share the same UUID across directories — the lookup
  // would silently pick the most-recently-modified, which can be the wrong file).
  let filePath;
  if (args.jsonl_path) {
    if (!require('fs').existsSync(args.jsonl_path)) {
      return { content: [{ type: 'text', text: `jsonl_path does not exist: ${args.jsonl_path}` }], isError: true };
    }
    filePath = args.jsonl_path;
  } else {
    filePath = findConversationFile(args.conversation_id);
    if (!filePath) {
      return { content: [{ type: 'text', text: 'No conversation file found.' }], isError: true };
    }
  }

  const dryRun = args.dry_run === true;
  let modes;
  if (Array.isArray(args.modes) && args.modes.length) {
    const invalid = args.modes.filter(m => !VALID_MODES.has(m));
    if (invalid.length) {
      return { content: [{ type: 'text', text: `Invalid modes: ${invalid.join(', ')}. Valid: ${[...VALID_MODES].join(', ')}.` }], isError: true };
    }
    modes = args.modes;
  } else {
    modes = [...VALID_MODES];  // default: all modes (including thinking)
  }

  const sizeBefore = fs.statSync(filePath).size;
  const entries = readJsonl(filePath);
  const chain = walkChain(entries);
  if (chain.length === 0) {
    return { content: [{ type: 'text', text: 'Conversation chain is empty.' }], isError: true };
  }

  // Resolve full entries (handles >50MB lightweight reader case).
  const chainFullEntries = chain.map(e => ({
    uuid: e.data.uuid,
    fullEntry: readJsonlLine(filePath, e.line) || e.data
  }));

  // For "thinking" mode, build turn segmentation + look up most recent v2 plan.
  let extraOpts = {};
  let planUsed = null;
  let usingThinkingFallback = false;
  if (modes.includes('thinking') || modes.includes('refetch-markers') || modes.includes('tool-args')) {
    const turns = segmentTurns(chain, readJsonlLine, filePath);
    const turnsByEntryUuid = new Map();
    for (const t of turns) {
      for (const e of t.entries) {
        if (e.data.uuid) turnsByEntryUuid.set(e.data.uuid, { turn_id: t.turn_id, totalTurns: turns.length });
      }
    }
    const lastUuid = chain[chain.length - 1].data.uuid;
    planUsed = findMatchingV2Plan(filePath, chain.length, lastUuid);
    usingThinkingFallback = !planUsed;
    extraOpts = { plan: planUsed, turnsByEntryUuid, totalTurns: turns.length, thinkingMarkerStyle: args.thinking_marker_style || 'minimal', keepRecentTurns: args.keep_recent_turns };
  }

  const sidecar = loadCondenseMeta(filePath);
  const { replace, stats } = buildCondensePlan(chainFullEntries, { modes, ...extraOpts, sidecar });
  const totalCondensed = stats.imagesCondensed + stats.memoryReadsCondensed + stats.identicalReadsCondensed + (stats.thinkingCondensed || 0) + (stats.staleReadsCondensed || 0) + (stats.mcpSnapshotsCondensed || 0) + (stats.refetchMarkersCondensed || 0) + (stats.toolArgsCondensed || 0);
  const totalBytesSaved = stats.imagesBytesSaved + stats.memoryReadsBytesSaved + stats.identicalReadsBytesSaved + (stats.thinkingBytesSaved || 0) + (stats.staleReadsBytesSaved || 0) + (stats.mcpSnapshotsBytesSaved || 0) + (stats.refetchMarkersBytesSaved || 0) + (stats.toolArgsBytesSaved || 0);

  if (totalCondensed === 0) {
    return {
      content: [{ type: 'text', text: `No condensable blocks found in ${path.basename(filePath)} (modes: ${modes.join(',')}). File size unchanged.` }]
    };
  }

  const reportLines = [
    `## condense_jsonl_blocks ${dryRun ? '(DRY RUN — no mutation)' : '— Applied'}`,
    ``,
    `**File**: \`${filePath}\``,
    `**Modes**: ${modes.join(', ')}`,
    `**File size**: ${(sizeBefore/1024).toFixed(0)} KB`,
    ``,
    `### Condensation found`,
    `- Images: ${stats.imagesCondensed} blocks, ~${(stats.imagesBytesSaved/1024).toFixed(0)} KB`,
    `- Memory-style reads: ${stats.memoryReadsCondensed} blocks, ~${(stats.memoryReadsBytesSaved/1024).toFixed(0)} KB`,
    `- Identical-content reads: ${stats.identicalReadsCondensed} blocks, ~${(stats.identicalReadsBytesSaved/1024).toFixed(0)} KB`,
    `- Stale reads (same path/args, older superseded): ${stats.staleReadsCondensed || 0} blocks, ~${((stats.staleReadsBytesSaved||0)/1024).toFixed(0)} KB`,
    `- MCP status snapshots (older superseded): ${stats.mcpSnapshotsCondensed || 0} blocks, ~${((stats.mcpSnapshotsBytesSaved||0)/1024).toFixed(0)} KB`,
    `- Re-fetch markers (Read/Bash/MCP queries → summary+pointer): ${stats.refetchMarkersCondensed || 0} blocks, ~${((stats.refetchMarkersBytesSaved||0)/1024).toFixed(0)} KB`,
    `- Tool-args (verbose tool_use INPUT fields → preview+pointer): ${stats.toolArgsCondensed || 0} blocks, ~${((stats.toolArgsBytesSaved||0)/1024).toFixed(0)} KB`,
    modes.includes('thinking') ? `- Thinking blocks: ${stats.thinkingCondensed || 0} blocks, ~${((stats.thinkingBytesSaved||0)/1024).toFixed(0)} KB${usingThinkingFallback ? ' ⚠️ (heuristic last-paragraph fallback — no v2 plan found)' : ` (using v2 plan ${planUsed?.planId?.slice(0,8) || ''}...)`}` : '',
    `- **Total**: ${totalCondensed} blocks, ~${(totalBytesSaved/1024).toFixed(0)} KB raw content (file size will drop less due to JSON overhead)`,
    ``
  ];

  if (dryRun) {
    reportLines.push(`Dry run — re-run without \`dry_run: true\` to actually apply.`);
    return { content: [{ type: 'text', text: reportLines.join('\n') }] };
  }

  // Backup BEFORE mutation.
  const convId = path.basename(filePath, '.jsonl');
  const backupDir = path.join(path.dirname(filePath), '.condense-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const epoch = Date.now();
  const backupPath = path.join(backupDir, `${convId}.${epoch}.jsonl`);
  fs.copyFileSync(filePath, backupPath);
  const prunedBackups = pruneOldBackups(backupDir, convId);

  // Update sidecar metadata for every block we just condensed (this is the
  // record that future runs use to skip already-touched blocks).
  for (const [uuid, info] of (stats._blockCondenseRecords || [])) {
    markBlockCondensed(sidecar, uuid, info.blockIdx, {
      mode: info.mode,
      originalBytes: info.originalBytes,
      condensedBytes: info.condensedBytes,
      extra: info.extra
    });
  }

  // Apply via shared rewriteJsonl utility.
  let stats2;
  try {
    stats2 = rewriteJsonl(filePath, { replace });
  } catch (e) {
    return {
      content: [{ type: 'text', text: `rewriteJsonl failed: ${e.message}\nBackup at ${backupPath} is intact.` }],
      isError: true
    };
  }

  // Persist the sidecar (after rewriteJsonl succeeds — keeps meta and JSONL in sync).
  let sidecarPath = null;
  try { sidecarPath = saveCondenseMeta(filePath, sidecar); } catch (e) { sidecarPath = `(save failed: ${e.message})`; }

  const sizeAfter = fs.statSync(filePath).size;

  // Append-only run log for audit + diagnostic. Captures every condense run's
  // parameters, results, errors. Located at <conv_dir>/.condense-log/<convId>.jsonl.
  // Dashboard / future tooling can scan this to surface "condense history" views,
  // diagnose unexpected outcomes, or compute cumulative savings across runs.
  try {
    const logDir = path.join(path.dirname(filePath), '.condense-log');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, path.basename(filePath, '.jsonl') + '.jsonl');
    const logEntry = {
      at: Date.now(),
      modes,
      args: {
        dry_run: dryRun,
        conversation_id: args.conversation_id,
        jsonl_path: args.jsonl_path,
        thinking_marker_style: args.thinking_marker_style,
        keep_recent_turns: args.keep_recent_turns
      },
      filePath,
      fileSize: { before: sizeBefore, after: sizeAfter },
      blocksCondensed: {
        images: stats.imagesCondensed,
        memoryReads: stats.memoryReadsCondensed,
        identicalReads: stats.identicalReadsCondensed,
        staleReads: stats.staleReadsCondensed || 0,
        mcpSnapshots: stats.mcpSnapshotsCondensed || 0,
        refetchMarkers: stats.refetchMarkersCondensed || 0,
        toolArgs: stats.toolArgsCondensed || 0,
        thinking: stats.thinkingCondensed || 0
      },
      bytesSaved: {
        images: stats.imagesBytesSaved,
        memoryReads: stats.memoryReadsBytesSaved,
        identicalReads: stats.identicalReadsBytesSaved,
        staleReads: stats.staleReadsBytesSaved || 0,
        mcpSnapshots: stats.mcpSnapshotsBytesSaved || 0,
        refetchMarkers: stats.refetchMarkersBytesSaved || 0,
        toolArgs: stats.toolArgsBytesSaved || 0,
        thinking: stats.thinkingBytesSaved || 0
      },
      totalBlocksTouched: totalCondensed,
      totalBytesSavedRaw: totalBytesSaved,
      backupPath,
      sidecarPath,
      replacedActual: stats2?.replacedActual || 0,
      planUsed: planUsed?.planId || null
    };
    fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\n');
  } catch (e) {
    // Don't fail the run on log write failure — the actual mutation already succeeded
    console.error('condense-log write failed:', e.message);
  }

  const fileBytesDelta = sizeBefore - sizeAfter;
  const reductionPct = sizeBefore > 0 ? Math.round((100 * fileBytesDelta) / sizeBefore) : 0;

  reportLines.push(
    `**Backup**: \`${backupPath}\``,
    prunedBackups.length ? `**Pruned old backups**: ${prunedBackups.length}` : '',
    `**File size**: ${(sizeBefore/1024).toFixed(0)} KB → ${(sizeAfter/1024).toFixed(0)} KB (${reductionPct}% smaller)`,
    `**Replaced entries**: ${stats2.replacedActual}`,
    sidecarPath ? `**Sidecar metadata**: \`${sidecarPath}\` — tracks per-block condense status; future runs skip already-condensed blocks` : '',
    ``,
    `Hot-trim: Claude Code re-walks the chain each turn — condensed content is visible immediately without /resume. uuid + parentUuid preserved on every entry.`,
    `To undo: \`restore_archive_backup({ backupPath: "${backupPath}" })\`.`
  );

  return {
    content: [{ type: 'text', text: reportLines.filter(l => l !== '').join('\n') }],
    structuredContent: {
      sizeBefore,
      sizeAfter,
      reductionPct,
      condensed: stats,
      backupPath
    }
  };
}
