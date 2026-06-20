/**
 * annotate_wisdom tool
 *
 * Add a comment/annotation to an existing wisdom entry.
 * Use this when you've tested a previous assumption and discovered
 * something new, or need to clarify/correct existing wisdom.
 *
 * Annotations are appended below the matching entry with a timestamp.
 */

import path from 'path';
import fs from 'fs';
import { findProjectRoot, getWisdomDir, readSection, writeSection } from '../lib/wisdom.js';

export async function handleAnnotateWisdom(args) {
  if (!args.comment || !args.comment.trim()) {
    return {
      content: [{ type: 'text', text: 'comment is required.' }],
      isError: true
    };
  }

  const projectRoot = findProjectRoot();
  const wisdomDir = getWisdomDir(projectRoot);
  const date = new Date().toISOString().split('T')[0];
  const annotation = `  > _${date}_: ${args.comment.trim()}`;

  if (args.file_path) {
    // Annotate a sidecar file
    const absPath = path.isAbsolute(args.file_path)
      ? args.file_path
      : path.join(projectRoot, args.file_path);
    const sidecarPath = absPath + '.wisdom';

    if (!fs.existsSync(sidecarPath)) {
      return {
        content: [{ type: 'text', text: `No sidecar wisdom found at ${sidecarPath}` }],
        isError: true
      };
    }

    let content = fs.readFileSync(sidecarPath, 'utf-8');

    if (args.search) {
      // Find the entry containing the search text and append annotation after it
      const idx = content.toLowerCase().indexOf(args.search.toLowerCase());
      if (idx === -1) {
        return {
          content: [{ type: 'text', text: `No entry matching "${args.search}" found in ${args.file_path}.wisdom` }],
          isError: true
        };
      }
      // Find the end of the line containing the match
      const lineEnd = content.indexOf('\n', idx);
      if (lineEnd === -1) {
        content = content + '\n' + annotation + '\n';
      } else {
        content = content.slice(0, lineEnd) + '\n' + annotation + content.slice(lineEnd);
      }
    } else {
      // Append to end of file
      content = content.trimEnd() + '\n' + annotation + '\n';
    }

    fs.writeFileSync(sidecarPath, content);
    return {
      content: [{ type: 'text', text: `Annotation added to ${args.file_path}.wisdom` }]
    };

  } else if (args.section) {
    // Annotate a section file
    const existing = readSection(wisdomDir, args.section);
    if (!existing) {
      return {
        content: [{ type: 'text', text: `Section "${args.section}" not found.` }],
        isError: true
      };
    }

    let updated;
    if (args.search) {
      const idx = existing.toLowerCase().indexOf(args.search.toLowerCase());
      if (idx === -1) {
        return {
          content: [{ type: 'text', text: `No entry matching "${args.search}" in section "${args.section}"` }],
          isError: true
        };
      }
      // Find end of the paragraph/entry (next blank line or next list item)
      let entryEnd = idx;
      const lines = existing.split('\n');
      let charCount = 0;
      let targetLineIdx = -1;

      // Find which line contains the match
      for (let i = 0; i < lines.length; i++) {
        if (charCount + lines[i].length >= idx) {
          targetLineIdx = i;
          break;
        }
        charCount += lines[i].length + 1; // +1 for \n
      }

      if (targetLineIdx >= 0) {
        // Find end of this entry — next line that starts with '- **' or is a heading or blank
        let endLineIdx = targetLineIdx + 1;
        while (endLineIdx < lines.length) {
          const line = lines[endLineIdx];
          if (line.startsWith('- **') || line.startsWith('## ') || line.startsWith('# ')) {
            break;
          }
          endLineIdx++;
        }
        // Insert annotation before the next entry
        lines.splice(endLineIdx, 0, annotation);
        updated = lines.join('\n');
      } else {
        updated = existing.trimEnd() + '\n' + annotation + '\n';
      }
    } else {
      // No search — append to end of section
      updated = existing.trimEnd() + '\n\n' + annotation + '\n';
    }

    writeSection(wisdomDir, args.section, updated);
    return {
      content: [{ type: 'text', text: `Annotation added to .wisdom/sections/${args.section}.md` }]
    };

  } else {
    return {
      content: [{ type: 'text', text: 'Provide either file_path or section to annotate.' }],
      isError: true
    };
  }
}
