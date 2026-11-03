#!/bin/bash
# Connects AgentTime to the agents on this Mac. Safe to run again: it backs up settings once,
# keeps everything else, and replaces (never duplicates) its own hooks.
#   Claude Code  -> background hooks in ~/.claude/settings.json
#   Antigravity  -> watch-only hooks in ~/.gemini/config/hooks.json
#   Codex        -> nothing to change (the app reads its session logs)
set -euo pipefail
HOOK="/Applications/AgentTime.app/Contents/MacOS/companion-hook"
[[ -x "$HOOK" ]] || { echo "Install the app first: ./build.sh --install"; exit 1; }
/usr/bin/python3 - "$HOOK" <<'PY'
import json, os, shutil, sys
hook, home, done = sys.argv[1], os.path.expanduser("~"), []

def load(p):
    if not os.path.exists(p): return {}
    if not os.path.exists(p + ".bak-companions"): shutil.copy(p, p + ".bak-companions")
    return json.load(open(p))

def save(p, data):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    json.dump(data, open(p, "w"), indent=2); open(p, "a").write("\n")

if os.path.isdir(os.path.join(home, ".claude")) or shutil.which("claude"):
    p = os.path.join(home, ".claude", "settings.json")
    s = load(p)
    hooks = s.setdefault("hooks", {})
    tool_events = {"PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Notification"}
    for ev in ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
               "PermissionRequest", "Notification", "Stop", "StopFailure"]:
        groups = [g for g in hooks.get(ev, []) if "companion-hook" not in json.dumps(g)]   # drop older copies
        hooks[ev] = groups
        h = {"type": "command", "command": hook, "args": ["claude"], "async": True, "timeout": 5}
        groups.append({"matcher": "", "hooks": [h]} if ev in tool_events else {"hooks": [h]})
    save(p, s); done.append("Claude Code (Finn)")

if os.path.isdir(os.path.join(home, ".gemini")) or shutil.which("agy"):
    p = os.path.join(home, ".gemini", "config", "hooks.json")
    s = load(p)
    def h(ev): return {"type": "command", "command": f"\"{hook}\" antigravity {ev} 2>/dev/null || echo '{{}}'", "timeout": 5}
    s.pop("agent-companions", None)                  # entry from the app's old name
    s["agenttime"] = {"SessionStart": [h("SessionStart")], "PreInvocation": [h("PreInvocation")],
                             "PostToolUse": [{"matcher": "*", "hooks": [h("PostToolUse")]}], "Stop": [h("Stop")]}
    save(p, s); done.append("Antigravity (Jake)")

if os.path.isdir(os.path.join(home, ".codex")) or shutil.which("codex"):
    done.append("Codex (BMO), nothing to change")

print("Connected: " + (", ".join(done) if done else "no supported agents found"))
PY
