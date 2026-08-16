/**
 * Little League World Series display names + marks.
 * ESPN/littleleague.org often ship 2–3 letter region codes and empty logos.
 */

const ESPN_COUNTRY = (code) =>
  `https://a.espncdn.com/i/teamlogos/countries/500/${code}.png`;
const US_STATE_FLAG = (st) =>
  `https://flagcdn.com/w80/us-${String(st).toLowerCase()}.png`;
const ISO_FLAG = (cc) =>
  `https://flagcdn.com/w80/${String(cc).toLowerCase()}.png`;

const USA_FLAG = ESPN_COUNTRY('usa');

const US_STATES = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  DC: 'District of Columbia'
};

const STATE_BY_NAME = Object.fromEntries(
  Object.entries(US_STATES).map(([code, name]) => [name.toLowerCase(), code])
);

/** ISO / ESPN country tokens that show up on LLWS scoreboards. */
const COUNTRIES = {
  AUS: { name: 'Australia', logo: ESPN_COUNTRY('AUS') },
  CAN: { name: 'Canada', logo: ESPN_COUNTRY('CAN') },
  CUB: { name: 'Cuba', logo: ESPN_COUNTRY('CUB') },
  CUW: { name: 'Curaçao', logo: ISO_FLAG('cw') },
  CW: { name: 'Curaçao', logo: ISO_FLAG('cw') },
  CZE: { name: 'Czechia', logo: ESPN_COUNTRY('CZE') },
  DOM: { name: 'Dominican Republic', logo: ESPN_COUNTRY('DOM') },
  ITA: { name: 'Italy', logo: ESPN_COUNTRY('ITA') },
  JPN: { name: 'Japan', logo: ESPN_COUNTRY('JPN') },
  KOR: { name: 'South Korea', logo: ESPN_COUNTRY('KOR') },
  MEX: { name: 'Mexico', logo: ESPN_COUNTRY('MEX') },
  NCA: { name: 'Nicaragua', logo: ESPN_COUNTRY('NCA') },
  NED: { name: 'Netherlands', logo: ESPN_COUNTRY('NED') },
  NLD: { name: 'Netherlands', logo: ESPN_COUNTRY('NLD') },
  PAN: { name: 'Panama', logo: ESPN_COUNTRY('PAN') },
  PUR: { name: 'Puerto Rico', logo: ESPN_COUNTRY('PUR') },
  TPE: { name: 'Chinese Taipei', logo: ESPN_COUNTRY('TPE') },
  TWN: { name: 'Chinese Taipei', logo: ESPN_COUNTRY('TPE') },
  USA: { name: 'United States', logo: USA_FLAG },
  US: { name: 'United States', logo: USA_FLAG }
};

/**
 * Official LLWS region codes (not USPS). MA here is Mid-Atlantic, not Massachusetts.
 * Resolved only when the team name looks like a region, not a city + state.
 */
const REGIONS = {
  AP: { label: 'Asia-Pacific', logo: null, fill: '#d3c89f', stroke: '#005039' },
  ATL: { label: 'Atlantic', logo: null, fill: '#1bbfdd', stroke: '#1bbfdd' },
  AUS: { label: 'Australia', logo: COUNTRIES.AUS.logo, fill: '#000000', stroke: '#00549e' },
  CAN: { label: 'Canada', logo: COUNTRIES.CAN.logo, fill: '#dc1e35', stroke: '#000000' },
  CB: { label: 'Caribbean', logo: null, fill: '#0793cf', stroke: '#000000' },
  CUW: { label: 'Curaçao', logo: COUNTRIES.CUW.logo, fill: '#2c3248', stroke: '#e8a200' },
  EA: { label: 'Europe-Africa', logo: null, fill: '#1d1160', stroke: '#008c99' },
  GL: { label: 'Great Lakes', logo: null, fill: '#2e3e7c', stroke: '#ef4523' },
  JPN: { label: 'Japan', logo: COUNTRIES.JPN.logo, fill: '#9493a2', stroke: '#dc1e35' },
  LA: { label: 'Latin America', logo: null, fill: '#008c99', stroke: '#ef4523' },
  MA: { label: 'Mid-Atlantic', logo: null, fill: '#002d62', stroke: '#dc1e35' },
  MEX: { label: 'Mexico', logo: COUNTRIES.MEX.logo, fill: '#04703c', stroke: '#dc1e35' },
  MTN: { label: 'Mountain', logo: null, fill: '#b8ac82', stroke: '#dc1d35' },
  MTR: { label: 'Metro', logo: null, fill: '#000000', stroke: '#ef4523' },
  MW: { label: 'Midwest', logo: null, fill: '#005039', stroke: '#e8a200' },
  NE: { label: 'New England', logo: null, fill: '#860038', stroke: '#79bde8' },
  NW: { label: 'Northwest', logo: null, fill: '#04703c', stroke: '#002d62' },
  PAN: { label: 'Panama', logo: COUNTRIES.PAN.logo, fill: '#79bde8', stroke: '#dc1e35' },
  SE: { label: 'Southeast', logo: null, fill: '#ffc628', stroke: '#000000' },
  SW: { label: 'Southwest', logo: null, fill: '#ef4523', stroke: '#ffc628' },
  W: { label: 'West', logo: null, fill: '#79bde8', stroke: '#ffc628' }
};

