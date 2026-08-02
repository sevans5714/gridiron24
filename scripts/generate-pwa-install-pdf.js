/**
 * Generate public/docs/gridiron24-app-install.pdf from pwa-install-guide.js
 * Run: npm run docs:pwa-pdf
 *
 * Branded to match GridIron 24 HQ email / site chrome (dark field, crest, blue accent).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { GUIDE } = require('../pwa-install-guide');

const OUT_DIR = path.join(__dirname, '..', 'public', 'docs');
const OUT_FILE = path.join(OUT_DIR, 'gridiron24-app-install.pdf');
const CREST_PATH = path.join(__dirname, '..', 'public', 'assets', 'gridiron24-crest-md.png');

const COLORS = {
  bg: [0.02, 0.02, 0.02],          // #050505
  panel: [0.051, 0.051, 0.051],    // #0d0d0d
  headerDeep: [0.047, 0.078, 0.133], // #0c1422
  blue: [0.184, 0.427, 1.0],       // #2f6dff
  gold: [0.937, 0.843, 0.510],     // #efd782
  text: [0.949, 0.949, 0.949],     // #f2f2f2
  muted: [0.608, 0.608, 0.608],    // #9b9b9b
  body: [0.12, 0.12, 0.12],        // near-black body text on light pages? Use dark theme throughout
  line: [0.22, 0.22, 0.22],
  tipBg: [0.08, 0.12, 0.22],
  white: [1, 1, 1]
};

function pdfEscape(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function rgb(c) {
  return `${c[0].toFixed(3)} ${c[1].toFixed(3)} ${c[2].toFixed(3)} rg`;
}

function RG(c) {
  return `${c[0].toFixed(3)} ${c[1].toFixed(3)} ${c[2].toFixed(3)} RG`;
}

function wrapWords(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/** Minimal PNG decoder — 8-bit RGB/RGBA, non-interlaced */
function decodePng(buf) {
  if (buf[0] !== 0x89 || buf.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error('Not a PNG');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  const idats = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idats.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`Unsupported PNG (bitDepth=${bitDepth} colorType=${colorType})`);
  }
  const compressed = Buffer.concat(idats);
  const inflated = zlib.inflateSync(compressed);
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const rgba = Buffer.alloc(width * height * 4);
  let src = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[src++];
    const row = Buffer.alloc(stride);
    inflated.copy(row, 0, src, src + stride);
    src += stride;
    for (let i = 0; i < stride; i += 1) {
      const x = row[i];
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let val = x;
      if (filter === 1) val = (x + a) & 255;
      else if (filter === 2) val = (x + b) & 255;
      else if (filter === 3) val = (x + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        val = (x + pr) & 255;
      }
      row[i] = val;
    }
    for (let x = 0; x < width; x += 1) {
      const si = x * bpp;
      const di = (y * width + x) * 4;
      rgba[di] = row[si];
      rgba[di + 1] = row[si + 1];
      rgba[di + 2] = row[si + 2];
      rgba[di + 3] = colorType === 6 ? row[si + 3] : 255;
    }
    prev = row;
  }
  return { width, height, rgba };
}

function compositeCrestRgb(size = 160) {
  const png = decodePng(fs.readFileSync(CREST_PATH));
  const bg = [13, 13, 13];
  const out = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sx = Math.min(png.width - 1, Math.floor((x / size) * png.width));
      const sy = Math.min(png.height - 1, Math.floor((y / size) * png.height));
      const i = (sy * png.width + sx) * 4;
      const a = png.rgba[i + 3] / 255;
      const di = (y * size + x) * 3;
      out[di] = Math.round(png.rgba[i] * a + bg[0] * (1 - a));
      out[di + 1] = Math.round(png.rgba[i + 1] * a + bg[1] * (1 - a));
      out[di + 2] = Math.round(png.rgba[i + 2] * a + bg[2] * (1 - a));
    }
  }
  return { width: size, height: size, rgb: out, flate: zlib.deflateSync(out) };
}

