# Agent Companions 🗡️🐶🎮

**Your AI agents, but make it Adventure Time.**

Finn, Jake and BMO hang out in a little window in the corner of your Mac and act out what your AI coding agents are up to, so you can tell at a glance who's busy, who's stuck, and who just finished.

![Finn, Jake and BMO napping together](docs/1-huddle.png)

## Meet the crew

| Your agent | Their buddy | When it's working… |
|---|---|---|
| **Claude Code** | **Finn** | studies his adventure map |
| **Antigravity** | **Jake** | makes himself a sandwich |
| **Codex** | **BMO** | dances and plays games |

When nobody has anything to do, all three curl up together for a nap. As soon as one of your agents starts a task, only its buddy wakes up and gets to work. The others keep snoozing.

![Finn reading his map, Jake making a sandwich, BMO dancing](docs/2-working.png)

## They have feelings (sort of)

- 🤔 **Planning:** Finn scratches his hat and thinks hard.
- 😅 **Something failed:** arms get tangled and they try again.
- 🩹 **Failed a few times in a row:** they look worn out and grab a bandage.
- ✋ **Needs your OK:** they wait patiently and the label says *Needs approval*.
- 🎉 **Done:** a quick victory pose (Finn's sword salute is the best), then back to napping.

![Finn planning, Jake bandaged after a few failures, BMO waiting for approval](docs/3-trouble.png)

![Finn celebrating with his sword while BMO keeps dancing](docs/4-done.png)

Every buddy also has a little label underneath saying exactly what's going on, so the cute part never hides the real status.

## Install it with a prompt

Copy this into your AI agent (Claude Code, Codex, Antigravity, or whatever you use) and let it do the work:

```text
Install Agent Companions (https://github.com/nehapandeymn-tech/agent-companions) on this Mac:

1. It needs macOS 14 or newer and the Xcode Command Line Tools. If `swiftc` is missing,
   tell me to run `xcode-select --install` and stop.
2. Clone the repo to ~/agent-companions and run `./build.sh --install` there.
3. Run `./scripts/connect.sh` to connect the agents I have installed. It keeps my existing
   settings and backs them up first.
4. Run: open "/Applications/Agent Companions.app"
5. Tell me which agents got connected. Remind me that I can drag the widget anywhere and
   right-click it for options.
```

Prefer doing it yourself?

```sh
git clone https://github.com/nehapandeymn-tech/agent-companions ~/agent-companions
cd ~/agent-companions && ./build.sh --install && ./scripts/connect.sh
open "/Applications/Agent Companions.app"
```

## Little things to know

- **Move it:** drag it anywhere. Clicks go straight through to your windows unless your mouse is on it.
- **Peek:** hover over a buddy for details.
- **Options:** right-click it (or use the menu-bar icon) to pause the animations, hide it, or turn on the optional **Ice King** cameo for really tough tasks.
- **Private by design:** it only notices *that* something happened, like "a task started" or "a step failed". It never reads your prompts, your code or your conversations.

## Saying goodbye

```sh
cd ~/agent-companions && ./scripts/disconnect.sh
```

Then quit the app and drag **Agent Companions** from Applications to the Trash.

## Credits

This is an unofficial fan project, made for fun. Finn, Jake, BMO, the Ice King and Adventure Time belong to Cartoon Network, and this project isn't affiliated with or endorsed by them. The pixel art is fan-made for this project.

Curious how it works under the hood? See [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).
