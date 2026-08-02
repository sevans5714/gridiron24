/**
 * Registry of every auto-generated communication (email + inbox).
 * Sitewide controls live in comms-settings-store.js.
 */

const CATALOG = [
  {
    id: 'email.invite',
    name: 'Member invite',
    channel: 'email',
    group: 'Onboarding',
    when: 'Staff sends or resends an invite from League Tools → Members.',
    editable: ['subject', 'preheader', 'eyebrow', 'headline', 'bodyLead', 'ctaLabel', 'note'],
    placeholders: ['who', 'league', 'inviteUrl', 'homeUrl', 'homeHost'],
    preview: '/api/invites/preview-email'
  },
  {
    id: 'email.invite_social',
    name: 'Social / lounge invite',
    channel: 'email',
    group: 'Onboarding',
    when: 'Staff sends an invite with “Social accounts” checked.',
    editable: ['subject', 'preheader', 'eyebrow', 'headline', 'bodyLead', 'ctaLabel', 'note'],
    placeholders: ['who', 'league', 'inviteUrl', 'homeUrl', 'homeHost'],
    preview: '/api/invites/preview-email?social=1'
  },
  {
    id: 'email.account_approved',
    name: 'Account approved (welcome email)',
    channel: 'email',
    group: 'Onboarding',
    when: 'Owner approves a join request with membership, or assigns membership later.',
    editable: ['subject', 'preheader', 'eyebrow', 'headline', 'textLine'],
    variants: ['gridiron', 'aaa', 'social'],
    placeholders: ['who', 'league'],
    preview: '/api/mail/preview-approved?kind=gridiron'
  },
  {
    id: 'email.password_reset',
    name: 'Password reset',
    channel: 'email',
    group: 'Account',
    when: 'Member submits Forgot password.',
    editable: ['subject', 'preheader', 'eyebrow', 'headline'],
    preview: '/api/mail/preview-reset'
  },
  {
    id: 'email.pwa_install',
    name: 'PWA install guide',
    channel: 'email',
    group: 'Onboarding',
    when: 'Owner sends install instructions from League Tools → Communications (or Members).',
    editable: ['subject', 'preheader', 'eyebrow', 'headline', 'bodyLead', 'ctaLabel'],
    preview: '/api/mail/preview-pwa-install',
    canDisable: true
  },
  {
    id: 'email.weekly_wrap',
    name: 'Weekly wrap-up',
    channel: 'email',
    group: 'Season',
    when: 'Cron (weekly) or manual Generate & Send in League Tools. Also posts League News.',
    editable: [],
    schedule: 'Render cron · weekly wrap',
    canDisable: true
  },
  {
    id: 'email.rules_sync',
    name: 'Rules sync alert',
    channel: 'email',
    group: 'Ops',
    when: 'Cron or manual Check Rules Sync when Detail/Overtime/AAA scoring drifts.',
    editable: ['subject'],
    schedule: 'Render cron · rules-sync',
    canDisable: true
  },
  {
    id: 'email.roster_violation',
    name: 'Roster violation warning',
    channel: 'email',
    group: 'Ops',
    when: 'Cron or manual Scan & Warn — emailed to the claimed team manager.',
    editable: ['subject'],
    schedule: 'Render cron · roster-violations',
    canDisable: true
  },
  {
    id: 'inbox.welcome',
    name: 'Welcome (first login)',
    channel: 'inbox',
    group: 'Onboarding',
    when: 'First successful sign-in after approval (once per account).',
    editable: ['subject', 'body'],
    variants: ['gridiron', 'aaa', 'social'],
    placeholders: ['who']
  },
  {
    id: 'inbox.account_created',
    name: 'New account alert',
    channel: 'inbox',
    group: 'Requests',
    when: 'Someone registers or accepts an invite — owners are notified.',
    editable: ['subject'],
    canDisable: true
  },
  {
    id: 'inbox.league_request',
    name: 'League registration request',
    channel: 'inbox',
    group: 'Requests',
    when: 'Independent league submitted via Create a League.',
    editable: ['subject'],
    canDisable: true
  },
  {
    id: 'inbox.league_approved',
    name: 'League approved',
    channel: 'inbox',
    group: 'Requests',
    when: 'Site owner approves an independent league.',
    editable: ['subject', 'body'],
    placeholders: ['league'],
    canDisable: true
  },
  {
    id: 'inbox.league_rejected',
    name: 'League rejected',
    channel: 'inbox',
    group: 'Requests',
    when: 'Site owner rejects an independent league.',
    editable: ['subject', 'body'],
    placeholders: ['league', 'reason'],
    canDisable: true
  },
  {
    id: 'inbox.league_invite',
    name: 'League invite (existing account)',
    channel: 'inbox',
    group: 'Onboarding',
    when: 'Independent league owner invites an email that already has an account.',
    editable: ['subject', 'body'],
    placeholders: ['league'],
    canDisable: true
  },
  {
    id: 'inbox.chat_mention',
    name: 'Roll Call @mention',
    channel: 'inbox',
    group: 'Lounge',
    when: 'Someone is @mentioned in Members Lounge Roll Call.',
    editable: [],
    canDisable: true
  },
  {
    id: 'inbox.lounge_token',
    name: 'Lounge pass granted',
    channel: 'inbox',
    group: 'Lounge',
    when: 'Owner/commissioner turns on Lounge Pass for a member.',
    editable: ['subject', 'body'],
    placeholders: ['who', 'bankroll'],
    canDisable: true
  },
  {
    id: 'inbox.feature_request',
    name: 'Feature request letters',
    channel: 'inbox',
    group: 'Feedback',
    when: 'Member submits a feature request — owners + author confirmation.',
    editable: [],
    canDisable: true
  },
  {
    id: 'inbox.rule_proposal',
    name: 'Rule change letters',
    channel: 'inbox',
    group: 'Feedback',
    when: 'Member submits a rule proposal — staff + author confirmation.',
    editable: [],
    canDisable: true
  },
  {
    id: 'inbox.rule_vote',
    name: 'Rule vote open',
    channel: 'inbox',
    group: 'Feedback',
    when: 'Owner opens a league-wide rule vote.',
    editable: [],
    canDisable: true
  },
  {
    id: 'inbox.rule_result',
    name: 'Rule vote result',
    channel: 'inbox',
    group: 'Feedback',
    when: 'All ballots are in — PASSED / FAILED result to voters.',
    editable: [],
    canDisable: true
  },
  {
    id: 'digest.pending_users',
    name: 'Digest · pending accounts',
    channel: 'inbox',
    group: 'Digests',
    when: 'On login / inbox open while unapproved accounts exist (throttled).',
    editable: [],
    canDisable: true
  },
  {
    id: 'digest.pending_leagues',
    name: 'Digest · pending leagues',
    channel: 'inbox',
    group: 'Digests',
    when: 'On login / inbox open while independent leagues await approval.',
    editable: [],
    canDisable: true
  },
  {
    id: 'digest.roster_violations',
    name: 'Digest · roster violations',
    channel: 'inbox',
    group: 'Digests',
    when: 'On login / inbox open while open roster violations exist.',
    editable: [],
    canDisable: true
  },
  {
    id: 'digest.rule_proposals',
    name: 'Digest · rule proposals',
    channel: 'inbox',
    group: 'Digests',
    when: 'On login / inbox open while rule proposals await owner action.',
    editable: [],
    canDisable: true
  },
  {
    id: 'digest.feature_requests',
    name: 'Digest · feature requests',
    channel: 'inbox',
    group: 'Digests',
    when: 'On login / inbox open while open feature requests exist.',
    editable: [],
    canDisable: true
  }
];

function listCatalog() {
  return CATALOG.map((item) => ({ ...item }));
}

function getCatalogItem(id) {
  return CATALOG.find((item) => item.id === id) || null;
}

module.exports = {
  CATALOG,
  listCatalog,
  getCatalogItem
};
