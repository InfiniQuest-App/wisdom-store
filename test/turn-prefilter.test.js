import test from 'node:test';
import assert from 'node:assert/strict';
import { preFilterTurn, PREFILTER_INTERNALS } from '../src/mcp-server/lib/turn-prefilter.js';

test('single-entry turn → micro/discardable', () => {
  const turn = { entries: [{ data: { uuid: 'u1' } }] };
  const fullEntries = [{ message: { content: 'hello' } }];
  const r = preFilterTurn(turn, fullEntries);
  assert.equal(r.type, 'micro');
  assert.equal(r.importance, 'discardable');
  assert.match(r._prefilterReason, /single-entry/);
});

test('2-entry turn no tool_use, short content → micro', () => {
  const turn = { entries: [{}, {}] };
  const fullEntries = [
    { message: { content: 'keep warm' } },
    { message: { content: 'standing by' } }
  ];
  const r = preFilterTurn(turn, fullEntries);
  assert.equal(r.type, 'micro');
  assert.equal(r.importance, 'discardable');
});

test('multi-entry turn WITH tool_use → not pre-filtered (needs Haiku)', () => {
  const turn = { entries: [{}, {}] };
  const fullEntries = [
    { message: { content: 'do X' } },
    { message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }
  ];
  assert.equal(preFilterTurn(turn, fullEntries), null);
});

test('multi-entry turn no tool_use BUT large content → not pre-filtered (likely a discussion)', () => {
  const turn = { entries: [{}, {}, {}] };
  const fullEntries = [
    { message: { content: 'design the auth flow with these constraints: '.repeat(40) } },
    { message: { content: 'thoughtful response to the design '.repeat(40) } },
    { message: { content: 'another big block of plaintext discussion '.repeat(20) } }
  ];
  assert.equal(preFilterTurn(turn, fullEntries), null);
});

test('preserves synthetic summary shape compatible with Pass 2', () => {
  const turn = { entries: [{ data: { uuid: 'u1' } }] };
  const fullEntries = [{ message: { content: 'wait' } }];
  const r = preFilterTurn(turn, fullEntries);
  // Required Pass-2 fields
  assert.ok(r.type);
  assert.ok(r.summary);
  assert.ok(Array.isArray(r.key_artifacts));
  assert.ok(r.duplicate_signal);
  assert.ok(r.importance);
});

test('totalContentChars handles string + array content', () => {
  assert.equal(PREFILTER_INTERNALS.totalContentChars([{ message: { content: 'abc' } }]), 3);
  assert.equal(PREFILTER_INTERNALS.totalContentChars([{ message: { content: [{ text: 'hi' }, { content: 'there' }] } }]), 7);
  assert.equal(PREFILTER_INTERNALS.totalContentChars([{}]), 0);
});

test('hasToolUseAnywhere detects nested tool_use blocks', () => {
  assert.equal(PREFILTER_INTERNALS.hasToolUseAnywhere([
    { message: { content: 'no tool here' } },
    { message: { content: [{ type: 'tool_use', name: 'Bash' }] } }
  ]), true);
  assert.equal(PREFILTER_INTERNALS.hasToolUseAnywhere([
    { message: { content: [{ type: 'text', text: 'just text' }] } }
  ]), false);
});

test('disable via 6+ entries even at small content', () => {
  const turn = { entries: Array(6).fill({}) };
  const fullEntries = Array(6).fill({ message: { content: 'tiny' } }); // 6 × 4 = 24 chars
  assert.equal(preFilterTurn(turn, fullEntries), null);
});
