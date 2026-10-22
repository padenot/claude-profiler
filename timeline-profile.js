// The parts of a Firefox Profiler timeline profile that the Claude, Codex and
// DSH profiles share: the categories, the tables every thread interns into, the
// call stacks samples are attributed to, and the markers they draw. Codex and
// DSH tracks are built the same way from a transcript and per-response usage,
// and share the rest of what is here.

const { ACTIVE_GAP } = require('./session-util.js');

// Indexes into the timeline profile's category list. Idle is drawn as
// nothing, so an idle stretch reads as empty rather than as another kind of work.
const OTHER_CATEGORY = 0;
const MESSAGES_CATEGORY = 1;
const SUBAGENTS_CATEGORY = 2;
const TOOLS_CATEGORY = 3;
const FAILED_TOOLS_CATEGORY = 4;
const MODEL_CATEGORY = 5;
const IDLE_CATEGORY = 6;

const CATEGORIES = [
  {
    name: 'Other',
    color: 'grey',
    subcategories: ['Other']
  },
  {
    name: 'Messages',
    color: 'blue',
    subcategories: ['Other']
  },
  {
    name: 'Subagents',
    color: 'yellow',
    subcategories: ['Other']
  },
  {
    name: 'Tools',
    color: 'green',
    subcategories: ['Other']
  },
  {
    name: 'Failed tools',
    color: 'red',
    subcategories: ['Other']
  },
  {
    name: 'Model',
    color: 'purple',
    subcategories: ['Other']
  },
  {
    name: 'Idle',
    color: 'transparent',
    subcategories: ['Other']
  }
];

const TEXT_SCHEMA = {
  name: 'Text',
  tooltipLabel: '{marker.name}',
  tableLabel: '{marker.data.text}',
  chartLabel: '{marker.name}',
  display: ['marker-chart', 'marker-table'],
  fields: [
    {
      key: 'text',
      label: 'Content',
      format: 'string'
    }
  ]
};

const INTERVENTION_SCHEMA = {
  name: 'Intervention',
  tooltipLabel: '{marker.data.kind}',
  tableLabel: '{marker.name}: {marker.data.kind}',
  chartLabel: '{marker.data.kind}',
  display: ['marker-chart', 'marker-table'],
  fields: [
    {
      key: 'kind',
      label: 'Kind',
      format: 'string'
    },
    {
      key: 'text',
      label: 'Content',
      format: 'string'
    }
  ]
};

const TOOL_CALL_SCHEMA = {
  name: 'ToolCall',
  tooltipLabel: '{marker.data.name}',
  tableLabel: '{marker.data.name} — {marker.data.detail}',
  chartLabel: '{marker.data.detail}',
  display: ['marker-chart', 'marker-table'],
  fields: [
    {
      key: 'detail',
      label: 'Input',
      format: 'string'
    },
    {
      key: 'outputBytes',
      label: 'Output size',
      format: 'bytes'
    },
    {
      key: 'status',
      label: 'Status',
      format: 'string'
    }
  ]
};

const SUBAGENT_SCHEMA = {
  name: 'Subagent',
  tooltipLabel: '{marker.data.description}',
  tableLabel: '{marker.data.agentType}: {marker.data.description}',
  chartLabel: '{marker.data.description}',
  display: ['marker-chart', 'marker-table'],
  fields: [
    {
      key: 'description',
      label: 'Task',
      format: 'string'
    },
    {
      key: 'agentType',
      label: 'Agent type',
      format: 'string'
    },
    {
      key: 'agentId',
      label: 'Agent id',
      format: 'string'
    },
    {
      key: 'cost',
      label: 'Cost ($)',
      format: 'decimal'
    }
  ]
};

const ACTIVITY_SCHEMA = {
  name: 'Activity',
  tooltipLabel: '{marker.name}',
  tableLabel: '{marker.name} — {marker.data.prompt}',
  chartLabel: '{marker.data.prompt}',
  display: ['marker-chart', 'marker-table', 'timeline-overview'],
  fields: [
    {
      key: 'cost',
      label: 'Cost ($)',
      format: 'decimal'
    },
    {
      key: 'prompt',
      label: 'Prompt',
      format: 'string'
    }
  ]
};

