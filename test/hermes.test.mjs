import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEvent, createState, normalizeEvent } from '../shared/protocol.js';
import { fromHermes } from '../adapters/hermes.mjs';
import { appendYamlHooks, HooksSectionExists } from '../lib/settings.mjs';
import { startServer } from '../server/index.mjs';

const CLI = resolve(fileURLToPath(import.meta.url), '../../bin/agent-floor.mjs');
const run = (state, raw) => applyEvent(state, normalizeEvent(raw));

// Payloads follow the shell-hook wire protocol in the Hermes docs:
// https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks#json-wire-protocol
// Session ids use Hermes' own `YYYYMMDD_HHMMSS_<hex>` shape (hermes_state_ids.py).
const SESSION = '20261112_153012_a1b2c3';
const payload = (hook_event_name, fields = {}) => ({
  hook_event_name,
  tool_name: null,
  tool_input: null,
  session_id: SESSION,
  cwd: '/home/user/project',
  profile: 'default',
  extra: {},
  ...fields,
});
const toolCall = (hook_event_name) =>
  payload(hook_event_name, {
    tool_name: 'terminal',
    tool_input: { command: 'rm -rf /' },
    extra: { task_id: 't-1', tool_call_id: 'call_1' },
  });
const llmCall = (user_message) =>
  payload('pre_llm_call', {
    extra: { user_message, conversation_history: [], is_first_turn: true, model: 'anthropic/claude-sonnet-4.6', platform: 'cli' },
  });

test('hermes adapter maps the session lifecycle onto one Hermes desk', () => {
  const s = createState();
  const join = fromHermes(payload('on_session_start', { extra: { model: 'anthropic/claude-sonnet-4.6', platform: 'cli' } }));
  assert.equal(join.length, 1);
  assert.equal(join[0].type, 'join');
  assert.equal(join[0].source, 'hermes');
  assert.equal(join[0].name, 'Hermes');
  assert.equal(join[0].team, 'project');
  for (const ev of join) run(s, ev);
  const id = join[0].agent;

  const pre = fromHermes(toolCall('pre_tool_call'));
  assert.equal(pre[0].type, 'tool');
  assert.equal(pre[0].tool, 'terminal');
  assert.equal(pre[0].agent, id);
  const post = fromHermes({ ...toolCall('post_tool_call'), extra: { result: '{"output": ""}', duration_ms: 12 } });
  assert.equal(post[0].status, 'thinking');

  const turnEnd = fromHermes(payload('on_session_end', { extra: { completed: true, interrupted: false } }));
  assert.equal(turnEnd[0].status, 'idle');
  assert.equal(turnEnd[0].agent, id);

  const finalize = fromHermes(payload('on_session_finalize', { extra: { platform: 'cli' } }));
  assert.equal(finalize[0].type, 'leave');
  assert.equal(finalize[0].agent, id);

  for (const ev of [...pre, ...post, ...turnEnd]) run(s, ev);
  assert.deepEqual(Object.keys(s.agents), [id]);
});

test('hermes sessions started on the same day get their own desks', () => {
  const a = fromHermes(payload('on_session_start', { session_id: '20261112_153012_a1b2c3' }))[0].agent;
  const b = fromHermes(payload('on_session_start', { session_id: '20261112_160455_9f8e7d' }))[0].agent;
  assert.notEqual(a, b);
});

test('hermes adapter ignores events it does not subscribe to and finalize without a session', () => {
  assert.deepEqual(fromHermes(payload('subagent_stop', { session_id: SESSION, extra: { child_status: 'completed' } })), []);
  assert.deepEqual(fromHermes(payload('Stop')), []);
  assert.deepEqual(fromHermes(payload('on_session_finalize', { session_id: '' })), []);
  assert.deepEqual(fromHermes(null), []);
});

test('hermes prompts stay off the floor unless shared', () => {
  const asked = llmCall('my secret plan');
  const hidden = fromHermes(asked, { sharePrompts: false });
  assert.equal(hidden[0].status, 'thinking');
  assert.doesNotMatch(JSON.stringify(hidden), /secret/);
  assert.equal(fromHermes(asked, { sharePrompts: true })[0].activity, 'Asked: my secret plan');

  const multimodal = llmCall([{ type: 'text', text: 'what is in' }, { type: 'image_url', image_url: { url: 'data:x' } }, { type: 'text', text: 'this secret image' }]);
  assert.doesNotMatch(JSON.stringify(fromHermes(multimodal, { sharePrompts: false })), /secret/);
  assert.equal(fromHermes(multimodal, { sharePrompts: true })[0].activity, 'Asked: what is in this secret image');
});

