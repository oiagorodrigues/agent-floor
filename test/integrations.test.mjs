import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, HOOK_AGENTS, INTEGRATIONS, setupForms } from '../integrations/index.mjs';
import { ConfigError, agentSection, checkConfig } from '../lib/config.mjs';
import { startServer } from '../server/index.mjs';

const CLI = resolve(fileURLToPath(import.meta.url), '../../bin/agent-floor.mjs');
const SETUP_USAGE =
  'Usage: agent-floor setup <claude|codex|cursor|hermes|opencode|pi> [--write] [--project]\n' +
  '       agent-floor setup claude --settings <file> [--config-dir <dir>] [--write]\n';

/** Runs the CLI with only the variables given, so the real CLAUDE_CONFIG_DIR or AGENT_FLOOR_* never leak in. */
function cli(args, { env = {}, input = '', cwd } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { PATH: process.env.PATH, ...env }, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function tempHome() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'af-integrations-')));
  const floorHome = join(home, '.agent-floor');
  await mkdir(floorHome);
  return { home, floorHome, env: { HOME: home, AGENT_FLOOR_HOME: floorHome, AGENT_FLOOR_AUTOLAUNCH: '0' } };
}

const writeConfig = (floorHome, config) => writeFile(join(floorHome, 'config.json'), JSON.stringify(config));
const claudeCommand = (configDir) => `node '${CLI}' hook claude` + (configDir ? ` --config-dir '${configDir}'` : '');
const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop', 'PreCompact', 'SessionEnd'];

test('the registry lists every integration folder, each with a setup', async () => {
  const root = resolve(fileURLToPath(import.meta.url), '../../integrations');
  const folders = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  assert.deepEqual(AGENTS, folders.sort());
  for (const name of AGENTS) assert.equal(typeof INTEGRATIONS[name].setup, 'function', name);
  assert.deepEqual(HOOK_AGENTS, ['claude', 'codex', 'cursor', 'hermes']);
});

test('the setup usage and the help are built from the registry', async () => {
  const { env } = await tempHome();
  const forms = setupForms();
  assert.deepEqual(forms[0], { args: `<${AGENTS.join('|')}> [--write] [--project]`, note: '' });
  assert.equal(SETUP_USAGE, `Usage: ${forms.map((f) => `agent-floor setup ${f.args}`).join('\n       ')}\n`);
  const help = (await cli(['--help'], { env })).stdout;
  for (const { args } of forms) assert.ok(help.includes(`agent-floor setup ${args}`), args);
  assert.ok(help.includes(`agent-floor hook <${HOOK_AGENTS.join('|')}>`));
});

test('setup runs for every registered agent instead of printing the usage', async () => {
  const { env } = await tempHome();
  for (const name of AGENTS) {
    const res = await cli(['setup', name], { env });
    assert.equal(res.code, 0, `${name}: ${res.stderr}`);
    assert.ok(!res.stdout.includes('Usage:'), name);
  }
});

test('setup without an agent, or with an unknown one, prints the usage and exits 1', async () => {
  const { env } = await tempHome();
  for (const args of [['setup'], ['setup', 'gemini'], ['setup', 'claude', '--settings'], ['setup', 'claude', '--config-dir']]) {
    assert.deepEqual(await cli(args, { env }), { code: 1, stdout: SETUP_USAGE, stderr: '' }, args.join(' '));
  }
});

