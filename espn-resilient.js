/**
 * Resilient ESPN upstream fetches.
 *
 *  1. Try multiple ESPN hosts that serve the same JSON shape
 *  2. Retry once with a short backoff
 *  3. Short TTL memory cache for fresh responses only
 *
 * Never serves expired / last-good snapshots. Callers should use live free
 * fallbacks (see sports-fallbacks.js) when ESPN is down.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 350;

const memory = new Map(); // key -> { at, data, source }
const status = {
  fantasy: { mode: 'unknown', source: null, at: null, error: null },
  site: { mode: 'unknown', source: null, at: null, error: null },
  news: { mode: 'unknown', source: null, at: null, error: null }
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markStatus(lane, patch) {
  status[lane] = {
    ...(status[lane] || {}),
    ...patch,
    at: new Date().toISOString()
  };
}

function getUpstreamStatus() {
  return {
    fantasy: { ...status.fantasy },
    site: { ...status.site },
    news: { ...status.news }
  };
}

/** Build fantasy league endpoint URLs across ESPN hosts (same path/shape). */
function fantasyLeagueUrls(pathnameAndQuery) {
  const pathPart = String(pathnameAndQuery || '').replace(/^\//, '');
  return [
    `https://lm-api-reads.fantasy.espn.com/${pathPart}`,
    `https://fantasy.espn.com/${pathPart}`
  ];
}

/** Build public site API URLs across ESPN hosts (same path/shape). */
function siteApiUrls(pathnameAndQuery) {
  const pathPart = String(pathnameAndQuery || '').replace(/^\//, '');
  return [
    `https://site.api.espn.com/${pathPart}`,
    `https://site.web.api.espn.com/${pathPart}`
  ];
}

async function fetchOnce(url, { headers, timeoutMs, signal } = {}) {
  const controller = new AbortController();
  const outer = signal;
  const onAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: headers || { Accept: 'application/json' },
      signal: controller.signal,
      redirect: 'manual'
    });
    const statusCode = Number(response.status) || 0;
    if (statusCode >= 300 && statusCode < 400) {
      const err = new Error(`Upstream ${statusCode}`);
      err.status = statusCode;
      err.url = url;
      throw err;
    }
    const text = await response.text();
    if (!response.ok) {
      const err = new Error(`Upstream ${response.status}`);
      err.status = response.status;
      err.detail = text.slice(0, 300);
      err.url = url;
      throw err;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const err = new Error('Upstream returned non-JSON');
      err.status = 502;
      err.url = url;
      throw err;
    }
    return { data, source: url };
  } finally {
    clearTimeout(timeout);
    if (outer) outer.removeEventListener('abort', onAbort);
  }
}

/**
 * @param {object} opts
 * @param {string[]} opts.urls
 * @param {string} opts.cacheKey
 * @param {number} [opts.ttlMs=30000]
 * @param {object} [opts.headers]
 * @param {number} [opts.timeoutMs]
 * @param {'fantasy'|'site'|'news'} [opts.lane='site']
 */
async function fetchJsonResilient(opts) {
  const {
    urls,
    cacheKey,
    ttlMs = 30_000,
    headers,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    lane = 'site'
  } = opts;

  const key = String(cacheKey || urls?.[0] || '');
  const existing = memory.get(key);
  if (existing && Date.now() - existing.at < ttlMs) {
    return {
      data: existing.data,
      stale: false,
      source: existing.source,
      fetchedAt: existing.at,
      ageMs: Date.now() - existing.at,
      from: 'memory-fresh'
    };
  }

  const errors = [];
  for (const url of urls || []) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (attempt > 0) await sleep(RETRY_DELAY_MS);
        const hit = await fetchOnce(url, { headers, timeoutMs });
        const entry = {
          at: Date.now(),
          data: hit.data,
          source: hit.source
        };
        memory.set(key, entry);
        markStatus(lane, { mode: 'live', source: hit.source, error: null });
        return {
          data: hit.data,
          stale: false,
          source: hit.source,
          fetchedAt: entry.at,
          ageMs: 0,
          from: 'live'
        };
      } catch (err) {
        errors.push(`${url}#${attempt + 1}: ${err.message || err}`);
        // 401/404 is a league answer (private / deleted), not the fantasy API dying.
        if (err.status === 401 || err.status === 404) {
          throw err;
        }
      }
    }
  }

  if (memory.has(key)) memory.delete(key);

  markStatus(lane, {
    mode: 'down',
    source: null,
    error: errors.slice(-1)[0] || 'upstream failed'
  });
  const err = new Error(errors.slice(-1)[0] || 'All ESPN upstreams failed');
  err.status = 502;
  err.detail = errors.join(' | ').slice(0, 500);
  err.errors = errors;
  throw err;
}

module.exports = {
  fetchJsonResilient,
  fantasyLeagueUrls,
  siteApiUrls,
  getUpstreamStatus
};
