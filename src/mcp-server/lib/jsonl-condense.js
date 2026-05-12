/**
 * Heuristic per-block condenser for Claude Code conversation JSONLs.
 *
 * Per-block surgery: rather than dropping/distilling whole turns (which loses
 * load-bearing decisions when the bloat is concentrated in a few tool_result
 * blocks inside an otherwise valuable turn), this library condenses individual
 * blocks within entries while keeping uuid + parentUuid + chain shape intact.
 *
 * v3.0 scope (conservative, zero-LLM, fully reversible):
 *   - "images": base64 image content in tool_results → marker
 *   - "memory-reads": older reads of memory-style paths → marker
 *   - "identical-reads": older reads of any path with byte-identical content → marker
 *
 * Each heuristic emits a structured replacement spec (uuid → newFullEntry) that
 * the caller can hand to lib/jsonl-mutate.js's rewriteJsonl. Heuristics are
 * idempotent — running twice produces no additional changes (markers won't
 * re-match the patterns).
 */

import fs from 'fs';
import path from 'path';

const MEMORY_FILE_PATTERNS = [
  /\/MEMORY\.md$/i,
  /\/CLAUDE\.md$/i,
  /\/\.wisdom\//i,
  /\/memory\/[^/]+\.md$/i,
  /\/plans\/[^/]+\.md$/i
];

const THINKING_KEEP_RECENT_TURNS = 30;  // keep thinking verbatim for the most-recent N turns (active state)
const THINKING_MIN_BYTES = 400;  // don't bother condensing tiny thinking blocks

// Pattern for MCP "status snapshot" tools — calls that return point-in-time
// state which gets stale fast (orchestrator queue, session info, etc.).
// When two calls with the same name + args appear in chain order, the older
// one's tool_result is superseded by the newer.
const MCP_SNAPSHOT_TOOL_PATTERNS = [
  /^mcp__orchestrator__get_suggestions$/i,
  /^mcp__orchestrator__get_session_info$/i,
  /^mcp__orchestrator__get_session_output$/i,
  /^mcp__orchestrator__list_sessions$/i,
  /^mcp__orchestrator__list_workers$/i,
  /^mcp__orchestrator__get_orchestrators$/i,
  /^mcp__worker__get_my_tasks$/i,
  /^mcp__worker__who_am_i$/i,
  /^mcp__worker__list_file_locks$/i
];
const MCP_SNAPSHOT_MIN_BYTES = 500;  // don't bother for trivial snapshots
const STALE_READ_MIN_BYTES = 500;    // don't bother for tiny reads

// Re-fetch marker mode: summarize tool_result content with head + tail + re-fetch pointer.
// Threshold: only condense tool_results above this size — not worth the marker overhead otherwise.
const REFETCH_MIN_BYTES = 1500;
const REFETCH_HEAD_CHARS = 400;
const REFETCH_TAIL_CHARS = 100;

// Tools whose results are SAFELY re-runnable (read-only, idempotent).
// Tool_results from mutation tools are excluded — re-running is unsafe.
const REFETCH_ELIGIBLE_TOOLS = new Set([
  'Read', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch',
  'mcp__orchestrator__get_suggestions',
  'mcp__orchestrator__get_session_info',
  'mcp__orchestrator__get_session_output',
  'mcp__orchestrator__list_sessions',
  'mcp__orchestrator__list_workers',
  'mcp__orchestrator__get_orchestrators',
  'mcp__worker__get_my_tasks',
  'mcp__worker__who_am_i',
  'mcp__worker__list_file_locks',
  'mcp__wisdom-store__get_wisdom',
  'mcp__wisdom-store__list_wisdom',
  'mcp__wisdom-store__get_project_overview',
  'mcp__wisdom-store__context_status'
]);
// Bash needs special caveat — re-running is technically possible but commands
// can be side-effecting. Marker includes a "don't re-run unless you've checked
// the command is safe" warning rather than a clean re-run pointer.
const REFETCH_BASH_CAVEAT_TOOLS = new Set(['Bash']);
// Keep refetch-eligible tool_results verbatim for the most-recent N turns (active state).
const REFETCH_KEEP_RECENT_TURNS = 30;

// tool-args mode: condense verbose tool_use INPUT fields where (a) the field
// is a free-form string, (b) the structural content (subject/name/etc.) is
// short enough to keep verbatim, and (c) the agent has enough context from the
// kept fields to remember what it asked for. Skips recent N turns.
const TOOL_ARGS_KEEP_RECENT_TURNS = 30;
const TOOL_ARGS_MIN_FIELD_BYTES = 300;  // don't bother condensing short fields
const TOOL_ARGS_PREVIEW_CHARS = 100;

// Per-tool: which fields to condense (the "long" ones), with the structural
// fields kept verbatim implicitly (anything not listed is preserved).
const TOOL_ARGS_FIELDS = {
  'TaskCreate': ['description'],
  'mcp__orchestrator__create_session': ['initialTask'],
  'mcp__orchestrator__assign_task': ['task']
};

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?)$/i;