function buildDocument() {
  const pageW = 612;
  const pageH = 792;
  const marginX = 42;
  const contentW = pageW - marginX * 2;
  const crest = compositeCrestRgb(168);

  const blocks = [];

  function addHeading(title, accent = COLORS.blue) {
    blocks.push({ type: 'sectionHead', title, accent });
  }
  function addPara(text, opts = {}) {
    for (const line of wrapWords(text, opts.max || 78)) {
      blocks.push({ type: 'body', text: line, muted: !!opts.muted, bold: !!opts.bold });
    }
  }
  function addBullets(items, numbered = false) {
    items.forEach((item, idx) => {
      const prefix = numbered ? `${idx + 1}.  ` : '-  ';
      const wrapped = wrapWords(item, 74);
      wrapped.forEach((line, li) => {
        blocks.push({
          type: 'bullet',
          text: li === 0 ? `${prefix}${line}` : `    ${line}`,
          first: li === 0
        });
      });
    });
  }
  function spacer(h = 10) {
    blocks.push({ type: 'space', h });
  }

  // Content (header drawn separately on page 1)
  addPara(GUIDE.intro[0]);
  addPara(GUIDE.intro[1]);
  spacer(12);
  addHeading('Before you start', COLORS.gold);
  addBullets(GUIDE.beforeYouStart);
  spacer(14);
  addHeading(GUIDE.apple.title, COLORS.blue);
  addBullets(GUIDE.apple.steps, true);
  spacer(8);
  blocks.push({ type: 'tipLabel', text: 'TIPS' });
  addBullets(GUIDE.apple.tips);
  spacer(14);
  addHeading(GUIDE.android.title, [0.18, 0.72, 0.45]);
  addBullets(GUIDE.android.steps, true);
  spacer(8);
  blocks.push({ type: 'tipLabel', text: 'TIPS' });
  addBullets(GUIDE.android.tips);
  spacer(14);
  addHeading(GUIDE.afterInstall.title, COLORS.gold);
  addBullets(GUIDE.afterInstall.bullets);
  spacer(12);
  addHeading(GUIDE.help.title, COLORS.muted);
  addPara(GUIDE.help.body, { muted: true });

  const headerH = 168;
  const footerH = 48;
  const lineH = 13.5;
  const pages = [];
  let y = pageH - headerH - 28;
  let pageBlocks = [];

  function newPage() {
    pages.push({ blocks: pageBlocks, isFirst: pages.length === 0 });
    pageBlocks = [];
    y = pageH - 56;
  }

  for (const b of blocks) {
    let need = lineH;
    if (b.type === 'space') need = b.h;
    else if (b.type === 'sectionHead') need = 26;
    else if (b.type === 'tipLabel') need = 18;
    if (y - need < footerH + 20) newPage();
    pageBlocks.push(b);
    y -= need;
  }
  if (pageBlocks.length) newPage();

  function drawHeader(isFirst) {
    const ops = [];
    // Full dark page wash for first page header area; continuation pages get slim bar
    if (isFirst) {
      ops.push(`${rgb(COLORS.bg)} 0 0 ${pageW} ${pageH} re f`);
      // Hero band — night field (matches HQ email / site chrome)
      ops.push(`${rgb(COLORS.headerDeep)} 0 ${pageH - headerH} ${pageW} ${headerH} re f`);
      ops.push(`${rgb([0.07, 0.12, 0.22])} 0 ${pageH - headerH} ${pageW} ${Math.floor(headerH * 0.55)} re f`);
      ops.push(`${rgb(COLORS.blue)} 0 ${pageH - 5} ${pageW} 5 re f`);
      ops.push(`${rgb(COLORS.gold)} 0 ${pageH - headerH - 3} ${pageW} 3 re f`);

      const logoSize = 96;
      const logoX = marginX + 2;
      const logoY = pageH - headerH + (headerH - logoSize) / 2 + 2;
      ops.push('q');
      ops.push(`${logoSize} 0 0 ${logoSize} ${logoX} ${logoY} cm`);
      ops.push('/ImCrest Do');
      ops.push('Q');

      const textX = logoX + logoSize + 16;
      ops.push('BT');
      ops.push(rgb(COLORS.gold));
      ops.push('/F2 9 Tf');
      ops.push(`${textX} ${pageH - 46} Td`);
      ops.push(`(${pdfEscape('GRIDIRON 24  |  FANTASY HQ')}) Tj`);
      ops.push('ET');

      ops.push('BT');
      ops.push(rgb(COLORS.white));
      ops.push('/F2 28 Tf');
      ops.push(`${textX} ${pageH - 84} Td`);
      ops.push(`(${pdfEscape('INSTALL THE APP')}) Tj`);
      ops.push('ET');

      ops.push('BT');
      ops.push(rgb(COLORS.muted));
      ops.push('/F1 11 Tf');
      ops.push(`${textX} ${pageH - 108} Td`);
      ops.push(`(${pdfEscape(GUIDE.subtitle)}) Tj`);
      ops.push('ET');

      ops.push('BT');
      ops.push(rgb(COLORS.blue));
      ops.push('/F2 9 Tf');
      ops.push(`${textX} ${pageH - 132} Td`);
      ops.push(`(${pdfEscape(GUIDE.updatedLabel.toUpperCase() + '  |  ' + GUIDE.siteUrl.replace(/^https:\/\//, ''))}) Tj`);
      ops.push('ET');
    } else {
      ops.push(`${rgb(COLORS.bg)} 0 0 ${pageW} ${pageH} re f`);
      ops.push(`${rgb(COLORS.headerDeep)} 0 ${pageH - 44} ${pageW} 44 re f`);
      ops.push(`${rgb(COLORS.blue)} 0 ${pageH - 3} ${pageW} 3 re f`);
      ops.push(`${rgb(COLORS.gold)} 0 ${pageH - 46} ${pageW} 2 re f`);
      const logoSize = 28;
      ops.push('q');
      ops.push(`${logoSize} 0 0 ${logoSize} ${marginX} ${pageH - 36} cm`);
      ops.push('/ImCrest Do');
      ops.push('Q');
      ops.push('BT');
      ops.push(rgb(COLORS.white));
      ops.push('/F2 11 Tf');
      ops.push(`${marginX + 36} ${pageH - 28} Td`);
      ops.push(`(${pdfEscape('GridIron 24  |  Install Guide (cont.)')}) Tj`);
      ops.push('ET');
    }
    return ops;
  }

  function drawFooter(pageIndex, pageCount) {
    const ops = [];
    ops.push(`${RG(COLORS.line)} 0.6 w ${marginX} ${footerH} m ${pageW - marginX} ${footerH} l S`);
    ops.push('BT');
    ops.push(rgb(COLORS.muted));
    ops.push('/F1 8 Tf');
    ops.push(`${marginX} ${footerH - 18} Td`);
    ops.push(`(${pdfEscape('GridIron 24 created by S.Evans  |  ' + GUIDE.siteUrl)}) Tj`);
    ops.push('ET');
    ops.push('BT');
    ops.push(rgb(COLORS.muted));
    ops.push('/F1 8 Tf');
    ops.push(`${pageW - marginX - 48} ${footerH - 18} Td`);
    ops.push(`(${pdfEscape(`${pageIndex + 1} / ${pageCount}`)}) Tj`);
    ops.push('ET');
    return ops;
  }

  function drawBlocks(list, startY) {
    const ops = [];
    let yPos = startY;
    for (const b of list) {
      if (b.type === 'space') {
        yPos -= b.h;
        continue;
      }
      if (b.type === 'sectionHead') {
        // Accent bar + title
        ops.push(`${rgb(b.accent)} ${marginX} ${yPos - 2} 4 16 re f`);
        ops.push('BT');
        ops.push(rgb(COLORS.white));
        ops.push('/F2 13 Tf');
        ops.push(`${marginX + 14} ${yPos} Td`);
        ops.push(`(${pdfEscape(b.title.toUpperCase())}) Tj`);
        ops.push('ET');
        yPos -= 22;
        continue;
      }
      if (b.type === 'tipLabel') {
        ops.push(`${rgb(COLORS.tipBg)} ${marginX} ${yPos - 4} ${contentW} 16 re f`);
        ops.push(`${rgb(COLORS.blue)} ${marginX} ${yPos - 4} 3 16 re f`);
        ops.push('BT');
        ops.push(rgb(COLORS.gold));
        ops.push('/F2 8 Tf');
        ops.push(`${marginX + 12} ${yPos} Td`);
        ops.push(`(${pdfEscape(b.text)}) Tj`);
        ops.push('ET');
        yPos -= 18;
        continue;
      }
      const color = b.muted ? COLORS.muted : COLORS.text;
      const font = b.bold ? 'F2' : 'F1';
      const size = b.type === 'bullet' ? 10.5 : 10.5;
      ops.push('BT');
      ops.push(rgb(color));
      ops.push(`/${font} ${size} Tf`);
      ops.push(`${marginX + (b.type === 'bullet' ? 8 : 0)} ${yPos} Td`);
      ops.push(`(${pdfEscape(b.text)}) Tj`);
      ops.push('ET');
      yPos -= lineH;
    }
    return ops;
  }

  const contentStreams = pages.map((page, idx) => {
    const startY = page.isFirst ? pageH - headerH - 28 : pageH - 64;
    const ops = [
      ...drawHeader(page.isFirst),
      ...drawBlocks(page.blocks, startY),
      ...drawFooter(idx, pages.length)
    ];
    return ops.join('\n');
  });

  return { contentStreams, pageW, pageH, crest };
}

