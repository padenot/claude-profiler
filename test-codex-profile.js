const assert = require('assert');
const { createCodexProfile } = require('./codex-profile.js');

const base = 1767350000000;
const session = (id, parentId, offset, title) => ({
  id, parentId, title, cwd: '/work/project', model: 'gpt-test',
  started: new Date(base + offset).toISOString(),
  ended: new Date(base + offset + 5000).toISOString()
});
const entry = (offset, type, payload) => ({
  timestamp: new Date(base + offset).toISOString(), type, payload
});

const tree = [{
  session: session('root', null, 0, 'Root thread'),
  entries: [
    entry(0, 'session_meta', { id: 'root' }),
    entry(100, 'turn_context', { turn_id: 'turn', model: 'gpt-test', effort: 'high' }),
    entry(200, 'event_msg', { type: 'task_started', turn_id: 'turn' }),
    entry(300, 'event_msg', { type: 'item_completed', turn_id: 'turn',
      started_at_ms: base + 250, completed_at_ms: base + 300,
      item: { type: 'UserMessage', content: [{ type: 'text', text: 'Hello' }] } }),
    entry(1000, 'event_msg', { type: 'item_completed', turn_id: 'turn',
      started_at_ms: base + 400, completed_at_ms: base + 1000,
      item: { type: 'CommandExecution', command: ['git', 'status'], status: 'completed',
        stdout: 'clean' } }),
    entry(1500, 'event_msg', { type: 'task_complete', turn_id: 'turn' }),
    entry(1600, 'token_usage_record', { response_id: 'response', turn_id: 'turn',
      usage: { total_tokens: 100, input_tokens: 80, cached_input_tokens: 50,
        output_tokens: 20, reasoning_output_tokens: 8 },
      thread_token_usage: {
        total_tokens: 100, input_tokens: 80, cached_input_tokens: 50, output_tokens: 20
      } })
  ]
}, {
  session: session('child', 'root', 500, 'Search agent'),
  entries: [entry(500, 'session_meta', { id: 'child' }), entry(1200, 'event_msg', {
    type: 'item_completed', started_at_ms: base + 800, completed_at_ms: base + 1200,
    item: { type: 'Reasoning', summary_text: 'Looking' }
  })]
}];

const billing = new Map([
  ['root', { estimated_usage_credits_micros: 10000000,
    estimated_usage_usd_micros: 1000000 }],
  ['child', { estimated_usage_credits_micros: 2500000,
    estimated_usage_usd_micros: 250000 }]
]);
const profile = createCodexProfile(tree, billing);
assert.strictEqual(profile.meta.product, 'Codex');
assert.strictEqual(profile.meta.version, 64);
assert.deepStrictEqual(profile.threads.map(thread => thread.name), ['Root thread', 'Search agent']);

const names = thread => thread.markers.name.map(index => profile.shared.stringArray[index]);
assert(names(profile.threads[0]).includes('Turn'));
assert(names(profile.threads[0]).includes('CommandExecution'));
assert(names(profile.threads[0]).includes('Subagent'));
assert(names(profile.threads[1]).includes('Reasoning'));
assert(names(profile.threads[0]).includes('Context Size'));
assert(names(profile.threads[0]).includes('Output Tokens'));
assert(names(profile.threads[0]).includes('gpt-test'));
assert(names(profile.threads[0]).includes('Activity'));

const usage = profile.threads[0].markers.data.find(marker => marker.type === 'Usage');
assert.deepStrictEqual([usage.totalTokens, usage.credits, usage.cost], [100, 10, 1]);
const threadCosts = profile.threads[0].markers.data
  .filter(marker => marker.type === 'ThreadCost');
const totalCosts = profile.threads[0].markers.data
  .filter(marker => marker.type === 'TotalCost');
const responseCosts = profile.threads[0].markers.data
  .filter(marker => marker.type === 'ResponseCost');
assert.strictEqual(threadCosts.at(-1).cost, 1);
assert.strictEqual(totalCosts.at(-1).cost, 1.25);
assert.strictEqual(responseCosts.reduce((sum, marker) => sum + marker.cost, 0), 1);
assert(profile.meta.markerSchema.find(schema => schema.name === 'ThreadCost').graphs);
assert(profile.meta.markerSchema.find(schema => schema.name === 'ContextSize').graphs);
assert(profile.threads[0].samples.length > 0);
assert.strictEqual(profile.threads[0].samples.weightType, 'bytes');
assert.strictEqual(profile.shared.sources.length, 2);
assert(profile.shared.sources.content[0].includes('Hello'));
assert(profile.threads[0].markers.startTime.every(Number.isFinite));
assert(profile.threads[0].markers.endTime.every(Number.isFinite));

