// Turn DSH session logs into a processed Firefox Profiler profile. DSH records
// explicit turn, step and tool spans with millisecond timestamps, one usage
// snapshot per model response, and the OpenRouter generation id that response
// was billed under, so tracks carry tokens and dollars as well as what ran.

const {
  OTHER_CATEGORY, MESSAGES_CATEGORY, SUBAGENTS_CATEGORY, TOOLS_CATEGORY,
  FAILED_TOOLS_CATEGORY, MODEL_CATEGORY, AGENT_SCHEMAS, createTimelineShared,
  buildTimelineShared, profileMeta, timeRange, createMarkerTable, addCostGraph, costAtTime,
  totalCostPoints, transcriptSamples, activitySpans, agentThread
} = require('./timeline-profile.js');

function timestamp(entry) {
  return Number.isFinite(entry?.time) ? entry.time : null;
}

function textBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => block?.text || '').filter(Boolean).join('\n');
}

// A tool result carries its call id either on the result block or on the
// message's tool source, depending on the record generation.
function toolResultOf(entry) {
  const message = entry.data?.message || {};
  const content = message.content;
  const block = Array.isArray(content)
    ? content.find(candidate => candidate?.type === 'tool-result')
    : content;
  return {
    callId: block?.toolCallId || message.source?.callId || null,
    text: textBlocks(block?.content ?? content),
    failed: block?.isError === true || entry.data?.meta?.isError === true
  };
}

