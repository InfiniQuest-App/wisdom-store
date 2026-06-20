import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentTurns, TURN_SEGMENTER_INTERNALS } from '../src/mcp-server/lib/turn-segmenter.js';

const { isRealUserInput } = TURN_SEGMENTER_INTERNALS;

test('isRealUserInput: string content = real input', () => {
  assert.equal(isRealUserInput({ type: 'user', message: { content: 'hello' } }), true);
});

test('isRealUserInput: array content with text block = real input', () => {
  assert.equal(isRealUserInput({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }), true);
});

test('isRealUserInput: array content with ONLY tool_result = NOT real input', () => {
  assert.equal(isRealUserInput({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'output' }] } }), false);
});

test('isRealUserInput: array with mixed text+tool_result = real input (text trumps)', () => {
  assert.equal(isRealUserInput({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }, { type: 'text', text: 'and also...' }] }
  }), true);
});

test('isRealUserInput: assistant entry = NOT real input', () => {
  assert.equal(isRealUserInput({ type: 'assistant', message: { content: 'hi' } }), false);
});

test('isRealUserInput: missing entry = false', () => {
  assert.equal(isRealUserInput(null), false);
  assert.equal(isRealUserInput({}), false);
});

test('segmentTurns: groups assistant + tool_result follow-ups into the user prompt that started the turn', () => {
  // Synthesize a chain: user_prompt -> assistant_response -> user_tool_result -> assistant_followup -> user_next_prompt
  const chain = [
    { line: 0, data: { uuid: 'u1', type: 'user', timestamp: '2026-01-01T00:00:00Z' } },
    { line: 1, data: { uuid: 'a1', type: 'assistant', timestamp: '2026-01-01T00:00:01Z' } },
    { line: 2, data: { uuid: 'tr1', type: 'user', timestamp: '2026-01-01T00:00:02Z' } },
    { line: 3, data: { uuid: 'a2', type: 'assistant', timestamp: '2026-01-01T00:00:03Z' } },
    { line: 4, data: { uuid: 'u2', type: 'user', timestamp: '2026-01-01T00:00:04Z' } },
    { line: 5, data: { uuid: 'a3', type: 'assistant', timestamp: '2026-01-01T00:00:05Z' } }
  ];
  const fullByLine = {
    0: { type: 'user', message: { content: 'first prompt' } },
    1: { type: 'assistant', message: { content: 'response' } },
    2: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'res' }] } },
    3: { type: 'assistant', message: { content: 'follow-up' } },
    4: { type: 'user', message: { content: 'second prompt' } },
    5: { type: 'assistant', message: { content: 'second response' } }
  };
  const turns = segmentTurns(chain, (_fp, line) => fullByLine[line], '/fake');
  assert.equal(turns.length, 2);
  assert.equal(turns[0].entries.length, 4); // u1 + a1 + tr1 + a2
  assert.equal(turns[0].first_uuid, 'u1');
  assert.equal(turns[0].last_uuid, 'a2');
  assert.equal(turns[1].entries.length, 2); // u2 + a3
  assert.equal(turns[1].first_uuid, 'u2');
  assert.equal(turns[1].last_uuid, 'a3');
});

test('segmentTurns: empty chain returns []', () => {
  assert.deepEqual(segmentTurns([], () => null, '/fake'), []);
});

test('segmentTurns: chain starting with non-user entry still puts it in turn 1', () => {
  const chain = [
    { line: 0, data: { uuid: 'a1', type: 'assistant', timestamp: '2026-01-01T00:00:00Z' } },
    { line: 1, data: { uuid: 'u1', type: 'user', timestamp: '2026-01-01T00:00:01Z' } }
  ];
  const fullByLine = {
    0: { type: 'assistant', message: { content: 'orphan' } },
    1: { type: 'user', message: { content: 'real prompt' } }
  };
  const turns = segmentTurns(chain, (_fp, line) => fullByLine[line], '/fake');
  assert.equal(turns.length, 2);
  assert.equal(turns[0].entries[0].data.uuid, 'a1');
  assert.equal(turns[0].has_real_user_input, false);
  assert.equal(turns[1].entries[0].data.uuid, 'u1');
  assert.equal(turns[1].has_real_user_input, true);
});
