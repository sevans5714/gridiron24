const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const GATE_FILE = path.join(DATA_DIR, 'league-gate.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readFileGate() {
  try {
    if (!fs.existsSync(GATE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(GATE_FILE, 'utf8'));
    const leaguePassword = String(data.leaguePassword || '');
    if (!leaguePassword) return null;
    return {
      leagueName: String(data.leagueName || 'GridIron 24').trim() || 'GridIron 24',
      leaguePassword,
      commissionerLogin: data.commissionerLogin
        ? String(data.commissionerLogin).trim().toLowerCase()
        : null,
      source: 'file'
    };
  } catch {
    return null;
  }
}

function getGate() {
  const envPassword = String(process.env.LEAGUE_PASSWORD || '');
  if (envPassword) {
    return {
      leagueName: String(process.env.LEAGUE_NAME || 'GridIron 24').trim() || 'GridIron 24',
      leaguePassword: envPassword,
      commissionerLogin: process.env.COMMISSIONER_LOGIN
        ? String(process.env.COMMISSIONER_LOGIN).trim().toLowerCase()
        : null,
      source: 'env'
    };
  }
  return readFileGate();
}

function isConfigured() {
  return Boolean(getGate()?.leaguePassword);
}

function writeGate({ leagueName, leaguePassword, commissionerLogin }) {
  if (process.env.LEAGUE_PASSWORD) {
    const err = new Error('League access is already set via server environment variables.');
    err.status = 409;
    throw err;
  }
  const name = String(leagueName || '').trim();
  const password = String(leaguePassword || '');
  if (!name || name.length < 2) {
    const err = new Error('League name must be at least 2 characters.');
    err.status = 400;
    throw err;
  }
  if (!password || password.length < 4) {
    const err = new Error('League password must be at least 4 characters.');
    err.status = 400;
    throw err;
  }
  ensureDir();
  const payload = {
    leagueName: name,
    leaguePassword: password,
    commissionerLogin: commissionerLogin
      ? String(commissionerLogin).trim().toLowerCase()
      : null,
    updatedAt: new Date().toISOString()
  };
  const tmp = `${GATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, GATE_FILE);

  if (payload.commissionerLogin && !process.env.COMMISSIONER_LOGIN) {
    process.env.COMMISSIONER_LOGIN = payload.commissionerLogin;
  }
  return {
    ok: true,
    leagueName: payload.leagueName,
    commissionerLogin: payload.commissionerLogin,
    source: 'file'
  };
}

module.exports = {
  DATA_DIR,
  GATE_FILE,
  getGate,
  isConfigured,
  writeGate
};
