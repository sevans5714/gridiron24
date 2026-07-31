/**
 * Commissioner invite / token email copy.
 *
 * Edit the strings below anytime — new invites use this copy.
 * Placeholders: {{who}} {{league}} {{inviteUrl}} {{homeUrl}} {{homeHost}}
 *
 * Preview (signed in as staff):
 *   /api/invites/preview-email          → HTML
 *   /api/invites/preview-email?format=json → subject + text + html
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

const socialCopy = {
  subject: "You're invited to the {{league}} Members Lounge",
  preheader: '{{who}} invited you to the Members Lounge — chat, games, and the social desk.',
  eyebrow: 'Members Lounge · Social access',
  headline: "You're invited to the Lounge",
  bodyLead:
    '{{who}} invited you to a social account for the {{league}} Members Lounge. ' +
    'You can hang in the lounge — this invite does not include a fantasy franchise.',
  ctaLabel: 'Create your lounge account',
  note:
    'This invite link stays active until you create your account. ' +
    'Social accounts sign in at {{homeHost}} and go straight to the Members Lounge.',
  textExtra:
    'This is a social (Members Lounge only) invite — no franchise assignment. ' +
    'Create your account, then sign in anytime.',
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
  loungeOnly
} = {}) {
  const who = invitedByName || 'Your commissioner';
  const league = leagueName || 'GridIron 24';
  const enter = homeUrl || 'https://www.gridiron24.com/enter';
  const homeHost = String(enter).replace(/^https?:\/\//, '');
  const vars = {
    who,
    league,
    inviteUrl: inviteUrl || '',
    homeUrl: enter,
    homeHost
  };
  const src = loungeOnly ? socialCopy : copy;

  return {
    subject: fill(src.subject, vars),
    preheader: fill(src.preheader, vars),
    eyebrow: fill(src.eyebrow, vars),
    headline: fill(src.headline, vars),
    bodyLead: fill(src.bodyLead, vars),
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
  fill,
  buildInviteCopy
};
