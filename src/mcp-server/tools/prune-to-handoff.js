/**
 * prune_to_handoff tool
 *
 * Companion to the "session writes its own hand-off near end-of-life" workflow.
 *
 * Flow:
 *   1. A session approaching context/TTL limit is prompted (manually or by the
 *      claudeLoop dashboard automation) to write a structured hand-off message
 *      that includes a stable marker line (default "## SESSION HANDOFF").
 *   2. The session writes the hand-off as its assistant response. The chain now
 *      ends with: [...prior turns] → [user: write handoff] → [assistant: handoff].
 *   3. On resume, this tool is called. It scans the chain newest-first for the
 *      marker, walks back to the user message that prompted the hand-off, and
 *      sets parentUuid:null on that user message. Everything before becomes
 *      orphaned — the next session's context is just (handoff request) +
 *      (handoff response) + whatever comes next.
 *
 * Why a curated hand-off beats /compact:
 *   - The session knows what mattered; the summarizer guesses from outside.
 *   - File pointers in the hand-off don't go stale; inline summaries do.
 *   - Cheap: one in-context message vs. a full-chain LLM pass.
 *   - The orphaned JSONL stays on disk; nothing is destroyed.
 *
 * Marker convention: any text the hand-off template anchors on. Default
 * "## SESSION HANDOFF" matches the template in docs/handoff-template.md.
 * Override via `marker` arg if you use a custom template.
 */

import {
  findConversationFile,
  readJsonl,
  readJsonlLine,
  walkChain,
  rewriteLine,
  estimateTokens,
  getMessageContent
} from '../lib/jsonl.js';

const VALID_ROOT_TYPES = new Set(['user', 'system']);
const DEFAULT_MARKER = '## SESSION HANDOFF';

