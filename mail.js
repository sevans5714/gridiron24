function mailConfig() {
  const from = process.env.MAIL_FROM || process.env.EMAIL_FROM || '';
  const apiKey = process.env.RESEND_API_KEY || '';
  return {
    configured: Boolean(apiKey && from),
    from: from || null,
    provider: apiKey ? 'resend' : null
  };
}

function siteBaseUrl(explicit) {
  const raw = String(explicit || process.env.APP_BASE_URL || 'https://www.gridiron24.com').trim();
  return raw.replace(/\/$/, '') || 'https://www.gridiron24.com';
}

async function sendViaResend({ from, apiKey, to, subject, text, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text,
      html: html || undefined
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Email send failed (${res.status}): ${body.slice(0, 240)}`);
  }
  return { sent: true, method: 'resend' };
}

function buildInviteEmail({
  inviteUrl,
  invitedByName,
  leagueName,
  baseUrl
}) {
  const who = invitedByName || 'Your commissioner';
  const league = leagueName || 'GridIron 24';
  const origin = siteBaseUrl(baseUrl);
  const logoUrl = `${origin}/assets/gridiron24-logo.png`;
  const detailLogo = `${origin}/assets/detail-conference.png`;
  const overtimeLogo = `${origin}/assets/overtime-conference.png`;
  const homeUrl = `${origin}/enter`;

  const text =
    `You're invited to ${league}\n\n` +
    `${who} invited you to join GridIron 24 — 24 teams, two conferences, one champion.\n\n` +
    `Create your account here (invite expires in 14 days):\n${inviteUrl}\n\n` +
    `Already have an account? Sign in: ${homeUrl}\n\n` +
    `If you weren't expecting this invite, you can ignore this email.\n`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark" />
  <meta name="supported-color-schemes" content="dark" />
  <title>You're invited to ${escapeHtml(league)}</title>
</head>
<body style="margin:0;padding:0;background:#050505;color:#f2f2f2;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
    ${escapeHtml(who)} invited you to join ${escapeHtml(league)}. Create your account to get in.
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#050505;margin:0;padding:0;width:100%;">
    <tr>
      <td align="center" style="padding:28px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;border:1px solid rgba(255,255,255,0.10);background:#0d0d0d;">
          <tr>
            <td align="center" style="padding:28px 28px 8px;background:radial-gradient(ellipse at 50% 0%, rgba(47,109,255,0.18), transparent 60%), #0d0d0d;">
              <a href="${escapeHtml(origin)}" style="text-decoration:none;">
                <img src="${escapeHtml(logoUrl)}" width="220" alt="${escapeHtml(league)}" style="display:block;width:220px;max-width:70%;height:auto;border:0;margin:0 auto;" />
              </a>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 28px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:#9b9b9b;">
              24 Teams · Two Conferences · One Champion
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:22px 28px 6px;font-family:Arial,Helvetica,sans-serif;font-size:26px;line-height:1.2;font-weight:700;color:#ffffff;">
              You're invited
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 36px 18px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.55;color:#c8c8c8;">
              <strong style="color:#ffffff;">${escapeHtml(who)}</strong> invited you to create your account for
              <strong style="color:#efd782;">${escapeHtml(league)}</strong>.
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:4px 28px 22px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" style="padding:0 14px;">
                    <img src="${escapeHtml(detailLogo)}" width="56" height="56" alt="Detail Conference" style="display:block;width:56px;height:56px;object-fit:contain;border:0;" />
                    <div style="padding-top:6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#ff7a18;">Detail</div>
                  </td>
                  <td align="center" style="padding:0 10px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#666;">vs</td>
                  <td align="center" style="padding:0 14px;">
                    <img src="${escapeHtml(overtimeLogo)}" width="56" height="56" alt="Overtime Conference" style="display:block;width:56px;height:56px;object-fit:contain;border:0;" />
                    <div style="padding-top:6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#e2232a;">Overtime</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:6px 28px 10px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" bgcolor="#2f6dff" style="border-radius:4px;">
                    <a href="${escapeHtml(inviteUrl)}" style="display:inline-block;padding:14px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;text-decoration:none;color:#ffffff;">
                      Create your account
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:12px 36px 8px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#8a8a8a;">
              This invite link expires in <strong style="color:#c8c8c8;">14 days</strong>.
              After you join, you can sign in anytime at
              <a href="${escapeHtml(homeUrl)}" style="color:#8eb6ff;text-decoration:underline;">${escapeHtml(homeUrl.replace(/^https?:\/\//, ''))}</a>.
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 36px 24px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#666666;word-break:break-all;">
              Button not working? Paste this link into your browser:<br />
              <a href="${escapeHtml(inviteUrl)}" style="color:#8eb6ff;text-decoration:underline;">${escapeHtml(inviteUrl)}</a>
            </td>
          </tr>
          <tr>
            <td style="border-top:1px solid rgba(255,255,255,0.08);padding:16px 28px 22px;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.5;color:#666666;text-align:center;">
              ${escapeHtml(league)} HQ · Fantasy football across Detail &amp; Overtime<br />
              If you weren’t expecting this email, you can ignore it.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return {
    subject: `You're invited to ${league}`,
    text,
    html
  };
}

async function sendPasswordResetEmail({ to, resetUrl, name, baseUrl }) {
  const { configured, from } = mailConfig();
  const apiKey = process.env.RESEND_API_KEY || '';
  const who = name || 'there';
  const origin = siteBaseUrl(baseUrl);
  const logoUrl = `${origin}/assets/gridiron24-logo.png`;
  const text =
    `Hi ${who},\n\n` +
    `Reset your GridIron 24 password using this link (expires in 1 hour):\n${resetUrl}\n\n` +
    `If you did not request this, you can ignore this email.\n`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="margin:0;padding:0;background:#050505;color:#f2f2f2;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#050505;">
    <tr><td align="center" style="padding:28px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;border:1px solid rgba(255,255,255,0.10);background:#0d0d0d;">
        <tr><td align="center" style="padding:24px 24px 8px;">
          <img src="${escapeHtml(logoUrl)}" width="180" alt="GridIron 24" style="display:block;width:180px;max-width:65%;height:auto;border:0;" />
        </td></tr>
        <tr><td align="center" style="padding:12px 28px 8px;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;color:#fff;">Reset your password</td></tr>
        <tr><td align="center" style="padding:0 32px 18px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#c8c8c8;">Hi ${escapeHtml(who)}, use the button below to choose a new password. This link expires in 1 hour.</td></tr>
        <tr><td align="center" style="padding:0 28px 20px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td bgcolor="#2f6dff" style="border-radius:4px;">
              <a href="${escapeHtml(resetUrl)}" style="display:inline-block;padding:14px 24px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;text-decoration:none;color:#fff;text-transform:uppercase;letter-spacing:0.04em;">Reset password</a>
            </td>
          </tr></table>
        </td></tr>
        <tr><td align="center" style="padding:0 32px 24px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#666;word-break:break-all;">
          Or paste this link:<br /><a href="${escapeHtml(resetUrl)}" style="color:#8eb6ff;">${escapeHtml(resetUrl)}</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  if (configured) {
    return sendViaResend({
      from,
      apiKey,
      to,
      subject: 'Reset your GridIron 24 password',
      text,
      html
    });
  }

  console.log(`[password-reset] ${to}: ${resetUrl}`);
  return { sent: false, method: 'log', resetUrl };
}

async function sendInviteEmail({ to, inviteUrl, invitedByName, leagueName, baseUrl }) {
  const { configured, from } = mailConfig();
  const apiKey = process.env.RESEND_API_KEY || '';
  const content = buildInviteEmail({
    inviteUrl,
    invitedByName,
    leagueName,
    baseUrl
  });

  if (configured) {
    return sendViaResend({
      from,
      apiKey,
      to,
      subject: content.subject,
      text: content.text,
      html: content.html
    });
  }

  console.log(`[invite] ${to}: ${inviteUrl}`);
  return { sent: false, method: 'log', inviteUrl, previewHtml: content.html };
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

module.exports = {
  sendPasswordResetEmail,
  sendInviteEmail,
  mailConfig,
  buildInviteEmail,
  siteBaseUrl
};
