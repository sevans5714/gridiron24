const loungeKey = require('./lounge-key');

const ONLINE_MS = 90_000;
const presence = new Map();

function touch(user, { loungeKey: room = 'gridiron' } = {}) {
  if (!user?.id) return null;
  const entry = {
    id: user.id,
    name: user.name || user.loginName || 'Member',
    loginName: user.loginName || null,
    loungeKey: loungeKey.normalizeLoungeKey(room),
    lastSeen: Date.now()
  };
  presence.set(user.id, entry);
  return publicEntry(entry);
}

function publicEntry(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    name: entry.name,
    loginName: entry.loginName || null,
    lastSeen: new Date(entry.lastSeen).toISOString()
  };
}

function listOnline({ excludeUserId = null, loungeKey: room = null } = {}) {
  const cutoff = Date.now() - ONLINE_MS;
  const want = room != null ? loungeKey.normalizeLoungeKey(room) : null;
  const out = [];
  for (const [id, entry] of presence) {
    if (entry.lastSeen < cutoff) {
      presence.delete(id);
      continue;
    }
    if (excludeUserId && id === excludeUserId) continue;
    if (want && loungeKey.normalizeLoungeKey(entry.loungeKey) !== want) continue;
    out.push(publicEntry(entry));
  }
  out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  return out;
}

function isOnline(userId) {
  const entry = presence.get(userId);
  if (!entry) return false;
  if (Date.now() - entry.lastSeen > ONLINE_MS) {
    presence.delete(userId);
    return false;
  }
  return true;
}

function drop(userId) {
  if (userId) presence.delete(userId);
}

module.exports = {
  touch,
  drop,
  listOnline,
  isOnline,
  ONLINE_MS
};
