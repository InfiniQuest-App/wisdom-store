/**
 * check_symbols tool
 *
 * Given a list of symbol names, cross-reference against the registry.
 * Reports:
 * - known: confirmed symbols (skip in output for brevity)
 * - fuzzy: possible typos (name + suggestion + distance)
 * - unknown: new or potentially hallucinated symbols
 *
 * Context-efficient: only reports fuzzy matches and unknowns.
 * Known symbols are counted but not listed unless requested.
 */

import {
  findProjectRoot,
  getWisdomDir
} from '../lib/wisdom.js';

import {
  checkSymbols,
  readSymbols
} from '../lib/indexer.js';

export async function handleCheckSymbols(args) {
  if (!args.symbols || !Array.isArray(args.symbols) || args.symbols.length === 0) {
    return {
      content: [{ type: 'text', text: 'Provide an array of symbol names to check.' }],
      isError: true
    };
  }

  const projectRoot = findProjectRoot(args.project_path);
  const wisdomDir = getWisdomDir(projectRoot);
  const registry = readSymbols(wisdomDir);

  if (!registry) {
    return {
      content: [{ type: 'text', text: 'No symbol registry found. Run `reindex_project` first.' }],
      isError: true
    };
  }

  // Strip _meta before checking
  const { _meta, ...symbolCategories } = registry;
  const result = checkSymbols(args.symbols, symbolCategories);

  const lines = [];

  // Only report issues (context-efficient)
  if (result.fuzzy.length > 0) {
    lines.push(`### Possible Typos (${result.fuzzy.length})`);
    for (const f of result.fuzzy) {
      const usageNote = f.usages > 5 ? ' (well-established)' : f.usages === 1 ? ' (rarely used)' : '';
      lines.push(`- **${f.queried}** → did you mean **${f.suggestion}**? (${f.category}, ${f.file}:${f.line})${usageNote}`);
    }
    lines.push('');
  }

  if (result.unknown.length > 0) {
    lines.push(`### Unknown Symbols (${result.unknown.length})`);
    lines.push(`These are not in the registry — could be new, renamed, or hallucinated:`);
    for (const u of result.unknown) {
      lines.push(`- **${u.name}**`);
    }
    lines.push('');
  }

  if (result.fuzzy.length === 0 && result.unknown.length === 0) {
    lines.push(`All ${result.known.length} symbols confirmed in registry.`);
  } else {
    lines.push(`Summary: ${result.known.length} known, ${result.fuzzy.length} fuzzy, ${result.unknown.length} unknown`);
  }

  // Optionally include known symbols if verbose
  if (args.verbose && result.known.length > 0) {
    lines.push('');
    lines.push(`### Known Symbols (${result.known.length})`);
    for (const k of result.known) {
      lines.push(`- ${k.name} — ${k.category}, ${k.file}:${k.line}`);
    }
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
}
