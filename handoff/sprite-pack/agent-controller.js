(function (root) {
  'use strict';
  const characters = ['finn', 'jake', 'bmo'];
  const supported = new Set(['rest','idle','chill','thinking','retry','strained','encounter','recover','practice','complete','walk_right','walk_left','run_right','run_left','views']);
  function resolve(signal = {}) {
    if (signal.status === 'completed') return 'complete';
    if (signal.status === 'failed' || signal.strain === true) return 'strained';
    if (['idle','cancelled'].includes(signal.status)) return 'rest';
    if (signal.status === 'waiting') return 'idle';
    if (signal.recovering === true) return 'recover';
    if ((signal.consecutiveErrors || 0) >= 3) return 'strained';
    if ((signal.consecutiveErrors || 0) > 0) return 'retry';
    if (signal.thinking === 'high') return 'thinking';
    if (signal.activity === 'encounter' && signal.status === 'running') return 'encounter';
    if (signal.activity === 'practice' && signal.status === 'running') return 'practice';
    if (signal.status === 'running') return 'chill';
    return 'rest';
  }
  function createController(now = () => performance.now()) {
    const agents = Object.fromEntries(characters.map(id => [id, {state:'rest',since:now(),signal:{status:'idle'}}]));
    function setState(id, state) {
      if (!agents[id]) throw new Error('Unknown character: '+id);
      if (!supported.has(state)) throw new Error('Unknown animation: '+state);
      if (agents[id].state !== state) { agents[id].state=state; agents[id].since=now(); }
      return agents[id];
    }
    function setSignal(id, signal) {
      if (!agents[id]) throw new Error('Unknown character: '+id);
      // Signals are complete snapshots; omitted old errors must not linger.
      agents[id].signal = {...signal};
      return setState(id, resolve(signal));
    }
    return {agents,setState,setSignal,resolve};
  }
  const api={characters,supported:[...supported],resolve,createController};
  if (typeof module !== 'undefined' && module.exports) module.exports=api;
  else root.AgentSprites=api;
})(typeof window !== 'undefined' ? window : globalThis);
