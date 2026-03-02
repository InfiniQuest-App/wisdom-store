/**
 * request_compact tool
 *
 * Requests context compaction for the current session by sending /compact
 * to the tmux session via the dashboard API. The compact executes after
 * the current turn completes.
 *
 * Requires DASHBOARD_URL env var pointing to the claudeLoop dashboard.
 */

import { findConversationFile } from '../lib/jsonl.js';

export async function handleRequestCompact(args) {
  const dashboardUrl = process.env.DASHBOARD_URL;
  if (!dashboardUrl) {
    return {
      content: [{ type: 'text', text: 'DASHBOARD_URL not set. Cannot send /compact without dashboard integration. Run /compact manually instead.' }]
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
    const resp = await fetch(`${dashboardUrl}/api/session/send-compact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: convId,
        session: args.session,
        delay: args.delay,
        nudge: args.nudge
      })
    });
    const result = await resp.json();

    if (result.success) {
      return {
        content: [{ type: 'text', text: `Compact requested for session \`${result.session}\`. The /compact command will execute after your current turn completes, followed by a nudge to continue. Save any important findings with save_wisdom before the compaction runs.` }]
      };
    } else {
      return {
        content: [{ type: 'text', text: `Failed to send /compact: ${result.error}` }],
        isError: true
      };
    }
  } catch (e) {
    return {
      content: [{ type: 'text', text: `Dashboard unreachable: ${e.message}. Run /compact manually.` }],
      isError: true
    };
  }
}
