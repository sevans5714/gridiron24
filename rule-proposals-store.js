const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'rule-proposals.json');
const MAX_PROPOSALS = 200;

const STATUS = {
  SUBMITTED: 'submitted',
  VOTING: 'voting',
  PASSED: 'passed',
  FAILED: 'failed',
  DISMISSED: 'dismissed'
};

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ proposals: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { proposals: Array.isArray(data.proposals) ? data.proposals : [] };
  } catch {
    return { proposals: [] };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

function tally(proposal) {
  const votes = proposal.votes && typeof proposal.votes === 'object' ? proposal.votes : {};
  let yes = 0;
  let no = 0;
  for (const v of Object.values(votes)) {
    const choice = String(v?.choice || v || '').toLowerCase();
    if (choice === 'yes') yes += 1;
    else if (choice === 'no') no += 1;
  }
  return { yes, no, total: yes + no };
}

function majorityNeeded(eligibleCount) {
  const n = Math.max(0, Number(eligibleCount) || 0);
  return Math.floor(n / 2) + 1;
}

function publicProposal(proposal, { user = null, includeVotes = false } = {}) {
  if (!proposal) return null;
  const { yes, no, total } = tally(proposal);
  const myVote = user?.id && proposal.votes?.[user.id]
    ? String(proposal.votes[user.id].choice || proposal.votes[user.id]).toLowerCase()
    : null;
  const eligibleCount = Number(proposal.eligibleCount || 0);
  const need = majorityNeeded(eligibleCount);
  const canVote = proposal.status === STATUS.VOTING && Boolean(user?.id) && !myVote;

  return {
    id: proposal.id,
    text: proposal.text,
    authorId: proposal.authorId,
    authorName: proposal.authorName,
    status: proposal.status,
    createdAt: proposal.createdAt,
    votingStartedAt: proposal.votingStartedAt || null,
    decidedAt: proposal.decidedAt || null,
    eligibleCount,
    majorityNeeded: need,
    yes,
    no,
    totalVotes: total,
    myVote,
    canVote,
    ...(includeVotes ? { voterIds: Object.keys(proposal.votes || {}) } : {})
  };
}

function createProposal({ text, author } = {}) {
  const clean = String(text || '').trim();
  if (!clean) throw Object.assign(new Error('Proposal text is required'), { status: 400 });
  if (clean.length > 4000) throw Object.assign(new Error('Proposal is too long'), { status: 400 });
  if (!author?.id) throw Object.assign(new Error('Sign in required'), { status: 401 });

  const store = readStore();
  const item = {
    id: crypto.randomUUID(),
    text: clean,
    authorId: author.id,
    authorName: author.name || author.loginName || 'Member',
    status: STATUS.SUBMITTED,
    createdAt: new Date().toISOString(),
    votingStartedAt: null,
    decidedAt: null,
    eligibleCount: 0,
    eligibleUserIds: [],
    votes: {},
    openedById: null,
    openedByName: null
  };
  store.proposals.unshift(item);
  store.proposals = store.proposals.slice(0, MAX_PROPOSALS);
  writeStore(store);
  return item;
}

function findProposal(id) {
  return readStore().proposals.find((p) => p.id === id) || null;
}

function listProposals({ status = null, limit = 50 } = {}) {
  let list = readStore().proposals.slice();
  if (status) list = list.filter((p) => p.status === status);
  return list
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
}

function openVote(id, { by, eligibleUsers = [] } = {}) {
  if (!by?.id) throw Object.assign(new Error('Sign in required'), { status: 401 });
  const store = readStore();
  const idx = store.proposals.findIndex((p) => p.id === id);
  if (idx === -1) throw Object.assign(new Error('Proposal not found'), { status: 404 });
  const proposal = store.proposals[idx];
  if (proposal.status !== STATUS.SUBMITTED) {
    throw Object.assign(new Error('Only submitted proposals can go to a league vote'), { status: 400 });
  }
  const eligible = (eligibleUsers || [])
    .filter((u) => u?.id)
    .map((u) => ({ id: u.id, name: u.name || u.loginName || 'Member' }));
  if (eligible.length < 1) {
    throw Object.assign(new Error('No eligible voters found'), { status: 400 });
  }

  proposal.status = STATUS.VOTING;
  proposal.votingStartedAt = new Date().toISOString();
  proposal.eligibleCount = eligible.length;
  proposal.eligibleUserIds = eligible.map((u) => u.id);
  proposal.votes = {};
  proposal.openedById = by.id;
  proposal.openedByName = by.name || by.loginName || 'Owner';
  store.proposals[idx] = proposal;
  writeStore(store);
  return proposal;
}

function maybeResolve(proposal) {
  if (!proposal || proposal.status !== STATUS.VOTING) return proposal;
  const need = majorityNeeded(proposal.eligibleCount);
  const { yes, no } = tally(proposal);
  if (yes >= need) {
    proposal.status = STATUS.PASSED;
    proposal.decidedAt = new Date().toISOString();
  } else if (no >= need) {
    proposal.status = STATUS.FAILED;
    proposal.decidedAt = new Date().toISOString();
  }
  return proposal;
}

function castVote(id, choice, { user } = {}) {
  if (!user?.id) throw Object.assign(new Error('Sign in required'), { status: 401 });
  const cleaned = String(choice || '').trim().toLowerCase();
  if (cleaned !== 'yes' && cleaned !== 'no') {
    throw Object.assign(new Error('Vote must be yes or no'), { status: 400 });
  }

  const store = readStore();
  const idx = store.proposals.findIndex((p) => p.id === id);
  if (idx === -1) throw Object.assign(new Error('Proposal not found'), { status: 404 });
  const proposal = store.proposals[idx];
  if (proposal.status !== STATUS.VOTING) {
    throw Object.assign(new Error('Voting is closed on this proposal'), { status: 400 });
  }
  const eligible = Array.isArray(proposal.eligibleUserIds) ? proposal.eligibleUserIds : [];
  if (eligible.length && !eligible.includes(user.id)) {
    throw Object.assign(new Error('You are not eligible to vote on this proposal'), { status: 403 });
  }
  proposal.votes = proposal.votes && typeof proposal.votes === 'object' ? proposal.votes : {};
  if (proposal.votes[user.id]) {
    throw Object.assign(new Error('You already voted'), { status: 400 });
  }
  proposal.votes[user.id] = {
    choice: cleaned,
    at: new Date().toISOString(),
    name: user.name || user.loginName || 'Member'
  };
  maybeResolve(proposal);
  store.proposals[idx] = proposal;
  writeStore(store);
  return proposal;
}

function dismissProposal(id, { by } = {}) {
  const store = readStore();
  const idx = store.proposals.findIndex((p) => p.id === id);
  if (idx === -1) throw Object.assign(new Error('Proposal not found'), { status: 404 });
  const proposal = store.proposals[idx];
  if (proposal.status !== STATUS.SUBMITTED) {
    throw Object.assign(new Error('Only submitted proposals can be dismissed'), { status: 400 });
  }
  proposal.status = STATUS.DISMISSED;
  proposal.decidedAt = new Date().toISOString();
  proposal.dismissedById = by?.id || null;
  store.proposals[idx] = proposal;
  writeStore(store);
  return proposal;
}

module.exports = {
  STATUS,
  createProposal,
  findProposal,
  listProposals,
  openVote,
  castVote,
  dismissProposal,
  publicProposal,
  majorityNeeded,
  tally
};
