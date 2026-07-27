function mailConfig() {
  const from = process.env.MAIL_FROM || process.env.EMAIL_FROM || '';
  const apiKey = process.env.RESEND_API_KEY || '';
  return {
    configured: Boolean(apiKey && from),
    from: from || null,
    provider: apiKey ? 'resend' : null
  };
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

async function sendPasswordResetEmail({ to, resetUrl, name }) {
  const { configured, from } = mailConfig();
  const apiKey = process.env.RESEND_API_KEY || '';
  const who = name || 'there';
  const text =
    `Hi ${who},\n\n` +
    `Reset your GridIron 24 password using this link (expires in 1 hour):\n${resetUrl}\n\n` +
    `If you did not request this, you can ignore this email.\n`;
  const html =
    `<p>Hi ${escapeHtml(who)},</p>` +
    `<p>Reset your GridIron 24 password with this link (expires in 1 hour):</p>` +
    `<p><a href="${escapeHtml(resetUrl)}">${escapeHtml(resetUrl)}</a></p>` +
    `<p>If you did not request this, you can ignore this email.</p>`;

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

async function sendInviteEmail({ to, inviteUrl, invitedByName, leagueName }) {
  const { configured, from } = mailConfig();
  const apiKey = process.env.RESEND_API_KEY || '';
  const who = invitedByName || 'Your commissioner';
  const league = leagueName || 'GridIron 24';
  const text =
    `You're invited to ${league}.\n\n` +
    `${who} invited you to create your GridIron 24 account.\n\n` +
    `Accept the invite and register here (link expires in 14 days):\n${inviteUrl}\n\n` +
    `If you weren't expecting this, you can ignore this email.\n`;
  const html =
    `<p>You're invited to <strong>${escapeHtml(league)}</strong>.</p>` +
    `<p>${escapeHtml(who)} invited you to create your GridIron 24 account.</p>` +
    `<p><a href="${escapeHtml(inviteUrl)}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:4px;">Create your account</a></p>` +
    `<p style="color:#666;font-size:13px;">Or paste this link:<br>${escapeHtml(inviteUrl)}</p>` +
    `<p style="color:#666;font-size:13px;">This invite expires in 14 days. If you weren't expecting this, ignore this email.</p>`;

  if (configured) {
    return sendViaResend({
      from,
      apiKey,
      to,
      subject: `You're invited to ${league}`,
      text,
      html
    });
  }

  console.log(`[invite] ${to}: ${inviteUrl}`);
  return { sent: false, method: 'log', inviteUrl };
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

module.exports = { sendPasswordResetEmail, sendInviteEmail, mailConfig };
