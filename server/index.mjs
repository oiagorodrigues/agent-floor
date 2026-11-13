// Agent Floor server. Zero dependencies.
//
//   POST /events        one event or an array of events (see docs/protocol.md)
//   GET  /stream        Server-Sent Events: a `snapshot` (state and recent events), then `event` + `effects`
//   GET  /state         current world as JSON
//   POST /reset         clear the floor
//   POST /shutdown      close the server, then call onShutdown (agent-floor stop)
//   GET  /*             the built web app (dist/)
//
// POSTs need `Authorization: Bearer <token>` (the token lives in ~/.agent-floor/token).
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import localState from '../desktop/state.cjs';
import { applyEvent, createState, deskOf, normalizeEvent, sweep, PROTOCOL_VERSION } from '../shared/protocol.js';
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
} = {}) {
  const expected = Buffer.from(`Bearer ${token}`);
  const state = createState();
  const clients = new Set();
  const recent = createRecent();

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
  function ingest(raw) {
    const ev = normalizeEvent(redactDeep(raw));
    if (!ev) return false;
    if (randomNames && ev.type !== 'reset') nameAgent(ev);
    const { effects, actor } = applyEvent(state, ev);
    if (ev.type === 'reset') recent.clear();
    else recent.add(ev, actor);
    broadcast('event', { event: ev, effects });
    return true;
  }

  const sweeper = setInterval(() => {
    const removed = sweep(state);
    if (removed.length) broadcast('removed', { agents: removed });
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
        res.write(`retry: 1500\nevent: snapshot\ndata: ${JSON.stringify({ version: PROTOCOL_VERSION, state, recent: recent.entries() })}\n\n`);
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
