#!/bin/bash
# Removes AgentTime' hooks from Claude Code and Antigravity. Leaves every other setting alone.
set -euo pipefail
/usr/bin/python3 - <<'PY'
import json, os
home = os.path.expanduser("~")
p = os.path.join(home, ".claude", "settings.json")
if os.path.exists(p):
    s = json.load(open(p))
    hooks = s.get("hooks", {})
    for ev in list(hooks):
        hooks[ev] = [g for g in hooks[ev] if "companion-hook" not in json.dumps(g)]
        if not hooks[ev]: del hooks[ev]
    if not hooks: s.pop("hooks", None)
    json.dump(s, open(p, "w"), indent=2); open(p, "a").write("\n")
p = os.path.join(home, ".gemini", "config", "hooks.json")
if os.path.exists(p):
    s = json.load(open(p)); s.pop("agent-companions", None); s.pop("agenttime", None)
    if s: json.dump(s, open(p, "w"), indent=2)
    else: os.remove(p)
print("Disconnected Claude Code and Antigravity.")
PY