/**
 * Detect base64 image data inside a tool_result content string. Heuristic:
 *   - Starts with the data: URI prefix for an image, OR
 *   - Looks like raw base64 (single long token of base64 chars) AND the
 *     preceding tool_use's input.file_path ends in an image extension.
 */
function looksLikeImageBase64(toolResultText, precedingToolUseInput) {
  if (typeof toolResultText !== 'string' || toolResultText.length < 1024) return false;
  if (toolResultText.startsWith('data:image/')) return true;
  // If there's no obvious data: prefix, fall back to "is this a Read of an image file?"
  // The corresponding tool_use carries the file path.
  const fp = precedingToolUseInput?.file_path;
  if (fp && IMAGE_EXT.test(fp)) {
    // Sanity check that the result LOOKS like base64 (ratio of base64-safe chars high)
    const sample = toolResultText.slice(0, 4096);
    const base64ish = sample.replace(/[A-Za-z0-9+/=]/g, '').length;
    if (base64ish / sample.length < 0.05) return true;
  }
  return false;
}

function isMcpSnapshotTool(toolName) {
  if (!toolName || typeof toolName !== 'string') return false;
  return MCP_SNAPSHOT_TOOL_PATTERNS.some(re => re.test(toolName));
}

function isMemoryStylePath(fp) {
  if (!fp || typeof fp !== 'string') return false;
  return MEMORY_FILE_PATTERNS.some(re => re.test(fp));
}

function refetchMarker({ toolName, toolArgs, contentText, contentLen, pass1TurnSummary }) {
  const head = contentText.slice(0, REFETCH_HEAD_CHARS);
  const tail = contentLen > (REFETCH_HEAD_CHARS + REFETCH_TAIL_CHARS + 100)
    ? contentText.slice(-REFETCH_TAIL_CHARS)
    : '';
  const lineCount = contentText.split('\n').length;
  const elidedLen = contentLen - head.length - tail.length;

  // Re-fetch pointer based on tool type
  let refetchInstr;
  if (toolName === 'Read' && toolArgs?.file_path) {
    refetchInstr = `Read({file_path: ${JSON.stringify(toolArgs.file_path)}${toolArgs.offset ? `, offset: ${toolArgs.offset}` : ''}${toolArgs.limit ? `, limit: ${toolArgs.limit}` : ''}}) — gives current file state, not the historical snapshot`;
  } else if (toolName === 'Bash' && toolArgs?.command) {
    refetchInstr = `Bash({command: ${JSON.stringify(toolArgs.command)}}) — RE-RUN ONLY IF SAFE; some commands have side effects.`;
  } else if (toolName === 'Grep' && toolArgs?.pattern) {
    refetchInstr = `Grep with same args (pattern + path filters) for current matches`;
  } else if (toolName?.startsWith('mcp__')) {
    refetchInstr = `${toolName}(${JSON.stringify(toolArgs || {})}) — re-call for current state`;
  } else {
    refetchInstr = `re-call ${toolName} with the same args`;
  }

  const summaryParts = [
    `[${toolName} tool_result elided — ~${(contentLen/1024).toFixed(1)} KB, ${lineCount} lines]`
  ];
  // Optional Pass 1 turn summary — higher quality context than raw head/tail.
  if (pass1TurnSummary) {
    summaryParts.push(``, `TURN OUTCOME (from analyze v2 Pass 1):`, `  ${pass1TurnSummary}`);
  }
  // Always include head+tail as procedural backup — Pass 1 summary captures the
  // turn's overall outcome but the raw content head shows the actual data shape.
  summaryParts.push(``, `RAW CONTENT (first ${head.length} chars):`, head);
  if (tail) {
    summaryParts.push(``, `... [${elidedLen} chars elided] ...`, ``, `(last ${tail.length} chars):`, tail);
  }
  summaryParts.push(
    ``,
    `RE-FETCH for full current content:`,
    `  ${refetchInstr}`,
    ``,
    `Why elided: tool_result was older than the most-recent ${REFETCH_KEEP_RECENT_TURNS}-turn active state and ≥${REFETCH_MIN_BYTES} bytes; condensed to summary+pointer. Original preserved in .condense-backups/.`
  );
  return summaryParts.join('\n');
}

// Sidecar-aware check: is this block already condensed per the sidecar metadata?
// When opts.sidecar is provided, skip blocks already recorded as condensed by
// any prior run — keeps condense IDEMPOTENT at the block level.
function isAlreadyCondensed(sidecar, uuid, blockIdx) {
  if (!sidecar?.entries) return false;
  return !!sidecar.entries[uuid]?.blocks?.[String(blockIdx)];
}

