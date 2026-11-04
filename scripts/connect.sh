#!/bin/bash
# Connects AgentTime to the agents on this Mac. Safe to run again: it backs up settings once,
# keeps everything else, and replaces (never duplicates) its own hooks.
#   Claude Code  -> background hooks + a status line (for the health bar) in ~/.claude/settings.json,
#                   and in every other Claude config folder an alias uses (CLAUDE_CONFIG_DIR = a second account)
#   Antigravity  -> watch-only hooks in ~/.gemini/config/hooks.json + a status line in
#                   ~/.gemini/antigravity-cli/settings.json
#   An existing status line keeps working: AgentTime reads the numbers, then shows your own line.
#   Codex        -> nothing to change (the app reads its session logs)
set -euo pipefail
HOOK="/Applications/AgentTime.app/Contents/MacOS/companion-hook"
[[ -x "$HOOK" ]] || { echo "Install the app first: ./build.sh --install"; exit 1; }
ACCOUNTS="$(/usr/bin/python3 -I "$(dirname "$0")/accounts.py")"
/usr/bin/python3 - "$HOOK" "$ACCOUNTS" <<'PY'
import json, os, shlex, shutil, sys
hook, home, done = sys.argv[1], os.path.expanduser("~"), []
accounts = json.loads(sys.argv[2])

def status_line(s, tool):
    """Point the status line at the hook, chaining whatever status line was there before."""
    old = s.get("statusLine") or {}
    cmd = old.get("command", "") if isinstance(old, dict) else ""
    if "companion-hook" in cmd:                      # ours already: keep whatever it chains
        parts = shlex.split(cmd); cmd = parts[3] if len(parts) > 3 else ""
    new = f"{shlex.quote(hook)} statusline {tool}" + (f" {shlex.quote(cmd)}" if cmd else "")
    s["statusLine"] = {**(old if isinstance(old, dict) else {}), "type": "command", "command": new}

def load(p):
    if not os.path.exists(p): return {}
    if not os.path.exists(p + ".bak-companions"): shutil.copy(p, p + ".bak-companions")
    return json.load(open(p))

def save(p, data):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    json.dump(data, open(p, "w"), indent=2); open(p, "a").write("\n")

if os.path.isdir(os.path.join(home, ".claude")) or shutil.which("claude"):
    for acct in accounts:
        if not os.path.isdir(acct["dir"]): continue
        p = os.path.join(acct["dir"], "settings.json")
        s = load(p)
        hooks = s.setdefault("hooks", {})
        tool_events = {"PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Notification"}
        for ev in ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
                   "PermissionRequest", "Notification", "Stop", "StopFailure"]:
            groups = [g for g in hooks.get(ev, []) if "companion-hook" not in json.dumps(g)]   # drop older copies
            hooks[ev] = groups
            h = {"type": "command", "command": hook, "args": ["claude"], "async": True, "timeout": 5}
            groups.append({"matcher": "", "hooks": [h]} if ev in tool_events else {"hooks": [h]})
        status_line(s, "claude")
        save(p, s)
    done.append("Claude Code (Finn: " + ", ".join(a["name"] for a in accounts if os.path.isdir(a["dir"])) + ")")

if os.path.isdir(os.path.join(home, ".gemini")) or shutil.which("agy"):
    p = os.path.join(home, ".gemini", "config", "hooks.json")
    s = load(p)
    def h(ev): return {"type": "command", "command": f"\"{hook}\" antigravity {ev} 2>/dev/null || echo '{{}}'", "timeout": 5}
    s.pop("agent-companions", None)                  # entry from the app's old name
    s["agenttime"] = {"SessionStart": [h("SessionStart")], "PreInvocation": [h("PreInvocation")],
                             "PostToolUse": [{"matcher": "*", "hooks": [h("PostToolUse")]}], "Stop": [h("Stop")]}
    save(p, s)
    p = os.path.join(home, ".gemini", "antigravity-cli", "settings.json")
    s = load(p); status_line(s, "antigravity"); save(p, s)
    done.append("Antigravity (Jake)")

if os.path.isdir(os.path.join(home, ".codex")) or shutil.which("codex"):
    done.append("Codex (BMO), nothing to change")

print("Connected: " + (", ".join(done) if done else "no supported agents found"))
PY
