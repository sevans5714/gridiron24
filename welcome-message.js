/**
 * First-login welcome inbox message.
 *
 * Edit `subject` and `body` below anytime — next first-time logins get the new copy.
 * Placeholders in body: {{name}}
 *
 * Preview: GET /api/welcome-message (signed-in), or open Inbox after a fresh login.
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
    '• Playoffs — Bowl, Stay in League, and the road to the title',
    '• Members Lounge — multi-sport board, live chat, buddy list, dues',
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
