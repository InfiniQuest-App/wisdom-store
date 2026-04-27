/**
 * Tests for sandwich_prune.
 *
 * The tool resolves files via ~/.claude/projects/<hash>/<conversationId>.jsonl,
 * so tests construct synthetic JSONL files there under a dedicated test hash
 * directory and clean up after themselves.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';

import { handleSandwichPrune } from '../src/mcp-server/tools/sandwich-prune.js';
import { readJsonl, walkChain, readJsonlLine } from '../src/mcp-server/lib/jsonl.js';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const TEST_HASH = '-tmp-wisdom-store-sandwich-prune-test-' + process.pid;
const TEST_DIR = path.join(PROJECTS_DIR, TEST_HASH);

function ensureTestDir() {
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

function cleanupTestDir() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

/**
 * Build a synthetic JSONL conversation file.
 *   - one file-history-snapshot session-config line at the top (no uuid)
 *   - `count` chain entries, alternating user/assistant by default
 *   - returns { filePath, conversationId, entries }
 */
function buildConversation({
  count,
  conversationId = randomUUID(),
  payloadBytes = 0,
  forceLargeFile = false,
  startWithUserOnly = false,
  // optional override: type per index, e.g. (i) => 'user' | 'assistant' | 'system'
  typeFn = null
}) {
  ensureTestDir();
  const filePath = path.join(TEST_DIR, `${conversationId}.jsonl`);
  const lines = [];

  // Session-level config (no uuid, no parentUuid)
  lines.push(JSON.stringify({
    type: 'file-history-snapshot',
    snapshot: { trackedFileBackups: {}, timestamp: '2026-01-01T00:00:00.000Z' },
    isSnapshotUpdate: false
  }));

  const sessionId = conversationId;
  let prevUuid = null;
  const entries = [];
  const filler = payloadBytes > 0 ? 'x'.repeat(payloadBytes) : '';

  for (let i = 0; i < count; i++) {
    const uuid = randomUUID();
    let type;
    if (typeFn) type = typeFn(i);
    else if (startWithUserOnly) type = 'user';
    else type = i % 2 === 0 ? 'user' : 'assistant';

    const entry = {
      parentUuid: prevUuid,
      isSidechain: false,
      userType: 'external',
      cwd: '/tmp/test',
      sessionId,
      version: '2.1.50',
      gitBranch: 'main',
      type,
      message: {
        role: type === 'assistant' ? 'assistant' : (type === 'system' ? 'system' : 'user'),
        content: `MSG_${i}_CONTENT_${filler}`
      },
      uuid,
      timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString()
    };
    lines.push(JSON.stringify(entry));
    entries.push({ uuid, type, content: `MSG_${i}_CONTENT_` });
    prevUuid = uuid;
  }

  // If we want to force a >50MB file but payloadBytes alone isn't enough, pad
  // the last entry with extra bulk in a way that doesn't change chain shape.
  let content = lines.join('\n') + '\n';
  if (forceLargeFile && Buffer.byteLength(content) <= 50 * 1024 * 1024) {
    // pad inside the last entry's message content so it's still valid JSON
    const target = 51 * 1024 * 1024;
    const padNeeded = target - Buffer.byteLength(content) + 100;
    const lastIdx = lines.length - 1;
    const lastObj = JSON.parse(lines[lastIdx]);
    lastObj.message.content = lastObj.message.content + 'P'.repeat(Math.max(0, padNeeded));
    lines[lastIdx] = JSON.stringify(lastObj);
    content = lines.join('\n') + '\n';
  }
  fs.writeFileSync(filePath, content);

  return { filePath, conversationId, entries };
}

test.after(() => cleanupTestDir());

