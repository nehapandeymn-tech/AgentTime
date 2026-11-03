// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../web/core.js');

function setup(cfg) {
  let now = 1_000_000;
  const clock = () => now;
  const store = C.createStore(cfg, clock);
  for (const p of C.PROVIDERS) store.setConnection(p, 'healthy');
  const revs = {};
  let n = 0;
  const ev = (provider, type, payload = {}, o = {}) => {
    const task = o.task || 't1', run = o.run || 'r1', session = o.session || 's1';
    const k = `${provider}|${session}|${task}|${run}`;
    revs[k] = o.revision ?? (revs[k] || 0) + 1;
    return { schemaVersion: 1, eventId: o.id || `e${++n}`, provider, providerSessionId: session, taskId: task, runId: run,
      revision: revs[k], occurredAt: '2026-11-03T14:00:00+05:30', type, payload };
  };
  return { store, ev, tick: ms => { now += ms; } };
}

test('confirmed mapping', () => {
  assert.deepEqual(C.DEFAULT_CONFIG.characters, { claude: 'finn', antigravity: 'jake', codex: 'bmo' });
});

test('all idle -> every provider rests (huddle)', () => {
  const { store } = setup();
  for (const p of C.PROVIDERS) assert.equal(store.resolve(p).state, 'rest');
});

test('one active: only Claude works, the others keep resting', () => {
  const { store, ev } = setup();
  store.ingest(ev('claude', 'task.started', { taskCategory: 'research', shortLabel: 'Reading files' }));
  assert.equal(store.resolve('claude').state, 'chill');
  assert.equal(store.resolve('claude').label, 'Reading files');
  assert.equal(store.resolve('antigravity').state, 'rest');
  assert.equal(store.resolve('codex').state, 'rest');
});

test('thinking is not an error', () => {
  const { store, ev } = setup();
  store.ingest(ev('codex', 'task.started'));
  store.ingest(ev('codex', 'task.progress', { thinking: 'high' }));
  const r = store.resolve('codex');
  assert.equal(r.state, 'thinking');
  assert.equal(r.counts.needsHelp, 0);
});

test('retry streak: first retry, duplicate ignored, third strained, others unaffected', () => {
  const { store, ev } = setup();
  store.ingest(ev('antigravity', 'task.started'));
  store.ingest(ev('antigravity', 'task.attempt_failed', { attemptId: 'a1' }, { id: 'f1' }));
  assert.equal(store.resolve('antigravity').state, 'retry');
  assert.equal(store.ingest(ev('antigravity', 'task.attempt_failed', { attemptId: 'a1' }, { id: 'f1' })), false); // same eventId
  store.ingest(ev('antigravity', 'task.attempt_failed', { attemptId: 'a1' }));                                    // same attempt, new id
  const t = [...store.tasks.values()][0];
  assert.equal(t.failStreak, 1);
  store.ingest(ev('antigravity', 'task.attempt_failed', { attemptId: 'a2' }));
  store.ingest(ev('antigravity', 'task.attempt_failed', { attemptId: 'a3' }));
  assert.equal(store.resolve('antigravity').state, 'strained');
  assert.equal(store.resolve('claude').state, 'rest');
});

test('confirmed recovery resets the streak and recovers once', () => {
  const { store, ev } = setup();
  store.ingest(ev('antigravity', 'task.started'));
  for (const a of ['a1', 'a2', 'a3']) store.ingest(ev('antigravity', 'task.attempt_failed', { attemptId: a }));
  store.ingest(ev('antigravity', 'task.attempt_succeeded'));
  assert.equal(store.resolve('antigravity').state, 'chill');
  assert.equal(store.takeOneShot('antigravity').kind, 'recover');
  assert.equal(store.takeOneShot('antigravity'), null);
});

test('expected test failure does not count', () => {
  const { store, ev } = setup();
  store.ingest(ev('claude', 'task.started'));
  store.ingest(ev('claude', 'task.attempt_failed', { attemptId: 'x', expected: true }));
  assert.equal(store.resolve('claude').state, 'chill');
});

test('needs approval: awake idle, label, no wounds', () => {
  const { store, ev } = setup();
  store.ingest(ev('codex', 'task.started'));
  store.ingest(ev('codex', 'task.waiting', { waitReason: 'approval' }));
  const r = store.resolve('codex');
  assert.equal(r.state, 'idle');
  assert.equal(r.label, 'Needs approval');
  assert.equal(r.counts.needsHelp, 0);
});

test('long running task stays calm', () => {
  const { store, ev, tick } = setup();
  store.ingest(ev('claude', 'task.started'));
  tick(3 * 60 * 60 * 1000);
  assert.equal(store.resolve('claude').state, 'chill');
});