test('help lists every agent that can be set up and every agent with a hook', async () => {
  const { env } = await tempHome();
  const { code, stdout } = await cli(['--help'], { env });
  assert.equal(code, 0);
  assert.equal(
    stdout,
    `agent-floor: a live 3D office for your coding agents

  agent-floor                              open the desktop app (starts the floor too)
  agent-floor start [--port 4317] [--open] run the floor without a window
  agent-floor setup <claude|codex|cursor|hermes|opencode|pi> [--write] [--project]
  agent-floor setup claude --settings <file> [--config-dir <dir>] [--write]   (for claude --settings)
  agent-floor emit --agent <id> --status working --activity "Writing tests" [--team checkout]
  agent-floor demo [--agents 60]          (stress test with many agents)
  agent-floor stop                         stop the floor (the desktop app quits if it runs it); hooks wait 6 hours to reopen it
  agent-floor quiet [hours]                hooks don't open the floor for a while (default 6); a running floor stays up
  agent-floor hook <claude|codex|cursor|hermes>  (called by agent hooks)

Environment: AGENT_FLOOR_URL, AGENT_FLOOR_PORT, AGENT_FLOOR_TEAM, AGENT_FLOOR_NAME,
             AGENT_FLOOR_AUTOLAUNCH=0 (hooks never open the app)
`,
  );
});

test('setup codex prints the notify line for this install', async () => {
  const { home, env } = await tempHome();
  const { code, stdout } = await cli(['setup', 'codex'], { env });
  assert.equal(code, 0);
  assert.ok(stdout.includes(`Add this line near the top of ${join(home, '.codex', 'config.toml')}:`));
  assert.ok(stdout.includes(`notify = ["node", ${JSON.stringify(CLI)}, "hook", "codex"]`));
});

test('setup claude prints, then writes hooks into the default and every mapped config dir', async () => {
  const { home, floorHome, env } = await tempHome();
  await writeConfig(floorHome, { agents: { claude: { byPath: [{ path: '~/work', configDir: '~/.claude-work' }] } } });
  const dirs = [join(home, '.claude'), join(home, '.claude-work')];

  const printed = await cli(['setup', 'claude'], { env });
  assert.equal(printed.code, 0, printed.stderr);
  for (const dir of dirs) {
    assert.ok(printed.stdout.includes(`Add this to ${join(dir, 'settings.json')}`), dir);
    assert.ok(printed.stdout.includes(JSON.stringify(claudeCommand(dir))), dir);
  }

  await mkdir(dirs[0]);
  await writeFile(join(dirs[0], 'settings.json'), JSON.stringify({ model: 'opus' }));
  const written = await cli(['setup', 'claude', '--write'], { env });
  assert.equal(written.code, 0, written.stderr);
  for (const dir of dirs) {
    const settings = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
    assert.deepEqual(Object.keys(settings.hooks), CLAUDE_EVENTS);
    assert.equal(settings.hooks.PreToolUse[0].matcher, '*');
    assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: 'command', command: claudeCommand(dir), timeout: 5 }] }]);
  }
  assert.equal(JSON.parse(await readFile(join(dirs[0], 'settings.json'), 'utf8')).model, 'opus');
  assert.match((await cli(['setup', 'claude', '--write'], { env })).stdout, /already has the current Agent Floor hooks/);
});

test('setup claude --settings writes only that file, tagged with --config-dir when given', async () => {
  const { home, env } = await tempHome();
  const res = await cli(['setup', 'claude', '--settings', 'run.json', '--config-dir', '~/.claude-ci', '--write'], { env, cwd: home });
  assert.equal(res.code, 0, res.stderr);
  const settings = JSON.parse(await readFile(join(home, 'run.json'), 'utf8'));
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].command, claudeCommand(join(home, '.claude-ci')));

  const project = await cli(['setup', 'claude', '--project', '--write'], { env, cwd: home });
  assert.equal(project.code, 0, project.stderr);
  const projectSettings = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(projectSettings.hooks.Stop[0].hooks[0].command, claudeCommand());
});

/** A floor on a random port with a known token; `agents()` lists what reached it. */
async function floor(floorHome) {
  const token = 'integrations-test-token';
  await writeFile(join(floorHome, 'token'), token, { mode: 0o600 });
  const server = await startServer({ port: 0, log: () => {}, token, randomNames: false });
  const url = `http://127.0.0.1:${server.server.address().port}`;
  return {
    url,
    agents: async () => Object.values((await (await fetch(`${url}/state`)).json()).agents),
    close: () => server.close(),
  };
}