test('happy path: 100-message chain, keep 5 + 20 → re-linked with bridge', async () => {
  cleanupTestDir();
  const { filePath, conversationId, entries } = buildConversation({ count: 100 });

  const result = await handleSandwichPrune({
    conversation_id: conversationId,
    keep_first_n: 5,
    keep_recent_n: 20
  });

  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Sandwich Prune Complete/);

  // Re-read the file: the new chain should be 5 early + 1 bridge + 20 recent = 26
  const after = readJsonl(filePath);
  const chain = walkChain(after);

  // Expect 26 chain entries
  assert.equal(chain.length, 26, `expected 26 chain entries, got ${chain.length}`);

  // The first 5 entries should be the original first 5
  for (let i = 0; i < 5; i++) {
    assert.equal(chain[i].data.uuid, entries[i].uuid, `early entry ${i} uuid mismatch`);
  }
  // Entry index 5 should be the bridge — type system, sandwich-prune marker
  const bridge = readJsonlLine(filePath, chain[5].line);
  assert.equal(bridge.type, 'system');
  assert.equal(bridge._sandwichPruneBridge, true);
  // Last 20 entries should be original entries[80..99]
  for (let i = 0; i < 20; i++) {
    const expectedUuid = entries[80 + i].uuid;
    assert.equal(chain[6 + i].data.uuid, expectedUuid, `recent entry ${i} uuid mismatch`);
  }

  // Session-level config (file-history-snapshot) should still be present
  const raw = fs.readFileSync(filePath, 'utf8');
  assert.match(raw, /"type":"file-history-snapshot"/);

  // Middle entries (index 5..79) should be physically removed (default behavior)
  for (let i = 5; i < 80; i++) {
    assert.ok(!raw.includes(entries[i].uuid), `middle entry ${i} (${entries[i].uuid}) should be gone`);
  }
});

