/**
 * Shared mutation primitive for JSONL conversation files.
 *
 * Realizes the `rewriteJsonl({drop, replace, append})` utility flagged in the
 * sandwich-prune.js TODO. Carries the same race-guard + atomic tmp+rename
 * safety used inline by lib/jsonl.js's rewriteLine, prune-context.js, and
 * sandwich-prune.js — single tested implementation those tools can migrate to.
 *
 * Operations are applied in this order during the single file pass:
 *   1. drop:    Set<uuid> — entries with matching uuid are physically removed.
 *   2. replace: Map<uuid, fullEntry> — entries with matching uuid are replaced
 *               in place by the provided full entry. Caller is responsible for
 *               passing FULL entries (not the lightweight {uuid,parentUuid,type,
 *               timestamp} subset that readJsonl returns for >50MB files); a
 *               lightweight subset would destroy message body and metadata.
 *   3. append:  Array<fullEntry> — entries are appended to the file end after
 *               all existing lines. Use for bridge messages, summaries, etc.
 *
 * Lines that fail JSON.parse are preserved as-is (defensive — don't lose
 * weird-but-present data). Blank lines are dropped from the output (they were
 * always semantically empty).
 *
 * @param {string} filePath - absolute path to the JSONL file
 * @param {object} ops
 * @param {Set<string>} [ops.drop] - uuids to remove
 * @param {Map<string,object>} [ops.replace] - uuid → full replacement entry
 * @param {Array<object>} [ops.append] - entries to append at end
 * @returns {{ sizeBefore, sizeAfter, droppedCount, replacedCount, appendedCount,
 *            droppedActual, replacedActual }} stats. droppedActual/replacedActual
 *            count entries the file actually contained (a uuid in `drop` that
 *            isn't in the file doesn't increment droppedActual).
 * @throws {Error} on race detection (file grew between open and write) or any
 *                 filesystem error during the atomic swap.
 */

import fs from 'fs';

export function rewriteJsonl(filePath, { drop, replace, append } = {}) {
  const dropSet = drop instanceof Set ? drop : new Set(drop || []);
  const replaceMap = replace instanceof Map
    ? replace
    : new Map(Object.entries(replace || {}));
  const appendArr = Array.isArray(append) ? append : [];

  const sizeBefore = fs.statSync(filePath).size;
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const outputLines = [];

  let droppedActual = 0;
  let replacedActual = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    let parsed;
    try { parsed = JSON.parse(line); }
    catch { outputLines.push(line); continue; }

    const u = parsed.uuid;
    if (u && dropSet.has(u)) {
      droppedActual++;
      continue;
    }
    if (u && replaceMap.has(u)) {
      outputLines.push(JSON.stringify(replaceMap.get(u)));
      replacedActual++;
      continue;
    }
    outputLines.push(line);
  }

  for (const entry of appendArr) {
    outputLines.push(JSON.stringify(entry));
  }

  // Race guard: live writer (Claude Code appending) detection.
  const sizeNow = fs.statSync(filePath).size;
  if (sizeNow !== sizeBefore) {
    throw new Error(
      `rewriteJsonl: file ${filePath} was modified concurrently ` +
      `(size ${sizeBefore} → ${sizeNow}). Aborting to avoid clobbering live writer's data. Retry.`
    );
  }

  // Atomic on-disk swap: tmp + rename. Same-fs rename is atomic on POSIX.
  const tmpPath = filePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmpPath, outputLines.join('\n') + '\n');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw e;
  }

  return {
    sizeBefore,
    sizeAfter: fs.statSync(filePath).size,
    droppedCount: dropSet.size,
    replacedCount: replaceMap.size,
    appendedCount: appendArr.length,
    droppedActual,
    replacedActual
  };
}
