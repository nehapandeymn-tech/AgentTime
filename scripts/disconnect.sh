#!/bin/bash
# Removes AgentTime's hooks and status lines from Claude Code and Antigravity. Leaves every other
# setting alone, and puts back any status line you had before.
set -euo pipefail
ACCOUNTS="$(/usr/bin/python3 -I "$(dirname "$0")/accounts.py")"
/usr/bin/python3 - "$ACCOUNTS" <<'PY'
import json, os, shlex, sys
home = os.path.expanduser("~")

def unhook_status(s):
    cmd = (s.get("statusLine") or {}).get("command", "")
    if "companion-hook" not in cmd: return
    parts = shlex.split(cmd)
    if len(parts) > 3: s["statusLine"]["command"] = parts[3]
    else: s.pop("statusLine", None)

for acct in json.loads(sys.argv[1]):
    p = os.path.join(acct["dir"], "settings.json")
    if not os.path.exists(p): continue
    s = json.load(open(p))
    hooks = s.get("hooks", {})
    for ev in list(hooks):
        hooks[ev] = [g for g in hooks[ev] if "companion-hook" not in json.dumps(g)]
        if not hooks[ev]: del hooks[ev]
    if not hooks: s.pop("hooks", None)
    unhook_status(s)
    json.dump(s, open(p, "w"), indent=2); open(p, "a").write("\n")
p = os.path.join(home, ".gemini", "config", "hooks.json")
if os.path.exists(p):
    s = json.load(open(p)); s.pop("agent-companions", None); s.pop("agenttime", None)
    if s: json.dump(s, open(p, "w"), indent=2)
    else: os.remove(p)
p = os.path.join(home, ".gemini", "antigravity-cli", "settings.json")
if os.path.exists(p):
    s = json.load(open(p)); unhook_status(s); json.dump(s, open(p, "w"), indent=2)
print("Disconnected Claude Code and Antigravity.")
PY
