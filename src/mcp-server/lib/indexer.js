/**
 * Project indexer and symbol extraction using @ast-grep/napi.
 *
 * AST-based symbol extraction supporting:
 * - JavaScript/TypeScript/TSX: functions, classes, variables, exports, interfaces, types, enums
 * - Python: functions, classes, variables (via regex fallback)
 * - Go: functions, types, structs (via regex fallback)
 * - Rust: functions, structs, enums, traits (via regex fallback)
 *
 * JS/TS uses proper AST parsing via ast-grep (tree-sitter).
 * Other languages use regex as fallback until their ast-grep lang plugins are added.
 *
 * Benchmarked: ~0.35ms/file parse, ~69ms full project scan (103 files).
 */

import fs from 'fs';
import path from 'path';
import { parse, Lang } from '@ast-grep/napi';

// Directories to always skip
const SKIP_DIRS = new Set([
  // Package managers / tooling
  'node_modules', '.git', '.wisdom', '.claude', 'dist', 'build',
  'coverage', '.next', '__pycache__', '.tox', '.venv', 'venv',
  'vendor', 'target', '.cache', '.turbo', '.github',
  // Backups / archive / generated
  'archive', 'backups', 'backup', 'logs', 'tmp',
  'uploads', 'media', 'data', 'migrations',
  // Non-code / static content
  'content', 'Website', 'public', 'static', 'assets',
]);

// File extensions and their ast-grep language (or 'regex' for fallback)
const LANG_MAP = {
  '.js': { lang: Lang.JavaScript, name: 'javascript' },
  '.mjs': { lang: Lang.JavaScript, name: 'javascript' },
  '.cjs': { lang: Lang.JavaScript, name: 'javascript' },
  '.jsx': { lang: Lang.JavaScript, name: 'javascript' },
  '.ts': { lang: Lang.TypeScript, name: 'typescript' },
  '.tsx': { lang: Lang.Tsx, name: 'typescript' },
  '.py': { lang: null, name: 'python' },
  '.go': { lang: null, name: 'go' },
  '.rs': { lang: null, name: 'rust' },
  '.html': { lang: null, name: 'html' },
};

/**
 * Scan a project directory and extract all symbols.
 */
export function scanProject(projectRoot, options = {}) {
  const maxDepth = options.maxDepth || 8;
  const maxFiles = options.maxFiles || 2000;
  const files = [];
  const symbols = {
    functions: {},
    classes: {},
    variables: {},
    exports: {},
    apiRoutes: {},
    htmlPages: {},
  };

  // Read .gitignore for extra skip dirs
  const extraSkip = readGitignoreDirs(projectRoot);

  walkDir(projectRoot, projectRoot, files, symbols, 0, maxDepth, maxFiles, extraSkip);
  return { files, symbols };
}

/**
 * Parse .gitignore for directory entries to skip.
 * Only extracts simple directory patterns (no globs).
 */
function readGitignoreDirs(projectRoot) {
  const dirs = new Set();
  const gitignorePath = path.join(projectRoot, '.gitignore');
  try {
    const content = fs.readFileSync(gitignorePath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      // Match directory entries like "Website/" or "GoogleDrive"
      const dirMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\/?$/);
      if (dirMatch) {
        dirs.add(dirMatch[1]);
      }
    }
  } catch { /* no .gitignore */ }
  return dirs;
}

