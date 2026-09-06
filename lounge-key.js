/**
 * Members Lounge rooms are keyed separately from HQ cookies.
 * GridIron 24, AAA, and social accounts share one lounge (`gridiron`).
 * Each independent league gets `independent:{leagueId}`.
 */

function normalizeLoungeKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'gridiron';
  const lower = s.toLowerCase();
  if (lower.startsWith('independent:')) {
    const id = s.slice(s.indexOf(':') + 1).trim();
    return id ? `independent:${id}` : 'gridiron';
  }
  return 'gridiron';
}

function fromScope(scope) {
  if (scope && (scope.scope === 'independent' || scope.platform === 'independent') && scope.leagueId) {
    return `independent:${scope.leagueId}`;
  }
  return 'gridiron';
}

function isIndependent(raw) {
  return normalizeLoungeKey(raw).startsWith('independent:');
}

function independentLeagueId(raw) {
  const key = normalizeLoungeKey(raw);
  if (!key.startsWith('independent:')) return null;
  return key.slice('independent:'.length);
}

function accountStoreId(userId, loungeKey) {
  const uid = String(userId || '').trim();
  const key = normalizeLoungeKey(loungeKey);
  if (!uid) return '';
  return key === 'gridiron' ? uid : `${key}::${uid}`;
}

module.exports = {
  normalizeLoungeKey,
  fromScope,
  isIndependent,
  independentLeagueId,
  accountStoreId
};