// A loop rather than Math.min(...times): a long session with sub-agents has
// more timestamps than a spread call can pass as arguments. `timeOf` gives an
// entry's time as a date string or a millisecond count.
function timeRange(entries, timeOf = entry => entry.timestamp) {
  let start = Infinity;
  let end = -Infinity;
  for (const entry of entries) {
    const time = timeOf(entry);
    if (time === null || time === undefined) continue;
    const at = new Date(time).getTime();
    if (!Number.isFinite(at)) continue;
    if (at < start) start = at;
    if (at > end) end = at;
  }
  return start <= end ? { start, end } : null;
}

// The tables a v64 profile shares across every thread, plus the sources table
// each track's transcript is embedded in.
function createTimelineShared() {
  const shared = {
    strings: [],
    stringMap: new Map(),
    funcIndexes: new Map(),
    frameIndexes: new Map(),
    stackIndexes: new Map(),
    stackTable: { frame: [], prefix: [], length: 0 },
    frameTable: {
      address: [], inlineDepth: [], category: [], subcategory: [], func: [],
      nativeSymbol: [], innerWindowID: [], originalLocation: [], line: [],
      column: [], length: 0
    },
    funcTable: {
      name: [], isJS: [], relevantForJS: [], resource: [], source: [],
      lineNumber: [], columnNumber: [], originalLocation: [], length: 0
    },
    resourceTable: { lib: [], name: [], host: [], type: [], length: 0 },
    sources: { length: 0, id: [], filename: [], startLine: [], startColumn: [], sourceMapURL: [], content: [] },
    resourceBySource: new Map()
  };

  shared.intern = (text) => {
    if (!shared.stringMap.has(text)) {
      shared.stringMap.set(text, shared.strings.length);
      shared.strings.push(text);
    }
    return shared.stringMap.get(text);
  };

  // A source file whose text travels inside the profile, so the source view
  // needs nothing from the network and a saved profile stays readable.
  shared.registerSource = (fileName, content, resourceName) => {
    const index = shared.sources.length;
    shared.sources.id.push(null);
    shared.sources.filename.push(shared.intern(fileName));
    shared.sources.startLine.push(1);
    shared.sources.startColumn.push(1);
    shared.sources.sourceMapURL.push(null);
    shared.sources.content.push(content);
    shared.sources.length++;

    shared.resourceBySource.set(index, shared.resourceTable.length);
    shared.resourceTable.lib.push(null);
    shared.resourceTable.name.push(shared.intern(resourceName || fileName));
    shared.resourceTable.host.push(null);
    // ResourceType.Url: the "file" is a document, not a library.
    shared.resourceTable.type.push(5);
    shared.resourceTable.length++;

    return index;
  };

  shared.resourceForSource = (sourceIndex) => shared.resourceBySource.get(sourceIndex);

  return shared;
}

// The shared half of a v64 profile, once every track has interned into it.
function buildTimelineShared(shared) {
  return {
    stringArray: shared.strings,
    stackTable: {
      length: shared.stackTable.length,
      prefix: shared.stackTable.prefix,
      frame: shared.stackTable.frame
    },
    frameTable: {
      length: shared.frameTable.length,
      address: shared.frameTable.address,
      inlineDepth: shared.frameTable.inlineDepth,
      category: shared.frameTable.category,
      subcategory: shared.frameTable.subcategory,
      func: shared.frameTable.func,
      nativeSymbol: shared.frameTable.nativeSymbol,
      innerWindowID: shared.frameTable.innerWindowID,
      originalLocation: shared.frameTable.originalLocation,
      line: shared.frameTable.line,
      column: shared.frameTable.column
    },
    funcTable: {
      length: shared.funcTable.length,
      name: shared.funcTable.name,
      isJS: shared.funcTable.isJS,
      relevantForJS: shared.funcTable.relevantForJS,
      resource: shared.funcTable.resource,
      source: shared.funcTable.source,
      lineNumber: shared.funcTable.lineNumber,
      columnNumber: shared.funcTable.columnNumber,
      originalLocation: shared.funcTable.originalLocation
    },
    resourceTable: {
      length: shared.resourceTable.length,
      lib: shared.resourceTable.lib,
      name: shared.resourceTable.name,
      host: shared.resourceTable.host,
      type: shared.resourceTable.type
    },
    nativeSymbols: { length: 0, address: [], functionSize: [], libIndex: [], name: [] },
    sources: shared.sources,
    sourceLocationTable: { source: [], line: [], column: [], length: 0 }
  };
}

