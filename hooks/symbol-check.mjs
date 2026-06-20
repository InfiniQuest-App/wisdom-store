/**
 * Symbol checker - called by post-write-symbol-check.sh hook
 * Usage: node symbol-check.mjs <file_path> <symbols_json_path> [--diff-only]
 *
 * When --diff-only is set, reads the changed content from stdin and only
 * checks symbols that appear in that diff. This prevents false positives
 * from pre-existing code in the file.
 *
 * Checks local imports AND standalone function calls against the
 * project's .wisdom/symbols.json registry.
 */
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const filePath = args[0];
const symbolsFile = args[1];
const diffOnly = args.includes('--diff-only');

if (!filePath || !symbolsFile) process.exit(0);

// Read the written file (always needed for context like local definitions)
let content;
try {
  content = fs.readFileSync(filePath, 'utf8');
} catch { process.exit(0); }

// Read diff content from stdin if in diff-only mode
let diffContent = '';
if (diffOnly) {
  try {
    diffContent = fs.readFileSync(0, 'utf8'); // fd 0 = stdin
  } catch { process.exit(0); }
  if (!diffContent.trim()) process.exit(0);
}

// The content to scan for symbols — either the diff or the full file
const scanContent = diffOnly ? diffContent : content;

// Read symbol registry
let registry;
try {
  registry = JSON.parse(fs.readFileSync(symbolsFile, 'utf8'));
} catch { process.exit(0); }

// Build set of all known symbols
const known = new Set();
for (const [cat, symbols] of Object.entries(registry)) {
  if (cat === '_meta') continue;
  for (const name of Object.keys(symbols)) {
    known.add(name);
  }
}

if (known.size === 0) process.exit(0);

