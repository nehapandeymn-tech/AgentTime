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

- Only the top grab strip (22 pt) takes the mouse: drag or right-click it there. Anywhere else over the widget it fades to 15% and clicks pass through to the windows behind.
- Right-click it, or use the menu-bar icon, for: Hide/Show, Pause Animations, Ice King on Tough Tasks, Clear Failure Labels, Move to Bottom-Right Corner, Quit.
- `~/.agent-companions/state.json` holds what each companion shows right now (updated every 2 s).

## Health bars (tokens left)

Each column ends with a pixel health bar: the context window left in that agent's most recent session (last 24 h), refreshed every 4 s by `Sources/App/Tokens.swift`. Only numbers are read; nothing else from these files is kept.

| Agent | Where the numbers come from | Window size |
|---|---|---|
| Claude Code | Newest transcript in `~/.claude/projects/*/*.jsonl`: the last main-thread assistant message's `usage` (input + cache read + cache write + output) | Not logged: 200k, or 1M once the session has gone past 200k |
| Codex | Newest session log: the last `token_count` event's `last_token_usage.total_tokens` | `model_context_window` from the same event |
| Antigravity | Newest `~/.gemini/antigravity-cli/conversations/*.db` (opened read-only): the latest `gen_metadata` row, protobuf fields 1›9›10›1 (prompt tokens) and 1›9›10›4 (window) | From the same record |

Colours: green above 50% left, yellow above 20%, red below; the heart blinks at 10% or less. Antigravity's format is undocumented, so if it changes, Jake's bar shows a grey heart and a dash instead of a wrong number.

To preview the bars: add `Companions.setTokens({claude:{used:79000,window:200000}})` to the `--js` snapshot script.

## Build

```sh
./build.sh            # runs the logic tests, builds build/AgentTime.app
./build.sh --install  # also copies it to /Applications
```

Check the rendering without touching live data:

```sh
"build/AgentTime.app/Contents/MacOS/AgentTime" --snapshot out.png --js "['claude','antigravity','codex'].forEach(p=>Companions.setConnection(p,'healthy'))"
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
- `Sources/App/main.swift`: the floating panel, log tailing, process checks and menu.
- `Sources/App/Tokens.swift`: the read-only token meters behind the health bars. Codex lines are cut down to event types before they reach the web view.
- `web/core.js`: all task logic, with no DOM. It covers dedup by event id, revision ordering, stable terminal states, retry streaks per attempt, one-shot completions (never replayed after a relaunch), and completion badges when another task needs help.
- `tests/core.test.js`: 25 tests covering the brief's acceptance scenarios and all three adapters.

## Known limits

- **Approvals:** Antigravity has no approval or notification hook, so Jake can't show "Needs approval". The Codex logs on this Mac contain no approval events either; BMO shows them only if Codex writes them.
- **Counted failures:** Claude and Antigravity report failed tool calls (for example a `grep` with no match). Each one counts as a failed attempt; one success resets the streak.
- **Turns that end without a stop:** these close when that session's own process exits (recorded per session by the hook). For Codex, an unfinished turn idle for 30+ minutes is closed only at launch.
- **Ice King:** none of the three tools reports "difficulty", so the Ice King appears only when something marks a task as an encounter (and the menu option is on).

## Uninstall

1. Run `./scripts/disconnect.sh`. It removes only this app's hooks; backups from install time are kept next to each file as `*.bak-companions`.
2. Quit the app, then delete `/Applications/AgentTime.app` and `~/.agent-companions/`.