// Interns call stacks into the shared tables for samples attributed to one
// track's embedded transcript, `sourceIndex`.
function createStackBuilder(shared, sourceIndex) {
  const { stackTable, frameTable, funcTable } = shared;

  const funcIndexes = shared.funcIndexes;
  // The line is part of a func's identity, not of its name: two calls can be
  // spelled the same and sit at different places in the transcript, and sharing
  // a func would make both scroll to whichever is heavier.
  function addFunc(name, line) {
    const key = `${name}\u0000${sourceIndex}\u0000${line === undefined ? 'x' : line}`;
    if (!funcIndexes.has(key)) {
      funcIndexes.set(key, funcTable.length);
      funcTable.name.push(shared.intern(name));
      funcTable.isJS.push(false);
      funcTable.relevantForJS.push(false);
      funcTable.resource.push(shared.resourceForSource(sourceIndex));
      funcTable.source.push(sourceIndex);
      funcTable.lineNumber.push(null);
      funcTable.columnNumber.push(null);
      funcTable.originalLocation.push(null);
      funcTable.length++;
    }
    return funcIndexes.get(key);
  }

  const frameIndexes = shared.frameIndexes;
  function addFrame(name, category, line) {
    const key = `${name}\u0000${category}\u0000${sourceIndex}\u0000${line === undefined ? 'x' : line}`;
    if (!frameIndexes.has(key)) {
      frameIndexes.set(key, frameTable.length);
      frameTable.address.push(-1);
      frameTable.inlineDepth.push(0);
      frameTable.category.push(category);
      frameTable.subcategory.push(0);
      frameTable.func.push(addFunc(name, line));
      frameTable.nativeSymbol.push(null);
      frameTable.innerWindowID.push(null);
      frameTable.originalLocation.push(null);
      // Where this frame's content sits in the transcript, so double-clicking it
      // scrolls the source view there.
      frameTable.line.push(line === undefined ? null : line);
      frameTable.column.push(null);
      frameTable.length++;
    }
    return frameIndexes.get(key);
  }

  const stackIndexes = shared.stackIndexes;
  // A call node merges every frame sharing a func, and the source view scrolls
  // to the heaviest line within a node, so a name occurring in many places would
  // scroll somewhere unrelated to the box that was clicked. The location gets a
  // leaf frame of its own below the frames that aggregate by name: parents stay
  // merged, the leaf scrolls exactly.
  function addStack(frames, category, line, leafLabel) {
    const path = line === undefined ? frames : [...frames, leafLabel || `line ${line}`];

    let prefix = null;
    path.forEach((name, index) => {
      const isLeaf = index === path.length - 1;
      const frameIndex = addFrame(name, category, isLeaf ? line : undefined);
      const key = `${frameIndex}\u0000${prefix === null ? 'r' : prefix}`;
      if (!stackIndexes.has(key)) {
        stackIndexes.set(key, stackTable.length);
        stackTable.frame.push(frameIndex);
        stackTable.prefix.push(prefix);
        stackTable.length++;
      }
      prefix = stackIndexes.get(key);
    });
    return prefix;
  }

  return addStack;
}

