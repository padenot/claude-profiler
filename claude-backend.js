// The Claude backend for the session picker. It discovers Claude Code's
// on-disk sessions and normalizes each one into the row shape consumed by the
// shared page renderer.

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  statSafe, activity, byLastActive, addUsage, addModels
} = require('./session-util.js');
const { cachedMap, fileStamp } = require('./row-cache.js');

function projectsDir() {
  return path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    'projects'
  );
}

// Every session file under ~/.claude/projects/<project>/<session-id>.jsonl.
// The per-session <session-id>/ directories next to them hold the sub-agent
// transcripts, and are walked by readSubagents rather than listed here.
function findSessionFiles(root = projectsDir()) {
  if (!fs.existsSync(root)) {
    return [];
  }

  const files = [];
  for (const project of fs.readdirSync(root)) {
    const dir = path.join(root, project);
    if (!statSafe(dir)?.isDirectory()) {
      continue;
    }

    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) {
        continue;
      }
      const file = path.join(dir, name);
      if (statSafe(file)?.isFile()) {
        files.push({ project, file });
      }
    }
  }

  return files;
}

// The project directory name is the working directory with its separators
// replaced by dashes, which is ambiguous — a real dash and a separator look the
// same. The entries record the actual `cwd`, so this is only the fallback for a
// session that has none.
function projectLabel(project) {
  return project.replace(/^-/, '/').replace(/-/g, '/');
}

// Sub-agent transcripts are the bulk of a session's bytes, so a session's size
// is only meaningful with them included. Summing the file sizes avoids reading
// 158MB of transcripts when all that is wanted is a number.
function subagentFiles(sessionFile) {
  const dir = path.join(
    path.dirname(sessionFile),
    path.basename(sessionFile, '.jsonl'),
    'subagents'
  );

  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir)
    .filter(name => name.startsWith('agent-') && name.endsWith('.jsonl'))
    .map(name => path.join(dir, name));
}

function subagentBytes(sessionFile) {
  const files = subagentFiles(sessionFile);
  return {
    bytes: files.reduce((sum, file) => sum + (statSafe(file)?.size || 0), 0),
    count: files.length
  };
}

// A row changes when the session or any of its sub-agents does.
function sessionStamp(sessionFile) {
  return [sessionFile, ...subagentFiles(sessionFile)]
    .map(file => fileStamp(statSafe(file)))
    .join(' ');
}

function emptyUsage() {
  return {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0
  };
}

// Claude can write several streaming snapshots for one request. As with the
// cost calculation, only the final snapshot belongs in the totals, and a call
// without a requestId is left out of both so that tokens and dollars agree.
function usageByModel(messages, totalCost) {
  const calls = new Map();
  for (const message of messages) {
    if (message.message?.usage && message.requestId) calls.set(message.requestId, message);
  }

  const models = {};
  const callsByModel = new Map();
  for (const message of calls.values()) {
    const model = message.message.model || 'Unknown model';
    const usage = models[model] ||= emptyUsage();
    if (!callsByModel.has(model)) callsByModel.set(model, []);
    callsByModel.get(model).push(message);
    const source = message.message.usage;
    usage.input_tokens += source.input_tokens || 0;
    usage.cache_creation_input_tokens += source.cache_creation_input_tokens ||
      (source.cache_creation?.ephemeral_5m_input_tokens || 0) +
      (source.cache_creation?.ephemeral_1h_input_tokens || 0);
    usage.cache_read_input_tokens += source.cache_read_input_tokens || 0;
    usage.output_tokens += source.output_tokens || 0;
  }
  for (const [model, modelCalls] of callsByModel) {
    models[model].cost = totalCost(modelCalls);
  }
  return models;
}

function totalUsage(models) {
  const usage = emptyUsage();
  for (const modelUsage of Object.values(models)) addUsage(usage, modelUsage);
  return usage;
}

