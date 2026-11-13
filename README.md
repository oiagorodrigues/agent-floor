# Agent Floor

A live 3D office for your coding agents.

Every agent gets a character and a desk inside one office building. Each project or team gets its own glass-walled office block off the main corridor, next to a lobby, kitchen, meeting room and lounge. You can watch agents walk in the front door, find their desk, type, think, raise a hand when they need you, and throw paper planes at each other when they talk. Click anyone to see exactly what they are doing.

Works with **Claude Code**, **Codex**, **Cursor**, **Hermes Agent**, **opencode**, **pi**, and anything else that can send an HTTP request.

**[Try the live demo](https://develop212.github.io/agent-floor/)** (runs in your browser, no install).

![Agent Floor: a glass-walled team office with agents at their desks](docs/hero.jpg)

![The whole building on the night shift](docs/night.jpg)

## Quick start

Agent Floor is not published on npm, and an `agent-floor` package there is not this project. Install it from source:

```bash
git clone https://github.com/oiagorodrigues/agent-floor
cd agent-floor && npm ci && npm run build && npm link
agent-floor setup claude --write
```

That's it. The next time a Claude Code session starts, Agent Floor opens by itself in its own desktop window (no browser). Close the window and it keeps listening from the menu bar; use **Quit (pause auto-open for 6 hours)** in the menu bar icon, or `agent-floor stop`, when you want quiet. Run `agent-floor` any time to open it yourself.

Start a Claude Code session in any project. A character walks into a room named after the project folder, sits down, and starts working. When it spawns a subagent, a new teammate walks in, gets briefed with a paper plane, works at its own desk, and reports back.

No agents yet? Click **Watch demo**, or run `agent-floor demo` in a second terminal.

## What you see

| On the floor | Means |
| --- | --- |
| An office block | One project, or whatever `team` you send. Name above the door and on the corridor floor, current task on the rolling whiteboard. |
| Character at a desk | One agent. The lead sits at the head of the desk pod. |
| Typing, code scrolling on the monitor | `working`: running a tool. The screen shows the tool and what it is doing. |
| Hand on chin, thought bubble | `thinking` |
| Waving, amber badge | `waiting`: it needs you |
| Head shake, red badge | `error` |
| Little hop, green check | `done` |
| Leaning back, screensaver | `idle` |
| Paper plane on an arc | A message from one agent to another, colour of the sender's team |
| Walking in the front door, down the corridor | An agent joining (or, in reverse, leaving) |

Coloured magnets on each whiteboard show every team member's status at a glance.

**Replay.** Press `R` (or the clock button) to rewind. The floor replays its last 30 minutes at 4× speed, paper planes included, even if you opened the window a moment ago. Drag the timeline to jump to any moment: orange ticks are messages, amber ticks are agents waiting on you or hitting an error, and green ticks are arrivals. `Space` pauses, `←` and `→` step 10 seconds, and **Live** brings you back to now. Replay runs in your browser with the same reducer the server uses, so it shows exactly what happened.

**Office log.** Press `L` (or the list button) for a running log in plain sentences: who did what, who handed what to whom, and when someone needs you. It covers the same 30 minutes, follows the selected agent's room and follows replay. **Copy** puts the log on your clipboard as text.

**Controls:** drag to pan, right-drag to orbit, scroll to zoom, click an agent or a room. `F` frames everyone, `[` and `]` step through agents, `R` opens replay, `L` opens the office log, `T` switches day and night, `Esc` closes things. On touch: one finger pans, two fingers zoom and rotate.

## Connect your tools

### Claude Code

```bash
agent-floor setup claude --write     # merges hooks into settings.json of every configured Claude config dir
agent-floor setup claude --project   # prints a snippet for .claude/settings.json in this repo
```

`--write` only adds or replaces Agent Floor's own hooks. Every other hook and setting stays as it is, a timestamped backup is kept next to the file, and running it again changes nothing.

If you use more than one Claude config dir (`CLAUDE_CONFIG_DIR`), list them in `~/.agent-floor/config.json`. `setup` installs the hooks in each one, and every session shows which account it runs under, for example "Claude (work)":

```json
{
  "claude": {
    "defaultConfigDir": "~/.claude",
    "byPath": [{ "path": "~/Workspaces/work", "configDir": "~/.claude-work" }]
  }
}
```

The hooks installed by `setup` know their config dir. Hooks from `--project` use `CLAUDE_CONFIG_DIR` and then the `byPath` folder rules.

#### Headless runs (`claude -p`)

Scripted runs often skip user settings (`--setting-sources project`) to keep their context small, which also skips the hooks above. Put the hooks in a settings file of their own and pass it with `--settings`:

```bash
agent-floor setup claude --settings run-settings.json --write
AGENT_FLOOR_AUTOLAUNCH=0 AGENT_FLOOR_TEAM=ABC-123 AGENT_FLOOR_NAME=plan \
  claude -p "..." --setting-sources project --settings run-settings.json
```

The file can already hold other settings; only Agent Floor's hooks are added or replaced. Add `--config-dir <dir>` to tag the account, otherwise the hook uses `CLAUDE_CONFIG_DIR` and the `byPath` rules. `--bare` skips every hook, including ones passed with `--settings`.

Uses `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SubagentStop`, `PreCompact` and `SessionEnd`. Subagents spawned with the Task tool get their own desks and their tool calls show up on their own screens.

#### Pipelines and crews

When a subagent's description names a stage ("Stage 2 - write the script"), its name tag and card show a `Stage 2` label. The prompt is read for a stage only when `AGENT_FLOOR_SHARE_PROMPTS=1`.

For a staged pipeline, where a lead hands work to a researcher, a writer and a checker, start Claude Code with crew mode on:

```bash
AGENT_FLOOR_CREW=1 claude
```

In crew mode, subagents stay at their desks after they finish, so the whole crew is on screen until the session ends. When the lead sends the same kind of subagent again, it is briefed at the desk it already has instead of a new one.

### Codex

```bash
agent-floor setup codex
```

Prints the `notify` line for `~/.codex/config.toml`. Codex reports once per finished turn. If your Codex build supports Claude-style hooks, point them at `agent-floor hook codex` and you get live tool activity too.

### Cursor

```bash
agent-floor setup cursor --write     # ~/.cursor/hooks.json
agent-floor setup cursor --project   # .cursor/hooks.json in this repo
```

Only observing hooks are installed. Agent Floor never answers a permission prompt for you.

### Hermes Agent

```bash
agent-floor setup hermes             # prints a hooks: block for ~/.hermes/config.yaml
agent-floor setup hermes --write     # appends it, if the file has no hooks: section yet
```

Uses [Hermes Agent](https://github.com/NousResearch/hermes-agent) shell hooks: `on_session_start`, `pre_llm_call`, `pre_tool_call`, `post_tool_call`, `on_session_end` and `on_session_finalize`. `--write` keeps a timestamped backup, and if your config already has a `hooks:` section it changes nothing and prints the entries for you to merge by hand. Hermes asks you to approve each new hook the next time `hermes chat` starts; `hermes hooks list` shows which ones are approved. Set `HERMES_HOME` to set up another profile.

### opencode

```bash
agent-floor setup opencode --write     # ~/.config/opencode/plugins/agent-floor.js
agent-floor setup opencode --project   # .opencode/plugins/agent-floor.js in this repo
```

Installs a small plugin file that loads `adapters/opencode-plugin.mjs` from this folder, so it works with OpenCode 1 (1.18.29 and newer) and 2 and updates with Agent Floor. Each opencode session gets its own desk with live tool activity, and the lead goes idle when the session does. Install it in one place only: OpenCode 1 would load both copies and post every event twice. Restart opencode after setup.

### pi

```bash
agent-floor setup pi --write         # adds the extension to ~/.pi/agent/settings.json
agent-floor setup pi --project       # .pi/settings.json in this repo
```

pi loads `extensions/agent-floor-pi.js` from this install into its own process. The extension posts tool activity, waiting and idle states to the floor in the background, so a floor that is down never slows pi. Each pi session gets its own desk in a room named after the project folder.

### Anything else

Post JSON to `http://localhost:4317/events` with the token from `~/.agent-floor/token`:

```bash
curl -X POST localhost:4317/events \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $(cat ~/.agent-floor/token)" \
  -d '{"type":"tool","agent":"bot-1","team":"Payments","tool":"Bash","activity":"Running tests"}'
```

Or from a shell script:

```bash
agent-floor emit --agent bot-1 --team Payments --status working --activity "Running tests"
agent-floor emit --agent bot-1 --to bot-2 --text "Tests are green"
```

The full event format is in [docs/protocol.md](docs/protocol.md). More integration notes, including LangGraph and CrewAI style frameworks, are in [docs/integrations.md](docs/integrations.md).

## Configuration

| Variable | Default | Used by |
| --- | --- | --- |
| `AGENT_FLOOR_PORT` | `4317` | server, hooks |
| `AGENT_FLOOR_HOST` | `127.0.0.1` | server |
| `AGENT_FLOOR_URL` | `http://127.0.0.1:4317` | hooks, `emit`, `demo` |
| `AGENT_FLOOR_TEAM` | project folder name | hooks: put this session in a named room |
| `AGENT_FLOOR_NAME` | `Claude`, `Codex`, `Cursor`, `Hermes`, `OpenCode`, `Pi` | hooks: the lead's display name |
| `AGENT_FLOOR_MACHINE` | unset | hooks: this computer's name, shown as a badge on its agents' name tags and as "on work-laptop" on the agent card |
| `AGENT_FLOOR_AUTOLAUNCH` | `1` | set to `0` so hooks never open the app |
| `AGENT_FLOOR_CREW` | `0` | hooks: set to `1` to keep finished subagents at their desks until the session ends, and reuse a desk when the same kind of subagent is spawned again |
| `AGENT_FLOOR_SHARE_PROMPTS` | `0` | set to `1` to show your prompts, replies and agent thoughts on the floor |
| `AGENT_FLOOR_RANDOM_NAMES` | `1` | server: Claude Code, Codex and Cursor agents get a random first name, unique on the floor; `0` keeps the adapter's name |
| `AGENT_FLOOR_APP` | `desktop` | `browser` opens the floor in a normal browser tab instead of the Electron window. Same as `"app": "browser"` in `~/.agent-floor/config.json` |

Group several repos into one room by giving them the same `AGENT_FLOOR_TEAM`.

The floor itself (the 3D scene) costs the same CPU and GPU in Electron or in a browser tab while it is on screen. A browser tab stops rendering when you close it or switch away, and the server keeps running in the background. Stop it with `agent-floor stop`.

## Privacy and safety

- The server binds to `127.0.0.1` and only answers loopback host names.
- The server sends no CORS headers, so pages on other origins, other localhost ports included, cannot read the stream or post to it.
- Every `POST` needs `Authorization: Bearer <token>`. The token is created in `~/.agent-floor/token` with owner-only permissions, so other users on the machine cannot post events.
- Prompts, replies and agent thoughts stay off the floor unless you set `AGENT_FLOOR_SHARE_PROMPTS=1`. Tool activity ("Running npm test", "Editing cart.ts") is still shown.
- The server masks secrets in every event, whether it comes from a hook, `agent-floor emit` or your own POST, before it reaches the floor. It catches tokens with a known prefix (`ghp_`, `gho_`, `github_pat_`, `sk-`, `sk-ant-`, `xoxb-`, `xoxp-`, `AKIA`, JWTs), `Authorization` headers, `curl -u user:pass`, passwords in URLs, and values labelled `password`, `passwd`, `token`, `secret`, `api_key`, `apikey` or `access_key`. The secret becomes `[redacted]` and its label stays, so `GITHUB_TOKEN=ghp_…` shows as `GITHUB_TOKEN=[redacted]`. Masking matches patterns, so a secret in an unknown format, or an unquoted `password: word` without a digit, can still show.
- Hooks time out after 1.2 seconds, swallow every error and always exit 0. The pi extension never makes pi wait for the floor, gives each request 0.8 seconds and swallows every error. If the floor is down, your agents never notice.
- Nothing is stored on disk and nothing is sent anywhere else. Activity text is clipped to 280 characters.
- For replay and the office log, the server keeps the last 30 minutes of events (at most 2,000) and the floor as it was at the start of that window, in memory only, and sends them only with the `/stream` snapshot. They come from the same events the stream already carries, so prompts are in them only when you set `AGENT_FLOOR_SHARE_PROMPTS=1`.

## The desktop app

`agent-floor` (or the first hook event when nothing is running) starts the floor and opens it as an Electron window. If Electron is not available, it falls back to a Chrome or Edge app window, and then to your default browser. Only one copy ever runs: parallel subagents share a launch lock. `agent-floor start` runs just the server, with no window, if you prefer a browser tab at http://localhost:4317.

- `agent-floor stop` stops the running floor, whether it runs in the background from `agent-floor start` or browser mode, or inside the desktop app. When the desktop app started the floor, the app quits too. Hooks then wait 6 hours before they open the floor again, so the next agent event doesn't bring it straight back. Run `agent-floor` to open it yourself.
- `agent-floor quiet [hours]` stops hooks from opening the floor for that many hours (6 by default). A floor that is already running stays up and keeps showing your agents.

## Performance

Static furniture is batched into a few meshes per room with colours baked into vertices, characters are one mesh per moving part, shadows refresh a few times a second, monitors only redraw near the camera, and the render resolution adapts to your frame rate. A building with 50+ agents holds 60 fps on an M-series MacBook. Add `?stats` to the URL (or `agent-floor demo --agents 60` for a stress test) to see draw calls, frame time and rebuild cost.

## How it works

```
Claude Code / Codex / Cursor / pi ───┐
agent-floor emit, curl, your code ───┼──► POST /events ──► reducer ──► GET /stream (SSE) ──► browser
                                     │                       │                                │
                                     └─ adapters/*.mjs       └─ shared/protocol.js ◄──────────┘
                                        map native payloads     same reducer runs on both sides
```

- `server/` is a zero-dependency Node HTTP server.
- `shared/protocol.js` is the event reducer, used verbatim by the server and the browser, so a snapshot plus the stream always matches.
- `adapters/` turn each tool's hook payload into floor events. They are pure functions with tests.
- `src/world/` is the three.js scene: rooms, desks, characters, paper planes and the camera rig.
- `src/ui/` is the HUD: name tags, speech bubbles, the agent card and the connect sheet.
- `desktop/` is the Electron shell: native window, tray icon, single instance, auto-launch state.

## Develop

```bash
git clone https://github.com/oiagorodrigues/agent-floor
cd agent-floor
npm ci
npm run dev        # floor server on :4317 + Vite on :5173
npm run demo       # in another terminal, stream fake agents
npm test           # protocol, adapters, server
npm run build      # typecheck + production build into dist/
```

`npm run build:pages` builds a demo-only version into `dist-pages/` for GitHub Pages. The included workflow publishes it on every push to `main`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how the scene is put together and what makes a good adapter.

## License

MIT
