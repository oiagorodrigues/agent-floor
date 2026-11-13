# Integrations

Every integration does the same thing: turn "something happened in my agent" into a small JSON event and post it to `http://localhost:4317/events` with `Authorization: Bearer <token>`, where the token is the content of `~/.agent-floor/token`. The built-in adapters live in `adapters/` and are covered by tests in `test/`.

## Claude Code

`agent-floor setup claude --write` merges this into the `settings.json` of each Claude config dir (a timestamped `.bak` copy of the old file is kept, and all your other hooks and settings stay):

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "agent-floor hook claude", "timeout": 5 }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "agent-floor hook claude", "timeout": 5 }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "agent-floor hook claude", "timeout": 5 }] }]
  }
}
```

The real snippet also covers `UserPromptSubmit`, `Notification`, `Stop`, `SubagentStop`, `PreCompact` and `SessionEnd`. Its command is `node '/absolute/path/bin/agent-floor.mjs' hook claude --config-dir '<dir>'`, so it never depends on `PATH` or on a package registry.

| Hook | On the floor |
| --- | --- |
| `SessionStart` | The lead walks in. |
| `UserPromptSubmit` | Thinking. Your prompt is shown only with `AGENT_FLOOR_SHARE_PROMPTS=1`. |
| `PreToolUse` | Working. The monitor shows the tool and a readable summary ("Running npm test", "Editing cart.ts"). |
| `PreToolUse` on `Task` / `Agent` | A helper walks in and gets a briefing plane with the task description. |
| `PreToolUse` on `TodoWrite` | The current todo goes on the team whiteboard. |
| `PostToolUse` on `Task` / `Agent` | The helper sends a "Report ready" plane back and finishes. |
| `Notification` | Waiting: the lead waves for you. |
| `Stop` | Idle. |
| `SessionEnd` | The lead walks out. |

Run `agent-floor setup claude --project` to print a snippet for one repository's `.claude/settings.json` instead, or `agent-floor setup claude --settings <file>` for a file you pass to `claude -p --settings` in scripted runs.

## Codex

```toml
# ~/.codex/config.toml
notify = ["node", "/absolute/path/to/agent-floor/bin/agent-floor.mjs", "hook", "codex"]
```

`agent-floor setup codex` prints the exact line for your install. Codex calls `notify` when a turn completes, so the desk updates once per reply. Codex accepts a single `notify` program. If you already use one, call both from a small wrapper script.

If your Codex build supports Claude-style hooks with `hook_event_name` payloads on stdin, use `agent-floor hook codex` there and you get per-tool updates as well.

## Cursor

`agent-floor setup cursor --write` merges observing hooks into `~/.cursor/hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [{ "command": "agent-floor hook cursor" }],
    "afterFileEdit": [{ "command": "agent-floor hook cursor" }],
    "afterShellExecution": [{ "command": "agent-floor hook cursor" }],
    "afterMCPExecution": [{ "command": "agent-floor hook cursor" }],
    "afterAgentResponse": [{ "command": "agent-floor hook cursor" }],
    "afterAgentThought": [{ "command": "agent-floor hook cursor" }],
    "subagentStop": [{ "command": "agent-floor hook cursor" }],
    "stop": [{ "command": "agent-floor hook cursor" }],
    "sessionEnd": [{ "command": "agent-floor hook cursor" }]
  }
}
```

Hooks that gate permissions (`beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `beforeTabFileRead`, `preToolUse`, `subagentStart`) are deliberately left out. Cursor's [hooks docs](https://cursor.com/docs/hooks) say a permission hook must answer `allow` or `deny`, and that invalid JSON or a response that doesn't match the schema blocks the action. Agent Floor has no neutral answer to give there, so it never subscribes to one.

That is why a Cursor helper appears on the floor when it finishes rather than when it starts. When `subagentStop` arrives, the helper joins at its lead's desk, reports back and is marked done (also when it was aborted), or red if it stopped with an error. Its task, description and summary are shown only with `AGENT_FLOOR_SHARE_PROMPTS=1`. `sessionEnd` makes the lead leave the floor.

