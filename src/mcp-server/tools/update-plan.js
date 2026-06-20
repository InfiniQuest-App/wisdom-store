/**
 * update_plan tool
 *
 * Create or update a plan in .wisdom/plans/.
 * Plans span multiple files and sections, capturing:
 * - What the feature/system does
 * - How it works
 * - Files it touches
 * - Design decisions
 * - Status (active, completed, abandoned)
 * - Last reviewed date
 */

import {
  findProjectRoot,
  getWisdomDir,
  readPlan,
  writePlan,
  readIndex,
  writeIndex
} from '../lib/wisdom.js';

export async function handleUpdatePlan(args) {
  if (!args.name) {
    return {
      content: [{ type: 'text', text: 'Plan name is required.' }],
      isError: true
    };
  }

  const projectRoot = findProjectRoot();
  const wisdomDir = getWisdomDir(projectRoot, true);

  const planName = args.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase();

  if (args.content) {
    // Full content replacement
    writePlan(wisdomDir, planName, args.content);
  } else {
    // Build from structured fields
    const existing = readPlan(wisdomDir, planName);
    const date = new Date().toISOString().split('T')[0];

    let content;
    if (existing && !args.replace) {
      // Append/update existing plan
      content = existing;
      if (args.description) {
        content = content.replace(/^## Description[\s\S]*?(?=^## |\Z)/m, '') +
          `\n## Description\n${args.description}\n`;
      }
      if (args.status) {
        content = content.replace(/\*Status\*: .*/, `*Status*: ${args.status} | *Updated*: ${date}`);
      }
    } else {
      // Create new plan
      content = [
        `# ${args.name}`,
        ``,
        `*Status*: ${args.status || 'active'} | *Created*: ${date} | *Last reviewed*: ${date}`,
        ``,
        args.description ? `## Description\n${args.description}\n` : '',
        args.files ? `## Files\n${args.files.map(f => `- ${f}`).join('\n')}\n` : '',
        args.decisions ? `## Design Decisions\n${args.decisions.map(d => `- ${d}`).join('\n')}\n` : '',
        args.sections ? `## Sections\n${args.sections.map(s => `- ${s}`).join('\n')}\n` : '',
      ].filter(Boolean).join('\n');
    }

    writePlan(wisdomDir, planName, content);
  }

  // Update index
  const index = readIndex(wisdomDir);
  index.plans = index.plans || {};
  index.plans[planName] = {
    file: `plans/${planName}.md`,
    status: args.status || index.plans[planName]?.status || 'active',
    sections: args.sections || index.plans[planName]?.sections || [],
    files: args.files || index.plans[planName]?.files || []
  };

  // Cross-reference sections
  if (args.sections) {
    for (const section of args.sections) {
      index.sections = index.sections || {};
      index.sections[section] = index.sections[section] || { files: [], plans: [] };
      if (!index.sections[section].plans.includes(planName)) {
        index.sections[section].plans.push(planName);
      }
    }
  }

  writeIndex(wisdomDir, index);

  return {
    content: [{ type: 'text', text: `Plan "${planName}" saved to .wisdom/plans/${planName}.md` }]
  };
}
