/**
 * list_wisdom tool
 *
 * Browse what wisdom exists — by section, type, recency, or keyword.
 * Returns a compact overview for progressive disclosure.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  findProjectRoot,
  getWisdomDir,
  readIndex
} from '../lib/wisdom.js';

export async function handleListWisdom(args) {
  const projectRoot = findProjectRoot();
  const wisdomDir = getWisdomDir(projectRoot);

  if (!fs.existsSync(wisdomDir)) {
    return {
      content: [{ type: 'text', text: 'No .wisdom/ directory found. Use `save_wisdom` to start.' }]
    };
  }

  const filter = args.filter || 'all'; // all, sections, plans, patterns, sidecars, global
  const lines = [];

  if (filter === 'all' || filter === 'sections') {
    const sectionsDir = path.join(wisdomDir, 'sections');
    if (fs.existsSync(sectionsDir)) {
      const files = fs.readdirSync(sectionsDir).filter(f => f.endsWith('.md'));
      if (files.length > 0) {
        lines.push(`### Sections (${files.length})`);
        for (const f of files) {
          const stat = fs.statSync(path.join(sectionsDir, f));
          const size = (stat.size / 1024).toFixed(1);
          const modified = stat.mtime.toISOString().split('T')[0];
          lines.push(`- **${f.replace('.md', '')}** — ${size}KB, updated ${modified}`);
        }
        lines.push('');
      }
    }
  }

  if (filter === 'all' || filter === 'plans') {
    const plansDir = path.join(wisdomDir, 'plans');
    if (fs.existsSync(plansDir)) {
      const files = fs.readdirSync(plansDir).filter(f => f.endsWith('.md'));
      if (files.length > 0) {
        const index = readIndex(wisdomDir);
        lines.push(`### Plans (${files.length})`);
        for (const f of files) {
          const name = f.replace('.md', '');
          const plan = index.plans?.[name];
          const status = plan?.status || 'unknown';
          lines.push(`- **${name}** [${status}]`);
        }
        lines.push('');
      }
    }
  }

  if (filter === 'all' || filter === 'patterns') {
    const patternsDir = path.join(wisdomDir, 'patterns');
    if (fs.existsSync(patternsDir)) {
      const files = fs.readdirSync(patternsDir).filter(f => f.endsWith('.md'));
      if (files.length > 0) {
        lines.push(`### Patterns (${files.length})`);
        for (const f of files) {
          lines.push(`- ${f.replace('.md', '')}`);
        }
        lines.push('');
      }
    }
  }

  if (filter === 'all' || filter === 'sidecars') {
    const sidecars = findSidecarsSync(projectRoot);
    if (sidecars.length > 0) {
      lines.push(`### Sidecar Files (${sidecars.length})`);
      for (const s of sidecars.slice(0, 30)) {
        const rel = path.relative(projectRoot, s);
        const stat = fs.statSync(s);
        const modified = stat.mtime.toISOString().split('T')[0];
        lines.push(`- **${rel}** — updated ${modified}`);
      }
      if (sidecars.length > 30) lines.push(`- ... and ${sidecars.length - 30} more`);
      lines.push('');
    }
  }

  if (filter === 'all' || filter === 'global') {
    const globalDir = path.join(os.homedir(), '.claude', 'wisdom');
    if (fs.existsSync(globalDir)) {
      let globalCount = 0;
      for (const sub of ['patterns', 'lessons']) {
        const dir = path.join(globalDir, sub);
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
          if (files.length > 0) {
            lines.push(`### Global ${sub} (${files.length})`);
            for (const f of files) {
              lines.push(`- ${f.replace('.md', '')}`);
            }
            lines.push('');
            globalCount += files.length;
          }
        }
      }
      if (globalCount === 0 && filter === 'global') {
        lines.push('*No global wisdom yet.*');
      }
    }
  }

  if (lines.length === 0) {
    lines.push('*No wisdom found. Use `save_wisdom` to start.*');
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
}

function findSidecarsSync(dir, depth = 0) {
  if (depth > 4) return [];
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findSidecarsSync(fullPath, depth + 1));
      } else if (entry.name.endsWith('.wisdom')) {
        results.push(fullPath);
      }
    }
  } catch { /* ignore */ }
  return results;
}
