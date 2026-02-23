/**
 * backup_plan tool
 *
 * Backs up a Claude Code plan file from ~/.claude/plans/ to
 * .wisdom/plan-backups/ with a timestamp. Claude knows its plan
 * name from the plan mode system prompt.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { findProjectRoot, getWisdomDir } from '../lib/wisdom.js';

const PLANS_DIR = path.join(os.homedir(), '.claude', 'plans');

export async function handleBackupPlan(args) {
  if (!args.plan_name) {
    return {
      content: [{ type: 'text', text: 'plan_name is required. This is the name from your plan mode system prompt (e.g. "peppy-launching-book").' }],
      isError: true
    };
  }

  // Normalize: strip .md extension and path if accidentally included
  const name = path.basename(args.plan_name, '.md');
  const sourcePath = args.source_path || path.join(PLANS_DIR, `${name}.md`);

  if (!fs.existsSync(sourcePath)) {
    // List available plans to help
    const available = fs.readdirSync(PLANS_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace('.md', ''))
      .slice(0, 10);
    return {
      content: [{ type: 'text', text: `Plan "${name}" not found in ~/.claude/plans/.\nAvailable plans: ${available.join(', ')}` }],
      isError: true
    };
  }

  const content = fs.readFileSync(sourcePath, 'utf8');

  // Destination: .wisdom/plan-backups/ in the project
  const projectRoot = findProjectRoot();
  const wisdomDir = getWisdomDir(projectRoot, true);
  const backupsDir = path.join(wisdomDir, 'plan-backups');
  fs.mkdirSync(backupsDir, { recursive: true });

  // Filename: planname-YYYY-MM-DD-HHMMSS.md
  const now = new Date();
  const ts = now.toISOString().replace(/[T:]/g, '-').replace(/\..+/, '');
  const destName = `${name}-${ts}.md`;
  const destPath = path.join(backupsDir, destName);

  fs.writeFileSync(destPath, content, 'utf8');

  const sizeKb = (content.length / 1024).toFixed(1);
  return {
    content: [{ type: 'text', text: `Plan "${name}" backed up (${sizeKb} KB) → .wisdom/plan-backups/${destName}` }]
  };
}
