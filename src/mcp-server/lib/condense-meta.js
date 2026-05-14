/**
 * Sidecar metadata for per-block condensation tracking.
 *
 * Lives at <conv_dir>/.condense-meta/<convId>.json. Tracks which blocks within
 * which entries have been condensed by which mode, when, with byte stats. Used
 * to:
 *   - Make condense idempotent at the BLOCK level (not just file level) —
 *     subsequent runs skip already-condensed blocks
 *   - Save Pass 1 effort on subsequent analyze runs (turns where all big blocks
 *     are already condensed don't need re-classification)
 *   - Enable per-mode reversibility ("undo just thinking-condense, keep image
 *     markers") by reading sidecar + restoring those specific blocks from a backup
 *   - Audit trail: see which blocks were touched when, by which mode, with
 *     before/after byte counts
 *
 * Sidecar is API-safe (lives outside the JSONL), so it can hold arbitrary
 * metadata without risking the "Extra inputs are not permitted" 400 we hit
 * when we tried adding metadata to message.content blocks.
 */

import fs from 'fs';
import path from 'path';

const SCHEMA_VERSION = 'v1';

function metaPath(jsonlPath) {
  const dir = path.dirname(jsonlPath);
  const base = path.basename(jsonlPath, '.jsonl');
  return path.join(dir, '.condense-meta', `${base}.json`);
}

export function loadCondenseMeta(jsonlPath) {
  const p = metaPath(jsonlPath);
  if (!fs.existsSync(p)) {
    return { schemaVersion: SCHEMA_VERSION, convId: path.basename(jsonlPath, '.jsonl'), lastUpdated: null, entries: {} };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!raw.entries) raw.entries = {};
    return raw;
  } catch (e) {
    // Corrupt sidecar — start fresh, don't crash. The original JSONL is the source of truth.
    return { schemaVersion: SCHEMA_VERSION, convId: path.basename(jsonlPath, '.jsonl'), lastUpdated: null, entries: {}, _loadError: e.message };
  }
}

export function saveCondenseMeta(jsonlPath, meta) {
  const p = metaPath(jsonlPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  meta.lastUpdated = Date.now();
  // Atomic write via tmp + rename
  const tmp = p + '.tmp.' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, p);
  return p;
}

/**
 * Mark a specific block as condensed.
 * @param {object} meta - the loaded sidecar
 * @param {string} uuid - entry uuid
 * @param {number} blockIdx - block position within message.content array
 * @param {object} info - { mode, originalBytes, condensedBytes, extra? }
 */
export function markBlockCondensed(meta, uuid, blockIdx, info) {
  if (!meta.entries[uuid]) meta.entries[uuid] = { blocks: {} };
  if (!meta.entries[uuid].blocks) meta.entries[uuid].blocks = {};
  meta.entries[uuid].blocks[String(blockIdx)] = {
    mode: info.mode,
    at: info.at || Date.now(),
    originalBytes: info.originalBytes || 0,
    condensedBytes: info.condensedBytes || 0,
    // Pull summarySource out of extra and persist as a top-level field
    // (refetch-markers upgrade-path uses it on the next run).
    ...(info.extra?.summarySource ? { summarySource: info.extra.summarySource } : {}),
    ...(info.extra ? { extra: info.extra } : {})
  };
}

export function isBlockCondensed(meta, uuid, blockIdx) {
  return !!meta?.entries?.[uuid]?.blocks?.[String(blockIdx)];
}

export function getBlockCondenseInfo(meta, uuid, blockIdx) {
  return meta?.entries?.[uuid]?.blocks?.[String(blockIdx)] || null;
}

export function isEntryFullyCondensed(meta, uuid, totalBlocks) {
  const e = meta?.entries?.[uuid];
  if (!e?.blocks) return false;
  for (let i = 0; i < totalBlocks; i++) {
    if (!e.blocks[String(i)]) return false;
  }
  return true;
}

/**
 * Aggregate stats across all entries in the sidecar.
 */
export function summarizeMeta(meta) {
  const byMode = {};
  let totalEntries = 0, totalBlocks = 0, totalOriginalBytes = 0, totalCondensedBytes = 0;
  for (const [uuid, e] of Object.entries(meta.entries || {})) {
    if (!e?.blocks) continue;
    totalEntries++;
    for (const [blockIdx, info] of Object.entries(e.blocks)) {
      totalBlocks++;
      totalOriginalBytes += info.originalBytes || 0;
      totalCondensedBytes += info.condensedBytes || 0;
      const m = info.mode || 'unknown';
      if (!byMode[m]) byMode[m] = { count: 0, savedBytes: 0 };
      byMode[m].count++;
      byMode[m].savedBytes += (info.originalBytes - info.condensedBytes) || 0;
    }
  }
  return { totalEntries, totalBlocks, totalOriginalBytes, totalCondensedBytes, byMode, lastUpdated: meta.lastUpdated };
}

export const CONDENSE_META_INTERNALS = { metaPath, SCHEMA_VERSION };
