/**
 * Commissioner invite / token email copy.
 *
 * Edit the strings below anytime — new invites use this copy.
 * Placeholders: {{who}} {{league}} {{inviteUrl}} {{homeUrl}} {{homeHost}}
 *
 * Preview (signed in as staff):
 *   /api/invites/preview-email                 → full-member HTML
 *   /api/invites/preview-email?social=1       → Members Lounge HTML
 *   /api/invites/preview-email?format=json    → subject + text + html
 * League Tools → Invites also links the HTML preview.
 */

const copy = {
  subject: "You're invited to {{league}}",
  preheader: '{{who}} invited you to join {{league}}. Create your account to get in.',
  eyebrow: '24 Teams · Two Conferences · One Champion',
  headline: "You're invited",
  /** Plain sentence under the headline (HTML version wraps names in bold). */
  bodyLead: '{{who}} invited you to create your account for {{league}}.',
  ctaLabel: 'Create your account',
  note:
    'This invite link stays active until you create your account. ' +
    'After you join, sign in anytime at {{homeHost}}.',
  textExtra:
    'This link stays active until you join. Create your account, then sign in anytime.',
  alreadyHaveAccount: 'Already have an account? Sign in: {{homeUrl}}',
  footerIgnore: "If you weren't expecting this email, ignore it."
};

/** Ordered feature cards for the Members Lounge social invite. */
const loungeFeatures = [
  {
    title: 'Live Scoreboard',
    blurb: 'NFL slate plus GridIron 24 & AAA fantasy boards — live and upcoming.'
  },
  {
    title: 'Record Book',
    blurb: 'Franchise records, streaks, and historical seasons in one desk.'
  },
  {
    title: 'Mock Draft',
    blurb: 'Full snake practice with pick clock, targets, and CPU seats.'
  },
  {
    title: "Casala's Palace",
    blurb: 'Paper sportsbook — lines, futures, and fun-money standings.'
  },
  {
    title: 'League Pools',
    blurb: "Pick'em, confidence, squares, survivor, auctions, sweeps, and more."
  },
  {
    title: 'Roll Call',
    blurb: 'Lounge chat with who’s online — the social heart of HQ.'
  },
  {
    title: 'Treasurer Desk',
    blurb: 'Dues, payments, and the league money desk.'
  },
  {
    title: 'Membership Roll',
    blurb: 'See who’s in the lounge and claim your screen name.'
  }
];

const socialCopy = {
  subject: "You're invited to the {{league}} Members Lounge",
  preheader:
    '{{who}} invited you to the Members Lounge — scoreboard, Record Book, Mock Draft, Sportsbook, pools, Roll Call, and more.',
  eyebrow: 'Members Lounge · Social Access',
  headline: 'Welcome to the Lounge',
  bodyLead:
    '{{who}} invited you to a social account for the {{league}} Members Lounge. ' +
    'Hang with the league — this invite is lounge access only (no fantasy franchise).',
  featuresHeading: "What's inside",
  features: loungeFeatures,
  accessNote: 'Social membership · Members Lounge only · No franchise HQ',
  ctaLabel: 'Enter the Members Lounge',
  note:
    'This invite link stays active until you create your account. ' +
    'Social accounts sign in at {{homeHost}} and land in the Members Lounge.',
  textExtra:
    'Create your account with the link above, then sign in anytime. ' +
    'Social accounts land in the Members Lounge.',
  alreadyHaveAccount: 'Already have an account? Sign in: {{homeUrl}}',
  footerIgnore: "If you weren't expecting this email, ignore it."
};

function fill(template, vars = {}) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v == null ? '' : String(v);
  });
}

function buildInviteCopy({
  inviteUrl,
  invitedByName,
  leagueName,
  homeUrl,
  loungeOnly,
  independent
} = {}) {
  const who = invitedByName || 'Your commissioner';
  const league = leagueName || (independent ? 'your league' : 'GridIron 24');
  const enter = homeUrl || 'https://www.gridiron24.com/enter';
  const homeHost = String(enter).replace(/^https?:\/\//, '');
  const vars = {
    who,
    league,
    inviteUrl: inviteUrl || '',
    homeUrl: enter,
    homeHost
  };
  const base = loungeOnly ? socialCopy : copy;
  let overrides = {};
  try {
    const comms = require('./comms-settings-store');
    overrides = comms.getCopy(loungeOnly ? 'email.invite_social' : 'email.invite') || {};
  } catch {
    overrides = {};
  }
  const src = { ...base, ...overrides };
  if (independent && !loungeOnly) {
    src.eyebrow = src.eyebrow && src.eyebrow !== copy.eyebrow
      ? src.eyebrow
      : '{{league}}';
  }

  return {
    subject: fill(src.subject, vars),
    preheader: fill(src.preheader, vars),
    eyebrow: fill(src.eyebrow, vars),
    headline: fill(src.headline, vars),
    bodyLead: fill(src.bodyLead, vars),
    featuresHeading: src.featuresHeading || '',
    features: Array.isArray(src.features) ? src.features.slice() : [],
    accessNote: src.accessNote || '',
    ctaLabel: fill(src.ctaLabel, vars),
    note: fill(src.note, vars),
    textExtra: fill(src.textExtra, vars),
    alreadyHaveAccount: fill(src.alreadyHaveAccount, vars),
    footerIgnore: fill(src.footerIgnore, vars),
    who,
    league,
    inviteUrl: vars.inviteUrl,
    homeUrl: enter,
    homeHost,
    loungeOnly: Boolean(loungeOnly),
    sourceFile: 'invite-email-message.js'
  };
}

module.exports = {
  copy,
  socialCopy,
  loungeFeatures,
  fill,
  buildInviteCopy
};