function buildPdf() {
  const { contentStreams, pageW, pageH, crest } = buildDocument();
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };

  const fontRegular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');

  const imageId = add(
    `<< /Type /XObject /Subtype /Image /Width ${crest.width} /Height ${crest.height} ` +
    `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${crest.flate.length} >>\n` +
    `stream\n`
  );
  // store binary separately — we'll assemble carefully
  const imageStream = crest.flate;
  objects[imageId - 1] = {
    dict:
      `<< /Type /XObject /Subtype /Image /Width ${crest.width} /Height ${crest.height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${imageStream.length} >>`,
    stream: imageStream
  };

  const contentIds = contentStreams.map((stream) => {
    const bytes = Buffer.from(stream, 'utf8');
    const id = add({ dict: `<< /Length ${bytes.length} >>`, stream: bytes });
    return id;
  });

  const pageIds = contentIds.map((contentId) =>
    add(
      `<< /Type /Page /Parent 0 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
      `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> ` +
      `/XObject << /ImCrest ${imageId} 0 R >> >> ` +
      `/Contents ${contentId} 0 R >>`
    )
  );

  const pagesId = add('PLACEHOLDER_PAGES');
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  objects[pagesId - 1] =
    `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;

  for (const id of pageIds) {
    objects[id - 1] = objects[id - 1].replace('/Parent 0 0 R', `/Parent ${pagesId} 0 R`);
  }

  // Assemble binary PDF
  const parts = [Buffer.from('%PDF-1.4\n', 'utf8')];
  const offsets = [0];
  let size = Buffer.byteLength('%PDF-1.4\n', 'utf8');

  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(size);
    const obj = objects[i];
    if (obj && typeof obj === 'object' && obj.dict) {
      const head = Buffer.from(`${i + 1} 0 obj\n${obj.dict}\nstream\n`, 'utf8');
      const tail = Buffer.from('\nendstream\nendobj\n', 'utf8');
      parts.push(head, obj.stream, tail);
      size += head.length + obj.stream.length + tail.length;
    } else {
      const chunk = Buffer.from(`${i + 1} 0 obj\n${obj}\nendobj\n`, 'utf8');
      parts.push(chunk);
      size += chunk.length;
    }
  }

  const xrefStart = size;
  let xref = `xref\n0 ${objects.length + 1}\n`;
  xref += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n`;
  xref += `startxref\n${xrefStart}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'utf8'));

  return Buffer.concat(parts);
}

function main() {
  if (!fs.existsSync(CREST_PATH)) {
    throw new Error(`Missing crest: ${CREST_PATH}`);
  }
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const pdf = buildPdf();
  fs.writeFileSync(OUT_FILE, pdf);
  console.log(`Wrote ${path.relative(process.cwd(), OUT_FILE)} (${pdf.length} bytes)`);
}

main();
