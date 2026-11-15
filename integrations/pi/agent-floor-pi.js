// pi extension that reports pi's activity to Agent Floor.
// `agent-floor setup pi --write` adds this file to the "extensions" list in pi's settings.json.
// https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
//
// It runs inside the pi process, so it posts the events itself. Handlers never
// wait for the floor, and every failure is swallowed: a floor that is down, slow
// or rejecting must never slow down or break pi.
import localState from '../../desktop/state.cjs';
import { PI_EVENTS, fromPi } from './adapter.mjs';

const PORT = Number(process.env.AGENT_FLOOR_PORT) || 4317;
const URL_BASE = (process.env.AGENT_FLOOR_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const TIMEOUT_MS = 800;
const MAX_BATCH = 200; // the most events the server takes in one POST

let queued = [];
let sending = null;
let cancel = new AbortController();

async function post(events) {
  try {
    await fetch(`${URL_BASE}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localState.readToken()}` },
      body: JSON.stringify(events),
      signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), cancel.signal]),
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

// pi may exit right after session_shutdown, so the queue gets one timeout to
// drain. Whatever is still queued or in flight after that is dropped, so an open
// request never keeps pi from exiting.
async function sendLast(events) {
  await Promise.race([send(events), new Promise((r) => setTimeout(r, TIMEOUT_MS).unref())]);
  queued.length = 0;
  cancel.abort();
  cancel = new AbortController();
}

/** @param {{ on(event: string, handler: (event: any, ctx: any) => unknown): void }} pi */
export default function agentFloor(pi) {
  for (const name of PI_EVENTS) {
    pi.on(name, (event, ctx) => {
      try {
        const events = fromPi(event, { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), idle: ctx.isIdle() });
        if (name === 'session_shutdown') return sendLast(events);
        send(events);
      } catch {
        // A pi build with a different ctx shape. Stay silent.
      }
    });
  }
}