function cli(args, { env = {}, input = '' } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('hook hermes posts with the token, prints nothing and exits 0', async () => {
  const home = await mkdtemp(join(tmpdir(), 'af-hermes-hook-'));
  const token = 'hermes-test-token';
  await writeFile(join(home, 'token'), token, { mode: 0o600 });
  const floor = await startServer({ port: 0, log: () => {}, token });
  const { port } = floor.server.address();
  const env = { HOME: home, AGENT_FLOOR_HOME: home, AGENT_FLOOR_AUTOLAUNCH: '0', AGENT_FLOOR_URL: `http://127.0.0.1:${port}` };
  try {
    const res = await cli(['hook', 'hermes'], { env, input: JSON.stringify(toolCall('pre_tool_call')) });
    assert.deepEqual(res, { code: 0, stdout: '', stderr: '' });
    const state = await (await fetch(`http://127.0.0.1:${port}/state`)).json();
    const agents = Object.values(state.agents);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].source, 'hermes');
  } finally {
    await floor.close();
  }
  // Floor gone, or a payload that is not JSON: still silent and exit 0.
  assert.deepEqual(await cli(['hook', 'hermes'], { env, input: JSON.stringify(toolCall('pre_tool_call')) }), { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(await cli(['hook', 'hermes'], { env, input: 'not json' }), { code: 0, stdout: '', stderr: '' });
});

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'af-hermes-setup-'));
  const env = { HOME: home, AGENT_FLOOR_HOME: join(home, '.agent-floor') };
  return { home, env, config: join(home, '.hermes', 'config.yaml') };
}
const OUR_COMMAND = `"node '${CLI}' hook hermes"`;
const backups = async (dir) => (await readdir(dir)).filter((f) => f.endsWith('.bak'));

test('setup hermes only prints without --write', async () => {
  const { env, config } = await tempHome();
  const res = await cli(['setup', 'hermes'], { env });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /^hooks:$/m);
  assert.ok(res.stdout.includes(`- command: ${OUR_COMMAND}`));
  assert.doesNotMatch(res.stdout, /npx/);
  await assert.rejects(stat(config), { code: 'ENOENT' });
});

test('setup hermes --write creates a private config with every hook pointing at this install', async () => {
  const { env, config } = await tempHome();
  const res = await cli(['setup', 'hermes', '--write'], { env });
  assert.equal(res.code, 0, res.stderr);
  const text = await readFile(config, 'utf8');
  for (const event of ['on_session_start', 'pre_llm_call', 'pre_tool_call', 'post_tool_call', 'on_session_end', 'on_session_finalize'])
    assert.match(text, new RegExp(`^  ${event}:\\n    - command: ${OUR_COMMAND.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\n      timeout: 5$`, 'm'));
  assert.equal((await stat(config)).mode & 0o777, 0o600);

  const again = await cli(['setup', 'hermes', '--write'], { env });
  assert.equal(again.code, 0);
  assert.match(again.stdout, /already has the current Agent Floor hooks/);
  assert.equal(await readFile(config, 'utf8'), text);
  assert.deepEqual(await backups(join(config, '..')), []);
});

test('setup hermes --write appends to an existing config and keeps a private backup', async () => {
  const { env, config } = await tempHome();
  await mkdir(join(config, '..'), { recursive: true });
  const original = 'model:\n  default: anthropic/claude-sonnet-4.6\nhooks_auto_accept: false';
  await writeFile(config, original, { mode: 0o640 });

  const res = await cli(['setup', 'hermes', '--write'], { env });
  assert.equal(res.code, 0, res.stderr);
  const text = await readFile(config, 'utf8');
  assert.ok(text.startsWith(`${original}\n\nhooks:\n`));
  assert.equal((await stat(config)).mode & 0o777, 0o640);
  const [backup] = await backups(join(config, '..'));
  assert.ok(backup, 'backup created');
  assert.equal(await readFile(join(config, '..', backup), 'utf8'), original);
  assert.equal((await stat(join(config, '..', backup))).mode & 0o777, 0o600);
});

test('setup hermes --write refuses a config that already has hooks and prints the snippet', async () => {
  const { env, config } = await tempHome();
  await mkdir(join(config, '..'), { recursive: true });
  const original = 'hooks:\n  pre_tool_call:\n    - matcher: "terminal"\n      command: "~/.hermes/agent-hooks/block-rm-rf.sh"\n';
  await writeFile(config, original, { mode: 0o600 });

  const res = await cli(['setup', 'hermes', '--write'], { env });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /already has a "hooks:" section/);
  assert.ok(res.stderr.includes(`- command: ${OUR_COMMAND}`));
  assert.equal(await readFile(config, 'utf8'), original);
  assert.deepEqual(await backups(join(config, '..')), []);
});

test('setup hermes follows HERMES_HOME', async () => {
  const { home, env } = await tempHome();
  const profile = join(home, '.hermes', 'profiles', 'work');
  const res = await cli(['setup', 'hermes', '--write'], { env: { ...env, HERMES_HOME: profile } });
  assert.equal(res.code, 0, res.stderr);
  assert.match(await readFile(join(profile, 'config.yaml'), 'utf8'), /^hooks:$/m);
  await assert.rejects(stat(join(home, '.hermes', 'config.yaml')), { code: 'ENOENT' });
});

test('appendYamlHooks only recognises a top-level hooks key', () => {
  const block = 'hooks:\n  pre_tool_call: []\n';
  assert.equal(appendYamlHooks(null, block), block);
  assert.equal(appendYamlHooks('# comments only\n', block), `# comments only\n\n${block}`);
  assert.equal(appendYamlHooks('hooks_auto_accept: true\nplugins:\n  hooks: x\n', block), `hooks_auto_accept: true\nplugins:\n  hooks: x\n\n${block}`);
  for (const existing of ['hooks:\n', 'hooks: {}\n', '"hooks":\n', "a: 1\n'hooks' :\n"])
    assert.throws(() => appendYamlHooks(existing, block), HooksSectionExists, existing);
});
