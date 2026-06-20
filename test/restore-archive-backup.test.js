import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { handleRestoreArchiveBackup } from '../src/mcp-server/tools/restore-archive-backup.js';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const TEST_HASH = '-tmp-wisdom-store-restore-archive-test-' + process.pid;
const TEST_DIR = path.join(PROJECTS_DIR, TEST_HASH);

function ensure() { fs.mkdirSync(TEST_DIR, { recursive: true }); }
function cleanup() { try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {} }
test.after(cleanup);

function setupBackups({ count = 3, conversationId = randomUUID() } = {}) {
  ensure();
  const liveContent = `LIVE-CONTENT\n{"uuid":"${randomUUID()}"}\n`;
  const liveFile = path.join(TEST_DIR, `${conversationId}.jsonl`);
  fs.writeFileSync(liveFile, liveContent);

  const backupDir = path.join(TEST_DIR, '.archive-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backups = [];
  for (let i = 0; i < count; i++) {
    const epoch = Date.now() + i; // ensures distinct mtimes via filename
    const p = path.join(backupDir, `${conversationId}.${epoch}.jsonl`);
    const content = `BACKUP-${i}\n{"uuid":"backup-${i}"}\n`;
    fs.writeFileSync(p, content);
    // Force mtime ordering
    const t = (Date.now() / 1000) - (count - i) * 60; // older first
    fs.utimesSync(p, t, t);
    backups.push({ path: p, content });
  }
  return { liveFile, conversationId, backups };
}

test('restores most recent backup by default', async () => {
  cleanup();
  const { liveFile, conversationId, backups } = setupBackups({ count: 3 });
  const result = await handleRestoreArchiveBackup({ conversation_id: conversationId });
  assert.equal(result.isError, undefined, result.content[0].text);
  // Most recent backup is backups[2] (highest mtime / latest epoch)
  const restored = fs.readFileSync(liveFile, 'utf8');
  assert.equal(restored, backups[2].content);
});

test('restores from explicit backupPath', async () => {
  cleanup();
  const { liveFile, conversationId, backups } = setupBackups({ count: 3 });
  // Restore the OLDEST backup explicitly
  const result = await handleRestoreArchiveBackup({
    conversation_id: conversationId,
    backupPath: backups[0].path
  });
  assert.equal(result.isError, undefined);
  assert.equal(fs.readFileSync(liveFile, 'utf8'), backups[0].content);
});

test('refuses if no backups exist', async () => {
  cleanup();
  ensure();
  const conversationId = randomUUID();
  const liveFile = path.join(TEST_DIR, `${conversationId}.jsonl`);
  fs.writeFileSync(liveFile, 'live\n');
  // No backupDir at all
  const result = await handleRestoreArchiveBackup({ conversation_id: conversationId });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No backups found/);
});

test('refuses if explicit backupPath does not exist', async () => {
  cleanup();
  const { conversationId } = setupBackups({ count: 1 });
  const result = await handleRestoreArchiveBackup({
    conversation_id: conversationId,
    backupPath: '/nonexistent/path/backup.jsonl'
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not found/i);
});

test('captures pre-restore snapshot', async () => {
  cleanup();
  const { liveFile, conversationId, backups } = setupBackups({ count: 1 });
  const liveBefore = fs.readFileSync(liveFile, 'utf8');
  const result = await handleRestoreArchiveBackup({ conversation_id: conversationId });
  assert.equal(result.isError, undefined);
  const snap = result.structuredContent.preRestoreSnapshot;
  assert.ok(snap, 'preRestoreSnapshot should be set');
  assert.ok(fs.existsSync(snap), 'snapshot file should exist on disk');
  assert.equal(fs.readFileSync(snap, 'utf8'), liveBefore, 'snapshot should match pre-restore content');
});

test('infers live target from backupPath when conversation_id omitted', async () => {
  cleanup();
  const { conversationId, backups, liveFile } = setupBackups({ count: 1 });
  // Delete the live file to ensure findConversationFile won't find it via mtime
  fs.unlinkSync(liveFile);
  // Recreate (simulate that the live file exists but we don't know which conv it is)
  fs.writeFileSync(liveFile, 'pre-restore-other\n');
  const result = await handleRestoreArchiveBackup({ backupPath: backups[0].path });
  assert.equal(result.isError, undefined, result.content[0].text);
  // Should restore to a sibling at <conversationDir>/<convId>.jsonl
  assert.equal(result.structuredContent.restoredTo, liveFile);
  assert.equal(fs.readFileSync(liveFile, 'utf8'), backups[0].content);
});
