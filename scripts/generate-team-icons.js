#!/usr/bin/env node
/**
 * GridIron team logo pack — generic football helmets only.
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'public', 'assets', 'team-icons');
const CATALOG = path.join(__dirname, '..', 'public', 'js', 'team-icons.js');

const COLORS = [
  { id: 'white', name: 'White', bg: '#141414', shell: '#f2f2f2', mask: '#9a9a9a', stripe: '#222222' },
  { id: 'silver', name: 'Silver', bg: '#141414', shell: '#c0c5cc', mask: '#6e737a', stripe: '#2a2e34' },
  { id: 'black', name: 'Black', bg: '#1c1c1c', shell: '#2a2a2a', mask: '#8a8a8a', stripe: '#efefef' },
  { id: 'gold', name: 'Gold', bg: '#1a1408', shell: '#e8c547', mask: '#7a6418', stripe: '#1a1408' },
  { id: 'navy', name: 'Navy', bg: '#070d18', shell: '#1a3a6e', mask: '#8a9bb0', stripe: '#efefef' },
  { id: 'blue', name: 'Blue', bg: '#0a1628', shell: '#2f6fed', mask: '#0d1f3d', stripe: '#efefef' },
  { id: 'sky', name: 'Sky', bg: '#0a1620', shell: '#5eb3e8', mask: '#1a3a50', stripe: '#0a1620' },
  { id: 'teal', name: 'Teal', bg: '#061414', shell: '#1aa6a0', mask: '#0a3a38', stripe: '#efefef' },
  { id: 'green', name: 'Green', bg: '#07140c', shell: '#1f9d55', mask: '#0a3a20', stripe: '#efefef' },
  { id: 'lime', name: 'Lime', bg: '#0c1408', shell: '#8fd94a', mask: '#2f4a14', stripe: '#0c1408' },
  { id: 'yellow', name: 'Yellow', bg: '#161208', shell: '#f5d031', mask: '#6a5810', stripe: '#161208' },
  { id: 'orange', name: 'Orange', bg: '#1a0d04', shell: '#f07316', mask: '#5a2a08', stripe: '#1a0d04' },
  { id: 'red', name: 'Red', bg: '#1a0506', shell: '#d8222a', mask: '#5a1014', stripe: '#efefef' },
  { id: 'crimson', name: 'Crimson', bg: '#160508', shell: '#9b1b2e', mask: '#4a0e18', stripe: '#efefef' },
  { id: 'maroon', name: 'Maroon', bg: '#14080c', shell: '#6b1d2a', mask: '#3a1018', stripe: '#efefef' },
  { id: 'purple', name: 'Purple', bg: '#12081a', shell: '#6b3fd4', mask: '#2a1850', stripe: '#efefef' },
  { id: 'violet', name: 'Violet', bg: '#14081a', shell: '#9b59d8', mask: '#3a1850', stripe: '#efefef' },
  { id: 'pink', name: 'Pink', bg: '#1a0812', shell: '#e85a9a', mask: '#5a1838', stripe: '#1a0812' },
  { id: 'brown', name: 'Brown', bg: '#140c08', shell: '#8b5a2b', mask: '#3a2410', stripe: '#efefef' },
  { id: 'tan', name: 'Tan', bg: '#14100c', shell: '#c4a574', mask: '#5a4830', stripe: '#2a2018' }
];

function helmetSvg({ bg, shell, mask, stripe }) {
  // Side-view American football helmet — shell, center stripe, facemask, ear hole.
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <rect width="64" height="64" rx="14" fill="${bg}"/>
  <!-- shell -->
  <path fill="${shell}" d="M12 36c0-13.5 10.5-24 24-24 14.5 0 22 10 22 20.5 0 5.5-3.5 9-9 9H34.5l-5.5 9.5h-4.5l3.8-9.5H18c-3.5 0-6-1.5-6-5z"/>
  <!-- center stripe -->
  <path fill="${stripe}" d="M33.2 12.2c1.1-.15 2.2-.2 3.3-.2.4 0 .8 0 1.2.02V41.5h-4.5V12.2z" opacity="0.92"/>
  <!-- facemask -->
  <g stroke="${mask}" stroke-width="2.2" stroke-linecap="round" fill="none">
    <path d="M34 26.5h18.5"/>
    <path d="M33.5 31h19.5"/>
    <path d="M33 35.5h17"/>
    <path d="M52.5 26.5v9"/>
    <path d="M47 26.5v12.5"/>
    <path d="M41.5 26.5v14"/>
  </g>
  <!-- ear / buckle -->
  <circle cx="28" cy="34" r="2.6" fill="${bg}" stroke="${mask}" stroke-width="1.4"/>
</svg>
`;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Wipe prior pack files — picker is helmets only.
  for (const file of fs.readdirSync(OUT_DIR)) {
    if (file.endsWith('.svg')) fs.unlinkSync(path.join(OUT_DIR, file));
  }

  const icons = COLORS.map((color) => {
    const id = `helmet-${color.id}`;
    fs.writeFileSync(path.join(OUT_DIR, `${id}.svg`), helmetSvg(color));
    return {
      id,
      name: `${color.name} Helmet`,
      motif: 'helmet',
      category: 'Helmets',
      palette: color.id,
      src: `/assets/team-icons/${id}.svg`
    };
  });

  fs.writeFileSync(CATALOG, `/* Auto-generated GridIron icon pack — football helmets */
window.GridIronIcons = {
  recommendedSize: 512,
  minSize: 256,
  maxSize: 1024,
  categories: ["Helmets"],
  icons: ${JSON.stringify(icons, null, 2)}
};
`);
  console.log(`Generated ${icons.length} helmets → ${CATALOG}`);
}

main();
