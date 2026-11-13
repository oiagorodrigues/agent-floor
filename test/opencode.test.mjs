import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { fromOpencodeV1, fromOpencodeV2, opencodeAgentId } from '../adapters/opencode.mjs';
import { createPlugin } from '../adapters/opencode-plugin.mjs';
import { startServer } from '../server/index.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const CLI = join(ROOT, 'bin/agent-floor.mjs');
const run = promisify(execFile);

const SESSION = 'ses_8e1f2a3b4c5dK9xQwErTyUiOpA';
const opts = { directory: '/w/api', sharePrompts: false };

// Payloads follow the examples and hook types in https://opencode.ai/docs/v1/plugins/.
test('opencode 1 tool hooks become tool activity on the session desk', () => {
  const [before] = fromOpencodeV1('tool.execute.before', { tool: 'read', sessionID: SESSION, callID: 'call_1' }, { args: { filePath: '/w/api/.env' } }, opts);
  assert.deepEqual(before, {
    type: 'tool',
    agent: opencodeAgentId(SESSION),
    team: 'api',
    source: 'opencode',
    name: 'OpenCode',
    role: 'Lead',
    tool: 'read',
    activity: 'Reading .env',
  });

  const [bash] = fromOpencodeV1('tool.execute.before', { tool: 'bash', sessionID: SESSION, callID: 'call_2' }, { args: { command: 'npm test', description: 'Run tests' } }, opts);
  assert.equal(bash.activity, 'Running npm test');

  const [after] = fromOpencodeV1(
    'tool.execute.after',
    { tool: 'edit', sessionID: SESSION, callID: 'call_3', args: { filePath: '/w/api/src/cart.ts' } },
    { title: 'src/cart.ts', output: '', metadata: {} },
    opts,
  );
  assert.equal(after.type, 'status');
  assert.equal(after.status, 'thinking');
  assert.equal(after.activity, 'Done: Editing cart.ts');
});

test('opencode 1 events: idle, errors and permission prompts', () => {
  const v1 = (event) => fromOpencodeV1('event', { event }, undefined, opts);
  assert.equal(v1({ type: 'session.idle', properties: { sessionID: SESSION } })[0].status, 'idle');
  assert.equal(v1({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } })[0].status, 'idle');
  assert.deepEqual(v1({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'busy' } } }), []);
  assert.equal(v1({ type: 'session.error', properties: { sessionID: SESSION, error: { name: 'UnknownError' } } })[0].status, 'error');
  assert.equal(v1({ type: 'permission.asked', properties: { id: 'per_1', sessionID: SESSION, permission: 'bash' } })[0].status, 'waiting');
  assert.equal(v1({ type: 'session.deleted', properties: { info: { id: SESSION } } })[0].type, 'leave');
  assert.deepEqual(v1({ type: 'file.edited', properties: { file: 'a.ts' } }), []);
  assert.deepEqual(v1({ type: 'session.error', properties: {} }), [], 'an error without a session has no desk');
  assert.deepEqual(fromOpencodeV1('tool.execute.before', null, {}, opts), []);
});

// Payloads follow https://opencode.ai/docs/build/plugins/server/ and .../migrate-v1/.
test('opencode 2 tool hooks, prompt hook and bus events', () => {
  const [before] = fromOpencodeV2(
    'tool.execute.before',
    { tool: 'grep', sessionID: SESSION, agent: 'build', messageID: 'msg_1', id: 'call_1', input: { pattern: 'TODO' } },
    opts,
  );
  assert.equal(before.type, 'tool');
  assert.equal(before.agent, opencodeAgentId(SESSION));
  assert.equal(before.activity, 'Searching for "TODO"');

  const [failed] = fromOpencodeV2(
    'tool.execute.after',
    { tool: 'bash', sessionID: SESSION, agent: 'build', messageID: 'msg_1', id: 'call_2', input: { command: 'make' }, status: 'error', error: { message: 'exit 2' } },
    opts,
  );
  assert.equal(failed.activity, 'Done: Running make');

  const [idle] = fromOpencodeV2('event', { id: 'evt_1', type: 'session.status', created: 1, data: { sessionID: SESSION, status: { type: 'idle' } } }, opts);
  assert.equal(idle.status, 'idle');
  const [asked] = fromOpencodeV2('event', { id: 'evt_2', type: 'permission.asked', created: 1, data: { id: 'per_1', sessionID: SESSION, permission: 'edit' } }, opts);
  assert.equal(asked.status, 'waiting');
});

