#!/usr/bin/env node
/**
 * Clean GridIron sports icon pack — simple, bold, sports marks.
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'public', 'assets', 'team-icons');
const CATALOG = path.join(__dirname, '..', 'public', 'js', 'team-icons.js');

const COLORS = [
  { id: 'white', bg: '#111111', fg: '#f4f4f4' },
  { id: 'gold', bg: '#111111', fg: '#efd782' },
  { id: 'blue', bg: '#0a1628', fg: '#5b8cff' },
  { id: 'orange', bg: '#1a0d04', fg: '#ff7a18' },
  { id: 'red', bg: '#1a0506', fg: '#e2232a' },
  { id: 'green', bg: '#07140c', fg: '#3dd68c' }
];

function svg(fg, bg, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <rect width="64" height="64" rx="14" fill="${bg}"/>
  <g fill="${fg}">${body}</g>
</svg>`;
}

// Clean geometric sports glyphs (24x24-ish content centered in 64)
const ICONS = [
  {
    id: 'football',
    name: 'Football',
    category: 'Ball',
    body: `<ellipse cx="32" cy="32" rx="22" ry="13" transform="rotate(-35 32 32)"/>
      <path d="M20 26c8 4 16 10 24 14" fill="none" stroke="#111" stroke-width="2"/>
      <path d="M26 24l2 4M30 22l2 4.5M34 23l1.8 4.2M38 26l1.5 3.8" stroke="#111" stroke-width="1.8" stroke-linecap="round"/>`
  },
  {
    id: 'helmet',
    name: 'Helmet',
    category: 'Gear',
    body: `<path d="M14 38c0-14 10-24 22-24 13 0 18 10 18 18 0 5-3 8-8 8H33l-6 8h-4l4-8h-5c-3 0-6-1-6-2z"/>
      <path d="M32 28h18" stroke="#111" stroke-width="5" stroke-linecap="round"/>`
  },
  {
    id: 'cleat',
    name: 'Cleat',
    category: 'Gear',
    body: `<path d="M12 34c8-10 22-12 32-6l10 3v8H44c-6 6-18 8-26 4z"/>
      <circle cx="20" cy="44" r="2.2"/><circle cx="28" cy="46" r="2.2"/>
      <circle cx="36" cy="45" r="2.2"/><circle cx="44" cy="42" r="2.2"/>`
  },
  {
    id: 'jersey',
    name: 'Jersey',
    category: 'Gear',
    body: `<path d="M20 16l7-3 5 7 5-7 7 3 8 8v28H12V24z"/>
      <text x="32" y="40" text-anchor="middle" font-family="Arial Black, sans-serif" font-size="12" fill="#111">24</text>`
  },
  {
    id: 'glove',
    name: 'Glove',
    category: 'Gear',
    body: `<path d="M20 48V30c0-8 6-12 12-12s12 4 12 12v18z"/>
      <rect x="23" y="10" width="5" height="14" rx="2"/>
      <rect x="30" y="8" width="5" height="16" rx="2"/>
      <rect x="37" y="10" width="5" height="14" rx="2"/>`
  },
  {
    id: 'whistle',
    name: 'Whistle',
    category: 'Gear',
    body: `<rect x="12" y="26" width="26" height="14" rx="5"/>
      <circle cx="44" cy="33" r="10"/>
      <circle cx="44" cy="33" r="3.5" fill="#111"/>
      <rect x="18" y="18" width="5" height="10" rx="1.5"/>`
  },
  {
    id: 'goalpost',
    name: 'Goalposts',
    category: 'Field',
    body: `<rect x="30" y="36" width="4" height="18"/>
      <rect x="16" y="22" width="32" height="4"/>
      <rect x="16" y="10" width="4" height="16"/>
      <rect x="44" y="10" width="4" height="16"/>`
  },
  {
    id: 'field',
    name: 'Field',
    category: 'Field',
    body: `<rect x="10" y="16" width="44" height="32" rx="3"/>
      <path d="M21 16v32M32 16v32M43 16v32" stroke="#111" stroke-width="2"/>
      <path d="M10 24h44M10 32h44M10 40h44" stroke="#111" stroke-width="1.5" opacity="0.7"/>`
  },
  {
    id: 'first-down',
    name: 'First Down',
    category: 'Field',
    body: `<rect x="12" y="14" width="5" height="36" rx="1"/>
      <rect x="47" y="14" width="5" height="36" rx="1"/>
      <path d="M17 22h30M17 32h30M17 42h30" stroke="currentColor" stroke-width="3"/>`
  },
  {
    id: 'spike',
    name: 'Spike',
    category: 'Field',
    body: `<path d="M32 8l8 28H24z"/>
      <rect x="29" y="34" width="6" height="20"/>
      <circle cx="32" cy="34" r="4" fill="#111" stroke="currentColor" stroke-width="2"/>`
  },
  {
    id: 'trophy',
    name: 'Trophy',
    category: 'Champ',
    body: `<path d="M20 16h24v12c0 10-6 16-12 16s-12-6-12-16z"/>
      <path d="M20 20H14c0 10 6 14 10 15M44 20h6c0 10-6 14-10 15" fill="none" stroke="currentColor" stroke-width="3"/>
      <rect x="29" y="44" width="6" height="6"/>
      <rect x="22" y="50" width="20" height="5" rx="1"/>`
  },
  {
    id: 'medal',
    name: 'Medal',
    category: 'Champ',
    body: `<path d="M20 8l12 14L44 8" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>
      <circle cx="32" cy="38" r="14"/>
      <circle cx="32" cy="38" r="7" fill="#111"/>`
  },
  {
    id: 'crown',
    name: 'Crown',
    category: 'Champ',
    body: `<path d="M12 44L14 18l12 14L32 12l6 20 12-14 2 26z"/>
      <rect x="12" y="44" width="40" height="6" rx="1"/>`
  },
  {
    id: 'ring',
    name: 'Ring',
    category: 'Champ',
    body: `<circle cx="32" cy="34" r="16" fill="none" stroke="currentColor" stroke-width="7"/>
      <rect x="26" y="12" width="12" height="10" rx="1"/>`
  },
  {
    id: 'star',
    name: 'Star',
    category: 'Champ',
    body: `<path d="M32 8l5 14h15l-12 9 5 15-13-9-13 9 5-15-12-9h15z"/>`
  },
  {
    id: 'shield',
    name: 'Shield',
    category: 'Crest',
    body: `<path d="M32 8l20 8v16c0 14-10 22-20 26-10-4-20-12-20-26V16z"/>
      <path d="M32 18l12 5v10c0 8-5 13-12 16-7-3-12-8-12-16V23z" fill="#111"/>`
  },
  {
    id: 'bolt',
    name: 'Lightning',
    category: 'Power',
    body: `<path d="M36 6L18 34h12l-6 24 24-32H34z"/>`
  },
  {
    id: 'flame',
    name: 'Flame',
    category: 'Power',
    body: `<path d="M32 8c8 12 16 16 16 28a16 16 0 11-32 0c0-10 8-16 10-22 2 8 8 10 6-6z"/>
      <path d="M32 28c4 6 8 8 8 14a8 8 0 11-16 0c0-5 4-8 8-14z" fill="#111"/>`
  },
  {
    id: 'fist',
    name: 'Fist',
    category: 'Power',
    body: `<rect x="16" y="22" width="32" height="22" rx="6"/>
      <rect x="18" y="14" width="6" height="12" rx="2"/>
      <rect x="26" y="12" width="6" height="14" rx="2"/>
      <rect x="34" y="14" width="6" height="12" rx="2"/>
      <path d="M16 38h32v10c0 4-4 6-16 6s-16-2-16-6z"/>`
  },
  {
    id: 'target',
    name: 'Target',
    category: 'Power',
    body: `<circle cx="32" cy="32" r="20"/>
      <circle cx="32" cy="32" r="13" fill="#111"/>
      <circle cx="32" cy="32" r="7"/>
      <circle cx="32" cy="32" r="2.5" fill="#111"/>`
  },
  {
    id: 'hawk',
    name: 'Hawk',
    category: 'Animals',
    body: `<path d="M32 10c10 4 18 14 17 24-6-2-11 0-17 8-6-8-11-10-17-8-1-10 7-20 17-24z"/>
      <path d="M24 28l8 7 8-7" fill="none" stroke="#111" stroke-width="2.5" stroke-linecap="round"/>`
  },
  {
    id: 'wolf',
    name: 'Wolf',
    category: 'Animals',
    body: `<path d="M16 46L14 22l10 8L32 12l8 18 10-8-2 24z"/>
      <circle cx="26" cy="32" r="2" fill="#111"/><circle cx="38" cy="32" r="2" fill="#111"/>`
  },
  {
    id: 'bull',
    name: 'Bull',
    category: 'Animals',
    body: `<ellipse cx="32" cy="34" rx="16" ry="14"/>
      <path d="M10 20l8 8M54 20l-8 8" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>
      <circle cx="26" cy="32" r="2.5" fill="#111"/><circle cx="38" cy="32" r="2.5" fill="#111"/>`
  },
  {
    id: 'bear',
    name: 'Bear',
    category: 'Animals',
    body: `<circle cx="18" cy="20" r="7"/><circle cx="46" cy="20" r="7"/>
      <circle cx="32" cy="34" r="18"/>
      <circle cx="25" cy="32" r="3" fill="#111"/><circle cx="39" cy="32" r="3" fill="#111"/>
      <ellipse cx="32" cy="40" rx="5" ry="3.5" fill="#111"/>`
  },
  {
    id: 'panther',
    name: 'Panther',
    category: 'Animals',
    body: `<ellipse cx="32" cy="36" rx="18" ry="14"/>
      <path d="M16 26l-4-12 12 8M48 26l4-12-12 8"/>
      <circle cx="25" cy="34" r="2.5" fill="#111"/><circle cx="39" cy="34" r="2.5" fill="#111"/>`
  },
  {
    id: 'eagle',
    name: 'Eagle',
    category: 'Animals',
    body: `<path d="M32 46C18 36 8 34 6 24c12 4 18-4 26-14 8 10 14 18 26 14-2 10-12 12-26 22z"/>`
  },
  {
    id: 'shark',
    name: 'Shark',
    category: 'Animals',
    body: `<path d="M8 36c12-16 34-18 48-6-12-1-18 4-22 10-6-2-16-2-26-4z"/>
      <path d="M36 22l5-12 5 13"/>
      <circle cx="46" cy="30" r="2" fill="#111"/>`
  },
  {
    id: 'ram',
    name: 'Ram',
    category: 'Animals',
    body: `<ellipse cx="32" cy="36" rx="15" ry="13"/>
      <path d="M12 20c-4 8 2 16 10 12M52 20c4 8-2 16-10 12" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>
      <circle cx="26" cy="34" r="2" fill="#111"/><circle cx="38" cy="34" r="2" fill="#111"/>`
  },
  {
    id: 'mountain',
    name: 'Mountain',
    category: 'Marks',
    body: `<path d="M6 50L24 18l8 12 10-20 16 40z"/>
      <path d="M24 18l5 8H20z" fill="#111"/><path d="M42 10l5 10h-9z" fill="#111"/>`
  },
  {
    id: 'wave',
    name: 'Wave',
    category: 'Marks',
    body: `<path d="M6 34c8-12 16 12 24 0s16 12 28-4" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>
      <path d="M6 46c8-12 16 12 24 0s16 12 28-4" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>`
  },
  {
    id: 'sun',
    name: 'Sun',
    category: 'Marks',
    body: `<circle cx="32" cy="32" r="10"/>
      ${[0, 45, 90, 135, 180, 225, 270, 315].map((d) => {
        const r = (d * Math.PI) / 180;
        return `<line x1="${32 + Math.cos(r) * 14}" y1="${32 + Math.sin(r) * 14}" x2="${32 + Math.cos(r) * 22}" y2="${32 + Math.sin(r) * 22}" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>`;
      }).join('')}`
  },
  {
    id: 'ice',
    name: 'Ice',
    category: 'Marks',
    body: `<path d="M32 8l4 16 16-4-12 12 12 12-16-4-4 16-4-16-16 4 12-12-12-12 16 4z"/>`
  },
  {
    id: 'arrow',
    name: 'Arrowhead',
    category: 'Marks',
    body: `<path d="M32 6l18 24H40v28H24V30H14z"/>`
  },
  {
    id: 'diamond',
    name: 'Diamond',
    category: 'Marks',
    body: `<path d="M32 6l22 26-22 26L10 32z"/>
      <path d="M32 16l12 16-12 16L20 32z" fill="#111"/>`
  },
  {
    id: 'hex',
    name: 'Hex',
    category: 'Marks',
    body: `<path d="M32 6l18 12v20L32 50 14 38V18z"/>
      <text x="32" y="36" text-anchor="middle" font-family="Arial Black, sans-serif" font-size="12" fill="#111">24</text>`
  },
  {
    id: 'pad',
    name: 'Pads',
    category: 'Gear',
    body: `<path d="M8 36c4-16 14-22 24-22s20 6 24 22c-8-4-16-6-24-6s-16 2-24 6z"/>
      <rect x="28" y="34" width="8" height="18" rx="2"/>`
  },
  {
    id: 'facemask',
    name: 'Facemask',
    category: 'Gear',
    body: `<ellipse cx="32" cy="32" rx="20" ry="16"/>
      <path d="M16 26h32M16 32h32M16 38h32" stroke="#111" stroke-width="2.5"/>
      <path d="M22 20v24M32 18v28M42 20v24" stroke="#111" stroke-width="2"/>`
  },
  {
    id: 'playbook',
    name: 'Playbook',
    category: 'Field',
    body: `<rect x="14" y="12" width="36" height="40" rx="3"/>
      <path d="M24 24h20M24 32h16M24 40h18" stroke="#111" stroke-width="3" stroke-linecap="round"/>
      <circle cx="19" cy="24" r="2" fill="#111"/><circle cx="19" cy="32" r="2" fill="#111"/><circle cx="19" cy="40" r="2" fill="#111"/>`
  },
  {
    id: 'lock',
    name: 'Lockdown',
    category: 'Field',
    body: `<rect x="16" y="28" width="32" height="24" rx="4"/>
      <path d="M22 28v-6a10 10 0 1120 0v6" fill="none" stroke="currentColor" stroke-width="4"/>
      <circle cx="32" cy="40" r="3" fill="#111"/>`
  },
  {
    id: 'checkered',
    name: 'Finish',
    category: 'Field',
    body: `<rect x="12" y="14" width="40" height="36" rx="2"/>
      ${[0, 1, 2, 3].map((row) => [0, 1, 2, 3].map((col) => (
        (row + col) % 2 ? '' : `<rect x="${14 + col * 9}" y="${16 + row * 8}" width="9" height="8" fill="#111"/>`
      )).join('')).join('')}`
  }
];

function loadExistingCatalogIcons() {
  if (!fs.existsSync(CATALOG)) return [];
  try {
    const raw = fs.readFileSync(CATALOG, 'utf8');
    const match = raw.match(/icons:\s*(\[[\s\S]*?\n\s*\])\s*\n\}/);
    if (!match) return [];
    return JSON.parse(match[1]);
  } catch {
    return [];
  }
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const sportsIds = new Set();
  const sportsIcons = [];
  for (const icon of ICONS) {
    for (const color of COLORS) {
      let body = icon.body
        .replaceAll('stroke="currentColor"', `stroke="${color.fg}"`)
        .replaceAll('fill="currentColor"', `fill="${color.fg}"`);
      body = body.replace(/<path([^>]*stroke=)/g, (m, rest) => {
        if (/fill=/.test(m)) return m;
        return `<path fill="none"${rest}`;
      });
      body = body.replace(/<line /g, '<line fill="none" ');

      const id = `${icon.id}-${color.id}`;
      sportsIds.add(id);
      const markup = svg(color.fg, color.bg, body);
      fs.writeFileSync(path.join(OUT_DIR, `${id}.svg`), markup);
      sportsIcons.push({
        id,
        name: icon.name,
        motif: icon.id,
        category: icon.category,
        palette: color.id,
        src: `/assets/team-icons/${id}.svg`
      });
    }
  }

  // Keep fun avatar pack entries that still have files on disk.
  const prior = loadExistingCatalogIcons().filter((icon) => {
    if (sportsIds.has(icon.id)) return false;
    return fs.existsSync(path.join(OUT_DIR, `${icon.id}.svg`));
  });

  const icons = [...sportsIcons, ...prior];
  const categories = [
    ...new Set([
      ...ICONS.map((i) => i.category),
      ...prior.map((i) => i.category)
    ])
  ];

  fs.writeFileSync(CATALOG, `/* Auto-generated GridIron icon pack (sports + avatars) */
window.GridIronIcons = {
  recommendedSize: 512,
  minSize: 256,
  maxSize: 1024,
  categories: ${JSON.stringify(categories)},
  icons: ${JSON.stringify(icons, null, 2)}
};
`);
  console.log(
    `Generated ${sportsIcons.length} sports icons; kept ${prior.length} avatars; catalog total ${icons.length}`
  );
}

main();
