/**
 * First-login welcome inbox message.
 *
 * Sent automatically the first time an approved user signs in.
 * Edit `subject` / `bodyFor` anytime — the next first-time login gets the new copy.
 * Welcome messages dismiss (delete) when the member marks them read.
 */

const subject = 'Welcome to GridIron 24 HQ';

const fromName = 'GridIron 24 HQ';

/**
 * Structured welcome — fun, clear, scannable.
 * Keep blank lines; the inbox turns newlines into line breaks.
 */
function bodyFor(name = 'Member') {
  const who = String(name || 'Member').trim() || 'Member';
  return [
    `Hey ${who} —`,
    '',
    'You are IN.',
    '',
    'Welcome to GridIron 24 HQ: the home base for GridIron 24, AAA, and every conference under this roof. Lace up. The season (and the trash talk) starts here.',
    '',
    'WHAT YOU CAN DO',
    '• Scoreboard — live fantasy matchups + the NFL slate',
    '• League — standings, My Roster, Team Rosters, draft, history, schedules',
    '• Playoffs — Bowl, Mayor\'s Cup, and the road to the title',
    '• Members Lounge — multi-sport board, Roll Call Room chat, dues',
    '• Rule Book — the law of the land (and Rule Change Proposals when open)',
    '• Inbox (you are here) — votes, mentions, and HQ messages',
    '',
    'PRO MOVES',
    '• Claim / check your team under League → My Roster',
    '• Flip Day / Night theme from your profile',
    '• Watch the Wire ticker for league news',
    '',
    'This is your league. Own the week.',
    '',
    '— GridIron 24 HQ'
  ].join('\n');
}

function buildWelcome({ name } = {}) {
  return {
    subject,
    fromName,
    body: bodyFor(name),
    type: 'welcome'
  };
}

module.exports = {
  subject,
  fromName,
  bodyFor,
  buildWelcome
};
