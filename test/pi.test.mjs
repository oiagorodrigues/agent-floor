import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEvent, createState, normalizeEvent } from '../shared/protocol.js';
import { fromPi } from '../integrations/pi/adapter.mjs';
import { mergePiExtensions } from '../integrations/pi/index.mjs';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const EXTENSION = join(root, 'integrations', 'pi', 'agent-floor-pi.js');
const tempDir = async (prefix) => realpath(await mkdtemp(join(tmpdir(), prefix)));

// Event shapes from pi's packages/coding-agent/src/core/extensions/types.ts and docs/extensions.md.
const SESSION_ID = '0199f5a2-7c3e-7b41-9d2a-5c8e1f3a6b07';
const opts = { cwd: '/w/shop', sessionId: SESSION_ID, sharePrompts: false, machine: 'work-laptop' };
const samples = {
  start: { type: 'session_start', reason: 'startup' },
  prompt: { type: 'before_agent_start', messageType: 'user', prompt: 'my secret plan', images: [], systemPrompt: 'You are an expert coding assistant', systemPromptOptions: {} },
  bash: { type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash', args: { command: 'npm test' } },
  edit: { type: 'tool_execution_start', toolCallId: 'call_2', toolName: 'edit', args: { path: 'src/cart.ts', edits: [{ oldText: 'a', newText: 'b' }] } },
  read: { type: 'tool_execution_start', toolCallId: 'call_3', toolName: 'read', args: { path: '/w/shop/README.md', offset: 1, limit: 50 } },
  grep: { type: 'tool_execution_start', toolCallId: 'call_4', toolName: 'grep', args: { pattern: 'TODO', path: 'src' } },
  done: { type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'bash', result: { content: [{ type: 'text', text: 'secret output' }] }, isError: false, durationMs: 1840 },
  failed: { type: 'tool_execution_end', toolCallId: 'call_3', toolName: 'read', result: { content: [] }, isError: true },
  ask: { type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'confirm', title: 'Allow rm -rf?' },
  answered: { type: 'ui_prompt_end' },
  settled: { type: 'agent_settled', aborted: false },
  aborted: { type: 'agent_settled', aborted: true },
  quit: { type: 'session_shutdown', reason: 'quit' },
  reload: { type: 'session_shutdown', reason: 'reload' },
};

test('pi adapter maps a session onto one lead desk', () => {
  const join = fromPi(samples.start, opts)[0];
  assert.deepEqual(join, { type: 'join', agent: 'pi:5c8e1f3a6b07', team: 'shop', source: 'pi', machine: 'work-laptop', name: 'Pi', role: 'Lead', status: 'idle', activity: 'Ready' });

  const tool = (sample) => fromPi(sample, opts)[0];
  assert.deepEqual([tool(samples.bash).type, tool(samples.bash).tool, tool(samples.bash).activity], ['tool', 'bash', 'Running npm test']);
  assert.equal(tool(samples.edit).activity, 'Editing cart.ts');
  assert.equal(tool(samples.read).activity, 'Reading README.md');
  assert.equal(tool(samples.grep).activity, 'Searching for "TODO"');
  assert.equal(tool({ ...samples.bash, toolName: 'deploy', args: {} }).activity, 'Using deploy');

  assert.deepEqual(fromPi(samples.done, opts).map((e) => [e.status, e.activity]), [['thinking', 'Done: bash']]);
  assert.equal(fromPi(samples.failed, opts)[0].activity, 'Failed: read');
  assert.equal(fromPi(samples.ask, opts)[0].status, 'waiting');
  assert.equal(fromPi(samples.answered, { ...opts, idle: true })[0].status, 'idle');
  assert.equal(fromPi(samples.answered, { ...opts, idle: false })[0].status, 'thinking');
  assert.deepEqual(fromPi(samples.settled, opts).map((e) => [e.status, e.activity]), [['idle', 'Waiting for you']]);
  assert.equal(fromPi(samples.aborted, opts)[0].activity, 'Stopped');
  assert.equal(fromPi(samples.quit, opts)[0].type, 'leave');
  assert.deepEqual(fromPi(samples.reload, opts), [], 'a reload keeps the desk');
  assert.deepEqual(fromPi({ type: 'turn_start', turnIndex: 0, timestamp: 1 }, opts), []);
  assert.deepEqual(fromPi(null, opts), []);

  const s = createState();
  for (const sample of Object.values(samples)) for (const ev of fromPi(sample, opts)) applyEvent(s, normalizeEvent(ev));
  assert.deepEqual(Object.keys(s.agents), [join.agent], 'every event lands on the same agent');
});

test('two pi sessions started in the same minute get their own desks', () => {
  const a = fromPi(samples.start, { ...opts, sessionId: '0199f5a2-7c3e-7b41-9d2a-5c8e1f3a6b07' })[0].agent;
  const b = fromPi(samples.start, { ...opts, sessionId: '0199f5a2-7d10-7c02-8e44-0b9d2c7f1e55' })[0].agent;
  assert.notEqual(a, b);
});

test('pi prompts stay off the floor unless shared', () => {
  const hidden = Object.values(samples).flatMap((sample) => fromPi(sample, { ...opts, sharePrompts: false }));
  assert.doesNotMatch(JSON.stringify(hidden), /secret|rm -rf|expert coding/);
  assert.equal(fromPi(samples.prompt, { ...opts, sharePrompts: false })[0].activity, 'Working on your request');
  assert.equal(fromPi(samples.prompt, { ...opts, sharePrompts: true })[0].activity, 'Asked: my secret plan');
  const custom = { type: 'before_agent_start', messageType: 'custom', message: { customType: 'x', content: 'secret note' }, systemPrompt: '' };
  assert.doesNotMatch(JSON.stringify(fromPi(custom, { ...opts, sharePrompts: true })), /secret/);
});

test('pi settings merge keeps other entries, replaces an old Agent Floor entry and is idempotent', () => {
  const settings = {
    defaultModel: 'claude-sonnet-4-5',
    extensions: ['~/mine/guard.ts', '/old/agent-floor/extensions/agent-floor-pi.js', '-/x/agent-floor-pi.js', 'builtin:mcp'],
  };
  const merged = mergePiExtensions(settings, '/app/extensions/agent-floor-pi.js');
  assert.deepEqual(merged, {
    defaultModel: 'claude-sonnet-4-5',
    extensions: ['~/mine/guard.ts', '-/x/agent-floor-pi.js', 'builtin:mcp', '/app/extensions/agent-floor-pi.js'],
  });
  assert.deepEqual(mergePiExtensions(merged, '/app/extensions/agent-floor-pi.js'), merged);
  assert.deepEqual(mergePiExtensions({}, '/app/extensions/agent-floor-pi.js'), { extensions: ['/app/extensions/agent-floor-pi.js'] });
  assert.throws(() => mergePiExtensions({ extensions: 'nope' }, '/a'), /"extensions" is not a list/);
});

function runSetup(home, args) {
  const env = { ...process.env, HOME: home, AGENT_FLOOR_HOME: join(home, '.agent-floor') };
  delete env.PI_CODING_AGENT_DIR;
  const r = spawnSync(process.execPath, [join(root, 'bin', 'agent-floor.mjs'), 'setup', 'pi', ...args], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('setup pi prints without --write and merges into ~/.pi/agent/settings.json with it', async () => {
  const home = await tempDir('agent-floor-pi-home-');
  const dir = join(home, '.pi', 'agent');
  const path = join(dir, 'settings.json');

  const printed = runSetup(home, []);
  assert.match(printed, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(printed.includes(JSON.stringify(EXTENSION)));
  await assert.rejects(stat(path), { code: 'ENOENT' }, 'nothing is written without --write');

  runSetup(home, ['--write']);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { extensions: [EXTENSION] });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.match(runSetup(home, ['--write']), /already loads the Agent Floor extension/);
  assert.deepEqual(await readdir(dir), ['settings.json']);

  const before = JSON.stringify({ theme: 'dark', extensions: ['/old/install/extensions/agent-floor-pi.js', 'mine.ts'] });
  await writeFile(path, before, { mode: 0o600 });
  runSetup(home, ['--write']);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { theme: 'dark', extensions: ['mine.ts', EXTENSION] });
  const backups = (await readdir(dir)).filter((f) => f.endsWith('.bak'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(dir, backups[0]), 'utf8'), before);
  assert.equal((await stat(join(dir, backups[0]))).mode & 0o777, 0o600);
});

test('the pi extension posts mapped events in order with the bearer token', async (t) => {
  const floorHome = await tempDir('agent-floor-pi-token-');
  await writeFile(join(floorHome, 'token'), 'test-token\n', { mode: 0o600 });
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ auth: req.headers.authorization, url: req.url, events: JSON.parse(body) });
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  process.env.AGENT_FLOOR_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.AGENT_FLOOR_HOME = floorHome;
  delete process.env.AGENT_FLOOR_SHARE_PROMPTS;
  const { default: agentFloor } = await import('../integrations/pi/agent-floor-pi.js');

  const handlers = new Map();
  agentFloor({ on: (name, handler) => handlers.set(name, handler) });
  assert.deepEqual([...handlers.keys()].sort(), ['agent_settled', 'before_agent_start', 'session_shutdown', 'session_start', 'tool_execution_end', 'tool_execution_start', 'ui_prompt_end', 'ui_prompt_start']);

  const ctx = { cwd: '/w/shop', sessionManager: { getSessionId: () => SESSION_ID }, isIdle: () => false };
  for (const sample of [samples.start, samples.prompt, samples.bash, samples.done]) {
    assert.equal(handlers.get(sample.type)(sample, ctx), undefined, `${sample.type} does not wait for the floor`);
  }
  await handlers.get('session_shutdown')(samples.quit, ctx);

  assert.ok(received.every((r) => r.auth === 'Bearer test-token' && r.url === '/events'));
  const events = received.flatMap((r) => r.events);
  assert.deepEqual(events.map((e) => e.type), ['join', 'status', 'tool', 'status', 'leave']);
  assert.doesNotMatch(JSON.stringify(events), /secret/);
});

