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
    notes: 'Prize pool is $2,400 from all 24 franchises at $100 buy-in. Conference championship losers are paid; conference winners advance to the GridIron Bowl for the top two prizes.',
    prizes: [
      { place: 1, label: 'GridIron 24 Champion', amount: 1000 },
      { place: 2, label: 'GridIron Bowl Runner-Up', amount: 500 },
      { place: 3, label: 'Detail Conference Championship Loser', amount: 200 },
      { place: 4, label: 'Overtime Conference Championship Loser', amount: 200 },
      { place: 5, label: 'Detail Regular-Season Champion', amount: 150 },
      { place: 6, label: 'Overtime Regular-Season Champion', amount: 150 },
      { place: 7, label: 'Detail Points Champion', amount: 100 },
      { place: 8, label: 'Overtime Points Champion', amount: 100 }
    ]
  }
};
