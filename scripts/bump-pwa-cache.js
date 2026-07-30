#!/usr/bin/env node
/**
 * Bump GridIron24 PWA cache-bust tokens (icons, manifest, shell CSS/JS, SW cache).
 * Usage:
 *   node scripts/bump-pwa-cache.js          # increment
 *   node scripts/bump-pwa-cache.js --check  # exit 0 if bump needed for staged changes
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VERSION_FILE = path.join(ROOT, 'public/app/pwa-bust.json');
const INDEX = path.join(ROOT, 'public/app/index.html');
const MANIFEST = path.join(ROOT, 'public/manifest.webmanifest');
const SW = path.join(ROOT, 'public/sw.js');

const TRIGGER_RE =
  /^(public\/app\/(?!pwa-bust\.json).+|public\/assets\/pwa\/.+|public\/manifest\.webmanifest|public\/sw\.js)$/;

function readVersion() {
  try {
    const raw = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
    const n = Number(raw.v);
    return Number.isFinite(n) && n > 0 ? n : 1;
  } catch {
    return 1;
  }
}

function writeVersion(v) {
  fs.writeFileSync(VERSION_FILE, `${JSON.stringify({ v }, null, 2)}\n`);
}

function rewrite(file, fn) {
  const before = fs.readFileSync(file, 'utf8');
  const after = fn(before);
  if (after !== before) fs.writeFileSync(file, after);
  return after !== before;
}

function applyVersion(v) {
  writeVersion(v);

  rewrite(INDEX, (html) => html
    .replace(/(\/manifest\.webmanifest\?v=)\d+/g, `$1${v}`)
    .replace(/(\/assets\/pwa\/[^"'?\s]+\?v=)\d+/g, `$1${v}`)
    .replace(/(\/app\/app\.css\?v=)\d+/g, `$1${v}`)
    .replace(/(\/app\/app\.js\?v=)\d+/g, `$1${v}`));

  rewrite(MANIFEST, (json) => json.replace(/(\/assets\/pwa\/[^"?]+\?v=)\d+/g, `$1${v}`));

  rewrite(SW, (js) => js
    .replace(/const CACHE = 'gi24-app-v\d+';/, `const CACHE = 'gi24-app-v${v}';`)
    .replace(/(\/app\/app\.css\?v=)\d+/g, `$1${v}`)
    .replace(/(\/app\/app\.js\?v=)\d+/g, `$1${v}`)
    .replace(/(\/manifest\.webmanifest\?v=)\d+/g, `$1${v}`)
    .replace(/(\/assets\/pwa\/[^'?]+\?v=)\d+/g, `$1${v}`));

  return v;
}

function stagedFiles() {
  try {
    const out = execSync('git diff --cached --name-only --diff-filter=ACMR', {
      cwd: ROOT,
      encoding: 'utf8'
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function needsBump(files = stagedFiles()) {
  return files.some((f) => TRIGGER_RE.test(f));
}

function stageBumpedFiles() {
  execSync(
    'git add -- public/app/pwa-bust.json public/app/index.html public/manifest.webmanifest public/sw.js',
    { cwd: ROOT, stdio: 'inherit' }
  );
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--check')) {
    process.exit(needsBump() ? 0 : 1);
  }

  if (args.has('--if-staged') && !needsBump()) {
    console.log('PWA cache bump skipped (no app/icon/manifest changes staged).');
    return;
  }

  const next = readVersion() + 1;
  applyVersion(next);
  if (args.has('--if-staged') || args.has('--stage')) {
    stageBumpedFiles();
  }
  console.log(`PWA cache bust → v${next} (icons, manifest, shell, service worker)`);
}

if (require.main === module) {
  main();
}

module.exports = { needsBump, readVersion, applyVersion };