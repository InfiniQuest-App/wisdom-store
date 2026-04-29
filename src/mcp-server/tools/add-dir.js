/**
 * add_dir tool
 *
 * Triggers Claude Code's /add-dir command on the current session by sending
 * /add-dir <path> to the tmux session via the dashboard API. Expands the
 * worker's permission scope so it can read/edit paths outside its default
 * project tree.
 *
 * Workers can't fire slash commands themselves, so this round-trips through
 * the dashboard's send-add-dir endpoint, which uses tmux send-keys via the
 * noTimestamp pathway (a leading [timestamp] would turn the slash command
 * into plain text and the command would never fire).
 *
 * Requires DASHBOARD_URL env var pointing to the claudeLoop dashboard.
 */

import { findConversationFile } from '../lib/jsonl.js';

export async function handleAddDir(args) {
  const dashboardUrl = process.env.DASHBOARD_URL;
  if (!dashboardUrl) {
    return {
      content: [{ type: 'text', text: 'DASHBOARD_URL not set. Cannot send /add-dir without dashboard integration. Run /add-dir manually instead.' }],
      isError: true
    };
  }

  if (!args.path || typeof args.path !== 'string') {
    return {
      content: [{ type: 'text', text: '`path` is required (absolute directory path to add).' }],
      isError: true
    };
  }
  if (!args.path.startsWith('/')) {
    return {
      content: [{ type: 'text', text: `\`path\` must be absolute (got: ${args.path}).` }],
      isError: true
    };
  }

  // Resolve conversation ID
  let convId = args.conversation_id;
  if (!convId) {
    const filePath = findConversationFile();
    if (filePath) {
      convId = filePath.match(/([a-f0-9-]+)\.jsonl$/)?.[1];
    }
  }

  if (!convId && !args.session) {
    return {
      content: [{ type: 'text', text: 'Could not determine session. Provide conversation_id or session name.' }],
      isError: true
    };
  }

  try {
    const resp = await fetch(`${dashboardUrl}/api/session/send-add-dir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: convId,
        session: args.session,
        path: args.path
      })
    });
    const result = await resp.json();

    if (result.success) {
      const queuedNote = result.queued
        ? ' (queued — will fire when your current turn ends).'
        : '.';
      return {
        content: [{ type: 'text', text: `\`/add-dir ${result.path}\` sent to session \`${result.session}\`${queuedNote} The path is now in your permission scope and persists until session restart.` }]
      };
    }

    // Dashboard returned success:false. Surface whatever signal it gave us.
    const reason = result.reason || result.error || 'unknown';
    const advice = result.advice ? `\n\n${result.advice}` : '';
    return {
      content: [{ type: 'text', text: `/add-dir NOT sent (reason: ${reason}).${advice}` }],
      isError: true
    };
  } catch (e) {
    return {
      content: [{ type: 'text', text: `Dashboard unreachable: ${e.message}. Run /add-dir ${args.path} manually.` }],
      isError: true
    };
  }
}
