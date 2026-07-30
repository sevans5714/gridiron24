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

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function brandedAssets(baseUrl) {
  const origin = siteBaseUrl(baseUrl);
  // Cache-bust so mail clients refresh the crest after brand updates.
  const crest = `${origin}/assets/gridiron24-crest.png?v=3`;
  return {
    origin,
    logoUrl: crest,
    crestUrl: crest,
    detailLogo: `${origin}/assets/detail-conference.png`,
    overtimeLogo: `${origin}/assets/overtime-conference.png`,
    enterUrl: `${origin}/enter`
  };
}

function brandedEmailHtml({
  title,
  preheader,
  eyebrow = '24 Teams · Two Conferences · One Champion',
  headline,
  bodyHtml,
  showConferences = true,
  ctaLabel,
  ctaUrl,
  noteHtml = '',
  linkFallbackUrl = '',
  footerExtra = 'If you weren’t expecting this email, ignore it.<br />GridIron 24 created by S.Evans',
  baseUrl
}) {
  const { origin, logoUrl, detailLogo, overtimeLogo } = brandedAssets(baseUrl);
  const conferences = showConferences
    ? `<tr>
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
          </tr>`
    : '';
  const cta = ctaLabel && ctaUrl
    ? `<tr>
            <td align="center" style="padding:6px 28px 10px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" bgcolor="#2f6dff" style="border-radius:4px;">
                    <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:14px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;text-decoration:none;color:#ffffff;">
                      ${escapeHtml(ctaLabel)}
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`
    : '';
  const note = noteHtml
    ? `<tr>
            <td align="center" style="padding:12px 36px 8px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#8a8a8a;">
              ${noteHtml}
            </td>
          </tr>`
    : '';
  const fallback = linkFallbackUrl
    ? `<tr>
            <td align="center" style="padding:8px 36px 24px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#666666;word-break:break-all;">
              Button not working? Paste this link into your browser:<br />
              <a href="${escapeHtml(linkFallbackUrl)}" style="color:#8eb6ff;text-decoration:underline;">${escapeHtml(linkFallbackUrl)}</a>
            </td>
          </tr>`
    : '';
  const footerLine = footerExtra
    ? `GridIron 24 HQ · Fantasy Football<br />${footerExtra}`
    : 'GridIron 24 HQ · Fantasy Football';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark" />
  <meta name="supported-color-schemes" content="dark" />
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#050505;color:#f2f2f2;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
    ${escapeHtml(preheader)}
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#050505;margin:0;padding:0;width:100%;">
    <tr>
      <td align="center" style="padding:28px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;border:1px solid rgba(255,255,255,0.10);background:#0d0d0d;">
          <tr>
            <td align="center" style="padding:32px 28px 10px;background:radial-gradient(ellipse at 50% 0%, rgba(47,109,255,0.18), transparent 60%), #0d0d0d;">
              <a href="${escapeHtml(origin)}" style="text-decoration:none;">
                <img src="${escapeHtml(logoUrl)}" width="260" alt="GridIron 24" style="display:block;width:260px;max-width:78%;height:auto;border:0;margin:0 auto;" />
              </a>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 28px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:#9b9b9b;">
              ${escapeHtml(eyebrow)}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:22px 28px 6px;font-family:Arial,Helvetica,sans-serif;font-size:26px;line-height:1.2;font-weight:700;color:#ffffff;">
              ${escapeHtml(headline)}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 36px 18px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.55;color:#c8c8c8;">
              ${bodyHtml}
            </td>
          </tr>
          ${conferences}
          ${cta}
          ${note}
          ${fallback}
          <tr>
            <td style="border-top:1px solid rgba(255,255,255,0.08);padding:18px 28px 22px;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.5;color:#666666;text-align:center;">
              <a href="${escapeHtml(origin)}" style="text-decoration:none;">
                <img src="${escapeHtml(logoUrl)}" width="64" alt="GridIron 24" style="display:block;width:64px;height:auto;border:0;margin:0 auto 10px;" />
              </a>
              ${footerLine}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildInviteEmail({
  inviteUrl,
  invitedByName,
  leagueName,
  baseUrl
}) {
  const inviteCopy = require('./invite-email-message');
  const { enterUrl: homeUrl } = brandedAssets(baseUrl);
  const c = inviteCopy.buildInviteCopy({
    inviteUrl,
    invitedByName,
    leagueName,
    homeUrl
  });

  const text =
    `${c.subject}\n\n` +
    `${c.bodyLead}\n\n` +
    `Create your account here:\n${inviteUrl}\n\n` +
    `${c.textExtra}\n\n` +
    `${c.alreadyHaveAccount}\n\n` +
    `GridIron 24 HQ · Fantasy Football\n` +
    `${c.footerIgnore}\n`;

  const html = brandedEmailHtml({
    title: c.subject,
    preheader: c.preheader,
    eyebrow: c.eyebrow,
    headline: c.headline,
    bodyHtml:
      `<strong style="color:#ffffff;">${escapeHtml(c.who)}</strong> invited you to create your account for ` +
      `<strong style="color:#efd782;">${escapeHtml(c.league)}</strong>.`,
    ctaLabel: c.ctaLabel,
    ctaUrl: inviteUrl,
    noteHtml:
      escapeHtml(c.note).replace(
        escapeHtml(c.homeHost),
        `<a href="${escapeHtml(homeUrl)}" style="color:#8eb6ff;text-decoration:underline;">${escapeHtml(c.homeHost)}</a>`
      ),
    linkFallbackUrl: inviteUrl,
    footerExtra: `${escapeHtml(c.footerIgnore)}<br />GridIron 24 created by S.Evans`,
    baseUrl
  });

  return {
    subject: c.subject,
    text,
    html,
    copy: c
  };
}

function buildPasswordResetEmail({ resetUrl, name, leagueName, baseUrl }) {
  const who = name || 'there';
  const league = leagueName || 'GridIron 24';
  const text =
    `Hi ${who},\n\n` +
    `Reset your ${league} password using this link (expires in 1 hour):\n${resetUrl}\n\n` +
    `If you did not request this, you can ignore this email.\n`;

  const html = brandedEmailHtml({
    title: `Reset your ${league} password`,
    preheader: `Reset your ${league} password. This link expires in 1 hour.`,
    headline: 'Reset your password',
    bodyHtml:
      `Hi <strong style="color:#ffffff;">${escapeHtml(who)}</strong> — use the button below to choose a new ` +
      `<strong style="color:#efd782;">${escapeHtml(league)}</strong> password. This link expires in 1 hour.`,
    showConferences: true,
    ctaLabel: 'Reset password',
    ctaUrl: resetUrl,
    noteHtml: 'If you did not request a password reset, you can ignore this email.',
    linkFallbackUrl: resetUrl,
    baseUrl
  });

  return {
    subject: `Reset your ${league} password`,
    text,
    html
  };
}

async function sendPasswordResetEmail({ to, resetUrl, name, baseUrl, leagueName }) {
  const { configured, from } = mailConfig();
  const apiKey = process.env.RESEND_API_KEY || '';
  const content = buildPasswordResetEmail({
    resetUrl,
    name,
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

  console.log(`[password-reset] ${to}: ${resetUrl}`);
  return { sent: false, method: 'log', resetUrl, previewHtml: content.html };
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

function buildAccountApprovedEmail({ name, leagueName, signInUrl, baseUrl }) {
  const who = name || 'there';
  const league = leagueName || 'GridIron 24';
  const { enterUrl } = brandedAssets(baseUrl);
  const homeUrl = signInUrl || enterUrl;

  const text =
    `Hi ${who},\n\n` +
    `Your ${league} account has been approved. You can sign in now:\n${homeUrl}\n\n` +
    `Welcome to the league — 24 teams, two conferences, one champion.\n\n` +
    `GridIron 24 HQ · Fantasy Football\n`;

  const html = brandedEmailHtml({
    title: `You're approved · ${league}`,
    preheader: `Your ${league} account is approved. Sign in to get started.`,
    headline: "You're in",
    bodyHtml:
      `Hi <strong style="color:#ffffff;">${escapeHtml(who)}</strong> — a commissioner approved your ` +
      `<strong style="color:#efd782;">${escapeHtml(league)}</strong> account. You can sign in now.`,
    ctaLabel: 'Sign in',
    ctaUrl: homeUrl,
    noteHtml: 'Use the login name and password you created when you registered.',
    linkFallbackUrl: homeUrl,
    footerExtra: '',
    baseUrl
  });

  return {
    subject: `You're approved · ${league}`,
    text,
    html
  };
}

async function sendAccountApprovedEmail({ to, name, leagueName, baseUrl }) {
  const { configured, from } = mailConfig();
  const apiKey = process.env.RESEND_API_KEY || '';
  const origin = siteBaseUrl(baseUrl);
  const content = buildAccountApprovedEmail({
    name,
    leagueName,
    signInUrl: `${origin}/enter`,
    baseUrl: origin
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

  console.log(`[account-approved] ${to}: ${content.subject}`);
  return { sent: false, method: 'log', previewHtml: content.html };
}

function conferenceEyebrow(conferenceKey, conferenceName) {
  const key = String(conferenceKey || '').toLowerCase();
  if (key === 'detail') return 'Detail Conference · GridIron 24';
  if (key === 'overtime') return 'Overtime Conference · GridIron 24';
  return conferenceName ? `${conferenceName} · GridIron 24` : 'GridIron 24 · Conference Note';
}

function buildConferenceOwnerEmail({
  subject,
  headline,
  body,
  recipientName,
  fromName,
  conferenceKey,
  conferenceName,
  ctaLabel,
  ctaUrl,
  baseUrl
}) {
  const origin = siteBaseUrl(baseUrl);
  const who = String(recipientName || '').trim() || 'Manager';
  const from = String(fromName || '').trim() || 'Your conference admin';
  const confLabel = conferenceName || (conferenceKey === 'overtime' ? 'Overtime Conference' : 'Detail Conference');
  const resolvedCtaUrl = ctaUrl
    ? (String(ctaUrl).startsWith('http') ? String(ctaUrl) : `${origin}${String(ctaUrl).startsWith('/') ? '' : '/'}${ctaUrl}`)
    : `${origin}/hq`;
  const resolvedCtaLabel = ctaLabel || 'Open League HQ';
  const bodyText = String(body || '').trim();
  const text =
    `${subject || 'Message from GridIron 24'}\n\n` +
    `Hi ${who},\n\n` +
    `${bodyText}\n\n` +
    `— ${from}\n${confLabel}\n\n` +
    `${resolvedCtaLabel}: ${resolvedCtaUrl}\n\n` +
    `GridIron 24 HQ · Fantasy Football\n`;

  const greeting = `<p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#d4d4d4;">Hi ${escapeHtml(who)},</p>`;
  const signoff =
    `<p style="margin:18px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#9a9a9a;">` +
    `— ${escapeHtml(from)}<br /><span style="letter-spacing:0.06em;text-transform:uppercase;font-size:12px;">${escapeHtml(confLabel)}</span></p>`;

  const html = brandedEmailHtml({
    title: subject || 'GridIron 24',
    preheader: `${from} · ${confLabel}`,
    eyebrow: conferenceEyebrow(conferenceKey, confLabel),
    headline: headline || subject || 'Conference update',
    bodyHtml: `${greeting}${paragraphsToHtml(bodyText)}${signoff}`,
    showConferences: false,
    ctaLabel: resolvedCtaLabel,
    ctaUrl: resolvedCtaUrl,
    linkFallbackUrl: resolvedCtaUrl,
    footerExtra: 'GridIron 24 created by S.Evans · Patrol Division',
    baseUrl: origin
  });

  return { subject: subject || `Message from ${confLabel}`, text, html };
}

async function sendConferenceOwnerEmail({
  to,
  subject,
  headline,
  body,
  recipientName,
  fromName,
  conferenceKey,
  conferenceName,
  ctaLabel,
  ctaUrl,
  baseUrl
}) {
  const content = buildConferenceOwnerEmail({
    subject,
    headline,
    body,
    recipientName,
    fromName,
    conferenceKey,
    conferenceName,
    ctaLabel,
    ctaUrl,
    baseUrl
  });
  const cfg = mailConfig();
  if (cfg.configured) {
    await sendViaResend({
      from: cfg.from,
      apiKey: process.env.RESEND_API_KEY,
      to,
      subject: content.subject,
      text: content.text,
      html: content.html
    });
    return { sent: true, method: 'resend', subject: content.subject };
  }
  console.log(`[conference-email] ${to}: ${content.subject}`);
  return { sent: false, method: 'log', subject: content.subject, previewHtml: content.html };
}

function paragraphsToHtml(text) {
  const chunks = String(text || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!chunks.length) return '';
  return chunks
    .map((p) => {
      const withBreaks = escapeHtml(p).replaceAll('\n', '<br />');
      return `<p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#d4d4d4;">${withBreaks}</p>`;
    })
    .join('');
}

function confResultsHtml(conf) {
  const games = (conf.games || []).filter((g) => g.final);
  if (!games.length) {
    return `<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#8a8a8a;">No final scores yet.</p>`;
  }
  return games
    .map((g) => {
      const line = `${escapeHtml(g.away)} ${g.awayScore.toFixed(1)} · ${escapeHtml(g.home)} ${g.homeScore.toFixed(1)}`;
      const winner = g.winnerName
        ? `<div style="margin-top:2px;font-size:12px;color:#8a8a8a;">Winner: ${escapeHtml(g.winnerName)}</div>`
        : '';
      return `<div style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.08);font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#f0f0f0;">${line}${winner}</div>`;
    })
    .join('');
}

function confStandingsHtml(conf) {
  const rows = (conf.standingsTop || []).slice(0, 6);
  if (!rows.length) return '';
  const items = rows
    .map(
      (t, i) =>
        `<div style="padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#d8d8d8;">` +
        `<span style="color:#8a8a8a;display:inline-block;min-width:1.4rem;">${i + 1}.</span>` +
        `${escapeHtml(t.name)} <span style="color:#9a9a9a;">${escapeHtml(t.record)}</span>` +
        ` <span style="color:#666;">· PF ${escapeHtml(t.pf)} · ${escapeHtml(t.streak)}</span></div>`
    )
    .join('');
  return `
    <div style="margin-top:12px;">
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#8a8a8a;margin-bottom:4px;">Standings</div>
      ${items}
    </div>`;
}

function weeklyAwardsHtml(stats) {
  const items = stats?.awards?.items || [];
  if (!items.length) return '';
  const rows = items
    .map(
      (a) => `
      <tr>
        <td style="padding:9px 0;border-bottom:1px solid rgba(255,255,255,0.08);vertical-align:top;width:34%;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#8eb6ff;">
          ${escapeHtml(a.label)}
        </td>
        <td style="padding:9px 0 9px 12px;border-bottom:1px solid rgba(255,255,255,0.08);font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.4;color:#f0f0f0;">
          ${escapeHtml(a.detail)}
        </td>
      </tr>`
    )
    .join('');
  return `
    <tr>
      <td style="padding:22px 28px 4px;">
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#ffffff;">
          Week ${escapeHtml(String(stats.week))} Awards
        </div>
        <div style="margin-top:4px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#8a8a8a;">
          Across Detail &amp; Overtime
        </div>
      </td>
    </tr>
    <tr>
      <td style="padding:8px 28px 6px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          ${rows}
        </table>
      </td>
    </tr>`;
}

function awardsPlainText(stats) {
  const items = stats?.awards?.items || [];
  if (!items.length) return '';
  return (
    `\nWeek ${stats.week} Awards\n` +
    items.map((a) => `• ${a.label}: ${a.detail}`).join('\n') +
    '\n'
  );
}

function resultsPlainText(stats) {
  const confs = stats?.conferences || [];
  if (!confs.length) return '';
  const blocks = confs.map((conf) => {
    const finals = (conf.games || []).filter((g) => g.final);
    const lines = [`\n${conf.shortName || conf.name}`];
    if (!finals.length) {
      lines.push('No final scores yet.');
    } else {
      for (const g of finals) {
        lines.push(
          `${g.away} ${g.awayScore.toFixed(1)} · ${g.home} ${g.homeScore.toFixed(1)}` +
            (g.winnerName ? ` (W: ${g.winnerName})` : '')
        );
      }
    }
    return lines.join('\n');
  });
  return `\nLeague Results${blocks.join('\n')}\n`;
}

function buildWeeklyWrapEmail({
  week,
  season,
  title,
  body,
  stats,
  recipientName,
  baseUrl
}) {
  const league = stats?.leagueName || 'GridIron 24';
  const { origin, logoUrl, detailLogo, overtimeLogo } = brandedAssets(baseUrl);
  const homeUrl = `${origin}/hq`;
  const who = recipientName || 'Manager';
  const headline = title || `Week ${week} Wrap-Up · ${season || ''}`;

  const confBlocks = (stats?.conferences || [])
    .map((conf) => {
      const accent = conf.key === 'overtime' ? '#e2232a' : '#ff7a18';
      const mark = conf.key === 'overtime' ? overtimeLogo : detailLogo;
      return `
        <tr>
          <td style="padding:18px 28px 6px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td width="44" valign="middle">
                  <img src="${escapeHtml(mark)}" width="40" height="40" alt="" style="display:block;width:40px;height:40px;object-fit:contain;border:0;" />
                </td>
                <td valign="middle" style="padding-left:10px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${accent};">
                  ${escapeHtml(conf.shortName || conf.name)}
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:4px 28px 10px;">
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#8a8a8a;margin-bottom:4px;">Results</div>
            ${confResultsHtml(conf)}
            ${confStandingsHtml(conf)}
          </td>
        </tr>`;
    })
    .join('');

  const text =
    `${headline}\n\n` +
    `Hi ${who},\n\n` +
    `${body}\n` +
    awardsPlainText(stats) +
    resultsPlainText(stats) +
    `\nOpen League HQ: ${homeUrl}\n`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark" />
  <title>${escapeHtml(headline)}</title>
</head>
<body style="margin:0;padding:0;background:#050505;color:#f2f2f2;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
    Week ${escapeHtml(String(week))} wrap-up is live — awards, scores, and the race across Detail &amp; Overtime.
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#050505;width:100%;">
    <tr>
      <td align="center" style="padding:28px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;border:1px solid rgba(255,255,255,0.10);background:#0d0d0d;">
          <tr>
            <td align="center" style="padding:26px 28px 6px;background:radial-gradient(ellipse at 50% 0%, rgba(47,109,255,0.16), transparent 58%), #0d0d0d;">
              <a href="${escapeHtml(origin)}" style="text-decoration:none;">
                <img src="${escapeHtml(logoUrl)}" width="260" alt="${escapeHtml(league)}" style="display:block;width:260px;max-width:78%;height:auto;border:0;margin:0 auto;" />
              </a>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:10px 28px 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#9b9b9b;">
              Weekly Wrap-Up · Week ${escapeHtml(String(week))}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:14px 28px 8px;font-family:Arial,Helvetica,sans-serif;font-size:24px;line-height:1.25;font-weight:700;color:#ffffff;">
              ${escapeHtml(headline)}
            </td>
          </tr>
          <tr>
            <td style="padding:8px 28px 4px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#9a9a9a;">
              Hi ${escapeHtml(who)},
            </td>
          </tr>
          <tr>
            <td style="padding:6px 28px 8px;">
              ${paragraphsToHtml(body)}
            </td>
          </tr>
          ${weeklyAwardsHtml(stats)}
          ${confBlocks}
          <tr>
            <td align="center" style="padding:22px 28px 10px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" bgcolor="#2f6dff" style="border-radius:4px;">
                    <a href="${escapeHtml(homeUrl)}" style="display:inline-block;padding:14px 26px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;text-decoration:none;color:#ffffff;">
                      Open League HQ
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="border-top:1px solid rgba(255,255,255,0.08);padding:16px 28px 22px;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.5;color:#666666;text-align:center;">
              <a href="${escapeHtml(origin)}" style="text-decoration:none;">
                <img src="${escapeHtml(logoUrl)}" width="64" alt="${escapeHtml(league)}" style="display:block;width:64px;height:auto;border:0;margin:0 auto 10px;" />
              </a>
              ${escapeHtml(league)} · Detail &amp; Overtime · Season ${escapeHtml(String(season || ''))}<br />
              You’re receiving this as a league manager at GridIron 24 HQ.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return {
    subject: headline,
    text,
    html
  };
}

async function sendWeeklyWrapEmail({ to, week, season, title, body, stats, recipientName, baseUrl }) {
  const { configured, from } = mailConfig();
  const apiKey = process.env.RESEND_API_KEY || '';
  const content = buildWeeklyWrapEmail({
    week,
    season,
    title,
    body,
    stats,
    recipientName,
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

  console.log(`[weekly-wrap] ${to}: ${content.subject}`);
  return { sent: false, method: 'log', previewHtml: content.html };
}

async function sendRulesSyncAlert({ to, matched, diffs, checkedAt, baseUrl }) {
  const cfg = mailConfig();
  const origin = siteBaseUrl(baseUrl);
  const toolsUrl = `${origin}/league-tools.html#rules-sync`;
  const when = checkedAt ? new Date(checkedAt).toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'just now';
  const subject = matched
    ? 'GridIron 24 · Conferences synced'
    : `GridIron 24 · Rules out of sync (${(diffs || []).length} differences)`;

  const lines = (diffs || []).slice(0, 20).map((d) => (
    `• [${d.kind}] ${d.label}: Detail=${d.detail} · Overtime=${d.overtime}`
  ));
  const text = matched
    ? `Detail and Overtime match.\n\nChecked: ${when}\nOfficial scoring on the Scoring page was refreshed.\n\n${toolsUrl}\n`
    : `Detail and Overtime scoring/lineup/playoff settings differ.\n\nChecked: ${when}\nDifferences (${(diffs || []).length}):\n${lines.join('\n')}\n\nOpen League Tools to fix:\n${toolsUrl}\n`;

  const htmlDiffs = matched
    ? `<p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#86efac;">Both conferences match. Official scoring was refreshed.</p>`
    : `<p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#fca5a5;">${(diffs || []).length} difference(s) found.</p>
       <ul style="margin:0 0 14px;padding-left:1.2rem;color:#c8c8c8;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;text-align:left;">${lines.map((l) => `<li>${escapeHtml(l.replace(/^• /, ''))}</li>`).join('')}</ul>`;

  const html = brandedEmailHtml({
    title: subject,
    preheader: matched ? 'Detail and Overtime match.' : 'Conference rules differ — open League Tools.',
    eyebrow: 'GridIron 24 · Rules Patrol',
    headline: matched ? 'Conferences synced' : 'Rules out of sync',
    bodyHtml:
      `<p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#9a9a9a;">Checked ${escapeHtml(when)} (Eastern)</p>` +
      htmlDiffs,
    showConferences: true,
    ctaLabel: 'Open League Tools',
    ctaUrl: toolsUrl,
    linkFallbackUrl: toolsUrl,
    footerExtra: 'Automated rules sync · GridIron 24 created by S.Evans',
    baseUrl: origin
  });

  if (cfg.configured) {
    return sendViaResend({
      from: cfg.from,
      apiKey: process.env.RESEND_API_KEY,
      to,
      subject,
      text,
      html
    });
  }
  console.log(`[rules-sync] ${to}: ${subject}`);
  return { sent: false, method: 'log', previewHtml: html };
}

function buildRosterViolationEmail({
  recipientName,
  teamName,
  conferenceName,
  conferenceKey,
  week,
  players,
  baseUrl
}) {
  const origin = siteBaseUrl(baseUrl);
  const who = String(recipientName || '').trim() || 'Manager';
  const team = String(teamName || 'Your franchise').trim();
  const conf = String(conferenceName || '').trim() || 'GridIron 24';
  const weekLabel = week != null ? `Week ${week}` : 'this week';
  const list = Array.isArray(players) ? players : [];
  const cleanLines = list.map((p) => {
    const slot = p.slot ? `${p.slot}` : 'Starter';
    const status = p.injuryStatus || 'INJURED';
    return `• ${p.playerName || 'Player'} (${p.position || '—'}) — ${slot} · ${status}`;
  });
  const subject = `Roster alert · ${team} · injured starter${list.length === 1 ? '' : 's'} (${weekLabel})`;
  const headline = 'Injured starter on your active lineup';
  const bodyText =
    `GridIron 24 Patrol flagged ${list.length === 1 ? 'an injured player' : 'injured players'} in your starting lineup for ${weekLabel}.\n\n` +
    `${cleanLines.join('\n')}\n\n` +
    `Starting a player who is Out, Doubtful, or on Injured Reserve is a roster violation. ` +
    `Please adjust your ESPN lineup before kickoff.\n\n` +
    `Franchise: ${team}\nConference: ${conf}`;

  const playerRows = list.map((p) => (
    `<tr>` +
    `<td style="padding:8px 10px;border-bottom:1px solid #2a2a2a;color:#f2f2f2;font-family:Arial,Helvetica,sans-serif;font-size:14px;">${escapeHtml(p.playerName || 'Player')}</td>` +
    `<td style="padding:8px 10px;border-bottom:1px solid #2a2a2a;color:#9a9a9a;font-family:Arial,Helvetica,sans-serif;font-size:13px;">${escapeHtml(p.position || '—')}</td>` +
    `<td style="padding:8px 10px;border-bottom:1px solid #2a2a2a;color:#9a9a9a;font-family:Arial,Helvetica,sans-serif;font-size:13px;">${escapeHtml(p.slot || 'Starter')}</td>` +
    `<td style="padding:8px 10px;border-bottom:1px solid #2a2a2a;color:#f59e0b;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;">${escapeHtml(p.injuryStatus || 'INJURED')}</td>` +
    `</tr>`
  )).join('');

  const table =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:12px 0 18px;border:1px solid #2a2a2a;">` +
    `<thead><tr>` +
    `<th align="left" style="padding:8px 10px;background:#161616;color:#9a9a9a;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;">Player</th>` +
    `<th align="left" style="padding:8px 10px;background:#161616;color:#9a9a9a;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;">Pos</th>` +
    `<th align="left" style="padding:8px 10px;background:#161616;color:#9a9a9a;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;">Slot</th>` +
    `<th align="left" style="padding:8px 10px;background:#161616;color:#9a9a9a;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;">Status</th>` +
    `</tr></thead><tbody>${playerRows}</tbody></table>`;

  const greeting = `<p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#d4d4d4;">Hi ${escapeHtml(who)},</p>`;
  const outro =
    `<p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#d4d4d4;">` +
    `Starting a player who is <strong style="color:#f2f2f2;">Out</strong>, <strong style="color:#f2f2f2;">Doubtful</strong>, or on <strong style="color:#f2f2f2;">Injured Reserve</strong> is a roster violation. ` +
    `Please adjust your ESPN lineup before kickoff.</p>` +
    `<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#9a9a9a;">` +
    `${escapeHtml(team)} · ${escapeHtml(conf)} · ${escapeHtml(weekLabel)}</p>`;

  const html = brandedEmailHtml({
    title: subject,
    preheader: `${list.length} injured starter${list.length === 1 ? '' : 's'} on ${team}`,
    eyebrow: 'GridIron 24 · Roster Patrol',
    headline,
    bodyHtml: `${greeting}${table}${outro}`,
    showConferences: false,
    ctaLabel: 'Open League HQ',
    ctaUrl: `${origin}/hq`,
    linkFallbackUrl: `${origin}/hq`,
    footerExtra: 'Automated warning from GridIron 24 Patrol · created by S.Evans',
    baseUrl: origin
  });

  return { subject, text: `${subject}\n\nHi ${who},\n\n${bodyText}\n\nOpen League HQ: ${origin}/hq\n`, html };
}

async function sendRosterViolationEmail(opts) {
  const content = buildRosterViolationEmail(opts);
  const to = String(opts.to || '').trim();
  if (!to) return { sent: false, method: 'skip', error: 'missing_email' };
  const cfg = mailConfig();
  if (cfg.configured) {
    try {
      await sendViaResend({
        from: cfg.from,
        apiKey: process.env.RESEND_API_KEY,
        to,
        subject: content.subject,
        text: content.text,
        html: content.html
      });
      return { sent: true, method: 'resend', subject: content.subject };
    } catch (err) {
      console.error(`[roster-violation] failed ${to}:`, err.message || err);
      return { sent: false, method: 'error', error: err.message || 'send failed', subject: content.subject };
    }
  }
  console.log(`[roster-violation] ${to}: ${content.subject}`);
  return { sent: false, method: 'log', subject: content.subject, previewHtml: content.html };
}

module.exports = {
  sendPasswordResetEmail,
  sendInviteEmail,
  sendAccountApprovedEmail,
  sendWeeklyWrapEmail,
  sendRulesSyncAlert,
  sendConferenceOwnerEmail,
  sendRosterViolationEmail,
  mailConfig,
  buildInviteEmail,
  buildAccountApprovedEmail,
  buildPasswordResetEmail,
  buildWeeklyWrapEmail,
  buildConferenceOwnerEmail,
  buildRosterViolationEmail,
  siteBaseUrl
};
