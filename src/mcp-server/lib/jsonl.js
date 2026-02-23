/**
 * JSONL conversation file utilities.
 *
 * Claude Code conversations are stored as JSONL files with linked-list structure:
 * each message has `uuid` and `parentUuid` fields forming a chain.
 * Setting parentUuid:null on a message makes it a new root, orphaning everything before.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

/**
 * Derive the project hash directory name from a working directory path.
 * Claude Code uses the path with / replaced by - (and leading -)
 * e.g. /home/user/my-project -> -home-user-my-project
 */
export function projectHash(cwd) {
  // Claude Code normalizes both / and _ to - in project directory names
  return cwd.replace(/[/_]/g, '-');
}

/**
 * Find the JSONL file for a conversation.
 * If conversationId is provided, use it directly.
 * Otherwise, find the most recently modified JSONL in the project directory.
 */
export function findConversationFile(conversationId, cwd) {
  if (conversationId) {
    // Try the current project dir first
    const hash = projectHash(cwd || process.cwd());
    const dir = path.join(PROJECTS_DIR, hash);
    const filePath = path.join(dir, `${conversationId}.jsonl`);
    if (fs.existsSync(filePath)) return filePath;

    // Quick scan of other project dirs (just check existence, no listing)
    try {
      const dirs = fs.readdirSync(PROJECTS_DIR);
      for (const d of dirs) {
        if (d === hash) continue; // Already checked
        const candidate = path.join(PROJECTS_DIR, d, `${conversationId}.jsonl`);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch { /* ignore */ }
    return null;
  }

  // No ID — find most recently modified JSONL for this project
  const hash = projectHash(cwd || process.cwd());
  let dir = path.join(PROJECTS_DIR, hash);

  // If exact hash doesn't exist, scan for a matching project dir
  // (handles edge cases like Claude normalizing special chars differently)
  if (!fs.existsSync(dir)) {
    try {
      const dirs = fs.readdirSync(PROJECTS_DIR);
      // Look for dirs that share the same base name (last segment)
      const baseName = hash.split('-').pop();
      const match = dirs.find(d => d === hash || d.split('-').pop() === baseName);
      if (match) {
        dir = path.join(PROJECTS_DIR, match);
      } else {
        return null;
      }
    } catch { return null; }
  }

  const jsonlFiles = fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({
      name: f,
      path: path.join(dir, f),
      mtime: fs.statSync(path.join(dir, f)).mtimeMs
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return jsonlFiles.length > 0 ? jsonlFiles[0].path : null;
}

/**
 * Read all lines from a JSONL file, parsing each as JSON.
 * Returns array of { line: lineNumber (0-indexed), data: parsedJSON, offset: byteOffset }
 *
 * For large files (>50MB), uses a streaming approach that only extracts
 * the fields needed for chain walking (uuid, parentUuid, type, timestamp).
 */
export function readJsonl(filePath, { lightweight = false } = {}) {
  const stat = fs.statSync(filePath);

  // For large files or lightweight mode, extract only chain-critical fields
  if (lightweight || stat.size > 50 * 1024 * 1024) {
    return readJsonlLightweight(filePath);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  return lines.map((line, i) => {
    try {
      return { line: i, data: JSON.parse(line) };
    } catch {
      return { line: i, data: null };
    }
  }).filter(e => e.data !== null);
}

/**
 * Lightweight JSONL reader — extracts only uuid, parentUuid, type, timestamp
 * using regex instead of full JSON.parse. ~10x faster for large files.
 */
function readJsonlLightweight(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const results = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // Extract key fields with regex (avoids full JSON parse)
    const uuid = line.match(/"uuid"\s*:\s*"([^"]+)"/)?.[1] || null;
    const parentUuid = line.includes('"parentUuid":null')
      ? null
      : line.match(/"parentUuid"\s*:\s*"([^"]+)"/)?.[1] || undefined;
    const timestamp = line.match(/"timestamp"\s*:\s*"([^"]+)"/)?.[1] || null;

    // Detect message type — match specific top-level type values
    // (avoid matching "type":"text" or "type":"thinking" inside content blocks)
    let type = null;
    if (line.includes('"type":"user"')) type = 'user';
    else if (line.includes('"type":"assistant"')) type = 'assistant';
    else if (line.includes('"type":"file-history-snapshot"')) type = 'file-history-snapshot';
    else if (line.includes('"type":"progress"')) type = 'progress';

    // Skip non-message lines (like file-history-snapshot without uuid chain fields)
    if (!uuid && type === 'file-history-snapshot') continue;

    results.push({
      line: i,
      data: { uuid, parentUuid, type, timestamp },
      rawLine: line  // Keep raw for rewriting
    });
  }

  return results;
}

/**
 * Read a single line from a JSONL file and fully parse it.
 * Used when we need full message content for a specific line.
 */
export function readJsonlLine(filePath, lineIndex) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  let nonEmptyCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) {
      if (nonEmptyCount === lineIndex) {
        try { return JSON.parse(lines[i]); } catch { return null; }
      }
      nonEmptyCount++;
    }
  }
  return null;
}

