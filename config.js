module.exports = {
  season: 2026,
  brand: {
    name: 'GridIron 24',
    tagline: '24 Teams. Two Conferences. One Champion.'
  },
  conferences: [
    {
      key: 'detail',
      name: 'Detail Conference',
      shortName: 'DETAIL',
      espnLeagueId: 559054421,
      logo: '/assets/detail-conference.png'
    },
    {
      key: 'overtime',
      name: 'Overtime Conference',
      shortName: 'OVERTIME',
      espnLeagueId: 236438046,
      logo: '/assets/overtime-conference.png'
    }
  ],
  payouts: {
    seasonLabel: '2026 Inaugural Season',
    buyInPerTeam: 100,
    teamCount: 24,
    currency: 'USD',
    notes: 'Prize pool is $2,400 from all 24 franchises at $100 buy-in. Conference championship runners-up earn $250 each. Week 16 third-place game winners earn $100 each. Season points champions (most points) earn $100 each. Conference champions meet in Week 17’s GridIron Bowl for the top two prizes.',
    prizes: [
      { place: 1, label: 'Winner — GridIron 24 Champion', amount: 1000 },
      { place: 2, label: 'Runner-Up — GridIron Bowl', amount: 500 },
      { place: 3, label: 'Detail Conference 2nd Place', amount: 250 },
      { place: 4, label: 'Overtime Conference 2nd Place', amount: 250 },
      { place: 5, label: 'Detail Third Place', amount: 100 },
      { place: 6, label: 'Overtime Third Place', amount: 100 },
      { place: 7, label: 'Detail Most Points', amount: 100 },
      { place: 8, label: 'Overtime Most Points', amount: 100 }
    ]
  },
  treasurer: {
    name: 'Jamie Aceto',
    email: 'jaceto53@gmail.com',
    venmoUsername: 'James-Aceto',
    note: 'League dues — GridIron 24 HQ'
  },
  // Prior seasons for Teams → History / Draft Results.
  // Prefer League Tools → Season Archive (saved live). Example seed:
  // { season: 2025, yearNumber: 3, espnLeagueId: 1856396051, label: 'Year 3 (2025)' }
  historySeasons: [],
  calendarDefaults: [
    { title: 'Draft Day', type: 'draft', date: '2026-08-24', notes: 'Both conferences draft — confirm time with your commissioner. Single-player keeper rule begins after the 2026 season (Rule Book §3.03–§3.05).' },
    { title: 'Dues Due', type: 'dues', date: '2026-09-01', notes: '$100 buy-in per franchise.' },
    { title: 'Trade Deadline', type: 'deadline', date: '2026-11-18', notes: 'No trades after this date.' },
    { title: 'Conference Playoffs Begin', type: 'event', date: '2026-12-08', notes: 'Week 14 Wild Card round.' },
    { title: 'GridIron Bowl I', type: 'bowl', date: '2026-12-29', notes: 'Week 17 — Detail champ vs Overtime champ.' },
    { title: "Mayor's Cup", type: 'survival', date: '2026-12-29', notes: 'Week 17 — relegated Detail vs relegated Overtime (PF tiebreaker for last place).' },
    { title: 'AAA Super Bowl', type: 'aaa', date: '2026-12-29', notes: 'AAA League championship — ESPN title game. Winner promotes to GridIron 24 next season.' },
    { title: 'Keeper Declarations Due', type: 'deadline', date: '2027-08-17', notes: 'One keeper per franchise. First keep costs the original draft round; each later keep drops one round. Max three seasons with the franchise, then back to the pool.' }
  ],
  survival: {
    enabled: true,
    week: 17,
    name: "Mayor's Cup"
  },
  affiliatedLeagues: [
    {
      key: 'aaa',
      name: 'AAA League',
      shortName: 'AAA',
      espnLeagueId: 529121946,
      role: 'feeder',
      logo: '/assets/aaa-league.png?v=6',
      payouts: {
        seasonLabel: '2026 AAA Season',
        buyInPerTeam: 50,
        teamCountMin: 10,
        teamCountMax: 14,
        teamCount: 12,
        currency: 'USD',
        notes: 'AAA is a separate league with its own league admin, draft, and player pool. Roster size is set by interest (10–14 franchises). Buy-in is $50 per franchise; the prize pool equals $50 × final roster ($500–$700). Award amounts below assume a 12-team field and may be adjusted when the roster locks. Scoring/lineup settings mirror GridIron 24. Champion promotes to GridIron 24 next season (display / commissioner-administered).',
        prizes: [
          { place: 1, label: 'AAA Champion', amount: 300 },
          { place: 2, label: 'AAA Runner-Up', amount: 150 },
          { place: 3, label: 'AAA Third Place', amount: 100 },
          { place: 4, label: 'AAA Most Points', amount: 50 }
        ]
      }
    }
  ]
};
