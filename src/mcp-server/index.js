#!/usr/bin/env node
/**
 * Wisdom Store MCP Server
 *
 * Provides context management and persistent knowledge tools for Claude Code sessions.
 * V1a: context_status, prune_context, inject_context
 * V1b: save_wisdom, get_wisdom, update_plan, list_wisdom
 * V1c: reindex_project, get_project_overview
 * V1d: check_symbols, refresh_symbols
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env from project root (no dotenv dependency needed)
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../../.env');
try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  }
} catch {}

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

import { handleContextStatus } from './tools/context-status.js';
import { handlePruneContext } from './tools/prune-context.js';
import { handleInjectContext } from './tools/inject-context.js';
import { handleRestoreContext } from './tools/restore-context.js';
import { handleSaveWisdom } from './tools/save-wisdom.js';
import { handleGetWisdom } from './tools/get-wisdom.js';
import { handleUpdatePlan } from './tools/update-plan.js';
import { handleListWisdom } from './tools/list-wisdom.js';
import { handleReindexProject } from './tools/reindex-project.js';
import { handleGetProjectOverview } from './tools/get-project-overview.js';
import { handleCheckSymbols } from './tools/check-symbols.js';
import { handleRefreshSymbols } from './tools/refresh-symbols.js';
import { handleBackupPlan } from './tools/backup-plan.js';
import { handleCompactContext } from './tools/compact-context.js';
import { handleAnnotateWisdom } from './tools/annotate-wisdom.js';
import { handleInspectPrunedMessages } from './tools/inspect-pruned-messages.js';
import { handleSandwichPrune } from './tools/sandwich-prune.js';
import { handleAnalyzeForArchiveV2 } from './tools/analyze-for-archive-v2.js';
import { handleCondenseJsonlBlocks } from './tools/condense-jsonl-blocks.js';
import { handleApplyArchivePlan } from './tools/apply-archive-plan.js';
import { handleRestoreArchiveBackup } from './tools/restore-archive-backup.js';
import { handleAddDir } from './tools/add-dir.js';

const server = new Server(
  { name: 'wisdom-store', version: '0.3.0' },
  { capabilities: { tools: {} } }
);

// Tool definitions
const TOOLS = [
  // V1a: Context Control
  {
    name: 'context_status',
    description: 'Check how much context you have left. Shows message count, estimated token usage, and bloat indicators. Call this when starting a complex task or when you suspect context is getting large. If usage is >70%, consider pruning old messages with prune_context before continuing.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'Conversation UUID. If omitted, finds the most recently modified conversation for the current project. Your conversation ID is shown in your status bar as [xxxxxxxx].'
        }
      }
    }
  },
  {
    name: 'prune_context',
    description: 'Free up context by trimming old messages. Works live without restart. Use when context_status shows >70% usage. Before pruning, save any important findings with save_wisdom so they survive the trim. Typical workflow: save_wisdom → prune_context(mode:"oldest_percent", percent:40) → continue working with more room.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'Conversation UUID. If omitted, finds the most recently modified conversation for the current project. Your conversation ID is shown in your status bar as [xxxxxxxx].'
        },
        mode: {
          type: 'string',
          enum: ['before_message', 'oldest_percent', 'after_phrase'],
          description: 'Pruning mode: "before_message" trims before a specific message number, "oldest_percent" trims the oldest N% of messages, "after_phrase" finds a message containing a unique phrase and makes it the new root.'
        },
        message_number: {
          type: 'integer',
          description: 'For before_message mode: trim everything before this message (1-indexed from chain start). The target message becomes the new root.'
        },
        percent: {
          type: 'number',
          description: 'For oldest_percent mode: trim this percentage of messages from the beginning (0-100).'
        },
        phrase: {
          type: 'string',
          description: 'For after_phrase mode: a unique phrase to search for in the conversation. The first message containing this phrase becomes the new root, everything before it is orphaned.'
        }
      },
      required: ['mode']
    }
  },
  {
    name: 'sandwich_prune',
    description: 'Surgical prune that preserves BOTH the start AND end of a conversation, dropping the middle bloat. Use when context is large but the original task brief (top) AND recent working state (bottom) both matter — better than prune_context(oldest_percent) for long-running sessions. Re-links the chain via parentUuid rewrite, optionally inserts a system bridge placeholder at the splice point. Pair with inspect_pruned_messages (when remove_middle_orphans:false) to view dropped content.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'Conversation UUID. If omitted, finds the most recently modified conversation for the current project.'
        },
        keep_first_n: {
          type: 'integer',
          description: 'Number of chain messages to preserve at the START (the original task brief + early context). Default: 5. Must be >= 1.',
          default: 5
        },
        keep_recent_n: {
          type: 'integer',
          description: 'Number of chain messages to preserve at the END (the recent working state). Default: 50. Must be >= 1.',
          default: 50
        },
        insert_bridge_placeholder: {
          type: 'boolean',
          description: 'If true, inserts a system message at the splice point indicating content was pruned. Default: true.',
          default: true
        },
        bridge_message: {
          type: 'string',
          description: 'Custom text for the bridge placeholder. Default explains that content was pruned and points at the JSONL backup.'
        },
        remove_middle_orphans: {
          type: 'boolean',
          description: 'If true, physically remove orphaned middle entries from the file (frees disk + breaks inspect_pruned_messages on the dropped range). If false, orphans remain on disk for later inspection. Default: true.',
          default: true
        }
      }
    }
  },
  {
    name: 'inject_context',
    description: 'Inject curated context into the conversation as a new branch. Use to restore important context after pruning or to seed a session with relevant knowledge. Auto-triggers /resume via the dashboard if available. Keep injected content natural-sounding — avoid markers like [INJECTED] that trigger prompt injection detection.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'Conversation UUID. If omitted, finds the most recently modified conversation for the current project. Your conversation ID is shown in your status bar as [xxxxxxxx].'
        },
        content: {
          type: 'string',
          description: 'The context to inject. Should be natural-sounding (avoid markers like [INJECTED] that trigger prompt injection detection). Can be formatted as pasted text, MCP responses, or conversation summaries.'
        },
        prune_orphans: {
          type: 'boolean',
          description: 'If true, delete orphaned messages after injection to reduce file size. Default: false.',
          default: false
        },
        session: {
          type: 'string',
          description: 'Tmux session name to send /resume to. If omitted, looks up by conversation ID via dashboard.'
        }
      },
      required: ['content']
    }
  },
  {
    name: 'restore_context',
    description: 'Reverse a compaction — restore the full conversation history that was summarized away. Finds the compact summary, re-links the chain to the original pre-compact messages, and orphans the summary. Works live without restart. Use when you need the full context back after a compact, or when the summary lost important details.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'Conversation UUID. If omitted, finds the most recently modified conversation for the current project.'
        }
      }
    }
  },

  // V1b: Wisdom Files
  {
    name: 'save_wisdom',
    description: 'Persist a lesson, pattern, caution, edge case, or decision so future sessions can benefit. Save when you discover something non-obvious: a tricky bug, an important constraint, a pattern that works well, or a decision rationale. Use file_path for file-specific wisdom (creates sidecar), section for broader project area knowledge, or scope:"global" for cross-project patterns. Keep entries concise and actionable — future you will thank present you.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The wisdom to save. Should be concise and actionable.'
        },
        wisdom_type: {
          type: 'string',
          enum: ['lesson', 'pattern', 'caution', 'edge_case', 'decision'],
          description: 'Type of wisdom. Default: lesson.'
        },
        file_path: {
          type: 'string',
          description: 'File to attach wisdom to (creates <file>.wisdom sidecar).'
        },
        section: {
          type: 'string',
          description: 'Project section name (writes to .wisdom/sections/<name>.md).'
        },
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description: 'Scope: "project" (default) or "global" (cross-project, saved to ~/.claude/wisdom/).'
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keywords for indexing. Helps palette find this wisdom later.'
        }
      },
      required: ['content']
    }
  },
  {
    name: 'get_wisdom',
    description: 'Load relevant wisdom before working on a file or area. Call with no args for a project overview, then drill into specifics. Recommended workflow: get_wisdom() overview → get_wisdom(file_path) for the files you are about to edit → get_wisdom(keyword) if you need to find related knowledge. This gives you accumulated project knowledge from previous sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Get sidecar wisdom for this file.'
        },
        section: {
          type: 'string',
          description: 'Get wisdom for this project section.'
        },
        plan: {
          type: 'string',
          description: 'Get a specific plan by name.'
        },
        keyword: {
          type: 'string',
          description: 'Search all wisdom for this keyword.'
        },
        mode: {
          type: 'string',
          enum: ['overview'],
          description: 'Set to "overview" for compact project wisdom summary.'
        }
      }
    }
  },
  {
    name: 'update_plan',
    description: 'Document a feature plan so future sessions understand what was built and why. Include files it touches, design decisions, and current status. Update existing plans when you complete or change direction on a feature. Plans are stored in .wisdom/plans/ and cross-referenced in the project index.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Plan name (will be slugified for filename).'
        },
        content: {
          type: 'string',
          description: 'Full plan content (markdown). If provided, replaces the entire plan file.'
        },
        description: {
          type: 'string',
          description: 'Plan description (used when building from fields, not full content).'
        },
        status: {
          type: 'string',
          enum: ['active', 'completed', 'abandoned', 'paused'],
          description: 'Plan status.'
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files this plan touches.'
        },
        sections: {
          type: 'array',
          items: { type: 'string' },
          description: 'Sections this plan belongs to.'
        },
        decisions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Design decisions made for this plan.'
        },
        replace: {
          type: 'boolean',
          description: 'If true, replace existing plan entirely. Default: false (merge/append).'
        }
      },
      required: ['name']
    }
  },
  {
    name: 'list_wisdom',
    description: 'Browse what wisdom exists in the project. Filter by: all, sections, plans, patterns, sidecars, or global.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['all', 'sections', 'plans', 'patterns', 'sidecars', 'global'],
          description: 'What to list. Default: all.'
        }
      }
    }
  },

  // V1c: Project Index
  {
    name: 'reindex_project',
    description: 'Build or refresh the project symbol index. Extracts all functions, classes, variables, and exports using AST parsing (JS/TS) or regex (Python/Go/Rust). Run this when starting work on a project for the first time, or after significant code changes. The index powers check_symbols and get_project_overview. Fast: ~350 files in under 2 seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'Project root path. If omitted, auto-detects from cwd.'
        },
        max_depth: {
          type: 'integer',
          description: 'Max directory depth to scan. Default: 8.'
        },
        max_files: {
          type: 'integer',
          description: 'Max files to scan. Default: 2000.'
        }
      }
    }
  },
  {
    name: 'get_project_overview',
    description: 'Get a compact map of the project: file tree with line counts, all classes/types, and all exports. Call this early in a session to orient yourself in an unfamiliar codebase. Much cheaper than reading individual files. Auto-runs reindex_project if no index exists yet.',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'Project root path. If omitted, auto-detects from cwd.'
        }
      }
    }
  },

  // V1d: Symbol Registry
  {
    name: 'check_symbols',
    description: 'Verify symbol names you just used are real. Pass function/class/variable names and get back: confirmed (exists), fuzzy match (possible typo — did you mean X?), or unknown (might be hallucinated). Call this after writing code that references existing symbols, especially in unfamiliar parts of the codebase. Only reports problems — confirmed symbols are counted but not listed.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of symbol names to check against the registry.'
        },
        project_path: {
          type: 'string',
          description: 'Project root path. If omitted, auto-detects from cwd.'
        },
        verbose: {
          type: 'boolean',
          description: 'If true, also list all known symbols. Default: false.'
        }
      },
      required: ['symbols']
    }
  },
  {
    name: 'refresh_symbols',
    description: 'Re-scan the project and update the symbol registry. Run this after you have made code changes (added/renamed/removed functions) so that check_symbols works against the latest codebase state.',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'Project root path. If omitted, auto-detects from cwd.'
        },
        max_depth: {
          type: 'integer',
          description: 'Max directory depth to scan. Default: 8.'
        },
        max_files: {
          type: 'integer',
          description: 'Max files to scan. Default: 2000.'
        }
      }
    }
  },
  // Utility
  {
    name: 'backup_plan',
    description: 'Back up your current Claude Code plan file to .wisdom/plan-backups/. Your plan name is in your plan mode system prompt (the filename in ~/.claude/plans/). Saves a timestamped copy so you can restore it later.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_name: {
          type: 'string',
          description: 'The plan filename (e.g. "peppy-launching-book"). Found in your plan mode system prompt path.'
        },
        source_path: {
          type: 'string',
          description: 'Optional full path to the plan file, if it is not in the default ~/.claude/plans/ directory.'
        }
      },
      required: ['plan_name']
    }
  },
  {
    name: 'annotate_wisdom',
    description: 'Add a comment or correction to existing wisdom. Use when you discover a previous assumption was wrong, needs clarification, or has new context. Annotations are timestamped and appended below the matching entry. Think of it as leaving a sticky note for future sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        comment: {
          type: 'string',
          description: 'The annotation to add (e.g. "Actually XYZ is wrong because...", "To clarify: you also need to...")'
        },
        section: {
          type: 'string',
          description: 'Section name to annotate (writes to .wisdom/sections/<name>.md)'
        },
        file_path: {
          type: 'string',
          description: 'File path whose sidecar to annotate (<file>.wisdom)'
        },
        search: {
          type: 'string',
          description: 'Text to search for within the wisdom file to place the annotation near. If omitted, appends to end.'
        }
      },
      required: ['comment']
    }
  },
  {
    name: 'inspect_pruned_messages',
    description: 'Reveal content from a section orphaned by prune_context, with nested progressive disclosure. The orphaned messages are still in the JSONL file (parentUuid:null on the new root just hides them from Claude); this tool reads them back. Five modes from narrowest-and-cheapest to widest:\n\n  1. turn_id: N (no other args) → lightweight TURN SUMMARY: user prompt + numbered action list (each tool call with key params + final assistant text). Default turn_id behavior, designed for "what happened in this turn?" without loading 30 raw messages.\n  2. turn_id: N, action_id: M → drill into one specific action\'s raw message.\n  3. turn_id: N, action_range: [M, K] → range of actions within the turn.\n  4. turn_id: N, full: true → all raw messages in turn (heavy; use only when you really need it).\n  5. turn_range: [N, M] → all messages across multiple turns.\n  6. message_range: [start, end] → arbitrary 1-indexed message range (max 100).\n  7. segment_id: N → 200-message chunk matching prune_context output IDs.\n\nRecommended workflow: prune_context output gives you turn IDs and action counts. Use turn_id alone for the summary, then action_id/action_range to drill in.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'Conversation UUID to inspect. If omitted, finds the most recently modified conversation for the current project.'
        },
        turn_id: {
          type: 'integer',
          description: '1-indexed turn number. By default returns a lightweight turn summary (user prompt + numbered action list). Combine with action_id, action_range, or full for different reveal granularities.'
        },
        action_id: {
          type: 'integer',
          description: '1-indexed action within the turn (only with turn_id). Returns the raw message containing that specific tool_use or assistant text.'
        },
        action_range: {
          type: 'array',
          items: { type: 'integer' },
          description: '[first_action, last_action] within the turn (only with turn_id). Returns the raw message range spanning those actions.'
        },
        full: {
          type: 'boolean',
          description: 'When true with turn_id, returns ALL raw messages in the turn (heavy — typically prefer the default summary or action_id/action_range drill-in).',
          default: false
        },
        turn_range: {
          type: 'array',
          items: { type: 'integer' },
          description: '[first_turn, last_turn]. Returns all messages across that turn range. Use for inspecting a few related turns at once.'
        },
        segment_id: {
          type: 'integer',
          description: '1-indexed segment number from prune_context output. Maps to messages [(segment_id-1)*200+1, segment_id*200]. Widest reveal granularity.'
        },
        segment_size: {
          type: 'integer',
          description: 'Override default segment size (200) — only meaningful with segment_id. Match what prune_context used.'
        },
        message_range: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Explicit [start, end] 1-indexed message numbers (max 100 per call). Use for arbitrary ranges that don\'t align with turns or segments.'
        }
      }
    }
  },
  {
    name: 'compact_context',
    description: 'Request context compaction for your session. Sends /compact to your tmux session via the dashboard — it executes after your current turn completes. Use when context is getting large and you want to compact proactively. Save important findings with save_wisdom first, as compaction summarizes and trims conversation history. Requires DASHBOARD_URL env var.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'Conversation UUID. If omitted, auto-detects from the current project.'
        },
        session: {
          type: 'string',
          description: 'Tmux session name. If omitted, looks up by conversation ID via dashboard.'
        },
        bypass_wisdom_save: {
          type: 'boolean',
          description: 'Skip the PreCompact wisdom-save check. Default false — the dashboard\'s PreCompact hook will block compaction unless wisdom is saved first OR this is true. Use only after verifying nothing important needs saving.',
          default: false
        }
      }
    }
  },
  {
    name: 'analyze_for_archive',
    description: 'Generate an LLM-driven archival trim plan for a Claude Code conversation JSONL. Two-pass architecture: Pass 1 classifies + summarizes each turn via Haiku (concurrent, cacheable system prompt, with heuristic pre-filter for obvious discardables); Pass 2 makes cross-turn keep/drop/distill decisions over the collected summaries. Produces a per-uuid plan that apply_archive_plan can validate and execute, and restore_archive_backup can undo. Bills against your Claude subscription via OAuth (Haiku rate budget — Sonnet bucket untouched). Use max_turns to sample-run before unleashing on a large session.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string' },
        max_turns: {
          type: 'integer',
          description: 'If set, only process the first N turns (useful for sampling on a large session before committing to a full run).'
        },
        concurrency: {
          type: 'integer',
          description: 'Max in-flight Pass 1 calls. Default 5; capped at 10 to stay polite.',
          default: 5
        },
        disable_prefilter: {
          type: 'boolean',
          description: 'Default false. When false, obviously-discardable turns (single-entry, multi-entry no-tool-use under 700 chars) skip the Haiku call and get a synthetic summary. Validated 100% precision on loop168 — saves ~30% Pass 1 cost. Set true to force every turn through Haiku for comparison testing.',
          default: false
        },
        allowApiKey: {
          type: 'boolean',
          description: 'Default false. Refuses without OAuth unless explicitly opted into ANTHROPIC_API_KEY (no surprise charges).',
          default: false
        },
        aggressive: {
          type: 'boolean',
          description: 'Default false. When true, Pass 2 uses an aggressive archival prompt (target ~50% chain reduction; drops more turns; distills more readily). Use when the user has explicitly accepted information loss in exchange for context savings.',
          default: false
        },
        force_keep_recent_n: {
          type: 'integer',
          description: 'Recency safety net: force the last N turns to action="keep" regardless of Pass 2 decisions. Default 30. Set to 0 to disable (let Pass 2 decide for all turns including recent state).',
          default: 30
        },
        skip_purpose: {
          type: 'boolean',
          description: 'Default false. When false, runs a cheap Haiku pre-pass over user messages to derive a 3-5 sentence session-purpose statement, fed to Pass 1 + Pass 2 as guiding context (and persisted in the plan file for dashboard reuse). Set true to skip (saves ~$0.005 + the small additional latency).',
          default: false
        }
      }
    }
  },
  {
    name: 'condense_jsonl_blocks',
    description: 'Heuristic per-block JSONL condenser. Replaces base64 image content, older memory-style file reads, and byte-identical duplicate reads with markers — keeps uuid+parentUuid+chain shape intact (block-level surgery, not turn-level). Zero LLM cost, zero rate-limit risk, fully reversible via restore_archive_backup. Use as a pre-pass before analyze_for_archive_v2 to shrink the JSONL before LLM analysis, or standalone for a free cleanup pass.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string' },
        dry_run: {
          type: 'boolean',
          description: 'Default false. If true, reports what would be condensed without modifying the file. Recommended for first run on a new conversation.',
          default: false
        },
        modes: {
          type: 'array',
          items: { type: 'string', enum: ['images', 'memory-reads', 'identical-reads', 'thinking', 'stale-reads', 'mcp-snapshots', 'refetch-markers', 'tool-args'] },
          description: 'Which heuristics to apply. Default all (images, memory-reads, identical-reads, thinking). images=base64 image content; memory-reads=older reads of MEMORY.md/CLAUDE.md/.wisdom/*; identical-reads=older reads with byte-identical content; thinking=condense thinking blocks in older turns (uses v2 plan summaries when available, else heuristic last-paragraph fallback).'
        },
        thinking_marker_style: {
          type: 'string',
          enum: ['minimal', 'verbose'],
          description: 'How to mark a condensed thinking block. Default "minimal" = single short marker like "[thinking elided]" — empirical evidence on loop168 shows verbose markers added ~17K body tokens across 234 condensations (Pass 1 summary embedded in marker). "verbose" = "[thinking elided ~3 KB; turn outcome: <Pass 1 summary>]" — useful only if you plan to read the JSONL manually.',
          default: 'minimal'
        }
      }
    }
  },
  {
    name: 'apply_archive_plan',
    description: 'Apply a trim plan generated by analyze_for_archive. Validates checksum + TTL + JSONL drift (lastMessageUuid + chain length) before any mutation. Backs up the JSONL to .archive-backups/ first (last 3 retained), then drops/distills entries via the shared atomic-rewrite utility. Drops are hot-trim safe (no /resume). Distills change visible content of kept entries — returns requiresResume:true. Pair with restore_archive_backup if a plan goes wrong.',
    inputSchema: {
      type: 'object',
      properties: {
        planId: {
          type: 'string',
          description: 'Plan ID returned by analyze_for_archive.'
        },
        checksum: {
          type: 'string',
          description: 'Plan checksum (sha256). Must match the value the plan was generated with — guards against tampering or stale apply.'
        },
        confirm: {
          type: 'boolean',
          description: 'Must be explicitly true to proceed. This is destructive (mutates the JSONL); the explicit confirm prevents accidental application.'
        },
        orphan_drops: {
          type: 'boolean',
          description: 'Default true. When true, drop actions ORPHAN entries (stay in file, unreachable from chain walks; inspectable via inspect_pruned_messages; trivially reversible by re-linking parentUuids). When false, drops physically remove entries from the file.',
          default: true
        },
        min_keep_score: {
          type: 'integer',
          description: 'Optional score-threshold override. When set, recomputes per-turn actions from value_score: turns with value_score >= min_keep_score → keep verbatim. Requires the plan was generated by analyze v2 with value_score in pass1.summaries. Pair with min_distill_score for full threshold control. Lets you tune aggressiveness without re-running analyze.',
          minimum: 0,
          maximum: 100
        },
        min_distill_score: {
          type: 'integer',
          description: 'Optional score-threshold override paired with min_keep_score. Turns with min_keep_score > value_score >= min_distill_score → distill (uses Pass 2 distillation if available, else Pass 1 summary). Turns with value_score < min_distill_score → drop. Default 31 when min_keep_score is set without explicit min_distill_score.',
          minimum: 0,
          maximum: 100
        }
      },
      required: ['planId', 'checksum', 'confirm']
    }
  },
  {
    name: 'restore_archive_backup',
    description: 'Safety net for bad apply_archive_plan results. Restores the JSONL from its most recent backup (or a specified backupPath). Hot-restore — Claude Code re-walks the chain each turn so the restored content is visible immediately without /resume. Captures a pre-restore snapshot so the restore itself can be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'Conversation UUID. If omitted, uses the most-recently-modified conversation for the current project.'
        },
        backupPath: {
          type: 'string',
          description: 'Explicit backup file path. If omitted, uses the most recent backup for the resolved conversation.'
        }
      }
    }
  },
  {
    name: 'add_dir',
    description: 'Expand your Claude Code permission scope to include an additional directory. Use when you need to read/edit files outside your current project tree (e.g., a sibling project, /tmp, an absolute path elsewhere). The dashboard sends `/add-dir <path>` to your tmux session as a real slash command. Permission grant is per-session and persists until session restart.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute directory path to add to your permission scope.'
        },
        conversation_id: {
          type: 'string',
          description: 'Conversation UUID. If omitted, auto-detects from the current project.'
        },
        session: {
          type: 'string',
          description: 'Tmux session name. If omitted, looks up by conversation ID via dashboard.'
        }
      },
      required: ['path']
    }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'context_status':
        return await handleContextStatus(args);
      case 'prune_context':
        return await handlePruneContext(args);
      case 'inject_context':
        return await handleInjectContext(args);
      case 'restore_context':
        return await handleRestoreContext(args);
      case 'save_wisdom':
        return await handleSaveWisdom(args);
      case 'get_wisdom':
        return await handleGetWisdom(args);
      case 'update_plan':
        return await handleUpdatePlan(args);
      case 'list_wisdom':
        return await handleListWisdom(args);
      case 'reindex_project':
        return await handleReindexProject(args);
      case 'get_project_overview':
        return await handleGetProjectOverview(args);
      case 'check_symbols':
        return await handleCheckSymbols(args);
      case 'refresh_symbols':
        return await handleRefreshSymbols(args);
      case 'backup_plan':
        return await handleBackupPlan(args);
      case 'compact_context':
        return await handleCompactContext(args);
      case 'annotate_wisdom':
        return await handleAnnotateWisdom(args);
      case 'inspect_pruned_messages':
        return await handleInspectPrunedMessages(args);
      case 'sandwich_prune':
        return await handleSandwichPrune(args);
      case 'analyze_for_archive':
        return await handleAnalyzeForArchiveV2(args);
      case 'condense_jsonl_blocks':
        return await handleCondenseJsonlBlocks(args);
      case 'apply_archive_plan':
        return await handleApplyArchivePlan(args);
      case 'restore_archive_backup':
        return await handleRestoreArchiveBackup(args);
      case 'add_dir':
        return await handleAddDir(args);
      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true
        };
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true
    };
  }
});

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