// Strip comments and strings to avoid false positives from prose
function stripCommentsAndStrings(code) {
  return code
    // Block comments
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Line comments
    .replace(/\/\/.*$/gm, '')
    // Template literals (rough — handles most cases)
    .replace(/`(?:[^`\\]|\\.)*`/g, '""')
    // Double-quoted strings
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    // Single-quoted strings
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

const referenced = new Set();

// --- Imports (checked against scanContent) ---

// ES imports from local paths only: import { foo, bar } from './...'
for (const match of scanContent.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
  for (const name of match[1].split(',')) {
    const trimmed = name.trim().split(/\s+as\s+/)[0].trim();
    if (trimmed && /^[a-zA-Z_]\w*$/.test(trimmed)) {
      referenced.add(trimmed);
    }
  }
}

// Default imports from local paths: import Foo from './...'
for (const match of scanContent.matchAll(/import\s+([A-Z]\w+)\s+from\s*['"](\.[^'"]+)['"]/g)) {
  referenced.add(match[1]);
}

// CommonJS require from local paths: const { foo } = require('./...')
for (const match of scanContent.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
  for (const name of match[1].split(',')) {
    const trimmed = name.trim().split(/\s*:\s*/)[0].trim();
    if (trimmed && /^[a-zA-Z_]\w*$/.test(trimmed)) {
      referenced.add(trimmed);
    }
  }
}

// --- Import path validation (only for paths in scanContent) ---

const fileDir = path.dirname(filePath);
const badPaths = [];

const localPaths = new Set();
for (const match of scanContent.matchAll(/(?:import|export)\s+.*?from\s*['"](\.[^'"]+)['"]/g)) {
  localPaths.add(match[1]);
}
for (const match of scanContent.matchAll(/require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
  localPaths.add(match[1]);
}

for (const importPath of localPaths) {
  const resolved = path.resolve(fileDir, importPath);
  const candidates = [resolved];
  if (!path.extname(resolved)) {
    candidates.push(resolved + '.js', resolved + '.mjs', resolved + '.ts', resolved + '.tsx',
                     resolved + '.jsx', resolved + '.cjs',
                     resolved + '/index.js', resolved + '/index.ts');
  }
  if (!candidates.some(c => fs.existsSync(c))) {
    badPaths.push(importPath);
  }
}

// --- Function calls (checked against stripped scanContent) ---

const stripped = stripCommentsAndStrings(scanContent);

// Standalone function calls (not method calls)
const SKIP = new Set([
  // Language keywords
  'if','for','while','switch','catch','require','import','return','throw',
  'function','async','class','const','let','var','try','else','new',
  'typeof','instanceof','delete','void','yield','await','of','in','from',
  // JS globals and builtins
  'console','Math','JSON','Object','Array','String','Number','Boolean',
  'Date','RegExp','Error','Promise','Set','Map','WeakMap','WeakSet',
  'Symbol','Proxy','Reflect','BigInt','Intl','ArrayBuffer','DataView',
  'Float32Array','Float64Array','Int8Array','Int16Array','Int32Array',
  'Uint8Array','Uint16Array','Uint32Array',
  'setTimeout','setInterval','clearTimeout','clearInterval',
  'requestAnimationFrame','cancelAnimationFrame',
  'parseInt','parseFloat','isNaN','isFinite','isInteger',
  'encodeURIComponent','decodeURIComponent','encodeURI','decodeURI',
  'atob','btoa',
  // Node.js globals
  'Buffer','process','module','exports','global','globalThis',
  'require','__dirname','__filename',
  // Common values
  'null','undefined','true','false','NaN','Infinity',
  'this','super','arguments',
  // Fetch/network
  'fetch','XMLHttpRequest','WebSocket','EventSource','Headers','Request','Response',
  'URL','URLSearchParams','FormData','AbortController',
  // Testing
  'describe','it','test','expect','beforeEach','afterEach','beforeAll','afterAll',
  'jest','vi','assert','should',
  // Console/logging
  'log','warn','info','error','debug','trace','dir','table','time','timeEnd',
  'alert','confirm','prompt',
  // Promise/async
  'resolve','reject','then','catch','finally',
  // Function methods
  'bind','call','apply',
  // Object methods
  'constructor','assign','keys','values','entries','freeze','seal','create','define',
  'is','from','parse','stringify','toString','valueOf','hasOwnProperty',
  'getPrototypeOf','setPrototypeOf','defineProperty','getOwnPropertyNames',
  // Array methods
  'includes','indexOf','lastIndexOf','push','pop','shift','unshift',
  'slice','splice','join','split','trim','trimStart','trimEnd',
  'replace','replaceAll','match','matchAll','search','test',
  'filter','map','reduce','reduceRight','forEach','find','findIndex','findLast',
  'some','every','sort','reverse','concat','flat','flatMap','fill',
  'copyWithin','at','with','toSorted','toReversed','toSpliced',
  // Collection methods
  'has','get','set','add','clear','delete','next','done','value',
  // DOM/Browser
  'querySelector','querySelectorAll','getElementById','getElementsByClassName',
  'createElement','createTextNode','appendChild','removeChild','insertBefore',
  'addEventListener','removeEventListener','dispatchEvent',
  'getAttribute','setAttribute','removeAttribute','classList',
  'preventDefault','stopPropagation',
  'getComputedStyle','getBoundingClientRect',
  // Node.js fs
  'readFileSync','writeFileSync','existsSync','mkdirSync','readdirSync',
  'readFile','writeFile','mkdir','readdir','stat','access','unlink',
  'statSync','unlinkSync','renameSync','copyFileSync',
  // Node.js path
  'resolve','join','dirname','basename','extname','relative','normalize','parse',
  // Node.js events
  'emit','on','once','off','removeListener','removeAllListeners',
  // Node.js crypto
  'randomUUID','createHash','createHmac','randomBytes',
  // Node.js child_process
  'exec','execSync','spawn','fork',
  // Node.js util
  'promisify','inspect','format','inherits',
  // CSS functions (appear in template literals)
  'rgba','rgb','hsl','hsla','calc','var','url','linear','radial',
  'translateX','translateY','rotate','scale','skew',
]);

for (const match of stripped.matchAll(/(?<![.\w])([a-zA-Z_]\w*)\s*\(/g)) {
  const name = match[1];
  if (SKIP.has(name)) continue;
  if (name.length <= 2) continue;
  // Skip constructor calls (new Foo()) — typically from dependencies
  if (/^[A-Z]/.test(name)) continue;
  referenced.add(name);
}

// Check which referenced symbols are unknown
const unknowns = [];
for (const name of referenced) {
  if (name.length <= 2) continue;
  if (/^[A-Z_]+$/.test(name)) continue; // CONSTANTS

  // Is it a local definition in this file? (check full file, not just diff)
  const localDef = new RegExp(`(?:function|const|let|var|class)\\s+${name}\\b`);
  if (localDef.test(content)) continue;

  // Is it a function parameter? (check full file)
  const paramInFunc = new RegExp(`(?:function\\s+\\w*|=>)\\s*\\([^)]*\\b${name}\\b[^)]*\\)`);
  const strippedFull = stripCommentsAndStrings(content);
  if (paramInFunc.test(strippedFull)) continue;

  // Check: not in registry AND looks like a project symbol
  if (!known.has(name)) {
    if (/^[a-z][a-zA-Z0-9]+$/.test(name) || /^[A-Z][a-z][a-zA-Z0-9]+$/.test(name)) {
      unknowns.push(name);
    }
  }
}

// --- API route validation (only routes in scanContent) ---

const badRoutes = [];
const apiRoutes = registry.apiRoutes || {};
if (Object.keys(apiRoutes).length > 0) {
  const knownPaths = new Set();
  const knownNormalized = new Set();
  const mounts = new Set();
  const mountsWithSubRoutes = new Set();

  for (const [key, info] of Object.entries(apiRoutes)) {
    const routePath = info.path || key.split(' ').slice(1).join(' ');
    if (info.method === 'MOUNT') {
      mounts.add(routePath);
    } else {
      knownPaths.add(routePath);
      const normalized = routePath.replace(/\/:[a-zA-Z_]\w*/g, '/*');
      knownNormalized.add(normalized);
    }
  }

  for (const mount of mounts) {
    for (const kp of knownPaths) {
      if (kp.startsWith(mount + '/') || kp === mount) {
        mountsWithSubRoutes.add(mount);
        break;
      }
    }
  }

  for (const match of scanContent.matchAll(/['"`](\/api\/[a-zA-Z0-9/_-]+)['"`]/g)) {
    const apiPath = match[1].replace(/\/$/, '');

    if (knownPaths.has(apiPath)) continue;

    const segments = apiPath.split('/');
    const wildcarded = segments.map(s => /^\d+$/.test(s) ? '*' : s).join('/');
    if (knownNormalized.has(wildcarded)) continue;

    let prefixMatch = false;
    for (const kp of knownPaths) {
      if (kp.startsWith(apiPath + '/')) { prefixMatch = true; break; }
    }
    if (prefixMatch) continue;

    let underOpaqueMount = false;
    for (const mount of mounts) {
      if (!mountsWithSubRoutes.has(mount) && (apiPath.startsWith(mount + '/') || apiPath === mount)) {
        underOpaqueMount = true;
        break;
      }
    }
    if (underOpaqueMount) continue;

    badRoutes.push(match[1]);
  }
}