// What a Codex or DSH track shows besides the markers Claude's share: turns,
// reasoning, per-response tokens, and the costs the provider billed.
const AGENT_SCHEMAS = [
  TEXT_SCHEMA, INTERVENTION_SCHEMA, TOOL_CALL_SCHEMA, SUBAGENT_SCHEMA, ACTIVITY_SCHEMA,
  { name: 'Turn', tooltipLabel: '{marker.name}', tableLabel: '{marker.name}: {marker.data.status}',
    chartLabel: '{marker.name}', display: ['marker-chart', 'marker-table', 'timeline-overview'],
    fields: [
      { key: 'status', label: 'Status', format: 'string' },
      { key: 'model', label: 'Model', format: 'string' },
      { key: 'effort', label: 'Effort', format: 'string' }
    ] },
  { name: 'Reasoning', tooltipLabel: '{marker.name}', tableLabel: '{marker.data.text}',
    chartLabel: '{marker.name}', display: ['marker-chart', 'marker-table'],
    fields: [{ key: 'text', label: 'Summary', format: 'string' }] },
  { name: 'ModelResponse', tooltipLabel: '{marker.data.model}',
    tableLabel: '{marker.data.model} ({marker.data.outputTokens} output tokens)',
    chartLabel: '{marker.data.model}', display: ['marker-chart', 'marker-table'], fields: [
      { key: 'model', label: 'Model', format: 'string' },
      { key: 'effort', label: 'Effort', format: 'string' },
      { key: 'inputTokens', label: 'Context tokens', format: 'integer' },
      { key: 'cachedInputTokens', label: 'Cached input', format: 'integer' },
      { key: 'outputTokens', label: 'Output tokens', format: 'integer' },
      { key: 'reasoningTokens', label: 'Reasoning tokens', format: 'integer' }
    ] },
  { name: 'ContextSize', tooltipLabel: '{marker.name}', display: [], fields: [
      { key: 'tokens', label: 'Context Size', format: 'integer' },
      { key: 'cachedTokens', label: 'Cached input', format: 'integer' },
      { key: 'uncachedTokens', label: 'Uncached input', format: 'integer' }
    ], graphs: [
      { key: 'tokens', color: 'blue', type: 'bar' },
      { key: 'cachedTokens', color: 'green', type: 'bar' }
    ] },
  { name: 'OutputTokens', tooltipLabel: '{marker.name}', display: [], fields: [
      { key: 'tokens', label: 'Output Tokens', format: 'integer' },
      { key: 'reasoningTokens', label: 'Reasoning Tokens', format: 'integer' }
    ], graphs: [
      { key: 'tokens', color: 'purple', type: 'bar' },
      { key: 'reasoningTokens', color: 'orange', type: 'bar' }
    ] },
  { name: 'Usage', tooltipLabel: '{marker.name}', tableLabel: '{marker.name}',
    display: ['marker-table'], fields: [
      { key: 'totalTokens', label: 'Total tokens', format: 'integer' },
      { key: 'inputTokens', label: 'Input tokens', format: 'integer' },
      { key: 'cachedTokens', label: 'Cached input', format: 'integer' },
      { key: 'outputTokens', label: 'Output tokens', format: 'integer' },
      { key: 'credits', label: 'Credits', format: 'decimal' },
      { key: 'cost', label: 'Cost ($)', format: 'decimal' }
    ] },
  { name: 'ThreadCost', tooltipLabel: '{marker.name}',
    tableLabel: '{marker.name}: ${marker.data.cost}', display: [], fields: [
      { key: 'cost', label: 'Thread cost ($)', format: 'decimal' },
      { key: 'credits', label: 'Thread credits', format: 'decimal' }
    ], graphs: [{ key: 'cost', color: 'blue', type: 'line' }] },
  { name: 'ResponseCost', tooltipLabel: '{marker.name}',
    tableLabel: '{marker.name}: ${marker.data.cost}', display: [], fields: [
      { key: 'cost', label: 'Response cost ($)', format: 'decimal' },
      { key: 'inputTokens', label: 'Context tokens', format: 'integer' },
      { key: 'cachedInputTokens', label: 'Cached input', format: 'integer' },
      { key: 'outputTokens', label: 'Output tokens', format: 'integer' }
    ], graphs: [{ key: 'cost', color: 'orange', type: 'bar' }] },
  { name: 'TotalCost', tooltipLabel: '{marker.name}',
    tableLabel: '{marker.name}: ${marker.data.cost}', display: [], fields: [
      { key: 'cost', label: 'Total cost ($)', format: 'decimal' },
      { key: 'credits', label: 'Total credits', format: 'decimal' }
    ], graphs: [{ key: 'cost', color: 'purple', type: 'line' }] }
];

// One track's markers, and how to add one at absolute times.
function createMarkerTable(shared, startTime) {
  const markers = { data: [], name: [], startTime: [], endTime: [], phase: [], category: [], length: 0 };
  const add = (name, start, end, category, data) => {
    markers.name.push(shared.intern(name));
    markers.startTime.push(Math.max(0, start - startTime));
    markers.endTime.push(Math.max(0, end - startTime));
    markers.phase.push(start === end ? 0 : 1);
    markers.category.push(category);
    markers.data.push(data);
    markers.length++;
  };
  return { markers, add };
}

// A cumulative cost graph: one marker per point, lasting until the next.
function addCostGraph(add, points, name, type, end) {
  points.forEach((point, pointIndex) => add(name, point.at,
    points[pointIndex + 1]?.at ?? end, OTHER_CATEGORY,
    { type, cost: point.cost, credits: point.credits }));
}

function costAtTime(points) {
  return time => [...points].reverse().find(point => point.at <= time)?.cost || 0;
}

