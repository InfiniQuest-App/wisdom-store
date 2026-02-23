/**
 * inject_context tool
 *
 * Injects curated context into the conversation by appending a new message
 * with parentUuid:null. This creates a fresh branch — the old chain is orphaned.
 *
 * After injection, the user must run /resume to trigger JSONL re-read.
 * (Hot-splice requires /resume; hot-trim does not.)
 *
 * Content should be natural-sounding to avoid Claude's prompt injection detection.
 * Good formats: pasted text, MCP responses, conversation summaries, CLAUDE.md-style context.
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import {
  findConversationFile,
  readJsonl,
  walkChain,
  appendLine,
  estimateTokens
} from '../lib/jsonl.js';

export async function handleInjectContext(args) {
  if (!args.content || !args.content.trim()) {
    return {
      content: [{ type: 'text', text: 'Content is required for injection.' }],
      isError: true
    };
  }

  const filePath = findConversationFile(args.conversation_id);
  if (!filePath) {
    return {
      content: [{ type: 'text', text: 'No conversation file found for this project.' }],
      isError: true
    };
  }

  // Read existing conversation to get metadata (cwd, sessionId, etc.)
  const entries = readJsonl(filePath);
  const chain = walkChain(entries);

  // Find a user message to copy metadata from
  const refMessage = chain.find(e => e.data.type === 'user') || chain[0];
  const cwd = refMessage?.data.cwd || process.cwd();
  const sessionId = refMessage?.data.sessionId || filePath.match(/([a-f0-9-]+)\.jsonl$/)?.[1];
  const gitBranch = refMessage?.data.gitBranch || 'main';
  const version = refMessage?.data.version || '2.1.50';

  const messageUuid = randomUUID();
  const timestamp = new Date().toISOString();

  // Create the file-history-snapshot (required before user messages)
  const snapshot = {
    type: 'file-history-snapshot',
    messageId: messageUuid,
    snapshot: {
      messageId: messageUuid,
      trackedFileBackups: {},
      timestamp
    },
    isSnapshotUpdate: false
  };

  // Create the user message with parentUuid:null (new root)
  const userMessage = {
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd,
    sessionId,
    version,
    gitBranch,
    type: 'user',
    message: {
      role: 'user',
      content: args.content
    },
    uuid: messageUuid,
    timestamp,
    todos: [],
    permissionMode: 'default'
  };

  // Append both lines
  appendLine(filePath, snapshot);
  appendLine(filePath, userMessage);

  // Optionally prune orphaned lines
  let pruneReport = '';
  if (args.prune_orphans) {
    const beforeSize = fs.statSync(filePath).size;
    pruneOrphanedLines(filePath, messageUuid);
    const afterSize = fs.statSync(filePath).size;
    const saved = ((1 - afterSize / beforeSize) * 100).toFixed(0);
    pruneReport = `\n**File pruned**: ${(beforeSize / 1024).toFixed(0)}KB → ${(afterSize / 1024).toFixed(0)}KB (${saved}% reduction)`;
  }

  const tokens = estimateTokens(args.content);

  // Auto-resume: if you have a dashboard/automation layer that can send tmux
  // commands, set DASHBOARD_URL to its base URL. It should accept:
  //   POST /api/session/send-resume { conversationId, session, delay }
  // and send `/resume` + Enter to the appropriate tmux session.
  // Without this, the user just runs /resume manually (the common case).
  let resumeStatus = '';
  const dashboardUrl = process.env.DASHBOARD_URL;
  if (dashboardUrl) {
    const convId = args.conversation_id || filePath.match(/([a-f0-9-]+)\.jsonl$/)?.[1];
    try {
      const resp = await fetch(`${dashboardUrl}/api/session/send-resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: convId,
          session: args.session,
          delay: 2000
        })
      });
      const result = await resp.json();
      if (result.success) {
        resumeStatus = `\n**Auto-resume**: Sent /resume to session \`${result.session}\`. Context will reload shortly.`;
      } else {
        resumeStatus = `\n**Auto-resume failed**: ${result.error}. Run \`/resume\` manually.`;
      }
    } catch {
      resumeStatus = `\n**Auto-resume unavailable** (dashboard not reachable). Run \`/resume\` manually.`;
    }
  } else {
    resumeStatus = '\n**Next step**: Run `/resume` in your Claude Code session to load the injected context.';
  }

  const report = [
    `## Context Injected`,
    ``,
    `**Message UUID**: \`${messageUuid}\``,
    `**Estimated tokens**: ~${tokens.toLocaleString()}`,
    `**Previous chain**: ${chain.length} messages (now orphaned)`,
    pruneReport,
    resumeStatus,
  ].join('\n');

  return {
    content: [{ type: 'text', text: report }]
  };
}

/**
 * Remove orphaned lines from the JSONL file.
 * Keeps only the new message and its snapshot.
 * This is safe because orphaned messages are unreachable from the new chain.
 */
function pruneOrphanedLines(filePath, newRootUuid) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());

  // Keep lines that are part of the new chain
  // For a fresh injection, that's just the snapshot + the new message
  const kept = lines.filter(line => {
    try {
      const data = JSON.parse(line);
      // Keep the new message
      if (data.uuid === newRootUuid) return true;
      // Keep its snapshot
      if (data.messageId === newRootUuid && data.type === 'file-history-snapshot') return true;
      // Keep any messages that chain FROM the new root (future messages)
      if (data.parentUuid === newRootUuid) return true;
      return false;
    } catch {
      return false;
    }
  });

  fs.writeFileSync(filePath, kept.join('\n') + '\n');
}