test('hook claude posts the event with the account of the folder rule, prints nothing and exits 0', async () => {
  const { home, floorHome, env } = await tempHome();
  await writeConfig(floorHome, { agents: { claude: { byPath: [{ path: '~/work', configDir: '~/.claude-work' }] } } });
  const f = await floor(floorHome);
  const hookEnv = { ...env, AGENT_FLOOR_URL: f.url };
  try {
    const input = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'abc123', cwd: join(home, 'work', 'api') });
    assert.deepEqual(await cli(['hook', 'claude'], { env: hookEnv, input }), { code: 0, stdout: '', stderr: '' });
    const [agent] = await f.agents();
    assert.equal(agent.source, 'claude-code');
    assert.equal(agent.account, 'work');

    const installed = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'def456', cwd: join(home, 'work') });
    await cli(['hook', 'claude', '--config-dir', join(home, '.claude')], { env: hookEnv, input: installed });
    const other = (await f.agents()).find((a) => a.id.includes('def456'));
    assert.equal(other.account, undefined, 'the installed dir is the default account');
  } finally {
    await f.close();
  }
});

test('hook claude stays silent and exits 0 when config.json is malformed', async () => {
  const { home, floorHome, env } = await tempHome();
  await writeConfig(floorHome, { agents: { claude: { byPath: 'nope' } } });
  const f = await floor(floorHome);
  try {
    const input = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'abc123', cwd: home });
    assert.deepEqual(await cli(['hook', 'claude'], { env: { ...env, AGENT_FLOOR_URL: f.url }, input }), { code: 0, stdout: '', stderr: '' });
    assert.deepEqual(await f.agents(), []);
  } finally {
    await f.close();
  }
});

test('hook codex takes the notify payload from argv or a hook payload from stdin', async () => {
  const { floorHome, env } = await tempHome();
  const f = await floor(floorHome);
  const hookEnv = { ...env, AGENT_FLOOR_URL: f.url };
  try {
    const notify = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'thread1', cwd: '/w/shop', 'last-assistant-message': 'Done' });
    assert.deepEqual(await cli(['hook', 'codex', notify], { env: hookEnv }), { code: 0, stdout: '', stderr: '' });
    const stdin = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'sess2', cwd: '/w/shop' });
    assert.deepEqual(await cli(['hook', 'codex'], { env: hookEnv, input: stdin }), { code: 0, stdout: '', stderr: '' });
    const agents = await f.agents();
    assert.deepEqual(agents.map((a) => a.source).sort(), ['codex', 'codex']);
  } finally {
    await f.close();
  }
});

test('hook cursor answers beforeSubmitPrompt on stdout and posts the event', async () => {
  const { floorHome, env } = await tempHome();
  const f = await floor(floorHome);
  try {
    const input = JSON.stringify({ hook_event_name: 'beforeSubmitPrompt', conversation_id: 'conv1', workspace_roots: ['/w/shop'], prompt: 'hi' });
    assert.deepEqual(await cli(['hook', 'cursor'], { env: { ...env, AGENT_FLOOR_URL: f.url }, input }), { code: 0, stdout: '{"continue":true}', stderr: '' });
    const [agent] = await f.agents();
    assert.equal(agent.source, 'cursor');
  } finally {
    await f.close();
  }
  // Floor gone: the answer still goes out.
  const input = JSON.stringify({ hook_event_name: 'beforeSubmitPrompt', conversation_id: 'conv1' });
  assert.deepEqual(await cli(['hook', 'cursor'], { env: { ...env, AGENT_FLOOR_URL: 'http://127.0.0.1:9' }, input }), { code: 0, stdout: '{"continue":true}', stderr: '' });
});

