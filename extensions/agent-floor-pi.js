// pi extension that reports pi's activity to Agent Floor.
// `agent-floor setup pi --write` adds this file to the "extensions" list in pi's settings.json.
// https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
//
// It runs inside the pi process, so it posts the events itself. Handlers never
// wait for the floor, and every failure is swallowed: a floor that is down, slow
// or rejecting must never slow down or break pi.
import localState from '../desktop/state.cjs';
import { PI_EVENTS, fromPi } from '../adapters/pi.mjs';

const PORT = Number(process.env.AGENT_FLOOR_PORT) || 4317;
const URL_BASE = (process.env.AGENT_FLOOR_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const TIMEOUT_MS = 800;
const MAX_BATCH = 200; // the most events the server takes in one POST

let queued = [];
let sending = null;

async function post(events) {
  try {
    await fetch(`${URL_BASE}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localState.readToken()}` },
      body: JSON.stringify(events),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Floor not running, slow, or the token is unreadable. Stay silent.
  }
}

// One request at a time, in order: events queued meanwhile go out in the next batch.
async function flush() {
  while (queued.length) await post(queued.splice(0, MAX_BATCH));
  sending = null;
}

function send(events) {
  if (events.length) {
    queued.push(...events);
    sending ??= flush();
  }
  return sending ?? Promise.resolve();
}

/** @param {{ on(event: string, handler: (event: any, ctx: any) => unknown): void }} pi */
export default function agentFloor(pi) {
  for (const name of PI_EVENTS) {
    pi.on(name, (event, ctx) => {
      try {
        const sent = send(fromPi(event, { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), idle: ctx.isIdle() }));
        // pi may exit right after session_shutdown, so give the leave event one timeout to go out.
        if (name === 'session_shutdown') return Promise.race([sent, new Promise((r) => setTimeout(r, TIMEOUT_MS).unref())]);
      } catch {
        // A pi build with a different ctx shape. Stay silent.
      }
    });
  }
}
