# Contributing

Thanks for helping. Agent Floor is small on purpose: a zero-dependency server, a shared reducer, a few pure adapters, and a three.js scene. Please keep it that way.

## Setup

```bash
npm install
npm run dev      # server on :4317, Vite on :5173 (proxies /events and /stream)
npm run demo     # in another terminal
npm test
```

Open http://localhost:5173. Add `?demo` to run the demo inside the browser without a server.

## Map of the code

| Path | What lives there |
| --- | --- |
| `shared/protocol.js` | Event validation and the reducer. Runs on the server and in the browser. Change it with care and add tests. |
| `shared/replay.js` | The recording replay plays back: folds old changes into a starting state and rebuilds any moment. |
| `shared/office-log.js` | Turns floor events into the office log's sentences. |
| `shared/demo-script.js` | The endless fake office used by `agent-floor demo` and the hosted demo. |
| `server/index.mjs` | HTTP + SSE. No dependencies. |
| `server/recent.mjs` | The bounded in-memory buffer of recent events sent with each snapshot. |
| `bin/agent-floor.mjs` | CLI: `start`, `setup`, `hook`, `emit`, `demo`, `stop`, `quiet`. |
| `adapters/` | Native hook payloads to floor events. Pure functions. |
| `src/world/layout.ts` | The floor plan: lobby, corridor, office wings, amenities, desks and walking routes. Seats and wings are stable once assigned. |
| `src/world/Building.ts` | The shell and shared spaces: walls, windows, doors, lobby, kitchen, meeting room, lounge, garden. |
| `src/world/props.ts` | The furniture catalogue. Each prop is a function that describes itself into a `Kit`. |
| `src/world/kit.ts` | Static batching: merges a room's furniture into one mesh per material. Add props here, not as separate meshes. |
| `src/world/textures.ts` | Procedural canvas textures (wood, carpet, terrazzo, grass, posters). No image files. |
| `src/world/Character.ts` | The clay figures and every pose: typing, thinking, waving, walking. |
| `src/world/Workstation.ts`, `Screen.ts` | Desks and the live monitor canvas. |
| `src/world/TeamRoom.ts` | One team's office: carpet, rug, furniture, whiteboard, door signs. |
| `src/world/Courier.ts` | Paper planes and landing ripples. |
| `src/world/World.ts` | Renderer, lights, camera rig, picking, and syncing the scene with state. |
| `src/ui/` | Name tags, bubbles, the agent card, the connect sheet, the replay timeline and the office log. |

## Design rules

- The world is the interface. Prefer showing something in the scene over adding a panel.
- One accent colour (`#ff5f2e`). Status colours are semantic only: blue working, sky thinking, amber waiting, red error, green done, grey idle.
- Motion is interruptible. Springs and damped approaches continue from the current value; never lock input during an animation.
- Respect `prefers-reduced-motion`: no walking, no flights, instant camera moves.
- Hooks must never slow down or break the host tool.

## Pull requests

- Run `npm test` and `npm run build` before pushing.
- New adapters need tests with a real payload sample.
- Visual changes: include a screenshot or short clip in light and dark.
