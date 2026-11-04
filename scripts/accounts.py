"""Finds every Claude Code config folder on this Mac (one per account) and its name.
The default ~/.claude, plus any CLAUDE_CONFIG_DIR used by a shell alias, e.g.
    alias personal='CLAUDE_CONFIG_DIR=~/.personal claude'   -> ~/.personal is called "personal"
    alias lesgo='claude ...'                                 -> ~/.claude is called "lesgo"
Prints JSON: [{"dir": "/Users/me/.claude", "name": "lesgo"}, ...]"""
import json, os, re
home = os.path.expanduser("~")
default = os.path.join(home, ".claude")
found = {default: None}
for rc in [".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile"]:
    p = os.path.join(home, rc)
    if not os.path.exists(p): continue
    for line in open(p, errors="ignore"):
        m = re.match(r"\s*alias\s+([\w-]+)=(['\"])(.*)\2", line)
        if not m or not re.search(r"\bclaude\b", m.group(3)): continue
        name, cmd = m.group(1), m.group(3)
        d = re.search(r"CLAUDE_CONFIG_DIR=(\S+)", cmd)
        path = os.path.normpath(os.path.expanduser(d.group(1).strip("'\""))) if d else default
        if found.get(path) is None: found[path] = name
print(json.dumps([{"dir": d, "name": n or os.path.basename(d).lstrip(".") or "claude"} for d, n in found.items()]))
