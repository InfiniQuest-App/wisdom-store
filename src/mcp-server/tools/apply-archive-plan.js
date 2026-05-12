/**
 * apply_archive_plan tool
 *
 * Reads a plan persisted by analyze_for_archive, validates it (checksum + TTL +
 * drift check via lastMessageUuid AND chain length), backs up the JSONL, then
 * applies the plan via the shared rewriteJsonl utility.
 *
 * Drop semantics: physically remove the entry. Surviving descendants whose
 * parentUuid pointed at a dropped entry are re-linked upward to skip the gap.
 * If the cascade pushes the first surviving entry to be a chain root, validate
 * its type is `user`/`system` (Claude Code refuses to resume an assistant root).
 *
 * Distill semantics: keep the entry's uuid + parentUuid + role + timestamp,
 * replace only the message content with the LLM's distillation summary. The
 * chain shape is preserved; only the visible text changes.
 *
 * Apply ordering: backup BEFORE mutate (atomic via tmp+rename inside
 * rewriteJsonl, plus the size-based race guard). If anything fails after backup,
 * the backup is intact for restore_archive_backup.
 *
 * Backup retention: keep last 3 per conversation (oldest pruned automatically).
 *
 * Hot-trim: drops alone are safe — Claude Code re-walks the chain each turn,
 * so dropped entries simply vanish. Distills modify visible content of an
 * existing entry; brief specifies returning requiresResume:true so caller can
 * fire /resume to force re-read.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  findConversationFile,
  readJsonl,
  walkChain,
  readJsonlLine
} from '../lib/jsonl.js';
import { rewriteJsonl } from '../lib/jsonl-mutate.js';
import { ANALYZE_INTERNALS } from './analyze-for-archive.js';

const VALID_ROOT_TYPES = new Set(['user', 'system']);
const BACKUP_RETENTION = 3;

function findPlanFile(planId) {
  // Plans are stored in `<conversation_dir>/.archive-plans/<planId>.json`. We
  // don't know the conversation upfront from planId alone, so scan all
  // ~/.claude/projects/<hash>/.archive-plans/ directories. This is bounded in
  // practice (one MCP server, dozens of project hashes at most).
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  let projectDirs;
  try { projectDirs = fs.readdirSync(projectsDir); }
  catch { return null; }

  for (const d of projectDirs) {
    const planPath = path.join(projectsDir, d, '.archive-plans', `${planId}.json`);
    if (fs.existsSync(planPath)) return planPath;
  }
  return null;
}

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

/**
 * Determine the new parentUuid for each surviving entry whose parent is in the
 * drop set. Walks back through consecutive dropped ancestors to the first
 * surviving one. If no surviving ancestor exists, the entry becomes a new root
 * (parentUuid: null).
 */
function computeReparentingMap(chain, droppedUuids) {
  const reparent = new Map(); // uuid → newParentUuid (null = new root)
  for (let i = 0; i < chain.length; i++) {
    const u = chain[i].data.uuid;
    if (droppedUuids.has(u)) continue;
    const originalParent = chain[i].data.parentUuid;
    if (originalParent == null) continue; // already a root
    if (!droppedUuids.has(originalParent)) continue; // parent kept

    // Cascade upward through dropped ancestors
    let j = i - 1;
    let newParent = null;
    while (j >= 0) {
      if (!droppedUuids.has(chain[j].data.uuid)) {
        newParent = chain[j].data.uuid;
        break;
      }
      j--;
    }
    reparent.set(u, newParent);
  }
  return reparent;
}

function entryHasToolUseOrResult(fullEntry) {
  // Distilling away an assistant tool_use orphans the next message's tool_result;
  // distilling away a user tool_result leaves an in-flight tool_use unanswered.
  // Either case can confuse Claude Code's chain reader. Detect and refuse.
  const content = fullEntry?.message?.content;
  if (!Array.isArray(content)) return null;
  for (const b of content) {
    if (b?.type === 'tool_use') return 'tool_use';
    if (b?.type === 'tool_result') return 'tool_result';
  }
  return null;
}

