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
    notes: 'Prize pool is $2,400 from all 24 franchises at $100 buy-in. Each conference championship runner-up earns $200. In Week 16, each conference’s semifinal losers play a third-place game — the winner gets their $100 buy-in back. Conference champions meet in Week 17’s GridIron Bowl for the top two prizes.',
    prizes: [
      { place: 1, label: 'GridIron 24 Champion', amount: 1200 },
      { place: 2, label: 'GridIron Bowl Runner-Up', amount: 500 },
      { place: 3, label: 'Detail Conference 2nd Place', amount: 200 },
      { place: 4, label: 'Overtime Conference 2nd Place', amount: 200 },
      { place: 5, label: 'Detail Third Place Game Winner (buy-in refund)', amount: 100 },
      { place: 6, label: 'Overtime Third Place Game Winner (buy-in refund)', amount: 100 },
      { place: 7, label: 'Detail Regular-Season Champion', amount: 150 },
      { place: 8, label: 'Overtime Regular-Season Champion', amount: 150 },
      { place: 9, label: 'Detail Points Champion', amount: 100 },
      { place: 10, label: 'Overtime Points Champion', amount: 100 }
    ]
  }
};