test('a floor that never answers cannot keep pi from exiting', async (t) => {
  const floorHome = await tempDir('agent-floor-pi-hang-');
  await writeFile(join(floorHome, 'token'), 'test-token\n', { mode: 0o600 });
  let requests = 0;
  let open = 0;
  const server = createServer((_req, res) => {
    requests++;
    open++;
    res.on('close', () => open--);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  process.env.AGENT_FLOOR_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.AGENT_FLOOR_HOME = floorHome;
  // A query string loads a second copy of the module, so it reads this test's URL.
  const { default: agentFloor } = await import('../integrations/pi/agent-floor-pi.js?hang');
  const handlers = new Map();
  agentFloor({ on: (name, handler) => handlers.set(name, handler) });
  const ctx = { cwd: '/w/shop', sessionManager: { getSessionId: () => SESSION_ID }, isIdle: () => false };

  handlers.get('session_start')(samples.start, ctx);
  handlers.get('tool_execution_start')(samples.bash, ctx);
  const started = Date.now();
  await handlers.get('session_shutdown')(samples.quit, ctx);
  assert.ok(Date.now() - started < 1500, `shutdown took ${Date.now() - started} ms`);
  for (let i = 0; i < 50 && open > 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(open, 0, 'no request is left open after shutdown');
  assert.equal(requests, 1, 'events queued behind the hung request are dropped');
});
