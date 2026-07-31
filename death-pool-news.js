/**
 * Daily death-watch news scan for the lounge Death Pool.
 * Sources: Google News RSS + Wikipedia "Deaths in {year}".
 * Paper/game context only — headlines for lounge awareness.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { listFigures } = require('./death-pool-figures');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'death-pool.json');
const MAX_STORIES = 40;
const SCAN_STALE_MS = 20 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12000;
const USER_AGENT =
  'GridIron24DeathPool/1.0 (+https://www.gridiron24.com; lounge game news desk)';

const SEARCHES = [
  {
    category: 'Celebrity',
    q: '("has died" OR "dies at" OR "dead at") (actor OR actress OR celebrity OR hollywood)'
  },
  {
    category: 'Sports',
    q: '("has died" OR "dies at" OR "dead at") (athlete OR NFL OR NBA OR MLB OR NHL OR Olympic OR coach)'
  },
  {
    category: 'Pop Culture',
    q: '("has died" OR "dies at" OR "dead at") (singer OR musician OR rapper OR comedian OR influencer)'
  },
  {
    category: 'Politics',
    q: '("has died" OR "dies at" OR "dead at") (politician OR senator OR congressman OR president OR "prime minister")'
  }
];

let scanLock = null;

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ pools: [], newsWatch: emptyWatch() }, null, 2));
  }
}

function emptyWatch() {
  return {
    lastScanAt: null,
    stories: [],
    errors: [],
    sources: []
  };
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      pools: Array.isArray(data.pools) ? data.pools : [],
      newsWatch: data.newsWatch && typeof data.newsWatch === 'object' ? data.newsWatch : emptyWatch()
    };
  } catch {
    return { pools: [], newsWatch: emptyWatch() };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

function decodeXml(s = '') {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .trim();
}

function tagText(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = String(block || '').match(re);
  return m ? decodeXml(m[1]) : '';
}

function storyId(title, url) {
  return crypto
    .createHash('sha1')
    .update(`${String(title || '').toLowerCase()}|${String(url || '').toLowerCase()}`)
    .digest('hex')
    .slice(0, 16);
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith('http://') ? http : https;
    const req = lib.get(
      url,
      {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/rss+xml, application/xml, text/xml, application/json, */*'
        },
        timeout: FETCH_TIMEOUT_MS
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          fetchText(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
    req.on('error', reject);
  });
}

function looksLikeDeathHeadline(title) {
  const t = String(title || '').toLowerCase();
  if (!t) return false;
  const positive =
    /\b(dies|died|dead|death|passes away|passed away|killed|obituary|mourns|mourning)\b/.test(t);
  if (!positive) return false;
  return !/\b(death metal|death star|fake death|near.?death experience)\b/.test(t);
}

function inferCategory(title, fallback = 'Unknown') {
  const t = String(title || '').toLowerCase();
  if (/\b(nfl|nba|mlb|nhl|olympic|athlete|coach|quarterback|soccer|fifa|ufc|boxing|wrestler|nascar)\b/.test(t)) {
    return 'Sports';
  }
  if (/\b(senator|congress|president|politician|governor|minister|mayor|lawmaker)\b/.test(t)) {
    return 'Politics';
  }
  if (/\b(singer|musician|rapper|band|comedian|influencer|tiktok|youtube)\b/.test(t)) {
    return 'Pop Culture';
  }
  if (/\b(actor|actress|celebrity)\b/.test(t)) {
    return 'Celebrity';
  }
  return fallback;
}

function googleNewsRssUrl(query) {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}

function parseRssItems(xml, category) {
  const items = [];
  const blocks = String(xml || '').match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const block of blocks) {
    let title = tagText(block, 'title');
    let sourceName = tagText(block, 'source');
    if (!sourceName && title.includes(' - ')) {
      const parts = title.split(' - ');
      if (parts.length >= 2) {
        sourceName = parts.pop().trim();
        title = parts.join(' - ').trim();
      }
    }
    const link = tagText(block, 'link') || tagText(block, 'guid');
    const pubDate = tagText(block, 'pubDate');
    const description = tagText(block, 'description')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!title || !looksLikeDeathHeadline(title)) continue;
    const publishedAt = pubDate ? new Date(pubDate).toISOString() : null;
    items.push({
      id: storyId(title, link),
      title: title.slice(0, 220),
      url: link || null,
      source: sourceName || 'Google News',
      category: inferCategory(title, category),
      publishedAt: Number.isFinite(Date.parse(publishedAt)) ? publishedAt : null,
      snippet: description.slice(0, 280),
      origin: 'google-news'
    });
  }
  return items;
}

