// Picker rows kept on disk from one launch to the next. Almost every session in
// the list is one that has not been touched since the last launch, and reading
// it again would give the same row; only the files that changed are re-read.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function cacheDir() {
  return path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
    'claude-profiler'
  );
}

// A row is only as good as the code that summarized it: new pricing, or a fix
// to how usage is counted, has to show up without anyone clearing a cache. So
// every row made by another version of this code, or under another model
// override, is thrown away.
let version = null;
function codeVersion() {
  if (!version) {
    const hash = crypto.createHash('sha1');
    for (const name of fs.readdirSync(__dirname).filter(name => name.endsWith('.js')).sort()) {
      hash.update(name).update(fs.readFileSync(path.join(__dirname, name)));
    }
    hash.update(process.env.CLAUDE_PROFILER_MODEL || '');
    version = hash.digest('hex');
  }
  return version;
}

function readCache(file) {
  try {
    const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cache.version === codeVersion()) return cache.rows;
  } catch {
    // Missing, unreadable or from a crashed write: start over.
  }
  return {};
}

// Written to a temporary file and renamed into place, so that a second
// claude-profiler starting meanwhile reads either the old cache or the new one.
function writeCache(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.promises.mkdir(path.dirname(file), { recursive: true })
    .then(() => fs.promises.writeFile(temporary, text))
    .then(() => fs.promises.rename(temporary, file))
    .catch(() => fs.promises.rm(temporary, { force: true }).catch(() => {}));
}

// `pool.map`, for the items whose `stampOf` changed since the row was cached.
// A null row — a session not worth listing — is cached too, since finding that
// out costs as much as summarizing it.
async function cachedMap(pool, name, items, { fileOf, stampOf }) {
  const file = path.join(cacheDir(), `${name}-rows.json`);
  const cached = readCache(file);
  const stamps = items.map(stampOf);
  const stale = items.filter((item, i) => cached[fileOf(item)]?.stamp !== stamps[i]);
  const fresh = new Map(
    (await pool.map(name, stale, fileOf)).map((row, i) => [stale[i], row])
  );

  const rows = {};
  const result = items.map((item, i) => {
    const row = fresh.has(item) ? fresh.get(item) : cached[fileOf(item)].row;
    rows[fileOf(item)] = { stamp: stamps[i], row };
    return row;
  });

  // Serialized before returning: the callers fold sub-agents into their roots
  // in place, and what is cached has to be the row as summarized. Only the
  // files that still exist are kept.
  if (stale.length || Object.keys(cached).length !== items.length) {
    writeCache(file, JSON.stringify({ version: codeVersion(), rows }));
  }
  return result;
}

// What a file's stamp is made of: whether it changed is all a row cares about.
function fileStamp(stat) {
  return stat ? `${stat.size}:${stat.mtimeMs}` : '';
}

module.exports = { cachedMap, fileStamp };
