const fs = require('fs');
const path = require('path');

const pkg = require('./package.json');

function shortSha(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return raw.slice(0, 7);
}

function readGitHead() {
  try {
    const gitDir = path.join(__dirname, '.git');
    const headPath = path.join(gitDir, 'HEAD');
    const head = fs.readFileSync(headPath, 'utf8').trim();
    if (head.startsWith('ref:')) {
      const ref = head.slice(4).trim();
      const refPath = path.join(gitDir, ref);
      return shortSha(fs.readFileSync(refPath, 'utf8').trim());
    }
    return shortSha(head);
  } catch {
    return null;
  }
}

const build =
  shortSha(process.env.RENDER_GIT_COMMIT) ||
  shortSha(process.env.GIT_COMMIT) ||
  readGitHead() ||
  String(pkg.version || '0.0.0');

module.exports = {
  version: pkg.version || '0.0.0',
  build,
  label: `Build ${build}`
};
