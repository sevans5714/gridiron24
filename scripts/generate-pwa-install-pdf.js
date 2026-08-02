/**
 * Generate public/docs/gridiron24-app-install.pdf from pwa-install-guide.js
 * Run: npm run docs:pwa-pdf
 *
 * Renders via Python/Pillow (system fonts + navy-matted crest) for clean print output.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'docs');
const OUT_FILE = path.join(OUT_DIR, 'gridiron24-app-install.pdf');
const PY_SCRIPT = path.join(__dirname, 'render_pwa_install_pdf.py');

function main() {
  if (!fs.existsSync(PY_SCRIPT)) throw new Error(`Missing ${PY_SCRIPT}`);
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const result = spawnSync('python3', [PY_SCRIPT, OUT_FILE], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0 || !fs.existsSync(OUT_FILE)) {
    throw new Error(`PDF render failed (status ${result.status})`);
  }
  console.log(`Wrote ${path.relative(process.cwd(), OUT_FILE)} (${fs.statSync(OUT_FILE).size} bytes)`);
}

main();
