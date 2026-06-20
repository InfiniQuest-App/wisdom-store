/**
 * save_wisdom tool
 *
 * Write wisdom to a sidecar file or section.
 * Types: lesson, pattern, caution, edge_case, decision
 *
 * If a file_path is provided, writes to <file_path>.wisdom (sidecar).
 * If a section is provided, writes to .wisdom/sections/<section>.md.
 * If scope is "global", writes to ~/.claude/wisdom/.
 */

import path from 'path';
import fs from 'fs';
import {
  findProjectRoot,
  getWisdomDir,
  writeSidecar,
  writeSection,
  readSection,
  writePattern,
  updateIndexKeywords,
  WISDOM_TYPES
} from '../lib/wisdom.js';

export async function handleSaveWisdom(args) {
  if (!args.content || !args.content.trim()) {
    return {
      content: [{ type: 'text', text: 'Content is required.' }],
      isError: true
    };
  }

  const wisdomType = args.wisdom_type || 'lesson';
  if (!WISDOM_TYPES.includes(wisdomType)) {
    return {
      content: [{ type: 'text', text: `Invalid wisdom_type: ${wisdomType}. Valid: ${WISDOM_TYPES.join(', ')}` }],
      isError: true
    };
  }

  const projectRoot = findProjectRoot();
  const wisdomDir = getWisdomDir(projectRoot, true);

  let target;

  if (args.file_path) {
    // Write to sidecar
    const absPath = path.isAbsolute(args.file_path)
      ? args.file_path
      : path.join(projectRoot, args.file_path);
    writeSidecar(absPath, wisdomType, args.content);
    target = `${args.file_path}.wisdom`;

    // Update index keywords if provided
    if (args.keywords && args.keywords.length > 0) {
      updateIndexKeywords(wisdomDir, args.keywords, args.file_path);
    }
  } else if (args.section) {
    // Write to section file
    const existing = readSection(wisdomDir, args.section) || `# ${args.section}\n`;
    const header = wisdomType.charAt(0).toUpperCase() + wisdomType.slice(1).replace('_', ' ');
    const date = new Date().toISOString().split('T')[0];
    const entry = `- **${args.content}** (${date})`;

    // Check if section has this header
    const headerRegex = new RegExp(`^## ${header}s?$`, 'm');
    let updated;
    if (headerRegex.test(existing)) {
      updated = existing.replace(headerRegex, `## ${header}s\n${entry}`);
    } else {
      updated = existing.trimEnd() + `\n\n## ${header}s\n${entry}\n`;
    }

    writeSection(wisdomDir, args.section, updated);
    target = `.wisdom/sections/${args.section}.md`;

    // Update index keywords if provided
    if (args.keywords && args.keywords.length > 0) {
      updateIndexKeywords(wisdomDir, args.keywords, `sections/${args.section}.md`);
    }
  } else if (args.scope === 'global') {
    // Write to global wisdom
    const globalDir = path.join(process.env.HOME || '/tmp', '.claude', 'wisdom');
    const subDir = wisdomType === 'pattern' ? 'patterns' : 'lessons';
    const dir = path.join(globalDir, subDir);
    fs.mkdirSync(dir, { recursive: true });

    // Use first keyword or content hash as filename
    const name = (args.keywords?.[0] || args.content.slice(0, 30)).replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    const filePath = path.join(dir, `${name}.md`);
    const date = new Date().toISOString().split('T')[0];
    const content = `# ${args.content.split('.')[0]}\n\n*Type*: ${wisdomType} | *Date*: ${date}\n\n${args.content}\n`;
    fs.writeFileSync(filePath, content);
    target = `~/.claude/wisdom/${subDir}/${name}.md`;
  } else {
    return {
      content: [{ type: 'text', text: 'Provide either file_path, section, or scope:"global".' }],
      isError: true
    };
  }

  return {
    content: [{ type: 'text', text: `Saved ${wisdomType} to ${target}` }]
  };
}
