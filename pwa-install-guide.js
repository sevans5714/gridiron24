/**
 * GridIron 24 PWA install guide — single source of truth.
 * Used by the public HTML page, PDF generator, and email copy.
 *
 * Keep this file current when install UX changes (Safari steps, Android Chrome, URLs).
 * Then run:  node scripts/generate-pwa-install-pdf.js
 */

const GUIDE = {
  title: 'Install the GridIron 24 App',
  subtitle: 'Add HQ to your iPhone or Android home screen',
  siteUrl: 'https://www.gridiron24.com',
  enterUrl: 'https://www.gridiron24.com/enter',
  appUrl: 'https://www.gridiron24.com/app/',
  updatedLabel: 'Updated August 2026',
  intro: [
    'GridIron 24 is a Progressive Web App (PWA). You install it from your phone’s browser — no App Store or Google Play download.',
    'Once installed, it opens like a normal app: standings, your matchup, roster, and league updates.'
  ],
  beforeYouStart: [
    'Have your GridIron 24 login ready (or create an account from an invite).',
    'Use the steps for your phone below. iPhone must use Safari. Android works best in Chrome.'
  ],
  apple: {
    title: 'iPhone & iPad (Safari)',
    steps: [
      'Open Safari (not Chrome or other browsers).',
      'Go to https://www.gridiron24.com/enter and sign in.',
      'After you land in the app, tap the Share button (square with an arrow pointing up).',
      'Scroll the share sheet and tap Add to Home Screen.',
      'Confirm the name (GridIron 24 / GI24), then tap Add.',
      'Open the new GridIron 24 icon on your Home Screen anytime.'
    ],
    tips: [
      'Chrome on iPhone can only bookmark the site — it cannot install the real app. Use Safari.',
      'If you do not see Add to Home Screen, tap Share → Edit Actions… and enable it.',
      'You can rearrange or put the icon in a folder like any other app.'
    ]
  },
  android: {
    title: 'Android (Chrome)',
    steps: [
      'Open Chrome.',
      'Go to https://www.gridiron24.com/enter and sign in.',
      'Look for an Install app / Add to Home screen banner, or tap the menu (⋮).',
      'Tap Install app or Add to Home screen, then confirm Install / Add.',
      'Open GridIron 24 from your Home Screen or app drawer.'
    ],
    tips: [
      'If Install does not appear, open https://www.gridiron24.com/app/ while signed in, then try the Chrome menu again.',
      'Samsung Internet and other browsers may label the action “Add page to” or “Add to Home screen.”',
      'After install, use the home-screen icon — not a browser bookmark — for the full app experience.'
    ]
  },
  afterInstall: {
    title: 'After you install',
    bullets: [
      'Sign in once inside the app if prompted.',
      'Use the bottom tabs for Home, Matchup, Roster, League, and Book.',
      'Notifications and updates depend on your phone settings; keep the app updated by opening it while online.',
      'To remove: long-press the icon → Remove / Uninstall (same as other apps).'
    ]
  },
  help: {
    title: 'Need help?',
    body: 'Ask your league commissioner or email the contact on your invite. Include your phone type (iPhone or Android) and which browser you used.'
  },
  email: {
    subject: 'How to install the GridIron 24 app (iPhone & Android)',
    preheader: 'Add GridIron 24 to your Home Screen — Safari on iPhone, Chrome on Android.',
    ctaLabel: 'Open install guide',
    ctaPath: '/install-app.html'
  }
};

function plainTextGuide() {
  const lines = [
    GUIDE.title,
    GUIDE.subtitle,
    '',
    ...GUIDE.intro,
    '',
    'Before you start',
    ...GUIDE.beforeYouStart.map((s) => `• ${s}`),
    '',
    GUIDE.apple.title,
    ...GUIDE.apple.steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    'Tips',
    ...GUIDE.apple.tips.map((s) => `• ${s}`),
    '',
    GUIDE.android.title,
    ...GUIDE.android.steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    'Tips',
    ...GUIDE.android.tips.map((s) => `• ${s}`),
    '',
    GUIDE.afterInstall.title,
    ...GUIDE.afterInstall.bullets.map((s) => `• ${s}`),
    '',
    GUIDE.help.title,
    GUIDE.help.body,
    '',
    `${GUIDE.siteUrl} · ${GUIDE.updatedLabel}`
  ];
  return lines.join('\n');
}

module.exports = {
  GUIDE,
  plainTextGuide
};
