/**
 * Wisdom file utilities.
 *
 * Three-tier storage:
 *   ~/.claude/wisdom/           — Global (cross-project) patterns and lessons
 *   <project>/.wisdom/          — Project-level sections, plans, patterns, index
 *   <file>.wisdom               — File-specific sidecar (lessons, edge cases, cautions)
 *
 * Sidecar format: markdown with ## sections (Cautions, Edge Cases, Decisions, Lessons, etc.)
 * Index format: .wisdom/index.json mapping files ↔ sections ↔ plans ↔ keywords
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const GLOBAL_WISDOM_DIR = path.join(os.homedir(), '.claude', 'wisdom');

// Wisdom types that can be stored
export const WISDOM_TYPES = ['lesson', 'pattern', 'caution', 'edge_case', 'decision', 'plan'];

// Map wisdom types to markdown section headers
const TYPE_TO_HEADER = {
  caution: 'Cautions',
  edge_case: 'Edge Cases',
  decision: 'Decisions',
  lesson: 'Lessons',
  pattern: 'Patterns',
  plan: 'Plans'
};

/**
 * Find the project root from a working directory.
 * Looks for .git, package.json, or .wisdom/ as indicators.
 */
export function findProjectRoot(cwd) {
  let dir = cwd || process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git')) ||
        fs.existsSync(path.join(dir, 'package.json')) ||
        fs.existsSync(path.join(dir, '.wisdom'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return cwd || process.cwd();
}

/**
 * Get the .wisdom/ directory for a project, creating it if needed.
 */
export function getWisdomDir(projectRoot, create = false) {
  const wisdomDir = path.join(projectRoot, '.wisdom');
  if (create && !fs.existsSync(wisdomDir)) {
    fs.mkdirSync(wisdomDir, { recursive: true });
    // Create subdirectories
    for (const sub of ['sections', 'plans', 'patterns']) {
      fs.mkdirSync(path.join(wisdomDir, sub), { recursive: true });
    }
    // Create empty index
    writeIndex(wisdomDir, { sections: {}, plans: {}, keywords: {} });
  }
  return wisdomDir;
}

/**
 * Read the .wisdom/index.json file.
 */
export function readIndex(wisdomDir) {
  const indexPath = path.join(wisdomDir, 'index.json');
  if (!fs.existsSync(indexPath)) return { sections: {}, plans: {}, keywords: {} };
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch {
    return { sections: {}, plans: {}, keywords: {} };
  }
}

/**
 * Write the .wisdom/index.json file.
 */
export function writeIndex(wisdomDir, index) {
  const indexPath = path.join(wisdomDir, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
}

/**
 * Read a sidecar wisdom file (e.g., sync.js.wisdom).
 * Returns parsed sections as { type: [entries] }.
 */
export function readSidecar(filePath) {
  const wisdomPath = filePath + '.wisdom';
  if (!fs.existsSync(wisdomPath)) return null;
  return parseWisdomMarkdown(fs.readFileSync(wisdomPath, 'utf8'));
}

/**
 * Write/append to a sidecar wisdom file.
 */
export function writeSidecar(filePath, type, entry) {
  const wisdomPath = filePath + '.wisdom';
  const header = TYPE_TO_HEADER[type] || type;
  const date = new Date().toISOString().split('T')[0];
  const line = `- ${entry} (${date})`;

  if (!fs.existsSync(wisdomPath)) {
    // Create new sidecar
    const fileName = path.basename(filePath);
    const content = `# ${fileName} — Wisdom\n\n## ${header}\n${line}\n`;
    fs.writeFileSync(wisdomPath, content);
    return;
  }

  // Append to existing section or create new section
  let content = fs.readFileSync(wisdomPath, 'utf8');
  const sectionRegex = new RegExp(`^## ${header}$`, 'm');
  if (sectionRegex.test(content)) {
    // Find the section and append after it
    content = content.replace(sectionRegex, `## ${header}\n${line}`);
  } else {
    // Add new section at the end
    content = content.trimEnd() + `\n\n## ${header}\n${line}\n`;
  }
  fs.writeFileSync(wisdomPath, content);
}

/**
 * Parse wisdom markdown into structured sections.
 */
function parseWisdomMarkdown(content) {
  const sections = {};
  let currentSection = null;

  for (const line of content.split('\n')) {
    const sectionMatch = line.match(/^## (.+)$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      sections[currentSection] = [];
      continue;
    }
    if (currentSection && line.startsWith('- ')) {
      sections[currentSection].push(line.slice(2));
    }
  }

  return sections;
}

/**
 * Read a section file from .wisdom/sections/.
 */
export function readSection(wisdomDir, sectionName) {
  const sectionPath = path.join(wisdomDir, 'sections', `${sectionName}.md`);
  if (!fs.existsSync(sectionPath)) return null;
  return fs.readFileSync(sectionPath, 'utf8');
}

/**
 * Write a section file to .wisdom/sections/.
 */
export function writeSection(wisdomDir, sectionName, content) {
  const sectionPath = path.join(wisdomDir, 'sections', `${sectionName}.md`);
  fs.mkdirSync(path.dirname(sectionPath), { recursive: true });
  fs.writeFileSync(sectionPath, content);
}

/**
 * Read a plan file from .wisdom/plans/.
 */
export function readPlan(wisdomDir, planName) {
  const planPath = path.join(wisdomDir, 'plans', `${planName}.md`);
  if (!fs.existsSync(planPath)) return null;
  return fs.readFileSync(planPath, 'utf8');
}

/**
 * Write a plan file to .wisdom/plans/.
 */
export function writePlan(wisdomDir, planName, content) {
  const planPath = path.join(wisdomDir, 'plans', `${planName}.md`);
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, content);
}

/**
 * Read a pattern file from .wisdom/patterns/.
 */
export function readPattern(wisdomDir, patternName) {
  const patternPath = path.join(wisdomDir, 'patterns', `${patternName}.md`);
  if (!fs.existsSync(patternPath)) return null;
  return fs.readFileSync(patternPath, 'utf8');
}

/**
 * Write a pattern file to .wisdom/patterns/.
 */
export function writePattern(wisdomDir, patternName, content) {
  const patternPath = path.join(wisdomDir, 'patterns', `${patternName}.md`);
  fs.mkdirSync(path.dirname(patternPath), { recursive: true });
  fs.writeFileSync(patternPath, content);
}

/**
 * Search all wisdom files for a keyword.
 * Returns matches from sidecars, sections, plans, and patterns.
 */
export function searchWisdom(projectRoot, keyword) {
  const results = [];
  const lowerKeyword = keyword.toLowerCase();

  // Search sidecars
  const wisdomDir = getWisdomDir(projectRoot);
  if (fs.existsSync(wisdomDir)) {
    // Search index keywords
    const index = readIndex(wisdomDir);
    if (index.keywords && index.keywords[lowerKeyword]) {
      for (const ref of index.keywords[lowerKeyword]) {
        results.push({ source: 'index', ref, keyword: lowerKeyword });
      }
    }

    // Search section files
    const sectionsDir = path.join(wisdomDir, 'sections');
    if (fs.existsSync(sectionsDir)) {
      for (const file of fs.readdirSync(sectionsDir)) {
        const content = fs.readFileSync(path.join(sectionsDir, file), 'utf8');
        if (content.toLowerCase().includes(lowerKeyword)) {
          results.push({ source: 'section', file, snippet: extractSnippet(content, lowerKeyword) });
        }
      }
    }

    // Search plan files
    const plansDir = path.join(wisdomDir, 'plans');
    if (fs.existsSync(plansDir)) {
      for (const file of fs.readdirSync(plansDir)) {
        const content = fs.readFileSync(path.join(plansDir, file), 'utf8');
        if (content.toLowerCase().includes(lowerKeyword)) {
          results.push({ source: 'plan', file, snippet: extractSnippet(content, lowerKeyword) });
        }
      }
    }

    // Search pattern files
    const patternsDir = path.join(wisdomDir, 'patterns');
    if (fs.existsSync(patternsDir)) {
      for (const file of fs.readdirSync(patternsDir)) {
        const content = fs.readFileSync(path.join(patternsDir, file), 'utf8');
        if (content.toLowerCase().includes(lowerKeyword)) {
          results.push({ source: 'pattern', file, snippet: extractSnippet(content, lowerKeyword) });
        }
      }
    }
  }

  // Search sidecar files (glob for *.wisdom in project)
  searchSidecarsRecursive(projectRoot, lowerKeyword, results);

  // Search global wisdom
  if (fs.existsSync(GLOBAL_WISDOM_DIR)) {
    for (const sub of ['patterns', 'lessons']) {
      const dir = path.join(GLOBAL_WISDOM_DIR, sub);
      if (fs.existsSync(dir)) {
        for (const file of fs.readdirSync(dir)) {
          const content = fs.readFileSync(path.join(dir, file), 'utf8');
          if (content.toLowerCase().includes(lowerKeyword)) {
            results.push({ source: `global/${sub}`, file, snippet: extractSnippet(content, lowerKeyword) });
          }
        }
      }
    }
  }

  return results;
}

/**
 * Search for .wisdom sidecar files recursively (skips node_modules, .git, etc.)
 */
function searchSidecarsRecursive(dir, keyword, results, depth = 0) {
  if (depth > 5) return; // Limit depth
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        searchSidecarsRecursive(fullPath, keyword, results, depth + 1);
      } else if (entry.name.endsWith('.wisdom')) {
        const content = fs.readFileSync(fullPath, 'utf8');
        if (content.toLowerCase().includes(keyword)) {
          results.push({ source: 'sidecar', file: fullPath, snippet: extractSnippet(content, keyword) });
        }
      }
    }
  } catch { /* permission errors etc */ }
}

/**
 * Extract a snippet around a keyword match.
 */
function extractSnippet(content, keyword) {
  const lower = content.toLowerCase();
  const idx = lower.indexOf(keyword);
  if (idx === -1) return '';
  const start = Math.max(0, idx - 50);
  const end = Math.min(content.length, idx + keyword.length + 100);
  return (start > 0 ? '...' : '') + content.slice(start, end).trim() + (end < content.length ? '...' : '');
}

/**
 * Update keywords in the index for a file or section.
 */
export function updateIndexKeywords(wisdomDir, keywords, ref) {
  const index = readIndex(wisdomDir);
  for (const kw of keywords) {
    const lower = kw.toLowerCase();
    if (!index.keywords[lower]) index.keywords[lower] = [];
    if (!index.keywords[lower].includes(ref)) {
      index.keywords[lower].push(ref);
    }
  }
  writeIndex(wisdomDir, index);
}