// The one line that identifies what a tool was asked to do, out of the JSON
// arguments DSH stores as a string.
function toolDetail(name, args) {
  let parsed = null;
  try {
    parsed = JSON.parse(args);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') return String(args || '').slice(0, 500);

  const parts = [];
  if (parsed.command) parts.push(parsed.command);
  else if (parsed.file_path) parts.push(parsed.file_path);
  else if (parsed.path) parts.push(parsed.path);
  if (parsed.pattern) parts.push(parsed.pattern);
  if (parts.length === 0 && parsed.description) parts.push(parsed.description);
  return (parts.join(' · ') || String(args || '')).slice(0, 500);
}

// Everything one session's records say about its timeline, in one pass. The
// current request config is carried forward because request/header has no turn
// or step of its own: it is what the step that follows is about to use.
function readTrack(entries) {
  let config = {};
  const calls = new Map();
  const results = new Map();
  const responses = [];
  const userMessages = [];
  const systemMessages = [];
  const errors = [];
  const turns = [];
  const openTurns = new Map();

  for (const entry of entries) {
    const at = timestamp(entry);
    switch (entry.type) {
      case 'request/header':
        config = entry.data?.header?.config || config;
        // turn/start precedes the request that describes it, so the open turn
        // learns its model and effort from the first header that follows.
        for (const open of openTurns.values()) {
          if (!open.config?.model) open.config = { ...config };
        }
        break;
      case 'request/context':
        config = { ...config, ...(entry.data || {}) };
        break;
      case 'user/message':
        if (at !== null && textBlocks(entry.data?.content)) {
          userMessages.push({ at, text: textBlocks(entry.data.content) });
        }
        break;
      case 'system/message': {
        const text = textBlocks(entry.data?.message) ||
          (typeof entry.data?.message === 'string' ? entry.data.message : '');
        if (at !== null && text) systemMessages.push({ at, text });
        break;
      }
      case 'assistant/message': {
        const message = entry.data?.message || {};
        const responseId = message.source?.replayState?.response?.responseId || null;
        // A replayed model call is the same generation recorded again.
        if (responseId && responses.some(response => response.responseId === responseId)) break;
        responses.push({
          at,
          turn: entry.data?.turn,
          step: entry.data?.step,
          model: message.source?.model || config.model || 'unknown',
          effort: config.reasoningEffort || '',
          usage: entry.data?.usage || {},
          responseId,
          blocks: Array.isArray(message.content) ? message.content : []
        });
        break;
      }
      case 'assistant/attempt': {
        const failure = entry.data?.stream
          ?.map(chunk => chunk?.chunk?.reason?.failure)
          .find(Boolean);
        if (at !== null) {
          errors.push({ at, text: failure?.message || 'model call failed' });
        }
        break;
      }
      case 'tool/call': {
        // A call without an id can have no result paired to it, but it still
        // needs a key of its own: a step can make several.
        const callId = entry.data?.callId || `unpaired-${calls.size}`;
        calls.set(callId, { callId, at, name: entry.data?.name || 'tool',
          arguments: entry.data?.arguments || '', turn: entry.data?.turn,
          step: entry.data?.step, config: { ...config } });
        break;
      }
      case 'tool/result': {
        const result = toolResultOf(entry);
        if (result.callId) results.set(result.callId, { at, ...result });
        break;
      }
      case 'turn/start':
        openTurns.set(entry.data?.turn, { at, config: { ...config } });
        break;
      case 'turn/end': {
        const open = openTurns.get(entry.data?.turn);
        if (at !== null) {
          turns.push({ start: open?.at ?? at, end: at, turn: entry.data?.turn,
            reason: entry.data?.reason?.kind || 'ended',
            config: open?.config || {} });
        }
        break;
      }
    }
  }

  return { calls, results, responses, userMessages, systemMessages, errors, turns };
}

// The readable transcript that becomes the sample stacks, so the call tree,
// flame graph and source view have the same content as the markers.
function transcriptEvents(track) {
  const events = [];
  for (const message of track.userMessages) {
    events.push({ at: message.at, label: 'User', text: message.text, category: MESSAGES_CATEGORY });
  }
  for (const message of track.systemMessages) {
    events.push({ at: message.at, label: 'System', text: message.text,
      category: OTHER_CATEGORY });
  }
  for (const error of track.errors) {
    events.push({ at: error.at, label: 'Error', text: error.text,
      category: FAILED_TOOLS_CATEGORY });
  }
  for (const response of track.responses) {
    if (response.at === null) continue;
    const text = textBlocks(response.blocks.filter(block => block?.type === 'text'));
    const reasoning = textBlocks(response.blocks.filter(block => block?.type === 'reasoning'));
    if (text) events.push({ at: response.at, label: 'DSH', text,
      category: MESSAGES_CATEGORY });
    if (reasoning) {
      events.push({ at: response.at, label: 'Reasoning', text: reasoning,
        category: MODEL_CATEGORY });
    }
  }
  for (const call of track.calls.values()) {
    const result = track.results.get(call.callId);
    const text = [toolDetail(call.name, call.arguments), result?.text || '']
      .filter(Boolean).join('\n\n');
    if (call.at === null || !text) continue;
    events.push({ at: result?.at ?? call.at, label: call.name, text,
      category: result?.failed ? FAILED_TOOLS_CATEGORY : TOOLS_CATEGORY });
  }
  return events.sort((a, b) => a.at - b.at);
}

function createDshProfile(tree, billing) {
  if (!tree?.length) throw new Error('No DSH session found');
  const ranges = tree.map(({ entries }) => timeRange(entries, timestamp)).filter(Boolean);
  if (!ranges.length) throw new Error('No timestamped events found in DSH session');
  const startTime = Math.min(...ranges.map(range => range.start));
  const profileEnd = Math.max(...ranges.map(range => range.end));
  const shared = createTimelineShared();

  const tracks = [...tree].sort((a, b) => {
    if (!a.session.parentId) return -1;
    if (!b.session.parentId) return 1;
    return String(a.session.started).localeCompare(String(b.session.started));
  });

  const costOf = (response) => {
    if (!response.responseId) return null;
    const row = billing.get(response.responseId);
    return row ? row.cost : null;
  };

  // Cumulative dollars over each track. A generation the API did not return
  // contributes nothing rather than a fabricated zero, and leaves the track
  // without a cost graph.
  const trackData = tracks.map(({ session, entries }) => {
    const track = readTrack(entries);
    // A track with no timestamped record of its own spans the whole profile.
    const { start: trackStart, end: trackEnd } =
      timeRange(entries, timestamp) || { start: startTime, end: profileEnd };
    const responses = track.responses.filter(response => response.at !== null)
      .sort((a, b) => a.at - b.at);

    let cumulative = 0;
    let known = true;
    const costPoints = [{ at: trackStart, cost: 0 }];
    for (const response of responses) {
      const cost = costOf(response);
      if (cost === null) known = false;
      else {
        cumulative += cost;
        costPoints.push({ at: response.at, cost: cumulative });
      }
    }

    return { session, track, trackStart, trackEnd, responses,
      costPoints: known ? costPoints : null, cost: known ? cumulative : null };
  });

  // A session-wide figure is only honest when every track was billed; a
  // partial total would read as cheaper than the session was.
  const totalPoints = trackData.every(data => data.costPoints) &&
    totalCostPoints(trackData.map(data => data.costPoints));

  const threads = trackData.map((data, index) => {
    const { session, track, trackStart, trackEnd, responses, costPoints } = data;
    const { markers, add } = createMarkerTable(shared, startTime);
    const costAt = costPoints && costAtTime(costPoints);

    const transcript = transcriptEvents(track);
    const samples = transcriptSamples(shared, transcript, {
      title: session.title, subtitle: session.cwd || 'DSH', rootName: 'DSH context', startTime,
      slug: session.id.replace(/[^A-Za-z0-9-]/g, '').slice(0, 60) || `session-${index}`
    });

    for (const message of track.userMessages) {
      add('User', message.at, message.at, MESSAGES_CATEGORY, { type: 'Text', text: message.text });
    }
    for (const message of track.systemMessages) {
      add('System', message.at, message.at, OTHER_CATEGORY, { type: 'Text', text: message.text });
    }
    for (const error of track.errors) {
      add('Error', error.at, error.at, FAILED_TOOLS_CATEGORY,
        { type: 'Intervention', kind: 'Error', text: error.text });
    }

    // Tool spans: the call is the start, its result the end. A call still
    // waiting for its result is kept as a pending point rather than dropped.
    for (const [callId, call] of track.calls) {
      if (call.at === null) continue;
      const result = track.results.get(callId);
      const end = result?.at ?? call.at;
      const output = result?.text || '';
      add(call.name, call.at, end, result?.failed ? FAILED_TOOLS_CATEGORY : TOOLS_CATEGORY, {
        type: 'ToolCall',
        name: call.name,
        detail: toolDetail(call.name, call.arguments),
        status: result ? (result.failed ? 'error' : 'complete') : 'pending',
        outputBytes: Buffer.byteLength(output, 'utf8')
      });
    }

    // Turns are DSH's explicit activity spans; the overview keeps a prompt and
    // the dollars spent inside each one.
    const turnStart = new Map(track.turns.map(turn => [turn.turn, turn.start]));
    let previousResponse = trackStart;
    responses.forEach((response, responseIndex) => {
      const next = responses[responseIndex + 1]?.at ?? trackEnd;
      const begin = Math.max(trackStart, turnStart.get(response.turn) ?? previousResponse);
      previousResponse = response.at;
      const usage = response.usage;
      // DSH's inputTokens excludes cache reads; the context is both.
      const contextTokens = (usage.inputTokens || 0) + (usage.cacheReadTokens || 0);
      const text = textBlocks(response.blocks.filter(block => block?.type === 'text'));
      const reasoning = textBlocks(response.blocks.filter(block => block?.type === 'reasoning'));
      if (text) add('DSH', response.at, response.at, MESSAGES_CATEGORY, { type: 'Text', text });
      if (reasoning) {
        add('Reasoning', begin, response.at, MODEL_CATEGORY, { type: 'Reasoning', text: reasoning });
      }
      add(response.model, begin, response.at, MODEL_CATEGORY, {
        type: 'ModelResponse', model: response.model, effort: response.effort,
        inputTokens: contextTokens,
        cachedInputTokens: usage.cacheReadTokens || 0,
        outputTokens: usage.outputTokens || 0,
        reasoningTokens: usage.reasoningTokens || 0
      });
      add('Context Size', response.at, next, MESSAGES_CATEGORY, { type: 'ContextSize',
        tokens: contextTokens,
        cachedTokens: usage.cacheReadTokens || 0,
        uncachedTokens: usage.inputTokens || 0 });
      add('Output Tokens', begin, response.at, MODEL_CATEGORY, { type: 'OutputTokens',
        tokens: usage.outputTokens || 0,
        reasoningTokens: usage.reasoningTokens || 0 });
      const cost = costOf(response);
      if (cost !== null) {
        add('Response Cost ($)', begin, response.at, MODEL_CATEGORY, { type: 'ResponseCost',
          cost, inputTokens: contextTokens,
          cachedInputTokens: usage.cacheReadTokens || 0,
          outputTokens: usage.outputTokens || 0 });
      }
    });

    for (const turn of track.turns) {
      add('Turn', turn.start, Math.max(turn.start + 1, turn.end), MODEL_CATEGORY, { type: 'Turn',
        status: turn.reason, model: turn.config.model || session.model || 'unknown',
        effort: turn.config.reasoningEffort || 'unknown' });
    }

    // The overview: DSH's turns, or for a session with no explicit turn
    // records, work separated by less than a minute, as the Codex profile does.
    const spans = track.turns.length ? track.turns : activitySpans(transcript);
    for (const span of spans) {
      const prompt = transcript.find(event =>
        event.label === 'User' && event.at >= span.start && event.at <= span.end)?.text || '';
      add('Activity', span.start, Math.max(span.start + 1, span.end), MESSAGES_CATEGORY, {
        type: 'Activity', prompt: prompt.replace(/\s+/g, ' ').slice(0, 300),
        cost: costAt && Math.max(0, costAt(span.end) - costAt(span.start))
      });
    }

    for (const child of trackData.filter(candidate =>
      candidate.session.parentId === session.id)) {
      const childStart = Date.parse(child.session.started) || trackStart;
      const childEnd = Date.parse(child.session.ended) || childStart;
      add('Subagent', childStart, childEnd, SUBAGENTS_CATEGORY, { type: 'Subagent',
        agentType: 'agent', description: child.session.title, agentId: child.session.id,
        cost: child.cost ?? undefined });
    }

    const usage = session.usage || {};
    add('Usage', trackEnd, trackEnd, OTHER_CATEGORY, { type: 'Usage',
      totalTokens: usage.totalTokens || 0,
      inputTokens: usage.inputTokens || 0,
      cachedTokens: usage.cacheReadTokens || 0,
      outputTokens: usage.outputTokens || 0,
      cost: data.cost ?? undefined });
    if (costPoints) addCostGraph(add, costPoints, 'Thread Cost ($)', 'ThreadCost', trackEnd);
    if (index === 0 && totalPoints) {
      addCostGraph(add, totalPoints, 'Total Cost ($)', 'TotalCost', profileEnd);
    }

    return agentThread({ session, processName: session.cwd || 'DSH', index, trackStart,
      trackEnd, profileEnd, startTime, samples, markers });
  });

  return {
    meta: profileMeta({ product: 'DSH', startTime, markerSchema: AGENT_SCHEMAS }),
    libs: [], threads, shared: buildTimelineShared(shared), counters: []
  };
}

module.exports = { createDshProfile };
