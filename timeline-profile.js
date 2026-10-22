// The parts of a Firefox Profiler timeline profile that Claude and Codex
// profiles share: the categories, the tables every thread interns into, the
// call stacks samples are attributed to, and the markers both kinds draw.

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
  createTimelineShared, buildTimelineShared, createStackBuilder, profileMeta
};
