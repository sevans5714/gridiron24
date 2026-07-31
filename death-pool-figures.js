/**
 * System seed list (~100) for lounge Death Pool nominations.
 * Public figures across politics, sports, pop culture, and celebrity.
 * Fun/dark-humor game content only — not predictions or real-money gambling.
 */
const FIGURES = [
  // Politics (20)
  { id: 'pol-trump', name: 'Donald Trump', category: 'Politics' },
  { id: 'pol-biden', name: 'Joe Biden', category: 'Politics' },
  { id: 'pol-obama', name: 'Barack Obama', category: 'Politics' },
  { id: 'pol-clinton-h', name: 'Hillary Clinton', category: 'Politics' },
  { id: 'pol-clinton-b', name: 'Bill Clinton', category: 'Politics' },
  { id: 'pol-pelosi', name: 'Nancy Pelosi', category: 'Politics' },
  { id: 'pol-mcconnell', name: 'Mitch McConnell', category: 'Politics' },
  { id: 'pol-schumer', name: 'Chuck Schumer', category: 'Politics' },
  { id: 'pol-aoc', name: 'Alexandria Ocasio-Cortez', category: 'Politics' },
  { id: 'pol-desantis', name: 'Ron DeSantis', category: 'Politics' },
  { id: 'pol-newsom', name: 'Gavin Newsom', category: 'Politics' },
  { id: 'pol-harris', name: 'Kamala Harris', category: 'Politics' },
  { id: 'pol-vance', name: 'JD Vance', category: 'Politics' },
  { id: 'pol-rfk', name: 'RFK Jr.', category: 'Politics' },
  { id: 'pol-putin', name: 'Vladimir Putin', category: 'Politics' },
  { id: 'pol-xi', name: 'Xi Jinping', category: 'Politics' },
  { id: 'pol-king-charles', name: 'King Charles III', category: 'Politics' },
  { id: 'pol-netanyahu', name: 'Benjamin Netanyahu', category: 'Politics' },
  { id: 'pol-modi', name: 'Narendra Modi', category: 'Politics' },
  { id: 'pol-trudeau', name: 'Justin Trudeau', category: 'Politics' },

  // Sports (25)
  { id: 'sp-brady', name: 'Tom Brady', category: 'Sports' },
  { id: 'sp-mahomes', name: 'Patrick Mahomes', category: 'Sports' },
  { id: 'sp-lebron', name: 'LeBron James', category: 'Sports' },
  { id: 'sp-curry', name: 'Stephen Curry', category: 'Sports' },
  { id: 'sp-messi', name: 'Lionel Messi', category: 'Sports' },
  { id: 'sp-ronaldo', name: 'Cristiano Ronaldo', category: 'Sports' },
  { id: 'sp-serena', name: 'Serena Williams', category: 'Sports' },
  { id: 'sp-federer', name: 'Roger Federer', category: 'Sports' },
  { id: 'sp-tiger', name: 'Tiger Woods', category: 'Sports' },
  { id: 'sp-jordan', name: 'Michael Jordan', category: 'Sports' },
  { id: 'sp-shaq', name: 'Shaquille O\'Neal', category: 'Sports' },
  { id: 'sp-barkley', name: 'Charles Barkley', category: 'Sports' },
  { id: 'sp-favre', name: 'Brett Favre', category: 'Sports' },
  { id: 'sp-montana', name: 'Joe Montana', category: 'Sports' },
  { id: 'sp-tyson', name: 'Mike Tyson', category: 'Sports' },
  { id: 'sp-mayweather', name: 'Floyd Mayweather', category: 'Sports' },
  { id: 'sp-gretzky', name: 'Wayne Gretzky', category: 'Sports' },
  { id: 'sp-jeter', name: 'Derek Jeter', category: 'Sports' },
  { id: 'sp-bonds', name: 'Barry Bonds', category: 'Sports' },
  { id: 'sp-ripken', name: 'Cal Ripken Jr.', category: 'Sports' },
  { id: 'sp-mickelson', name: 'Phil Mickelson', category: 'Sports' },
  { id: 'sp-mcgregor', name: 'Conor McGregor', category: 'Sports' },
  { id: 'sp-rodgers', name: 'Aaron Rodgers', category: 'Sports' },
  { id: 'sp-ohtani', name: 'Shohei Ohtani', category: 'Sports' },
  { id: 'sp-giannis', name: 'Giannis Antetokounmpo', category: 'Sports' },

  // Pop culture (30)
  { id: 'pop-swift', name: 'Taylor Swift', category: 'Pop Culture' },
  { id: 'pop-beyonce', name: 'Beyoncé', category: 'Pop Culture' },
  { id: 'pop-drake', name: 'Drake', category: 'Pop Culture' },
  { id: 'pop-kardashian', name: 'Kim Kardashian', category: 'Pop Culture' },
  { id: 'pop-oprah', name: 'Oprah Winfrey', category: 'Pop Culture' },
  { id: 'pop-letterman', name: 'David Letterman', category: 'Pop Culture' },
  { id: 'pop-fallon', name: 'Jimmy Fallon', category: 'Pop Culture' },
  { id: 'pop-kimmel', name: 'Jimmy Kimmel', category: 'Pop Culture' },
  { id: 'pop-colbert', name: 'Stephen Colbert', category: 'Pop Culture' },
  { id: 'pop-stewart', name: 'Jon Stewart', category: 'Pop Culture' },
  { id: 'pop-seinfeld', name: 'Jerry Seinfeld', category: 'Pop Culture' },
  { id: 'pop-murphy', name: 'Eddie Murphy', category: 'Pop Culture' },
  { id: 'pop-sandler', name: 'Adam Sandler', category: 'Pop Culture' },
  { id: 'pop-cruise', name: 'Tom Cruise', category: 'Pop Culture' },
  { id: 'pop-dicaprio', name: 'Leonardo DiCaprio', category: 'Pop Culture' },
  { id: 'pop-pitt', name: 'Brad Pitt', category: 'Pop Culture' },
  { id: 'pop-jolie', name: 'Angelina Jolie', category: 'Pop Culture' },
  { id: 'pop-streep', name: 'Meryl Streep', category: 'Pop Culture' },
  { id: 'pop-deniro', name: 'Robert De Niro', category: 'Pop Culture' },
  { id: 'pop-pacino', name: 'Al Pacino', category: 'Pop Culture' },
  { id: 'pop-eastwood', name: 'Clint Eastwood', category: 'Pop Culture' },
  { id: 'pop-madonna', name: 'Madonna', category: 'Pop Culture' },
  { id: 'pop-springsteen', name: 'Bruce Springsteen', category: 'Pop Culture' },
  { id: 'pop-jagger', name: 'Mick Jagger', category: 'Pop Culture' },
  { id: 'pop-mccartney', name: 'Paul McCartney', category: 'Pop Culture' },
  { id: 'pop-dylan', name: 'Bob Dylan', category: 'Pop Culture' },
  { id: 'pop-elton', name: 'Elton John', category: 'Pop Culture' },
  { id: 'pop-cher', name: 'Cher', category: 'Pop Culture' },
  { id: 'pop-dolly', name: 'Dolly Parton', category: 'Pop Culture' },
  { id: 'pop-musk', name: 'Elon Musk', category: 'Pop Culture' },

  // Celebrity (25)
  { id: 'cel-van-dyke', name: 'Dick Van Dyke', category: 'Celebrity' },
  { id: 'cel-brooks', name: 'Mel Brooks', category: 'Celebrity' },
  { id: 'cel-burnett', name: 'Carol Burnett', category: 'Celebrity' },
  { id: 'cel-shatner', name: 'William Shatner', category: 'Celebrity' },
  { id: 'cel-clooney', name: 'George Clooney', category: 'Celebrity' },
  { id: 'cel-freeman', name: 'Morgan Freeman', category: 'Celebrity' },
  { id: 'cel-denzel', name: 'Denzel Washington', category: 'Celebrity' },
  { id: 'cel-whoopi', name: 'Whoopi Goldberg', category: 'Celebrity' },
  { id: 'cel-jackson', name: 'Samuel L. Jackson', category: 'Celebrity' },
  { id: 'cel-ford', name: 'Harrison Ford', category: 'Celebrity' },
  { id: 'cel-stallone', name: 'Sylvester Stallone', category: 'Celebrity' },
  { id: 'cel-arnold', name: 'Arnold Schwarzenegger', category: 'Celebrity' },
  { id: 'cel-willis', name: 'Bruce Willis', category: 'Celebrity' },
  { id: 'cel-keanu', name: 'Keanu Reeves', category: 'Celebrity' },
  { id: 'cel-fonda', name: 'Jane Fonda', category: 'Celebrity' },
  { id: 'cel-dench', name: 'Judi Dench', category: 'Celebrity' },
  { id: 'cel-mirren', name: 'Helen Mirren', category: 'Celebrity' },
  { id: 'cel-hopkins', name: 'Anthony Hopkins', category: 'Celebrity' },
  { id: 'cel-mckellen', name: 'Ian McKellen', category: 'Celebrity' },
  { id: 'cel-nicholson', name: 'Jack Nicholson', category: 'Celebrity' },
  { id: 'cel-gaga', name: 'Lady Gaga', category: 'Celebrity' },
  { id: 'cel-rihanna', name: 'Rihanna', category: 'Celebrity' },
  { id: 'cel-bieber', name: 'Justin Bieber', category: 'Celebrity' },
  { id: 'cel-kanye', name: 'Kanye West', category: 'Celebrity' },
  { id: 'cel-bezos', name: 'Jeff Bezos', category: 'Celebrity' }
];

function listFigures() {
  return FIGURES.map((f) => ({ ...f }));
}

function findFigure(id) {
  const key = String(id || '').trim();
  return FIGURES.find((f) => f.id === key) || null;
}

module.exports = { listFigures, findFigure, FIGURES };
