// Agent Companions core: provider adapters -> normalized events -> task store -> per-provider resolver.
// Pure logic, no DOM. Loads in the browser as window.CompanionCore and in Node via require() for tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CompanionCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PROVIDERS = ['claude', 'antigravity', 'codex'];

  const DEFAULT_CONFIG = {
    // User-confirmed mapping. Provider identity stays separate from character identity everywhere.
    characters: { claude: 'finn', antigravity: 'jake', codex: 'bmo' },
    labels: { claude: 'Claude', antigravity: 'Antigravity', codex: 'Codex' },
    workSlotOrder: ['claude', 'antigravity', 'codex'],
    retryFrom: 1,              // 1-2 consecutive failed attempts -> retry
    strainedFrom: 3,           // 3+ -> strained
    recoverFromStreak: 2,      // a success after this many failures plays the one-shot recover
    completionCoalesceMs: 1000,
    failedStrainMs: 3000,      // a failed task shows strained briefly, then a subdued pose
    encounters: false,         // Ice King only when explicitly enabled AND a task asks for it
    dedupLimit: 5000,
    keepFinishedMs: 10 * 60 * 1000,
  };

  const TYPES = new Set(['task.started', 'task.progress', 'task.waiting', 'task.resumed', 'task.attempt_failed',
    'task.attempt_succeeded', 'task.completed', 'task.failed', 'task.cancelled']);
  const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

  // Lower rank = more important. Mirrors the brief's dominant-task order (section 9).
  const RANK = { failed: 0, strained: 1, retry: 2, needsUser: 3, encounter: 4, thinking: 5, running: 6, queued: 7 };

  const WAIT_LABELS = {
    approval: 'Needs approval', user_input: 'Waiting for you', dependency: 'Waiting on a dependency',
    rate_limit: 'Rate limited, waiting', queued: 'Queued',
  };

  // ---------------------------------------------------------------- task store

  function createStore(userConfig = {}, clock = () => Date.now()) {
    const config = Object.assign({}, DEFAULT_CONFIG, userConfig);
    const seen = new Set();
    const seenOrder = [];
    const tasks = new Map();                 // provider|session|task -> record
    const pastRuns = new Map();              // task key -> Set(runId) of superseded/finished runs
    const consumed = new Set();              // completion keys already celebrated (or replayed)
    const connection = {};                   // provider -> 'unknown' | 'healthy' | 'unavailable'
    const oneShots = {};                     // provider -> [{kind, at, count}]
    const badges = {};                       // provider -> completions shown as a badge instead of a gesture
    const focus = {};                        // provider -> task key kept for stability
    for (const p of PROVIDERS) { connection[p] = 'unknown'; oneShots[p] = []; badges[p] = 0; }

    function remember(id) {
      seen.add(id); seenOrder.push(id);
      while (seenOrder.length > config.dedupLimit) seen.delete(seenOrder.shift());
    }

    function validate(e) {
      return e && e.schemaVersion === 1 && typeof e.eventId === 'string' && PROVIDERS.includes(e.provider) &&
        typeof e.providerSessionId === 'string' && typeof e.taskId === 'string' && typeof e.runId === 'string' &&
        Number.isInteger(e.revision) && TYPES.has(e.type);
    }

    function newRecord(e, key) {
      return {
        key, provider: e.provider, providerSessionId: e.providerSessionId, taskId: e.taskId, runId: e.runId,
        revision: 0, status: 'running', category: 'other', thinking: 'unknown', activity: 'automatic',
        waitReason: null, failStreak: 0, failedAttempts: new Set(), label: '', startedAt: clock(),
        updatedAt: clock(), finishedAt: null, acknowledged: false,
      };
    }

    function applyPayload(t, p) {
      if (!p) return;
      if (typeof p.shortLabel === 'string') t.label = p.shortLabel.slice(0, 60);
      if (p.taskCategory) t.category = p.taskCategory;
      if (p.thinking) t.thinking = p.thinking;
      if (p.activity) t.activity = p.activity;
    }

    function queueOneShot(provider, kind) {
      const q = oneShots[provider];
      const now = clock();
      const last = q[q.length - 1];
      if (kind === 'complete' && last && last.kind === 'complete' && now - last.at < config.completionCoalesceMs) last.count++;
      else q.push({ kind, at: now, count: 1 });
    }

    /** Apply one normalized event. Returns true when it changed task truth. */
    function ingest(e, opts = {}) {
      if (!validate(e)) return false;
      if (seen.has(e.eventId)) return false;
      remember(e.eventId);
      if (connection[e.provider] === 'unknown') connection[e.provider] = 'healthy';

      const key = `${e.provider}|${e.providerSessionId}|${e.taskId}`;
      let t = tasks.get(key);
      const runs = pastRuns.get(key) || new Set();
      if (runs.has(e.runId)) return false;                      // late event from a finished/superseded run

      if (!t || t.runId !== e.runId) {
        // A different run only begins on an explicit start (or the first thing we ever see of this task).
        if (t && e.type !== 'task.started') return false;
        if (t) { runs.add(t.runId); pastRuns.set(key, runs); }
        t = newRecord(e, key);
        tasks.set(key, t);
      }
      if (e.revision <= t.revision) return false;                // stale or duplicate ordering
      if (TERMINAL.has(t.status)) return false;                  // terminal states are stable
      t.revision = e.revision;
      t.updatedAt = clock();
      const p = e.payload || {};

      switch (e.type) {
        case 'task.started':
          t.status = 'running'; applyPayload(t, p); break;
        case 'task.progress':
          if (t.status === 'waiting') { t.status = 'running'; t.waitReason = null; }
          applyPayload(t, p); break;
        case 'task.waiting':
          t.status = 'waiting'; t.waitReason = p.waitReason || 'user_input'; applyPayload(t, p); break;
        case 'task.resumed':
          t.status = 'running'; t.waitReason = null; applyPayload(t, p); break;
        case 'task.attempt_failed': {
          if (p.expected === true) break;                         // deliberate failing test etc.
          const attempt = p.attemptId || e.eventId;
          if (t.failedAttempts.has(attempt)) break;
          t.failedAttempts.add(attempt);
          t.failStreak++;
          if (t.status === 'waiting') { t.status = 'running'; t.waitReason = null; }
          applyPayload(t, p); break;
        }
        case 'task.attempt_succeeded':
          if (t.failStreak >= config.recoverFromStreak && !opts.replay) queueOneShot(e.provider, 'recover');
          t.failStreak = 0; t.failedAttempts.clear();
          if (t.status === 'waiting') { t.status = 'running'; t.waitReason = null; }
          applyPayload(t, p); break;
        case 'task.completed': {
          t.status = 'completed'; t.finishedAt = clock(); t.failStreak = 0; applyPayload(t, p);
          const ck = `${e.provider}|${e.providerSessionId}|${e.taskId}|${e.runId}`;
          if (!consumed.has(ck)) {                                // record consumption before scheduling
            consumed.add(ck);
            if (!opts.replay) queueOneShot(e.provider, 'complete');
          }
          break;
        }
        case 'task.failed':
          t.status = 'failed'; t.finishedAt = clock(); t.acknowledged = false; applyPayload(t, p); break;
        case 'task.cancelled':
          t.status = 'cancelled'; t.finishedAt = clock(); break;
      }
      return true;
    }

    function setConnection(provider, state) {
      if (PROVIDERS.includes(provider)) connection[provider] = state;
    }

    /** The provider process went away: close its open work quietly (no celebration, no wounds). */
    function providerStopped(provider, sessionId) {
      for (const t of tasks.values()) {
        if (t.provider !== provider || TERMINAL.has(t.status)) continue;
        if (sessionId && t.providerSessionId !== sessionId) continue;
        t.status = 'cancelled'; t.finishedAt = clock();
      }
    }

    function acknowledgeFailures(provider) {
      for (const t of tasks.values()) if (t.provider === provider && t.status === 'failed') t.acknowledged = true;
    }

    function prune() {
      const now = clock();
      for (const [k, t] of tasks) {
        const done = t.status === 'completed' || t.status === 'cancelled' || (t.status === 'failed' && t.acknowledged);
        if (done && now - t.finishedAt > config.keepFinishedMs) tasks.delete(k);
      }
    }

    // ------------------------------------------------------------ resolver

    /** Visual meaning of one task (brief section 8), or null when it no longer needs showing. */
    function taskVisual(t) {
      if (t.status === 'failed') {
        if (t.acknowledged) return null;
        const fresh = clock() - t.finishedAt < config.failedStrainMs;
        return { rank: RANK.failed, state: fresh ? 'strained' : 'idle', label: t.label ? `Failed: ${t.label}` : 'Failed', needsHelp: true };
      }
      if (t.status === 'completed' || t.status === 'cancelled') return null;
      if (t.status === 'waiting') {
        const needsUser = t.waitReason === 'approval' || t.waitReason === 'user_input';
        return { rank: needsUser ? RANK.needsUser : RANK.queued, state: 'idle', label: WAIT_LABELS[t.waitReason] || 'Waiting', needsUser };
      }
      if (t.failStreak >= config.strainedFrom) return { rank: RANK.strained, state: 'strained', label: 'Struggling, still retrying', needsHelp: true };
      if (t.failStreak >= config.retryFrom) return { rank: RANK.retry, state: 'retry', label: t.label ? `Retrying: ${t.label}` : 'Retrying', needsHelp: true };
      if (t.activity === 'encounter' && config.encounters) return { rank: RANK.encounter, state: 'encounter', label: t.label || 'Tough task' };
      if (t.thinking === 'high') return { rank: RANK.thinking, state: 'thinking', label: t.label || 'Thinking' };
      if (t.activity === 'practice') return { rank: RANK.running, state: 'practice', label: t.label || 'Working' };
      return { rank: RANK.running, state: 'chill', label: t.label || 'Working' };
    }

    /** What one provider's companion should show right now. */
    function resolve(provider) {
      const conn = connection[provider];
      const open = [];
      for (const t of tasks.values()) {
        if (t.provider !== provider) continue;
        const v = taskVisual(t);
        if (v) open.push({ t, v });
      }
      const counts = {
        running: open.filter(o => o.t.status === 'running').length,
        needsUser: open.filter(o => o.v.needsUser).length,
        needsHelp: open.filter(o => o.v.needsHelp).length,
        total: open.length,
      };
      if (conn !== 'healthy') {
        return { provider, state: 'idle', label: 'Status unavailable', unavailable: true, resting: false, counts, rank: 9, badge: badges[provider] };
      }
      if (!open.length) {
        delete focus[provider];
        return { provider, state: 'rest', label: 'Resting', resting: true, counts, rank: 10, badge: badges[provider] };
      }
      // Dominant task: best rank; keep the current focus within that rank, else the oldest unresolved.
      const best = Math.min(...open.map(o => o.v.rank));
      const top = open.filter(o => o.v.rank === best).sort((a, b) => a.t.startedAt - b.t.startedAt);
      const keep = top.find(o => o.t.key === focus[provider]);
      const pick = keep || top[0];
      focus[provider] = pick.t.key;
      return {
        provider, state: pick.v.state, label: pick.v.label, resting: false, counts, rank: best,
        summary: summarize(counts), badge: badges[provider], taskKey: pick.t.key,
      };
    }

    /** Next one-shot to play, honouring "never hide work that needs help behind a celebration". */
    function takeOneShot(provider) {
      const q = oneShots[provider];
      if (!q.length) return null;
      const r = resolve(provider);
      const shot = q.shift();
      if (shot.kind === 'complete' && r.rank <= RANK.needsUser) { badges[provider] += shot.count; return null; }
      if (shot.kind === 'recover' && r.rank <= RANK.needsUser) return null;   // urgent truth wins
      return shot;
    }

    function clearBadge(provider) { badges[provider] = 0; }

    return {
      config, ingest, setConnection, providerStopped, acknowledgeFailures, prune, resolve, takeOneShot, clearBadge,
      tasks, connection, _oneShots: oneShots,
    };
  }

  function summarize(c) {
    const parts = [];
    if (c.needsHelp) parts.push(`${c.needsHelp} need${c.needsHelp === 1 ? 's' : ''} help`);
    if (c.needsUser) parts.push(`${c.needsUser} waiting on you`);
    const calm = c.running - c.needsHelp;
    if (calm > 0) parts.push(`${calm} running`);
    return c.total > 1 ? parts.join(' · ') : '';
  }

  // ---------------------------------------------------------------- adapters
  // Each adapter turns one raw record into zero or more envelopes. They are stateful only for
  // run numbering and revisions, which come from the order of append-only logs.

  function envelopeFactory(provider) {
    const revs = new Map();
    return function make(sessionId, taskId, runId, type, payload, sourceId, occurredAt) {
      const rk = `${sessionId}|${taskId}|${runId}`;
      const rev = (revs.get(rk) || 0) + 1;
      revs.set(rk, rev);
      return {
        schemaVersion: 1, eventId: `${provider}:${sourceId}:${type}`, provider, providerSessionId: sessionId,
        taskId, runId, revision: rev, occurredAt: occurredAt || new Date().toISOString(), type, payload: payload || {},
      };
    };
  }

  const CLAUDE_TOOL_LABELS = [
    [/^(Read|Glob|Grep|LS|NotebookRead)$/, 'Reading files', 'research'],
    [/^(WebSearch|WebFetch)$/, 'Searching the web', 'research'],
    [/^(Edit|MultiEdit|Write|NotebookEdit)$/, 'Editing files', 'coding'],
    [/^Bash$/, 'Running a command', 'coding'],
    [/^(Task|Agent)$/, 'Working with a helper agent', 'other'],
    [/^(TodoWrite|TaskCreate|TaskUpdate)$/, 'Planning steps', 'planning'],
    [/^(EnterPlanMode|ExitPlanMode)$/, 'Planning', 'planning'],
    [/^mcp__/, 'Using a connected tool', 'other'],
  ];
  function toolLabel(table, name) {
    for (const [re, label, cat] of table) if (re.test(name || '')) return { shortLabel: label, taskCategory: cat };
    return { shortLabel: 'Working', taskCategory: 'other' };
  }

  /** Claude Code hook records written by companion-hook (one per hook call). */
  function createClaudeAdapter() {
    const make = envelopeFactory('claude');
    const runs = new Map();   // session -> current run id
    let counter = 0;
    return function adapt(raw, sourceId) {
      const ev = raw.hook_event_name, s = raw.session_id;
      if (!ev || !s) return [];
      if (raw.agent_id && ev !== 'PreToolUse' && ev !== 'PostToolUse' && ev !== 'PostToolUseFailure') return [];
      const plan = raw.permission_mode === 'plan';
      const think = plan ? { thinking: 'high', shortLabel: 'Planning' } : {};
      const out = [];
      // Every event carries prompt_id: a turn we joined midway (e.g. the widget started late) still counts.
      const midTurn = ev !== 'UserPromptSubmit' && ev !== 'Stop' && ev !== 'StopFailure' && ev !== 'SessionEnd' && ev !== 'SessionStart' && ev !== 'Notification';
      if (midTurn && raw.prompt_id && runs.get(s) !== raw.prompt_id) {
        runs.set(s, raw.prompt_id);
        out.push(make(s, s, raw.prompt_id, 'task.started', Object.assign({ shortLabel: 'Working', taskCategory: 'other', thinking: plan ? 'high' : 'normal' }, think), sourceId + ':s', raw.received_at));
      }
      const run = runs.get(s);
      const emit = (type, payload) => run && out.push(make(s, s, run, type, payload, sourceId, raw.received_at));
      switch (ev) {
        case 'UserPromptSubmit': {
          const id = raw.prompt_id || `p${++counter}-${sourceId}`;
          runs.set(s, id);
          out.push(make(s, s, id, 'task.started', Object.assign({ shortLabel: 'Starting', taskCategory: 'other', thinking: plan ? 'high' : 'normal' }, think), sourceId, raw.received_at));
          break;
        }
        case 'PreToolUse':
          emit('task.progress', Object.assign(toolLabel(CLAUDE_TOOL_LABELS, raw.tool_name), { thinking: plan ? 'high' : 'normal' }, think));
          break;
        case 'PostToolUse':
          emit('task.attempt_succeeded', { attemptId: raw.tool_use_id });
          break;
        case 'PostToolUseFailure':
          if (raw.is_interrupt) { emit('task.cancelled', {}); runs.delete(s); }
          else emit('task.attempt_failed', { attemptId: raw.tool_use_id || sourceId, retriable: true, shortLabel: toolLabel(CLAUDE_TOOL_LABELS, raw.tool_name).shortLabel });
          break;
        case 'PermissionRequest':
          emit('task.waiting', { waitReason: 'approval', shortLabel: 'Needs approval' });
          break;
        case 'Notification': {
          const kind = raw.notification_type || '';
          if (kind === 'permission_prompt' || /permission/i.test(raw.message || '')) emit('task.waiting', { waitReason: 'approval' });
          else if (kind === 'agent_needs_input' || kind === 'elicitation_dialog') emit('task.waiting', { waitReason: 'user_input' });
          break;
        }
        case 'Stop':
          emit('task.completed', { shortLabel: 'Done' }); runs.delete(s);
          break;
        case 'StopFailure':
          emit('task.failed', { shortLabel: 'Stopped on an error' }); runs.delete(s);
          break;
        case 'SessionEnd':
          emit('task.cancelled', {}); runs.delete(s);
          break;
      }
      return out;
    };
  }

  const AGY_TOOL_LABELS = [
    [/^(view_file|list_dir|find|grep_search|code_search|view_code_item)/, 'Reading files', 'research'],
    [/^(search_web|read_url|browser_)/, 'Browsing the web', 'research'],
    [/^(write_to_file|replace_file_content|multi_replace|propose_code|edit)/, 'Editing files', 'coding'],
    [/^run_command|^command_status/, 'Running a command', 'coding'],
    [/^generate_image/, 'Making an image', 'other'],
    [/^manage_task|^task/, 'Planning steps', 'planning'],
  ];

  /** Antigravity CLI hook records (event name supplied by our hooks.json entry). */
  function createAntigravityAdapter() {
    const make = envelopeFactory('antigravity');
    const runs = new Map();
    let counter = 0;
    return function adapt(raw, sourceId) {
      const ev = raw.event, s = raw.conversationId;
      if (!ev || !s) return [];
      const out = [];
      let run = runs.get(s);
      const start = () => {
        run = `r${++counter}-${sourceId}`; runs.set(s, run);
        out.push(make(s, s, run, 'task.started', { shortLabel: 'Starting', taskCategory: 'other' }, sourceId + ':s', raw.received_at));
      };
      switch (ev) {
        case 'PreInvocation':
          if (!run) start();
          out.push(make(s, s, run, 'task.progress', { shortLabel: 'Thinking it through' }, sourceId, raw.received_at));
          break;
        case 'PostToolUse':
          if (!run) start();
          if (raw.error) out.push(make(s, s, run, 'task.attempt_failed', Object.assign({ attemptId: `${s}:${raw.stepIdx}`, retriable: true }, toolLabel(AGY_TOOL_LABELS, raw.tool)), sourceId, raw.received_at));
          else {
            out.push(make(s, s, run, 'task.attempt_succeeded', { attemptId: `${s}:${raw.stepIdx}` }, sourceId + ':ok', raw.received_at));
            out.push(make(s, s, run, 'task.progress', toolLabel(AGY_TOOL_LABELS, raw.tool), sourceId, raw.received_at));
          }
          break;
        case 'Stop':
          if (run) { out.push(make(s, s, run, 'task.completed', { shortLabel: 'Done' }, sourceId, raw.received_at)); runs.delete(s); }
          break;
      }
      return out;
    };
  }

  /** Codex session rollout lines (~/.codex/sessions/.../*.jsonl), read-only. */
  function createCodexAdapter() {
    const make = envelopeFactory('codex');
    const runs = new Map();        // session -> turn id
    return function adapt(raw, sourceId, fileSession) {
      const s = fileSession || (raw.payload && raw.payload.session_id) || 'unknown';
      if (raw.type !== 'event_msg' || !raw.payload) return [];
      const p = raw.payload;
      const out = [];
      switch (p.type) {
        case 'task_started': {
          const turn = p.turn_id || sourceId;
          runs.set(s, turn);
          const plan = p.collaboration_mode_kind === 'plan';
          out.push(make(s, s, turn, 'task.started', { shortLabel: plan ? 'Planning' : 'Working', thinking: plan ? 'high' : 'normal', taskCategory: plan ? 'planning' : 'other' }, sourceId, raw.timestamp));
          break;
        }
        case 'item_completed': {
          const turn = runs.get(s); if (!turn) break;
          const item = p.item || {};
          const label = /command/i.test(item.type || '') ? 'Running a command'
            : /patch|file|edit/i.test(item.type || '') ? 'Editing files'
            : /search|web/i.test(item.type || '') ? 'Searching the web'
            : /reasoning/i.test(item.type || '') ? 'Thinking it through' : null;
          if (label) out.push(make(s, s, turn, 'task.progress', { shortLabel: label }, sourceId, raw.timestamp));
          break;
        }
        case 'exec_approval_request': case 'apply_patch_approval_request': case 'request_user_input': {
          const turn = runs.get(s); if (!turn) break;
          out.push(make(s, s, turn, 'task.waiting', { waitReason: p.type === 'request_user_input' ? 'user_input' : 'approval' }, sourceId, raw.timestamp));
          break;
        }
        case 'stream_error': {
          const turn = runs.get(s); if (!turn) break;
          out.push(make(s, s, turn, 'task.attempt_failed', { attemptId: sourceId, retriable: true, shortLabel: 'Reconnecting' }, sourceId, raw.timestamp));
          break;
        }
        case 'error': {
          const turn = runs.get(s); if (!turn) break;
          out.push(make(s, s, turn, 'task.failed', { shortLabel: 'Stopped on an error' }, sourceId, raw.timestamp));
          runs.delete(s);
          break;
        }
        case 'task_complete': {
          const turn = p.turn_id || runs.get(s); if (!turn) break;
          out.push(make(s, s, turn, 'task.completed', { shortLabel: 'Done' }, sourceId, raw.timestamp));
          runs.delete(s);
          break;
        }
        case 'turn_aborted': {
          const turn = p.turn_id || runs.get(s); if (!turn) break;
          out.push(make(s, s, turn, 'task.cancelled', {}, sourceId, raw.timestamp));
          runs.delete(s);
          break;
        }
      }
      return out;
    };
  }

  return { PROVIDERS, DEFAULT_CONFIG, RANK, createStore, createClaudeAdapter, createAntigravityAdapter, createCodexAdapter, summarize };
});