function recordCondense(records, uuid, blockIdx, mode, originalBytes, condensedBytes, extra) {
  records.push([uuid, { blockIdx, mode, originalBytes, condensedBytes, extra }]);
}

function imageMarker(originalLength, filePath) {
  const sizeKb = (originalLength / 1024).toFixed(0);
  return `[image elided: ~${sizeKb} KB base64, was Read of ${filePath || '<unknown path>'}]`;
}

function staleReadMarker({ filePath, originalLength, supersededByEntry, reason }) {
  const sizeKb = (originalLength / 1024).toFixed(1);
  return `[stale read elided: ${sizeKb} KB, ${filePath || '<unknown path>'}, ${reason}; superseded by uuid ${supersededByEntry?.slice(0, 8) || '?'}]`;
}

/**
 * Find the most recent v2 plan in <conversationDir>/.archive-plans/ that matches
 * the current chain (lastMessageUuid + jsonlMessages). Returns the parsed plan
 * or null if no matching plan found.
 */
export function findMatchingV2Plan(conversationFilePath, currentChainLength, currentLastUuid) {
  const planDir = path.join(path.dirname(conversationFilePath), '.archive-plans');
  let files;
  try { files = fs.readdirSync(planDir); }
  catch { return null; }
  const candidates = files
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const full = path.join(planDir, f);
      try { return { full, mtime: fs.statSync(full).mtimeMs, plan: JSON.parse(fs.readFileSync(full, 'utf8')) }; }
      catch { return null; }
    })
    .filter(c => c && c.plan?.schemaVersion === 'v2-two-pass'
                && c.plan.lastMessageUuid === currentLastUuid
                && c.plan.jsonlMessages === currentChainLength)
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.plan || null;
}

/**
 * Build a Map<turn_id, summaryText> from a v2 plan's Pass 1 summaries.
 */
function pass1SummariesByTurn(plan) {
  const m = new Map();
  for (const s of (plan?.pass1?.summaries || [])) {
    if (s?.turn_id != null && s?.summary && !s.error) m.set(s.turn_id, s.summary);
  }
  return m;
}

/**
 * Build a Set<turn_id> for turns Pass 2 marked "drop" — we skip those when
 * condensing thinking (they'll be removed wholesale anyway, no need to mutate first).
 */
function pass2DroppedTurnIds(plan) {
  const s = new Set();
  for (const d of (plan?.pass2?.turnDecisions || [])) {
    if (d?.action === 'drop' && d.turn_id != null) s.add(d.turn_id);
  }
  return s;
}

/**
 * Heuristic last-paragraph extractor (fallback when no v2 plan is available).
 * Splits on double-newline; returns the last non-empty paragraph (or last
 * sentence if no paragraph break). Approximate but better than nothing.
 */
function extractLastParagraph(text) {
  if (!text || typeof text !== 'string') return '';
  const trimmed = text.trim();
  // Try double-newline paragraph split first
  const paras = trimmed.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (paras.length >= 2) return paras[paras.length - 1];
  // Fall back to last sentence (rough)
  const sentences = trimmed.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length >= 2) return sentences.slice(-2).join(' ');
  return trimmed.slice(-500); // last 500 chars as last-resort
}

// Default minimal marker — keeps body-token cost near zero. Empirical evidence
// from loop168: verbose markers (Pass 1 summary embedded) added ~17K body tokens
// across 234 condensations. The model can re-derive the turn outcome from its own
// actions in the same turn; the marker doesn't need to repeat that.
function thinkingMarker({ originalLength, source, summary, style = 'minimal' }) {
  if (style === 'minimal') return '[thinking elided]';
  const sizeKb = (originalLength / 1024).toFixed(1);
  if (source === 'pass1') {
    return `[thinking elided ~${sizeKb} KB; turn outcome: ${summary}]`;
  }
  return `[thinking elided ~${sizeKb} KB; heuristic last-paragraph kept: ${summary}]`;
}

/**
 * Build a `replace` map suitable for rewriteJsonl from a chain of entries.
 *
 * @param {Array<{uuid, fullEntry}>} chainFullEntries — chain entries with full
 *   message bodies (caller resolves via readJsonlLine for >50MB files).
 * @param {object} opts
 * @param {Array<'images'|'memory-reads'|'identical-reads'>} [opts.modes]
 * @returns {{ replace: Map<uuid, newEntry>, stats: object }}
 */
