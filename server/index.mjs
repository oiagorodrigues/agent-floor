// Agent Floor server. Zero dependencies.
//
//   POST /events        one event or an array of events (see docs/protocol.md)
//   GET  /stream        Server-Sent Events: a `snapshot` (state and the last 30 minutes), then `event` + `effects`
//   GET  /state         current world as JSON
//   POST /reset         clear the floor
//   POST /shutdown      close the server, then call onShutdown (agent-floor stop)
//   POST /reload        read the rooms file again (see lib/rooms.mjs)
//   GET  /*             the built web app (dist/)
//
// POSTs need `Authorization: Bearer <token>` (the token lives in ~/.agent-floor/token).
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import localState from '../desktop/state.cjs';
import { loadRooms, roomsPath, seedEvents } from '../lib/rooms.mjs';
import { applyEvent, createState, deskOf, normalizeEvent, settlePinned, slug, sweep, PROTOCOL_VERSION } from '../shared/protocol.js';
import { pickName } from './names.mjs';
import { redactDeep } from './redact.mjs';
import { createRecent } from './recent.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 256 * 1024;
const HOOK_SOURCES = new Set(['claude-code', 'codex', 'cursor']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

export function startServer({
  port = Number(process.env.AGENT_FLOOR_PORT) || 4317,
  host = process.env.AGENT_FLOOR_HOST || '127.0.0.1',
  staticDir = resolve(here, '../dist'),
  log = console.log,
  token = localState.readToken(),
  randomNames = process.env.AGENT_FLOOR_RANDOM_NAMES !== '0',
  onShutdown,
  recent = createRecent(),
  // The Agent Floor home (~/.agent-floor). Without it there are no rooms and nothing is saved.
  floorDir = undefined,
  home = homedir(),
} = {}) {
  const expected = Buffer.from(`Bearer ${token}`);
  const state = createState();
  const clients = new Set();
  const roomsFile = floorDir ? roomsPath(floorDir) : null;
  const stateFile = floorDir ? join(floorDir, `state-${port}.json`) : null;
  let rooms = null;

  function broadcast(name, data) {
    const frame = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  }

  // Hook adapters send the same name ("Claude") for every session, so the floor
  // gives each of their agents its own first name and keeps it for its lifetime.
  function nameAgent(ev) {
    const existing = state.agents[deskOf(state, ev.agent)];
    if (existing) {
      if (ev.name && HOOK_SOURCES.has(existing.source)) ev.name = existing.name;
    } else if (HOOK_SOURCES.has(ev.source)) {
      ev.name = pickName(new Set(Object.values(state.agents).map((a) => a.name)));
    }
  }

  // Redacting before normalizeEvent means secrets are masked before text is clipped,
  // so a token cut at the length limit is still recognised.
  // Only the server's own events (`trusted`) may pin a roster desk or reset one outright.
  function ingest(raw, { trusted = false } = {}) {
    const ev = normalizeEvent(redactDeep(raw));
    if (!ev) return false;
    if (!trusted) delete ev.pinned;
    if (randomNames && !trusted && ev.type !== 'reset') nameAgent(ev);
    const { effects, actor } = applyEvent(state, ev);
    if (ev.type === 'reset') recent.reset(state);
    else recent.add(ev, actor);
    broadcast('event', { event: ev, effects });
    if (ev.type === 'reset') applyRooms(rooms);
    return true;
  }

  /** Puts the roster desks of `config` on the floor and walks out the ones it no longer lists. */
  function applyRooms(config) {
    rooms = config;
    const events = seedEvents(config);
    const desks = new Set(events.filter((e) => e.type === 'join').map((e) => e.agent));
    for (const a of Object.values(state.agents)) {
      if (a.pinned && !desks.has(a.id)) ingest({ type: 'leave', agent: a.id, pinned: false }, { trusted: true });
    }
    for (const ev of events) ingest(ev, { trusted: true });
    save();
    return desks.size;
  }

  /** Throws when the rooms file is invalid, and the floor keeps the rooms it has. */
  function reloadRooms() {
    return applyRooms(roomsFile ? loadRooms(roomsFile, home) : null);
  }

  // Only what the rooms file defines is saved, plus each room's colour and place on the
  // floor. No activity, history or task text: prompts and commands never reach the disk.
  function save() {
    if (!stateFile) return;
    const desks = Object.values(state.agents).filter((a) => a.pinned);
    const teams = {};
    for (const a of desks) {
      const { id, name, hue, order, createdAt } = state.teams[a.team];
      teams[id] = { id, name, hue, order, createdAt };
    }
    const saved = {
      teams,
      desks: desks.map(({ id, name, role, team, idleActivity, joinedAt }) => ({ id, name, role, team, idleActivity, joinedAt })),
    };
    const tmp = `${stateFile}.${process.pid}.tmp`;
    try {
      if (!desks.length) return rmSync(stateFile, { force: true });
      mkdirSync(floorDir, { recursive: true, mode: 0o700 });
      writeFileSync(tmp, JSON.stringify(saved), { flag: 'wx', mode: 0o600 });
      renameSync(tmp, stateFile);
    } catch (err) {
      log(`Agent Floor could not save ${stateFile}: ${err.message}`);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  // Roster desks from the last run come back idle, so a rooms file that is invalid
  // at start still shows its rooms. A valid file then replaces them.
  function restore() {
    let saved;
    try {
      saved = JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') log(`Agent Floor ignored ${stateFile}: ${err.message}`);
      return;
    }
    const text = (v) => typeof v === 'string' && v.length > 0 && v.length <= 280;
    const num = (v) => Number.isFinite(v);
    const now = Date.now();
    for (const t of Object.values(saved?.teams ?? {})) {
      if (!text(t?.id) || slug(t.id) !== t.id || !text(t.name) || !num(t.hue) || !num(t.order) || !num(t.createdAt)) continue;
      state.teams[t.id] = { id: t.id, name: t.name, hue: t.hue, order: t.order, task: undefined, createdAt: t.createdAt };
    }
    for (const d of Array.isArray(saved?.desks) ? saved.desks : []) {
      if (!text(d?.id) || !d.id.startsWith('roster:') || !text(d.role) || !state.teams[d.team] || !num(d.joinedAt)) continue;
      const idleActivity = text(d.idleActivity) ? d.idleActivity : 'Ready';
      state.agents[d.id] = {
        id: d.id,
        name: text(d.name) ? d.name : d.role,
        role: d.role,
        team: d.team,
        source: 'roster',
        status: 'idle',
        activity: idleActivity,
        idleActivity,
        joinedAt: d.joinedAt,
        lastSeen: now,
        history: [],
        pinned: true,
      };
    }
    const used = new Set(Object.values(state.agents).map((a) => a.team));
    for (const id of Object.keys(state.teams)) if (!used.has(id)) delete state.teams[id];
  }

  // No rooms file: nothing is read from or written to disk, as before rooms existed.
  if (roomsFile && existsSync(roomsFile)) restore();
  try {
    reloadRooms();
  } catch (err) {
    log(`Agent Floor: ${err.message}. Fix the file and POST /reload.`);
  }

  const sweeper = setInterval(() => {
    for (const ev of settlePinned(state)) ingest(ev, { trusted: true });
    const removed = sweep(state);
    if (!removed.length) return;
    recent.removed(removed);
    broadcast('removed', { agents: removed });
  }, 2000);
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 20000);

  async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw Object.assign(new Error('Body too large'), { status: 413 });
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : null;
  }

  function isAuthorized(req) {
    const given = Buffer.from(String(req.headers.authorization || ''));
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  async function serveStatic(req, res) {
    const url = new URL(req.url, 'http://x');
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(staticDir, path);
    if (!file.startsWith(staticDir)) return json(res, 403, { error: 'Forbidden' });
    try {
      const s = await stat(file);
      if (s.isDirectory()) file = join(file, 'index.html');
    } catch {
      file = join(staticDir, 'index.html');
    }
    try {
      const body = await readFile(file);
      const cache = file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': cache });
      res.end(body);
    } catch {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Agent Floor server is running, but the web app is not built.\nRun `npm run build`, or use `npm run dev` while developing.\n');
    }
  }

  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  let closing = null;

  function close() {
    closing ??= new Promise((r) => {
      clearInterval(sweeper);
      clearInterval(heartbeat);
      for (const res of clients) res.end();
      server.close(() => r());
    });
    return closing;
  }

  const server = createServer(async (req, res) => {
    // DNS-rebinding guard: when bound to loopback, only answer loopback hostnames.
    if (loopback && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '')) {
      return json(res, 403, { error: 'Forbidden host' });
    }
    const { pathname } = new URL(req.url, 'http://x');
    // No CORS headers are ever sent, so pages on other origins (including other
    // localhost ports) can neither read the stream nor pass a JSON preflight.
    if (req.method === 'POST' && !String(req.headers['content-type'] || '').includes('application/json')) {
      return json(res, 415, { error: 'Send Content-Type: application/json' });
    }
    if (req.method === 'POST' && !isAuthorized(req)) {
      return json(res, 401, { error: 'Send Authorization: Bearer <token from ~/.agent-floor/token>' });
    }

    try {
      if (pathname === '/events' && req.method === 'POST') {
        const body = await readBody(req);
        const list = Array.isArray(body) ? body : [body];
        let accepted = 0;
        for (const raw of list.slice(0, 200)) if (ingest(raw)) accepted++;
        return json(res, accepted ? 202 : 400, { accepted, rejected: list.length - accepted });
      }
      if (pathname === '/stream' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(`retry: 1500\nevent: snapshot\ndata: ${JSON.stringify({ version: PROTOCOL_VERSION, state, ...recent.history() })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (pathname === '/state' && req.method === 'GET') return json(res, 200, state);
      if (pathname === '/health') return json(res, 200, { ok: true, version: PROTOCOL_VERSION, agents: Object.keys(state.agents).length });
      if (pathname === '/reset' && req.method === 'POST') {
        ingest({ type: 'reset' });
        return json(res, 200, { ok: true });
      }
      if (pathname === '/shutdown' && req.method === 'POST') {
        // Without this the caller's keep-alive socket holds server.close() open for seconds.
        res.setHeader('Connection', 'close');
        json(res, 200, { ok: true });
        close().then(() => {
          log('Agent Floor stopped.');
          onShutdown?.();
        });
        return;
      }
      if (pathname === '/reload' && req.method === 'POST') {
        return json(res, 200, { ok: true, desks: reloadRooms() });
      }
      if (req.method === 'GET') return serveStatic(req, res);
      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      return json(res, err.status || 400, { error: err.message || 'Bad request' });
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      log(`Agent Floor is live at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
      resolvePromise({
        server,
        state,
        ingest,
        close,
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((err) => {
    console.error(err.code === 'EADDRINUSE' ? 'Port is already in use. Set AGENT_FLOOR_PORT to pick another.' : err);
    process.exit(1);
  });
}
