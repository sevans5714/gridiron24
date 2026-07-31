/** Static NFL 32 for survivor pool picks. */
const NFL_TEAMS = [
  { abbr: 'ARI', name: 'Arizona Cardinals' },
  { abbr: 'ATL', name: 'Atlanta Falcons' },
  { abbr: 'BAL', name: 'Baltimore Ravens' },
  { abbr: 'BUF', name: 'Buffalo Bills' },
  { abbr: 'CAR', name: 'Carolina Panthers' },
  { abbr: 'CHI', name: 'Chicago Bears' },
  { abbr: 'CIN', name: 'Cincinnati Bengals' },
  { abbr: 'CLE', name: 'Cleveland Browns' },
  { abbr: 'DAL', name: 'Dallas Cowboys' },
  { abbr: 'DEN', name: 'Denver Broncos' },
  { abbr: 'DET', name: 'Detroit Lions' },
  { abbr: 'GB', name: 'Green Bay Packers' },
  { abbr: 'HOU', name: 'Houston Texans' },
  { abbr: 'IND', name: 'Indianapolis Colts' },
  { abbr: 'JAX', name: 'Jacksonville Jaguars' },
  { abbr: 'KC', name: 'Kansas City Chiefs' },
  { abbr: 'LAC', name: 'Los Angeles Chargers' },
  { abbr: 'LAR', name: 'Los Angeles Rams' },
  { abbr: 'LV', name: 'Las Vegas Raiders' },
  { abbr: 'MIA', name: 'Miami Dolphins' },
  { abbr: 'MIN', name: 'Minnesota Vikings' },
  { abbr: 'NE', name: 'New England Patriots' },
  { abbr: 'NO', name: 'New Orleans Saints' },
  { abbr: 'NYG', name: 'New York Giants' },
  { abbr: 'NYJ', name: 'New York Jets' },
  { abbr: 'PHI', name: 'Philadelphia Eagles' },
  { abbr: 'PIT', name: 'Pittsburgh Steelers' },
  { abbr: 'SEA', name: 'Seattle Seahawks' },
  { abbr: 'SF', name: 'San Francisco 49ers' },
  { abbr: 'TB', name: 'Tampa Bay Buccaneers' },
  { abbr: 'TEN', name: 'Tennessee Titans' },
  { abbr: 'WAS', name: 'Washington Commanders' }
];

const BY_ABBR = new Map(NFL_TEAMS.map((t) => [t.abbr, t]));

/** Normalize ESPN / nflverse abbreviations into our set. */
function normalizeAbbr(raw) {
  const a = String(raw || '').trim().toUpperCase();
  if (!a) return null;
  const aliases = {
    WSH: 'WAS',
    WASH: 'WAS',
    LA: 'LAR',
    STL: 'LAR',
    SD: 'LAC',
    OAK: 'LV',
    JAC: 'JAX'
  };
  const key = aliases[a] || a;
  return BY_ABBR.has(key) ? key : null;
}

function teamName(abbr) {
  const key = normalizeAbbr(abbr);
  return key ? BY_ABBR.get(key).name : null;
}

module.exports = {
  NFL_TEAMS,
  normalizeAbbr,
  teamName
};
