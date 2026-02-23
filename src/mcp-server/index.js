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

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

import { handleContextStatus } from './tools/context-status.js';
import { handlePruneContext } from './tools/prune-context.js';
import { handleInjectContext } from './tools/inject-context.js';
import { handleSaveWisdom } from './tools/save-wisdom.js';
import { handleGetWisdom } from './tools/get-wisdom.js';
import { handleUpdatePlan } from './tools/update-plan.js';
import { handleListWisdom } from './tools/list-wisdom.js';
import { handleReindexProject } from './tools/reindex-project.js';
import { handleGetProjectOverview } from './tools/get-project-overview.js';
import { handleCheckSymbols } from './tools/check-symbols.js';
import { handleRefreshSymbols } from './tools/refresh-symbols.js';
import { handleBackupPlan } from './tools/backup-plan.js';

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
