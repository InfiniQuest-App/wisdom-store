/**
 * get_wisdom tool
 *
 * Retrieve wisdom for a file, section, or keyword.
 * Progressive disclosure: returns compact index first, full details on request.
 *
 * Modes:
 * - file_path: returns sidecar wisdom for that file
 * - section: returns section wisdom from .wisdom/sections/
 * - keyword: searches all wisdom for matches
 * - plan: returns a specific plan from .wisdom/plans/
 * - overview: returns the project wisdom index (compact)
 */

import fs from 'fs';
import path from 'path';
import {
  findProjectRoot,
  getWisdomDir,
  readSidecar,
  readSection,
  readPlan,
  readPattern,
  readIndex,
  searchWisdom
} from '../lib/wisdom.js';

export async function handleGetWisdom(args) {
  const projectRoot = findProjectRoot();
  const wisdomDir = getWisdomDir(projectRoot);

  // Overview mode — return compact index
  if (args.mode === 'overview' || (!args.file_path && !args.section && !args.keyword && !args.plan)) {
    return getOverview(wisdomDir, projectRoot);
  }

  // File sidecar
  if (args.file_path) {
    const absPath = path.isAbsolute(args.file_path)
      ? args.file_path
      : path.join(projectRoot, args.file_path);
    const wisdom = readSidecar(absPath);
    if (!wisdom) {
      return { content: [{ type: 'text', text: `No wisdom found for ${args.file_path}` }] };
    }
    return {
      content: [{ type: 'text', text: formatSidecar(args.file_path, wisdom) }]
    };
  }

  // Section
  if (args.section) {
    const content = readSection(wisdomDir, args.section);
    if (!content) {
      return { content: [{ type: 'text', text: `No section found: ${args.section}` }] };
    }
    return { content: [{ type: 'text', text: content }] };
  }

  // Plan
  if (args.plan) {
    const content = readPlan(wisdomDir, args.plan);
    if (!content) {
      return { content: [{ type: 'text', text: `No plan found: ${args.plan}` }] };
    }
    return { content: [{ type: 'text', text: content }] };
  }

  // Keyword search
  if (args.keyword) {
    const results = searchWisdom(projectRoot, args.keyword);
    if (results.length === 0) {
      return { content: [{ type: 'text', text: `No wisdom found for keyword: "${args.keyword}"` }] };
    }
    return {
      content: [{ type: 'text', text: formatSearchResults(args.keyword, results) }]
    };
  }

  return {
    content: [{ type: 'text', text: 'Provide file_path, section, keyword, plan, or use mode:"overview".' }],
    isError: true
  };
}

function getOverview(wisdomDir, projectRoot) {
  const index = readIndex(wisdomDir);
  const lines = ['## Wisdom Overview\n'];

  // Sections
  const sectionNames = Object.keys(index.sections || {});
  if (sectionNames.length > 0) {
    lines.push(`### Sections (${sectionNames.length})`);
    for (const name of sectionNames) {
      const sec = index.sections[name];
      const files = sec.files ? sec.files.length : 0;
      const plans = sec.plans ? sec.plans.join(', ') : 'none';
      lines.push(`- **${name}**: ${files} files, plans: ${plans}`);
    }
    lines.push('');
  }

  // Plans
  const planNames = Object.keys(index.plans || {});
  if (planNames.length > 0) {
    lines.push(`### Plans (${planNames.length})`);
    for (const name of planNames) {
      const plan = index.plans[name];
      lines.push(`- **${name}**: ${plan.status || 'unknown'} — ${plan.sections?.join(', ') || 'no sections'}`);
    }
    lines.push('');
  }

  // Keywords
  const keywords = Object.keys(index.keywords || {});
  if (keywords.length > 0) {
    lines.push(`### Keywords (${keywords.length})`);
    lines.push(keywords.sort().join(', '));
    lines.push('');
  }

  // Check for sidecars in project
  const sidecars = findSidecars(projectRoot);
  if (sidecars.length > 0) {
    lines.push(`### Sidecar Files (${sidecars.length})`);
    for (const s of sidecars.slice(0, 20)) {
      lines.push(`- ${path.relative(projectRoot, s)}`);
    }
    if (sidecars.length > 20) lines.push(`- ... and ${sidecars.length - 20} more`);
    lines.push('');
  }

  if (sectionNames.length === 0 && planNames.length === 0 && keywords.length === 0 && sidecars.length === 0) {
    lines.push('*No wisdom stored yet. Use `save_wisdom` to start.*');
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function findSidecars(dir, depth = 0) {
  if (depth > 4) return [];
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findSidecars(fullPath, depth + 1));
      } else if (entry.name.endsWith('.wisdom')) {
        results.push(fullPath);
      }
    }
  } catch { /* ignore */ }
  return results;
}

function formatSidecar(filePath, sections) {
  const lines = [`## Wisdom: ${filePath}\n`];
  for (const [header, entries] of Object.entries(sections)) {
    lines.push(`### ${header}`);
    for (const entry of entries) {
      lines.push(`- ${entry}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function formatSearchResults(keyword, results) {
  const lines = [`## Search: "${keyword}" (${results.length} results)\n`];
  for (const r of results) {
    const source = r.source === 'sidecar' ? path.basename(r.file) : `${r.source}: ${r.file || r.ref}`;
    lines.push(`- **${source}**`);
    if (r.snippet) lines.push(`  ${r.snippet}`);
  }
  return lines.join('\n');
}