// The running sum of several tracks' cumulative cost points.
function totalCostPoints(pointLists) {
  const deltas = [];
  for (const points of pointLists) {
    let previous = { cost: 0, credits: 0 };
    for (const point of points) {
      deltas.push({ at: point.at, cost: point.cost - previous.cost,
        credits: point.credits === undefined ? undefined : point.credits - previous.credits });
      previous = point;
    }
  }
  deltas.sort((a, b) => a.at - b.at);
  let cost = 0;
  let credits = 0;
  return deltas.map(delta => {
    cost += delta.cost;
    if (delta.credits !== undefined) credits += delta.credits;
    return { at: delta.at, cost, credits: delta.credits === undefined ? undefined : credits };
  });
}

// Embed a readable transcript of the track and put every logged contribution
// on an allocation-like sample stack under `rootName`, so the call tree, flame
// graph and source view work as they do on a Claude track. Gaps longer than
// the active-time threshold are filled with idle samples.
function transcriptSamples(shared, transcript, { title, subtitle, slug, rootName, startTime }) {
  const document = [`# ${title}`, `# ${subtitle}`, ''];
  for (const event of transcript) {
    event.line = document.length + 1;
    document.push(`[${new Date(event.at).toISOString()}] ${event.label}`);
    document.push(...event.text.split('\n'), '');
  }
  const sourceIndex = shared.registerSource(`${slug}.transcript.txt`, document.join('\n'));
  const addStack = createStackBuilder(shared, sourceIndex);
  const rows = transcript.map(event => ({
    time: event.at - startTime,
    stack: addStack([rootName, event.label], event.category, event.line),
    weight: Buffer.byteLength(event.text, 'utf8')
  }));
  const idleStack = addStack(['Idle'], IDLE_CATEGORY);
  for (let index = 1; index < transcript.length; index++) {
    const before = transcript[index - 1].at;
    const after = transcript[index].at;
    if (after - before > ACTIVE_GAP) {
      rows.push({ time: before - startTime + 1, stack: idleStack, weight: 0 });
      rows.push({ time: after - startTime - 1, stack: idleStack, weight: 0 });
    }
  }
  rows.sort((a, b) => a.time - b.time);
  return { length: rows.length, stack: rows.map(row => row.stack),
    time: rows.map(row => row.time), weight: rows.map(row => row.weight), weightType: 'bytes' };
}

// For a track with no explicit turns: work separated by less than the
// active-time threshold, grouped into activity spans.
function activitySpans(transcript) {
  const spans = [];
  for (const event of transcript) {
    const previous = spans.at(-1);
    if (!previous || event.at - previous.end > ACTIVE_GAP) {
      spans.push({ start: event.at, end: event.at, events: [event] });
    } else {
      previous.end = event.at;
      previous.events.push(event);
    }
  }
  return spans;
}

// The thread of one track. The root track, `index` 0, lasts as long as the
// whole profile so that its total-cost graph can reach the end.
function agentThread({ session, processName, index, trackStart, trackEnd, profileEnd, startTime,
  samples, markers }) {
  const end = (index === 0 ? profileEnd : trackEnd) - startTime;
  return {
    processType: 'default', processName,
    processStartupTime: trackStart - startTime, processShutdownTime: end,
    registerTime: trackStart - startTime, unregisterTime: end,
    pausedRanges: [], showMarkersInTimeline: true, name: session.title,
    isMainThread: true, pid: index, tid: index, samples, markers
  };
}

// The processed-format version is what the front end upgrades from. v64 is the
// first one whose sources table has a `content` column, where each track's
// transcript is embedded; older versions have that table rebuilt by the
// upgraders, which drops the text.
function profileMeta({ product, startTime, markerSchema }) {
  return {
    processType: 0,
    product,
    stackwalk: 0,
    version: 64,
    preprocessedProfileVersion: 64,
    symbolicationNotSupported: true,
    interval: 1,
    startTime,
    profilingStartTime: 0,
    markerSchema,
    categories: CATEGORIES,
    usesOnlyOneStackType: true
  };
}

module.exports = {
  OTHER_CATEGORY, MESSAGES_CATEGORY, SUBAGENTS_CATEGORY, TOOLS_CATEGORY,
  FAILED_TOOLS_CATEGORY, MODEL_CATEGORY, IDLE_CATEGORY,
  TEXT_SCHEMA, INTERVENTION_SCHEMA, TOOL_CALL_SCHEMA, SUBAGENT_SCHEMA, ACTIVITY_SCHEMA,
  AGENT_SCHEMAS, createTimelineShared, buildTimelineShared, createStackBuilder, profileMeta,
  timeRange, createMarkerTable, addCostGraph, costAtTime, totalCostPoints, transcriptSamples,
  activitySpans, agentThread
};
