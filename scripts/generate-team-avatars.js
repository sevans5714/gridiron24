#!/usr/bin/env node
/**
 * Download a fun DiceBear avatar pack for GridIron team logos.
 * Styles: adventurer, avataaars, bottts, lorelei, micah, notionists, big-smile, open-peeps
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT_DIR = path.join(__dirname, '..', 'public', 'assets', 'team-icons');
const CATALOG = path.join(__dirname, '..', 'public', 'js', 'team-icons.js');

const STYLES = [
  { id: 'adventurer', name: 'Adventurer', category: 'Characters' },
  { id: 'avataaars', name: 'Avatar', category: 'Characters' },
  { id: 'bottts', name: 'Bot', category: 'Robots' },
  { id: 'lorelei', name: 'Lorelei', category: 'Characters' },
  { id: 'micah', name: 'Micah', category: 'Characters' },
  { id: 'notionists', name: 'Notionist', category: 'Characters' },
  { id: 'big-smile', name: 'Big Smile', category: 'Fun' },
  { id: 'open-peeps', name: 'Peep', category: 'Characters' }
];

// Punchy dark backgrounds that fit the HQ
const BACKGROUNDS = [
  '0a0a0a',
  '0a1628',
  '1a0d04',
  '1a0506',
  '07140c',
  '1a1028',
  '0c1a1a',
  '1a1408'
];

// Fun seeds — sports / attitude / league flavor
const SEEDS = [
  'Blitz', 'GridIron', 'Touchdown', 'Endzone', 'HailMary', 'PickSix', 'SackAttack',
  'GoalLine', 'TwoMinute', 'Audible', 'PlayAction', 'ScreenPass', 'DeepRoute', 'HotRoute',
  'RedZone', 'Wildcat', 'OptionPlay', 'Bootleg', 'TrickPlay', 'FourthDown',
  'Wolfpack', 'Thunder', 'Viper', 'Raptor', 'Maverick', 'Outlaw', 'Renegade', 'Bandit',
  'Phantom', 'Specter', 'Comet', 'Nova', 'Eclipse', 'Storm', 'Cyclone', 'Avalanche',
  'Diesel', 'Voltage', 'Torque', 'Nitro', 'Turbo', 'Rocket', 'Cannon', 'Missile',
  'Kingslayer', 'Ironclad', 'Warpath', 'Rampage', 'Onslaught', 'Mayhem', 'Chaos', 'Fury',
  'Ace', 'Joker', 'Wildcard', 'Lucky', 'Clutch', 'Ice', 'Fire', 'Smoke',
  'Buzzsaw', 'Chainsaw', 'Hatchet', 'Hammer', 'Anvil', 'Forge', 'Steel', 'Chrome',
  'Gator', 'Shark', 'Cobra', 'Panther', 'Falcon', 'Hawk', 'Bull', 'Rhino',
  'Cookie', 'Waffle', 'Nacho', 'Pickle', 'Banjo', 'Disco', 'Neon', 'Pixel',
  'Captain', 'Chief', 'Boss', 'Duke', 'Baron', 'Knight', 'Scout', 'Ranger'
];

function slug(styleId, seed, bg) {
  const s = String(seed).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${styleId}-${s}-${bg.slice(0, 4)}`;
}

function fetchSvg(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: 'image/svg+xml' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchSvg(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

function uniquifySvgIds(svgInner, prefix) {
  const ids = new Set();
  for (const m of svgInner.matchAll(/\sid=["']([^"']+)["']/g)) ids.add(m[1]);
  let out = svgInner;
  for (const id of ids) {
    const next = `${prefix}__${id}`;
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\sid=(["'])${esc}\\1`, 'g'), ` id="${next}"`);
    out = out.replace(new RegExp(`url\\((["']?)#${esc}\\1\\)`, 'g'), `url(#${next})`);
    out = out.replace(new RegExp(`href=(["'])#${esc}\\1`, 'g'), `href="#${next}"`);
    out = out.replace(new RegExp(`xlink:href=(["'])#${esc}\\1`, 'g'), `xlink:href="#${next}"`);
  }
  return out;
}

function wrapAvatar(innerSvg, bg, idPrefix) {
  let body = innerSvg
    .replace(/<\?xml[^>]*>/i, '')
    .replace(/<metadata[\s\S]*?<\/metadata>/gi, '')
    .trim();

  const viewBoxMatch = body.match(/viewBox="([^"]+)"/i);
  const viewBox = viewBoxMatch ? viewBoxMatch[1] : '0 0 128 128';
  let inner = body
    .replace(/^<svg[^>]*>/i, '')
    .replace(/<\/svg>\s*$/i, '');

  const prefix = String(idPrefix || 'av').replace(/[^a-zA-Z0-9_-]/g, '');
  inner = uniquifySvgIds(inner, prefix);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <rect width="128" height="128" rx="28" fill="#${bg}"/>
  <svg x="0" y="0" width="128" height="128" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet">
    ${inner}
  </svg>
</svg>
`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const file of fs.readdirSync(OUT_DIR)) {
    if (file.endsWith('.svg')) fs.unlinkSync(path.join(OUT_DIR, file));
  }

  const icons = [];
  const categories = [...new Set(STYLES.map((s) => s.category))];

  // 16 seeds × 8 styles = 128 unique avatars
  const seedPick = SEEDS.slice(0, 16);
  let i = 0;
  for (const style of STYLES) {
    for (let s = 0; s < seedPick.length; s += 1) {
      const seed = seedPick[s];
      const bg = BACKGROUNDS[(i + s) % BACKGROUNDS.length];
      const id = slug(style.id, seed, bg);
      const url = `https://api.dicebear.com/9.x/${style.id}/svg?seed=${encodeURIComponent(seed)}&size=128&radius=0`;
      process.stdout.write(`fetch ${id}… `);
      try {
        const raw = await fetchSvg(url);
        const svg = wrapAvatar(raw, bg, id);
        fs.writeFileSync(path.join(OUT_DIR, `${id}.svg`), svg);
        icons.push({
          id,
          name: `${style.name} · ${seed}`,
          motif: seed.toLowerCase(),
          category: style.category,
          palette: style.id,
          src: `/assets/team-icons/${id}.svg`
        });
        console.log('ok');
      } catch (err) {
        console.log('FAIL', err.message);
      }
      i += 1;
    }
  }

  icons.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  const catalog = `/* Auto-generated DiceBear avatar pack for GridIron */
window.GridIronIcons = {
  recommendedSize: 512,
  minSize: 256,
  maxSize: 1024,
  categories: ${JSON.stringify(categories)},
  icons: ${JSON.stringify(icons, null, 2)}
};
`;
  fs.writeFileSync(CATALOG, catalog);
  console.log(`\nWrote ${icons.length} avatars → ${OUT_DIR}`);
  console.log(`Catalog → ${CATALOG}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
