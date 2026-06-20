/**
 * compact_context tool
 *
 * Triggers Claude Code's /compact command on the current session by sending
 * /compact to the tmux session via the dashboard API. Compaction executes
 * after the current turn completes.
 *
 * Naming parallels prune_context — both manage conversation context, with
 * compact_context summarizing+trimming via the LLM and prune_context
 * dropping oldest messages without summarization.
 *
 * Requires DASHBOARD_URL env var pointing to the claudeLoop dashboard.
 */

import { findConversationFile } from '../lib/jsonl.js';

export async function handleCompactContext(args) {
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
        nudge: args.nudge,
        bypassWisdomSave: args.bypass_wisdom_save === true
      })
    });
    const result = await resp.json();

    if (result.success) {
      return {
        content: [{ type: 'text', text: `Compact requested for session \`${result.session}\`. The /compact command will execute after your current turn completes, followed by a nudge to continue. Save any important findings with save_wisdom before the compaction runs.` }]
      };
    }

    // Dashboard returned success:false. Surface whatever signal it gave us
    // (blocked + advice from PreCompact hook, or generic .error, or just the body).
    const reason = result.reason || result.error || (result.blocked ? 'blocked by hook' : 'unknown');
    const advice = result.advice ? `\n\n${result.advice}` : '';
    return {
      content: [{ type: 'text', text: `Compact NOT sent (reason: ${reason}).${advice}` }],
      isError: true
    };
  } catch (e) {
    return {
      content: [{ type: 'text', text: `Dashboard unreachable: ${e.message}. Run /compact manually.` }],
      isError: true
    };
  }
}