/**
 * Walk the parentUuid chain from the latest message back to the root.
 * Returns messages in chain order (root first).
 *
 * Claude Code reads the chain by finding the latest leaf and walking
 * parentUuid back to null. We do the same.
 */
export function walkChain(entries) {
  // Build lookup by uuid
  const byUuid = new Map();
  for (const entry of entries) {
    if (entry.data.uuid) {
      byUuid.set(entry.data.uuid, entry);
    }
  }

  // Find the leaf: latest message by timestamp that has a uuid
  // but no other message points to it as parent... actually simpler:
  // find all uuids that are NOT referenced as parentUuid by anyone
  const referenced = new Set();
  for (const entry of entries) {
    if (entry.data.parentUuid) {
      referenced.add(entry.data.parentUuid);
    }
  }

  const leaves = entries.filter(e => e.data.uuid && !referenced.has(e.data.uuid));

  // Pick the leaf with the latest timestamp (or last in file)
  let leaf = leaves[leaves.length - 1];
  if (leaves.length > 1) {
    leaf = leaves.reduce((best, e) => {
      const t1 = new Date(best.data.timestamp || 0).getTime();
      const t2 = new Date(e.data.timestamp || 0).getTime();
      return t2 > t1 ? e : best;
    });
  }

  if (!leaf) return [];

  // Walk back to root (with cycle guard)
  const chain = [];
  const visited = new Set();
  let current = leaf;
  while (current) {
    if (visited.has(current.data.uuid)) break; // Cycle detected
    visited.add(current.data.uuid);
    chain.unshift(current);
    if (current.data.parentUuid === null || current.data.parentUuid === undefined) break;
    current = byUuid.get(current.data.parentUuid) || null;
  }

  return chain;
}

/**
 * Estimate token count from message content.
 * Rough approximation: ~4 chars per token for English text/code.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Extract content text from a message entry for token estimation.
 */
export function getMessageContent(entry) {
  const msg = entry.data.message;
  if (!msg) return '';

  if (typeof msg.content === 'string') return msg.content;

  if (Array.isArray(msg.content)) {
    return msg.content.map(block => {
      if (typeof block === 'string') return block;
      if (block.type === 'text') return block.text || '';
      if (block.type === 'thinking') return block.thinking || '';
      if (block.type === 'tool_use') return JSON.stringify(block.input || {});
      if (block.type === 'tool_result') {
        if (typeof block.content === 'string') return block.content;
        if (Array.isArray(block.content)) {
          return block.content.map(c => c.text || '').join('\n');
        }
      }
      return '';
    }).join('\n');
  }

  return '';
}

/**
 * Rewrite a specific line in the JSONL file.
 * Reads the file, modifies the target line, writes back.
 */
export function rewriteLine(filePath, lineIndex, newData) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  // Find the actual line index (accounting for empty lines)
  let actualIndex = 0;
  let nonEmptyCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) {
      if (nonEmptyCount === lineIndex) {
        actualIndex = i;
        break;
      }
      nonEmptyCount++;
    }
  }

  lines[actualIndex] = JSON.stringify(newData);
  fs.writeFileSync(filePath, lines.join('\n'));
}

/**
 * Append a line to the JSONL file.
 */
export function appendLine(filePath, data) {
  fs.appendFileSync(filePath, '\n' + JSON.stringify(data));
}
