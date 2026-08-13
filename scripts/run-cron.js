#!/usr/bin/env node
/**
 * Render cron runner.
 *
 * POSTs an app cron endpoint and exits 0 unless the job actually failed.
 * Expected skips (HTTP 409, or JSON skipped:true) are success so Render
 * does not email "service crashed" for "week has no scores yet" and similar.
 *
 * Usage: node scripts/run-cron.js /api/cron/weekly-wrap
 */
'use strict';

const pathArg = process.argv[2];
if (!pathArg) {
  console.error('usage: node scripts/run-cron.js /api/cron/...');
  process.exit(1);
}

const secret = String(process.env.CRON_SECRET || '').trim();
if (!secret) {
  console.error('CRON_SECRET missing');
  process.exit(1);
}

const base = String(process.env.APP_BASE_URL || 'https://www.gridiron24.com').replace(/\/$/, '');
const path = pathArg.startsWith('/') ? pathArg : `/${pathArg}`;
const url = `${base}${path}`;
const timeoutMs = Number(process.env.CRON_TIMEOUT_MS || 90_000);
const retries = Math.max(0, Number(process.env.CRON_RETRIES || 1));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isExpectedSkip(status, body) {
  if (status === 409) return true;
  if (status < 200 || status >= 300) return false;
  try {
    const json = JSON.parse(body);
    return Boolean(json && json.skipped);
  } catch {
    return false;
  }
}

function isSuccess(status, body) {
  if (status >= 200 && status < 300) return true;
  return isExpectedSkip(status, body);
}

function isRetryable(status, err) {
  if (err) {
    const msg = String(err.cause?.code || err.code || err.message || err);
    return /abort|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|UND_ERR|502|503|504/i.test(msg);
  }
  return status === 502 || status === 503 || status === 504;
}

async function once() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}` },
      signal: ac.signal
    });
    const text = await res.text();
    console.log(res.status, text.slice(0, 800));
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { status, text } = await once();
      if (isSuccess(status, text)) process.exit(0);
      if (isRetryable(status) && attempt < retries) {
        console.warn(`[run-cron] retry ${attempt + 1} after HTTP ${status}`);
        await sleep(5000);
        continue;
      }
      process.exit(1);
    } catch (err) {
      lastErr = err;
      console.error('[run-cron]', err.message || err);
      if (isRetryable(null, err) && attempt < retries) {
        console.warn(`[run-cron] retry ${attempt + 1} after error`);
        await sleep(5000);
        continue;
      }
      process.exit(1);
    }
  }
  if (lastErr) console.error('[run-cron]', lastErr.message || lastErr);
  process.exit(1);
})();
