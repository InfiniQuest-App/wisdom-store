/**
 * refresh_symbols tool
 *
 * Re-scan the project and update .wisdom/symbols.json.
 * Thin wrapper around reindex_project — exists as a separate tool
 * because the vision doc specifies it and it's a clearer name
 * for the symbol-checking workflow.
 */

import { handleReindexProject } from './reindex-project.js';

export async function handleRefreshSymbols(args) {
  return handleReindexProject(args);
}
