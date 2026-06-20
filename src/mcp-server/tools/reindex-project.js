/**
 * reindex_project tool
 *
 * Scan the project, extract symbols, and update:
 * - .wisdom/symbols.json (symbol registry)
 * - .wisdom/index.json (updated file list in index)
 */

import {
  findProjectRoot,
  getWisdomDir,
  readIndex,
  writeIndex
} from '../lib/wisdom.js';

import {
  scanProject,
  writeSymbols
} from '../lib/indexer.js';

export async function handleReindexProject(args) {
  const projectRoot = findProjectRoot(args.project_path);
  const wisdomDir = getWisdomDir(projectRoot, true);

  const startTime = Date.now();

  const options = {
    maxDepth: args.max_depth || 8,
    maxFiles: args.max_files || 2000
  };

  const result = scanProject(projectRoot, options);
  const elapsed = Date.now() - startTime;

  // Write symbols
  const symbolData = {
    _meta: {
      project: projectRoot,
      scanned: new Date().toISOString(),
      elapsed_ms: elapsed,
      file_count: result.files.length
    },
    ...result.symbols
  };
  writeSymbols(wisdomDir, symbolData);

  // Update index with file list
  const index = readIndex(wisdomDir);
  index.files = result.files.map(f => ({
    path: f.path,
    lang: f.lang,
    lines: f.lines,
    modified: f.modified
  }));
  index.lastIndexed = new Date().toISOString();
  writeIndex(wisdomDir, index);

  // Summary
  const funcCount = Object.keys(result.symbols.functions).length;
  const classCount = Object.keys(result.symbols.classes).length;
  const exportCount = Object.keys(result.symbols.exports).length;
  const varCount = Object.keys(result.symbols.variables).length;

  const summary = [
    `Indexed ${result.files.length} files in ${elapsed}ms`,
    ``,
    `### Symbols Found`,
    `- Functions: ${funcCount}`,
    `- Classes: ${classCount}`,
    `- Exports: ${exportCount}`,
    `- Variables: ${varCount}`,
    ``,
    `### Languages`,
  ];

  // Language breakdown
  const langCounts = {};
  for (const f of result.files) {
    langCounts[f.lang] = (langCounts[f.lang] || 0) + 1;
  }
  for (const [lang, count] of Object.entries(langCounts).sort()) {
    summary.push(`- ${lang}: ${count} files`);
  }

  summary.push('');
  summary.push(`Saved to .wisdom/symbols.json and updated .wisdom/index.json`);

  return {
    content: [{ type: 'text', text: summary.join('\n') }]
  };
}