function walkDir(dir, projectRoot, files, symbols, depth, maxDepth, maxFiles, extraSkip) {
  if (depth > maxDepth || files.length >= maxFiles) return;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return; }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (files.length >= maxFiles) break;
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    if (extraSkip && extraSkip.has(entry.name)) continue;
    // Skip dirs with spaces (usually backups/copies) or containing 'backup'/'Backup'
    if (entry.isDirectory() && (entry.name.includes(' ') || /backup/i.test(entry.name))) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walkDir(fullPath, projectRoot, files, symbols, depth + 1, maxDepth, maxFiles, extraSkip);
      continue;
    }

    const ext = path.extname(entry.name);
    const langInfo = LANG_MAP[ext];
    if (!langInfo) continue;

    const relPath = path.relative(projectRoot, fullPath);

    try {
      const stat = fs.statSync(fullPath);
      // HTML monoliths (e.g. admin_tickets.html) can be large but we only
      // extract inline <script> blocks, so allow up to 5MB for HTML files
      const sizeLimit = langInfo.name === 'html' ? 5 * 1024 * 1024 : 500 * 1024;
      if (stat.size > sizeLimit) continue;

      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');

      files.push({
        path: relPath,
        lang: langInfo.name,
        lines: lines.length,
        size: stat.size,
        modified: stat.mtime.toISOString().split('T')[0]
      });

      if (langInfo.name === 'html') {
        extractHtml(relPath, content, symbols);
      } else if (langInfo.lang) {
        extractWithAst(relPath, content, langInfo.lang, symbols);
      } else {
        extractWithRegex(relPath, lines, langInfo.name, symbols);
      }
    } catch { /* skip unreadable/unparseable files */ }
  }
}

/**
 * Extract symbols using ast-grep AST parsing.
 */
function extractWithAst(filePath, content, lang, symbols, lineOffset = 0) {
  let root;
  try {
    root = parse(lang, content).root();
  } catch {
    return;
  }

  try {
    extractAstSymbols(root, filePath, lang, symbols, lineOffset);
  } catch (e) {
    // If AST extraction fails, don't lose other files' symbols
    // AST extraction failed — continue without losing other files' data
  }
}