export async function handlePruneToHandoff(args = {}) {
  const filePath = findConversationFile(args.conversation_id);
  if (!filePath) {
    return {
      content: [{ type: 'text', text: 'No conversation file found for this project.' }],
      isError: true
    };
  }

  const marker = (args.marker || DEFAULT_MARKER).trim();
  if (!marker) {
    return {
      content: [{ type: 'text', text: 'marker arg cannot be empty.' }],
      isError: true
    };
  }
  const dryRun = args.dry_run === true;
  const keepRecentNExtra = Number.isInteger(args.keep_recent_n_extra) && args.keep_recent_n_extra > 0
    ? args.keep_recent_n_extra
    : 0;
  // Cluster-merge: when a session writes the hand-off then later writes an
  // addendum (e.g. "## SESSION HANDOFF — Addendum"), both messages match the
  // marker. Default behavior anchors the cluster — walk back from the newest
  // marker, gathering adjacent marker-bearing assistant messages within
  // merge_window turns, and anchor before the OLDEST one. Opt out for the
  // supersede pattern (newest hand-off should fully replace the older one).
  const mergeHandoffCluster = args.merge_handoff_cluster !== false; // default true
  const mergeWindow = Number.isInteger(args.merge_window) && args.merge_window > 0
    ? args.merge_window
    : 10;

  const entries = readJsonl(filePath);
  const chain = walkChain(entries);

  // Hot-path optimization: lightweight chain entries (files >50MB) already
  // retain rawLine, so parsing it in-memory beats re-reading the entire file
  // via readJsonlLine for every entry we need to inspect. Without this, a
  // 77MB / 13K-line file's marker scan does ~5K × 77MB = ~385GB of redundant
  // disk reads — which is why prune-to-handoff was timing out on big sessions
  // and pegging a core for 60-120s. Fallback to readJsonlLine if rawLine is
  // absent (non-lightweight path, or stale entries from older readers).
  const getFullEntry = (chainEntry) => {
    if (chainEntry?.rawLine) {
      try { return JSON.parse(chainEntry.rawLine); } catch { return null; }
    }
    return readJsonlLine(filePath, chainEntry.line);
  };

  if (chain.length === 0) {
    return {
      content: [{ type: 'text', text: 'Conversation chain is empty.' }],
      isError: true
    };
  }

  // Scan newest-first for the marker. Two filters to avoid matching discussion
  // of the marker (the dashboard-sent prompt, orchestrator-routed messages,
  // assistant turns quoting the prompt back, spec docs that mention the
  // string):
  //   1. Only assistant messages — the hand-off is by definition authored by
  //      the session itself. User/system turns containing the marker are
  //      always discussion.
  //   2. Marker must appear at the START of a line (preceded by \n or start)
  //      and followed by whitespace or end. This excludes backtick-quoted
  //      mentions like `## SESSION HANDOFF` and inline references.
  // Real-world catch from loop16 dogfood: chain had 11 marker occurrences;
  // newest assistant occurrence was a quote of the prompt, not the actual
  // hand-off ~7 turns earlier.
  // Re-read full bodies from disk because chain entries may be lightweight
  // for files >50MB.
  const escMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const markerHeadingRegex = new RegExp(`(^|\\n)${escMarker}(?:\\s|$)`);
  let markerIdx = -1;
  for (let i = chain.length - 1; i >= 0; i--) {
    // Fast skip: if rawLine doesn't even contain the marker text, no need to
    // JSON.parse it. Cheap string contains check on a 5-50KB line is much
    // faster than parsing it just to discover it's not a hand-off.
    if (chain[i]?.rawLine && !chain[i].rawLine.includes(marker)) continue;
    const full = getFullEntry(chain[i]);
    if (!full) continue;
    if (full.type !== 'assistant') continue;
    // getMessageContent expects the chain-entry shape { data: ... }
    const text = getMessageContent({ data: full });
    if (text && markerHeadingRegex.test(text)) {
      markerIdx = i;
      break;
    }
  }

  if (markerIdx === -1) {
    return {
      content: [{
        type: 'text',
        text: `No hand-off marker "${marker}" found in any assistant message. Did the session write a hand-off? Note: the marker must appear in an assistant turn (the session writing its own hand-off); occurrences in user/system messages are treated as discussion and skipped. See docs/handoff-template.md.`
      }],
      isError: true
    };
  }

  // Cluster expansion: walk back from the newest marker, including additional
  // marker-bearing assistant messages within merge_window turns. Each found
  // marker resets the search window from its position (transitive expansion),
  // so a chain of addendums spread across multiple turns gets fully captured
  // as long as no gap exceeds merge_window.
  const newestMarkerIdx = markerIdx;
  const clusterMarkerIndices = [newestMarkerIdx];
  if (mergeHandoffCluster && markerIdx > 0) {
    let stopAt = Math.max(0, markerIdx - mergeWindow);
    let scanIdx = markerIdx - 1;
    while (scanIdx >= stopAt) {
      if (chain[scanIdx]?.rawLine && !chain[scanIdx].rawLine.includes(marker)) {
        scanIdx--;
        continue;
      }
      const full = getFullEntry(chain[scanIdx]);
      if (full && full.type === 'assistant') {
        const text = getMessageContent({ data: full });
        if (text && markerHeadingRegex.test(text)) {
          markerIdx = scanIdx;
          clusterMarkerIndices.push(scanIdx);
          stopAt = Math.max(0, scanIdx - mergeWindow);
        }
      }
      scanIdx--;
    }
  }
  const oldestMarkerIdx = markerIdx;

  // Walk back from the OLDEST marker in the cluster to find the nearest user
  // message — that becomes the new chain root, so next session sees
  // [user: prompt for handoff] → [assistant: handoff] → … → [addendum] as
  // its starting context.
  let anchorIdx = -1;
  let anchorEntry = null;
  let anchorFull = null;
  let anchorType = null;
  for (let i = markerIdx; i >= 0; i--) {
    const full = getFullEntry(chain[i]) || chain[i].data;
    const t = full?.type || chain[i].data.type;
    if (VALID_ROOT_TYPES.has(t)) {
      anchorIdx = i;
      anchorEntry = chain[i];
      anchorFull = full;
      anchorType = t;
      break;
    }
  }

  if (anchorIdx === -1) {
    return {
      content: [{
        type: 'text',
        text: `Found hand-off marker at chain index ${markerIdx}, but no user/system message exists at or before it to anchor as the new chain root.`
      }],
      isError: true
    };
  }

  // Buffer mode: walk back keep_recent_n_extra additional chain entries from
  // the anchor, then keep walking until we land on a valid (user/system) root
  // — Claude Code refuses non-rootable types. Caps at chain[0].
  const primaryAnchorIdx = anchorIdx;
  let bufferAppliedCount = 0;
  if (keepRecentNExtra > 0 && anchorIdx > 0) {
    let candidateIdx = Math.max(0, anchorIdx - keepRecentNExtra);
    while (candidateIdx >= 0) {
      const full = getFullEntry(chain[candidateIdx]) || chain[candidateIdx].data;
      const t = full?.type || chain[candidateIdx].data.type;
      if (VALID_ROOT_TYPES.has(t)) {
        bufferAppliedCount = anchorIdx - candidateIdx;
        anchorIdx = candidateIdx;
        anchorEntry = chain[candidateIdx];
        anchorFull = full;
        anchorType = t;
        break;
      }
      candidateIdx--;
    }
    // If we walked all the way past index 0 without finding a valid root,
    // primaryAnchor stays — we just don't apply the buffer.
  }

  const orphanedCount = anchorIdx;
  let orphanedTokens = 0;
  for (let i = 0; i < anchorIdx; i++) {
    orphanedTokens += estimateTokens(getMessageContent(chain[i]));
  }
  const keptCount = chain.length - anchorIdx;

  // Snippet of the hand-off (first ~400 chars from the marker heading) for
  // the report. Use the regex to find the heading-line position rather than
  // indexOf, so we land on the actual heading instead of any earlier inline
  // mention of the marker string within the same message.
  const markerFull = readJsonlLine(filePath, chain[markerIdx].line);
  const handoffText = getMessageContent({ data: markerFull }) || '';
  const headingMatch = markerHeadingRegex.exec(handoffText);
  const markerOffset = headingMatch
    ? headingMatch.index + (headingMatch[1] ? headingMatch[1].length : 0)
    : handoffText.indexOf(marker);
  const snippet = handoffText
    .slice(markerOffset, markerOffset + 400)
    .replace(/\s+$/, '')
    + (handoffText.length - markerOffset > 400 ? '\n…(truncated)' : '');

  const bufferLine = keepRecentNExtra > 0
    ? `**Buffer**: requested keep_recent_n_extra=${keepRecentNExtra}, applied=${bufferAppliedCount} (primary anchor was chain idx ${primaryAnchorIdx + 1}, anchor walked back to ${anchorIdx + 1})`
    : null;
  const clusterLine = clusterMarkerIndices.length > 1
    ? `**Hand-off cluster**: ${clusterMarkerIndices.length} marker-bearing assistant messages merged (chain idxs ${clusterMarkerIndices.slice().reverse().map(i => i + 1).join(', ')}). Anchored before the oldest so all are kept in chain. Disable with merge_handoff_cluster=false for supersede semantics.`
    : null;
  const reportLines = (lines) => lines.filter(l => l !== null);

  if (dryRun) {
    return {
      content: [{
        type: 'text',
        text: reportLines([
          `## Prune to Hand-off — DRY RUN`,
          ``,
          `**File**: \`${filePath}\``,
          `**Marker**: \`${marker}\` newest match at chain index ${newestMarkerIdx + 1} of ${chain.length}${oldestMarkerIdx !== newestMarkerIdx ? ` (oldest in cluster: ${oldestMarkerIdx + 1})` : ''}`,
          `**New chain root**: chain index ${anchorIdx + 1} (${anchorType})`,
          clusterLine,
          bufferLine,
          `**Would orphan**: ${orphanedCount} of ${chain.length} messages (~${orphanedTokens.toLocaleString()} tokens)`,
          `**Would keep**: ${keptCount} messages from anchor to leaf`,
          ``,
          `### Hand-off snippet (oldest in cluster)`,
          `\`\`\``,
          snippet,
          `\`\`\``,
          ``,
          `Run again with \`dry_run: false\` (or omit) to apply.`
        ]).join('\n')
      }]
    };
  }

  // Apply: set parentUuid:null on the anchor entry. rewriteLine handles the
  // race-guard + atomic tmp-rename internally.
  const newData = { ...anchorFull, parentUuid: null };
  rewriteLine(filePath, anchorEntry.line, newData);

  return {
    content: [{
      type: 'text',
      text: reportLines([
        `## Prune to Hand-off Complete`,
        ``,
        `**File**: \`${filePath}\``,
        `**Marker**: \`${marker}\` newest match at chain index ${newestMarkerIdx + 1} of ${chain.length}${oldestMarkerIdx !== newestMarkerIdx ? ` (oldest in cluster: ${oldestMarkerIdx + 1})` : ''}`,
        `**New chain root**: chain index ${anchorIdx + 1} (${anchorType})`,
        clusterLine,
        bufferLine,
        `**Messages orphaned**: ${orphanedCount} (~${orphanedTokens.toLocaleString()} tokens freed)`,
        `**Messages remaining in chain**: ${keptCount}`,
        ``,
        `Orphans remain in the JSONL file (recoverable via inspect_pruned_messages or grep).`,
        `Context change takes effect on the next message (no restart needed).`,
        `CLAUDE.md is auto-loaded by Claude Code on every turn — no need for the hand-off to repeat it.`,
        ``,
        `### Hand-off snippet (oldest in cluster, now the chain root context)`,
        `\`\`\``,
        snippet,
        `\`\`\``
      ]).join('\n')
    }]
  };
}