const REGION_BY_NAME = Object.fromEntries(
  Object.values(REGIONS).map((r) => [r.label.toLowerCase(), r])
);

function hexLuminance(hex) {
  const h = String(hex || '').replace('#', '').trim();
  if (h.length < 6) return 0;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (![r, g, b].every(Number.isFinite)) return 0;
  return (r * 299 + g * 587 + b * 114) / 1000;
}

function shieldLogo(text, fill = '#12345a', stroke = '#f0c14a') {
  const label = String(text || '?')
    .slice(0, 3)
    .toUpperCase()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const size = label.length > 2 ? 18 : 22;
  const fg = hexLuminance(fill) > 165 ? '#111111' : '#ffffff';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="2" y="2" width="60" height="60" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="4"/><text x="32" y="41" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="${size}" font-weight="700" fill="${fg}">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function isGenericUsaFlag(url) {
  return /\/countries\/500\/usa\.png/i.test(String(url || ''));
}

function isUsableLogo(url) {
  const s = String(url || '').trim();
  if (!s) return false;
  if (s.startsWith('data:image/')) return true;
  return /^https?:\/\//i.test(s);
}

function titleCase(s) {
  return String(s || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function looksLikeRegionName(text) {
  const s = String(text || '').trim();
  if (/\bRegion\b/i.test(s)) return true;
  const core = s.replace(/\s+Region$/i, '').trim().toLowerCase();
  return Boolean(REGION_BY_NAME[core]);
}

function parseCityAndCode(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw || /^tba$/i.test(raw)) return null;

  const comma = raw.match(/^(.+?),\s*([A-Za-z .'-]+)$/);
  if (comma) {
    const city = comma[1].trim();
    const place = comma[2].trim();
    const stateCode = STATE_BY_NAME[place.toLowerCase()];
    if (stateCode) {
      return {
        city,
        code: stateCode,
        kind: 'state',
        fullName: `${city}, ${US_STATES[stateCode]}`
      };
    }
    const country = Object.values(COUNTRIES).find((c) => c.name.toLowerCase() === place.toLowerCase());
    if (country) {
      return { city, kind: 'country', logo: country.logo, fullName: `${city}, ${country.name}` };
    }
  }

  const trail = raw.match(/^(.+?)\s+([A-Z]{2,3})$/);
  if (trail && !looksLikeRegionName(raw)) {
    const city = trail[1].trim();
    const code = trail[2];
    if (COUNTRIES[code]) {
      return {
        city,
        code,
        kind: 'country',
        logo: COUNTRIES[code].logo,
        fullName: `${city}, ${COUNTRIES[code].name}`
      };
    }
    if (US_STATES[code] && city.length > 2) {
      return {
        city,
        code,
        kind: 'state',
        fullName: `${city}, ${US_STATES[code]}`
      };
    }
  }

  const regionName = raw.replace(/\s+Region$/i, '').trim();
  const region = REGION_BY_NAME[regionName.toLowerCase()];
  if (region || looksLikeRegionName(raw)) {
    const info = region || REGION_BY_NAME[regionName.toLowerCase()];
    if (info) {
      return {
        city: info.label,
        kind: 'region',
        logo: info.logo,
        fill: info.fill,
        stroke: info.stroke,
        fullName: `${info.label} Region`
      };
    }
  }

  return null;
}

function regionFromAbbr(abbr) {
  const code = String(abbr || '').trim().toUpperCase();
  return REGIONS[code] || COUNTRIES[code] && {
    label: COUNTRIES[code].name,
    logo: COUNTRIES[code].logo
  } || null;
}

function enrichLlwsTeam(team) {
  if (!team) return team;
  const name = String(team.name || team.shortName || '').trim();
  const abbr = String(team.abbreviation || '').trim();
  const parsed = parseCityAndCode(name) || parseCityAndCode(team.shortName) || null;
  const region = looksLikeRegionName(name) || !parsed
    ? regionFromAbbr(abbr)
    : null;

  let label = null;
  let fullName = name || abbr || 'TBD';
  let logo = isUsableLogo(team.logo) ? team.logo : null;
  let fill = team.markFill || null;
  let stroke = team.markStroke || null;

  if (parsed) {
    label = parsed.city;
    fullName = parsed.fullName || fullName;
    if (parsed.kind === 'state') {
      logo = US_STATE_FLAG(parsed.code);
    } else if (parsed.logo) {
      logo = parsed.logo;
    }
    fill = parsed.fill || fill;
    stroke = parsed.stroke || stroke;
  } else if (region) {
    label = region.label || label;
    fullName = region.label ? `${region.label}${/region/i.test(fullName) ? '' : ' Region'}` : fullName;
    if (!/region/i.test(fullName) && region.label) fullName = `${region.label} Region`;
    if (region.logo) logo = region.logo;
    fill = region.fill || fill;
    stroke = region.stroke || stroke;
  } else if (COUNTRIES[abbr.toUpperCase()] && (!name || name === abbr)) {
    const c = COUNTRIES[abbr.toUpperCase()];
    label = c.name;
    fullName = c.name;
    logo = logo && !isGenericUsaFlag(logo) ? logo : c.logo;
  } else if (name && name.length > 3 && name.toUpperCase() !== abbr.toUpperCase()) {
    label = name.replace(/\s+Region$/i, '').trim();
    fullName = name;
  } else if (abbr.length > 3) {
    label = titleCase(abbr);
  }

  if (isGenericUsaFlag(logo) && parsed?.kind === 'state') {
    logo = US_STATE_FLAG(parsed.code);
  }

  if (!label || label.length <= 3) {
    label = (parsed && parsed.city) || (region && region.label) || name.replace(/\s+Region$/i, '').trim() || abbr || 'TBD';
  }

  if (!isUsableLogo(logo) || (isGenericUsaFlag(logo) && parsed?.kind !== 'state' && region && !region.logo)) {
    const mark = String(abbr || label).slice(0, 3);
    logo = shieldLogo(mark, fill || '#12345a', stroke || '#f0c14a');
  }

  return {
    ...team,
    abbreviation: label,
    shortName: label,
    name: fullName,
    logo
  };
}

function enrichLlwsGame(game) {
  if (!game || (game.league && game.league !== 'llws')) return game;
  const away = enrichLlwsTeam(game.away);
  const home = enrichLlwsTeam(game.home);
  return {
    ...game,
    away,
    home,
    name: away && home ? `${away.name} at ${home.name}` : game.name,
    shortName: away && home
      ? `${away.abbreviation} @ ${home.abbreviation}`
      : game.shortName
  };
}

function mergeLlwsSide(prev, next) {
  if (!prev) return next || null;
  if (!next) return prev;
  const pickText = (a, b) => {
    const x = String(a || '').trim();
    const y = String(b || '').trim();
    if (!x) return y;
    if (!y) return x;
    if (x.length <= 3 && y.length > 3) return y;
    if (y.length <= 3 && x.length > 3) return x;
    return x.length >= y.length ? x : y;
  };
  return {
    ...prev,
    ...next,
    id: next.id || prev.id || null,
    abbreviation: pickText(next.abbreviation, prev.abbreviation),
    name: pickText(next.name, prev.name),
    shortName: pickText(next.shortName, prev.shortName),
    logo: next.logo || prev.logo || null,
    score: next.score != null ? next.score : prev.score,
    record: next.record || prev.record || null,
    winner: Boolean(next.winner || prev.winner),
    markFill: next.markFill || prev.markFill || null,
    markStroke: next.markStroke || prev.markStroke || null
  };
}

module.exports = {
  enrichLlwsTeam,
  enrichLlwsGame,
  mergeLlwsSide
};
