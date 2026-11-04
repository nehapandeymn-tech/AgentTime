// AgentTime scene: choreography + canvas renderer. Reads the store, never writes task truth.
(function () {
  'use strict';
  const C = window.CompanionCore;
  const P = C.PROVIDERS;

  const W = 380, H = 186, GROUND = 104;
  const BAR_Y = GROUND + 6, ROW_H = 13, U = 1.5;   // health bars sit right under the characters; U = one bar 'pixel'
  const NAME_Y = GROUND + 46;                       // room for two account rows above the names
  const HEIGHT = { finn: 58, jake: 58, bmo: 46, group: 60, 'ice-king': 66 };
  const ATLAS_FILES = ['finn-core', 'jake-core', 'bmo-core', 'finn-context', 'jake-context', 'bmo-context', 'ice-king', 'group', 'death'];
  const DEATH_STATES = new Set(['die', 'grave', 'poof']);
  const POOF_MS = 450;
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
  let limits = {};                          // provider -> [{name, known, left, limit, dead, resetsAt}] (one per account)
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
    for (const ch of ['finn', 'jake', 'bmo']) images[`${ch}-death`] = images.death;   // one sheet, three rows
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
    if (c.poofUntil && now < c.poofUntil) return 'poof';
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
      const dead = isDead(p);
      if (dead && !c.deadSince) { c.deadSince = now; c.oneShot = null; }
      if (!dead && c.deadSince) { c.deadSince = 0; c.poofUntil = now + POOF_MS; }
      if (dead) {
        c.moving = false; c.x = WORK_X[p];                  // the tombstone stands over its own health bar
        const name = reducedMotion ? 'grave' : 'die';         // 'die' plays once and ends on the tombstone
        if (name !== c.seq) { c.seq = name; c.seqStart = c.deadSince; }
        if (!c.last || !c.last.dead) announceText(`${cfg.labels[p]}: out of tokens`);
        c.last = { ...r, dead: true };
        continue;
      }
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

  function announce(p, r) { announceText(`${cfg.labels[p]}: ${r.label}`); }
  function announceText(t) { if (live) live.textContent = t; }

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
    const atlas = DEATH_STATES.has(c.seq) ? `${ch}-death` : CONTEXT_STATES.has(c.seq) ? `${ch}-context` : `${ch}-core`;
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
    if (c.deadSince) return 'Out of tokens' + backIn(p);
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

    const huddle = P.every(p => res[p].resting && !chars[p].deadSince && !chars[p].moving && !chars[p].oneShot && Math.abs(chars[p].x - REST_X[p]) < 1);
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
      const dead = !!chars[p].deadSince;
      const dot = dead ? STATE_COLOR.unavailable : r.unavailable ? STATE_COLOR.unavailable : STATE_COLOR[chars[p].oneShot ? 'chill' : r.state] || STATE_COLOR.idle;
      text(cfg.labels[p], x + 4, NAME_Y, { weight: 700, size: 11.5, max: 110 });
      const nameW = ctx.measureText(cfg.labels[p]).width / dpr;
      ctx.fillStyle = dot;
      ctx.beginPath(); ctx.arc((x + 4 - nameW / 2 - 7) * dpr, (NAME_Y - 4) * dpr, 3 * dpr, 0, Math.PI * 2); ctx.fill();
      const badge = r.badge ? `  ✓${r.badge}` : '';
      const asking = r.rank === C.RANK.needsUser && !dead;
      const flash = asking && !reducedMotion && !paused && Math.floor(now / 500) % 2 === 1;
      text(statusLine(p, r) + badge, x, NAME_Y + 15, { size: 10.5, weight: asking ? 700 : 500, max: 120,
        color: dead ? 'rgba(255,255,255,0.55)' : asking ? (flash ? '#ffffff' : '#ffcc33') : huddle ? 'rgba(255,255,255,0.6)' : dot });
      if (asking) drawAsk(p, now);
      if (r.summary && !dead) text(r.summary, x, NAME_Y + 28, { size: 9.5, max: 120, color: 'rgba(255,255,255,0.55)' });
    }

    for (const p of P) drawHealth(p, now);

    // Grab handle: the only part of the widget that takes the mouse (drag it, right-click it).
    roundRect((W / 2 - 22) * dpr, 7 * dpr, 44 * dpr, 5 * dpr, 2.5 * dpr);
    ctx.fillStyle = handleHot ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.25)'; ctx.fill();

    if (paused) text('Paused', W - 14, 18, { align: 'right', size: 10, color: 'rgba(255,255,255,0.6)' });
  }


  // ------------------------------------------------------------ health bars and tombstones

  // An agent is out only when every account we know about is out. Accounts with no numbers yet don't count.
  function isDead(p) {
    const known = (limits[p] || []).filter(a => a.known);
    return known.length > 0 && known.every(a => a.dead);
  }
  function backIn(p) {
    const times = (limits[p] || []).filter(a => a.dead && a.resetsAt).map(a => a.resetsAt);
    if (!times.length) return '';
    const mins = Math.max(1, Math.round((Math.min(...times) * 1000 - Date.now()) / 60000));
    return mins >= 60 * 24 ? ` · back in ${Math.round(mins / 1440)}d` : mins >= 60 ? ` · back in ${Math.floor(mins / 60)}h ${mins % 60}m` : ` · back in ${mins}m`;
  }

  // 3×5 pixel font for the bars: digits, capitals, % and a dash.
  const GLYPH = {
    '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111',
    '4': '101101111001001', '5': '111100111001111', '6': '111100111101111', '7': '111001001010010',
    '8': '111101111101111', '9': '111101111001111', '%': '101001010100101', '-': '000000111000000',
    'A': '010101111101101', 'B': '110101110101110', 'C': '011100100100011', 'D': '110101101101110',
    'E': '111100110100111', 'F': '111100110100100', 'G': '011100101101011', 'H': '101101111101101',
    'I': '111010010010111', 'J': '001001001101010', 'K': '101101110101101', 'L': '100100100100111',
    'M': '101111111101101', 'N': '110101101101101', 'O': '010101101101010', 'P': '110101110100100',
    'Q': '010101101110011', 'R': '110101110101101', 'S': '011100010001110', 'T': '111010010010010',
    'U': '101101101101111', 'V': '101101101101010', 'W': '101101111111101', 'X': '101101010101101',
    'Y': '101101010010010', 'Z': '111001010100111', '.': '000000000000010',
  };

  // Bar graphics are drawn on a coarse grid (U logical px per pixel) so they match the sprites' chunky pixels.
  let gx = 0, gy = 0;
  function px(x, y, w, h, color) { ctx.fillStyle = color; ctx.fillRect((gx + x * U) * dpr, (gy + y * U) * dpr, w * U * dpr, h * U * dpr); }
  function pixelText(str, x, y, color) {
    let cx = x;
    for (const ch of str.toUpperCase()) {
      const g = GLYPH[ch];
      if (g) for (let i = 0; i < 15; i++) if (g[i] === '1') px(cx + (i % 3), y + Math.floor(i / 3), 1, 1, color);
      cx += 4;
    }
  }
  const textW = str => str.length * 4 - 1;

  const SEGMENTS = 8, SEG_W = 3, BH = 7;
  function barColors(frac) {
    if (frac > 0.5) return ['#4cd964', '#a6f5b0'];
    if (frac > 0.2) return ['#ffcc33', '#ffe9a0'];
    return ['#ff4d4d', '#ffb0a8'];
  }

  function drawHealth(p, now) {
    let accts = limits[p] || [];
    if (!accts.length) accts = [{ name: '', known: false }];
    const named = accts.length > 1;
    const nameW = named ? Math.max(...accts.map(a => textW((a.name || '?').slice(0, 8)))) + 3 : 0;
    accts.forEach((a, row) => drawBar(a, COL_X[p], BAR_Y + row * ROW_H, named ? (a.name || '?').slice(0, 8) : '', nameW, now));
  }

  function drawBar(a, x, y, name, nameW, now) {
    const has = !!a.known;
    const frac = has ? Math.max(0, Math.min(1, a.left)) : 0;
    const [fill, shine] = barColors(frac);
    const barW = SEGMENTS * SEG_W + 3;              // frame, 1 gap, segments (2 wide + 1 gap), frame
    const label = !has ? '-' : `${Math.round(frac * 100)}%`;
    const total = nameW + barW + 2 + textW('100%');
    gx = Math.round(x - total * U / 2); gy = y;
    let cx = 0;
    if (name) pixelText(name, nameW - 3 - textW(name), 1, has ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.35)');
    cx += nameW;

    // Nearly out: the lit segments blink. Out: an empty bar.
    const blinkOff = has && frac <= 0.1 && frac > 0 && !reducedMotion && !paused && Math.floor(now / 400) % 2 === 1;
    const edge = 'rgba(255,255,255,0.4)';
    px(cx, 0, barW, BH, '#0b0d14');
    px(cx + 1, 0, barW - 2, 1, edge); px(cx + 1, BH - 1, barW - 2, 1, edge);
    px(cx, 1, 1, BH - 2, edge); px(cx + barW - 1, 1, 1, BH - 2, edge);
    const lit = has && frac > 0 && !blinkOff ? Math.max(1, Math.ceil(frac * SEGMENTS)) : 0;
    for (let i = 0; i < SEGMENTS; i++) {
      const sx = cx + 2 + i * SEG_W;
      if (i < lit) {
        px(sx, 1, SEG_W - 1, BH - 2, fill);
        px(sx, 1, SEG_W - 1, 1, shine);
        px(sx, BH - 2, SEG_W - 1, 1, 'rgba(0,0,0,0.28)');
      } else px(sx, 1, SEG_W - 1, BH - 2, 'rgba(255,255,255,0.08)');
    }
    cx += barW + 2;
    pixelText(label, cx, 1, has ? fill : 'rgba(255,255,255,0.35)');
  }

  // Waiting on you: a bouncing pixel "!" bubble over the character's head.
  function drawAsk(p, now) {
    const c = chars[p];
    const ch = cfg.characters[p];
    const bob = reducedMotion || paused ? 0 : Math.round(Math.abs(Math.sin(now / 220)) * 4);
    const Z = 2;                                       // bubble pixels are 2 bar pixels
    gx = Math.round(c.x + 6); gy = Math.round(GROUND - HEIGHT[ch] - 26 - bob);
    const B = ['01111110', '11111111', '11111111', '11111111', '11111111', '11111111', '01111110', '00111000', '00110000', '00100000'];
    B.forEach((row, y) => { for (let x = 0; x < 8; x++) if (row[x] === '1') px(x * Z, y * Z, Z, Z, '#ffcc33'); });
    px(0, 2 * Z, Z / 2, 3 * Z, '#ffe9a0');           // a little shine on the left edge
    px(3.5 * Z, 1 * Z, Z, 3 * Z, '#1b1f2b'); px(3.5 * Z, 5 * Z, Z, Z, '#1b1f2b');
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
    setLimits: l => { limits = l || {}; wake(); },
    snapshotState: () => P.map(p => { const r = store.resolve(p); return { provider: p, state: r.state, label: r.label, x: chars[p].x, seq: chars[p].seq, needsYou: r.rank === C.RANK.needsUser, dead: !!chars[p].deadSince, limits: limits[p] || [] }; }),
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
