/**
 * First-login welcome inbox message.
 *
 * Sent automatically the first time an approved user signs in.
 * Edit `subject` / `bodyFor` anytime — the next first-time login gets the new copy.
 * Welcome messages dismiss (delete) when the member marks them read.
 */

const subject = 'Welcome to GridIron 24';

const fromName = 'GridIron 24 HQ';

/**
 * Structured welcome — fun, clear, scannable.
 * Section headings (ALL CAPS) and bullets render with branded inbox chrome.
 */
function bodyFor(name = 'Member') {
  const who = String(name || 'Member').trim() || 'Member';
  return [
    `Hey ${who} —`,
    '',
    'You are in. Welcome to GridIron 24 HQ: home of GridIron 24, AAA, and every conference under this roof.',
    '',
    'WHAT YOU CAN DO',
    '• Scoreboard — live fantasy matchups and the NFL slate',
    '• League — standings, My Roster, Team Rosters, draft, history, schedules',
    '• Playoffs — Bowl, Mayor\'s Cup, and the road to the title',
    '• Members Lounge — sports board, Roll Call Room, dues',
    '• Rule Book — the law of the land',
    '• Inbox — votes, mentions, and HQ messages',
    '',
    'PRO MOVES',
    '• Claim or check your team under League → My Roster',
    '• Set Day / Night theme from your profile',
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
