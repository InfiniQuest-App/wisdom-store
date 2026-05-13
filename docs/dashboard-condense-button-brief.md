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
- **Mode selection** (multi-select checklist of the 8 modes (see Appendix for full table))
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
  "modes": [...],             // optional, default = all 8
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

---

# Full Widget Spec (for dashboard worker)

This is the complete specification for a **"Smart Archival" control widget** that lives on each session's card or detail view. Implementation framework agnostic (React, plain DOM, etc.) — the worker decides how to render; this spec defines what the user sees, what each control does, and what happens behind it.

## Header strip (always visible)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Smart Archival   ·   claude-loop120   ·   e47eaf10                          │
│  Active chain: 1247 entries  |  ctx: 98% AC  |  file: 12.5 MB                │
│  Last condense: never · Last backup: never                                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Data sources for header:**
- Session friendly-name + UUID: from dashboard's session map
- Active chain entries + file size: shell out to `node -e "import('mcp-server/lib/jsonl.js').then(...)"` OR call the existing `mcp__wisdom-store__context_status` tool which returns these
- AC%: from Claude Code's footer cache if accessible; else show "—"
- Last condense + last backup: from `<conv_dir>/.condense-log/<convId>.jsonl` (most recent entry's timestamp) and `<conv_dir>/.condense-backups/` directory listing (newest mtime)

## Tab structure

```
┌─[ Quick Condense ]─[ Configure ]─[ LLM-Assisted ]─[ History ]──────┐
│                                                                     │
│  [tab content]                                                      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Tab 1: Quick Condense (default tab)

**Purpose:** one-click button. All 8 modes, defaults, no fuss.

```
┌──────────────────────────────────────────────────────────────┐
│  Quick Condense                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   Runs all 8 heuristic modes with safe defaults.             │
│   Zero LLM cost. Fully reversible. Idempotent.               │
│                                                              │
│   [ ] Dry run (preview only — no mutation)                   │
│                                                              │
│           ┌────────────────────────────┐                     │
│           │   ⚡ CONDENSE NOW          │                     │
│           └────────────────────────────┘                     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Behavior:** clicking the button calls the backend with:
```json
{
  "jsonl_path": "<conv_dir>/<convId>.jsonl",
  "modes": ["images", "memory-reads", "identical-reads", "stale-reads",
            "mcp-snapshots", "refetch-markers", "tool-args", "thinking"],
  "thinking_marker_style": "minimal",
  "dry_run": <checkbox state>
}
```

**Result display (after success):**

```
┌──────────────────────────────────────────────────────────────┐
│  ✓ Condense complete                                         │
│                                                              │
│   File: 12,541 KB → 9,832 KB  (-21.6%)                       │
│   Blocks touched: 487                                        │
│                                                              │
│   ▸ thinking         145 blocks  ~287 KB                     │
│   ▸ refetch-markers   84 blocks  ~225 KB                     │
│   ▸ mcp-snapshots      7 blocks   ~41 KB                     │
│   ▸ tool-args          4 blocks    ~8 KB                     │
│   ▸ memory-reads       0 blocks    ~0 KB                     │
│   ▸ images             0 blocks    ~0 KB                     │
│   ▸ stale-reads        0 blocks    ~0 KB                     │
│   ▸ identical-reads    0 blocks    ~0 KB                     │
│                                                              │
│   Backup: e47eaf10.1778625179591.jsonl                       │
│   [Restore from backup]   [View report]                      │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Tooltip on the "Dry run" checkbox:**
> "Preview what would be condensed without modifying the file. Recommended for the first run on any new session — confirms the tool finds something useful before committing."

**Tooltip on the "CONDENSE NOW" button:**
> "Runs all 8 condense modes against this conversation's JSONL. Produces a backup before mutating; safe to re-run (idempotent). The session sees the condensed file on its next turn — no /resume needed."

---

## Tab 2: Configure (advanced controls)

**Purpose:** mode picker + per-mode parameters + advanced args. Power users can tune.

```
┌──────────────────────────────────────────────────────────────┐
│  Configure Condense                                          │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Modes (8):                                                  │
│                                                              │
│   ☑ images                  Risk: ✓ none                     │
│   ☑ memory-reads            Risk: ✓ none                     │
│   ☑ identical-reads         Risk: ✓ none                     │
│   ☑ stale-reads             Risk: ✓ none                     │
│   ☑ mcp-snapshots           Risk: ✓ none                     │
│   ☑ refetch-markers         Risk: ◐ low                      │
│   ☑ tool-args               Risk: ◐ mid                      │
│   ☑ thinking                Risk: ◑ unknown                  │
│                                                              │
│   [Conservative subset]  [All 8 (default)]  [Aggressive]     │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  Thinking marker style:  ( ) minimal   ( ) verbose           │
│                                                              │
│  Keep recent N turns:  [ adaptive ]   [override ____]        │
│                                                              │
│  [ ] Dry run                                                 │
│                                                              │
│           ┌────────────────────────────┐                     │
│           │   APPLY CONFIGURATION      │                     │
│           └────────────────────────────┘                     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Mode controls (8 checkboxes):**

| Mode | Default | Tooltip |
|---|---|---|
| `images` | ☑ | "Replaces base64 image content in tool_results with `[image elided]` markers. Image still re-readable from its file path. Zero risk." |
| `memory-reads` | ☑ | "Older reads of memory-style files (MEMORY.md, CLAUDE.md, .wisdom/*, plans/*.md) get replaced with markers. Always safe — agent can re-Read these files for current state." |
| `identical-reads` | ☑ | "When the same file is read multiple times with byte-identical content, older copies become markers. Zero info loss — content was identical." |
| `stale-reads` | ☑ | "Same path + same offset + same limit, multiple reads in chain order: older reads become markers. Strict args match — never confuses partial reads at different offsets." |
| `mcp-snapshots` | ☑ | "Older copies of MCP status-snapshot tool_results (get_suggestions, get_session_info, list_workers, etc.) become markers — point-in-time data goes stale fast." |
| `refetch-markers` | ☑ | "Tool_result content for read-only tools (Read, Bash, Grep, MCP queries) becomes a summary (head/tail) + re-fetch pointer. Agent re-calls the tool if it needs full content. Safe — tools are idempotent." |
| `tool-args` | ☑ | "Verbose string fields in tool_use INPUTS for TaskCreate/Edit/Write/manualFileEdit/create_session/assign_task get a 100-char preview + pointer. Mid risk — agent's record of 'what I sent' becomes shorter; structural fields (file_path, subject) preserved." |
| `thinking` | ☑ | "Thinking-block signatures get replaced with `[thinking elided]` markers. Big space savings (signatures are bulky). Unknown subtle risk — signatures might serve as continuation primer for the model; empirical AC% drops, but qualitative continuation quality is untested in extended-thinking sessions." |

**Preset buttons:**
- **Conservative subset** → enables only: images, memory-reads, identical-reads, stale-reads, mcp-snapshots (the 5 zero-risk modes)
- **All 8 (default)** → enables everything
- **Aggressive** → All 8 + lower the `keep_recent_turns` to `5` (override the adaptive default to be more aggressive on recency)

**Thinking marker style (radio):**
- **minimal** (default) → markers like `[thinking elided]` (~17 chars). Empirically validated, byte-efficient.
- **verbose** → markers like `[thinking elided ~3 KB; turn outcome: <Pass 1 summary>]`. Only useful if an analyze-v2 plan exists for this session (otherwise falls back to a stub). ~150-500 chars per marker.

**Tooltip on thinking marker style:**
> "Minimal markers add minimal body weight — empirical evidence shows this is the right default. Verbose markers embed Pass 1 turn summaries from a prior analyze-v2 run — useful if you want the agent to see the per-turn semantic outcome without expanding the elided content. Switch to verbose only after running 'LLM-Assisted' analyze first."

**Keep recent N turns (number with adaptive option):**
- Default placeholder text: `adaptive` — uses `min(30, ceil(totalTurns/2))`
- User can type a number to override
- Validation: integer ≥ 0

**Tooltip on keep recent N:**
> "How many of the most recent turns to leave verbatim (active state). Default 'adaptive' = min(30, half of total turns). For long chains (>60 turns) that's 30. For short chains (e.g., 17 turns), it shrinks to ~9. Override with a specific integer if you want more or less recency preservation."

**Apply configuration button:** sends all selected modes + style + recent-N override to the same backend endpoint.

---

## Tab 3: LLM-Assisted (analyze + apply pipeline)

**Purpose:** richer condensation using Haiku to make per-turn semantic judgments. Costs ~$0.50/run on Haiku rate budget. Three-step wizard.

```
┌──────────────────────────────────────────────────────────────┐
│  LLM-Assisted Archival                                       │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Step 1: Analyze (Haiku)                                     │
│                                                              │
│   Model:  ( ) Haiku 4.5 (default, cheap, separate budget)    │
│           ( ) Sonnet 4.6 (higher judgment, ~4x cost)         │
│                                                              │
│   ☐ Aggressive Pass 2 (target ≤50% chain reduction)          │
│   ☐ Skip purpose pre-pass (saves ~$0.005)                    │
│                                                              │
│   Force-keep last N turns: [ 30 ] (recency safety net)       │
│                                                              │
│   Estimated cost: $0.50–0.75                                 │
│                                                              │
│           ┌────────────────────────────┐                     │
│           │   ANALYZE                  │                     │
│           └────────────────────────────┘                     │
│                                                              │
│   ─── status: not yet analyzed ───                           │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**After analyze completes, Step 2 appears:**

```
│  Step 2: Review plan                                         │
│                                                              │
│   Purpose: "This session is investigating CouchDB→Postgres   │
│              migration paths for the InfiniQuest backend..." │
│                                                              │
│   Pass 2 decisions: 250 turns → 167 keep / 76 drop / 7 distill│
│                                                              │
│   Value-score distribution:                                  │
│     0–30   ████ 15 turns (~13K tokens)                       │
│     31–50  ██ 9 turns (~8K)                                  │
│     51–70  ███ 12 turns (~14K)                               │
│     71–85  ███████████████ 78 turns (~140K)                  │
│     86–100 █████████████████ 89 turns (~120K)                │
│                                                              │
│   [Show top droppable turns]  [Show top kept turns]          │
│                                                              │
│  Step 3: Apply (with optional score-threshold override)      │
│                                                              │
│   Apply mode:  ( ) orphan (default — entries stay in file,   │
│                            unreachable from chain walks)     │
│                ( ) physical-remove (smaller file)            │
│                                                              │
│   ☐ Score-threshold override (recompute actions from score)  │
│      min_keep_score:    [ 86 ]   ← keep verbatim if ≥        │
│      min_distill_score: [ 31 ]   ← distill if score in       │
│                                     between, drop if below   │
│                                                              │
│           ┌────────────────────────────┐                     │
│           │   APPLY PLAN               │                     │
│           └────────────────────────────┘                     │
└──────────────────────────────────────────────────────────────┘
```

**Step 1 controls:**

| Control | Default | Tooltip |
|---|---|---|
| Model: Haiku 4.5 | ☑ default | "Cheaper (~4x), uses separate rate-limit budget from Sonnet. Recommended unless you need higher-judgment semantic decisions." |
| Model: Sonnet 4.6 | — | "Higher judgment quality. ~4x cost. Uses Sonnet rate budget — competes with active Sonnet sessions." |
| Aggressive Pass 2 | ☐ off | "Pass 2 prompt explicitly targets ≤50% chain reduction. Drops more turns, distills more readily, keeps fewer verbatim. Use when you've accepted information loss for context savings." |
| Skip purpose pre-pass | ☐ off | "Skip the cheap (~$0.005) Haiku pre-pass that derives a 3-5 sentence 'what is this session about' summary. The summary informs Pass 1 + Pass 2 judgment. Skipping loses some context-aware judgment quality but saves a tiny amount of money." |
| Force-keep last N turns | 30 | "Recency safety net. After Pass 2 produces decisions, override the last N turns to action='keep' regardless. The agent needs verbatim recent state to know what it was just doing. Set to 0 to disable (let Pass 2 decide all turns)." |

**Step 2 displays:**
- Purpose summary (from the analyze plan's `purpose` field)
- Decision tally (from the plan's `pass2.turnDecisions`)
- Value-score histogram (computed from `pass1.summaries[].value_score`)
- Drill-in: clicking "Show top droppable" lists turns with low scores; "top kept" lists high scores

**Step 3 controls:**

| Control | Default | Tooltip |
|---|---|---|
| Apply mode: orphan | ☑ default | "Dropped turns stay in the JSONL file (unreachable from chain walks but inspectable via inspect_pruned_messages). Reversible by re-linking parentUuids. Same context-window outcome as physical-remove; preserves history on disk." |
| Apply mode: physical-remove | — | "Dropped entries removed from the file entirely. Smaller disk footprint but historical content only recoverable from .archive-backups/." |
| Score-threshold override | ☐ off | "Recompute per-turn actions directly from the value_score Pass 1 emitted, ignoring Pass 2's keep/drop choices. Useful when you want a different aggressiveness without re-analyzing. Only available if the plan was generated by analyze-v2 with value_scores." |
| min_keep_score | 86 (when override on) | "Turns with value_score ≥ this stay verbatim. Range 0-100. Higher = more aggressive (keeps less)." |
| min_distill_score | 31 (when override on) | "Turns with min_keep_score > value_score ≥ this get distilled (replaced with 1-2 sentence summary). Below this, dropped entirely. Range 0-100." |

**Backend flow for Step 1:**
```
POST /api/analyze
{ conversation_id, model, aggressive, skip_purpose, force_keep_recent_n }
→ { ok, planId, checksum, planSummary: { ...purpose, decisions, scoreHistogram } }
```

**Backend flow for Step 3:**
```
POST /api/apply
{ planId, checksum, confirm: true, orphan_drops, min_keep_score?, min_distill_score? }
→ { ok, report, restoreCommand }
```

---

## Tab 4: History

**Purpose:** show the run log + cumulative stats + restore picker.

```
┌──────────────────────────────────────────────────────────────┐
│  Condense History — claude-loop120                           │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Cumulative: 487 blocks condensed, 658 KB raw saved over     │
│  3 runs (this session)                                       │
│                                                              │
│  ┌──────────┬──────────┬─────────────┬───────────────────┐   │
│  │ When     │ Modes    │ Δ size      │ Actions           │   │
│  ├──────────┼──────────┼─────────────┼───────────────────┤   │
│  │ 18:34    │ all 8    │ -2,119 KB   │ [restore] [view]  │   │
│  │ 18:13    │ all 8    │ -414 KB     │ [restore] [view]  │   │
│  │ 18:00    │ images   │ -152 KB     │ [restore] [view]  │   │
│  └──────────┴──────────┴─────────────┴───────────────────┘   │
│                                                              │
│  Per-mode effectiveness (across this session):               │
│   thinking         145 blocks   287 KB                       │
│   refetch-markers   84 blocks   225 KB                       │
│   mcp-snapshots      9 blocks    82 KB                       │
│   ... etc                                                    │
│                                                              │
│  Available backups (last 3 retained):                        │
│   ▸ e47eaf10.1778625179591.jsonl  18:34  (latest)            │
│   ▸ e47eaf10.1778624363921.jsonl  18:13                      │
│   ▸ e47eaf10.1778623998410.jsonl  18:00                      │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Data sources:**
- Run history table: parse `<conv_dir>/.condense-log/<convId>.jsonl` line by line, render most recent first
- Cumulative stats: sum the `bytesSaved` and `totalBlocksTouched` fields across all log entries
- Per-mode chart: aggregate `bytesSaved.<mode>` and `blocksCondensed.<mode>` across all runs
- Backups list: `ls -t <conv_dir>/.condense-backups/<convId>.*.jsonl`

**Actions per row:**
- **[restore]** → opens confirmation modal: "Restore <convId>.jsonl from this backup? Current state will be overwritten (a pre-restore snapshot will be saved automatically)." On confirm, calls `restore_archive_backup({backupPath: <path>})`.
- **[view]** → modal showing the full run report (the markdown text from the original tool output).

---

## Sidebar widget (compact, on session card)

For session cards in the dashboard's main grid:

```
┌──────────────────────────────────────────────────┐
│ claude-loop120 · 98% AC · 12.5 MB                │
│ ─────────────────────────────────────────────    │
│ [⚡ Quick Condense]  [⚙ Configure]  [📜 History] │
└──────────────────────────────────────────────────┘
```

Three buttons. First opens a confirm modal then runs Quick Condense. Second + Third open the full Smart Archival panel on the respective tab.

**Indicator badges:**
- 🆕 if no condense has ever been run on this session
- 💾 with hover-tooltip "Last condense X minutes ago, saved Y KB"
- ⚠️ with hover-tooltip if the last run had errors (parsed from the run log's content)

---

## Backend endpoints summary

| Method | Path | Purpose |
|---|---|---|
| POST | /api/condense | run condense_jsonl_blocks |
| POST | /api/analyze | run analyze_for_archive |
| POST | /api/apply | run apply_archive_plan |
| POST | /api/restore | run restore_archive_backup |
| GET  | /api/condense-history?convId=... | parse run log, return runs + cumulative stats |
| GET  | /api/backups?convId=... | list backups in .condense-backups/ |
| GET  | /api/session-status?convId=... | return chain length, file size, AC% (from context_status), last condense time |

All POST endpoints shell out to a tiny Node wrapper that imports the relevant tool and calls its handler. All GET endpoints just read filesystem state.

## Color-coded risk legend (use somewhere visible in Configure tab)

- ✓ none — content is provably re-fetchable or was duplicate
- ◐ low — content is re-fetchable via standard tool but agent has to know to re-fetch
- ◐ mid — agent's record of past actions becomes shorter; structural info preserved
- ◑ unknown — empirical effect measurable but qualitative impact untested


---

# Pre-bundled Strategies (replaces "Conservative / All 8 / Aggressive" presets)

**Use case-named** so users pick by intent, not by mode-counting. Each preset is a complete configuration.

## Strategy 1: 🛡️ Safe & Free
**For:** any session, any time. Zero risk, zero cost, fully reversible.
- **Modes:** `images`, `memory-reads`, `identical-reads`, `stale-reads`, `mcp-snapshots` (5 zero-risk modes)
- **LLM:** ❌ none
- **Cost:** $0
- **Typical impact:** 2–10% AC reduction
- **What it WON'T touch:** thinking blocks, agent text, tool inputs, mutation tool args
- **When to use:** routine cleanup; first time on any session; if you're nervous about content loss

## Strategy 2: ⚖️ Default (recommended)
**For:** any session that's getting heavy. All heuristic, balanced risk.
- **Modes:** all 8
- **LLM:** ❌ none
- **Cost:** $0
- **Typical impact:** 15–30% file shrink, 10–25% AC reduction
- **What it touches:** safe modes + thinking signatures + verbose tool inputs + tool_result summaries
- **Quirks to know:** thinking signature impact on model continuation quality is empirically un-tested; agent's record of past tool inputs becomes preview+pointer (structural fields preserved)
- **When to use:** when AC is approaching auto-compact and you want significant headroom without LLM cost

## Strategy 3: 🧠 Deep (LLM-assisted, ~$0.50)
**For:** sessions where you want semantic per-turn judgment, not just heuristic.
- **Heuristic pass:** all 8 modes first (free)
- **LLM pass:** then run `analyze_for_archive` (Haiku, ~$0.50) to identify droppable/distillable turns
- **Apply:** `apply_archive_plan` with score thresholds (default `min_keep_score=86, min_distill_score=31`)
- **LLM:** ✓ Haiku purpose pre-pass + Pass 1 per-turn classification + Pass 2 cross-turn judgment
- **Cost:** ~$0.50–0.75 (Haiku rate budget; doesn't compete with active Sonnet sessions)
- **Typical impact:** 30–50% AC reduction (combined with the heuristic pre-pass)
- **When to use:** session is past the heuristic-only floor (40-60% AC after Default) AND you want to push lower without breaking continuity; OR you want semantic-aware drops (Pass 2 catches duplicate decisions / superseded planning that pure heuristic misses)

**Default selection in the dashboard:** **Strategy 2 (Default).** Power users can change.

---

# LLM vs Heuristic at a Glance

Every mode is tagged with a `🧠` (LLM) or `🔧` (heuristic) icon in the Configure tab:

| Mode | Type | Per-block LLM cost |
|---|---|---|
| `images` | 🔧 heuristic | $0 |
| `memory-reads` | 🔧 heuristic | $0 |
| `identical-reads` | 🔧 heuristic | $0 |
| `stale-reads` | 🔧 heuristic | $0 |
| `mcp-snapshots` | 🔧 heuristic | $0 |
| `refetch-markers` | 🔧 heuristic (optionally pulls Pass 1 summary if v2 plan exists for richer marker text — but only reads, no LLM call from this mode) | $0 |
| `tool-args` | 🔧 heuristic | $0 |
| `thinking` | 🔧 heuristic (optionally pulls Pass 1 summary if `thinking_marker_style: verbose` AND v2 plan exists — same: read-only, no LLM call) | $0 |

**`condense_jsonl_blocks` is 100% heuristic.** No LLM calls. Ever.

The LLM-assisted pipeline is **separate**:
- 🧠 `analyze_for_archive` — uses Haiku for purpose pre-pass + Pass 1 classification + Pass 2 judgment. Costs ~$0.50/run.
- 🔧 `apply_archive_plan` — heuristic execution of an analyze plan. $0.

**In the widget UI:** put a small "🔧 zero LLM" badge on Tabs 1 + 2, and "🧠 uses LLM" badge on Tab 3.

---

# Empirical Results by Session Profile

Real measurements from today's testing, with recommended strategy per profile.

## Orchestrator profile (e.g., loop168 — orch-009)
**Characteristics:** lots of `send_message` (220 KB), `text/assistant` (227 KB), coordination MCP calls, fewer giant tool_results.

**Heuristic mode breakdown (loop168 baseline 101% AC):**
- `images` alone: -9% AC (2 screenshots removed)
- `memory-reads` alone: ~0% (rounding; few memory reads in active chain)
- `thinking` alone: **-16% AC** (biggest single win — 234 thinking blocks)
- `mcp-snapshots`: -1%
- `refetch-markers`: -5%

**Strategy 2 (Default heuristic) total: ~−25% AC** → from 101% to 76% AC

**Strategy 3 (Deep) added: ~−8% more** → from 76% to 68% AC

**Recommendation for orchestrators: Strategy 3 if AC > 75%; Strategy 2 if AC < 60% and you just want headroom.**

**What was weak:** the 220 KB of `send_message` tool_use INPUTS is the biggest unaddressed chunk on orchestrators. Heuristic `tool-args` doesn't touch those (mutation tools, message text not re-fetchable). Best handled via LLM-assisted apply with aggressive Pass 2 (orphans coordination-heavy turns; agent can fetch via inspect_pruned_messages).

## Worker profile (e.g., loop151 — Computers_Plus_Repair)
**Characteristics:** lots of `thinking` (286 KB pre-condense), `tool_result:Read` (217 KB), `tool_result:Bash` (165 KB), MCP DB queries. Few `send_message` (workers don't initiate coordination).

**Heuristic mode breakdown (loop151 baseline 66% AC):**
- `thinking` + `refetch-markers` + `mcp-snapshots` together: **-14% AC** (combined, individual contributions un-isolated)
- Strategy 2 (Default heuristic) total: **−14% AC** → from 66% to 52% AC

**The 4 extensions** (db_query whitelist, Edit/Write to tool-args + refetch, lower threshold) added ~0% AC marginal on already-condensed loop151 but should pick up edge cases on FRESH worker sessions.

**Recommendation for workers: Strategy 2 alone is usually enough.** Strategy 3 adds marginal value for workers — their content is mostly tool_results already covered by heuristic refetch-markers.

**What was weak:** for workers with very few turns (loop151 has 17 turns), the recent-N adaptive cap (`min(30, ceil(totalTurns/2))`) keeps a high fraction of turns verbatim. So less is condensable. Tune `keep_recent_turns` lower if you want more aggressive worker condensation.

## Investigator profile (e.g., a worker spawned for read-only research, like loop171 was)
**Characteristics:** mostly `tool_result:Read`, very few edits, lots of file content captured.

**Strategy 2 should hit hard via `refetch-markers`** (re-fetching is exactly what investigators can do — re-Read a file for current state).

**Recommendation: Strategy 2.**

## Light worker / short session (< 50 turns)
**Characteristics:** small chain, mostly recent turns are "active state."

**Default `keep_recent_turns = ceil(totalTurns/2)` will skip half the chain.** Result: only modest condensation.

**Recommendation: Strategy 1 (Safe & Free) is enough.** Strategy 2 won't find much extra to do without overriding `keep_recent_turns`.

## Heavy investigator with images (e.g., mobile UI debugging session)
**Characteristics:** lots of screenshots embedded as `Read` of `.png`/`.jpg` files.

**`images` mode alone is the killer feature** — base64 image bytes can be 100+ KB each.

**Recommendation: Strategy 1 OR Strategy 2; either captures images.**

## Untested profiles (worth measuring next)
- **Long investigator session at full-context** (1000+ turns) — does the adaptive `keep_recent_turns` floor (capped at 30) preserve enough recency?
- **Sessions with extended-thinking explicitly used by Mike post-condense** — does removing thinking signatures actually degrade subsequent extended-thinking quality? (Mike's "fingerprint / weights / private language" hypothesis untested in practice.)
- **Sessions across model switches** (Opus ↔ Sonnet ↔ Haiku) — do thinking signatures transfer between models at all?

---

# Strategy selector UI in the Configure tab

Replace the existing 3-button row with this radio-group:

```
Strategy:  ( ) 🛡️ Safe & Free      ── 5 zero-risk modes, no LLM
           (•) ⚖️ Default            ── all 8 heuristic modes (recommended)
           ( ) 🧠 Deep (LLM-assisted) ── adds ~$0.50 Haiku pass for semantic judgment

         Or [Customize modes ▾] for manual selection
```

Selecting a strategy auto-toggles the appropriate modes in the checkbox list (which becomes read-only unless "Customize" is clicked). "Customize" reveals all 8 mode toggles + advanced args.

For the LLM-assisted Strategy 3 selection, the "APPLY CONFIGURATION" button changes label to "RUN HEURISTIC + ANALYZE + APPLY" to make the multi-step nature obvious, and shows the estimated cost ($0.50–$0.75) before clicking.
