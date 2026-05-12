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

import path from 'path';

const MEMORY_FILE_PATTERNS = [
  /\/MEMORY\.md$/i,
  /\/CLAUDE\.md$/i,
  /\/\.wisdom\//i,
  /\/memory\/[^/]+\.md$/i,
  /\/plans\/[^/]+\.md$/i
];

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

function isMemoryStylePath(fp) {
  if (!fp || typeof fp !== 'string') return false;
  return MEMORY_FILE_PATTERNS.some(re => re.test(fp));
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
  const replace = new Map();
  const stats = {
    imagesCondensed: 0,
    imagesBytesSaved: 0,
    memoryReadsCondensed: 0,
    memoryReadsBytesSaved: 0,
    identicalReadsCondensed: 0,
    identicalReadsBytesSaved: 0,
    totalEntriesScanned: chainFullEntries.length
  };

  // First pass: collect all file_read tool_uses + their tool_results.
  // The structure: an assistant entry contains tool_use blocks. The NEXT entry
  // (a user-role message) contains tool_result blocks keyed by tool_use_id.
  // We track Reads across entries to detect duplicates and stale reads.
  const reads = []; // { entryIdx, fp, toolUseId, content, contentLen, contentHash }

  for (let i = 0; i < chainFullEntries.length; i++) {
    const entry = chainFullEntries[i].fullEntry;
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && block.name === 'Read' && block.input?.file_path) {
        // Look ahead for the matching tool_result in the immediately-following entries
        const tuId = block.id;
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
              reads.push({
                readEntryIdx: i,
                resultEntryIdx: j,
                resultBlockIdx: nc.indexOf(nb),
                fp: block.input.file_path,
                toolUseId: tuId,
                content: text,
                contentLen: text.length,
                imageBase64Length,
                resultUuid: chainFullEntries[j].uuid
              });
              break;
            }
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
          enqueueBlockReplace(replace, chainFullEntries, r, staleReadMarker({
            filePath: fp,
            originalLength: r.contentLen,
            supersededByEntry: latest.resultUuid,
            reason: 'byte-identical to a later read'
          }));
          stats.identicalReadsCondensed++;
          stats.identicalReadsBytesSaved += r.contentLen;
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
        enqueueBlockReplace(replace, chainFullEntries, r, staleReadMarker({
          filePath: fp,
          originalLength: r.contentLen,
          supersededByEntry: latest.resultUuid,
          reason: 'older memory-style read superseded by later read'
        }), 'memory-reads');
        stats.memoryReadsCondensed++;
        stats.memoryReadsBytesSaved += r.contentLen;
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
      const totalBytes = r.imageBase64Length + r.contentLen;
      enqueueImageBlockReplace(replace, chainFullEntries, r, imageMarker(totalBytes, r.fp));
      stats.imagesCondensed++;
      stats.imagesBytesSaved += totalBytes;
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
    // The tool_result block itself: replace its inner content array with a single text block.
    const newInner = [{ type: 'text', text: markerText }];
    return {
      ...block,
      content: newInner,
      _condensed: true,
      _condenseSource: 'images',
      _originalImageLength: readSpec.imageBase64Length
    };
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
    return { ...block, content: markerText, _condensed: true, _condenseSource: sourceTag, _originalLength: readSpec.contentLen };
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
