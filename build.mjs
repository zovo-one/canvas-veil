// build.mjs — canvas-veil (#107) production bundler. Fleet-standard esbuild
// pipeline (Pinterest #106 pattern), adapted to this build's dist contract
// (TECHNICAL-BRIEF §5 + Phase 1.5): popup.html / options.html /
// onboarding.html / sw.js at dist ROOT; only content scripts nest under
// dist/content/.
//
// Pipeline (TECHNICAL-BRIEF §9): tsc --noEmit && vitest run first (npm
// "build" script) -> esbuild bundles 5 TS entries (iife, chrome111 = the
// manifest's minimum_chrome_version) -> static copy preserving manifest
// paths -> i18n-bootstrap injection (only if a dist HTML still carries a
// literal __MSG_ token; data-i18n pages never trigger it) -> locale
// validation -> gate-6 dist scans -> dist file log.
//
// onboarding.js is deliberately NOT bundled: gate G14 greps the built JS for
// the premium template's tabs.getCurrent/tabs.remove close logic, so it
// ships byte-identical (ScamRows lesson).
//
// dist/ is emptied before every build. `node build.mjs --watch` rebuilds on
// change (dev). Zero runtime deps.

import { build, context } from 'esbuild';
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');
const WATCH = process.argv.includes('--watch');
const MINIFY = true; // TECHNICAL-BRIEF §9 pin ("esbuild bundles … minified")

// ---------------------------------------------------------------- clean
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// ------------------------------------------------------------- TS entries
// Object-form entryPoints: output path (relative to outdir, no extension) to
// source file — produces the manifest's exact dist contract.
/** @type {import('esbuild').BuildOptions} */
const OPTIONS = {
  entryPoints: {
    sw: 'src/sw.ts', //                          → dist/sw.js
    'content/main-world': 'src/content/main-world.ts', // → dist/content/main-world.js
    'content/isolated': 'src/content/isolated.ts', //     → dist/content/isolated.js
    popup: 'src/popup/popup.ts', //              → dist/popup.js (popup.html sibling)
    options: 'src/options/options.ts', //        → dist/options.js (options.html sibling)
  },
  bundle: true,
  format: 'iife', // zero-import safety everywhere (ScamRows-proven)
  target: 'chrome111', // matches minimum_chrome_version (MAIN-world scripts)
  outdir: DIST,
  sourcemap: false,
  minify: MINIFY,
  logLevel: 'info',
};

// ------------------------------------------------------------ static copy
/** Copies the whitelisted file types of one source dir into one dist dir. */
function copyDirFlat(srcDir, distDir, exts) {
  if (!existsSync(srcDir)) return;
  mkdirSync(distDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    const p = join(srcDir, name);
    if (!statSync(p).isFile()) continue;
    if (!exts.some((e) => p.endsWith(e))) continue;
    copyFileSync(p, join(distDir, name));
  }
}

function copyStatic() {
  cpSync(join(SRC, 'manifest.json'), join(DIST, 'manifest.json'));
  cpSync(join(ROOT, '_locales'), join(DIST, '_locales'), { recursive: true });
  if (existsSync(join(ROOT, 'icons'))) {
    cpSync(join(ROOT, 'icons'), join(DIST, 'icons'), { recursive: true });
  } else {
    console.warn('[build] WARNING: icons/ missing — run `npm run icons` (ops finalizes)');
  }

  // HTML/CSS/JS land at dist ROOT beside their bundles (manifest paths).
  copyDirFlat(join(SRC, 'popup'), DIST, ['.html', '.css']);
  copyDirFlat(join(SRC, 'options'), DIST, ['.html', '.css', '.js']); // .js = zovo-sidebar.js (ships verbatim)
  copyDirFlat(join(SRC, 'onboarding'), DIST, ['.html', '.css', '.js']); // onboarding.js verbatim (G14)
  copyDirFlat(join(SRC, 'content'), join(DIST, 'content'), ['.css']);
  copyDirFlat(join(SRC, 'styles'), join(DIST, 'styles'), ['.css']); // shared zovo-base tokens
}

// ------------------------------------------------------- i18n-bootstrap
// Chrome 150 stopped substituting __MSG_*__ tokens in extension HTML. Any
// dist HTML still containing a literal token gets the canonical bootstrap
// (tools/i18n-bootstrap.js, TrustGrade-verbatim) copied beside it and a
// synchronous <script> tag injected before its first bundle script. Pages
// using data-i18n attributes (ours) never trigger this.
function injectI18nBootstrap() {
  const BOOTSTRAP = join(ROOT, 'tools', 'i18n-bootstrap.js');
  /** @param {string} dir */
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!p.endsWith('.html')) continue;
      const html = readFileSync(p, 'utf8');
      if (!html.includes('__MSG_')) continue;
      if (html.includes('i18n-bootstrap.js')) continue; // already linked
      copyFileSync(BOOTSTRAP, join(dir, 'i18n-bootstrap.js'));
      const tag = '<script src="i18n-bootstrap.js"></script>';
      const scriptAt = html.indexOf('<script');
      let out;
      if (scriptAt !== -1) {
        out = html.slice(0, scriptAt) + tag + '\n' + html.slice(scriptAt);
      } else if (html.includes('</body>')) {
        out = html.replace('</body>', tag + '\n</body>');
      } else {
        throw new Error(`[build] __MSG_ found but no injection point: ${p}`);
      }
      writeFileSync(p, out);
      console.log(`[build] i18n-bootstrap injected: ${p}`);
    }
  }
  walk(DIST);
}

