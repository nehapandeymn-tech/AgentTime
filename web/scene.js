// AgentTime scene: choreography + canvas renderer. Reads the store, never writes task truth.
(function () {
  'use strict';
  const C = window.CompanionCore;
  const P = C.PROVIDERS;

  const W = 380, H = 156, GROUND = 104;
  const HEIGHT = { finn: 58, jake: 58, bmo: 46, group: 60, 'ice-king': 66 };
  const ATLAS_FILES = ['finn-core', 'jake-core', 'bmo-core', 'finn-context', 'jake-context', 'bmo-context', 'ice-king', 'group'];
  const CONTEXT_STATES = new Set(['chill', 'thinking', 'retry', 'strained', 'encounter', 'recover']);
  const WALK_SPEED = 120;                  // logical px / s
  const ONE_SHOT_MS = { complete: 3000, recover: 3300 };

  const store = C.createStore({});
  const adapters = { claude: C.createClaudeAdapter(), antigravity: C.createAntigravityAdapter(), codex: C.createCodexAdapter() };
  const cfg = store.config;

  // Stable slots from the configured order: work slots spread out, rest spots huddle in the middle.
  const WORK_X = {}, REST_X = {}, COL_X = {};
  cfg.workSlotOrder.forEach((p, i) => { WORK_X[p] = [64, 190, 316][i]; COL_X[p] = WORK_X[p]; REST_X[p] = [116, 190, 264][i]; });

  const chars = {};
  for (const p of P) chars[p] = { x: REST_X[p], seq: null, seqStart: 0, oneShot: null, last: null };

  let manifest = null;
  const images = {};
  let reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let paused = false, visible = true, hover = null, rafId = 0, handleHot = false;
  let iceKing = null;                       // {target, mode:'cast'|'resolved', start}

  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  const live = document.getElementById('live');
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';

  // ------------------------------------------------------------ assets

  async function loadAssets() {
    try { manifest = await (await fetch('sprites/manifest.json')).json(); } catch { manifest = null; }
    await Promise.all(ATLAS_FILES.map(k => new Promise(res => {
      const img = new Image();
      img.onload = () => { images[k] = img; res(); };
      img.onerror = () => { images[k] = null; res(); };   // a missing sheet must not look like a task error
      img.src = `sprites/${k}.png`;
    })));
  }

  // ------------------------------------------------------------ ingest (from the native shell)

  function ingestBatch(items) {
    for (const it of items) {
      let raw;
      try { raw = JSON.parse(it.line); } catch { continue; }
      const adapt = adapters[it.source];
      if (!adapt) continue;
      let envs = [];
      try { envs = adapt(raw, it.id, it.session); } catch { envs = []; }
      for (const e of envs) store.ingest(e, { replay: !!it.replay });
    }
    wake();
  }

  // ------------------------------------------------------------ choreography

  function seqName(p, r, c, now) {
    if (c.moving) return c.dir > 0 ? 'walk_right' : 'walk_left';
    if (c.oneShot) return c.oneShot.kind === 'complete' ? 'complete' : 'recover';
    return r.state;      // rest | idle | practice | chill | thinking | retry | strained | encounter
  }

  function step(now, dt) {
    const res = {};
    for (const p of P) {
      const r = store.resolve(p);
      res[p] = r;
      const c = chars[p];
      if (!c.oneShot) {
        const s = store.takeOneShot(p);
        if (s) { c.oneShot = { kind: s.kind, count: s.count, end: now + ONE_SHOT_MS[s.kind] }; if (s.kind === 'complete') store.clearBadge(p); }
      }
      if (c.oneShot && (now >= c.oneShot.end || (c.oneShot.kind === 'recover' && r.rank <= C.RANK.needsUser))) c.oneShot = null;

      const target = c.oneShot ? c.x : (r.resting || r.unavailable ? REST_X[p] : WORK_X[p]);
      const d = target - c.x;
      if (Math.abs(d) < 1 || reducedMotion || paused) { c.x = target; c.moving = false; }
      else { c.moving = true; c.dir = Math.sign(d); c.x += Math.sign(d) * Math.min(Math.abs(d), WALK_SPEED * dt); }

      const name = seqName(p, r, c, now);
      if (name !== c.seq) { c.seq = name; c.seqStart = now; }
      if (r.label !== (c.last && c.last.label)) announce(p, r);
      c.last = r;
    }

    // Ice King: optional, one target at most, never aimed at a resting companion.
    const fighters = P.filter(p => res[p].state === 'encounter' && !chars[p].moving);
    if (fighters.length) {
      const target = fighters.sort((a, b) => res[a].rank - res[b].rank)[0];
      if (!iceKing || iceKing.mode !== 'cast') iceKing = { target, mode: 'cast', start: now };
      else iceKing.target = target;
    } else if (iceKing && iceKing.mode === 'cast') {
      const ended = res[iceKing.target];
      iceKing = ended.resting || chars[iceKing.target].oneShot ? { mode: 'resolved', start: now } : null;
    } else if (iceKing && iceKing.mode === 'resolved' && now - iceKing.start > 1600) iceKing = null;
    return res;
  }

  function announce(p, r) {
    if (!live) return;
    live.textContent = `${cfg.labels[p]}: ${r.label}`;
  }

  // ------------------------------------------------------------ drawing

  function frameIndex(seq, elapsed, loopAlways) {
    const n = seq.frames.length;
    if (reducedMotion || paused) return Math.floor(n / 2);       // representative pose, not a neutral frame 0
    const tick = Math.floor(elapsed * seq.fps / 1000);
    return seq.loop || loopAlways ? tick % n : Math.min(tick, n - 1);
  }

  function drawSprite(atlasKey, state, x, height, elapsed) {
    if (!manifest) return;
    const atlas = manifest.atlases[atlasKey];
    const img = images[atlasKey];
    if (!atlas || !img || !atlas.states[state]) return;
    const seq = atlas.states[state];
    const f = seq.frames[frameIndex(seq, elapsed)];
    const s = height / atlas.referenceHeight;
    ctx.drawImage(img, f.x, f.y, f.w, f.h,
      Math.round((x - f.anchorX * s) * dpr), Math.round((GROUND - f.anchorY * s) * dpr),
      Math.round(f.w * s * dpr), Math.round(f.h * s * dpr));
  }

  function drawCharacter(p, now) {
    const c = chars[p];
    const ch = cfg.characters[p];
    const atlas = CONTEXT_STATES.has(c.seq) ? `${ch}-context` : `${ch}-core`;
    drawSprite(atlas, c.seq, c.x, HEIGHT[ch], now - c.seqStart);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function text(str, x, y, opts = {}) {
    ctx.font = `${opts.weight || 500} ${(opts.size || 11) * dpr}px -apple-system, "SF Pro Text", system-ui, sans-serif`;
    ctx.textAlign = opts.align || 'center';
    ctx.textBaseline = 'alphabetic';
    let s = str;
    const max = (opts.max || 999) * dpr;
    while (s.length > 3 && ctx.measureText(s).width > max) s = s.slice(0, -2);
    if (s !== str) s = s.trimEnd() + '…';
    ctx.fillStyle = opts.color || 'rgba(255,255,255,0.92)';
    ctx.fillText(s, x * dpr, y * dpr);
  }

  const STATE_COLOR = { rest: '#8b93a7', idle: '#f5c451', chill: '#7fd4a8', thinking: '#9db8ff', practice: '#7fd4a8',
    retry: '#ffb35c', strained: '#ff7a6b', encounter: '#9fe3ff', unavailable: '#8b93a7' };

  function statusLine(p, r) {
    const c = chars[p];
    if (c.oneShot) return c.oneShot.kind === 'complete' ? (c.oneShot.count > 1 ? `Done ×${c.oneShot.count}` : 'Done') : 'Back on track';
    return r.label;
  }

  function draw(now, res) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;

    // Glass card so labels read over any wallpaper or window.
    roundRect(0.5 * dpr, 0.5 * dpr, (W - 1) * dpr, (H - 1) * dpr, 14 * dpr);
    ctx.fillStyle = 'rgba(17, 20, 30, 0.66)'; ctx.fill();
    ctx.lineWidth = dpr; ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(14 * dpr, (GROUND + 1) * dpr, (W - 28) * dpr, dpr);

    const huddle = P.every(p => res[p].resting && !chars[p].moving && !chars[p].oneShot && Math.abs(chars[p].x - REST_X[p]) < 1);
    if (huddle) {
      drawSprite('group', 'huddle', REST_X[cfg.workSlotOrder[1]], HEIGHT.group, now);   // one sprite, three friends
    } else {
      // Draw resting characters first so working ones sit on top.
      const order = [...P].sort((a, b) => (res[b].resting ? 1 : 0) - (res[a].resting ? 1 : 0));
      for (const p of order) drawCharacter(p, now);
    }
    if (iceKing) drawSprite('ice-king', iceKing.mode === 'cast' ? 'cast' : 'resolved', W - 26, HEIGHT['ice-king'], now - iceKing.start);

    // Provider columns: names stay put while characters move.
    for (const p of P) {
      const r = res[p];
      const x = COL_X[p];
      const dot = r.unavailable ? STATE_COLOR.unavailable : STATE_COLOR[chars[p].oneShot ? 'chill' : r.state] || STATE_COLOR.idle;
      text(cfg.labels[p], x + 4, GROUND + 22, { weight: 700, size: 11.5, max: 110 });
      const nameW = ctx.measureText(cfg.labels[p]).width / dpr;
      ctx.fillStyle = dot;
      ctx.beginPath(); ctx.arc((x + 4 - nameW / 2 - 7) * dpr, (GROUND + 18) * dpr, 3 * dpr, 0, Math.PI * 2); ctx.fill();
      const badge = r.badge ? `  ✓${r.badge}` : '';
      text(statusLine(p, r) + badge, x, GROUND + 37, { size: 10.5, max: 120, color: huddle ? 'rgba(255,255,255,0.6)' : dot });
      if (r.summary) text(r.summary, x, GROUND + 50, { size: 9.5, max: 120, color: 'rgba(255,255,255,0.55)' });
    }

    // Grab handle: the only part of the widget that takes the mouse (drag it, right-click it).
    roundRect((W / 2 - 22) * dpr, 7 * dpr, 44 * dpr, 5 * dpr, 2.5 * dpr);
    ctx.fillStyle = handleHot ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.25)'; ctx.fill();

    if (paused) text('Paused', W - 14, 18, { align: 'right', size: 10, color: 'rgba(255,255,255,0.6)' });
    if (hover) drawHover(res);
  }

  function drawHover(res) {
    const p = P.reduce((best, q) => Math.abs(COL_X[q] - hover.x) < Math.abs(COL_X[best] - hover.x) ? q : best, P[0]);
    const r = res[p];
    const ts = [...store.tasks.values()].filter(t => t.provider === p).map(t => t.updatedAt);
    const ago = ts.length ? Math.max(0, Math.round((Date.now() - Math.max(...ts)) / 1000)) : null;
    const lines = [
      `${cfg.labels[p]} · ${cfg.characters[p][0].toUpperCase() + cfg.characters[p].slice(1)}`,
      r.unavailable ? 'No live status: hooks not installed or tool not running' : `${r.counts.total} open task${r.counts.total === 1 ? '' : 's'}${r.summary ? ' · ' + r.summary : ''}`,
      ago == null ? 'No events yet' : `Last update ${ago < 60 ? ago + 's' : Math.round(ago / 60) + 'm'} ago`,
    ];
    const bw = 230, bh = 52, bx = Math.min(Math.max(8, hover.x - bw / 2), W - bw - 8), by = 18;
    roundRect(bx * dpr, by * dpr, bw * dpr, bh * dpr, 8 * dpr);
    ctx.fillStyle = 'rgba(8, 10, 16, 0.92)'; ctx.fill();
    lines.forEach((l, i) => text(l, bx + 10, by + 16 + i * 14, { align: 'left', size: i ? 10 : 11, weight: i ? 500 : 700, max: bw - 20, color: i ? 'rgba(255,255,255,0.75)' : '#fff' }));
  }

  // ------------------------------------------------------------ loop

  let lastT = 0, lastPrune = 0;
  function loop(t) {
    rafId = 0;
    const now = performance.now();
    const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0;
    lastT = now;
    const res = step(now, dt);
    draw(now, res);
    if (now - lastPrune > 30000) { store.prune(); lastPrune = now; }
    if (visible) rafId = requestAnimationFrame(loop);
  }
  function wake() { if (visible && !rafId) { lastT = 0; rafId = requestAnimationFrame(loop); } }

  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', e => { reducedMotion = e.matches; });

  // ------------------------------------------------------------ API for the native shell

  window.Companions = {
    ingestBatch,
    setConnection: (p, s) => { store.setConnection(p, s); wake(); },
    providerStopped: p => { store.providerStopped(p); wake(); },
    acknowledgeFailures: () => { P.forEach(p => store.acknowledgeFailures(p)); wake(); },
    setVisible: v => { visible = v; if (v) wake(); },
    setPaused: v => { paused = v; wake(); },
    setReducedMotion: v => { reducedMotion = v; wake(); },
    setEncounters: v => { cfg.encounters = v; wake(); },
    hover: (x, y) => { hover = x == null ? null : { x, y }; wake(); },
    setHandle: on => { handleHot = on; wake(); },
    snapshotState: () => P.map(p => { const r = store.resolve(p); return { provider: p, state: r.state, label: r.label, x: chars[p].x, seq: chars[p].seq }; }),
    _store: store,
  };

  loadAssets().then(() => {
    wake();
    try { window.webkit.messageHandlers.companions.postMessage({ type: 'ready' }); } catch { /* browser preview */ }
    if (location.search.includes('demo')) runDemo();
  });

  // ------------------------------------------------------------ demo (browser preview only)

  function runDemo() {
    P.forEach(p => store.setConnection(p, 'healthy'));
    let n = 0;
    const L = (source, obj) => ({ source, line: JSON.stringify(obj), id: `demo${++n}`, session: 'demo' });
    const steps = [
      [800, [L('claude', { hook_event_name: 'UserPromptSubmit', session_id: 'd', prompt_id: 'p1' }), L('claude', { hook_event_name: 'PreToolUse', session_id: 'd', tool_name: 'Read' })]],
      [2500, [L('codex', { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', collaboration_mode_kind: 'plan' } })]],
      [2500, [L('antigravity', { event: 'PreInvocation', conversationId: 'c' })]],
      [2000, [L('antigravity', { event: 'PostToolUse', conversationId: 'c', tool: 'run_command', stepIdx: 1, error: 'exit 1' })]],
      [2500, [L('antigravity', { event: 'PostToolUse', conversationId: 'c', tool: 'run_command', stepIdx: 2, error: 'exit 1' })]],
      [2500, [L('antigravity', { event: 'PostToolUse', conversationId: 'c', tool: 'run_command', stepIdx: 3, error: 'exit 1' })]],
      [2500, [L('antigravity', { event: 'PostToolUse', conversationId: 'c', tool: 'run_command', stepIdx: 4 })]],
      [3000, [L('claude', { hook_event_name: 'Stop', session_id: 'd' })]],
      [3500, [L('codex', { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } })]],
      [3500, [L('antigravity', { event: 'Stop', conversationId: 'c' })]],
    ];
    let t = 0;
    for (const [d, batch] of steps) { t += d; setTimeout(() => ingestBatch(batch), t); }
  }
})();
