# Brief: Add a "Condense" button to the dashboard for per-session JSONL condensation

## What it does

Triggers wisdom-store's `condense_jsonl_blocks` tool against a Claude Code conversation JSONL — heuristically condenses image bytes, stale file reads, MCP status snapshots, thinking signatures, verbose tool inputs, and large tool_result outputs. **Zero LLM cost** (pure heuristic). **Out-of-process** — does not touch any agent's context window. The targeted agent picks up the condensed file on its NEXT turn (chain re-walk; hot-trim safe).

Typical impact: **15–30% file size reduction** on a JSONL that hasn't been condensed before; **5–15% AC% reduction** in the agent's context. Smaller incremental gains on already-condensed sessions (sidecar tracking makes re-runs idempotent).

## Why a dashboard button (vs asking the agent itself)

Asking the agent to run condense on its own JSONL costs context twice:
1. **Wake-up cache miss** when the agent processes the tool call + result
2. **Post-condense cache miss** when the next prompt encounters the new chain shape

A dashboard button bypasses both — pure file mutation, agent never knows it happened until it next reads its chain (which it has to do anyway to continue working).

## How to invoke (Node, no MCP needed)

The condense tool is a plain Node module — call it directly via `child_process.spawn` from the dashboard's backend:

```javascript
import { handleCondenseJsonlBlocks } from '/home/michael/Projects/wisdom-store/src/mcp-server/tools/condense-jsonl-blocks.js';

// Recommended default modes (all heuristic, all reversible)
const DEFAULT_MODES = [
  'images',
  'memory-reads',
  'identical-reads',
  'mcp-snapshots',
  'refetch-markers',
  'tool-args',
  'thinking'
];

async function condenseConversation({ jsonlPath, modes = DEFAULT_MODES, dryRun = false }) {
  const result = await handleCondenseJsonlBlocks({
    jsonl_path: jsonlPath,           // explicit path — bypasses UUID lookup
    modes,
    dry_run: dryRun,
    thinking_marker_style: 'minimal' // minimal markers (empirically validated; verbose available)
  });
  return result;
}
```

`result.content[0].text` contains a markdown report. `result.structuredContent` (when present) has parsed fields: `sizeBefore`, `sizeAfter`, `reductionPct`, `condensed` (per-mode counts), `backupPath`.

## Arguments to expose in the UI

Minimum viable button:
- **One button** per session card: "Condense conversation" — uses default modes, no other args needed
- **Dry-run option** (checkbox): run in preview mode first, show predicted savings, ask user to confirm before mutating

Optional power-user controls:
- **Mode selection** (multi-select checklist of the 7 modes)
- **`thinking_marker_style`**: `minimal` (default, byte-efficient) or `verbose` (embeds Pass 1 turn summaries when an analyze-v2 plan exists)
- **`keep_recent_turns`**: integer override; default is `min(30, ceil(totalTurns/2))` — keep the most recent N turns verbatim
- **Re-run button** to re-trigger with same params (idempotent — sidecar prevents double-condensing)

## Where things live

For a conversation at `<conv_dir>/<convId>.jsonl`, the tool maintains three sidecar dirs:

- **`<conv_dir>/.condense-backups/<convId>.<epoch>.jsonl`** — full JSONL backup before each mutation. Last 3 retained, oldest pruned.
- **`<conv_dir>/.condense-meta/<convId>.json`** — per-block tracking (which blocks were condensed by which mode, with byte stats). Makes re-runs idempotent.
- **`<conv_dir>/.condense-log/<convId>.jsonl`** — append-only run log: one JSON line per run with parameters + results + timing.

## Logging / diagnostic data the dashboard can surface

Every run appends to the log file. Each entry has:

