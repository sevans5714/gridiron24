async function sendPasswordResetEmail({ to, resetUrl, name }) {
  const from = process.env.MAIL_FROM || process.env.EMAIL_FROM || '';
  const apiKey = process.env.RESEND_API_KEY || '';

  if (apiKey && from) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: 'Reset your GridIron 24 password',
        text: `Hi ${name || 'there'},\n\nReset your password using this link (expires in 1 hour):\n${resetUrl}\n\nIf you did not request this, you can ignore this email.\n`
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Email send failed (${res.status}): ${body}`);
    }
    return { sent: true, method: 'resend' };
  }

  console.log(`[password-reset] ${to}: ${resetUrl}`);
  return { sent: false, method: 'log', resetUrl };
}

async function sendInviteEmail({ to, inviteUrl, invitedByName, leagueName }) {
  const from = process.env.MAIL_FROM || process.env.EMAIL_FROM || '';
  const apiKey = process.env.RESEND_API_KEY || '';
  const who = invitedByName || 'Your commissioner';
  const league = leagueName || 'GridIron 24';
  const text =
    `You're invited to ${league}.\n\n` +
    `${who} invited you to create your GridIron 24 account.\n\n` +
    `Accept the invite and register here (link expires in 14 days):\n${inviteUrl}\n\n` +
    `If you weren't expecting this, you can ignore this email.\n`;

  if (apiKey && from) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `You're invited to ${league}`,
        text
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Email send failed (${res.status}): ${body}`);
    }
    return { sent: true, method: 'resend' };
  }

  console.log(`[invite] ${to}: ${inviteUrl}`);
  return { sent: false, method: 'log', inviteUrl };
}

module.exports = { sendPasswordResetEmail, sendInviteEmail };