test('completion plays once, repeated snapshots and late progress do not reopen', () => {
  const { store, ev } = setup();
  store.ingest(ev('claude', 'task.started'));
  store.ingest(ev('claude', 'task.completed'));
  assert.equal(store.takeOneShot('claude').kind, 'complete');
  assert.equal(store.ingest(ev('claude', 'task.completed')), false);
  assert.equal(store.ingest(ev('claude', 'task.progress', {}, { revision: 1 })), false);
  assert.equal(store.ingest(ev('claude', 'task.progress', {}, { revision: 9 })), false);
  assert.equal(store.takeOneShot('claude'), null);
  assert.equal(store.resolve('claude').state, 'rest');
});

test('new run of the same task gets its own lifecycle and completion', () => {
  const { store, ev } = setup();
  store.ingest(ev('claude', 'task.started'));
  store.ingest(ev('claude', 'task.completed'));
  store.takeOneShot('claude');
  store.ingest(ev('claude', 'task.started', {}, { run: 'r2' }));
  assert.equal(store.resolve('claude').state, 'chill');
  store.ingest(ev('claude', 'task.completed', {}, { run: 'r2' }));
  assert.equal(store.takeOneShot('claude').kind, 'complete');
  // late event for the superseded run is ignored
  assert.equal(store.ingest(ev('claude', 'task.progress', {}, { run: 'r1', revision: 50 })), false);
});

test('multiple tasks: one completes, the other keeps Finn working', () => {
  const { store, ev } = setup();
  store.ingest(ev('claude', 'task.started', {}, { task: 'a' }));
  store.ingest(ev('claude', 'task.started', {}, { task: 'b' }));
  store.ingest(ev('claude', 'task.completed', {}, { task: 'a' }));
  assert.equal(store.takeOneShot('claude').kind, 'complete');
  assert.equal(store.resolve('claude').state, 'chill');
});

test('completion behind a task that needs help becomes a badge', () => {
  const { store, ev } = setup();
  store.ingest(ev('codex', 'task.started', {}, { task: 'a' }));
  store.ingest(ev('codex', 'task.waiting', { waitReason: 'approval' }, { task: 'a' }));
  store.ingest(ev('codex', 'task.started', {}, { task: 'b' }));
  store.ingest(ev('codex', 'task.completed', {}, { task: 'b' }));
  assert.equal(store.takeOneShot('codex'), null);
  assert.equal(store.resolve('codex').badge, 1);
  assert.equal(store.resolve('codex').label, 'Needs approval');
});

test('rapid completions coalesce into one gesture with a count', () => {
  const { store, ev } = setup();
  for (const t of ['a', 'b', 'c']) { store.ingest(ev('claude', 'task.started', {}, { task: t })); store.ingest(ev('claude', 'task.completed', {}, { task: t })); }
  const s = store.takeOneShot('claude');
  assert.equal(s.count, 3);
  assert.equal(store.takeOneShot('claude'), null);
});

test('replayed history never celebrates', () => {
  const { store, ev } = setup();
  store.ingest(ev('codex', 'task.started'), { replay: true });
  store.ingest(ev('codex', 'task.completed'), { replay: true });
  assert.equal(store.takeOneShot('codex'), null);
});

test('waiting, failure, cancellation and unavailable are distinct', () => {
  const { store, ev, tick } = setup();
  store.ingest(ev('claude', 'task.started'));
  store.ingest(ev('claude', 'task.failed', { shortLabel: 'Build' }));
  assert.equal(store.resolve('claude').state, 'strained');
  tick(5000);
  assert.equal(store.resolve('claude').state, 'idle');
  assert.equal(store.resolve('claude').label, 'Failed: Build');
  store.acknowledgeFailures('claude');
  assert.equal(store.resolve('claude').state, 'rest');

  store.ingest(ev('codex', 'task.started'));
  store.ingest(ev('codex', 'task.cancelled'));
  assert.equal(store.resolve('codex').state, 'rest');
  assert.equal(store.takeOneShot('codex'), null);

  store.setConnection('antigravity', 'unavailable');
  const r = store.resolve('antigravity');
  assert.equal(r.unavailable, true);
  assert.equal(r.label, 'Status unavailable');
});

test('process exit closes open work quietly', () => {
  const { store, ev } = setup();
  store.ingest(ev('antigravity', 'task.started'));
  store.providerStopped('antigravity');
  assert.equal(store.resolve('antigravity').state, 'rest');
  assert.equal(store.takeOneShot('antigravity'), null);
});

test('encounters are off unless enabled', () => {
  const off = setup();
  off.store.ingest(off.ev('claude', 'task.started', { activity: 'encounter' }));
  assert.equal(off.store.resolve('claude').state, 'chill');
  const on = setup({ encounters: true });
  on.store.ingest(on.ev('claude', 'task.started', { activity: 'encounter' }));
  assert.equal(on.store.resolve('claude').state, 'encounter');
});

test('malformed and unknown events are ignored', () => {
  const { store } = setup();
  assert.equal(store.ingest({ hello: 1 }), false);
  assert.equal(store.ingest({ schemaVersion: 1, eventId: 'x', provider: 'gemini', providerSessionId: 's', taskId: 't', runId: 'r', revision: 1, type: 'task.started' }), false);
});

