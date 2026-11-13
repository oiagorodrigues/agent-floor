#!/usr/bin/env node
// agent-floor CLI
//
//   agent-floor [start] [--port 4317] [--open]   run the floor
//   agent-floor hook <agent>                     used by agent hooks (reads stdin / argv)
//   agent-floor emit --agent id --status working --activity "..."  [--team x] [--to id --text "..."]
//   agent-floor setup <agent> [--write] [--project]   agents: integrations/index.mjs
//   agent-floor setup claude --settings <file> [--config-dir <dir>] [--write]
//   agent-floor demo                             push a scripted demo into a running floor
//   agent-floor stop                             stop the running floor and pause auto-open for 6 hours
//   agent-floor quiet [hours]                    pause auto-open from hooks (default 6 hours)
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ConfigError, agentSection, loadConfig } from '../lib/config.mjs';
import { loadRooms, roomsPath } from '../lib/rooms.mjs';
import { AGENTS, HOOK_AGENTS, INTEGRATIONS, setupForms } from '../integrations/index.mjs';
import { SetupError, UsageError } from '../integrations/cli.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SELF = resolve(here, 'agent-floor.mjs');
const PORT = Number(process.env.AGENT_FLOOR_PORT) || 4317;
const URL_BASE = (process.env.AGENT_FLOOR_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const IS_LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(URL_BASE);
const require = createRequire(import.meta.url);
const localState = require('../desktop/state.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [, , cmd = 'app', ...rest] = process.argv;
// setup and startup read it first, so a config.json in an old shape stops them with the fix.
const readConfig = () => loadConfig(AGENTS);

function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

async function post(events) {
  if (!events.length) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1200);
  try {
    await fetch(`${URL_BASE}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localState.readToken()}` },
      body: JSON.stringify(events),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

// ---------------------------------------------------------------- auto-launch

async function healthy() {
  try {
    const res = await fetch(`${URL_BASE}/health`, { signal: AbortSignal.timeout(400) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Send events; if the floor is not running, open the desktop app and resend.
 * Guarded so it never spams windows: one launcher at a time (lock file), a
 * snooze after "Quit", `stop` or `quiet`, and AGENT_FLOOR_AUTOLAUNCH=0 to turn it off.
 */
async function postOrLaunch(events) {
  if (!events.length) return;
  try {
    await post(events);
    return;
  } catch {
    /* not running (or slow); fall through */
  }
  if (!IS_LOCAL || process.env.AGENT_FLOOR_AUTOLAUNCH === '0') return;
  if (localState.isSnoozed()) return;
  if (localState.takeLaunchLock()) await openApp({ fromHook: true });
  // Wait for the floor (ours or one another hook is starting), then resend.
  for (let i = 0; i < 35; i++) {
    await sleep(100);
    if (await healthy()) {
      await post(events).catch(() => {});
      return;
    }
  }
}

function findChromium() {
  if (process.platform === 'darwin') {
    for (const app of ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium', 'Arc'])
      if (existsSync(`/Applications/${app}.app`)) return { mac: app };
    return null;
  }
  const names = process.platform === 'win32' ? ['chrome', 'msedge'] : ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];
  for (const n of names) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [n], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return { bin: r.stdout.trim().split(/\r?\n/)[0] };
  }
  return null;
}

const APP_MODES = ['desktop', 'browser'];

/** "desktop" (default) or "browser", from AGENT_FLOOR_APP or "app" in ~/.agent-floor/config.json. */
function appMode() {
  // Reads only the global key, so a hook can still open the floor while an agent section waits to be moved.
  const mode = process.env.AGENT_FLOOR_APP || localState.readConfig().app || 'desktop';
  if (!APP_MODES.includes(mode)) throw new Error(`Unknown app mode "${mode}". Use ${APP_MODES.join(' or ')}.`);
  return mode;
}

/**
 * Open the floor in its own window. Prefers the Electron desktop app; falls
 * back to a Chromium "app window" (no tabs, no address bar), then the browser.
 * In browser mode it goes straight to a normal tab in the default browser.
 */
async function openApp({ fromHook = false, browser = appMode() === 'browser' } = {}) {
  const detached = { detached: true, stdio: 'ignore' };
  let electron = null;
  if (!browser) {
    try {
      electron = require('electron');
    } catch {
      electron = null;
    }
  }
  if (typeof electron === 'string' && existsSync(electron)) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    spawn(electron, [resolve(here, '../desktop/main.cjs'), ...(fromHook ? ['--from-hook'] : [])], { ...detached, env }).unref();
    return 'desktop';
  }
  // No Electron: run the server in the background, then open a window onto it.
  if (!(await healthy())) {
    spawn(process.execPath, [SELF, 'start'], detached).unref();
    for (let i = 0; i < 30 && !(await healthy()); i++) await sleep(100);
  }
  const chromium = browser ? null : findChromium();
  const url = `http://127.0.0.1:${PORT}/${chromium ? '?app=1' : ''}`;
  if (chromium?.mac) spawn('open', ['-na', chromium.mac, '--args', `--app=${url}`, '--new-window'], detached).unref();
  else if (chromium?.bin) spawn(chromium.bin, [`--app=${url}`], detached).unref();
  else {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(opener, args, detached).unref();
  }
  return chromium ? 'app-window' : 'browser';
}

async function app(args) {
  const f = flags(args);
  readConfig();
  const how = await openApp(f.browser ? { browser: true } : {});
  console.log(
    how === 'desktop'
      ? 'Agent Floor is opening in its own window. It keeps running in the menu bar when you close it.'
      : how === 'app-window'
        ? 'Agent Floor is opening in an app window. Install Electron (npm i -g electron) for the full desktop app.'
        : `Agent Floor is running at http://127.0.0.1:${PORT}`,
  );
}

// ---------------------------------------------------------------- hook
// A hook must never slow down or break the agent. Every failure is swallowed
// and the process always exits 0.

// An invalid rooms file must not stop the hook: the session lands in a room named
// after its folder, and `POST /reload` reports what is wrong with the file.
function hookRooms() {
  try {
    return loadRooms(roomsPath(localState.DIR), homedir());
  } catch {
    return null;
  }
}

const agentConfig = (name) => () => agentSection(readConfig(), name);

async function hook(kind) {
  let response = '';
  try {
    const args = rest.slice(1);
    const integration = HOOK_AGENTS.includes(kind) ? INTEGRATIONS[kind] : null;
    await integration?.hook({
      args,
      flags: flags(args),
      readStdin,
      send: postOrLaunch,
      respond: (text) => (response = text),
      config: agentConfig(kind),
      rooms: hookRooms,
    });
  } catch {
    // Floor not running, or bad payload. Stay silent.
  }
  if (response) process.stdout.write(response);
  process.exit(0);
}

// ---------------------------------------------------------------- emit
async function emit(args) {
  const f = flags(args);
  if (!f.agent) {
    console.error('Usage: agent-floor emit --agent <id> [--type status] [--status working] [--activity "..."] [--team name] [--role role] [--to id --text "..."]');
    process.exit(1);
  }
  const ev = {
    type: f.type || (f.to ? 'message' : f.tool ? 'tool' : f.task ? 'task' : 'status'),
    agent: f.agent,
    team: f.team,
    name: f.name,
    role: f.role,
    source: f.source || 'cli',
    parent: f.parent,
    status: f.status,
    activity: f.activity,
    tool: f.tool,
    task: f.task,
    to: f.to ? String(f.to).split(',') : undefined,
    text: f.text,
  };
  try {
    await post([ev]);
  } catch (err) {
    console.error(`Could not reach ${URL_BASE}. Is the floor running? (${err.message})`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- setup
// Hooks always run this local file, never a package fetched from the registry.
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const hookCommand = (kind, configDir) =>
  `node ${shellQuote(SELF)} hook ${kind}` + (configDir ? ` --config-dir ${shellQuote(configDir)}` : '');

const SETUP_USAGE = 'Usage: ' + setupForms().map(({ args }) => `agent-floor setup ${args}`).join('\n       ');

async function setup(args) {
  const f = flags(args);
  const kind = f._[0];
  if (!AGENTS.includes(kind)) {
    console.log(SETUP_USAGE);
    process.exit(1);
  }
  readConfig();
  try {
    await INTEGRATIONS[kind].setup({ flags: f, self: SELF, hookCommand, config: agentConfig(kind) });
  } catch (err) {
    if (err instanceof UsageError) console.log(SETUP_USAGE);
    else if (err instanceof SetupError) console.error(err.message);
    else throw err;
    process.exit(1);
  }
}

// ---------------------------------------------------------------- start
async function start(args) {
  const f = flags(args);
  readConfig();
  const { startServer } = await import('../server/index.mjs');
  const port = Number(f.port) || undefined;
  const host = f.host || undefined;
  try {
    await startServer({ port, host, floorDir: localState.DIR });
    if (f.open) await openApp({ browser: Boolean(f.browser) });
    console.log(`Connect an agent:  agent-floor setup ${AGENTS.join(' | ')}`);
    console.log('Press Ctrl+C to stop.');
  } catch (err) {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port || 4317} is already in use. Try --port 4318.` : err.message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- quiet / stop
// Same pause as the tray's "Quit (pause auto-open for 6 hours)".
const QUIET_HOURS = 6;
const plural = (n) => `${n} hour${n === 1 ? '' : 's'}`;

async function quiet(args) {
  const arg = flags(args)._[0];
  const hours = arg === undefined ? QUIET_HOURS : Number(arg);
  if (!Number.isFinite(hours) || hours <= 0) {
    console.error(`Usage: agent-floor quiet [hours]   (a number above 0, default ${QUIET_HOURS})`);
    process.exit(1);
  }
  localState.snooze(hours);
  console.log(`Hooks will not open Agent Floor for ${plural(hours)}. A floor that is already running keeps running; agent-floor stop stops it.`);
}

async function stop() {
  // Pause first: otherwise the next hook (even the one for this very command) opens the floor again.
  localState.snooze(QUIET_HOURS);
  let res;
  try {
    res = await fetch(`${URL_BASE}/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localState.readToken()}` },
      body: '{}',
      signal: AbortSignal.timeout(2000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      console.error(`The floor at ${URL_BASE} did not answer within 2 seconds.`);
      process.exit(1);
    }
    if (err.cause?.code !== 'ECONNREFUSED') throw err;
    console.log(`No floor is running at ${URL_BASE}. Hooks will not open it for ${plural(QUIET_HOURS)}.`);
    return;
  }
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    console.error(`The floor at ${URL_BASE} did not stop: HTTP ${res.status}${error ? ` (${error})` : ''}.`);
    process.exit(1);
  }
  console.log(`Stopped the floor at ${URL_BASE}. Hooks will not open it again for ${plural(QUIET_HOURS)}; run agent-floor to open it yourself.`);
}

// ---------------------------------------------------------------- demo
async function demo(args) {
  const f = flags(args);
  const { createScript } = await import('../shared/demo-script.js');
  const script = createScript(Date.now(), { agents: Number(f.agents) || 0 });
  console.log(`Streaming a demo into ${URL_BASE}. Ctrl+C to stop.`);
  let failures = 0;
  for (;;) {
    const step = script.next();
    try {
      await post(step.events);
      failures = 0;
    } catch {
      // A slow moment is fine; give up only if the floor is really gone.
      if (++failures >= 5) {
        console.error(`Could not reach ${URL_BASE}. Start the floor first: agent-floor start`);
        process.exit(1);
      }
    }
    await new Promise((r) => setTimeout(r, step.wait));
  }
}

const commands = { app, start, hook: () => hook(rest[0]), emit, setup, demo, stop, quiet };
if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(`agent-floor: a live 3D office for your coding agents

  agent-floor                              open the desktop app (starts the floor too)
  agent-floor start [--port 4317] [--open] run the floor without a window
${setupForms()
  .map(({ args, note }) => `  agent-floor setup ${args}${note ? `   (${note})` : ''}`)
  .join('\n')}
  agent-floor emit --agent <id> --status working --activity "Writing tests" [--team checkout]
  agent-floor demo [--agents 60]          (stress test with many agents)
  agent-floor stop                         stop the floor (the desktop app quits if it runs it); hooks wait 6 hours to reopen it
  agent-floor quiet [hours]                hooks don't open the floor for a while (default 6); a running floor stays up
  agent-floor hook <${HOOK_AGENTS.join('|')}>  (called by agent hooks)

Environment: AGENT_FLOOR_URL, AGENT_FLOOR_PORT, AGENT_FLOOR_TEAM, AGENT_FLOOR_NAME,\n             AGENT_FLOOR_AUTOLAUNCH=0 (hooks never open the app)`);
} else if (commands[cmd] || cmd.startsWith('--')) {
  try {
    await (commands[cmd] ? commands[cmd](rest) : start([cmd, ...rest]));
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
} else {
  console.error(`Unknown command "${cmd}". Try agent-floor --help`);
  process.exit(1);
}