```json
{
  "at": 1778625179591,
  "modes": ["images", "memory-reads", "...", "thinking"],
  "args": { "dry_run": false, "thinking_marker_style": "minimal", ... },
  "filePath": "/home/michael/.claude/projects/.../<convId>.jsonl",
  "fileSize": { "before": 2785965, "after": 2363406 },
  "blocksCondensed": {
    "images": 0, "memoryReads": 0, "identicalReads": 0,
    "staleReads": 0, "mcpSnapshots": 2, "refetchMarkers": 47,
    "toolArgs": 0, "thinking": 93
  },
  "bytesSaved": {
    "images": 0, "memoryReads": 0, "identicalReads": 0,
    "staleReads": 0, "mcpSnapshots": 41123, "refetchMarkers": 230456,
    "toolArgs": 0, "thinking": 143521
  },
  "totalBlocksTouched": 142,
  "totalBytesSavedRaw": 415100,
  "backupPath": "/.../.condense-backups/<convId>.1778625179591.jsonl",
  "sidecarPath": "/.../.condense-meta/<convId>.json",
  "replacedActual": 142,
  "planUsed": null
}
```

Useful dashboard surfaces:
- **Per-session "condense history"** card — show last N runs, byte savings per run, cumulative savings
- **Per-mode effectiveness chart** — across all sessions, which modes save the most bytes (informs future tuning)
- **Re-condense detection** — if `blocksCondensed` totals are tiny, the file was already condensed — show "already condensed" badge instead of "X% saved"
- **Restore button** that reads the latest `.condense-backups/` entry and offers one-click rollback

## Reversibility

Every mutation is fully reversible. To restore from any backup:

```javascript
import { handleRestoreArchiveBackup } from '/home/michael/Projects/wisdom-store/src/mcp-server/tools/restore-archive-backup.js';

await handleRestoreArchiveBackup({
  conversation_id: '<convId>',
  backupPath: '/path/to/.condense-backups/<convId>.<epoch>.jsonl'
});
```

Or from the most recent backup automatically (no `backupPath` needed):

```javascript
await handleRestoreArchiveBackup({ conversation_id: '<convId>' });
```

## Safety properties

- **Backup-before-mutation** is unconditional. Even on dry-runs there's no risk (dry-runs don't mutate at all).
- **Atomic writes** via tmp + rename in `rewriteJsonl`. Race-guarded against the live agent appending mid-condense.
- **Hot-trim**: Claude Code re-walks the chain each turn — condensed content visible immediately without `/resume`. The condensed JSONL is always API-valid (no metadata pollution on `message.content[]` blocks).
- **Idempotent**: sidecar tracks per-block condense status; re-running is a no-op for already-touched blocks.

## Future extension hooks

- **`condense_jsonl_blocks`** is the current API. A future analyze-then-apply LLM pipeline (~$0.50/run on Haiku) is `mcp__wisdom-store__analyze_for_archive` + `mcp__wisdom-store__apply_archive_plan` — produces drop/distill decisions per turn. Could be wired as a separate "Deep condense (LLM-assisted)" button.
- **Score-threshold apply** lets the user dial archival aggressiveness via `min_keep_score` / `min_distill_score` args on apply (when an analyze plan exists). Could be a slider.

## Test endpoint suggestion

Wire a basic POST endpoint:

```
POST /api/condense
{
  "conversation_id": "...",   // optional, look up via dashboard's session map
  "jsonl_path": "...",        // OR explicit path
  "modes": [...],             // optional, default = all 7
  "dry_run": false,           // optional, default false
  "thinking_marker_style": "minimal"
}

→ 200 { ok: true, report: <markdown text>, structured: {...} }
→ 500 { ok: false, error: "..." }
```

The handler shells out to a node script wrapping `handleCondenseJsonlBlocks` and returns its result.

## Estimated implementation effort

- Backend endpoint + node wrapper: ~30 min
- UI button on session card + simple result display: ~30-60 min
- "Condense history" view (reads `.condense-log/`): ~1-2 hr
- Restore button + history of backups: ~1 hr
- Mode picker + advanced settings: ~1 hr