test('handoff example events replay cleanly', () => {
  const fs = require('node:fs');
  const lines = fs.readFileSync(__dirname + '/../handoff/example-events.ndjson', 'utf8').trim().split('\n');
  const { store } = setup();
  for (const l of lines) store.ingest(JSON.parse(l));
  for (const p of C.PROVIDERS) assert.ok(store.resolve(p).state);
});

// ---------------------------------------------------------------- adapters

test('Claude adapter: prompt -> tools -> approval -> stop', () => {
  const { store } = setup();
  const a = C.createClaudeAdapter();
  let i = 0;
  const feed = raw => a(raw, `L${++i}`).forEach(e => store.ingest(e));
  feed({ hook_event_name: 'UserPromptSubmit', session_id: 'S', prompt_id: 'P1' });
  assert.equal(store.resolve('claude').state, 'chill');
  feed({ hook_event_name: 'PreToolUse', session_id: 'S', tool_name: 'Grep' });
  assert.equal(store.resolve('claude').label, 'Reading files');
  feed({ hook_event_name: 'PermissionRequest', session_id: 'S', tool_name: 'Bash' });
  assert.equal(store.resolve('claude').label, 'Needs approval');
  feed({ hook_event_name: 'PreToolUse', session_id: 'S', tool_name: 'Bash' });
  assert.equal(store.resolve('claude').label, 'Running a command');
  feed({ hook_event_name: 'PostToolUseFailure', session_id: 'S', tool_name: 'Bash', tool_use_id: 'u1' });
  assert.equal(store.resolve('claude').state, 'retry');
  feed({ hook_event_name: 'PostToolUse', session_id: 'S', tool_name: 'Bash', tool_use_id: 'u2' });
  assert.equal(store.resolve('claude').state, 'chill');
  feed({ hook_event_name: 'Stop', session_id: 'S' });
  assert.equal(store.resolve('claude').state, 'rest');
  assert.equal(store.takeOneShot('claude').kind, 'complete');
});

test('Claude adapter: joining a turn midway starts it from prompt_id', () => {
  const { store } = setup();
  const a = C.createClaudeAdapter();
  let i = 0;
  const feed = raw => a(raw, `L${++i}`).forEach(e => store.ingest(e));
  feed({ hook_event_name: 'PreToolUse', session_id: 'S', prompt_id: 'P9', tool_name: 'Edit' });
  assert.equal(store.resolve('claude').label, 'Editing files');
  feed({ hook_event_name: 'Stop', session_id: 'S', prompt_id: 'P9' });
  assert.equal(store.resolve('claude').state, 'rest');
});

test('Claude adapter: plan mode is thinking, interrupt cancels', () => {
  const { store } = setup();
  const a = C.createClaudeAdapter();
  let i = 0;
  const feed = raw => a(raw, `L${++i}`).forEach(e => store.ingest(e));
  feed({ hook_event_name: 'UserPromptSubmit', session_id: 'S', prompt_id: 'P1', permission_mode: 'plan' });
  assert.equal(store.resolve('claude').state, 'thinking');
  feed({ hook_event_name: 'PostToolUseFailure', session_id: 'S', is_interrupt: true });
  assert.equal(store.resolve('claude').state, 'rest');
  assert.equal(store.takeOneShot('claude'), null);
});

test('Antigravity adapter: invocation, tool error, stop', () => {
  const { store } = setup();
  const a = C.createAntigravityAdapter();
  let i = 0;
  const feed = raw => a(raw, `L${++i}`).forEach(e => store.ingest(e));
  feed({ event: 'PreInvocation', conversationId: 'C' });
  assert.equal(store.resolve('antigravity').state, 'chill');
  feed({ event: 'PostToolUse', conversationId: 'C', tool: 'run_command', stepIdx: 4, error: 'exit status 1' });
  assert.equal(store.resolve('antigravity').state, 'retry');
  feed({ event: 'PostToolUse', conversationId: 'C', tool: 'view_file', stepIdx: 5 });
  assert.equal(store.resolve('antigravity').label, 'Reading files');
  feed({ event: 'Stop', conversationId: 'C' });
  assert.equal(store.resolve('antigravity').state, 'rest');
  assert.equal(store.takeOneShot('antigravity').kind, 'complete');
});

test('Codex adapter: rollout task lifecycle, abort', () => {
  const { store } = setup();
  const a = C.createCodexAdapter();
  let i = 0;
  const feed = raw => a(raw, `L${++i}`, 'SESSION').forEach(e => store.ingest(e));
  feed({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'T1' } });
  assert.equal(store.resolve('codex').state, 'chill');
  feed({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution' } } });
  assert.equal(store.resolve('codex').label, 'Running a command');
  feed({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'T1' } });
  assert.equal(store.takeOneShot('codex').kind, 'complete');
  feed({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'T2' } });
  feed({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'T2' } });
  assert.equal(store.resolve('codex').state, 'rest');
  assert.equal(store.takeOneShot('codex'), null);
});
