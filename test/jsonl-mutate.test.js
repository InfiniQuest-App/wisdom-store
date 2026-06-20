/**
 * Tests for the shared rewriteJsonl({drop, replace, append}) primitive.
 * Verifies the same race-guard + atomic-write semantics that prune-context
 * and sandwich-prune originally inlined inside their own implementations.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { rewriteJsonl } from '../src/mcp-server/lib/jsonl-mutate.js';

const TMP_DIR = path.join(os.tmpdir(), 'wisdom-store-jsonl-mutate-test-' + process.pid);

function ensure() { fs.mkdirSync(TMP_DIR, { recursive: true }); }
function cleanup() { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {} }
test.after(cleanup);

function makeFile(entries) {
  ensure();
  const p = path.join(TMP_DIR, randomUUID() + '.jsonl');
  fs.writeFileSync(p, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return p;
}

test('drop: removes entries by uuid', () => {
  const entries = [
    { uuid: 'a', body: 'A' },
    { uuid: 'b', body: 'B' },
    { uuid: 'c', body: 'C' }
  ];
  const filePath = makeFile(entries);
  const stats = rewriteJsonl(filePath, { drop: new Set(['b']) });
  assert.equal(stats.droppedActual, 1);
  assert.equal(stats.droppedCount, 1);
  const after = fs.readFileSync(filePath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(after.map(e => e.uuid), ['a', 'c']);
});

test('replace: substitutes entries by uuid (full body swap)', () => {
  const filePath = makeFile([
    { uuid: 'a', body: 'old-A', preserved: true },
    { uuid: 'b', body: 'B' }
  ]);
  const replace = new Map([['a', { uuid: 'a', body: 'new-A', preserved: true, extra: 'added' }]]);
  const stats = rewriteJsonl(filePath, { replace });
  assert.equal(stats.replacedActual, 1);
  const after = fs.readFileSync(filePath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(after[0].body, 'new-A');
  assert.equal(after[0].extra, 'added');
  assert.equal(after[0].preserved, true);
});

test('append: adds entries at end', () => {
  const filePath = makeFile([{ uuid: 'a', body: 'A' }]);
  const append = [{ uuid: 'z', body: 'Z' }];
  const stats = rewriteJsonl(filePath, { append });
  assert.equal(stats.appendedCount, 1);
  const after = fs.readFileSync(filePath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(after.map(e => e.uuid), ['a', 'z']);
});

test('combined drop+replace+append in single call', () => {
  const filePath = makeFile([
    { uuid: 'a', body: 'A' },
    { uuid: 'b', body: 'B' },
    { uuid: 'c', body: 'C' },
    { uuid: 'd', body: 'D' }
  ]);
  const stats = rewriteJsonl(filePath, {
    drop: new Set(['b']),
    replace: new Map([['c', { uuid: 'c', body: 'NEW-C' }]]),
    append: [{ uuid: 'e', body: 'E' }]
  });
  assert.equal(stats.droppedActual, 1);
  assert.equal(stats.replacedActual, 1);
  assert.equal(stats.appendedCount, 1);
  const after = fs.readFileSync(filePath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(after.map(e => e.uuid), ['a', 'c', 'd', 'e']);
  assert.equal(after[1].body, 'NEW-C');
});

test('preserves unparseable lines defensively (does not lose them)', () => {
  ensure();
  const p = path.join(TMP_DIR, randomUUID() + '.jsonl');
  fs.writeFileSync(p, '{"uuid":"a","body":"A"}\n!!!not-json!!!\n{"uuid":"b","body":"B"}\n');
  rewriteJsonl(p, { drop: new Set(['a']) });
  const after = fs.readFileSync(p, 'utf8').trim().split('\n');
  assert.equal(after.length, 2);
  assert.equal(after[0], '!!!not-json!!!');
  assert.equal(JSON.parse(after[1]).uuid, 'b');
});

test('drops blank lines from output', () => {
  ensure();
  const p = path.join(TMP_DIR, randomUUID() + '.jsonl');
  fs.writeFileSync(p, '{"uuid":"a"}\n\n{"uuid":"b"}\n\n');
  rewriteJsonl(p, {});
  const after = fs.readFileSync(p, 'utf8').split('\n').filter(l => l);
  assert.equal(after.length, 2);
});

test('race guard: throws when file size changes between read and write', () => {
  const filePath = makeFile([{ uuid: 'a', body: 'A' }, { uuid: 'b', body: 'B' }]);
  // Monkey-patch fs.statSync via a wrapper module — simpler: simulate by mid-call
  // appending. We do this by spying on fs.writeFileSync to append before the
  // race-guard re-stat. But the rewriteJsonl reads sizeBefore at the start, then
  // re-stats just before the tmp write. To deterministically trigger: manually
  // append between the two stats. We need access to that window.
  //
  // Approach: subclass fs.statSync to lie about the size. Use the global
  // process-level monkey-patch.
  const origStatSync = fs.statSync;
  let firstCall = true;
  fs.statSync = function (p) {
    const r = origStatSync.call(fs, p);
    if (firstCall && p === filePath) {
      firstCall = false;
      return { ...r, size: r.size - 5 }; // pretend file was smaller before
    }
    return r;
  };
  try {
    assert.throws(
      () => rewriteJsonl(filePath, { drop: new Set(['a']) }),
      /modified concurrently/
    );
  } finally {
    fs.statSync = origStatSync;
  }
});

test('atomic write: file content unchanged if rename throws', () => {
  const filePath = makeFile([{ uuid: 'a' }, { uuid: 'b' }]);
  const before = fs.readFileSync(filePath, 'utf8');
  const origRename = fs.renameSync;
  fs.renameSync = function () { throw new Error('simulated fs failure'); };
  try {
    assert.throws(() => rewriteJsonl(filePath, { drop: new Set(['a']) }), /simulated fs failure/);
  } finally {
    fs.renameSync = origRename;
  }
  // Original file should be unchanged
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
});