**MVP (button + minimal display): ~1 hour total.**

---

# Appendix: Full argument reference + broader pipeline

The MVP button only needs `condense_jsonl_blocks` with default modes. But there's a richer pipeline available — useful if the dashboard wants a "Smart archival" panel rather than just a button.

## All 8 condense modes (current)

| Mode | What it does | LLM cost | Risk |
|---|---|---|---|
| `images` | base64 image content in tool_results → `[image elided]` markers | $0 | None — image re-readable from file path |
| `memory-reads` | Older reads of memory-style files (MEMORY.md, .wisdom/*, CLAUDE.md, plans/*.md) → marker | $0 | None — file re-readable |
| `identical-reads` | Reads with byte-identical content (any path) — older copies → marker | $0 | None — content was identical |
| `stale-reads` | Same path + same offset + same limit, multiple times — older → marker | $0 | None — strict args match |
| `mcp-snapshots` | Older copies of MCP status-snapshot tool_results (get_suggestions, get_session_info, etc.) → marker | $0 | None — newer copy supersedes |
| `refetch-markers` | tool_result content for read-only/idempotent tools → summary head/tail + re-fetch pointer | $0 | Low — agent can re-fetch via standard tool |
| `tool-args` | Verbose string fields in tool_use INPUTS for: TaskCreate, mcp__orchestrator__create_session, mcp__orchestrator__assign_task, Edit, Write, mcp__codegen__manualFile{Edit,Write} | $0 | Mid — agent's record of "what I sent" becomes preview + pointer; structural fields (subject/file_path) preserved |
| `thinking` | Thinking blocks (mostly signatures) → `[thinking elided]` markers; uses Pass 1 turn-summary if a v2 plan exists, else heuristic fallback | $0 | Unknown — signatures might serve as continuation primer for the model; empirically AC% drops when removed but qualitative quality hasn't been A/B tested |

**Recommended default for "Condense" button:** all 8.
**Conservative subset** (no risk): `['images', 'memory-reads', 'identical-reads', 'stale-reads', 'mcp-snapshots']`.
**Aggressive subset**: add `['refetch-markers', 'tool-args', 'thinking']`.

## All `condense_jsonl_blocks` arguments

| Arg | Type | Default | Purpose |
|---|---|---|---|
| `conversation_id` | string | (lookup) | UUID of conversation. If omitted AND `jsonl_path` omitted, finds most-recently-modified for current project |
| `jsonl_path` | string | — | Explicit JSONL path. **Bypasses UUID lookup** — required when testing on a copy or when multiple files share the UUID across dirs |
| `modes` | string[] | all 8 | Which modes to apply (subset of the 8 above) |
| `dry_run` | bool | false | Preview only; no mutation. Recommended for first run on any new file |
| `thinking_marker_style` | enum | `minimal` | `minimal` = `[thinking elided]` (~17 chars). `verbose` = `[thinking elided ~3 KB; turn outcome: <Pass 1 summary>]` (~150-500 chars; only useful with v2 plan) |
| `keep_recent_turns` | int | adaptive | Override the "skip last N turns" floor. Default: `min(30, ceil(totalTurns/2))` — adapts to short chains |

## Broader smart-archival pipeline (the LLM-assisted path)

`condense_jsonl_blocks` is the **heuristic-only, $0** layer. For deeper trim with LLM judgment, three more tools exist:

### `analyze_for_archive` (LLM-assisted, ~$0.50/run)

Two-pass LLM analysis (Haiku) producing a per-uuid plan: keep / drop / distill per turn, with value scores 0-100.

| Arg | Type | Default | Purpose |
|---|---|---|---|
| `conversation_id` | string | (lookup) | UUID |
| `max_turns` | int | all | If set, only process the first N turns (sample-mode for cheap preview) |
| `concurrency` | int | 5 | Max in-flight Pass-1 Haiku calls (capped at 10) |
| `disable_prefilter` | bool | false | Skip the heuristic pre-filter (`micro` / `system_or_meta` turns get a synthetic Pass-1 summary without a Haiku call) |
| `aggressive` | bool | false | Pass-2 uses an aggressive prompt (target ≤50% chain reduction, drops more, distills more) |
| `force_keep_recent_n` | int | 30 | Recency safety net — last N turns force-kept regardless of Pass-2 decisions |
| `skip_purpose` | bool | false | Skip the cheap (~$0.005) Haiku purpose pre-pass that derives a 3-5 sentence "what is this session about" summary. The summary informs Pass 1 + Pass 2 judgment AND is persisted in the plan file (dashboard-reusable). |
| `allowApiKey` | bool | false | Refuses by default if OAuth (subscription billing) isn't available — explicit opt-in to fall back to ANTHROPIC_API_KEY |

Output: a plan file at `<conv_dir>/.archive-plans/<planId>.json` with `planId` + `checksum` + per-turn summaries with `value_score`.

### `apply_archive_plan` (executes a plan, $0)

Validates checksum + drift + TTL, then mutates the JSONL via shared atomic-rewrite.

| Arg | Type | Default | Purpose |
|---|---|---|---|
| `planId` | string | required | From analyze output |
| `checksum` | string | required | Tamper guard (sha256 of plan core) |
| `confirm` | bool | required true | Must explicitly opt-in (destructive) |
| `orphan_drops` | bool | true | Drops ORPHAN entries (stay in file, unreachable from chain walks; inspectable via `inspect_pruned_messages`). Set false for physical-remove. |
| `min_keep_score` | int (0-100) | — | Score-threshold override: turns with value_score ≥ this stay verbatim. Recomputes Pass-2 actions from value_score directly. |
| `min_distill_score` | int (0-100) | — | Companion: min_keep_score > score ≥ min_distill_score → distill. Below min_distill_score → drop. |

Output: condense report with per-uuid stats. Backup at `<conv_dir>/.archive-backups/<convId>.<epoch>.jsonl` (last 3 retained).

### `restore_archive_backup` (undo any apply or condense, $0)

| Arg | Type | Default | Purpose |
|---|---|---|---|
| `conversation_id` | string | (lookup) | UUID |
| `backupPath` | string | most recent | Specific backup file. Without this, restores the most-recent backup (which may be the wrong one if you want to roll back further). |

Captures a pre-restore snapshot so the restore itself is reversible.

## Suggested dashboard control panel

If you want a richer interface (vs single button):

**Tab 1 — "Quick Condense" (the simple button):**
- One click, all 8 modes, `thinking_marker_style: minimal`
- Shows result: bytes saved, blocks touched, "X% smaller"
- Restore button (latest backup)

**Tab 2 — "Configure Condense":**
- Mode checkboxes (8 modes, all checked by default with conservative/aggressive presets)
- `thinking_marker_style` dropdown (minimal/verbose)
- `keep_recent_turns` slider (default "adaptive" with manual override)
- Dry-run checkbox
- Run button

**Tab 3 — "LLM-Assisted Archival" (advanced):**
- Step 1: Analyze (model selector, aggressive checkbox, force_keep_recent_n slider)
- Step 2: Review plan (show purpose summary, per-turn decisions, value_score histogram)
- Step 3: Apply (orphan/physical-remove toggle, score-threshold sliders for tuning aggressiveness without re-analyzing)
- Estimated cost displayed at each step

**Tab 4 — "History":**
- Per-session run log (parsed from `.condense-log/<convId>.jsonl`)
- Cumulative savings chart
- Restore-from-backup picker (any of last 3)

**Sidebar widget on session card:**
- Current AC% (from Claude Code's footer if accessible; else from our `context_status` tool)
- "Condense" quick-button + "Configure" link
- Indicator badge if a recent backup or sidecar exists
