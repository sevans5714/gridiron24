/**
 * First-login welcome inbox message.
 *
 * Sent automatically the first time an approved user signs in.
 * Copy varies by membership: gridiron | aaa | social.
 */

const fromName = 'GridIron 24 HQ';

function bodyFor(name = 'Member', opts = {}) {
  const who = String(name || 'Member').trim() || 'Member';
  const membership = String(opts.kind || 'gridiron').toLowerCase();

  let overrideBody = '';
  if (opts.allowOverride !== false) {
    try {
      const copy = require('./comms-settings-store').getCopy('inbox.welcome', { variant: membership });
      if (copy?.body) {
        overrideBody = String(copy.body).replace(/\{\{who\}\}/g, who);
      }
    } catch {
      /* defaults below */
    }
  }
  if (overrideBody.trim()) return overrideBody;

  if (membership === 'social') {
    return [
      `Hey ${who} —`,
      '',
      'Welcome to the GridIron 24 Members Lounge. You’re in as a Social Member.',
      '',
      'WHAT’S INSIDE',
      '• Live Scoreboard — NFL slate plus GridIron 24 & AAA fantasy boards',
      '• Record Book — franchise records, streaks, and historical seasons',
      '• Mock Draft — snake practice with pick clock and targets',
      '• Casala’s Palace — paper sportsbook lines, futures, and standings',
      '• League Pools — pick’em, squares, survivor, auctions, sweeps, and more',
      '• Roll Call — lounge chat and who’s online',
      '• Treasurer Desk — dues and payments',
      '• Membership Roll — see who’s in the lounge',
      '',
      'This account is lounge access — not a fantasy franchise. An owner can promote you later.',
      '',
      'See you in Roll Call.',
      '',
      '— GridIron 24 HQ'
    ].join('\n');
  }

  if (membership === 'aaa') {
    return [
      `Hey ${who} —`,
      '',
      'You are in. Welcome to AAA League under the GridIron 24 roof.',
      '',
      'WHAT YOU CAN DO',
      '• AAA HQ — standings, roster, schedule, and league desk',
      '• Members Lounge — sports board, Roll Call, dues (shared with GridIron 24)',
      '• Inbox — votes, mentions, and HQ messages',
      '',
      'PRO MOVES',
      '• Claim or check your AAA franchise under the league tools / My Roster flow',
      '• Set Day / Night theme from your profile',
      '',
      'Own the week.',
      '',
      '— GridIron 24 HQ'
    ].join('\n');
  }

  return [
    `Hey ${who} —`,
    '',
    'You are in. Welcome to GridIron 24 HQ.',
    '',
    'WHAT YOU CAN DO',
    '• Scoreboard — live fantasy matchups and the NFL slate',
    '• League — standings, My Roster, Team Rosters, draft, schedules',
    '• Members Lounge — Record Book (franchise records & historical seasons), Mock Draft, Sportsbook, Roll Call, dues',
    '• Playoffs — Bowl, Mayor\'s Cup, and the road to the title',
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

function subjectFor(kind = 'gridiron', { allowOverride = true } = {}) {
  const membership = String(kind || 'gridiron').toLowerCase();
  if (allowOverride) {
    try {
      const copy = require('./comms-settings-store').getCopy('inbox.welcome', { variant: membership });
      if (copy?.subject?.trim()) return String(copy.subject).trim();
    } catch {
      /* defaults */
    }
  }
  if (membership === 'social') return 'Welcome to the Members Lounge';
  if (membership === 'aaa') return 'Welcome to AAA League';
  return 'Welcome to GridIron 24';
}

function buildWelcome({ name, kind } = {}) {
  const membershipKind = String(kind || 'gridiron').toLowerCase();
  return {
    subject: subjectFor(membershipKind),
    fromName,
    body: bodyFor(name, { kind: membershipKind }),
    type: 'welcome',
    membershipKind
  };
}

module.exports = {
  fromName,
  bodyFor,
  subjectFor,
  buildWelcome
};