Hook names have changed between Cursor releases, so if one is not recognised by your version, Cursor ignores it.

## Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) by Nous Research runs the commands in the `hooks:` block of its `config.yaml` as [shell hooks](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks#shell-hooks). `agent-floor setup hermes` prints this block, and `--write` appends it to `~/.hermes/config.yaml` (or `$HERMES_HOME/config.yaml`):

```yaml
hooks:
  on_session_start:
    - command: "node '/absolute/path/bin/agent-floor.mjs' hook hermes"
      timeout: 5
  pre_tool_call:
    - command: "node '/absolute/path/bin/agent-floor.mjs' hook hermes"
      timeout: 5
```

The real block also covers `pre_llm_call`, `post_tool_call`, `on_session_end` and `on_session_finalize`. There is no YAML parser here, so `--write` only appends: if the file already has a top-level `hooks:` key it changes nothing, exits 1 and prints the entries for you to merge by hand. When it writes, it keeps a timestamped, owner-only `.bak` copy of the old file.

Hermes asks you to approve each `(event, command)` pair the first time a foreground `hermes chat` sees it, and remembers the answer in `shell-hooks-allowlist.json`. The gateway and cron never ask, so approve the hooks once in the CLI, or use `--accept-hooks` / `HERMES_ACCEPT_HOOKS=1`. `hermes hooks list` shows the consent state and `hermes hooks doctor` checks timing.

| Hook | On the floor |
| --- | --- |
| `on_session_start` | The lead walks in. |
| `pre_llm_call` | Thinking. Your prompt (`extra.user_message`) is shown only with `AGENT_FLOOR_SHARE_PROMPTS=1`. |
| `pre_tool_call` | Working. The monitor shows the Hermes tool name (`terminal`, `read_file`, ...). |
| `post_tool_call` | Thinking, with a "Done" line. |
| `on_session_end` | Idle. Hermes fires it at the end of every turn. |
| `on_session_finalize` | The lead walks out (`/new`, or quitting the CLI). |

The hook prints nothing and always exits 0, so it never blocks a tool call, rewrites arguments or injects context. Subagents started with `delegate_task` run under their own session id, so their tool calls appear on a separate Hermes desk in the same room.

## Your own agents

### Python

```python
import json, pathlib, urllib.request

TOKEN = (pathlib.Path.home() / ".agent-floor" / "token").read_text().strip()

def floor(**event):
    req = urllib.request.Request(
        "http://localhost:4317/events",
        data=json.dumps(event).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"},
    )
    try:
        urllib.request.urlopen(req, timeout=1)
    except OSError:
        pass  # the floor is optional

floor(type="join", agent="researcher", team="Market scan", role="Research")
floor(type="tool", agent="researcher", tool="search", activity="Searching for competitor pricing")
floor(type="message", agent="researcher", to="writer", text="Found 12 sources")
floor(type="status", agent="researcher", status="done", activity="Handed off")
```

This drops straight into LangGraph nodes, CrewAI task callbacks, AutoGen message hooks, or any loop you wrote yourself. Use one `team` per graph or crew, and `parent` for agents that spawn others.

### TypeScript

```ts
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const token = readFileSync(`${homedir()}/.agent-floor/token`, 'utf8').trim();
const floor = (event: Record<string, unknown>) =>
  fetch('http://localhost:4317/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(event),
  }).catch(() => {});

await floor({ type: 'tool', agent: 'planner', team: 'Release', tool: 'git', activity: 'Tagging v2.3.0' });
```

### Shell

```bash
agent-floor emit --agent deploy-bot --team Release --status working --activity "Rolling out to eu-west"
agent-floor emit --agent deploy-bot --to planner --text "Rollout done"
agent-floor emit --agent deploy-bot --type leave
```

## Writing a new adapter

1. Add `adapters/<tool>.mjs` exporting a pure function from the tool's payload to an array of events.
2. Wire it into the `hook` command in `bin/agent-floor.mjs`, and to `setup` if the tool has a config file.
3. Add cases to `test/protocol.test.mjs`.
4. A hook must never block, prompt, or fail the host tool. Keep the 1.2 second timeout and always exit 0.
