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

import path from 'path';
import { findCallerConvIdFromParent, findCallerCwdFromParent } from '../lib/jsonl.js';

/**
 * Detect whether a working directory is inside a worktree of the form
 * <mainRepo>-worktrees/<session>/.... Returns the main repo path and the
 * worktrees base path if so; null otherwise.
 *
 * Mirrors the regex in claudeLoop's worktree-utils.detectWorktree. We don't
 * import claudeLoop directly — wisdom-store stays free of that dependency.
 */
function detectWorktreeBase(workingDir) {
  const m = workingDir.match(/^(.+)-worktrees\/([^/]+)/);
  if (!m) return null;
  return { mainRepo: m[1], worktreesBase: m[1] + '-worktrees' };
}

/**
 * True if `target` is `root` itself or a descendant of `root`.
 *
 * Uses path.relative — string-prefix matching is unsafe (`/etc-foo` would
 * falsely match `/etc`). path.relative produces `..`-prefixed or absolute
 * output when target is outside root, so we reject those.
 */
function isWithinRoot(root, target) {
  const rel = path.relative(root, target);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

/**
 * Compute the set of allowed roots a session can /add-dir into:
 *   - Caller in a worktree: [mainRepo, mainRepo-worktrees]
 *   - Otherwise:            [callerCwd, callerCwd-worktrees]
 *
 * "callerCwd as project root" is correct when claude was invoked from the
 * project root (the normal case). If a worker cd's into a subdirectory
 * before launch, this shrinks scope but never widens it past safe bounds.
 */
function computeAllowedRoots(callerCwd) {
  const resolved = path.resolve(callerCwd);
  const wt = detectWorktreeBase(resolved);
  if (wt) return [wt.mainRepo, wt.worktreesBase];
  return [resolved, resolved + '-worktrees'];
}

/**
 * Validate the requested add_dir path against the caller's allowed roots.
 * Exported for unit testing (the function is pure given callerCwd input).
 */
export function validateAddDirScope(callerCwd, requestedPath) {
  const resolvedRequest = path.resolve(requestedPath);
  const allowedRoots = computeAllowedRoots(callerCwd);
  const ok = allowedRoots.some(root => isWithinRoot(root, resolvedRequest));
  return { ok, allowedRoots, resolvedRequest };
}

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

  // Scope validation. add_dir must not let a worker widen its permission
  // scope to arbitrary filesystem paths — that defeats the per-project Read
  // allowlist tightening (e.g. CPR's scope is project-only, but pre-fix
  // add_dir({ path: "/etc" }) was succeeding). Allowed roots are the
  // caller's project root + sibling worktrees only. No `force:true` escape
  // hatch — wider scope is user-only territory via manual /add-dir.
  const callerCwd = findCallerCwdFromParent();
  if (!callerCwd) {
    return {
      content: [{ type: 'text', text: 'Could not determine caller cwd from `/proc/<ppid>/cwd`. Cannot scope-check the request. If you need wider permission scope, run `/add-dir <path>` manually in your Claude session — that\'s user-only territory.' }],
      isError: true
    };
  }
  const scope = validateAddDirScope(callerCwd, args.path);
  if (!scope.ok) {
    const rootList = scope.allowedRoots.map(r => `  - ${r}`).join('\n');
    return {
      content: [{ type: 'text', text: `Refused: \`${scope.resolvedRequest}\` is outside this session's allowed scope.\n\nAllowed roots:\n${rootList}\n\nIf you need wider scope, run \`/add-dir ${args.path}\` manually in your Claude session — that's user-only territory.` }],
      isError: true
    };
  }

  // Resolve conversation ID. Prefer parent-process cmdline (--resume UUID) — that's
  // the authoritative "who is calling me" signal. We deliberately do NOT fall back
  // to findConversationFile()'s most-recently-modified-JSONL heuristic here: when
  // multiple workers share a project directory, that heuristic silently picks
  // whichever sibling wrote most recently, routing /add-dir to the wrong pane
  // (loop146 → loop11 bug). Per acceptance criteria: fail loudly instead.
  let convId = args.conversation_id;
  if (!convId) {
    convId = findCallerConvIdFromParent();
  }

  if (!convId && !args.session) {
    return {
      content: [{ type: 'text', text: 'Could not determine the calling session. Tried `args.conversation_id` (none) and parent-process cmdline (no `--resume <UUID>` found). Provide an explicit `conversation_id` or `session` argument so /add-dir routes to the right pane.' }],
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