test('hook with an unknown or missing agent does nothing and exits 0', async () => {
  const { env } = await tempHome();
  assert.deepEqual(await cli(['hook', 'gemini'], { env, input: '{}' }), { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(await cli(['hook'], { env, input: '{}' }), { code: 0, stdout: '', stderr: '' });
});

// The shape before "agents": agent sections sat at the top of the file.
const OLD_CONFIG = { app: 'browser', claude: { defaultConfigDir: '~/.claude', byPath: [{ path: '~/work', configDir: '~/.claude-work' }] } };
const MOVED_CONFIG = { app: 'browser', agents: { claude: OLD_CONFIG.claude } };

test('config.json keeps global keys at the top and each agent under "agents"', () => {
  const config = { app: 'browser', agents: { claude: { defaultConfigDir: '~/.claude-main' } } };
  assert.equal(checkConfig(config, AGENTS, '/f/config.json'), config);
  assert.deepEqual(agentSection(config, 'claude'), { defaultConfigDir: '~/.claude-main' });
  assert.deepEqual(agentSection(config, 'cursor'), {});
  assert.deepEqual(agentSection(checkConfig({}, AGENTS), 'claude'), {});
  assert.throws(() => checkConfig({ agents: [] }, AGENTS, '/f/config.json'), (err) => err instanceof ConfigError && /"agents" must be an object/.test(err.message));
});

test('an agent section at the top level is refused with the file it should become', () => {
  assert.throws(
    () => checkConfig(OLD_CONFIG, AGENTS, '/f/config.json'),
    (err) =>
      err instanceof ConfigError &&
      err.message === `/f/config.json: agent settings now live under "agents". Move "claude" there, so the file reads:\n\n${JSON.stringify(MOVED_CONFIG, null, 2)}`,
  );
  assert.throws(
    () => checkConfig({ agents: { pi: {} }, claude: {}, cursor: {} }, AGENTS, '/f/config.json'),
    (err) => err.message.includes('Move "claude" and "cursor" there') && err.message.endsWith(JSON.stringify({ agents: { pi: {}, claude: {}, cursor: {} } }, null, 2)),
  );
});

test('a half-moved config keeps the settings already under "agents" in the suggested file', () => {
  const config = { agents: { claude: { defaultConfigDir: '~/.claude-new' } }, claude: { defaultConfigDir: '~/.claude-old', byPath: [] } };
  assert.throws(
    () => checkConfig(config, AGENTS, '/f/config.json'),
    (err) => err.message.endsWith(JSON.stringify({ agents: { claude: { defaultConfigDir: '~/.claude-new', byPath: [] } } }, null, 2)),
  );
});

test('setup stops on a config.json that is not valid JSON and names the file', async () => {
  const { home, floorHome, env } = await tempHome();
  await writeFile(join(floorHome, 'config.json'), '{ bad');
  const { code, stdout, stderr } = await cli(['setup', 'cursor'], { env, cwd: home });
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, new RegExp(`^${join(floorHome, 'config.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: not valid JSON \\(.+\\)\\.\n$`));
});

test('setup and start stop on the old config shape and say how to move it', async () => {
  const { home, floorHome, env } = await tempHome();
  await writeConfig(floorHome, OLD_CONFIG);
  const expected = `${join(floorHome, 'config.json')}: agent settings now live under "agents". Move "claude" there, so the file reads:\n\n${JSON.stringify(MOVED_CONFIG, null, 2)}\n`;
  for (const args of [['setup', 'claude', '--write'], ['setup', 'cursor', '--write'], ['start', '--port', '0']]) {
    assert.deepEqual(await cli(args, { env, cwd: home }), { code: 1, stdout: '', stderr: expected }, args.join(' '));
  }
  assert.deepEqual(await readdir(home), ['.agent-floor'], 'nothing was written');
  assert.deepEqual(JSON.parse(await readFile(join(floorHome, 'config.json'), 'utf8')), OLD_CONFIG);
});

test('hook claude stays silent and exits 0 on the old config shape', async () => {
  const { home, floorHome, env } = await tempHome();
  await writeConfig(floorHome, OLD_CONFIG);
  const f = await floor(floorHome);
  try {
    const input = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'abc123', cwd: join(home, 'work') });
    assert.deepEqual(await cli(['hook', 'claude'], { env: { ...env, AGENT_FLOOR_URL: f.url }, input }), { code: 0, stdout: '', stderr: '' });
    assert.deepEqual(await f.agents(), []);
  } finally {
    await f.close();
  }
});
