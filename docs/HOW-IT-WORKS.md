# How it works

A small see-through widget in the corner of your Mac where three Adventure Time friends show what your AI agents are doing:

| Tool | Companion | Live source |
|---|---|---|
| Claude Code | Finn | Claude Code hooks (`~/.claude/settings.json`), async, watch-only |
| Antigravity CLI (`agy`) | Jake | Antigravity hooks (`~/.gemini/config/hooks.json`): `SessionStart`, `PreInvocation`, `PostToolUse`, `Stop` |
| Codex (CLI and desktop app) | BMO | Read-only tail of `~/.codex/sessions/**.jsonl` (no Codex settings changed) |

When nothing is running, all three sleep in one huddle. When a tool starts work, only its companion wakes and walks to its spot: Finn reads a map, Jake makes a sandwich, BMO dances. Plan mode shows thinking, failed steps show a retry (3+ in a row: tired and bandaged), approvals show "Needs approval", and a finished turn gets one short celebration. Labels always say the real status.

The design follows `handoff/START-HERE-CLAUDE.txt`. The art in `web/sprites/` is an unofficial, fan-made Adventure Time pack.

## Use it

- Drag the widget anywhere. Clicks pass through it to your windows except while the pointer is over it.
- Hover a column for details (open tasks, last update).
- Right-click it, or use the menu-bar icon, for: Hide/Show, Pause Animations, Ice King on Tough Tasks, Clear Failure Labels, Move to Bottom-Right Corner, Quit.
- `~/.agent-companions/state.json` holds what each companion shows right now (updated every 2 s).

## Build

```sh
./build.sh            # runs the logic tests, builds build/Agent Companions.app
./build.sh --install  # also copies it to /Applications
```

Check the rendering without touching live data:

```sh
"build/Agent Companions.app/Contents/MacOS/Agent Companions" --snapshot out.png --js "['claude','antigravity','codex'].forEach(p=>Companions.setConnection(p,'healthy'))"
```

## How it works

```
companion-hook (Claude, Antigravity) ─┐
                                      ├─> ~/.agent-companions/events/*.ndjson ─┐
Codex session logs (read-only) ───────┘                                        ├─> app tails + slims lines
                                                                                └─> web/core.js: adapters -> task store -> resolver
                                                                                    web/scene.js: choreography -> canvas
```

- `scripts/connect.sh` / `scripts/disconnect.sh`: add or remove the hooks, keeping all other settings.
- `Sources/Hook/main.swift`: `companion-hook`. It stores only an allow-list (event name, session id, tool name, failure flag, process id). It never stores prompts, file contents or commands, never blocks, and always answers Antigravity with valid JSON (about 20 ms).
- `Sources/App/main.swift`: the floating panel, log tailing, process checks and menu. Codex lines are cut down to event types before they reach the web view.
- `web/core.js`: all task logic, with no DOM. It covers dedup by event id, revision ordering, stable terminal states, retry streaks per attempt, one-shot completions (never replayed after a relaunch), and completion badges when another task needs help.
- `tests/core.test.js`: 25 tests covering the brief's acceptance scenarios and all three adapters.

## Known limits

- **Approvals:** Antigravity has no approval or notification hook, so Jake can't show "Needs approval". The Codex logs on this Mac contain no approval events either; BMO shows them only if Codex writes them.
- **Counted failures:** Claude and Antigravity report failed tool calls (for example a `grep` with no match). Each one counts as a failed attempt; one success resets the streak.
- **Turns that end without a stop:** these close when that session's own process exits (recorded per session by the hook). For Codex, an unfinished turn idle for 30+ minutes is closed only at launch.
- **Ice King:** none of the three tools reports "difficulty", so the Ice King appears only when something marks a task as an encounter (and the menu option is on).

## Uninstall

1. Run `./scripts/disconnect.sh`. It removes only this app's hooks; backups from install time are kept next to each file as `*.bak-companions`.
2. Quit the app, then delete `/Applications/Agent Companions.app` and `~/.agent-companions/`.
