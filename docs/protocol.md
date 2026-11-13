# Event protocol (v1)

Agents talk to the floor by posting JSON to `POST /events`. Send one object or an array of up to 200. The request must have `Content-Type: application/json` and `Authorization: Bearer <token>`, with the token from `~/.agent-floor/token`. Without the token the server answers `401`.

Only `type` and `agent` are required. Any event creates the agent and its team if they do not exist yet, so the smallest useful integration is a single `status` call.

```json
{ "type": "status", "agent": "bot-1", "team": "Payments", "status": "working", "activity": "Reconciling invoices" }
```

## Fields

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `join` `status` `tool` `message` `task` `leave` `reset` | What happened. |
| `agent` | string, or `{ id, name?, role?, source? }` | Stable id for this agent. Reuse it for every event. |
| `name` | string | Display name. Defaults to a tidied version of the id. |
| `role` | string | Shown under the name and decides shirt colour. `Lead` gets the head desk and a headset. |
| `team` | string, or `{ id?, name }` | The room. Agents with the same team share a square. Defaults to the parent's team, then `default`. |
| `parent` | agent id, or `null` | Who spawned this agent. Joining with a parent plays a briefing paper plane. `null` only means something on a roster desk (see below). |
| `source` | string | `claude-code`, `codex`, `cursor`, `cli` or anything you like. Shown on the agent card. |
| `status` | `idle` `thinking` `working` `waiting` `done` `error` `offline` | Drives the character's pose, badge, screen and floor ring. |
| `activity` | string, up to 280 chars | One line about what it is doing right now. Shown on the monitor and the name tag. |
| `tool` | string | Tool name for `tool` events. Shown in the monitor's title bar. |
| `to` | agent id or array | Recipients of a `message`. Unknown recipients are created in the sender's team. |
| `text` | string | Message text, shown in a speech bubble over the sender. |
| `task` | string | For `task` events: written on the team whiteboard. |
| `subagent` | `{ key?, type? }` | For adapters that only know "a subagent of type X". See below. |
| `stage` | string, up to 24 chars | A pipeline label shown on the name tag and card, e.g. `Stage 2`. Send `""` to clear it. |
| `stay` | boolean | On `join` with a `parent`: keep this helper at its desk after it finishes, until its parent leaves. See below. |
| `ts` | number (ms) | Optional timestamp. Defaults to now. |

The server also sends `pinned` on the roster desks it creates from the rooms file. It drops `pinned` from anything posted to `/events`, so a client can't pin an agent.

## Event types

- **join**: an agent arrives. It walks in from the door and sits down. With `parent`, the parent briefs it.
- **status**: change `status` and/or `activity`.
- **tool**: the agent is using a tool. Sets `status` to `working` unless you pass another.
- **message**: a paper plane flies from `agent` to each `to`. Without `to`, it goes to the parent.
- **task**: update the team whiteboard.
- **leave**: the agent stands up and walks out. It is removed a few seconds later.
- **reset**: clear the whole floor.

## Lifetime

The server forgets agents that have left after 6 seconds, helpers (agents with a `parent`) 45 seconds after they finish with `done` (unless they joined with `stay`, in which case they leave with their parent), and anything silent for 2 hours. Empty rooms disappear with their last agent. Roster desks are never forgotten, so their rooms stay.

## Subagent hints

Some tools tell you a tool call happened inside "a subagent of type `code-reviewer`" with an opaque id, but not which spawn it belongs to. Send the event as the parent with a hint:

```json
{ "type": "tool", "agent": "lead-1", "subagent": { "key": "ag_9", "type": "code-reviewer" }, "tool": "Read", "activity": "Reading cart.ts" }
```

The floor binds the hint to the oldest unbound helper of that `role` under `lead-1`, and remembers the key so later events land on the same desk. If there is no such helper, it opens a new desk.

## Helpers that stay

A helper that joined with `stay: true` is not removed when it finishes. When its parent leaves, it leaves too. If the same parent later sends a `join` for a new id with the same `role` while that helper is `done`, the floor reuses the helper's desk, keeps its name and takes the `stage` from the new join: the new id becomes an alias, and every later event for it lands on that desk. The aliases are in `state.aliases` (new id to desk id). A helper that is still busy is never reused, so parallel helpers of one role each get a desk. A helper that stays silent for 2 hours is still removed.

## Roster desks

With a rooms file (see the README), the server puts a standing desk on the floor for each `roster` entry, with the id `roster:<room slug>:<type>`, role `<type>` and `pinned: true`. Without a rooms file there are no roster desks and nothing in this section applies.

- A `join` with a `parent` on a roster desk is one spawn: the parent briefs it and it gets to work, like any helper.
- A `status` with `parent: null` ends one spawn. When the last running spawn ends, the desk goes back to idle with its "job · model" line, and its `status` and `activity` fields are ignored.
- Events can't change a roster desk's `name`, `role`, `team`, `source`, `account` or `machine`. Those come from the rooms file.
- The server sends a desk back to idle by itself 45 seconds after it ends in `done`, `error` or `offline`, or after 30 minutes without events (an interrupted subagent).
- A `reset` clears the floor and then puts the roster desks back.

## Reading state

- `GET /stream`: Server-Sent Events. First a `snapshot` with the full `state`, `recent` (the last 30 minutes of changes, at most 2,000, as `{ at, event, actor? }` or `{ at, removed }` for agents the server forgot), and `base` (the state at `baseAt`, just before the oldest entry in `recent`), then `event` frames (`{ event, effects }`) and `removed` frames (`{ agents: [...] }`). `actor` is the desk an event landed on when a subagent hint moved it off `event.agent`. Applying `recent` to `base` with the reducer reproduces `state`, which is how replay reaches back before the window opened.
- `GET /state`: the current world as JSON.
- `GET /health`: `{ ok, version, agents }`.
- `POST /reset`: clear the floor. Needs the token like `/events`.
- `POST /shutdown`: stop the floor (what `agent-floor stop` sends). Needs the token like `/events`.
- `POST /reload`: read the rooms file again. Needs the token like `/events`. Answers `{ ok, desks }`, or `400` with `{ error }` naming the bad field, in which case the floor keeps the rooms it has.

The reducer that turns events into state is `shared/protocol.js`. It has no dependencies, so you can import it to build other views on the same stream.
