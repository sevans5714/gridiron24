/**
 * Run scheduled jobs inside the web process.
 *
 * Render cron services email "Exited with status 1" whenever the job process
 * fails (401, ESPN timeout, mail error). The web service already stays up;
 * running the same UTC schedules here keeps work going without crash mail.
 */
'use strict';

function utcParts(d) {
  return {
    day: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes()
  };
}

function slotKey(name, d) {
  return `${name}:${d.toISOString().slice(0, 16)}`;
}

function jobDue(job, d) {
  const { day, hour, minute } = utcParts(d);
  if (Array.isArray(job.days) && !job.days.includes(day)) return false;
  if (Array.isArray(job.hours) && !job.hours.includes(hour)) return false;
  if (job.everyMinutes) return minute % job.everyMinutes === 0;
  return (job.hour ?? 0) === hour && (job.minute ?? 0) === minute;
}

function startInProcessCrons(jobs, { log = console, intervalMs = 20_000 } = {}) {
  const ran = new Set();

  function prune() {
    if (ran.size <= 120) return;
    const keep = [...ran].slice(-40);
    ran.clear();
    for (const key of keep) ran.add(key);
  }

  function tick() {
    const now = new Date();
    for (const job of jobs) {
      if (!job || !job.name || typeof job.run !== 'function') continue;
      if (!jobDue(job, now)) continue;
      const key = slotKey(job.name, now);
      if (ran.has(key)) continue;
      ran.add(key);
      Promise.resolve()
        .then(() => job.run())
        .then((result) => {
          const note = result && result.skipped
            ? `skipped:${result.reason || 'yes'}`
            : (result && result.ok === false ? (result.error || 'not-ok') : 'ok');
          log.log(`[cron:${job.name}] ${note}`);
        })
        .catch((err) => {
          log.warn(`[cron:${job.name}] failed`, err.message || err);
        });
    }
    prune();
  }

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

module.exports = { jobDue, startInProcessCrons };
