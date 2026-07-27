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
    notes: 'Prize pool is $2,400 from all 24 franchises at $100 buy-in. Conference championship runners-up earn $200 each. Week 16 third-place game winners earn $100 each. Season points champions (most points) earn $150 each. Conference champions meet in Week 17’s GridIron Bowl for the top two prizes.',
    prizes: [
      { place: 1, label: 'Winner — GridIron 24 Champion', amount: 1000 },
      { place: 2, label: 'Runner-Up — GridIron Bowl', amount: 500 },
      { place: 3, label: 'Detail Conference 2nd Place', amount: 200 },
      { place: 4, label: 'Overtime Conference 2nd Place', amount: 200 },
      { place: 5, label: 'Detail Third Place', amount: 100 },
      { place: 6, label: 'Overtime Third Place', amount: 100 },
      { place: 7, label: 'Detail Most Points', amount: 150 },
      { place: 8, label: 'Overtime Most Points', amount: 150 }
    ]
  }
};
