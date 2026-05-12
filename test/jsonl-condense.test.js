import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCondensePlan, CONDENSE_INTERNALS } from '../src/mcp-server/lib/jsonl-condense.js';

const { isMemoryStylePath, looksLikeImageBase64 } = CONDENSE_INTERNALS;

test('isMemoryStylePath: matches MEMORY.md, CLAUDE.md, .wisdom/, memory/, plans/', () => {
  assert.equal(isMemoryStylePath('/home/x/Projects/foo/MEMORY.md'), true);
  assert.equal(isMemoryStylePath('/home/x/Projects/foo/CLAUDE.md'), true);
  assert.equal(isMemoryStylePath('/home/x/Projects/foo/.wisdom/sections/auth.md'), true);
  assert.equal(isMemoryStylePath('/home/x/.claude/projects/-foo/memory/identity.md'), true);
  assert.equal(isMemoryStylePath('/home/x/Projects/foo/.wisdom/plans/v1.md'), true);
  // Non-matches
  assert.equal(isMemoryStylePath('/home/x/Projects/foo/src/auth.js'), false);
  assert.equal(isMemoryStylePath('/home/x/Projects/foo/README.md'), false);
});

test('looksLikeImageBase64: data: URI', () => {
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(2000);
  assert.equal(looksLikeImageBase64(big, {}), true);
});

test('looksLikeImageBase64: raw base64 with image file_path hint', () => {
  const text = 'A'.repeat(8000); // pure base64-ish
  assert.equal(looksLikeImageBase64(text, { file_path: '/tmp/foo.png' }), true);
  assert.equal(looksLikeImageBase64(text, { file_path: '/tmp/foo.txt' }), false);
});

test('looksLikeImageBase64: short text → false', () => {
  assert.equal(looksLikeImageBase64('hi', { file_path: '/tmp/foo.png' }), false);
});

test('buildCondensePlan: identical-reads mode marks older reads of same path', () => {
  const sameContent = 'X'.repeat(2000);
  const chain = [
    { uuid: 'a1', fullEntry: { uuid: 'a1', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/foo.txt' } }] } } },
    { uuid: 'r1', fullEntry: { uuid: 'r1', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: sameContent }] } } },
    { uuid: 'a2', fullEntry: { uuid: 'a2', message: { content: [{ type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: '/foo.txt' } }] } } },
    { uuid: 'r2', fullEntry: { uuid: 'r2', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: sameContent }] } } }
  ];
  const { replace, stats } = buildCondensePlan(chain, { modes: ['identical-reads'] });
  assert.equal(stats.identicalReadsCondensed, 1, 'should condense the older read (r1)');
  assert.ok(replace.has('r1'), 'older read uuid should be in replace map');
  assert.ok(!replace.has('r2'), 'newer read should not be condensed');
  // Marker text contains expected hints
  const newR1 = replace.get('r1');
  const newBlock = newR1.message.content[0];
  assert.ok(newBlock._condensed === true);
  assert.ok(newBlock.content.includes('byte-identical'));
});

test('buildCondensePlan: images mode condenses image-base64 tool_results (data: URI form)', () => {
  const imgContent = 'data:image/png;base64,' + 'B'.repeat(5000);
  const chain = [
    { uuid: 'a1', fullEntry: { uuid: 'a1', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/tmp/screenshot.png' } }] } } },
    { uuid: 'r1', fullEntry: { uuid: 'r1', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: imgContent }] } } }
  ];
  const { replace, stats } = buildCondensePlan(chain, { modes: ['images'] });
  assert.equal(stats.imagesCondensed, 1);
  assert.ok(replace.has('r1'));
  const newBlock = replace.get('r1').message.content[0];
  // Image block replacer rewrites tool_result.content from string/image-array to [{type:'text', text: marker}]
  assert.ok(Array.isArray(newBlock.content));
  assert.equal(newBlock.content[0].type, 'text');
  assert.ok(newBlock.content[0].text.includes('image elided'));
  assert.ok(newBlock.content[0].text.includes('screenshot.png'));
});

test('buildCondensePlan: images mode condenses array-of-image-blocks (Claude Code Read of image)', () => {
  // This is the actual shape Claude Code produces when Read is called against an
  // image file: tool_result.content is an array containing an `image` block.
  const chain = [
    { uuid: 'a1', fullEntry: { uuid: 'a1', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/tmp/screenshot.jpg' } }] } } },
    { uuid: 'r1', fullEntry: { uuid: 'r1', message: { content: [{
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'X'.repeat(5000) } }
      ]
    }] } } }
  ];
  const { replace, stats } = buildCondensePlan(chain, { modes: ['images'] });
  assert.equal(stats.imagesCondensed, 1);
  assert.ok(stats.imagesBytesSaved > 4000);
  const newBlock = replace.get('r1').message.content[0];
  assert.ok(Array.isArray(newBlock.content));
  assert.equal(newBlock.content[0].type, 'text');
  assert.ok(newBlock.content[0].text.includes('image elided'));
});

test('buildCondensePlan: memory-reads mode marks older reads of MEMORY.md', () => {
  const c1 = 'memory contents v1\n'.repeat(100);
  const c2 = 'memory contents v2\n'.repeat(100);
  const chain = [
    { uuid: 'a1', fullEntry: { uuid: 'a1', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/proj/MEMORY.md' } }] } } },
    { uuid: 'r1', fullEntry: { uuid: 'r1', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: c1 }] } } },
    { uuid: 'a2', fullEntry: { uuid: 'a2', message: { content: [{ type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: '/proj/MEMORY.md' } }] } } },
    { uuid: 'r2', fullEntry: { uuid: 'r2', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: c2 }] } } }
  ];
  const { replace, stats } = buildCondensePlan(chain, { modes: ['memory-reads'] });
  assert.equal(stats.memoryReadsCondensed, 1);
  assert.ok(replace.has('r1'));
  assert.ok(!replace.has('r2'));
  const newBlock = replace.get('r1').message.content[0];
  assert.ok(newBlock.content.includes('memory-style read'));
});

test('buildCondensePlan: idempotent — re-running on already-condensed file produces no further changes', () => {
  // Synthesize chain where r1 is already a condensed marker (short), r2 has fresh content
  const chain = [
    { uuid: 'a1', fullEntry: { uuid: 'a1', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/proj/MEMORY.md' } }] } } },
    { uuid: 'r1', fullEntry: { uuid: 'r1', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '[stale read elided: 5KB ...]' }] } } },
    { uuid: 'a2', fullEntry: { uuid: 'a2', message: { content: [{ type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: '/proj/MEMORY.md' } }] } } },
    { uuid: 'r2', fullEntry: { uuid: 'r2', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: 'fresh memory content '.repeat(100) }] } } }
  ];
  const { stats } = buildCondensePlan(chain, { modes: ['memory-reads'] });
  // r1 is below the 256-char threshold, so memory-reads should skip it
  assert.equal(stats.memoryReadsCondensed, 0);
});