test('NO-OP: chain too short (length <= keep_first_n + keep_recent_n)', async () => {
  cleanupTestDir();
  const { conversationId } = buildConversation({ count: 20 });
  const result = await handleSandwichPrune({
    conversation_id: conversationId,
    keep_first_n: 5,
    keep_recent_n: 20
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /NO-OP/);
});

test('NO-OP via overlap: keep_first_n + keep_recent_n meets exactly chain length', async () => {
  cleanupTestDir();
  const { conversationId } = buildConversation({ count: 25 });
  const result = await handleSandwichPrune({
    conversation_id: conversationId,
    keep_first_n: 5,
    keep_recent_n: 20
  });
  assert.match(result.content[0].text, /NO-OP/);
});

test('first_recent type=assistant → walks forward to find user/system', async () => {
  cleanupTestDir();
  // Build a chain where index 5 (first recent w/ keep_first_n=5, keep_recent_n=10
  // and chain length 15) is forced to be 'assistant'. The next one is 'user'.
  // Layout (15 chain entries, alternating but force index 5 to be assistant):
  //   idx 0 user, 1 user, 2 assistant, 3 user, 4 assistant, 5 assistant, 6 user, ...
  // With keep_first_n=5 (idx 0..4) and keep_recent_n=10 (idx 5..14), recentStart = 5 (assistant).
  // Tool should walk forward to idx 6 (user).
  const { filePath, conversationId, entries } = buildConversation({
    count: 16,
    typeFn: (i) => {
      if (i === 5) return 'assistant';
      return i % 2 === 0 ? 'user' : 'assistant';
    }
  });
  // Sanity: chain length 16, kept first 5 + kept recent 10 = 15 < 16 → has 1 to prune.
  // First-recent candidate = entries[6] (since entries[5] is assistant, walks to 6).
  // To make sure we have a 'user' at index 6:
  // typeFn: i=6 → even → 'user' ✓
  assert.equal(entries[5].type, 'assistant');
  assert.equal(entries[6].type, 'user');

  const result = await handleSandwichPrune({
    conversation_id: conversationId,
    keep_first_n: 5,
    keep_recent_n: 10
  });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.match(result.content[0].text, /Sandwich Prune Complete/);

  // The new chain root for the recent segment should be entries[6], not entries[5]
  const after = readJsonl(filePath);
  const chain = walkChain(after);
  // Find bridge in chain
  const bridgeIdx = chain.findIndex(c => {
    const full = readJsonlLine(filePath, c.line);
    return full?._sandwichPruneBridge === true;
  });
  assert.ok(bridgeIdx >= 0, 'bridge should be present');
  const firstRecentInChain = chain[bridgeIdx + 1];
  assert.equal(firstRecentInChain.data.uuid, entries[6].uuid, 'first recent should be entries[6] (the user one)');
});

test('insert_bridge_placeholder=false → direct re-link works', async () => {
  cleanupTestDir();
  const { filePath, conversationId, entries } = buildConversation({ count: 50 });
  const result = await handleSandwichPrune({
    conversation_id: conversationId,
    keep_first_n: 5,
    keep_recent_n: 10,
    insert_bridge_placeholder: false
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Sandwich Prune Complete/);

  const after = readJsonl(filePath);
  const chain = walkChain(after);

  // 5 early + 0 bridge + 10 recent = 15
  assert.equal(chain.length, 15);
  // First 5 are originals
  for (let i = 0; i < 5; i++) {
    assert.equal(chain[i].data.uuid, entries[i].uuid);
  }
  // Index 5 is entries[40] (the first of the recent 10), with parentUuid pointing
  // directly to entries[4].uuid (no bridge in between).
  assert.equal(chain[5].data.uuid, entries[40].uuid);
  const fullFirstRecent = readJsonlLine(filePath, chain[5].line);
  assert.equal(fullFirstRecent.parentUuid, entries[4].uuid);
});

test('remove_middle_orphans=false → middle stays in file as orphans', async () => {
  cleanupTestDir();
  const { filePath, conversationId, entries } = buildConversation({ count: 30 });
  const result = await handleSandwichPrune({
    conversation_id: conversationId,
    keep_first_n: 5,
    keep_recent_n: 10,
    remove_middle_orphans: false
  });
  assert.equal(result.isError, undefined);

  // Middle entries (idx 5..19) should still be in the file
  const raw = fs.readFileSync(filePath, 'utf8');
  for (let i = 5; i < 20; i++) {
    assert.ok(raw.includes(entries[i].uuid), `middle entry ${i} should still be in file as orphan`);
  }

  // But they should NOT be in the active chain
  const chain = walkChain(readJsonl(filePath));
  const chainUuids = new Set(chain.map(c => c.data.uuid));
  for (let i = 5; i < 20; i++) {
    assert.ok(!chainUuids.has(entries[i].uuid), `middle entry ${i} should not be in active chain`);
  }
});

test('large file (>50MB synthetic) → message content preserved across rewrite', async () => {
  cleanupTestDir();
  // Build ~120 messages with ~500KB each → ~60MB. Triggers lightweight reader path.
  const { filePath, conversationId, entries } = buildConversation({
    count: 120,
    payloadBytes: 500 * 1024,
    forceLargeFile: true
  });

  const stat = fs.statSync(filePath);
  assert.ok(stat.size > 50 * 1024 * 1024, `file should be >50MB to exercise lightweight path, got ${stat.size}`);

  const result = await handleSandwichPrune({
    conversation_id: conversationId,
    keep_first_n: 10,
    keep_recent_n: 20,
    remove_middle_orphans: false  // keep them so we can verify nothing was destroyed
  });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);

  // Verify a preserved early entry still has full content (not lightweight stub)
  const after = readJsonl(filePath);
  const earlyEntry = after.find(e => e.data.uuid === entries[4].uuid);
  assert.ok(earlyEntry, 'entries[4] should still be present');
  const fullEarly = readJsonlLine(filePath, earlyEntry.line);
  assert.ok(fullEarly?.message?.content?.includes('MSG_4_CONTENT_'), 'entries[4] should retain MSG_4_CONTENT_ marker');

  // The first-recent (entries[100]) was rewritten — verify its content survived
  const recentEntry = after.find(e => e.data.uuid === entries[100].uuid);
  assert.ok(recentEntry, 'entries[100] should be present');
  const fullRecent = readJsonlLine(filePath, recentEntry.line);
  assert.ok(fullRecent?.message?.content?.includes('MSG_100_CONTENT_'),
    'entries[100] message content should be preserved through rewrite (regression: lightweight subset would have wiped it)');

  // Bridge entry should be present and point at entries[9]
  const bridge = after.find(e => {
    const full = readJsonlLine(filePath, e.line);
    return full?._sandwichPruneBridge === true;
  });
  assert.ok(bridge, 'bridge should be present');
  const fullBridge = readJsonlLine(filePath, bridge.line);
  assert.equal(fullBridge.parentUuid, entries[9].uuid);

  // first_recent.parentUuid should now be the bridge uuid
  assert.equal(fullRecent.parentUuid, fullBridge.uuid);
});

test('rejects keep_first_n < 1', async () => {
  cleanupTestDir();
  const { conversationId } = buildConversation({ count: 50 });
  const result = await handleSandwichPrune({
    conversation_id: conversationId,
    keep_first_n: 0,
    keep_recent_n: 10
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /must each be >= 1/);
});

test('preserves session-level config (file-history-snapshot) entries', async () => {
  cleanupTestDir();
  const { filePath, conversationId } = buildConversation({ count: 30 });
  const before = fs.readFileSync(filePath, 'utf8');
  const beforeSnapCount = (before.match(/"type":"file-history-snapshot"/g) || []).length;

  await handleSandwichPrune({
    conversation_id: conversationId,
    keep_first_n: 5,
    keep_recent_n: 10
  });

  const after = fs.readFileSync(filePath, 'utf8');
  const afterSnapCount = (after.match(/"type":"file-history-snapshot"/g) || []).length;
  assert.equal(afterSnapCount, beforeSnapCount, 'session-level config should be preserved');
});
