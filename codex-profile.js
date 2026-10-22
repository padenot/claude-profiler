// Turn Codex rollout JSONL into a processed Firefox Profiler profile. Modern
// rollouts record completed items with exact start/end times; older point
// events are kept as text markers so their history remains inspectable too.

const { ACTIVE_GAP } = require('./session-util.js');
const { isBillingPlaceholder, legacyDuplicates } = require('./codex-backend.js');
const {
  OTHER_CATEGORY, MESSAGES_CATEGORY, SUBAGENTS_CATEGORY, TOOLS_CATEGORY,
  FAILED_TOOLS_CATEGORY, MODEL_CATEGORY, IDLE_CATEGORY,
  TEXT_SCHEMA, INTERVENTION_SCHEMA, TOOL_CALL_SCHEMA, SUBAGENT_SCHEMA,
  ACTIVITY_SCHEMA, createTimelineShared, buildTimelineShared, createStackBuilder, profileMeta,
  timeRange
} = require('./timeline-profile.js');

function timestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const time = typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function durationMs(duration) {
  if (!duration || typeof duration !== 'object') return 0;
  return (duration.secs || 0) * 1000 + (duration.nanos || 0) / 1000000;
}

function textBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => block?.text || block?.input_text || block?.output_text || '')
    .filter(Boolean).join('\n');
}

function itemText(item) {
  return textBlocks(item.content) || textBlocks(item.summary_text) ||
    textBlocks(item.raw_content) || '';
}

function toolDetail(item) {
  if (Array.isArray(item.command)) return item.command.join(' ');
  if (typeof item.command === 'string') return item.command;
  if (item.server || item.tool) return [item.server, item.tool].filter(Boolean).join('.');
  if (item.action || item.query) return [item.action, item.query].filter(Boolean).join(': ');
  if (item.changes) return JSON.stringify(item.changes);
  return '';
}

function usageOf(entries) {
  let usage = null;
  for (const entry of entries) {
    if (entry.type === 'token_usage_record' && entry.payload?.thread_token_usage) {
      usage = entry.payload.thread_token_usage;
    } else if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' &&
               entry.payload.info?.total_token_usage) {
      usage = entry.payload.info.total_token_usage;
    }
  }
  return usage || {};
}

function usageSnapshots(entries) {
  const snapshots = [];
  for (const entry of entries) {
    let usage;
    if (entry.type === 'token_usage_record') usage = entry.payload?.thread_token_usage;
    if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
      usage = entry.payload.info?.total_token_usage;
    }
    const at = timestamp(entry.timestamp);
    if (usage && at !== null) snapshots.push({ at, tokens: usage.total_tokens || 0 });
  }
  return snapshots;
}

function responseUsage(entries, isDuplicate) {
  const records = [];
  let lastLegacyTotal = null;
  for (const entry of entries) {
    const at = timestamp(entry.timestamp);
    if (at === null) continue;
    if (entry.type === 'token_usage_record' && entry.payload?.usage) {
      records.push({ at, turnId: entry.payload.turn_id,
        responseId: entry.payload.response_id, usage: entry.payload.usage });
    } else if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' &&
               entry.payload.info?.last_token_usage && !isDuplicate(entry)) {
      const total = entry.payload.info.total_token_usage?.total_tokens;
      // Old logs repeat token_count after tool events. A changed cumulative
      // total identifies the actual model response that last_token_usage names.
      if (total !== lastLegacyTotal) {
        records.push({ at, turnId: null, responseId: null,
          usage: entry.payload.info.last_token_usage });
        lastLegacyTotal = total;
      }
    }
  }
  return records;
}

