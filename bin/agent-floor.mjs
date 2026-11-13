#!/usr/bin/env node
// agent-floor CLI
//
//   agent-floor [start] [--port 4317] [--open]   run the floor
//   agent-floor hook <claude|codex|cursor|hermes>  used by agent hooks (reads stdin / argv)
//   agent-floor emit --agent id --status working --activity "..."  [--team x] [--to id --text "..."]
//   agent-floor setup <claude|codex|cursor|hermes|opencode|pi> [--write] [--project]
//   agent-floor setup claude --settings <file> [--config-dir <dir>] [--write]
//   agent-floor demo                             push a scripted demo into a running floor
//   agent-floor stop                             stop the running floor and pause auto-open for 6 hours
//   agent-floor quiet [hours]                    pause auto-open from hooks (default 6 hours)
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { accountLabel, claudeConfigDirFor, claudeSetupTargets } from '../lib/accounts.mjs';
import { loadRooms, roomsPath } from '../lib/rooms.mjs';
import { HooksSectionExists, appendYamlHooks, mergeClaudeHooks, mergeCursorHooks, mergePiExtensions, updateJsonFile, updateTextFile } from '../lib/settings.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SELF = resolve(here, 'agent-floor.mjs');
const PORT = Number(process.env.AGENT_FLOOR_PORT) || 4317;
const URL_BASE = (process.env.AGENT_FLOOR_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const IS_LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(URL_BASE);
const require = createRequire(import.meta.url);
const localState = require('../desktop/state.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [, , cmd = 'app', ...rest] = process.argv;

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

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
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
function claudeAccount(cwd, installedFor) {
  const config = localState.readConfig();
  const home = homedir();
  const dir = claudeConfigDirFor({ installedFor, envDir: process.env.CLAUDE_CONFIG_DIR, cwd, config, home });
  return accountLabel(dir, config, home);
}

// An invalid rooms file must not stop the hook: the session lands in a room named
// after its folder, and `POST /reload` reports what is wrong with the file.
function hookRooms() {
  try {
    return loadRooms(roomsPath(localState.DIR), homedir());
  } catch {
    return null;
  }
}

async function hook(kind) {
  let response = '';
  try {
    if (kind === 'claude') {
      const { fromClaude } = await import('../adapters/claude.mjs');
      const input = parseJson(await readStdin());
      const account = claudeAccount(input?.cwd, flags(rest.slice(1))['config-dir']);
      await postOrLaunch(fromClaude(input, { account, rooms: hookRooms() }));
    } else if (kind === 'codex') {
      const { fromCodex } = await import('../adapters/codex.mjs');
      // notify passes JSON as the last argv entry; hooks pass it on stdin.
      const arg = rest.slice(1).find((x) => x.trim().startsWith('{'));
      const input = parseJson(arg) || parseJson(await readStdin());
      await postOrLaunch(fromCodex(input));
    } else if (kind === 'cursor') {
      const { fromCursor, cursorResponse } = await import('../adapters/cursor.mjs');
      const input = parseJson(await readStdin());
      response = cursorResponse(input?.hook_event_name);
      await postOrLaunch(fromCursor(input));
    } else if (kind === 'hermes') {
      // Prints nothing: Hermes reads stdout as a block, modify or context directive.
      const { fromHermes } = await import('../adapters/hermes.mjs');
      await postOrLaunch(fromHermes(parseJson(await readStdin())));
    }
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
const hookCmd = (kind, configDir) =>
  `node ${shellQuote(SELF)} hook ${kind}` + (configDir ? ` --config-dir ${shellQuote(configDir)}` : '');

function claudeHooks(configDir) {
  const command = hookCmd('claude', configDir);
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop', 'PreCompact', 'SessionEnd'];
  const hooks = {};
  for (const e of events) {
    const entry = { hooks: [{ type: 'command', command, timeout: 5 }] };
    if (e === 'PreToolUse' || e === 'PostToolUse') entry.matcher = '*';
    hooks[e] = [entry];
  }
  return hooks;
}

function cursorHooks() {
  const command = hookCmd('cursor');
  const names = [
    'beforeSubmitPrompt',
    'afterAgentThought',
    'afterAgentResponse',
    'afterFileEdit',
    'afterShellExecution',
    'afterMCPExecution',
    'subagentStop',
    'stop',
    'sessionEnd',
  ];
  return { version: 1, hooks: Object.fromEntries(names.map((n) => [n, [{ command }]])) };
}

/** A `hooks:` block for Hermes' config.yaml. JSON strings are valid YAML double-quoted scalars. */
async function hermesHooks() {
  const { HERMES_EVENTS } = await import('../adapters/hermes.mjs');
  const command = JSON.stringify(hookCmd('hermes'));
  const lines = ['hooks:'];
  for (const event of Object.keys(HERMES_EVENTS)) lines.push(`  ${event}:`, `    - command: ${command}`, '      timeout: 5');
  return lines.join('\n') + '\n';
}

// opencode loads plain .js files from its plugins folders. This one only points
// at the plugin inside this install, so updating Agent Floor updates the plugin.
function opencodePlugin() {
  const plugin = pathToFileURL(resolve(here, '../adapters/opencode-plugin.mjs')).href;
  return [
    '// Agent Floor for opencode, written by `agent-floor setup opencode`.',
    '// Run that command again if you move the agent-floor folder.',
    `import { createPlugin } from ${JSON.stringify(plugin)};`,
    '',
    'export default createPlugin();',
    '',
  ].join('\n');
}

function opencodePluginPath(project) {
  if (project) return resolve('.opencode/plugins/agent-floor.js');
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(config, 'opencode', 'plugins', 'agent-floor.js');
}

async function writeHooks(path, merge, opens) {
  const { changed, backup } = await updateJsonFile(path, merge);
  if (!changed) console.log(`${path} already has the current Agent Floor hooks.`);
  else console.log(`Merged Agent Floor hooks into ${path}${backup ? ` (backup at ${backup})` : ''}. ${opens}`);
}

const SETUP_USAGE = 'Usage: agent-floor setup <claude|codex|cursor|hermes|opencode|pi> [--write] [--project]\n       agent-floor setup claude --settings <file> [--config-dir <dir>] [--write]';

async function setup(args) {
  const f = flags(args);
  const kind = f._[0];
  if (kind === 'claude') {
    if (f.settings === true || f['config-dir'] === true) {
      console.log(SETUP_USAGE);
      process.exit(1);
    }
    const targets = claudeSetupTargets({
      settingsFile: f.settings,
      project: f.project,
      configDir: f['config-dir'],
      cwd: process.cwd(),
      config: localState.readConfig(),
      home: homedir(),
    }).map(({ path, configDir }) => ({ path, hooks: claudeHooks(configDir) }));
    for (const { path, hooks } of targets) {
      if (!f.write) {
        console.log(`Add this to ${path} (or rerun with --write to merge it for you):\n`);
        console.log(JSON.stringify({ hooks }, null, 2) + '\n');
        continue;
      }
      await writeHooks(path, (settings) => mergeClaudeHooks(settings, hooks), 'Agent Floor will open by itself the next time a Claude Code session starts.');
    }
  } else if (kind === 'cursor') {
    const config = cursorHooks();
    const path = f.project ? resolve('.cursor/hooks.json') : join(homedir(), '.cursor', 'hooks.json');
    if (!f.write) {
      console.log(`Add this to ${path} (or rerun with --write to merge it for you):\n`);
      console.log(JSON.stringify(config, null, 2));
      return;
    }
    await writeHooks(path, (current) => mergeCursorHooks(current, config), 'Agent Floor will open by itself the next time a Cursor agent runs.');
  } else if (kind === 'hermes') {
    const path = join(process.env.HERMES_HOME || join(homedir(), '.hermes'), 'config.yaml');
    const block = await hermesHooks();
    if (!f.write) {
      console.log(`Add this to ${path} (or rerun with --write to append it for you):\n`);
      console.log(block);
      return;
    }
    let result;
    try {
      result = await updateTextFile(path, (current) => appendYamlHooks(current, block));
    } catch (err) {
      if (!(err instanceof HooksSectionExists)) throw err;
      console.error(`${path} already has a "hooks:" section, so Agent Floor left it alone. Merge these entries into it by hand:\n`);
      console.error(block);
      process.exit(1);
    }
    if (!result.changed) console.log(`${path} already has the current Agent Floor hooks.`);
    else console.log(`Added Agent Floor hooks to ${path}${result.backup ? ` (backup at ${result.backup})` : ''}.`);
    console.log('Hermes asks you to approve each new hook the next time `hermes chat` starts (or start it once with --accept-hooks). `hermes hooks list` shows which ones are approved.');
  } else if (kind === 'opencode') {
    const path = opencodePluginPath(f.project);
    const plugin = opencodePlugin();
    if (!f.write) {
      console.log(`Write this file to ${path} (or rerun with --write to write it for you):\n`);
      console.log(plugin);
      return;
    }
    const { changed, backup } = await updateTextFile(path, () => plugin);
    if (!changed) console.log(`${path} already has the current Agent Floor plugin.`);
    else console.log(`Wrote ${path}${backup ? ` (backup at ${backup})` : ''}. Restart opencode to load it.`);
  } else if (kind === 'codex') {
    const path = join(homedir(), '.codex', 'config.toml');
    console.log(`Add this line near the top of ${path}:\n`);
    console.log(`notify = ["node", ${JSON.stringify(SELF)}, "hook", "codex"]\n`);
    console.log('Codex allows one notify program. If you already have one, chain them in a small script.');
  } else if (kind === 'pi') {
    // pi runs this extension in its own process, so it needs no hook command.
    const extension = resolve(here, '../extensions/agent-floor-pi.js');
    const agentDir = process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=$|[\\/])/, homedir()) || join(homedir(), '.pi', 'agent');
    const path = f.project ? resolve('.pi/settings.json') : join(agentDir, 'settings.json');
    if (!f.write) {
      console.log(`Add this to ${path} (or rerun with --write to merge it for you):\n`);
      console.log(JSON.stringify({ extensions: [extension] }, null, 2));
      return;
    }
    const { changed, backup } = await updateJsonFile(path, (settings) => mergePiExtensions(settings, extension));
    if (!changed) console.log(`${path} already loads the Agent Floor extension.`);
    else console.log(`Added the Agent Floor extension to ${path}${backup ? ` (backup at ${backup})` : ''}. New pi sessions will show up on the floor.`);
  } else {
    console.log(SETUP_USAGE);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- start
async function start(args) {
  const f = flags(args);
  const { startServer } = await import('../server/index.mjs');
  const port = Number(f.port) || undefined;
  const host = f.host || undefined;
  try {
    await startServer({ port, host, floorDir: localState.DIR });
    if (f.open) await openApp({ browser: Boolean(f.browser) });
    console.log('Connect an agent:  agent-floor setup claude | codex | cursor | hermes | opencode | pi');
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
  agent-floor setup <claude|codex|cursor|hermes|opencode|pi> [--write] [--project]
  agent-floor setup claude --settings <file> [--config-dir <dir>] [--write]   (for claude --settings)
  agent-floor emit --agent <id> --status working --activity "Writing tests" [--team checkout]
  agent-floor demo [--agents 60]          (stress test with many agents)
  agent-floor stop                         stop the floor (the desktop app quits if it runs it); hooks wait 6 hours to reopen it
  agent-floor quiet [hours]                hooks don't open the floor for a while (default 6); a running floor stays up
  agent-floor hook <claude|codex|cursor|hermes>  (called by agent hooks)

Environment: AGENT_FLOOR_URL, AGENT_FLOOR_PORT, AGENT_FLOOR_TEAM, AGENT_FLOOR_NAME,\n             AGENT_FLOOR_AUTOLAUNCH=0 (hooks never open the app)`);
} else if (commands[cmd]) {
  await commands[cmd](rest);
} else if (cmd.startsWith('--')) {
  await start([cmd, ...rest]);
} else {
  console.error(`Unknown command "${cmd}". Try agent-floor --help`);
  process.exit(1);
}