// --------------------------------------------------------------- file log
/** @param {string} dir @param {string} [prefix] @returns {string[]} */
function walkFiles(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkFiles(p, `${prefix}${name}/`));
    else out.push(`${prefix}${name}`);
  }
  return out;
}

// ------------------------------------------------------ locale validation
// Manifest __MSG_ keys exist; every data-i18n* key used in HTML exists;
// positional $1..$9 placeholders ONLY (named $tabs$-style FAIL fleet-wide);
// '$$' is the literal-$ escape; extName <=75, extDesc <=132.
function validateLocales() {
  const fail = (m) => {
    throw new Error(`[build] locale validation: ${m}`);
  };
  const messagesPath = join(DIST, '_locales', 'en', 'messages.json');
  const messages = JSON.parse(readFileSync(messagesPath, 'utf8'));
  const keys = new Set(Object.keys(messages));

  const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
  for (const field of ['name', 'description']) {
    const v = manifest[field];
    const m = typeof v === 'string' && v.match(/^__MSG_(\w+)__$/);
    if (m && !keys.has(m[1])) fail(`manifest ${field} references missing key ${m[1]}`);
  }
  const actionTitle = manifest.action?.default_title;
  const at = typeof actionTitle === 'string' && actionTitle.match(/^__MSG_(\w+)__$/);
  if (at && !keys.has(at[1])) fail(`manifest action.default_title missing key ${at[1]}`);

  if ((messages.extName?.message ?? '').length > 75) fail('extName >75 chars');
  if ((messages.extDesc?.message ?? '').length > 132) fail('extDesc >132 chars');

  for (const [k, v] of Object.entries(messages)) {
    const stripped = String(v.message).replace(/\$\$/g, '');
    if (/\$[A-Za-z][A-Za-z0-9_]*\$/.test(stripped)) {
      fail(`named placeholder in "${k}" — positional $1 only (fleet rule)`);
    }
  }

  const attrRe = /data-i18n(?:-aria|-title|-placeholder)?="([^"]+)"/g;
  for (const f of walkFiles(DIST)) {
    if (!f.endsWith('.html')) continue;
    const html = readFileSync(join(DIST, f), 'utf8');
    for (const m of html.matchAll(attrRe)) {
      if (!keys.has(m[1])) fail(`${f} uses missing data-i18n key "${m[1]}"`);
    }
  }
  console.log('[build] locale validation OK');
}

// ------------------------------------------------------------ dist scans
// TECHNICAL-BRIEF Phase 8 gate 6 — hard fails.
function scanDist() {
  const fail = (m) => {
    throw new Error(`[build] dist scan: ${m}`);
  };
  for (const f of walkFiles(DIST)) {
    const text = readFileSync(join(DIST, f), 'utf8');
    if (f.endsWith('.js')) {
      if (/console\.log\s*\(/.test(text)) fail(`console.log in ${f}`);
      if (/(^|[^\w.])eval\s*\(/.test(text)) fail(`eval( in ${f}`);
      if (/new\s+Function\s*\(/.test(text)) fail(`new Function in ${f}`);
    }
    if (f.endsWith('.html')) {
      if (text.includes('__MSG_')) fail(`__MSG_ token survived in ${f} (data-i18n only)`);
      if (text.includes('<!--')) fail(`HTML comment in ${f} (scanners read comments)`);
      if (text.includes('href="#review"')) fail(`href="#review" in ${f} (A-solicit violation)`);
      if (/more from zovo/i.test(text)) fail(`cross-sell string in ${f}`);
      if (/\{\{[^}]+\}\}/.test(text)) fail(`{{placeholder}} left in ${f} (SHIELD: stamp before zip)`);
    }
    if (f.endsWith('.css') || f.endsWith('.js')) {
      if (/\{\{[^}]+\}\}/.test(text)) fail(`{{placeholder}} left in ${f} (SHIELD: stamp before zip)`);
    }
  }
  for (const page of ['popup.html', 'options.html']) {
    const html = readFileSync(join(DIST, page), 'utf8');
    if (!html.includes('zovo.one')) fail(`${page} missing visible zovo.one footer text`);
  }
  console.log('[build] dist scans OK (gate 6)');
}

function logDist() {
  const files = walkFiles(DIST);
  for (const f of files) console.log(`[dist] ${f}`);
  console.log(`[build] dist/ ready: ${files.length} files (iife, chrome111, minify=${MINIFY}).`);
}

// ------------------------------------------------------------------ run
if (WATCH) {
  const ctx = await context(OPTIONS);
  await ctx.watch();
  copyStatic();
  injectI18nBootstrap();
  validateLocales();
  scanDist();
  logDist();
  console.log('[build] watching for changes…');
} else {
  await build(OPTIONS);
  copyStatic();
  injectI18nBootstrap();
  validateLocales();
  scanDist();
  logDist();
  // esbuild's long-lived service child keeps the node event loop alive after
  // the work is done — exit explicitly (one-shot build only, never watch).
  process.exit(0);
}
