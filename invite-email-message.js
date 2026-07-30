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
    'A commissioner must approve you before you can sign in. ' +
    'After approval, sign in anytime at {{homeHost}}.',
  textExtra:
    'This link stays active until you join. A commissioner must approve your account before you can sign in.',
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
  homeUrl
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

  return {
    subject: fill(copy.subject, vars),
    preheader: fill(copy.preheader, vars),
    eyebrow: fill(copy.eyebrow, vars),
    headline: fill(copy.headline, vars),
    bodyLead: fill(copy.bodyLead, vars),
    ctaLabel: fill(copy.ctaLabel, vars),
    note: fill(copy.note, vars),
    textExtra: fill(copy.textExtra, vars),
    alreadyHaveAccount: fill(copy.alreadyHaveAccount, vars),
    footerIgnore: fill(copy.footerIgnore, vars),
    who,
    league,
    inviteUrl: vars.inviteUrl,
    homeUrl: enter,
    homeHost,
    sourceFile: 'invite-email-message.js'
  };
}

module.exports = {
  copy,
  fill,
  buildInviteCopy
};
