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

## Health bars, tombstones and approvals

Right under each character: one pixel bar per account, showing how much of its **plan usage limit** is left (the tighter of the 5-hour and weekly limits). `Sources/App/Limits.swift` refreshes them every 4 s. Only numbers are read.

| Agent | Where the numbers come from |
|---|---|
| Claude Code | Its status line runs `companion-hook statusline claude`, which saves `rate_limits.five_hour` / `seven_day` (`used_percentage`, `resets_at`) to `~/.agent-companions/limits/claude-<config dir>.json`. One file per config folder, so `~/.claude` and every `CLAUDE_CONFIG_DIR` an alias in `~/.zshrc` uses become separate accounts, named after the alias (`lesgo`, `personal`). |
| Antigravity | Its status line (`~/.gemini/antigravity-cli/settings.json`) runs `companion-hook statusline antigravity`, which saves `quota` (`gemini-5h`, `gemini-weekly`, `3p-5h`, `3p-weekly`: `remaining_fraction`, `reset_time`). The bar shows the group of the model in use; Jake is only out when both groups are. |
| Codex | The newest `rate_limits` in its session logs (`primary` / `secondary`: `used_percent`, `window_minutes`, `resets_at`, plus `rate_limit_reached_type`). |

- Several open sessions on one account each report the numbers from their own last request, so the hook keeps the lowest "left" seen for the same bucket and reset time: within a limit window the bar only goes down. Names and order can be set in `~/.agent-companions/accounts.json`.
- A limit whose reset time has passed counts as full again, so a tombstone lifts on time even if the agent hasn't run since.
- **Tombstone:** an agent is out when every account with numbers is at 0%. Its character plays the "out of tokens" sequence (`web/sprites/death.png`, cut from `Resources/death-sheet.png` with `swift Tools/cutdeath.swift`) and a tombstone stays over its bar with "Out of tokens · back in …". An account with no numbers yet (never used) shows a dash and doesn't count either way.
- **Status lines:** `connect.sh` keeps an existing status line working: the hook saves the numbers, then runs your old command and shows its output. `disconnect.sh` puts it back.
- **Codex approvals:** Codex logs a tool call that asks to leave the sandbox (`require_escalated`) when it asks you, and the call's output only once you've answered. A call still unanswered after 6 s (past Codex's automatic reviewer) shows "Needs approval": a bouncing **!** over BMO, a flashing label, and "Needs you" in the menu bar. When the output arrives, BMO goes back to work.

To preview: add `Companions.setLimits({codex:[{name:'',known:true,left:0,dead:true}]})` to the `--js` snapshot script.

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
- `Sources/App/main.swift`: the floating panel, log tailing, process checks and menu. Codex lines are cut down to event types before they reach the web view.
- `Sources/App/Limits.swift`: plan limits per account (health bars, tombstones).
- `scripts/accounts.py`: finds your Claude accounts (config folders used by shell aliases) for `connect.sh`.
- `web/core.js`: all task logic, with no DOM. It covers dedup by event id, revision ordering, stable terminal states, retry streaks per attempt, one-shot completions (never replayed after a relaunch), and completion badges when another task needs help.
- `tests/core.test.js`: 25 tests covering the brief's acceptance scenarios and all three adapters.

## Known limits

- **Approvals:** Antigravity has no approval or notification hook, so Jake can't show "Needs approval". Codex approvals are inferred from sandbox-escalation calls that haven't been answered after 6 s; other kinds of Codex approval (like file edits outside the project) aren't detected.
- **Counted failures:** Claude and Antigravity report failed tool calls (for example a `grep` with no match). Each one counts as a failed attempt; one success resets the streak.
- **Turns that end without a stop:** these close when that session's own process exits (recorded per session by the hook). For Codex, an unfinished turn idle for 30+ minutes is closed only at launch.
- **Ice King:** none of the three tools reports "difficulty", so the Ice King appears only when something marks a task as an encounter (and the menu option is on).

## Uninstall

1. Run `./scripts/disconnect.sh`. It removes only this app's hooks; backups from install time are kept next to each file as `*.bak-companions`.
2. Quit the app, then delete `/Applications/AgentTime.app` and `~/.agent-companions/`.