test('prompts stay off the floor unless sharing is on', () => {
  const v1 = (sharePrompts) =>
    fromOpencodeV1('chat.message', { sessionID: SESSION, agent: 'build' }, { message: {}, parts: [{ type: 'text', text: 'rotate the prod API key' }] }, { ...opts, sharePrompts })[0];
  const v2 = (sharePrompts) =>
    fromOpencodeV2('session.prompt', { sessionID: SESSION, messageID: 'msg_1', prompt: { text: 'rotate the prod API key' }, delivery: 'steer' }, { ...opts, sharePrompts })[0];
  for (const map of [v1, v2]) {
    const hidden = map(false);
    assert.equal(hidden.status, 'thinking');
    assert.equal(hidden.activity, 'Working on your request');
    assert.ok(!JSON.stringify(hidden).includes('prod API key'));
    assert.equal(map(true).activity, 'Asked: rotate the prod API key');
  }
});

test('two sessions started in the same moment get their own desks', () => {
  // opencode ids share a time-ordered prefix; only the random tail differs.
  assert.notEqual(opencodeAgentId('ses_8e1f2a3b4c5dK9xQwErTyUiOpA'), opencodeAgentId('ses_8e1f2a3b4c5dZz1Yx2Wv3Ut4'));
});

/** The parts of the OpenCode 2 plugin context the plugin uses, recording what it registers. */
function fakeOpencode2(busEvents) {
  const hooks = {};
  const register = (domain) => async (name, callback) => {
    hooks[`${domain}.${name}`] = callback;
  };
  const subscriptions = [];
  return {
    hooks,
    subscriptions,
    ctx: {
      location: { directory: '/w/api' },
      tool: { hook: register('tool') },
      session: { hook: register('session') },
      event: {
        async *subscribe(options) {
          subscriptions.push(options);
          yield* busEvents;
        },
      },
    },
  };
}

test('the opencode 2 setup registers observing hooks and the event stream', async () => {
  const posted = [];
  const plugin = createPlugin({ post: async (events) => void posted.push(...events) });
  const { ctx, hooks, subscriptions } = fakeOpencode2([{ id: 'evt_1', type: 'session.idle', created: 1, data: { sessionID: SESSION } }]);

  const cleanup = await plugin.setup(ctx);
  assert.deepEqual(Object.keys(hooks).sort(), ['session.prompt', 'tool.execute.after', 'tool.execute.before']);
  const toolEvent = { tool: 'read', sessionID: SESSION, agent: 'build', messageID: 'msg_1', id: 'call_1', input: { filePath: '/w/api/a.ts' } };
  assert.equal(hooks['tool.execute.before'](toolEvent), undefined, 'the hook returns at once');
  assert.deepEqual(toolEvent.input, { filePath: '/w/api/a.ts' }, 'tool input is never changed');
  hooks['session.prompt']({ sessionID: SESSION, messageID: 'msg_1', prompt: { text: 'secret plan' }, delivery: 'steer' });
  hooks['tool.execute.before']({ tool: 'read' });
  await new Promise(setImmediate);

  // The event stream and the hooks run independently, so only the set of posts is fixed.
  assert.deepEqual(
    posted.map((e) => [e.agent, e.team, e.status ?? e.type, e.activity]).sort(),
    [
      [opencodeAgentId(SESSION), 'api', 'idle', 'Waiting for you'],
      [opencodeAgentId(SESSION), 'api', 'thinking', 'Working on your request'],
      [opencodeAgentId(SESSION), 'api', 'tool', 'Reading a.ts'],
    ],
  );
  assert.ok(subscriptions[0].types.includes('session.status'));
  assert.equal(subscriptions[0].signal.aborted, false);
  cleanup();
  assert.equal(subscriptions[0].signal.aborted, true);
});

async function tempHome() {
  return realpath(await mkdtemp(join(tmpdir(), 'agent-floor-opencode-')));
}

