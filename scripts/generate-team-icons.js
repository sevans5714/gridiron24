#!/usr/bin/env node
/**
 * GridIron team logo pack — downloaded American football freeware icons only.
 * Sources listed in vendor/american-football-icons/README.md
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'public', 'assets', 'team-icons');
const CATALOG = path.join(__dirname, '..', 'public', 'js', 'team-icons.js');
const SRC_DIR = path.join(__dirname, '..', 'vendor', 'american-football-icons', 'src');

const COLORS = [
  { id: 'white', name: 'White', bg: '#141414', fg: '#f2f2f2' },
  { id: 'silver', name: 'Silver', bg: '#141414', fg: '#c5cad1' },
  { id: 'black', name: 'Black', bg: '#1c1c1c', fg: '#4a4a4a' },
  { id: 'gold', name: 'Gold', bg: '#1a1408', fg: '#e8c547' },
  { id: 'navy', name: 'Navy', bg: '#070d18', fg: '#3b6ec8' },
  { id: 'blue', name: 'Blue', bg: '#0a1628', fg: '#2f6fed' },
  { id: 'sky', name: 'Sky', bg: '#0a1620', fg: '#5eb3e8' },
  { id: 'teal', name: 'Teal', bg: '#061414', fg: '#1cb5ae' },
  { id: 'green', name: 'Green', bg: '#07140c', fg: '#22a85a' },
  { id: 'lime', name: 'Lime', bg: '#0c1408', fg: '#8fd94a' },
  { id: 'yellow', name: 'Yellow', bg: '#161208', fg: '#f5d031' },
  { id: 'orange', name: 'Orange', bg: '#1a0d04', fg: '#f07316' },
  { id: 'red', name: 'Red', bg: '#1a0506', fg: '#e2232a' },
  { id: 'crimson', name: 'Crimson', bg: '#160508', fg: '#a61e32' },
  { id: 'maroon', name: 'Maroon', bg: '#14080c', fg: '#7a2434' },
  { id: 'purple', name: 'Purple', bg: '#12081a', fg: '#6b3fd4' }
];

// Multicolor emoji / illustrated SVGs — use as-is (one tile each).
const COLORFUL_PREFIXES = [
  'fluent-emoji-flat-',
  'twemoji-',
  'openmoji-',
  'noto-'
];

function classify(file) {
  const f = file.toLowerCase();
  if (f.includes('helmet')) return { category: 'Helmets', label: 'Helmet' };
  if (f.includes('player')) return { category: 'Players', label: 'Player' };
  if (f.includes('shirt') || f.includes('jersey')) return { category: 'Jerseys', label: 'Jersey' };
  if (f.includes('whistle')) return { category: 'Gear', label: 'Whistle' };
  if (f.includes('trophy')) return { category: 'Gear', label: 'Trophy' };
  if (f.includes('medal')) return { category: 'Gear', label: 'Medal' };
  if (f.includes('football') || f.includes('ball')) return { category: 'Footballs', label: 'Football' };
  return { category: 'Marks', label: 'Mark' };
}

function sourceLabel(file) {
  if (file.startsWith('game-icons-')) return 'Game Icons';
  if (file.startsWith('ph-')) return 'Phosphor';
  if (file.startsWith('mdi-')) return 'MDI';
  if (file.startsWith('tabler-')) return 'Tabler';
  if (file.startsWith('ion-')) return 'Ionicons';
  if (file.startsWith('mingcute-')) return 'MingCute';
  if (file.startsWith('fluent-emoji-flat-')) return 'Fluent Emoji';
  if (file.startsWith('twemoji-')) return 'Twemoji';
  if (file.startsWith('openmoji-')) return 'OpenMoji';
  if (file.startsWith('noto-')) return 'Noto';
  if (file.startsWith('svgrepo-')) return 'SVG Repo';
  return 'Icon';
}

function isColorful(file) {
  return COLORFUL_PREFIXES.some((p) => file.startsWith(p));
}

function extractSvg(raw) {
  let body = String(raw)
    .replace(/<\?xml[^>]*>/i, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  const viewBoxMatch = body.match(/viewBox="([^"]+)"/i);
  const viewBox = viewBoxMatch ? viewBoxMatch[1] : '0 0 256 256';
  const inner = body
    .replace(/^<svg[^>]*>/i, '')
    .replace(/<\/svg>\s*$/i, '')
    .trim();
  return { viewBox, inner, full: body };
}

function colorizeInner(inner, fg) {
  let out = inner;
  out = out.replaceAll('currentColor', fg);
  out = out.replace(/fill="(?!none)[^"]*"/gi, `fill="${fg}"`);
  out = out.replace(/stroke="(?!none)[^"]*"/gi, `stroke="${fg}"`);
  // bare fill/stroke attrs without quotes variants already handled
  if (!/fill=/.test(out) && /<path\b/i.test(out)) {
    out = out.replace(/<path\b/gi, `<path fill="${fg}"`);
  }
  return out;
}

function wrap({ viewBox, inner, bg }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <rect width="64" height="64" rx="14" fill="${bg}"/>
  <svg x="8" y="8" width="48" height="48" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet">
    ${inner}
  </svg>
</svg>
`;
}

function slugify(file) {
  return file.replace(/\.svg$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`Missing sources at ${SRC_DIR}`);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const file of fs.readdirSync(OUT_DIR)) {
    if (file.endsWith('.svg')) fs.unlinkSync(path.join(OUT_DIR, file));
  }

  const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.svg')).sort();
  const icons = [];
  const categories = new Set();

  for (const file of files) {
    const raw = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
    if (!raw.includes('<svg')) {
      console.warn(`skip non-svg ${file}`);
      continue;
    }
    const { viewBox, inner } = extractSvg(raw);
    const meta = classify(file);
    const source = sourceLabel(file);
    const base = slugify(file);
    categories.add(meta.category);

    if (isColorful(file)) {
      const id = `af-${base}`;
      fs.writeFileSync(path.join(OUT_DIR, `${id}.svg`), wrap({ viewBox, inner, bg: '#141414' }));
      icons.push({
        id,
        name: `${meta.label} · ${source}`,
        motif: meta.label.toLowerCase(),
        category: meta.category,
        palette: 'color',
        src: `/assets/team-icons/${id}.svg`
      });
      continue;
    }

    for (const color of COLORS) {
      const id = `af-${base}-${color.id}`;
      const tinted = colorizeInner(inner, color.fg);
      fs.writeFileSync(
        path.join(OUT_DIR, `${id}.svg`),
        wrap({ viewBox, inner: tinted, bg: color.bg })
      );
      icons.push({
        id,
        name: `${meta.label} · ${color.name} · ${source}`,
        motif: meta.label.toLowerCase(),
        category: meta.category,
        palette: color.id,
        src: `/assets/team-icons/${id}.svg`
      });
    }
  }

  const order = ['Footballs', 'Helmets', 'Players', 'Jerseys', 'Gear', 'Marks'];
  const cats = order.filter((c) => categories.has(c));
  for (const c of categories) if (!cats.includes(c)) cats.push(c);

  icons.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  fs.writeFileSync(CATALOG, `/* Auto-generated GridIron icon pack — American football freeware
 * See vendor/american-football-icons/README.md for sources & licenses.
 */
window.GridIronIcons = {
  recommendedSize: 512,
  minSize: 256,
  maxSize: 1024,
  categories: ${JSON.stringify(cats)},
  icons: ${JSON.stringify(icons, null, 2)}
};
`);
  console.log(`Generated ${icons.length} icons from ${files.length} freeware sources → ${CATALOG}`);
}

main();
