/**
 * get_project_overview tool
 *
 * Returns a compact project map showing file structure and key symbols.
 * Always runs a fresh scan for accuracy (~1-2s).
 */

import {
  findProjectRoot,
  getWisdomDir,
  readIndex,
  writeIndex
} from '../lib/wisdom.js';

import {
  scanProject,
  generateOverview,
  writeSymbols
} from '../lib/indexer.js';

export async function handleGetProjectOverview(args) {
  const projectRoot = findProjectRoot(args.project_path);
  const wisdomDir = getWisdomDir(projectRoot, true);

  const startTime = Date.now();
  const scanResult = scanProject(projectRoot);
  const elapsed = Date.now() - startTime;

  // Save updated symbols and index
  const symbolData = {
    _meta: {
      project: projectRoot,
      scanned: new Date().toISOString(),
      elapsed_ms: elapsed,
      file_count: scanResult.files.length
    },
    ...scanResult.symbols
  };
  writeSymbols(wisdomDir, symbolData);

  const index = readIndex(wisdomDir);
  index.files = scanResult.files.map(f => ({
    path: f.path,
    lang: f.lang,
    lines: f.lines,
    modified: f.modified
  }));
  index.lastIndexed = new Date().toISOString();
  writeIndex(wisdomDir, index);

  const overview = generateOverview(projectRoot, scanResult);
  const footer = `\n---\n*Fresh scan: ${scanResult.files.length} files in ${elapsed}ms.*`;

  return {
    content: [{ type: 'text', text: overview + footer }]
  };
}
