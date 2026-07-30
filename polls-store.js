const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'polls.json');

const AUDIENCE_ALL = 'all';
const AUDIENCE_CONFERENCE = 'conference';
const MAX_OPTIONS = 6;
const MIN_OPTIONS = 2;
const MAX_POLLS = 80;

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ polls: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { polls: Array.isArray(data.polls) ? data.polls : [] };
  } catch {
    return { polls: [] };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

function normalizeOptionText(text) {
  return String(text || '').trim();
}

function createPoll({
  question,
  options,
  audience = AUDIENCE_ALL,
  audienceConference = null,
  author
} = {}) {
  const cleanQuestion = String(question || '').trim();
  if (!cleanQuestion) {
    throw Object.assign(new Error('Poll question is required'), { status: 400 });
  }
  if (cleanQuestion.length > 240) {
    throw Object.assign(new Error('Question is too long'), { status: 400 });
  }
  if (!author?.id) {
    throw Object.assign(new Error('Sign in required'), { status: 401 });
  }

  const cleanedOptions = (Array.isArray(options) ? options : [])
    .map((o) => normalizeOptionText(typeof o === 'string' ? o : o?.text))
    .filter(Boolean);
  const unique = [...new Set(cleanedOptions.map((t) => t.toLowerCase()))];
  if (cleanedOptions.length < MIN_OPTIONS) {
    throw Object.assign(new Error(`Add at least ${MIN_OPTIONS} options`), { status: 400 });
  }
  if (cleanedOptions.length > MAX_OPTIONS) {
    throw Object.assign(new Error(`At most ${MAX_OPTIONS} options`), { status: 400 });
  }
  if (unique.length !== cleanedOptions.length) {
    throw Object.assign(new Error('Options must be unique'), { status: 400 });
  }
  for (const text of cleanedOptions) {
    if (text.length > 120) {
      throw Object.assign(new Error('Option text is too long'), { status: 400 });
    }
  }

  const audienceMode = String(audience || AUDIENCE_ALL).toLowerCase() === AUDIENCE_CONFERENCE
    ? AUDIENCE_CONFERENCE
    : AUDIENCE_ALL;
  let conference = null;
  if (audienceMode === AUDIENCE_CONFERENCE) {
    conference = String(audienceConference || '').trim().toLowerCase() || null;
    if (!conference) {
      throw Object.assign(new Error('Pick a conference for a limited poll'), { status: 400 });
    }
  }

  const store = readStore();
  const item = {
    id: crypto.randomUUID(),
    question: cleanQuestion,
    options: cleanedOptions.map((text) => ({
      id: crypto.randomUUID(),
      text
    })),
    audience: audienceMode,
    audienceConference: conference,
    status: 'open',
    createdById: author.id,
    createdByName: author.name || author.loginName || 'Admin',
    createdByRole: author.role || null,
    createdAt: new Date().toISOString(),
    closedAt: null,
    votes: {}
  };
  store.polls.unshift(item);
  store.polls = store.polls.slice(0, MAX_POLLS);
  writeStore(store);
  return item;
}

function findPoll(id) {
  return readStore().polls.find((p) => p.id === id) || null;
}

function closePoll(id, { by } = {}) {
  const store = readStore();
  const idx = store.polls.findIndex((p) => p.id === id);
  if (idx === -1) throw Object.assign(new Error('Poll not found'), { status: 404 });
  if (store.polls[idx].status === 'closed') return store.polls[idx];
  store.polls[idx].status = 'closed';
  store.polls[idx].closedAt = new Date().toISOString();
  store.polls[idx].closedById = by?.id || null;
  writeStore(store);
  return store.polls[idx];
}

function deletePoll(id) {
  const store = readStore();
  const before = store.polls.length;
  store.polls = store.polls.filter((p) => p.id !== id);
  if (store.polls.length === before) {
    throw Object.assign(new Error('Poll not found'), { status: 404 });
  }
  writeStore(store);
  return true;
}

function canUserVoteOnPoll(poll, { user, conferenceKey } = {}) {
  if (!poll || poll.status !== 'open') return false;
  if (!user?.id) return false;
  if (poll.audience !== AUDIENCE_CONFERENCE) return true;
  const required = String(poll.audienceConference || '').toLowerCase();
  if (!required) return true;
  // Site owners / commissioners can always vote.
  if (user.siteOwner || user.role === 'commissioner') return true;
  if (user.role === 'conference_admin' && String(user.conference || '').toLowerCase() === required) {
    return true;
  }
  return String(conferenceKey || '').toLowerCase() === required;
}

function castVote(pollId, optionId, { user, conferenceKey } = {}) {
  if (!user?.id) throw Object.assign(new Error('Sign in required'), { status: 401 });
  const store = readStore();
  const idx = store.polls.findIndex((p) => p.id === pollId);
  if (idx === -1) throw Object.assign(new Error('Poll not found'), { status: 404 });
  const poll = store.polls[idx];
  if (poll.status !== 'open') {
    throw Object.assign(new Error('This poll is closed'), { status: 400 });
  }
  if (!canUserVoteOnPoll(poll, { user, conferenceKey })) {
    throw Object.assign(new Error('Only members of that conference can vote on this poll'), { status: 403 });
  }
  const option = (poll.options || []).find((o) => o.id === optionId);
  if (!option) throw Object.assign(new Error('Invalid option'), { status: 400 });

  poll.votes = poll.votes && typeof poll.votes === 'object' ? poll.votes : {};
  poll.votes[user.id] = {
    optionId: option.id,
    conferenceKey: conferenceKey || null,
    at: new Date().toISOString()
  };
  store.polls[idx] = poll;
  writeStore(store);
  return poll;
}

function tally(poll) {
  const counts = {};
  for (const opt of poll.options || []) counts[opt.id] = 0;
  const votes = poll.votes && typeof poll.votes === 'object' ? poll.votes : {};
  for (const vote of Object.values(votes)) {
    const optionId = vote?.optionId || vote;
    if (counts[optionId] != null) counts[optionId] += 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { counts, total };
}

function publicPoll(poll, { user = null, conferenceKey = null, includeAdmin = false } = {}) {
  if (!poll) return null;
  const { counts, total } = tally(poll);
  const myVote = user?.id && poll.votes?.[user.id]
    ? (poll.votes[user.id].optionId || poll.votes[user.id])
    : null;
  const eligible = canUserVoteOnPoll(poll, { user, conferenceKey });
  const showResults = Boolean(myVote) || poll.status === 'closed' || includeAdmin;

  return {
    id: poll.id,
    question: poll.question,
    options: (poll.options || []).map((o) => ({
      id: o.id,
      text: o.text,
      votes: showResults ? (counts[o.id] || 0) : null
    })),
    audience: poll.audience,
    audienceConference: poll.audienceConference,
    status: poll.status,
    createdByName: poll.createdByName,
    createdAt: poll.createdAt,
    closedAt: poll.closedAt,
    totalVotes: showResults ? total : null,
    myVote,
    canVote: eligible && poll.status === 'open' && !myVote,
    eligible,
    showResults,
    ...(includeAdmin
      ? {
          createdById: poll.createdById,
          createdByRole: poll.createdByRole,
          voterCount: total
        }
      : {})
  };
}

function listPollsForBoard({ user = null, conferenceKey = null, includeClosed = true } = {}) {
  const polls = readStore().polls
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  return polls
    .filter((p) => {
      if (!includeClosed && p.status === 'closed') return false;
      if (p.audience !== AUDIENCE_CONFERENCE) return true;
      const required = String(p.audienceConference || '').toLowerCase();
      if (!required) return true;
      if (user?.siteOwner || user?.role === 'commissioner') return true;
      if (user?.role === 'conference_admin' && String(user.conference || '').toLowerCase() === required) {
        return true;
      }
      return String(conferenceKey || '').toLowerCase() === required;
    })
    .slice(0, 20)
    .map((p) => publicPoll(p, { user, conferenceKey }));
}

function listPollsAdmin() {
  return readStore().polls
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((p) => publicPoll(p, { includeAdmin: true }));
}

module.exports = {
  AUDIENCE_ALL,
  AUDIENCE_CONFERENCE,
  createPoll,
  closePoll,
  deletePoll,
  castVote,
  findPoll,
  listPollsForBoard,
  listPollsAdmin,
  publicPoll,
  canUserVoteOnPoll
};