function extractAstSymbols(root, filePath, lang, symbols, lineOffset = 0) {
  const isTS = (lang === Lang.TypeScript || lang === Lang.Tsx);

  // Extract function declarations
  const funcDecls = root.findAll({ rule: { kind: 'function_declaration' } });
  for (const node of funcDecls) {
    const name = node.field('name');
    if (name) addSymbol(symbols.functions, name.text(), filePath, name.range().start.line + 1 + lineOffset);
  }

  // Extract arrow/const functions: const foo = (...) => or const foo = function
  const lexDecls = root.findAll({ rule: { kind: 'lexical_declaration' } });
  for (const node of lexDecls) {
    const declarators = node.findAll({ rule: { kind: 'variable_declarator' } });
    for (const decl of declarators) {
      const nameNode = decl.field('name');
      const valueNode = decl.field('value');
      if (!nameNode || !valueNode) continue;

      const valueKind = valueNode.kind();
      if (valueKind === 'arrow_function' || valueKind === 'function_expression') {
        addSymbol(symbols.functions, nameNode.text(), filePath, nameNode.range().start.line + 1 + lineOffset);
      } else {
        // Regular variable
        addSymbol(symbols.variables, nameNode.text(), filePath, nameNode.range().start.line + 1 + lineOffset);
      }
    }
  }

  // var declarations
  const varDecls = root.findAll({ rule: { kind: 'variable_declaration' } });
  for (const node of varDecls) {
    const declarators = node.findAll({ rule: { kind: 'variable_declarator' } });
    for (const decl of declarators) {
      const nameNode = decl.field('name');
      const valueNode = decl.field('value');
      if (!nameNode) continue;

      const valueKind = valueNode?.kind();
      if (valueKind === 'arrow_function' || valueKind === 'function_expression') {
        addSymbol(symbols.functions, nameNode.text(), filePath, nameNode.range().start.line + 1 + lineOffset);
      } else {
        addSymbol(symbols.variables, nameNode.text(), filePath, nameNode.range().start.line + 1 + lineOffset);
      }
    }
  }

  // Extract class declarations
  const classDecls = root.findAll({ rule: { kind: 'class_declaration' } });
  for (const node of classDecls) {
    const name = node.field('name');
    if (name) addSymbol(symbols.classes, name.text(), filePath, name.range().start.line + 1 + lineOffset);
  }

  // Extract method definitions inside classes
  const methods = root.findAll({ rule: { kind: 'method_definition' } });
  for (const node of methods) {
    const name = node.field('name');
    if (name && name.text() !== 'constructor') {
      addSymbol(symbols.functions, name.text(), filePath, name.range().start.line + 1 + lineOffset);
    }
  }

  // TypeScript-specific: interfaces, type aliases, enums
  if (isTS) {
    const interfaces = root.findAll({ rule: { kind: 'interface_declaration' } });
    for (const node of interfaces) {
      const name = node.field('name');
      if (name) addSymbol(symbols.classes, name.text(), filePath, name.range().start.line + 1 + lineOffset);
    }

    const typeAliases = root.findAll({ rule: { kind: 'type_alias_declaration' } });
    for (const node of typeAliases) {
      const name = node.field('name');
      if (name) addSymbol(symbols.classes, name.text(), filePath, name.range().start.line + 1 + lineOffset);
    }

    const enums = root.findAll({ rule: { kind: 'enum_declaration' } });
    for (const node of enums) {
      const name = node.field('name');
      if (name) addSymbol(symbols.classes, name.text(), filePath, name.range().start.line + 1 + lineOffset);
    }
  }

  // Extract exports
  const exportStmts = root.findAll({ rule: { kind: 'export_statement' } });
  for (const node of exportStmts) {
    // export function foo / export class Bar / export const baz
    const declaration = node.field('declaration');
    if (declaration) {
      const nameNode = declaration.field('name');
      if (nameNode) {
        addSymbol(symbols.exports, nameNode.text(), filePath, nameNode.range().start.line + 1 + lineOffset);
      } else if (declaration.kind() === 'lexical_declaration' || declaration.kind() === 'variable_declaration') {
        // export const foo = ...
        const declarators = declaration.findAll({ rule: { kind: 'variable_declarator' } });
        for (const decl of declarators) {
          const n = decl.field('name');
          if (n) addSymbol(symbols.exports, n.text(), filePath, n.range().start.line + 1 + lineOffset);
        }
      }
    }

    // export { foo, bar }
    const exportClause = node.findAll({ rule: { kind: 'export_specifier' } });
    for (const spec of exportClause) {
      const nameNode = spec.field('name');
      if (nameNode) addSymbol(symbols.exports, nameNode.text(), filePath, nameNode.range().start.line + 1 + lineOffset);
    }

    // export default
    const value = node.field('value');
    if (value && value.kind() === 'identifier') {
      addSymbol(symbols.exports, value.text(), filePath, value.range().start.line + 1 + lineOffset);
    }
  }

  // CommonJS exports (module.exports.foo = ..., exports.foo = ...)
  // Use regex on source lines since AST structure for these is generic assignment_expression
  const sourceLines = root.text().split('\n');
  for (let i = 0; i < sourceLines.length; i++) {
    const line = sourceLines[i];

    // exports.foo = ... or module.exports.foo = ...
    const memberExport = line.match(/^(?:module\.)?exports\.(\w+)\s*=/);
    if (memberExport) {
      addSymbol(symbols.exports, memberExport[1], filePath, i + 1);
      continue;
    }

    // module.exports = { foo, bar, baz } or module.exports = { foo: ..., bar: ... }
    const bulkExport = line.match(/^module\.exports\s*=\s*\{([^}]+)\}/);
    if (bulkExport) {
      const names = bulkExport[1].split(',').map(s => s.trim().split(/[:\s]/)[0].trim());
      for (const name of names) {
        if (name && /^\w+$/.test(name)) {
          addSymbol(symbols.exports, name, filePath, i + 1);
        }
      }
    }

    // Express API routes: router.get('/path', ...) or app.get('/path', ...)
    const routeMatch = line.match(/(?:router|app)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/);
    if (routeMatch) {
      const method = routeMatch[1].toUpperCase();
      const routePath = routeMatch[2];
      const key = `${method} ${routePath}`;
      if (!symbols.apiRoutes[key]) {
        symbols.apiRoutes[key] = { file: filePath, line: i + 1, method, path: routePath };
      }
      continue;
    }

    // Route mount: app.use('/api/tickets', ticketRoutes)
    const mountMatch = line.match(/app\.use\s*\(\s*['"`]([^'"`]+)['"`]/);
    if (mountMatch && mountMatch[1].startsWith('/api')) {
      const mountPath = mountMatch[1];
      const key = `MOUNT ${mountPath}`;
      if (!symbols.apiRoutes[key]) {
        symbols.apiRoutes[key] = { file: filePath, line: i + 1, method: 'MOUNT', path: mountPath };
      }
    }
  }
}

/**
 * Regex fallback for Python/Go/Rust.
 */
function extractWithRegex(filePath, lines, lang, symbols, lineOffset = 0) {
  switch (lang) {
    case 'javascript':
    case 'typescript':
      extractJsRegex(filePath, lines, symbols, lineOffset);
      break;
    case 'python':
      extractPython(filePath, lines, symbols);
      break;
    case 'go':
      extractGo(filePath, lines, symbols);
      break;
    case 'rust':
      extractRust(filePath, lines, symbols);
      break;
  }
}

function extractJsRegex(filePath, lines, symbols, lineOffset = 0) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1 + lineOffset;

    // function declarations: function foo(...) or async function foo(...)
    const funcDecl = line.match(/(?:async\s+)?function\s+([a-zA-Z_$]\w*)\s*\(/);
    if (funcDecl) {
      addSymbol(symbols.functions, funcDecl[1], filePath, lineNum);
      continue;
    }

    // const/let/var arrow functions: const foo = (...) => or const foo = async (...) =>
    const arrowFunc = line.match(/(?:const|let|var)\s+([a-zA-Z_$]\w*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$]\w*)\s*=>/);
    if (arrowFunc) {
      addSymbol(symbols.functions, arrowFunc[1], filePath, lineNum);
      continue;
    }

    // class declarations: class Foo
    const classDecl = line.match(/class\s+([A-Z]\w*)/);
    if (classDecl) {
      addSymbol(symbols.classes, classDecl[1], filePath, lineNum);
      continue;
    }
  }
}

function extractPython(filePath, lines, symbols) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    const funcDef = line.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
    if (funcDef) { addSymbol(symbols.functions, funcDef[1], filePath, lineNum); continue; }

    const classDef = line.match(/^class\s+(\w+)[\s(:]/);
    if (classDef) { addSymbol(symbols.classes, classDef[1], filePath, lineNum); continue; }

    const methodDef = line.match(/^\s+(?:async\s+)?def\s+(\w+)\s*\(/);
    if (methodDef && !methodDef[1].startsWith('_')) {
      addSymbol(symbols.functions, methodDef[1], filePath, lineNum);
      continue;
    }

    const varAssign = line.match(/^(\w+)\s*(?::\s*\w+\s*)?=/);
    if (varAssign && varAssign[1] === varAssign[1].toUpperCase()) {
      addSymbol(symbols.variables, varAssign[1], filePath, lineNum);
    }
  }
}

function extractGo(filePath, lines, symbols) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    const funcDecl = line.match(/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/);
    if (funcDecl) { addSymbol(symbols.functions, funcDecl[1], filePath, lineNum); continue; }

    const typeDecl = line.match(/^type\s+(\w+)\s+(?:struct|interface)\s*\{/);
    if (typeDecl) { addSymbol(symbols.classes, typeDecl[1], filePath, lineNum); continue; }

    const constDecl = line.match(/^(?:const|var)\s+(\w+)\s/);
    if (constDecl) { addSymbol(symbols.variables, constDecl[1], filePath, lineNum); }
  }
}

function extractRust(filePath, lines, symbols) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    const funcDecl = line.match(/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/);
    if (funcDecl) { addSymbol(symbols.functions, funcDecl[1], filePath, lineNum); continue; }

    const structDecl = line.match(/^(?:pub\s+)?struct\s+(\w+)/);
    if (structDecl) { addSymbol(symbols.classes, structDecl[1], filePath, lineNum); continue; }

    const enumDecl = line.match(/^(?:pub\s+)?enum\s+(\w+)/);
    if (enumDecl) { addSymbol(symbols.classes, enumDecl[1], filePath, lineNum); continue; }

    const traitDecl = line.match(/^(?:pub\s+)?trait\s+(\w+)/);
    if (traitDecl) { addSymbol(symbols.classes, traitDecl[1], filePath, lineNum); continue; }

    const constDecl = line.match(/^(?:pub\s+)?(?:const|static)\s+(\w+)/);
    if (constDecl) { addSymbol(symbols.variables, constDecl[1], filePath, lineNum); }
  }
}

/**
 * Extract HTML page info: title, script dependencies.
 */
function extractHtml(filePath, content, symbols) {
  // Extract <title>
  const titleMatch = content.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : null;

  // Extract <script src="...">
  const scripts = [];
  const scriptRegex = /<script[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = scriptRegex.exec(content)) !== null) {
    const src = match[1];
    // Skip CDN/external scripts and common libs
    if (src.startsWith('http') || src.startsWith('//')) continue;
    scripts.push(src);
  }

  // Extract function definitions from inline <script> blocks
  // This catches functions defined in HTML monoliths (e.g. admin_tickets.html)
  const inlineScriptRegex = /<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/gi;
  let inlineMatch;
  while ((inlineMatch = inlineScriptRegex.exec(content)) !== null) {
    const scriptContent = inlineMatch[1];
    if (!scriptContent.trim()) continue;
    // Calculate line offset of this script block within the HTML file
    const blockStart = content.substring(0, inlineMatch.index).split('\n').length;
    try {
      extractWithAst(filePath, scriptContent, Lang.JavaScript, symbols, blockStart);
    } catch {
      // AST parse failed (maybe template syntax) — try regex fallback
      const lines = scriptContent.split('\n');
      extractWithRegex(filePath, lines, 'javascript', symbols, blockStart);
    }
  }

  const name = path.basename(filePath);
  symbols.htmlPages[name] = {
    file: filePath,
    title: title || name,
    scripts
  };
}

function addSymbol(category, name, filePath, line) {
  if (!category[name]) {
    category[name] = { file: filePath, line, usages: 1 };
  } else {
    category[name].usages++;
  }
}

/**
 * Generate a compact project overview for context injection.
 */
export function generateOverview(projectRoot, scanResult) {
  const { files, symbols } = scanResult;
  const lines = ['# Project Overview\n'];

  // File tree (compact — group by directory)
  const dirs = {};
  for (const f of files) {
    const dir = path.dirname(f.path);
    if (!dirs[dir]) dirs[dir] = [];
    dirs[dir].push(f);
  }

  lines.push(`## Files (${files.length})`);
  const totalLines = files.reduce((sum, f) => sum + f.lines, 0);
  lines.push(`Total: ${totalLines.toLocaleString()} lines\n`);

  for (const [dir, dirFiles] of Object.entries(dirs).sort()) {
    const fileList = dirFiles.map(f => {
      const name = path.basename(f.path);
      return `${name} (${f.lines}L)`;
    }).join(', ');
    lines.push(`- **${dir || '.'}**/: ${fileList}`);
  }
  lines.push('');

  const funcCount = Object.keys(symbols.functions).length;
  const classCount = Object.keys(symbols.classes).length;
  const exportCount = Object.keys(symbols.exports).length;

  lines.push(`## Symbols`);
  lines.push(`Functions: ${funcCount}, Classes/Types: ${classCount}, Exports: ${exportCount}\n`);

  if (classCount > 0 && classCount <= 50) {
    lines.push(`### Classes/Types`);
    for (const [name, info] of Object.entries(symbols.classes).sort()) {
      lines.push(`- **${name}** — ${info.file}:${info.line}`);
    }
    lines.push('');
  }

  if (exportCount > 0 && exportCount <= 80) {
    lines.push(`### Exports`);
    for (const [name, info] of Object.entries(symbols.exports).sort()) {
      lines.push(`- ${name} — ${info.file}:${info.line}`);
    }
    lines.push('');
  }

  // API Routes (compact: group by file, show methods only)
  const routeEntries = Object.entries(symbols.apiRoutes || {});
  if (routeEntries.length > 0) {
    const mounts = routeEntries.filter(([, v]) => v.method === 'MOUNT');
    const routes = routeEntries.filter(([, v]) => v.method !== 'MOUNT');

    lines.push(`## API Routes (${routes.length} endpoints)\n`);

    // Group routes by file, show file + methods + count
    const routesByFile = {};
    for (const [, info] of routes) {
      if (!routesByFile[info.file]) routesByFile[info.file] = [];
      routesByFile[info.file].push(info);
    }

    for (const [file, fileRoutes] of Object.entries(routesByFile).sort()) {
      const methods = [...new Set(fileRoutes.map(r => r.method))].sort().join(', ');
      const mountInfo = mounts.find(([, v]) => {
        // Try to match mount path to this route file
        const fileBase = path.basename(file, '.js').replace(/[-_]/g, '');
        return v.path.replace(/[/-]/g, '').includes(fileBase);
      });
      const mountPath = mountInfo ? mountInfo[1].path : '';
      lines.push(`- **${file}** — ${methods} (${fileRoutes.length})${mountPath ? ` → ${mountPath}` : ''}`);
    }
    lines.push('');
  }

  // HTML Pages (compact: name + title, scripts available via get_wisdom)
  const pageEntries = Object.entries(symbols.htmlPages || {});
  if (pageEntries.length > 0) {
    lines.push(`## HTML Pages (${pageEntries.length})\n`);
    for (const [name, info] of pageEntries.sort()) {
      const scriptCount = info.scripts.length > 0 ? ` (${info.scripts.length} scripts)` : '';
      lines.push(`- **${name}**: ${info.title}${scriptCount}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check symbols against registry. Returns { known, fuzzy, unknown }.
 */
export function checkSymbols(symbolNames, registry) {
  const known = [];
  const fuzzy = [];
  const unknown = [];

  const allNames = new Set();
  for (const category of Object.values(registry)) {
    for (const name of Object.keys(category)) {
      allNames.add(name);
    }
  }

  for (const name of symbolNames) {
    if (allNames.has(name)) {
      for (const [catName, cat] of Object.entries(registry)) {
        if (cat[name]) {
          known.push({ name, category: catName, ...cat[name] });
          break;
        }
      }
    } else {
      const match = findFuzzyMatch(name, allNames);
      if (match) {
        for (const [catName, cat] of Object.entries(registry)) {
          if (cat[match.name]) {
            fuzzy.push({
              queried: name,
              suggestion: match.name,
              distance: match.distance,
              category: catName,
              ...cat[match.name]
            });
            break;
          }
        }
      } else {
        unknown.push({ name });
      }
    }
  }

  return { known, fuzzy, unknown };
}

function findFuzzyMatch(query, names) {
  let bestMatch = null;
  let bestDistance = Infinity;
  const maxDistance = Math.max(2, Math.floor(query.length * 0.3));

  for (const name of names) {
    if (Math.abs(name.length - query.length) > maxDistance) continue;
    const dist = levenshtein(query.toLowerCase(), name.toLowerCase());
    if (dist <= maxDistance && dist < bestDistance) {
      bestDistance = dist;
      bestMatch = name;
    }
  }

  return bestMatch ? { name: bestMatch, distance: bestDistance } : null;
}

function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b[i - 1] === a[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

export function readSymbols(wisdomDir) {
  const symbolsPath = path.join(wisdomDir, 'symbols.json');
  if (!fs.existsSync(symbolsPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(symbolsPath, 'utf8'));
  } catch {
    return null;
  }
}

export function writeSymbols(wisdomDir, symbols) {
  const symbolsPath = path.join(wisdomDir, 'symbols.json');
  fs.writeFileSync(symbolsPath, JSON.stringify(symbols, null, 2) + '\n');
}