async function withFloor(token, fn) {
  const floor = await startServer({ port: 0, log: () => {}, token });
  try {
    await fn(`http://127.0.0.1:${floor.server.address().port}`);
  } finally {
    await floor.close();
  }
}

async function loadPlugin(home, env) {
  // desktop/state.cjs reads AGENT_FLOOR_HOME when it loads, so the plugin runs in a child process.
  const script = `
    const { createPlugin } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'adapters/opencode-plugin.mjs')).href)});
    const hooks = await createPlugin().server({ directory: '/w/api' });
    await hooks['chat.message']({ sessionID: ${JSON.stringify(SESSION)} }, { parts: [{ type: 'text', text: 'rotate the prod API key' }] });
    await hooks['tool.execute.before']({ tool: 'bash', sessionID: ${JSON.stringify(SESSION)}, callID: 'c1' }, { args: { command: 'npm test' } });
  `;
  // The posts are fire-and-forget, but their open requests keep the child alive until the floor has answered.
  return run(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH, HOME: home, AGENT_FLOOR_HOME: home, ...env } });
}

test('the opencode plugin posts with the floor token and keeps prompts private', async () => {
  const home = await tempHome();
  await writeFile(join(home, 'token'), 'plugin-token\n', { mode: 0o600 });
  await withFloor('plugin-token', async (base) => {
    await loadPlugin(home, { AGENT_FLOOR_URL: base });
    const state = await (await fetch(`${base}/state`)).json();
    const agent = state.agents[opencodeAgentId(SESSION)];
    assert.ok(agent, 'the token was accepted');
    assert.equal(agent.activity, 'Running npm test');
    assert.ok(!JSON.stringify(state).includes('prod API key'));
  });
});

test('the opencode plugin shrugs off a floor that is not running', async () => {
  const home = await tempHome();
  const started = Date.now();
  await loadPlugin(home, { AGENT_FLOOR_URL: 'http://127.0.0.1:9' });
  assert.ok(Date.now() - started < 5000);
});

const setup = (home, ...args) =>
  run(process.execPath, [CLI, 'setup', 'opencode', ...args], { cwd: home, env: { PATH: process.env.PATH, HOME: home, AGENT_FLOOR_HOME: join(home, '.agent-floor') } });

test('setup opencode prints the plugin, and --write installs it privately with a backup', async () => {
  const home = await tempHome();
  const path = join(home, '.config/opencode/plugins/agent-floor.js');
  const pluginUrl = pathToFileURL(join(ROOT, 'adapters/opencode-plugin.mjs')).href;

  const dry = await setup(home);
  assert.match(dry.stdout, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(dry.stdout.includes(pluginUrl));
  assert.ok(!dry.stdout.includes('npx'));
  await assert.rejects(stat(path), { code: 'ENOENT' });

  await setup(home, '--write');
  const written = await readFile(path, 'utf8');
  assert.ok(written.includes(pluginUrl));
  assert.ok(!written.includes('npx'));
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  const plugin = (await import(pathToFileURL(path).href)).default;
  assert.equal(plugin.id, 'agent-floor');
  assert.equal(typeof plugin.setup, 'function');
  assert.equal(typeof plugin.server, 'function');

  assert.match((await setup(home, '--write')).stdout, /already has the current Agent Floor plugin/);
  await writeFile(path, '// an older copy\n');
  await setup(home, '--write');
  const backups = (await readdir(join(home, '.config/opencode/plugins'))).filter((f) => f.endsWith('.bak'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(home, '.config/opencode/plugins', backups[0]), 'utf8'), '// an older copy\n');

  await setup(home, '--write', '--project');
  assert.equal(await readFile(join(home, '.opencode/plugins/agent-floor.js'), 'utf8'), written);
});

test('setup opencode follows XDG_CONFIG_HOME', async () => {
  const home = await tempHome();
  const xdg = join(home, 'xdg');
  await run(process.execPath, [CLI, 'setup', 'opencode', '--write'], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: xdg, AGENT_FLOOR_HOME: join(home, '.agent-floor') },
  });
  assert.ok((await readFile(join(xdg, 'opencode/plugins/agent-floor.js'), 'utf8')).includes('createPlugin'));
});
