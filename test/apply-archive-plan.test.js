/**
 * Tests for apply_archive_plan.
 *
 * The tool reads a plan file from `<conversation_dir>/.archive-plans/<planId>.json`,
 * so tests build a synthetic JSONL under `~/.claude/projects/<hash>/`, write a
 * matching plan file, and exercise the apply path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { randomUUID } from 'crypto';

import { handleApplyArchivePlan, APPLY_INTERNALS } from '../src/mcp-server/tools/apply-archive-plan.js';
import { ANALYZE_INTERNALS } from '../src/mcp-server/tools/analyze-for-archive.js';
import { readJsonl, walkChain, readJsonlLine } from '../src/mcp-server/lib/jsonl.js';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const TEST_HASH = '-tmp-wisdom-store-apply-archive-test-' + process.pid;
const TEST_DIR = path.join(PROJECTS_DIR, TEST_HASH);

function ensureTestDir() { fs.mkdirSync(TEST_DIR, { recursive: true }); }
function cleanupTestDir() { try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {} }
test.after(cleanupTestDir);

function buildJsonl({ count = 20, conversationId = randomUUID() } = {}) {
  ensureTestDir();
  const filePath = path.join(TEST_DIR, `${conversationId}.jsonl`);
  const lines = [];
  let prevUuid = null;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const uuid = randomUUID();
    const role = i % 2 === 0 ? 'user' : 'assistant';
    const messageContent = role === 'assistant'
      ? [{ type: 'text', text: `MSG_${i}_BODY` }]
      : `MSG_${i}_BODY`;
    const entry = {
      parentUuid: prevUuid,
      type: role,
      uuid,
      timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      sessionId: conversationId,
      message: { role, content: messageContent }
    };
    lines.push(JSON.stringify(entry));
    entries.push({ uuid, type: role });
    prevUuid = uuid;
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  return { filePath, conversationId, entries };
}

function writePlan({ filePath, conversationId, planEntries, chainEntries, jsonlMessages, lastMessageUuid }) {
  const planId = randomUUID();
  const planCore = {
    planId,
    jsonlPath: filePath,
    jsonlBytes: fs.statSync(filePath).size,
    jsonlMessages,
    lastMessageUuid,
    entries: planEntries
  };
  const checksum = crypto.createHash('sha256')
    .update(ANALYZE_INTERNALS.canonicalStringify(planCore))
    .digest('hex');
  const fullPlan = {
    ...planCore,
    checksum,
    createdAt: Date.now(),
    purpose: '',
    cost: '$0.00 — synthetic test plan',
    authMode: 'oauth',
    billing: 'subscription'
  };
  const planDir = path.join(TEST_DIR, '.archive-plans');
  fs.mkdirSync(planDir, { recursive: true });
  const planPath = path.join(planDir, `${planId}.json`);
  fs.writeFileSync(planPath, JSON.stringify(fullPlan, null, 2));
  return { planId, checksum, planPath };
}

test('refuses without confirm:true', async () => {
  cleanupTestDir();
  const { filePath, conversationId, entries } = buildJsonl({ count: 10 });
  const { planId, checksum } = writePlan({
    filePath, conversationId,
    planEntries: [{ uuid: entries[3].uuid, action: 'drop', reason: 'test' }],
    jsonlMessages: 10,
    lastMessageUuid: entries[9].uuid
  });
  const result = await handleApplyArchivePlan({ planId, checksum });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /confirm.*true/i);
});

test('refuses on missing planId', async () => {
  const result = await handleApplyArchivePlan({ checksum: 'x', confirm: true });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /required/);
});

test('refuses on plan not found', async () => {
  const result = await handleApplyArchivePlan({ planId: randomUUID(), checksum: 'x', confirm: true });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not found/i);
});

test('refuses on checksum mismatch', async () => {
  cleanupTestDir();
  const { filePath, conversationId, entries } = buildJsonl({ count: 10 });
  const { planId } = writePlan({
    filePath, conversationId,
    planEntries: [{ uuid: entries[3].uuid, action: 'drop', reason: 'test' }],
    jsonlMessages: 10,
    lastMessageUuid: entries[9].uuid
  });
  const result = await handleApplyArchivePlan({ planId, checksum: 'wrong-checksum', confirm: true });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /checksum/);
});

test('refuses on drift: lastMessageUuid changed', async () => {
  cleanupTestDir();
  const { filePath, conversationId, entries } = buildJsonl({ count: 10 });
  const { planId, checksum } = writePlan({
    filePath, conversationId,
    planEntries: [{ uuid: entries[3].uuid, action: 'drop', reason: 'test' }],
    jsonlMessages: 10,
    lastMessageUuid: 'wrong-uuid-pretending-something-else'
  });
  const result = await handleApplyArchivePlan({ planId, checksum, confirm: true });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /drifted/);
});

test('refuses on drift: chain length changed', async () => {
  cleanupTestDir();
  const { filePath, conversationId, entries } = buildJsonl({ count: 10 });
  const { planId, checksum } = writePlan({
    filePath, conversationId,
    planEntries: [{ uuid: entries[3].uuid, action: 'drop', reason: 'test' }],
    jsonlMessages: 99,  // wrong count
    lastMessageUuid: entries[9].uuid
  });
  const result = await handleApplyArchivePlan({ planId, checksum, confirm: true });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /drifted/);
});

test('happy path with orphan_drops:false: physically removes entries + reparents survivors', async () => {
  cleanupTestDir();
  const { filePath, conversationId, entries } = buildJsonl({ count: 10 });
  // i%2==0 → user, so entries[3] = assistant, entries[5] = assistant.
  // After drop: entries[4].parentUuid was entries[3].uuid → must rewrite to entries[2].uuid
  //             entries[6].parentUuid was entries[5].uuid → must rewrite to entries[4].uuid (still kept)
  const { planId, checksum } = writePlan({
    filePath, conversationId,
    planEntries: [
      { uuid: entries[3].uuid, action: 'drop', reason: 'duplicate' },
      { uuid: entries[5].uuid, action: 'drop', reason: 'large tool output' }
    ],
    jsonlMessages: 10,
    lastMessageUuid: entries[9].uuid
  });
  // Explicit physical-remove mode (orphan_drops: false)
  const result = await handleApplyArchivePlan({ planId, checksum, confirm: true, orphan_drops: false });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.match(result.content[0].text, /Applied/);
  assert.equal(result.structuredContent.dropped, 2);
  assert.equal(result.structuredContent.droppedMode, 'physical-remove');

  // Verify backup was created before mutation
  const backupDir = path.join(TEST_DIR, '.archive-backups');
  const backups = fs.readdirSync(backupDir);
  assert.equal(backups.length, 1);
  const backupContent = fs.readFileSync(path.join(backupDir, backups[0]), 'utf8');
  for (const e of entries) {
    assert.ok(backupContent.includes(e.uuid), `backup should contain ${e.uuid}`);
  }

  // Physical-remove: dropped entries are GONE from live file
  const liveContent = fs.readFileSync(filePath, 'utf8');
  assert.ok(!liveContent.includes(entries[3].uuid));
  assert.ok(!liveContent.includes(entries[5].uuid));

  // Reparenting: entries[4].parentUuid should now be entries[2].uuid
  const after = readJsonl(filePath);
  const e4 = after.find(e => e.data.uuid === entries[4].uuid);
  const fullE4 = readJsonlLine(filePath, e4.line);
  assert.equal(fullE4.parentUuid, entries[2].uuid);
  const chain = walkChain(after);
  assert.equal(chain.length, 8, `expected 8 chain entries (10 - 2 physically dropped), got ${chain.length}`);
});

test('default (orphan_drops:true): dropped entries STAY in file but become unreachable from chain', async () => {
  cleanupTestDir();
  const { filePath, conversationId, entries } = buildJsonl({ count: 10 });
  const { planId, checksum } = writePlan({
    filePath, conversationId,
    planEntries: [
      { uuid: entries[3].uuid, action: 'drop', reason: 'duplicate' },
      { uuid: entries[5].uuid, action: 'drop', reason: 'large tool output' }
    ],
    jsonlMessages: 10,
    lastMessageUuid: entries[9].uuid
  });
  // Default mode — orphan_drops not set, should default to true
  const result = await handleApplyArchivePlan({ planId, checksum, confirm: true });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.equal(result.structuredContent.droppedMode, 'orphan');

  // Orphan mode: dropped entries STAY in file
  const liveContent = fs.readFileSync(filePath, 'utf8');
  assert.ok(liveContent.includes(entries[3].uuid), 'orphaned entries[3] should still be in file');
  assert.ok(liveContent.includes(entries[5].uuid), 'orphaned entries[5] should still be in file');

  // BUT they are not in the active chain — reparenting cascades past them
  const after = readJsonl(filePath);
  const chain = walkChain(after);
  assert.equal(chain.length, 8, `chain should be 8 (10 - 2 orphaned), got ${chain.length}`);
  const chainUuids = new Set(chain.map(c => c.data.uuid));
  assert.ok(!chainUuids.has(entries[3].uuid), 'entries[3] not in active chain');
  assert.ok(!chainUuids.has(entries[5].uuid), 'entries[5] not in active chain');

  // Reparenting: entries[4].parentUuid should now be entries[2].uuid
  const e4 = after.find(e => e.data.uuid === entries[4].uuid);
  const fullE4 = readJsonlLine(filePath, e4.line);
  assert.equal(fullE4.parentUuid, entries[2].uuid);
});

test('distill: replaces content, preserves uuid+parentUuid, sets requiresResume', async () => {
  cleanupTestDir();
  const { filePath, conversationId, entries } = buildJsonl({ count: 10 });
  const distillation = '[Distilled summary: tried X, failed because Y, settled on Z]';
  const { planId, checksum } = writePlan({
    filePath, conversationId,
    planEntries: [{ uuid: entries[5].uuid, action: 'distill', distillation, reason: 'failed approach worth keeping' }],
    jsonlMessages: 10,
    lastMessageUuid: entries[9].uuid
  });
  const result = await handleApplyArchivePlan({ planId, checksum, confirm: true });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.equal(result.structuredContent.distilled, 1);
  assert.equal(result.structuredContent.requiresResume, true);

  // Find the distilled entry — uuid + parentUuid preserved, content replaced
  const after = readJsonl(filePath);
  const distilled = after.find(e => e.data.uuid === entries[5].uuid);
  assert.ok(distilled, 'distilled entry kept');
  const full = readJsonlLine(filePath, distilled.line);
  assert.equal(full.parentUuid, entries[4].uuid, 'parentUuid preserved through distill');
  // Content should be the distillation text — for assistant role, in content[0].text
  const content = Array.isArray(full.message.content)
    ? full.message.content[0]?.text
    : full.message.content;
  assert.equal(content, distillation);
  assert.equal(full._archiveDistilled, true);
});

test('refuses if drop cascade would make first surviving root be non-user/system', async () => {
  cleanupTestDir();
  // Build a chain where index 0 is user, 1 is assistant, then drop index 0 →
  // index 1 (assistant) would become the new root. Should be refused.
  const { filePath, conversationId, entries } = buildJsonl({ count: 10 });
  // entries[0] = user (i%2==0), entries[1] = assistant. Drop entries[0].
  const { planId, checksum } = writePlan({
    filePath, conversationId,
    planEntries: [{ uuid: entries[0].uuid, action: 'drop', reason: 'older copy' }],
    jsonlMessages: 10,
    lastMessageUuid: entries[9].uuid
  });
  const result = await handleApplyArchivePlan({ planId, checksum, confirm: true });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Cannot apply.*chain root/);
  // Backup should still exist (created before validation)
  const backupDir = path.join(TEST_DIR, '.archive-backups');
  assert.ok(fs.existsSync(backupDir));
  // Live file should be unchanged
  const live = readJsonl(filePath);
  assert.equal(live.length, 10);
});

test('TTL expiry: refuses old plan', async () => {
  cleanupTestDir();
  const { filePath, conversationId, entries } = buildJsonl({ count: 10 });
  const { planId, checksum, planPath } = writePlan({
    filePath, conversationId,
    planEntries: [{ uuid: entries[3].uuid, action: 'drop', reason: 'test' }],
    jsonlMessages: 10,
    lastMessageUuid: entries[9].uuid
  });
  // Forge createdAt to be older than TTL
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  plan.createdAt = Date.now() - (ANALYZE_INTERNALS.PLAN_TTL_MS + 60000);
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

  const result = await handleApplyArchivePlan({ planId, checksum, confirm: true });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /expired/);
});

test('backup retention: keeps last 3, prunes older', async () => {
  cleanupTestDir();
  const { filePath, conversationId, entries } = buildJsonl({ count: 10 });
  const backupDir = path.join(TEST_DIR, '.archive-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  // Pre-create 4 fake older backups for this conv
  const convId = path.basename(filePath, '.jsonl');
  for (let i = 0; i < 4; i++) {
    const p = path.join(backupDir, `${convId}.${1000000 + i}.jsonl`);
    fs.writeFileSync(p, `dummy backup ${i}`);
  }
  // Apply a plan — pruneOldBackups should run after the new backup is created
  const { planId, checksum } = writePlan({
    filePath, conversationId,
    planEntries: [{ uuid: entries[3].uuid, action: 'drop', reason: 'test' }],
    jsonlMessages: 10,
    lastMessageUuid: entries[9].uuid
  });
  await handleApplyArchivePlan({ planId, checksum, confirm: true });
  const remaining = fs.readdirSync(backupDir).filter(f => f.endsWith('.jsonl'));
  assert.equal(remaining.length, APPLY_INTERNALS.BACKUP_RETENTION,
    `expected ${APPLY_INTERNALS.BACKUP_RETENTION} backups, got ${remaining.length}: ${remaining.join(', ')}`);
});

test('computeReparentingMap: cascades through consecutive drops', () => {
  // Synthetic chain: A → B → C → D → E, drop B and C
  const chain = [
    { data: { uuid: 'A', parentUuid: null } },
    { data: { uuid: 'B', parentUuid: 'A' } },
    { data: { uuid: 'C', parentUuid: 'B' } },
    { data: { uuid: 'D', parentUuid: 'C' } },
    { data: { uuid: 'E', parentUuid: 'D' } }
  ];
  const reparent = APPLY_INTERNALS.computeReparentingMap(chain, new Set(['B', 'C']));
  assert.equal(reparent.get('D'), 'A', 'D should cascade past B,C to A');
  assert.equal(reparent.has('E'), false, 'E parentUuid (D) is kept — no rewrite');
});

test('computeReparentingMap: returns null parent when no surviving ancestor', () => {
  const chain = [
    { data: { uuid: 'A', parentUuid: null } },
    { data: { uuid: 'B', parentUuid: 'A' } },
    { data: { uuid: 'C', parentUuid: 'B' } }
  ];
  const reparent = APPLY_INTERNALS.computeReparentingMap(chain, new Set(['A', 'B']));
  assert.equal(reparent.get('C'), null, 'C becomes new root');
});

test('refuses to distill an entry containing a tool_use block', async () => {
  cleanupTestDir();
  ensureTestDir();
  // Build a JSONL with one assistant entry that has a tool_use block
  const conversationId = randomUUID();
  const filePath = path.join(TEST_DIR, `${conversationId}.jsonl`);
  const u1 = randomUUID(), u2 = randomUUID(), u3 = randomUUID();
  const lines = [
    JSON.stringify({ uuid: u1, parentUuid: null, type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'do X' } }),
    JSON.stringify({ uuid: u2, parentUuid: u1, type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }] } }),
    JSON.stringify({ uuid: u3, parentUuid: u2, type: 'user', timestamp: '2026-01-01T00:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'a b c' }] } })
  ];
  fs.writeFileSync(filePath, lines.join('\n') + '\n');

  const { planId, checksum } = writePlan({
    filePath, conversationId,
    planEntries: [{ uuid: u2, action: 'distill', distillation: 'tried Bash', reason: 'long output' }],
    jsonlMessages: 3,
    lastMessageUuid: u3
  });

  const result = await handleApplyArchivePlan({ planId, checksum, confirm: true });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /tool_use|tool_result/);
  // No mutation should have happened
  const after = fs.readFileSync(filePath, 'utf8');
  assert.ok(after.includes('"name":"Bash"'), 'tool_use block should still be present');
});

test('entryHasToolUseOrResult: detects tool_use, tool_result, and skips text-only', () => {
  assert.equal(APPLY_INTERNALS.entryHasToolUseOrResult({ message: { content: [{ type: 'tool_use' }] } }), 'tool_use');
  assert.equal(APPLY_INTERNALS.entryHasToolUseOrResult({ message: { content: [{ type: 'tool_result' }] } }), 'tool_result');
  assert.equal(APPLY_INTERNALS.entryHasToolUseOrResult({ message: { content: [{ type: 'text', text: 'hi' }] } }), null);
  assert.equal(APPLY_INTERNALS.entryHasToolUseOrResult({ message: { content: 'string' } }), null);
  assert.equal(APPLY_INTERNALS.entryHasToolUseOrResult({}), null);
});