function transcriptEvents(entries, isDuplicate) {
  const events = [];
  for (const entry of entries) {
    const at = timestamp(entry.timestamp);
    if (at === null || entry.type !== 'event_msg') continue;
    const payload = entry.payload || {};
    if (isDuplicate(entry)) continue;
    if (payload.type === 'item_completed' && payload.item) {
      const item = payload.item;
      const end = timestamp(payload.completed_at_ms) ?? at;
      let label = item.type;
      let text = itemText(item);
      let category = MODEL_CATEGORY;
      if (item.type === 'UserMessage') { label = 'User'; category = MESSAGES_CATEGORY; }
      if (item.type === 'AgentMessage') { label = 'Codex'; category = MESSAGES_CATEGORY; }
      if (['CommandExecution', 'McpToolCall', 'FileChange', 'WebSearch', 'Extension']
        .includes(item.type)) {
        category = TOOLS_CATEGORY;
        const output = item.stdout || item.stderr || item.aggregated_output || item.formatted_output || '';
        text = [toolDetail(item), typeof output === 'string' ? output : JSON.stringify(output)]
          .filter(Boolean).join('\n\n');
      }
      if (item.type === 'ContextCompaction') text = 'Context window compacted.';
      if (item.type === 'SubAgentActivity') {
        label = 'Subagent'; category = SUBAGENTS_CATEGORY;
        text = [item.kind, item.agent_path, item.agent_thread_id].filter(Boolean).join(' — ');
      }
      if (text) events.push({ at: end, label, text, category });
    } else if (payload.type === 'user_message' || payload.type === 'agent_message') {
      events.push({ at, label: payload.type === 'user_message' ? 'User' : 'Codex',
        text: String(payload.message || ''), category: MESSAGES_CATEGORY });
    } else if (payload.type === 'agent_reasoning') {
      events.push({ at, label: 'Reasoning', text: String(payload.text || ''),
        category: MODEL_CATEGORY });
    } else if (['exec_command_end', 'patch_apply_end', 'web_search_end', 'mcp_tool_call_end']
      .includes(payload.type)) {
      const detail = payload.command || payload.query || payload.invocation ||
        (payload.changes ? JSON.stringify(payload.changes) : '');
      const output = payload.stdout || payload.stderr || payload.aggregated_output ||
        payload.formatted_output || payload.result || '';
      events.push({ at, label: payload.type.replace(/_end$/, ''), category: TOOLS_CATEGORY,
        text: [typeof detail === 'string' ? detail : JSON.stringify(detail),
          typeof output === 'string' ? output : JSON.stringify(output)].filter(Boolean).join('\n\n') });
    } else if (payload.type === 'context_compacted') {
      events.push({ at, label: 'Context compaction', category: MODEL_CATEGORY,
        text: 'Context window compacted.' });
    } else if (payload.type === 'error' || payload.type === 'thread_rolled_back') {
      events.push({ at, label: 'Intervention', category: FAILED_TOOLS_CATEGORY,
        text: String(payload.message || payload.reason || payload.type) });
    }
  }
  return events.sort((a, b) => a.at - b.at);
}

function costPoints(entries, billing, trackStart, trackEnd) {
  const dollars = billing.estimated_usage_usd_micros / 1000000;
  const credits = billing.estimated_usage_credits_micros / 1000000;
  const snapshots = usageSnapshots(entries);
  const finalTokens = snapshots.at(-1)?.tokens || usageOf(entries).total_tokens || 0;
  const points = [{ at: trackStart, cost: 0, credits: 0 }];

  for (const snapshot of snapshots) {
    const share = finalTokens > 0 ? Math.min(1, snapshot.tokens / finalTokens) : 0;
    const point = { at: snapshot.at, cost: dollars * share, credits: credits * share };
    if (points.at(-1).at === point.at) points[points.length - 1] = point;
    else points.push(point);
  }

  // The endpoint is authoritative even if a final local usage record is
  // missing or precedes the last event in the rollout.
  const final = { at: trackEnd, cost: dollars, credits };
  if (points.at(-1).at === trackEnd) points[points.length - 1] = final;
  else points.push(final);
  return points;
}