async function fetchGoogleNews() {
  const out = [];
  const errors = [];
  const sources = [];
  for (const search of SEARCHES) {
    const url = googleNewsRssUrl(search.q);
    try {
      const xml = await fetchText(url);
      const items = parseRssItems(xml, search.category);
      out.push(...items);
      sources.push({ name: `Google News · ${search.category}`, ok: true, count: items.length });
    } catch (err) {
      errors.push(`Google News (${search.category}): ${err.message}`);
      sources.push({ name: `Google News · ${search.category}`, ok: false, error: err.message });
    }
  }
  return { stories: out, errors, sources };
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchWikipediaDeaths() {
  const year = new Date().getUTCFullYear();
  const page = `Deaths_in_${year}`;
  const api =
    `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}` +
    `&prop=text&format=json&redirects=1`;
  try {
    const raw = await fetchText(api);
    const json = JSON.parse(raw);
    const html = json?.parse?.text?.['*'] || '';
    if (!html) {
      return {
        stories: [],
        errors: [`Wikipedia: empty parse for ${page}`],
        sources: [{ name: 'Wikipedia', ok: false, error: 'empty' }]
      };
    }
    const monthName = new Date().toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
    const monthRe = new RegExp(
      `<h2[^>]*>\\s*(?:<span[^>]*>)?${monthName}(?:</span>)?\\s*</h2>([\\s\\S]*?)(?=<h2|$)`,
      'i'
    );
    const monthMatch = html.match(monthRe);
    const sectionHtml = monthMatch ? monthMatch[1] : html;
    const lis = sectionHtml.match(/<li[\s>][\s\S]*?<\/li>/gi) || [];
    const stories = [];
    const notable =
      /\b(actor|actress|singer|musician|rapper|comedian|athlete|footballer|baseball|basketball|hockey|olympic|coach|politician|senator|congress|president|governor|minister|mayor|journalist|author|director|producer|playwright|artist|influencer|celebrity|broadcaster|television|film|hollywood|nascar|wrestler|boxer|ufc)\b/i;
    for (const li of lis.slice(0, 120)) {
      const text = stripHtml(li);
      if (!text || text.length < 8) continue;
      const nameMatch = text.match(/^([^,.(]{2,80})/);
      const name = nameMatch ? nameMatch[1].trim() : '';
      if (!name || /^(retrieved|references|external)/i.test(name)) continue;
      if (!notable.test(text)) continue;
      const title = `${name} — listed on Wikipedia deaths ${year}`;
      const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(page.replace(/ /g, '_'))}`;
      stories.push({
        id: storyId(title, name),
        title: title.slice(0, 220),
        url,
        source: 'Wikipedia',
        category: inferCategory(text, 'Celebrity'),
        publishedAt: new Date().toISOString(),
        snippet: text.slice(0, 280),
        origin: 'wikipedia',
        personName: name
      });
      if (stories.length >= 18) break;
    }
    return {
      stories,
      errors: [],
      sources: [{ name: 'Wikipedia', ok: true, count: stories.length, page }]
    };
  } catch (err) {
    return {
      stories: [],
      errors: [`Wikipedia: ${err.message}`],
      sources: [{ name: 'Wikipedia', ok: false, error: err.message }]
    };
  }
}

function collectWatchNames(pools) {
  const names = [];
  for (const fig of listFigures()) {
    names.push({ name: fig.name, key: fig.name.toLowerCase(), kind: 'figure', figureId: fig.id });
  }
  for (const pool of pools || []) {
    if (pool.status === 'ended') continue;
    for (const nom of pool.noms || []) {
      if (!nom?.name) continue;
      if (nom.status === 'unsold') continue;
      names.push({
        name: nom.name,
        key: String(nom.name).toLowerCase(),
        kind: 'nomination',
        poolId: pool.id,
        poolName: pool.name,
        nomId: nom.id,
        ownerName: nom.ownerName || null,
        status: nom.status
      });
    }
  }
  names.sort((a, b) => b.key.length - a.key.length);
  return names;
}

function matchStory(story, watchNames) {
  const hay = `${story.title} ${story.snippet || ''} ${story.personName || ''}`.toLowerCase();
  const matchedNames = [];
  const poolHits = [];
  const seen = new Set();
  for (const entry of watchNames) {
    if (!entry.key || entry.key.length < 4) continue;
    if (!hay.includes(entry.key)) continue;
    if (!seen.has(entry.key)) {
      matchedNames.push(entry.name);
      seen.add(entry.key);
    }
    if (entry.kind === 'nomination') {
      poolHits.push({
        poolId: entry.poolId,
        poolName: entry.poolName,
        nomId: entry.nomId,
        nomName: entry.name,
        ownerName: entry.ownerName,
        status: entry.status
      });
    }
  }
  return { matchedNames, poolHits };
}

function mergeStories(existing, incoming) {
  const map = new Map();
  for (const s of existing || []) {
    if (s?.id) map.set(s.id, s);
  }
  for (const s of incoming || []) {
    if (!s?.id) continue;
    const prev = map.get(s.id);
    map.set(
      s.id,
      prev
        ? {
            ...prev,
            ...s,
            matchedNames: s.matchedNames || prev.matchedNames,
            poolHits: s.poolHits || prev.poolHits
          }
        : s
    );
  }
  return [...map.values()]
    .sort((a, b) => {
      const hit = (b.poolHits?.length || 0) - (a.poolHits?.length || 0);
      if (hit) return hit;
      // Prefer fresh Google News headlines over bulk Wikipedia listings.
      const originRank = (s) => (s.origin === 'google-news' ? 0 : 1);
      const o = originRank(a) - originRank(b);
      if (o) return o;
      return Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0);
    })
    .slice(0, MAX_STORIES);
}

async function runDeathNewsScan({ force = false } = {}) {
  if (scanLock) return scanLock;
  scanLock = (async () => {
    const store = readStore();
    const last = Date.parse(store.newsWatch?.lastScanAt || '');
    if (!force && Number.isFinite(last) && Date.now() - last < SCAN_STALE_MS) {
      return {
        ok: true,
        skipped: true,
        reason: 'recent_scan',
        newsWatch: publicNewsWatch(store)
      };
    }

    const [google, wiki] = await Promise.all([fetchGoogleNews(), fetchWikipediaDeaths()]);
    const watchNames = collectWatchNames(store.pools);
    const stamped = [...google.stories, ...wiki.stories].map((story) => {
      const { matchedNames, poolHits } = matchStory(story, watchNames);
      return { ...story, matchedNames, poolHits, scannedAt: new Date().toISOString() };
    });

    // Preserve pools when rewriting the shared death-pool.json file.
    const fresh = readStore();
    fresh.newsWatch = {
      lastScanAt: new Date().toISOString(),
      stories: mergeStories(fresh.newsWatch?.stories || [], stamped),
      errors: [...(google.errors || []), ...(wiki.errors || [])].slice(0, 12),
      sources: [...(google.sources || []), ...(wiki.sources || [])]
    };
    writeStore(fresh);

    return {
      ok: true,
      skipped: false,
      added: stamped.length,
      newsWatch: publicNewsWatch(fresh),
      poolHitCount: stamped.reduce((n, s) => n + (s.poolHits?.length || 0), 0)
    };
  })();

  try {
    return await scanLock;
  } finally {
    scanLock = null;
  }
}

function publicNewsWatch(storeOrWatch) {
  const watch =
    storeOrWatch?.newsWatch && typeof storeOrWatch.newsWatch === 'object'
      ? storeOrWatch.newsWatch
      : storeOrWatch && Array.isArray(storeOrWatch.stories)
        ? storeOrWatch
        : readStore().newsWatch;
  const last = watch.lastScanAt || null;
  const lastMs = Date.parse(last || '');
  const stale = !Number.isFinite(lastMs) || Date.now() - lastMs >= SCAN_STALE_MS;
  return {
    lastScanAt: last,
    stale,
    storyCount: (watch.stories || []).length,
    stories: (watch.stories || []).slice(0, MAX_STORIES),
    errors: watch.errors || [],
    sources: watch.sources || []
  };
}

async function getNewsWatch({ refreshIfStale = true } = {}) {
  const store = readStore();
  const watch = publicNewsWatch(store);
  if (refreshIfStale && watch.stale) {
    try {
      const result = await runDeathNewsScan({ force: false });
      return result.newsWatch || publicNewsWatch(readStore());
    } catch (err) {
      return { ...watch, errors: [...(watch.errors || []), err.message] };
    }
  }
  return watch;
}

module.exports = {
  runDeathNewsScan,
  getNewsWatch,
  publicNewsWatch,
  SCAN_STALE_MS
};
