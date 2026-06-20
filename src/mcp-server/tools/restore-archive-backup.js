/**
 * restore_archive_backup tool
 *
 * Safety net for bad apply_archive_plan decisions: restore the JSONL file from
 * its most recent backup (or a specified backup path).
 *
 * Backups live at `<conversation_dir>/.archive-backups/<convId>.<epoch>.jsonl`,
 * created by apply_archive_plan BEFORE any mutation. Retention is "last 3";
 * the oldest is pruned when a new backup is created.
 *
 * Restoration is via atomic copy + rename: the live JSONL is replaced wholesale.
 * Hot-restore semantics: Claude Code re-walks the chain each turn, so the
 * restored content is visible immediately without /resume. Distill-undo via
 * restore is fully supported (the original entries come back verbatim).
 */

import fs from 'fs';
import path from 'path';
import { findConversationFile } from '../lib/jsonl.js';

function listBackups(backupDir, convId) {
  try {
    return fs.readdirSync(backupDir)
      .filter(f => f.startsWith(`${convId}.`) && f.endsWith('.jsonl'))
      .map(f => {
        const full = path.join(backupDir, f);
        const st = fs.statSync(full);
        return { name: f, path: full, mtime: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

export async function handleRestoreArchiveBackup(args = {}) {
  // Resolve the live JSONL only when conversation_id is supplied (or when no
  // backupPath is given — i.e., we need findConversationFile's "most recent for
  // current project" semantics). If backupPath alone is supplied, infer the
  // live target from the backup filename to avoid silently restoring into the
  // current project's most-recent conversation.
  const liveJsonl = (args.conversation_id || !args.backupPath)
    ? findConversationFile(args.conversation_id)
    : null;
  if (!liveJsonl && !args.backupPath) {
    return {
      content: [{ type: 'text', text: 'No conversation file found and no backupPath provided.' }],
      isError: true
    };
  }

  let backupPath = args.backupPath;
  let targetJsonl = liveJsonl;

  if (!backupPath) {
    const convId = path.basename(liveJsonl, '.jsonl');
    const backupDir = path.join(path.dirname(liveJsonl), '.archive-backups');
    const backups = listBackups(backupDir, convId);
    if (backups.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No backups found in ${backupDir}. apply_archive_plan creates backups automatically before mutation; if no archival has been applied, there's nothing to restore.`
        }],
        isError: true
      };
    }
    backupPath = backups[0].path;
  } else {
    if (!fs.existsSync(backupPath)) {
      return {
        content: [{ type: 'text', text: `Backup file not found: ${backupPath}` }],
        isError: true
      };
    }
    // If caller supplied backupPath without conversation_id, infer the live target
    // from the backup filename: `<convId>.<epoch>.jsonl` → `<convId>.jsonl` in
    // the parent's parent directory (.archive-backups → conversation dir).
    if (!targetJsonl) {
      const fname = path.basename(backupPath);
      const m = fname.match(/^([0-9a-f-]+)\.\d+\.jsonl$/);
      if (!m) {
        return {
          content: [{
            type: 'text',
            text: `Could not infer live JSONL from backup filename '${fname}'. Provide conversation_id explicitly.`
          }],
          isError: true
        };
      }
      const convDir = path.dirname(path.dirname(backupPath)); // strip .archive-backups
      targetJsonl = path.join(convDir, `${m[1]}.jsonl`);
    }
  }

  if (!targetJsonl) {
    return {
      content: [{ type: 'text', text: 'Could not resolve target JSONL to restore into.' }],
      isError: true
    };
  }

  // Pre-restore safety snapshot — copy current live file to a `.pre-restore`
  // sibling, in case the user wants to undo the restore. Best-effort; not
  // load-bearing on the restore itself.
  let preRestorePath = null;
  if (fs.existsSync(targetJsonl)) {
    preRestorePath = targetJsonl + '.pre-restore-' + Date.now();
    try { fs.copyFileSync(targetJsonl, preRestorePath); }
    catch { preRestorePath = null; }
  }

  // Atomic restore: copy backup → tmp → rename onto live. Same-fs rename is
  // atomic on POSIX. We don't use the size-based race guard here because the
  // operation is by definition replacing the live file's content; concurrent
  // appends would still be lost, but the user explicitly asked for restoration.
  const sizeBefore = fs.existsSync(targetJsonl) ? fs.statSync(targetJsonl).size : 0;
  const sizeBackup = fs.statSync(backupPath).size;
  const tmpPath = targetJsonl + '.tmp-restore-' + process.pid + '-' + Date.now();
  fs.copyFileSync(backupPath, tmpPath);
  try {
    fs.renameSync(tmpPath, targetJsonl);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    return {
      content: [{ type: 'text', text: `Restore failed during rename: ${e.message}. Pre-restore snapshot at ${preRestorePath || 'none (could not capture)'}.` }],
      isError: true
    };
  }

  const report = [
    `## restore_archive_backup — Restored`,
    ``,
    `**Restored from**: \`${backupPath}\``,
    `**Restored to**: \`${targetJsonl}\``,
    `**Size**: ${(sizeBefore / 1024).toFixed(0)} KB → ${(sizeBackup / 1024).toFixed(0)} KB`,
    preRestorePath ? `**Pre-restore snapshot**: \`${preRestorePath}\` (lets you re-undo if needed)` : '**Pre-restore snapshot**: not captured (target did not exist or copy failed)',
    ``,
    `Hot-restore: Claude Code re-walks the chain each turn — restored content is visible immediately without /resume.`,
  ].filter(l => l !== '').join('\n');

  return {
    content: [{ type: 'text', text: report }],
    structuredContent: {
      restoredFrom: backupPath,
      restoredTo: targetJsonl,
      sizeBefore,
      sizeAfter: sizeBackup,
      preRestoreSnapshot: preRestorePath
    }
  };
}
