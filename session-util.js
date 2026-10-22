// Helpers shared by the Claude and Codex session backends, and by the profile
// builders that read the same files.

const fs = require('fs');

// A gap longer than this is the session waiting for its user rather than
// working. Sixty seconds is well past a slow tool call but well short of the
// pauses that make a wall-clock duration meaningless.
const ACTIVE_GAP = 60 * 1000;

// A session being written to can lose a file between readdir and stat, and a
// broken symlink throws the same way; neither is a reason to fail the listing.
function statSafe(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

// `mapLine` lets a caller rewrite a line's text before it is parsed.
function readJsonlFile(file, mapLine = line => line) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines.map((line, i) => {
    try {
      return JSON.parse(mapLine(line));
    } catch (error) {
      // The last write of a live session can be observed halfway through. Its
      // complete records are still a valid summary; corruption in the middle
      // of a file is not.
      if (i === lines.length - 1) return null;
      throw error;
    }
  }).filter(Boolean);
}

// When a session first and last did something, and how long it spent working.
// Wall clock is a poor measure of a session: one left open overnight reads as
// 142 hours of which six minutes were work. Summing only the gaps short
// enough to be the session working — the same distinction the timeline draws
// as its Idle category — is what makes the column comparable between rows.
function activity(entries) {
  let first = null;
  let last = null;
  let active = 0;
  let previous = null;
  for (const entry of entries) {
    if (!entry.timestamp) continue;
    first = first || entry.timestamp;
    last = entry.timestamp;
    const at = new Date(entry.timestamp).getTime();
    if (previous !== null && at > previous && at - previous <= ACTIVE_GAP) {
      active += at - previous;
    }
    previous = at;
  }
  return { first, last, active };
}

// Most recently active first: the session someone wants to profile is usually
// the one they were just in, which is not the one that was opened most
// recently — a session started last week can be the live one.
function byLastActive(a, b) {
  return (b.ended || '').localeCompare(a.ended || '');
}

// Adds the token counts `emptyUsage` lists from each model's usage into
// `into`, and the model's cost when it has one.
function addModels(into, models, emptyUsage) {
  for (const [model, usage] of Object.entries(models)) {
    const target = into[model] ||= emptyUsage();
    addUsage(target, usage, Object.keys(emptyUsage()));
    if (usage.cost !== undefined) target.cost = (target.cost || 0) + usage.cost;
  }
}

function addUsage(into, usage, keys = Object.keys(into)) {
  for (const key of keys) into[key] += usage?.[key] || 0;
}

module.exports = {
  statSafe, readJsonlFile, activity, byLastActive, addUsage, addModels
};