export function buildCondensePlan(chainFullEntries, opts = {}) {
  const modes = new Set(opts.modes || ['images', 'memory-reads', 'identical-reads']);
  const sidecar = opts.sidecar || null;  // when provided, skip already-condensed blocks
  const replace = new Map();
  const stats = {
    imagesCondensed: 0,
    imagesBytesSaved: 0,
    memoryReadsCondensed: 0,
    memoryReadsBytesSaved: 0,
    identicalReadsCondensed: 0,
    identicalReadsBytesSaved: 0,
    thinkingCondensed: 0,
    thinkingBytesSaved: 0,
    thinkingFallbackUsed: 0,
    staleReadsCondensed: 0,
    staleReadsBytesSaved: 0,
    mcpSnapshotsCondensed: 0,
    mcpSnapshotsBytesSaved: 0,
    refetchMarkersCondensed: 0,
    refetchMarkersBytesSaved: 0,
    toolArgsCondensed: 0,
    toolArgsBytesSaved: 0,
    totalEntriesScanned: chainFullEntries.length,
    _blockCondenseRecords: []  // records for sidecar persistence; not meant for user display
  };

  // First pass: collect all tool_use → tool_result pairings. For each, capture
  // the tool name + args + the result content. Used by multiple modes:
  //   - reads: indexed by file_path (for memory-reads, identical-reads, stale-reads)
  //   - mcpSnapshots: indexed by tool name + args (for mcp-snapshots)
  const reads = [];
  const mcpSnapshots = []; // {readEntryIdx, resultEntryIdx, resultBlockIdx, toolName, argsKey, content, contentLen, resultUuid}

  for (let i = 0; i < chainFullEntries.length; i++) {
    const entry = chainFullEntries[i].fullEntry;
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      const isRead = block.name === 'Read' && block.input?.file_path;
      const isMcpSnapshot = isMcpSnapshotTool(block.name);
      if (!isRead && !isMcpSnapshot) continue;
      const tuId = block.id;
      // Look ahead for matching tool_result
      for (let j = i + 1; j < Math.min(i + 5, chainFullEntries.length); j++) {
        const next = chainFullEntries[j].fullEntry;
        const nc = next?.message?.content;
        if (!Array.isArray(nc)) continue;
        for (const nb of nc) {
          if (nb?.type === 'tool_result' && nb.tool_use_id === tuId) {
              // Handle three shapes of tool_result.content:
              //   1. string — the typical small/medium read
              //   2. array of {type:"text", text}    — multi-text return
              //   3. array of {type:"image", source:{data,...}} — image read (Turn 155 style)
              let text = '';
              let imageBase64Length = 0;
              if (typeof nb.content === 'string') {
                text = nb.content;
              } else if (Array.isArray(nb.content)) {
                for (const c of nb.content) {
                  if (c?.type === 'text') text += c.text || '';
                  else if (c?.type === 'image' && c.source?.data) imageBase64Length += c.source.data.length;
                }
              }
              const sharedSpec = {
                readEntryIdx: i,
                resultEntryIdx: j,
                resultBlockIdx: nc.indexOf(nb),
                toolUseId: tuId,
                content: text,
                contentLen: text.length,
                imageBase64Length,
                resultUuid: chainFullEntries[j].uuid
              };
              if (isRead) {
                reads.push({
                  ...sharedSpec,
                  fp: block.input.file_path,
                  offset: block.input.offset || null,
                  limit: block.input.limit || null
                });
              }
              if (isMcpSnapshot && text.length >= MCP_SNAPSHOT_MIN_BYTES) {
                mcpSnapshots.push({
                  ...sharedSpec,
                  toolName: block.name,
                  argsKey: JSON.stringify(block.input || {})
                });
              }
              break;
            }
          }
        }
    }
  }

  // --- Mode: identical-reads ---
  // Group by file_path; within each group, find runs of identical content; keep the latest, mark earlier.
  if (modes.has('identical-reads')) {
    const byPath = new Map();
    for (const r of reads) {
      if (!byPath.has(r.fp)) byPath.set(r.fp, []);
      byPath.get(r.fp).push(r);
    }
    for (const [fp, group] of byPath) {
      if (group.length < 2) continue;
      // Compare content; mark all-but-the-latest with identical content to the latest as condensable.
      const latest = group[group.length - 1];
      for (let k = 0; k < group.length - 1; k++) {
        const r = group[k];
        if (r.content === latest.content && r.contentLen > 1024) {
          // Schedule replacement for r's tool_result block
          if (isAlreadyCondensed(sidecar, r.resultUuid, r.resultBlockIdx)) continue;
          enqueueBlockReplace(replace, chainFullEntries, r, staleReadMarker({
            filePath: fp,
            originalLength: r.contentLen,
            supersededByEntry: latest.resultUuid,
            reason: 'byte-identical to a later read'
          }), 'identical-reads');
          stats.identicalReadsCondensed++;
          stats.identicalReadsBytesSaved += r.contentLen;
          recordCondense(stats._blockCondenseRecords, r.resultUuid, r.resultBlockIdx, 'identical-reads', r.contentLen, 0, { fp });
        }
      }
    }
  }

  // --- Mode: memory-reads ---
  // For known memory-style paths, mark older reads as condensable even if content differs (memory grows).
  if (modes.has('memory-reads')) {
    const memByPath = new Map();
    for (const r of reads) {
      if (!isMemoryStylePath(r.fp)) continue;
      if (!memByPath.has(r.fp)) memByPath.set(r.fp, []);
      memByPath.get(r.fp).push(r);
    }
    for (const [fp, group] of memByPath) {
      if (group.length < 2) continue;
      const latest = group[group.length - 1];
      for (let k = 0; k < group.length - 1; k++) {
        const r = group[k];
        // Skip if already scheduled by identical-reads
        if (replace.has(r.resultUuid) && replace.get(r.resultUuid)._condenseSource === 'identical-reads') continue;
        if (r.contentLen < 256) continue; // not worth marking trivial reads
        if (isAlreadyCondensed(sidecar, r.resultUuid, r.resultBlockIdx)) continue;
        enqueueBlockReplace(replace, chainFullEntries, r, staleReadMarker({
          filePath: fp,
          originalLength: r.contentLen,
          supersededByEntry: latest.resultUuid,
          reason: 'older memory-style read superseded by later read'
        }), 'memory-reads');
        stats.memoryReadsCondensed++;
        stats.memoryReadsBytesSaved += r.contentLen;
        recordCondense(stats._blockCondenseRecords, r.resultUuid, r.resultBlockIdx, 'memory-reads', r.contentLen, 0, { fp });
      }
    }
  }

  // --- Mode: images ---
  if (modes.has('images')) {
    for (const r of reads) {
      // Two paths to qualify as image-condensable:
      //   (a) tool_result content is array containing an `image` block with base64 data
      //   (b) tool_result content is a string starting with `data:image/` (legacy/data URI form)
      const isStructuredImage = r.imageBase64Length > 1024;
      const isDataUriImage = looksLikeImageBase64(r.content, { file_path: r.fp });
      if (!isStructuredImage && !isDataUriImage) continue;
      if (replace.has(r.resultUuid)) continue;
      if (isAlreadyCondensed(sidecar, r.resultUuid, r.resultBlockIdx)) continue;
      const totalBytes = r.imageBase64Length + r.contentLen;
      enqueueImageBlockReplace(replace, chainFullEntries, r, imageMarker(totalBytes, r.fp));
      stats.imagesCondensed++;
      stats.imagesBytesSaved += totalBytes;
      recordCondense(stats._blockCondenseRecords, r.resultUuid, r.resultBlockIdx, 'images', totalBytes, 0, { fp: r.fp });
    }
  }

  // --- Mode: stale-reads ---
  // Same path + same offset + same limit, multiple times in chain order:
  // older reads are superseded (the newer one captures current file state).
  // Different from memory-reads (which condenses any older read of memory-style paths,
  // even if file content differs); stale-reads requires same args = redundant call.
  if (modes.has('stale-reads')) {
    const byArgs = new Map();
    for (const r of reads) {
      const key = r.fp + '|' + (r.offset ?? '') + '|' + (r.limit ?? '');
      if (!byArgs.has(key)) byArgs.set(key, []);
      byArgs.get(key).push(r);
    }
    for (const [key, group] of byArgs) {
      if (group.length < 2) continue;
      const latest = group[group.length - 1];
      for (let k = 0; k < group.length - 1; k++) {
        const r = group[k];
        if (r.contentLen < STALE_READ_MIN_BYTES) continue;
        if (replace.has(r.resultUuid)) continue; // already scheduled by another mode
        enqueueBlockReplace(replace, chainFullEntries, r, staleReadMarker({
          filePath: r.fp,
          originalLength: r.contentLen,
          supersededByEntry: latest.resultUuid,
          reason: 'older read of same path/offset/limit superseded'
        }), 'stale-reads');
        if (!stats.staleReadsCondensed) stats.staleReadsCondensed = 0;
        if (!stats.staleReadsBytesSaved) stats.staleReadsBytesSaved = 0;
        stats.staleReadsCondensed++;
        stats.staleReadsBytesSaved += r.contentLen;
      }
    }
  }

  // --- Mode: mcp-snapshots ---
  // MCP status-snapshot tools (get_suggestions, get_session_info, etc.) return
  // point-in-time state. When the same call appears multiple times in chain order
  // with the same args, older snapshots are stale.
  if (modes.has('mcp-snapshots')) {
    const byKey = new Map();
    for (const s of mcpSnapshots) {
      const key = s.toolName + '|' + s.argsKey;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(s);
    }
    for (const [key, group] of byKey) {
      if (group.length < 2) continue;
      const latest = group[group.length - 1];
      for (let k = 0; k < group.length - 1; k++) {
        const s = group[k];
        if (s.contentLen < MCP_SNAPSHOT_MIN_BYTES) continue;
        if (replace.has(s.resultUuid)) continue;
        const target = chainFullEntries[s.resultEntryIdx].fullEntry;
        const newContent = target.message.content.map((block, idx) => {
          if (idx !== s.resultBlockIdx) return block;
          const marker = `[stale MCP snapshot elided: ${(s.contentLen/1024).toFixed(1)} KB from ${s.toolName}; superseded by uuid ${latest.resultUuid?.slice(0,8) || '?'}]`;
          return { ...block, content: marker };
        });
        const next = {
          ...target,
          message: { ...target.message, content: newContent },
          _condensed: true,
          _condenseSource: 'mcp-snapshots'
        };
        replace.set(target.uuid, next);
        if (!stats.mcpSnapshotsCondensed) stats.mcpSnapshotsCondensed = 0;
        if (!stats.mcpSnapshotsBytesSaved) stats.mcpSnapshotsBytesSaved = 0;
        stats.mcpSnapshotsCondensed++;
        stats.mcpSnapshotsBytesSaved += s.contentLen;
      }
    }
  }

  // --- Mode: thinking ---
  // Condense thinking blocks using v2 Pass 1 summaries when available; fall
  // back to heuristic last-paragraph extraction otherwise. Skip recent N turns
  // and turns Pass 2 marked drop. Requires opts.turnsByEntryUuid + opts.plan
  // to function fully (otherwise pure heuristic fallback per-block, no turn ctx).
  if (modes.has('thinking')) {
    const plan = opts.plan || null;
    const markerStyle = opts.thinkingMarkerStyle || 'minimal';  // default minimal — empirical body-token win
    const summariesByTurn = plan ? pass1SummariesByTurn(plan) : new Map();
    const droppedTurns = plan ? pass2DroppedTurnIds(plan) : new Set();
    const turnsByEntryUuid = opts.turnsByEntryUuid || new Map();  // uuid → {turn_id, totalTurns}
    const totalTurns = opts.totalTurns || 0;
    const recentBoundary = totalTurns - THINKING_KEEP_RECENT_TURNS;

    for (let i = 0; i < chainFullEntries.length; i++) {
      const entry = chainFullEntries[i].fullEntry;
      const c = entry?.message?.content;
      if (!Array.isArray(c)) continue;

      const turnInfo = turnsByEntryUuid.get(chainFullEntries[i].uuid);
      const turn_id = turnInfo?.turn_id;

      // Skip thinking in turns marked drop (apply will remove them anyway)
      if (turn_id != null && droppedTurns.has(turn_id)) continue;
      // Skip thinking in recent turns (active state)
      if (turn_id != null && totalTurns > 0 && turn_id > recentBoundary) continue;

      // Find each thinking block in this entry's content
      let modified = false;
      const newContent = c.map((block) => {
        if (block?.type !== 'thinking') return block;
        // Anthropic's API stores thinking with empty `thinking` field + opaque
        // `signature` field (cryptographic verification for thinking-mode replay).
        // The signature is the byte-heavy part. For archival, replacing it loses
        // thinking-mode replay capability but preserves all semantic content
        // (the actions/decisions in the same turn already capture what matters).
        const thinkingLen = (block.thinking || '').length;
        const sigLen = (block.signature || '').length;
        const totalLen = thinkingLen + sigLen;
        if (totalLen < THINKING_MIN_BYTES) return block;

        let summary, source;
        if (turn_id != null && summariesByTurn.has(turn_id)) {
          summary = summariesByTurn.get(turn_id);
          source = 'pass1';
        } else if (thinkingLen > 0) {
          summary = extractLastParagraph(block.thinking);
          source = 'heuristic-last-paragraph';
          stats.thinkingFallbackUsed++;
        } else {
          // No plan, no thinking text (signature-only block — Anthropic-encrypted thinking)
          summary = '(thinking content was encrypted by Anthropic — only the signature remained)';
          source = 'signature-only-no-plan';
          stats.thinkingFallbackUsed++;
        }
        const marker = thinkingMarker({ originalLength: totalLen, source, summary, style: markerStyle });
        modified = true;
        stats.thinkingCondensed++;
        stats.thinkingBytesSaved += totalLen;
        // CRITICAL: only `type` + `text` (+ optional `cache_control`) are valid
        // on a text content block per Anthropic API schema. Extra fields cause
        // `400 Extra inputs are not permitted` when Claude Code sends the
        // conversation back to the API. All metadata goes on the entry top-level
        // (handled below), not on the block.
        return { type: 'text', text: marker };
      });

      if (modified) {
        // Merge with any existing replace for this uuid
        const existing = replace.get(entry.uuid);
        const baseTarget = existing || entry;
        const next = {
          ...baseTarget,
          message: { ...baseTarget.message, content: newContent },
          _condensed: true
        };
        if (existing) next._condenseSource = (baseTarget._condenseSource || '') + '+thinking';
        else next._condenseSource = 'thinking';
        replace.set(entry.uuid, next);
      }
    }
  }

  // --- Mode: refetch-markers ---
  // For tool_result blocks of READ-ONLY tools (Read, Bash, MCP queries, etc.),
  // replace content with a summary (head + tail + line count) and a pointer to
  // re-fetch the full content. Skip the most-recent N turns (active state).
  // Skip tool_use INPUTS (those represent agent's record of past actions).
  if (modes.has('refetch-markers')) {
    const turnsByEntryUuid = opts.turnsByEntryUuid || new Map();
    const totalTurns = opts.totalTurns || 0;
    const recentBoundary = totalTurns - REFETCH_KEEP_RECENT_TURNS;

    // Re-pair tool_use → tool_result (similar to other modes)
    for (let i = 0; i < chainFullEntries.length; i++) {
      const entry = chainFullEntries[i].fullEntry;
      const c = entry?.message?.content;
      if (!Array.isArray(c)) continue;

      const turnInfo = turnsByEntryUuid.get(chainFullEntries[i].uuid);
      const turn_id = turnInfo?.turn_id;
      if (turn_id != null && totalTurns > 0 && turn_id > recentBoundary) continue;

      // Find tool_use blocks in this entry; look ahead for matching tool_results
      for (const block of c) {
        if (block?.type !== 'tool_use') continue;
        if (!REFETCH_ELIGIBLE_TOOLS.has(block.name)) continue;
        const tuId = block.id;

        for (let j = i + 1; j < Math.min(i + 5, chainFullEntries.length); j++) {
          const next = chainFullEntries[j].fullEntry;
          const nc = next?.message?.content;
          if (!Array.isArray(nc)) continue;
          for (let bIdx = 0; bIdx < nc.length; bIdx++) {
            const nb = nc[bIdx];
            if (nb?.type !== 'tool_result' || nb.tool_use_id !== tuId) continue;

            // Get text content
            let txt = '';
            if (typeof nb.content === 'string') txt = nb.content;
            else if (Array.isArray(nb.content)) for (const cb of nb.content) {
              if (cb?.type === 'text') txt += cb.text || '';
            }
            if (txt.length < REFETCH_MIN_BYTES) continue;
            const targetUuid = chainFullEntries[j].uuid;
            if (replace.has(targetUuid)) continue; // already scheduled by another mode

            const pass1TurnSummary = (turn_id != null && opts.plan)
              ? pass1SummariesByTurn(opts.plan).get(turn_id)
              : null;
            const marker = refetchMarker({
              toolName: block.name,
              toolArgs: block.input,
              contentText: txt,
              contentLen: txt.length,
              pass1TurnSummary
            });

            const target = chainFullEntries[j].fullEntry;
            const newContent = target.message.content.map((b, idx) => {
              if (idx !== bIdx) return b;
              return { ...b, content: marker };
            });
            replace.set(targetUuid, {
              ...target,
              message: { ...target.message, content: newContent },
              _condensed: true,
              _condenseSource: 'refetch-markers'
            });
            if (!stats.refetchMarkersCondensed) stats.refetchMarkersCondensed = 0;
            if (!stats.refetchMarkersBytesSaved) stats.refetchMarkersBytesSaved = 0;
            stats.refetchMarkersCondensed++;
            stats.refetchMarkersBytesSaved += (txt.length - marker.length);
            break;
          }
        }
      }
    }
  }

  // --- Mode: tool-args ---
  // Condense verbose string fields in tool_use INPUTS (not tool_results).
  // Risky-ish but bounded: we only touch tools where the AGENT'S MEMORY of
  // "what I asked" is preserved by other (kept) fields like subject/name, and
  // the long field is the kind of thing the worker has in their own memory.
  // Skip recent N turns. The marker preserves the first ~100 chars of the field
  // and points to .condense-backups for the original.
  if (modes.has('tool-args')) {
    const turnsByEntryUuid = opts.turnsByEntryUuid || new Map();
    const totalTurns = opts.totalTurns || 0;
    const recentBoundary = totalTurns - TOOL_ARGS_KEEP_RECENT_TURNS;

    for (let i = 0; i < chainFullEntries.length; i++) {
      const entry = chainFullEntries[i].fullEntry;
      const c = entry?.message?.content;
      if (!Array.isArray(c)) continue;

      const turnInfo = turnsByEntryUuid.get(chainFullEntries[i].uuid);
      const turn_id = turnInfo?.turn_id;
      if (turn_id != null && totalTurns > 0 && turn_id > recentBoundary) continue;

      let modified = false;
      const newContent = c.map((b, bIdx) => {
        if (b?.type !== 'tool_use') return b;
        const fields = TOOL_ARGS_FIELDS[b.name];
        if (!fields) return b;
        if (isAlreadyCondensed(sidecar, entry.uuid, bIdx)) return b;
        // Check if any of this tool's "long" fields is condensable
        let touched = false;
        const newInput = { ...b.input };
        let originalBytesField = 0;
        for (const fieldName of fields) {
          const val = newInput[fieldName];
          if (typeof val !== 'string') continue;
          if (val.length < TOOL_ARGS_MIN_FIELD_BYTES) continue;
          const preview = val.slice(0, TOOL_ARGS_PREVIEW_CHARS);
          const elidedLen = val.length - preview.length;
          // Marker: keep preview, signal elision, point to backup
          newInput[fieldName] = `${preview}... [${elidedLen} more chars elided; full original in .condense-backups/. Tool: ${b.name}, field: ${fieldName}]`;
          originalBytesField += val.length;
          touched = true;
        }
        if (!touched) return b;
        modified = true;
        if (!stats.toolArgsCondensed) stats.toolArgsCondensed = 0;
        if (!stats.toolArgsBytesSaved) stats.toolArgsBytesSaved = 0;
        stats.toolArgsCondensed++;
        stats.toolArgsBytesSaved += (originalBytesField - JSON.stringify(newInput).length);
        recordCondense(stats._blockCondenseRecords, entry.uuid, bIdx, 'tool-args', originalBytesField, JSON.stringify(newInput).length, { toolName: b.name });
        return { ...b, input: newInput };
      });

      if (modified) {
        const existing = replace.get(entry.uuid);
        const baseTarget = existing || entry;
        const next = {
          ...baseTarget,
          message: { ...baseTarget.message, content: newContent },
          _condensed: true,
          _condenseSource: (existing?._condenseSource || '') + (existing ? '+tool-args' : 'tool-args')
        };
        replace.set(entry.uuid, next);
      }
    }
  }

  // Final pass: record sidecar entries for any block we modified that wasn\'t
  // already recorded via mode-specific recordCondense calls. Walks the replace
  // map and emits records based on the _condenseSource tag set by each mode.
  const recordedUuids = new Set(stats._blockCondenseRecords.map(([u, info]) => u + '|' + info.blockIdx));
  for (const [uuid, modifiedEntry] of replace) {
    if (recordedUuids.has(uuid + '|0') && modifiedEntry?.message?.content?.length === 1) continue; // simple case already recorded
    const c = modifiedEntry?.message?.content;
    if (!Array.isArray(c)) continue;
    // Find blocks that look condensed (text marker, single text block in tool_result, etc.)
    for (let bIdx = 0; bIdx < c.length; bIdx++) {
      const b = c[bIdx];
      // Heuristic: a block is "condensed" if it's a tool_result/text whose content
      // looks like our marker (starts with '[' and contains 'elided').
      if (recordedUuids.has(uuid + '|' + bIdx)) continue;
      let markerText = null;
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.startsWith('[')) markerText = b.text;
      else if (b?.type === 'tool_result' && typeof b.content === 'string' && b.content.startsWith('[')) markerText = b.content;
      if (markerText && markerText.includes('elided')) {
        const mode = modifiedEntry._condenseSource || 'unknown';
        recordCondense(stats._blockCondenseRecords, uuid, bIdx, mode, 0, markerText.length, {});
      }
    }
  }

  return { replace, stats };
}