const fileName = filePath.split('/').pop();
const warnings = [];
const mode = diffOnly ? ' (in new code)' : '';

if (badRoutes.length > 0) {
  warnings.push(`API route check: ${badRoutes.length} route(s) not found in project index for ${fileName}${mode}:`);
  for (const r of badRoutes.slice(0, 10)) {
    warnings.push(`  - ${r}`);
  }
  if (badRoutes.length > 10) warnings.push(`  ... and ${badRoutes.length - 10} more`);
}

if (badPaths.length > 0) {
  warnings.push(`Import path check: ${badPaths.length} import(s) point to files that don't exist in ${fileName}${mode}:`);
  for (const p of badPaths) {
    warnings.push(`  - ${p}`);
  }
}

if (unknowns.length > 0) {
  warnings.push(`Symbol check: ${unknowns.length} symbol(s) not found in project registry for ${fileName}${mode}:`);
  for (const name of unknowns.slice(0, 10)) {
    warnings.push(`  - ${name} (could be hallucinated, new, or from a dependency)`);
  }
  if (unknowns.length > 10) warnings.push(`  ... and ${unknowns.length - 10} more`);
  warnings.push(`Run refresh_symbols to update the registry if these are intentional.`);
}

if (warnings.length > 0) {
  warnings.push(`If this warning is a false positive or unhelpful, use save_wisdom to log the issue (e.g. save_wisdom({ content: "symbol-check flagged X as unknown but it's a builtin/dependency — consider adding to SKIP list", section: "tool-feedback" })).`);
  // Exit code 2 + stderr = feedback shown directly to Claude
  console.error(warnings.join('\n'));
  process.exit(2);
}
