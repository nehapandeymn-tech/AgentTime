HANDOFF COPY — USER-CONFIRMED MAPPING
Antigravity = Jake; Claude = Finn; Codex = BMO.
Read ../START-HERE-CLAUDE.txt for the full implementation specification.
The demo uses character IDs internally; its cards show provider names.

ADVENTURE TIME — AGENT COMPANION SPRITE PACK
Created 3 November 2026

START HERE
Open preview.html in your browser. Choose a state separately for Finn, Jake,
and BMO, or select Play task story to see a sample workflow. Everyone rest
returns the three to their huddle. Light / dark demonstrates transparency.
The additional viewer contains Ice King's drumming, casting and views,
plus the group's waking, returning and celebration animations.
The preview is local and does not connect to or monitor your agents.

DELIVERABLES
8 original transparent RGBA PNG atlases, 322 measured frame rectangles:
- finn-core.png, jake-core.png, bmo-core.png: 54 frames each, 1024 x 1536.
- finn-context.png, jake-context.png, bmo-context.png: 36 each, 1254 x 1254.
- ice-king.png: 36 frames, 1254 x 1254.
- group.png: 16 group frames, 1536 x 1024.
manifest.json / manifest.js: measured source rectangles and playback rates.
agent-controller.js: independent state resolver and controller.
preview.html / preview.js: example renderer and manual controls.
Three *prompts.json files contain the exact final generation prompt set.
All artwork used the built-in image-generation tool. Original alpha retained.

CHARACTER RESEARCH & DESIGN CHOICES
Your reference is Finn the Human. The yellow dog is Jake; the little living
game-console robot is BMO. The look follows the supplied chunky pixel Finn.

FINN: the early Golden Sword of Battle is also called Scarlet. That informed
the golden sword used for practice and the completion salute. Calm work is
an original map-reading loop; focused work is a chin/hat-thinking gesture.
Source: https://adventuretime.fandom.com/wiki/Finn%27s_swords

JAKE: his easy-going personality and Stretchy Powers support relaxed food
play and elastic action. The pack uses sandwich-making for easy work, an
arm knot for retries, and a stretchy shield/punch for an optional encounter.
Source: https://adventuretime.fandom.com/wiki/Jake

BMO: a living game console with a playful imagination, games and musical
interests. Here, easy work is dancing, ordinary action is controller play,
thinking is a concentrated screen face, and completion is a check and hop.
Source: https://adventuretime.fandom.com/wiki/BMO

ICE KING: his magical crown supplies ice powers, and the story reveals his
former identity, Simon Petrikov, and loneliness. He is treated as a comic,
sympathetic obstacle rather than a universally evil enemy. An optional
ice-casting encounter represents a difficult task, resolving with a wave.
Peaceful drumming is included because he also plays drums in the series.
Sources: https://en.wikipedia.org/wiki/Ice_King
         https://adventuretime.fandom.com/wiki/Ice_King

The work/status meanings, map-reading routine, error knots, screen symbols,
bandages, huddle and task transitions are original design interpretations,
not claims that these exact sequences occur in the show. This is an
unofficial character asset pack, not an official Adventure Time release.

ROW MAPS (one-based rows, frames run left to right)
CORE SHEETS — six frames per row
1 views: front, right, back, left, front three-quarter, back three-quarter
2 idle: breathing / blink
3 walk_right
4 walk_left
5 run_right
6 run_left
7 practice: Finn sword attack / Jake stretchy punch / BMO controller game
8 complete: salute / celebration / check-and-dance
9 rest: seated Finn / curled Jake / sleepy BMO

CONTEXT SHEETS — six frames per row
1 chill: map / sandwich / dance
2 thinking: concentration
3 retry: recoverable error / frustration
4 strained: repeated errors / comic exhaustion and mild bandage
5 encounter: brace against incoming ice, facing right
6 recover: regain composure and readiness

ICE KING — six frames per row
1 views; 2 idle; 3 cast (left); 4 hover (left); 5 drums; 6 resolved

GROUP — four frames per row
1 huddle; 2 wake; 3 return; 4 complete

STATE BEHAVIOR
All three rest -> the dedicated sleeping huddle.
One or more working -> only those characters work; the others rest nearby.
Running normally -> peaceful, character-specific activity.
High thinking -> concentration, not injury or failure.
One or two consecutive errors -> retry/frustration.
Three or more errors, failed status, or explicit strain -> mild comic strain.
Explicit encounter activity -> ice challenge, with Ice King on the right.
Recovery -> healthy reset, then peaceful work.
Completed -> one completion gesture, hold briefly, then return to rest.
Waiting -> awake idle. Cancelled -> rest.
The threshold of three errors is a configurable design default, not a
measured universal definition of task difficulty. Feed actual task events;
do not infer an error solely from elapsed time or a long thinking phase.

INTEGRATION
Load agent-controller.js for the framework-independent state mapping.
In the example preview, these functions are available on window:

  setAgentSignal('finn', {status:'running', thinking:'high'});
  setAgentSignal('jake', {status:'running', consecutiveErrors:1});
  setAgentSignal('bmo', {status:'running', activity:'encounter'});
  setAgentSignal('finn', {status:'completed'});
  setAgentState('jake', 'walk_left');

Signal calls are full snapshots (old omitted errors are cleared). Send them
on meaningful event changes. Do not repeatedly emit completed after the
completion animation has returned to rest unless a new task has completed.
Map your own agent IDs to finn/jake/bmo. No service credentials are required.

To use the controller elsewhere:
  const controller = AgentSprites.createController();
  controller.setSignal('finn', {status:'running', consecutiveErrors:3});
  // controller.agents.finn.state === 'strained'

Use manifest.atlases[atlasName].states[state].frames for source rectangles.
Each frame has x, y, w, h, anchorX and anchorY. For an anchor position (X,Y)
and scale S, draw at (X-anchorX*S, Y-anchorY*S), size (w*S,h*S).
Use nearest-neighbor sampling (imageSmoothingEnabled=false).
Play loop=false states once, then let your app choose the next state.
The example holds completion/recovery for 1.8 seconds after the sequence.
Views are static direction choices, not a locomotion animation; the preview
cycles them only to let you inspect every angle.

SCOPE & QUALITY NOTES
The sheets include front/back/left/right static views and left/right motion.
They do not include front/back walking or running cycles.
Generated spacing is not a perfect uniform grid: use measured rectangles,
not an assumed tile size. Actual output sizes differ from requested sizes.
Body-color anchors and row baselines reduce frame-placement drift.
The artwork has small frame-to-frame drawing and scale variations; it has
not had a manual pixel-by-pixel animation cleanup. These are usable draft
animation assets rather than a claim of hand-polished production animation.
Transparent pixels retain hidden RGB color; alpha-aware renderers display
them correctly. Do not flatten against that hidden color.

VALIDATION
Inspected all eight complete sheets visually. Checked alpha transparency,
frame bounds and 322 nonempty frame rectangles, script syntax and state
mapping. The in-app browser blocked local-file previews, so the HTML preview
was not visually tested in a browser here. No live agent integration was
installed or tested. Open the preview locally to review motion at your
intended display size before integrating.