function markerSchemas() {
  return [
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
}

function createCodexProfile(tree, billing) {
  if (!tree?.length) throw new Error('No Codex thread found');
  const ranges = tree.map(({ entries }) => timeRange(entries)).filter(Boolean);
  if (!ranges.length) throw new Error('No timestamped events found in Codex rollout');
  const startTime = Math.min(...ranges.map(range => range.start));
  const profileEnd = Math.max(...ranges.map(range => range.end));
  // A thread with no timestamped entry of its own spans the whole profile.
  const trackRange = entries => timeRange(entries) || { start: startTime, end: profileEnd };
  const shared = createTimelineShared();

  const tracks = [...tree].sort((a, b) => {
    if (!a.session.parentId) return -1;
    if (!b.session.parentId) return 1;
    return String(a.session.started).localeCompare(String(b.session.started));
  });

  // Billing is best-effort: offline, signed out, or for an old thread the
  // backend has no row, or an all-zero placeholder for a thread that did use
  // tokens. Such a thread keeps its timeline but has no cost graphs, and the
  // root's total is only drawn when every thread has a cost.
  const billed = new Map();
  for (const { session, entries } of tracks) {
    const row = billing.get(session.id);
    if (row && !isBillingPlaceholder(usageOf(entries).total_tokens,
      row.estimated_usage_usd_micros, row.estimated_usage_credits_micros)) {
      billed.set(session.id, row);
    }
  }

  const costs = new Map();
  const totalDeltas = [];
  for (const track of tracks) {
    const billingRow = billed.get(track.session.id);
    if (!billingRow) continue;
    const { start, end } = trackRange(track.entries);
    const points = costPoints(track.entries, billingRow, start, end);
    costs.set(track.session.id, points);
    let previousCost = 0;
    let previousCredits = 0;
    for (const point of points) {
      totalDeltas.push({ at: point.at, cost: point.cost - previousCost,
        credits: point.credits - previousCredits });
      previousCost = point.cost;
      previousCredits = point.credits;
    }
  }
  totalDeltas.sort((a, b) => a.at - b.at);
  let totalCost = 0;
  let totalCredits = 0;
  const totalPoints = billed.size === tracks.length && totalDeltas.map(point => {
    totalCost += point.cost;
    totalCredits += point.credits;
    return { at: point.at, cost: totalCost, credits: totalCredits };
  });

  const threads = tracks.map(({ session, entries }, index) => {
    const { start: trackStart, end: trackEnd } = trackRange(entries);
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
    const addCostGraph = (points, name, type, end) => {
      points.forEach((point, pointIndex) => add(name, point.at,
        points[pointIndex + 1]?.at ?? end, OTHER_CATEGORY,
        { type, cost: point.cost, credits: point.credits }));
    };

    // Embed a readable transcript and put every logged contribution on an
    // allocation-like sample stack. This gives Codex the same useful call-tree,
    // flame-graph and source-view surfaces as a Claude profile.
    const isDuplicate = legacyDuplicates(entries);
    const transcript = transcriptEvents(entries, isDuplicate);
    const document = [`# ${session.title}`, `# ${session.cwd || 'Codex'}`, ''];
    for (const event of transcript) {
      event.line = document.length + 1;
      document.push(`[${new Date(event.at).toISOString()}] ${event.label}`);
      document.push(...event.text.split('\n'), '');
    }
    const slug = session.id.replace(/[^A-Za-z0-9-]/g, '').slice(0, 60) || `thread-${index}`;
    const sourceIndex = shared.registerSource(`${slug}.transcript.txt`, document.join('\n'));
    const addStack = createStackBuilder(shared, sourceIndex);
    const sampleRows = transcript.map(event => ({
      time: event.at - startTime,
      stack: addStack(['Codex context', event.label], event.category, event.line),
      weight: Buffer.byteLength(event.text, 'utf8')
    }));
    const idleStack = addStack(['Idle'], IDLE_CATEGORY);
    for (let sampleIndex = 1; sampleIndex < transcript.length; sampleIndex++) {
      const before = transcript[sampleIndex - 1].at;
      const after = transcript[sampleIndex].at;
      if (after - before > ACTIVE_GAP) {
        sampleRows.push({ time: before - startTime + 1, stack: idleStack, weight: 0 });
        sampleRows.push({ time: after - startTime - 1, stack: idleStack, weight: 0 });
      }
    }
    sampleRows.sort((a, b) => a.time - b.time);

    const contextByTurn = new Map(entries.filter(e => e.type === 'turn_context')
      .map(e => [e.payload?.turn_id, e.payload || {}]));
    const turnStarts = new Map();
    const explicitActivity = [];
    for (const entry of entries) {
      const at = timestamp(entry.timestamp);
      if (at === null || entry.type !== 'event_msg') continue;
      const payload = entry.payload || {};
      if (isDuplicate(entry)) continue;
      if (payload.type === 'task_started') turnStarts.set(payload.turn_id, at);
      if (payload.type === 'task_complete' || payload.type === 'turn_aborted') {
        const begin = timestamp(payload.started_at ? payload.started_at * 1000 : null) ??
          turnStarts.get(payload.turn_id) ?? at;
        const context = contextByTurn.get(payload.turn_id) || {};
        explicitActivity.push({ start: begin, end: at });
        add('Turn', begin, at, MODEL_CATEGORY, { type: 'Turn',
          status: payload.type === 'task_complete' ? 'complete' : (payload.reason || 'aborted'),
          model: context.model || session.model || 'unknown', effort: context.effort || 'unknown' });
      }

      if (payload.type === 'item_completed' && payload.item) {
        const item = payload.item;
        const end = timestamp(payload.completed_at_ms) ?? at;
        const begin = timestamp(payload.started_at_ms) ?? Math.max(trackStart, end - durationMs(item.duration));
        if (item.type === 'UserMessage' || item.type === 'AgentMessage') {
          const text = itemText(item);
          if (text) add(item.type === 'UserMessage' ? 'User' : 'Codex', end, end, MESSAGES_CATEGORY,
            { type: 'Text', text });
        } else if (item.type === 'Reasoning') {
          add('Reasoning', begin, end, MODEL_CATEGORY, { type: 'Reasoning', text: itemText(item) });
        } else if (['CommandExecution', 'McpToolCall', 'FileChange', 'WebSearch', 'Extension']
          .includes(item.type)) {
          const output = item.stdout || item.stderr || item.aggregated_output || item.formatted_output || '';
          const failed = item.status && !['completed', 'success'].includes(item.status);
          add(item.type, begin, end, failed ? FAILED_TOOLS_CATEGORY : TOOLS_CATEGORY,
            { type: 'ToolCall', name: item.type, detail: toolDetail(item).slice(0, 500), status: item.status || 'complete',
              outputBytes: Buffer.byteLength(typeof output === 'string' ? output : JSON.stringify(output)) });
        } else if (item.type === 'ContextCompaction') {
          add('Context compaction', end, end, MODEL_CATEGORY,
            { type: 'Text', text: 'Codex compacted the model context window.' });
        } else if (item.type === 'SubAgentActivity') {
          add('Subagent activity', end, end, SUBAGENTS_CATEGORY, { type: 'Text',
            text: [item.kind, item.agent_path, item.agent_thread_id].filter(Boolean).join(' — ') });
        }
      } else if (payload.type === 'user_message' || payload.type === 'agent_message') {
        add(payload.type === 'user_message' ? 'User' : 'Codex', at, at, MESSAGES_CATEGORY,
          { type: 'Text', text: String(payload.message || '') });
      } else if (payload.type === 'agent_reasoning') {
        add('Reasoning', at, at, MODEL_CATEGORY,
          { type: 'Reasoning', text: String(payload.text || '') });
      } else if (['exec_command_end', 'patch_apply_end', 'web_search_end', 'mcp_tool_call_end']
        .includes(payload.type)) {
        const elapsed = typeof payload.duration === 'number'
          ? payload.duration * 1000 : durationMs(payload.duration);
        const detail = payload.command || payload.query || payload.invocation ||
          (payload.changes ? JSON.stringify(payload.changes) : '');
        const output = payload.stdout || payload.stderr || payload.aggregated_output ||
          payload.formatted_output || payload.result || '';
        const failed = payload.success === false || payload.status === 'failed' ||
          (Number.isInteger(payload.exit_code) && payload.exit_code !== 0);
        add(payload.type.replace(/_end$/, ''), Math.max(trackStart, at - elapsed), at,
          failed ? FAILED_TOOLS_CATEGORY : TOOLS_CATEGORY, { type: 'ToolCall',
            name: payload.type.replace(/_end$/, ''),
            detail: (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500),
            status: failed ? 'error' : (payload.status || 'complete'),
            outputBytes: Buffer.byteLength(typeof output === 'string' ? output : JSON.stringify(output)) });
      } else if (payload.type === 'context_compacted') {
        add('Context compaction', at, at, MODEL_CATEGORY,
          { type: 'Text', text: 'Codex compacted the model context window.' });
      } else if (payload.type === 'error' || payload.type === 'thread_rolled_back') {
        add(payload.type === 'error' ? 'Error' : 'Thread rolled back', at, at, FAILED_TOOLS_CATEGORY,
          { type: 'Intervention', kind: payload.type === 'error' ? 'Error' : 'Thread rolled back',
            text: String(payload.message || payload.reason || payload.type) });
      }
    }

    for (const child of tracks.filter(track => track.session.parentId === session.id)) {
      const childStart = timestamp(child.session.started) ?? trackStart;
      const childEnd = timestamp(child.session.ended) ?? childStart;
      add('Subagent', childStart, childEnd, SUBAGENTS_CATEGORY, { type: 'Subagent',
        // Like a Claude sub-agent with no type recorded: the rollout names none.
        agentType: 'agent', description: child.session.title, agentId: child.session.id,
        cost: costs.get(child.session.id)?.at(-1).cost });
    }

    const responses = responseUsage(entries, isDuplicate);
    const threadCostPoints = costs.get(session.id);
    const costAt = time => [...threadCostPoints].reverse()
      .find(point => point.at <= time)?.cost || 0;
    const contexts = entries.filter(entry => entry.type === 'turn_context')
      .map(entry => ({ at: timestamp(entry.timestamp), payload: entry.payload || {} }))
      .filter(context => context.at !== null);
    responses.forEach((response, responseIndex) => {
      const next = responses[responseIndex + 1]?.at ?? trackEnd;
      const previous = responses[responseIndex - 1]?.at ??
        turnStarts.get(response.turnId) ?? trackStart;
      const produced = transcript.filter(event =>
        event.at > previous && event.at <= response.at &&
        (event.category === 5 || event.label === 'Codex'));
      const responseStart = produced.length ? produced[0].at : previous;
      const context = contextByTurn.get(response.turnId) ||
        [...contexts].reverse().find(candidate => candidate.at <= response.at)?.payload || {};
      const usage = response.usage;
      add(context.model || session.model || 'Model', responseStart, response.at, MODEL_CATEGORY, {
        type: 'ModelResponse', model: context.model || session.model || 'unknown',
        effort: context.effort || 'unknown', inputTokens: usage.input_tokens || 0,
        cachedInputTokens: usage.cached_input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        reasoningTokens: usage.reasoning_output_tokens || 0
      });
      add('Context Size', response.at, next, MESSAGES_CATEGORY, { type: 'ContextSize',
        tokens: usage.input_tokens || 0,
        cachedTokens: usage.cached_input_tokens || 0,
        uncachedTokens: Math.max(0, (usage.input_tokens || 0) - (usage.cached_input_tokens || 0)) });
      add('Output Tokens', responseStart, response.at, MODEL_CATEGORY, { type: 'OutputTokens',
        tokens: usage.output_tokens || 0,
        reasoningTokens: usage.reasoning_output_tokens || 0 });
      if (threadCostPoints) add('Response Cost ($)', responseStart, response.at, MODEL_CATEGORY, {
        type: 'ResponseCost',
        cost: Math.max(0, costAt(response.at) - costAt(previous)),
        inputTokens: usage.input_tokens || 0,
        cachedInputTokens: usage.cached_input_tokens || 0,
        outputTokens: usage.output_tokens || 0
      });
    });

    // Older Codex rollouts predate explicit task spans. Group work separated
    // by less than a minute into activity spans so their overview remains as
    // useful as modern Turn markers and Claude's Activity markers.
    if (transcript.length > 0) {
      const spans = explicitActivity;
      if (spans.length === 0) {
        for (const event of transcript) {
          const previous = spans.at(-1);
          if (!previous || event.at - previous.end > ACTIVE_GAP) {
            spans.push({ start: event.at, end: event.at, events: [event] });
          } else {
            previous.end = event.at;
            previous.events.push(event);
          }
        }
      }
      for (const span of spans) {
        const prompt = (span.events || transcript.filter(event =>
          event.at >= span.start && event.at <= span.end))
          .find(event => event.label === 'User')?.text || '';
        add('Activity', span.start, Math.max(span.start + 1, span.end), MESSAGES_CATEGORY, {
          type: 'Activity', prompt: prompt.replace(/\s+/g, ' ').slice(0, 300),
          cost: threadCostPoints && Math.max(0, costAt(span.end) - costAt(span.start))
        });
      }
    }

    const billingRow = billed.get(session.id);
    const usage = usageOf(entries);
    add('Usage', trackEnd, trackEnd, OTHER_CATEGORY, { type: 'Usage',
      totalTokens: usage.total_tokens || 0, inputTokens: usage.input_tokens || 0,
      cachedTokens: usage.cached_input_tokens || 0, outputTokens: usage.output_tokens || 0,
      credits: billingRow && billingRow.estimated_usage_credits_micros / 1000000,
      cost: billingRow && billingRow.estimated_usage_usd_micros / 1000000 });
    if (threadCostPoints) addCostGraph(threadCostPoints, 'Thread Cost ($)', 'ThreadCost', trackEnd);
    if (index === 0 && totalPoints) {
      addCostGraph(totalPoints, 'Total Cost ($)', 'TotalCost', profileEnd);
    }

    return {
      processType: 'default', processName: session.cwd || 'Codex',
      processStartupTime: trackStart - startTime,
      processShutdownTime: (index === 0 ? profileEnd : trackEnd) - startTime,
      registerTime: trackStart - startTime,
      unregisterTime: (index === 0 ? profileEnd : trackEnd) - startTime,
      pausedRanges: [], showMarkersInTimeline: true, name: session.title,
      isMainThread: true, pid: index, tid: index,
      samples: { length: sampleRows.length, stack: sampleRows.map(row => row.stack),
        time: sampleRows.map(row => row.time), weight: sampleRows.map(row => row.weight),
        weightType: 'bytes' }, markers
    };
  });

  return {
    meta: profileMeta({ product: 'Codex', startTime, markerSchema: markerSchemas() }),
    libs: [], threads, shared: buildTimelineShared(shared), counters: []
  };
}

module.exports = { createCodexProfile };