console.log('ok   builds Codex turns, tools, usage, and subagent tracks');
const unbilled = createCodexProfile(tree, new Map([['child', billing.get('child')]]));
const unbilledTypes = thread => thread.markers.data.map(marker => marker.type);
assert.strictEqual(unbilled.threads.length, 2);
assert(!unbilledTypes(unbilled.threads[0]).includes('ThreadCost'));
assert(!unbilledTypes(unbilled.threads[0]).includes('ResponseCost'));
assert(!unbilledTypes(unbilled.threads[0]).includes('TotalCost'));
assert(unbilledTypes(unbilled.threads[0]).includes('ModelResponse'));
assert(unbilledTypes(unbilled.threads[1]).includes('ThreadCost'));
assert.strictEqual(createCodexProfile(tree, new Map()).threads.length, 2);
console.log('ok   threads without billing data keep their timeline but no cost graphs');

const placeholder = createCodexProfile(tree, new Map([...billing, ['root', {
  estimated_usage_credits_micros: 0, estimated_usage_usd_micros: 0 }]]));
assert(!unbilledTypes(placeholder.threads[0]).includes('ThreadCost'));
assert(!unbilledTypes(placeholder.threads[0]).includes('TotalCost'));
console.log('ok   an all-zero billing placeholder draws no cost graphs');

const untimed = createCodexProfile([tree[0], { session: session('quiet', 'root', 0, 'Quiet'),
  entries: [{ type: 'session_meta', payload: { id: 'quiet' } }] }], billing);
assert.deepStrictEqual([untimed.threads[1].registerTime, untimed.threads[1].unregisterTime],
  [0, 1600]);
console.log('ok   a thread with no timestamps spans the whole profile');

const doubled = [{ session: session('both', null, 0, 'Both formats'), entries: [
  entry(0, 'session_meta', { id: 'both' }),
  entry(100, 'event_msg', { type: 'item_completed', completed_at_ms: base + 100,
    item: { type: 'UserMessage', content: [{ type: 'text', text: 'Hi' }] } }),
  entry(100, 'event_msg', { type: 'user_message', message: 'Hi' }),
  entry(200, 'event_msg', { type: 'item_completed', started_at_ms: base + 150,
    completed_at_ms: base + 200, item: { type: 'CommandExecution', command: 'ls',
      status: 'completed' } }),
  entry(200, 'event_msg', { type: 'exec_command_end', command: 'ls', exit_code: 0 }),
  entry(300, 'token_usage_record', { response_id: 'r', usage: { total_tokens: 10,
    input_tokens: 8, output_tokens: 2 }, thread_token_usage: { total_tokens: 10 } }),
  entry(300, 'event_msg', { type: 'token_count', info: {
    last_token_usage: { total_tokens: 10, input_tokens: 8, output_tokens: 2 },
    total_token_usage: { total_tokens: 10 } } })
] }];
const doubledProfile = createCodexProfile(doubled, new Map());
const doubledTypes = doubledProfile.threads[0].markers.data.map(marker => marker.type);
const count = type => doubledTypes.filter(t => t === type).length;
assert.deepStrictEqual([count('Text'), count('ToolCall'), count('ModelResponse')], [1, 1, 1]);
assert.strictEqual(doubledProfile.threads[0].samples.stack.length, 2);
console.log('ok   a rollout logging both formats counts every event once');

// Legacy events only before a Codex upgrade, both formats after it.
const resumed = [{ session: session('resumed', null, 0, 'Resumed'), entries: [
  entry(0, 'session_meta', { id: 'resumed' }),
  entry(100, 'event_msg', { type: 'user_message', message: 'Old prompt' }),
  entry(200, 'event_msg', { type: 'token_count', info: {
    last_token_usage: { total_tokens: 5, input_tokens: 4, output_tokens: 1 },
    total_token_usage: { total_tokens: 5 } } }),
  entry(1000, 'turn_context', { turn_id: 'new', model: 'gpt-test' }),
  entry(1001, 'event_msg', { type: 'user_message', message: 'New prompt' }),
  entry(1002, 'event_msg', { type: 'item_completed', completed_at_ms: base + 1002,
    item: { type: 'UserMessage', content: [{ type: 'text', text: 'New prompt' }] } }),
  entry(1100, 'event_msg', { type: 'token_count', info: {
    last_token_usage: { total_tokens: 10, input_tokens: 8, output_tokens: 2 },
    total_token_usage: { total_tokens: 15 } } }),
  entry(1101, 'token_usage_record', { response_id: 'r', turn_id: 'new', usage: {
    total_tokens: 10, input_tokens: 8, output_tokens: 2 }, thread_token_usage: { total_tokens: 15 } })
] }];
const resumedData = createCodexProfile(resumed, new Map()).threads[0].markers.data;
assert.deepStrictEqual(resumedData.filter(marker => marker.type === 'Text').map(marker => marker.text),
  ['Old prompt', 'New prompt']);
assert.strictEqual(resumedData.filter(marker => marker.type === 'ModelResponse').length, 2);
console.log('ok   legacy events written before a Codex upgrade are kept');

console.log('\nall passed');