/**
 * Modify the tool_result block in-place inside a chain entry's message.content,
 * then enqueue the modified full entry for rewriteJsonl's replace map.
 */
function enqueueImageBlockReplace(replace, chainFullEntries, readSpec, markerText) {
  const target = chainFullEntries[readSpec.resultEntryIdx].fullEntry;
  const newContent = target.message.content.map((block, idx) => {
    if (idx !== readSpec.resultBlockIdx) return block;
    // The tool_result block itself: replace its inner content array with a single
    // text block. Strip API-incompatible metadata (only API-valid keys may live
    // on content blocks; metadata moves to entry top-level below).
    return { ...block, content: [{ type: 'text', text: markerText }] };
  });
  const next = {
    ...target,
    message: { ...target.message, content: newContent },
    _condensed: true,
    _condenseSource: 'images'
  };
  replace.set(target.uuid, next);
}

function enqueueBlockReplace(replace, chainFullEntries, readSpec, markerText, sourceTag = 'unknown') {
  const target = chainFullEntries[readSpec.resultEntryIdx].fullEntry;
  // Deep-ish clone — only the message.content array's matching block needs change.
  const newContent = target.message.content.map((block, idx) => {
    if (idx !== readSpec.resultBlockIdx) return block;
    // Strip metadata from content block (API-incompatible). Replace tool_result
    // content (string form) with the marker text directly.
    return { ...block, content: markerText };
  });
  const next = {
    ...target,
    message: { ...target.message, content: newContent },
    _condensed: true
  };
  next._condenseSource = sourceTag; // for de-dupe gate above
  replace.set(target.uuid, next);
}

export const CONDENSE_INTERNALS = {
  looksLikeImageBase64,
  isMemoryStylePath,
  imageMarker,
  staleReadMarker,
  MEMORY_FILE_PATTERNS,
  IMAGE_EXT
};