function makeDistilledEntry(originalFull, distillation) {
  // Preserve all top-level metadata; replace only message content. Role-aware
  // to keep the JSONL valid for Claude Code's reader.
  const role = originalFull.message?.role || originalFull.type || 'user';
  let newMessage;
  if (role === 'assistant') {
    newMessage = { role: 'assistant', content: [{ type: 'text', text: distillation }] };
  } else if (role === 'system') {
    newMessage = { role: 'system', content: distillation };
  } else {
    newMessage = { role: 'user', content: distillation };
  }
  return {
    ...originalFull,
    message: newMessage,
    _archiveDistilled: true,
    _archiveDistilledAt: new Date().toISOString()
  };
}

export async function handleApplyArchivePlan(args = {}) {
  if (!args.planId || !args.checksum) {
    return {
      content: [{ type: 'text', text: 'Both `planId` and `checksum` are required.' }],
      isError: true
    };
  }
  if (args.confirm !== true) {
    return {
      content: [{ type: 'text', text: 'Refusing to apply without explicit `confirm: true`. This is destructive (mutates JSONL); confirm to proceed.' }],
      isError: true
    };
  }

  const planPath = findPlanFile(args.planId);
  if (!planPath) {
    return {
      content: [{ type: 'text', text: `Plan ${args.planId} not found. Run analyze_for_archive first, or check the planId.` }],
      isError: true
    };
  }

  let plan;
  try { plan = JSON.parse(fs.readFileSync(planPath, 'utf8')); }
  catch (e) { return { content: [{ type: 'text', text: `Failed to read plan: ${e.message}` }], isError: true }; }

  // TTL check
  if (Date.now() - plan.createdAt > ANALYZE_INTERNALS.PLAN_TTL_MS) {
    return {
      content: [{
        type: 'text',
        text: `Plan ${args.planId} expired (created ${Math.round((Date.now() - plan.createdAt) / 60000)} minutes ago, TTL ${ANALYZE_INTERNALS.PLAN_TTL_MS / 60000} min). Re-run analyze_for_archive.`
      }],
      isError: true
    };
  }

  // Recompute checksum from the plan's stored core fields and verify both
  // (a) the recomputed checksum matches what's stored in the file (file integrity)
  // (b) the caller-supplied checksum matches (no stale apply)
  const planCore = {
    planId: plan.planId,
    jsonlPath: plan.jsonlPath,
    jsonlBytes: plan.jsonlBytes,
    jsonlMessages: plan.jsonlMessages,
    lastMessageUuid: plan.lastMessageUuid,
    entries: plan.entries
  };
  const recomputed = crypto.createHash('sha256')
    .update(ANALYZE_INTERNALS.canonicalStringify(planCore))
    .digest('hex');
  if (recomputed !== plan.checksum) {
    return {
      content: [{ type: 'text', text: `Plan file checksum mismatch (file may be tampered). Refusing.` }],
      isError: true
    };
  }
  if (args.checksum !== plan.checksum) {
    return {
      content: [{
        type: 'text',
        text: `Provided checksum does not match plan checksum. Got ${args.checksum.slice(0, 16)}..., expected ${plan.checksum.slice(0, 16)}...`
      }],
      isError: true
    };
  }

  // Resolve the live JSONL and check drift.
  const filePath = plan.jsonlPath;
  if (!fs.existsSync(filePath)) {
    return {
      content: [{ type: 'text', text: `JSONL file ${filePath} no longer exists.` }],
      isError: true
    };
  }
  const entries = readJsonl(filePath);
  const chain = walkChain(entries);
  if (chain.length === 0) {
    return { content: [{ type: 'text', text: 'Live JSONL chain is empty.' }], isError: true };
  }
  const liveLastUuid = chain[chain.length - 1].data.uuid;
  if (liveLastUuid !== plan.lastMessageUuid || chain.length !== plan.jsonlMessages) {
    return {
      content: [{
        type: 'text',
        text: `JSONL drifted since analyze — re-run analyze_for_archive. ` +
              `(plan: ${plan.jsonlMessages} msgs, last=${plan.lastMessageUuid?.slice(0, 8)}...; ` +
              `live: ${chain.length} msgs, last=${liveLastUuid?.slice(0, 8)}...)`
      }],
      isError: true
    };
  }

  // Backup the JSONL BEFORE any mutation. Backup goes in `.archive-backups/`
  // alongside the conversation file.
  const convId = path.basename(filePath, '.jsonl');
  const backupDir = path.join(path.dirname(filePath), '.archive-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const epoch = Date.now();
  const backupPath = path.join(backupDir, `${convId}.${epoch}.jsonl`);
  fs.copyFileSync(filePath, backupPath);
  const prunedOldBackups = pruneOldBackups(backupDir, convId);

  // Build drop set + distill replace map.
  const droppedUuids = new Set(plan.entries.filter(e => e.action === 'drop').map(e => e.uuid));
  const distillEntries = plan.entries.filter(e => e.action === 'distill');

  // Reparent surviving entries whose parent was dropped.
  const reparent = computeReparentingMap(chain, droppedUuids);

  // Validate: if a surviving entry becomes a new root, its type must be user/system.
  for (const [u, newParent] of reparent.entries()) {
    if (newParent !== null) continue; // not a root
    const chainEntry = chain.find(c => c.data.uuid === u);
    const fullEntry = readJsonlLine(filePath, chainEntry.line);
    const t = fullEntry?.type;
    if (!VALID_ROOT_TYPES.has(t)) {
      return {
        content: [{
          type: 'text',
          text: `Cannot apply: dropping entries would make ${u.slice(0, 8)}... (type=${t}) a chain root, ` +
                `but Claude Code requires roots to be user/system. Re-run analyze with adjusted scope. ` +
                `Backup at ${backupPath} (no mutation occurred yet).`
        }],
        isError: true
      };
    }
  }

  // Defensive: distilling an entry with tool_use/tool_result blocks would orphan
  // the tool_use_id paired with it across the user/assistant message boundary.
  // Refuse rather than silently corrupt the chain. Caller can re-run analyze
  // and ask the LLM to skip such entries (or drop the whole tool-call pair).
  for (const distill of distillEntries) {
    const chainEntry = chain.find(c => c.data.uuid === distill.uuid);
    if (!chainEntry) continue;
    const fullEntry = readJsonlLine(filePath, chainEntry.line);
    const blockKind = entryHasToolUseOrResult(fullEntry);
    if (blockKind) {
      return {
        content: [{
          type: 'text',
          text: `Cannot apply: plan distills entry ${distill.uuid.slice(0, 8)}... which contains a ${blockKind} block. ` +
                `Distilling would orphan the paired tool_use_id reference. Re-run analyze to exclude tool_use/tool_result entries from distill, ` +
                `or drop the full tool-call pair instead. Backup at ${backupPath} (no mutation occurred yet).`
        }],
        isError: true
      };
    }
  }

  // Build replace map: for each entry whose parent needs rewriting OR which is
  // being distilled (or both), compose the new full entry.
  const replaceMap = new Map();
  const reparentOnly = new Set(reparent.keys());
  for (const distill of distillEntries) {
    const chainEntry = chain.find(c => c.data.uuid === distill.uuid);
    if (!chainEntry) continue; // shouldn't happen — analyze validated
    const fullEntry = readJsonlLine(filePath, chainEntry.line);
    if (!fullEntry) continue;
    let next = makeDistilledEntry(fullEntry, distill.distillation);
    if (reparent.has(distill.uuid)) {
      next = { ...next, parentUuid: reparent.get(distill.uuid) };
      reparentOnly.delete(distill.uuid);
    }
    replaceMap.set(distill.uuid, next);
  }
  // Entries that need parent rewrite but aren't being distilled
  for (const u of reparentOnly) {
    const chainEntry = chain.find(c => c.data.uuid === u);
    const fullEntry = readJsonlLine(filePath, chainEntry.line);
    if (!fullEntry) continue;
    replaceMap.set(u, { ...fullEntry, parentUuid: reparent.get(u) });
  }

  // Default to orphan-style drops: dropped entries stay in file (preserved as
  // history; can be inspected via inspect_pruned_messages later), but surviving
  // descendants' parentUuids are rewritten past them via the reparenting cascade.
  // For physical-remove behavior (smaller file), pass orphan_drops: false —
  // though for file-size cleanup sandwich_prune is the better-suited tool.
  const orphanDrops = args.orphan_drops !== false;

  // Apply via shared utility. In orphan mode, don't pass drop set; reparenting
  // alone is enough to make dropped entries unreachable from any chain walk.
  let stats;
  try {
    stats = rewriteJsonl(filePath, orphanDrops
      ? { replace: replaceMap }
      : { drop: droppedUuids, replace: replaceMap });
  } catch (e) {
    return {
      content: [{
        type: 'text',
        text: `rewriteJsonl failed: ${e.message}\nBackup at ${backupPath} is intact — use restore_archive_backup if needed.`
      }],
      isError: true
    };
  }

  const distilled = distillEntries.length;
  const dropped = droppedUuids.size;
  const reductionPct = stats.sizeBefore > 0
    ? Math.round((1 - stats.sizeAfter / stats.sizeBefore) * 100)
    : 0;
  const requiresResume = distilled > 0;

  const report = [
    `## apply_archive_plan — Applied`,
    ``,
    `**Plan**: \`${plan.planId}\``,
    `**JSONL**: \`${filePath}\``,
    `**Backup**: \`${backupPath}\``,
    prunedOldBackups.length ? `**Pruned old backups**: ${prunedOldBackups.length} (kept last ${BACKUP_RETENTION})` : '',
    ``,
    `**Drop mode**: ${orphanDrops ? 'orphan (entries stay in file, unreachable from chain walks; inspectable via inspect_pruned_messages; reversible by re-linking parentUuids)' : 'physical remove (entries deleted from file; reversible only via backup restore)'}`,
    ``,
    `**Applied entries**: ${plan.entries.length}`,
    `- Dropped: ${dropped}${orphanDrops ? ' (orphaned, in file)' : ` (actually removed: ${stats.droppedActual})`}`,
    `- Distilled: ${distilled}`,
    `- Reparented (parent was dropped): ${reparent.size}`,
    ``,
    `**File size**: ${(stats.sizeBefore / 1024).toFixed(0)} KB → ${(stats.sizeAfter / 1024).toFixed(0)} KB (${reductionPct}% reduction${orphanDrops ? ' — orphan mode preserves dropped entries on disk; size delta is from reparenting + distill replacements only' : ''})`,
    ``,
    `**Requires /resume**: ${requiresResume ? 'YES (distillations changed visible content of kept entries)' : 'no (drops are hot-trim safe — Claude Code re-walks the chain each turn)'}`,
  ].filter(l => l !== '').join('\n');

  return {
    content: [{ type: 'text', text: report }],
    structuredContent: {
      applied: plan.entries.length,
      dropped: orphanDrops ? droppedUuids.size : stats.droppedActual,
      droppedMode: orphanDrops ? 'orphan' : 'physical-remove',
      distilled,
      bytesBefore: stats.sizeBefore,
      bytesAfter: stats.sizeAfter,
      reductionPct,
      backupPath,
      requiresResume
    }
  };
}

export const APPLY_INTERNALS = {
  computeReparentingMap,
  makeDistilledEntry,
  entryHasToolUseOrResult,
  pruneOldBackups,
  findPlanFile,
  BACKUP_RETENTION
};