// One row of the table. Everything here comes from a single pass over the
// session's own entries plus a stat of each sub-agent file. Sub-agent usage is
// folded in later alongside its cost, when those transcripts are read.
function summarizeSession({ project, file }, deps) {
  const { readJsonlFile, sessionTitle, conversationEntries, totalCost } = deps;

  const stat = statSafe(file);
  const entries = readJsonlFile(file);
  const agents = subagentBytes(file);

  const { first: firstTimestamp, last: lastTimestamp, active } = activity(entries);
  let cwd = null;
  let gitBranch = null;
  let version = null;
  for (const entry of entries) {
    // The last one wins: a session can change branch, and its final state is
    // the one worth showing.
    cwd = entry.cwd || cwd;
    gitBranch = entry.gitBranch || gitBranch;
    version = entry.version || version;
  }

  const messages = conversationEntries(entries);
  const models = usageByModel(messages, totalCost);
  const usage = totalUsage(models);

  return {
    provider: 'claude',
    id: path.basename(file, '.jsonl'),
    file,
    project,
    title: sessionTitle(entries),
    cwd: cwd || projectLabel(project),
    gitBranch: gitBranch || '',
    version: version || '',
    // The file's own mtime is the fallback for a session whose entries carry no
    // timestamp at all, so that sorting by date never has a hole in it.
    started: firstTimestamp || stat?.mtime.toISOString() || null,
    ended: lastTimestamp || stat?.mtime.toISOString() || null,
    active,
    messages: messages.length,
    entries: entries.length,
    bytes: (stat?.size || 0) + agents.bytes,
    subagents: agents.count,
    cost: totalCost(messages),
    tokens: Object.values(usage).reduce((sum, value) => sum + value, 0),
    usage,
    models,
    credits: null,
    profileAvailable: true
  };
}

// The sub-agents' own API calls. Kept separate from summarizeSession because
// it means reading every sub-agent transcript.
function subagentSummary(sessionFile, deps) {
  const { readSubagents, conversationEntries, totalCost } = deps;

  try {
    const result = { cost: 0, usage: emptyUsage(), models: {} };
    for (const agent of readSubagents(sessionFile)) {
      const messages = conversationEntries(agent.entries);
      const models = usageByModel(messages, totalCost);
      result.cost += totalCost(messages);
      addModels(result.models, models, emptyUsage);
      addUsage(result.usage, totalUsage(models));
    }
    return result;
  } catch {
    return { cost: 0, usage: emptyUsage(), models: {} };
  }
}

// One session's row, sub-agents included, or null when it has no place in the
// list. A file that fails to parse is skipped rather than taking the whole
// listing down with it: a session being written to can be caught mid-line.
function sessionRow(entry, deps, withSubagentCost = true) {
  let session;
  try {
    session = summarizeSession(entry, deps);
  } catch {
    return null;
  }

  // A session with no messages is one Claude Code opened and nothing came of
  // — there is nothing to profile in it.
  if (session.messages === 0) {
    return null;
  }

  if (withSubagentCost && session.subagents > 0) {
    const agents = subagentSummary(session.file, deps);
    session.cost += agents.cost;
    addUsage(session.usage, agents.usage);
    addModels(session.models, agents.models, emptyUsage);
    session.tokens = Object.values(session.usage)
      .reduce((sum, value) => sum + value, 0);
  }

  return session;
}

// Every session, newest first.
function listSessions(deps, { root, withSubagentCost = true } = {}) {
  return findSessionFiles(root)
    .map(entry => sessionRow(entry, deps, withSubagentCost))
    .filter(Boolean)
    .sort(byLastActive);
}

// The same, with the files read in parallel by a worker pool, and only those
// that changed since the last launch.
async function listSessionsInPool(pool, { root } = {}) {
  const rows = await cachedMap(pool, 'claude', findSessionFiles(root), {
    fileOf: entry => entry.file,
    stampOf: entry => sessionStamp(entry.file)
  });
  return rows.filter(Boolean).sort(byLastActive);
}

module.exports = {
  findSessionFiles,
  listSessions,
  listSessionsInPool,
  sessionRow,
  summarizeSession,
  projectLabel
};
