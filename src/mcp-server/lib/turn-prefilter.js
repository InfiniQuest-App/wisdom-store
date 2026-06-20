/**
 * Heuristic pre-filter for analyze_for_archive_v2 Pass 1.
 *
 * Detects "obviously discardable" turns without needing a Haiku call. Saves
 * ~30% of Pass 1 cost on typical orchestrator/worker conversations.
 *
 * Validated empirically on loop168 (250 turns, ground-truth from Haiku Pass 1):
 *   - Precision: 100% (74/74 flagged turns also Haiku-discardable)
 *   - Recall:    85% (74/87 of Haiku-discardable caught)
 *
 * Bias: precision over recall. A false-positive (dropping a load-bearing turn)
 * is far worse than a false-negative (paying Haiku to classify an obvious
 * discardable). Tune toward zero false positives.
 *
 * The synthetic summary returned for pre-filtered turns is plumbed into Pass 2
 * unchanged — so cross-turn judgment still sees these turns when picking
 * duplicates, even though no Haiku call was made.
 */

const PF_MAX_ENTRIES = 5;
const PF_MAX_CONTENT_CHARS = 700;

function totalContentChars(fullEntries) {
  let total = 0;
  for (const e of fullEntries) {
    const c = e?.message?.content;
    if (typeof c === 'string') total += c.length;
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (typeof b?.text === 'string') total += b.text.length;
        else if (typeof b?.content === 'string') total += b.content.length;
      }
    }
  }
  return total;
}

function hasToolUseAnywhere(fullEntries) {
  for (const e of fullEntries) {
    const c = e?.message?.content;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === 'tool_use') return true;
      }
    }
  }
  return false;
}

/**
 * Returns a synthetic summary block (same shape as Pass 1's submit_turn_summary
 * output) when the turn matches a pre-filterable pattern. Returns null when the
 * turn needs a real Haiku call.
 */
export function preFilterTurn(turn, fullEntries) {
  // Single-entry turn — user prompt with no agent response at all (rejected mid-flow,
  // hit a context limit, etc.). Always discardable.
  if (fullEntries.length === 1) {
    return {
      type: 'micro',
      summary: 'Pre-filtered: single-entry turn (no agent response).',
      key_artifacts: [],
      duplicate_signal: 'pf-micro-single-entry',
      importance: 'discardable',
      _prefilterReason: 'single-entry turn (no agent response)'
    };
  }

  // Multi-entry but no tool_use AND modest content — agent acked, user kept warm,
  // status check etc. The 700-char threshold was empirically validated to give
  // 100% precision on loop168 — content > 700 chars is more likely to contain
  // a load-bearing decision worth Haiku-classifying.
  const totalChars = totalContentChars(fullEntries);
  if (
    fullEntries.length <= PF_MAX_ENTRIES &&
    !hasToolUseAnywhere(fullEntries) &&
    totalChars < PF_MAX_CONTENT_CHARS
  ) {
    return {
      type: 'micro',
      summary: `Pre-filtered: ≤${PF_MAX_ENTRIES}-entry turn, no tool_use, content ${totalChars} chars.`,
      key_artifacts: [],
      duplicate_signal: 'pf-micro-no-tool-use-short',
      importance: 'discardable',
      _prefilterReason: `≤${PF_MAX_ENTRIES} entries, no tool_use, ${totalChars} chars`
    };
  }

  return null; // not pre-filterable; needs Haiku
}

export const PREFILTER_INTERNALS = {
  totalContentChars,
  hasToolUseAnywhere,
  PF_MAX_ENTRIES,
  PF_MAX_CONTENT_CHARS
};
