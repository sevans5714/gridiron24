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
  // Set real dollar amounts when ready — null shows as TBD on the site.
  payouts: {
    seasonLabel: '2026 Inaugural Season',
    buyInPerTeam: null,
    teamCount: 24,
    currency: 'USD',
    notes: 'Prize pool is funded by entry fees from all 24 franchises. Amounts update once buy-in is finalized.',
    prizes: [
      { place: 1, label: 'GridIron Bowl Champion', amount: null },
      { place: 2, label: 'GridIron Bowl Runner-Up', amount: null },
      { place: 3, label: 'Detail Conference Champion', amount: null },
      { place: 4, label: 'Overtime Conference Champion', amount: null },
      { place: 5, label: 'Detail Regular Season Champion', amount: null },
      { place: 6, label: 'Overtime Regular Season Champion', amount: null }
    ]
  }
};
