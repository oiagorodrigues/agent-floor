import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.mjs';
import { NAMES } from '../server/names.mjs';
import { createRecent, RECENT_MAX } from '../server/recent.mjs';
import { fromClaude } from '../adapters/claude.mjs';
import { fromCodex } from '../adapters/codex.mjs';
import { fromCursor } from '../adapters/cursor.mjs';
import { createState } from '../shared/protocol.js';
import { Recording } from '../shared/replay.js';
import { buildLines, linesToText } from '../shared/office-log.js';

const TOKEN = 'test-token';
const auth = { Authorization: `Bearer ${TOKEN}` };

async function withFloor(fn) {
  const floor = await startServer({ port: 0, log: () => {}, token: TOKEN });
  const { port } = floor.server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await floor.close();
  }
}

test('server accepts events and serves state', () =>
  withFloor(async (base) => {
    const res = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify([{ type: 'join', agent: 'a', team: 'T' }, { type: 'bogus' }]),
    });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { accepted: 1, rejected: 1 });
    const state = await (await fetch(`${base}/state`)).json();
    assert.ok(state.agents.a);

    const bad = await fetch(`${base}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: '{nope' });
    assert.equal(bad.status, 400);

    const simple = await fetch(`${base}/events`, { method: 'POST', headers: { 'Content-Type': 'text/plain', ...auth }, body: '{"type":"join","agent":"x"}' });
    assert.equal(simple.status, 415, 'non-JSON posts are refused');
  }));

test('posts without the right token are refused and change nothing', () =>
  withFloor(async (base) => {
    const body = JSON.stringify({ type: 'join', agent: 'intruder' });
    for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Authorization: TOKEN }]) {
      const res = await fetch(`${base}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
      assert.equal(res.status, 401);
    }
    const reset = await fetch(`${base}/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(reset.status, 401);
    const state = await (await fetch(`${base}/state`)).json();
    assert.equal(state.agents.intruder, undefined);
  }));

const post = (base, events) =>
  fetch(`${base}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify(events) });
const names = async (base) => Object.fromEntries(Object.values((await (await fetch(`${base}/state`)).json()).agents).map((a) => [a.id, a.name]));

test('hook agents get distinct first names that stick for their lifetime', () =>
  withFloor(async (base) => {
    await post(base, [
      ...Array.from({ length: NAMES.length + 3 }, (_, i) => ({ type: 'join', agent: `claude-code:s${i}`, source: 'claude-code', name: 'Claude' })),
      { type: 'join', agent: 'bot-1', source: 'cli', name: 'Deploy Bot' },
    ]);
    const before = await names(base);
    const hookNames = Object.entries(before).filter(([id]) => id.startsWith('claude-code:')).map(([, n]) => n);
    assert.equal(new Set(hookNames).size, NAMES.length + 3, 'no name repeats, even past the list size');
    assert.ok(hookNames.filter((n) => NAMES.includes(n)).length === NAMES.length, 'plain names are used up before numbered ones');
    assert.equal(before['bot-1'], 'Deploy Bot', 'agents from other sources keep their own name');

    await post(base, [{ type: 'status', agent: 'claude-code:s0', source: 'claude-code', name: 'Claude', status: 'working' }]);
    assert.equal((await names(base))['claude-code:s0'], before['claude-code:s0']);
  }));

test('random names can be turned off', async () => {
  const floor = await startServer({ port: 0, log: () => {}, token: TOKEN, randomNames: false });
  const base = `http://127.0.0.1:${floor.server.address().port}`;
  try {
    await post(base, [{ type: 'join', agent: 'claude-code:s1', source: 'claude-code', name: 'Claude' }]);
    assert.equal((await names(base))['claude-code:s1'], 'Claude');
  } finally {
    await floor.close();
  }
});

test('no CORS headers, even for other localhost origins', () =>
  withFloor(async (base) => {
    const origin = 'http://localhost:5555';
    const read = await fetch(`${base}/state`, { headers: { Origin: origin } });
    assert.equal(read.headers.get('access-control-allow-origin'), null);
    const preflight = await fetch(`${base}/events`, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, authorization' },
    });
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  }));

test('shutdown needs JSON and the token, then closes the server', { timeout: 5000 }, async () => {
  let isShutDown = false;
  let shutDown;
  const shutdown = new Promise((r) => (shutDown = r));
  const onShutdown = () => {
    isShutDown = true;
    shutDown();
  };
  const floor = await startServer({ port: 0, log: () => {}, token: TOKEN, onShutdown });
  const base = `http://127.0.0.1:${floor.server.address().port}`;
  try {
    const refused = [
      [{ 'Content-Type': 'application/json' }, 401],
      [{ 'Content-Type': 'application/json', Authorization: 'Bearer wrong' }, 401],
      [{ 'Content-Type': 'text/plain', ...auth }, 415],
    ];
    for (const [headers, status] of refused) {
      const res = await fetch(`${base}/shutdown`, { method: 'POST', headers, body: '{}' });
      assert.equal(res.status, status);
    }
    assert.equal((await fetch(`${base}/health`)).status, 200, 'still up after refused requests');
    assert.equal(isShutDown, false);

    const stream = await fetch(`${base}/stream`);
    const res = await fetch(`${base}/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: '{}' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    await stream.text(); // the server ends open streams as it closes
    await shutdown;
    assert.equal(floor.server.listening, false);
    await assert.rejects(fetch(`${base}/health`));
  } finally {
    await floor.close();
  }
});

test('a reused crew desk keeps its random name', () =>
  withFloor(async (base) => {
    const helper = { parent: 'claude-code:s1', source: 'claude-code', name: 'Researcher', role: 'researcher' };
    await post(base, [
      { type: 'join', agent: 'claude-code:s1', source: 'claude-code', name: 'Claude', role: 'Lead' },
      { type: 'join', agent: 'claude-code:s1:tu1', ...helper, stay: true },
      { type: 'status', agent: 'claude-code:s1:tu1', status: 'done' },
    ]);
    const first = (await names(base))['claude-code:s1:tu1'];
    await post(base, [
      { type: 'join', agent: 'claude-code:s1:tu2', ...helper, stay: true },
      { type: 'message', agent: 'claude-code:s1:tu2', parent: 'claude-code:s1', source: 'claude-code', to: 'claude-code:s1', text: 'Report ready' },
    ]);
    const after = await names(base);
    assert.equal(Object.keys(after).length, 2, 'no second desk');
    assert.equal(after['claude-code:s1:tu1'], first);
  }));

/** The first SSE frame of /stream: `{ version, state, recent }`. */
async function snapshot(base) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/stream`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('\n\n', text.indexOf('data: '))) text += decoder.decode((await reader.read()).value, { stream: true });
  ctrl.abort();
  return JSON.parse(text.split('\n').find((l) => l.startsWith('data: ')).slice(6));
}

test('the stream snapshot carries recent events, with the names and accounts the floor gave them', () =>
  withFloor(async (base) => {
    await post(base, [
      { type: 'join', agent: 'claude-code:s1', source: 'claude-code', name: 'Claude', account: 'work', team: 'T' },
      { type: 'tool', agent: 'claude-code:s1', source: 'claude-code', name: 'Claude', tool: 'Bash', activity: 'Running tests' },
    ]);
    const { state, recent } = await snapshot(base);
    const given = state.agents['claude-code:s1'].name;
    assert.ok(NAMES.includes(given));
    assert.deepEqual(recent.map((e) => e.event.type), ['join', 'tool']);
    assert.ok(recent.every((e) => e.event.name === given), 'buffered events carry the random name, not "Claude"');
    assert.equal(recent[0].event.account, 'work');

    const replay = new Recording(createState(), 0);
    for (const e of recent) replay.record(e);
    replay.seek(Infinity);
    assert.equal(replay.view.agents['claude-code:s1'].name, given);
    assert.equal(replay.view.agents['claude-code:s1'].account, 'work');

    await fetch(`${base}/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: '{}' });
    assert.deepEqual((await snapshot(base)).recent, [], 'reset clears the buffer');
  }));

test('the recent buffer stays bounded by count', () =>
  withFloor(async (base) => {
    const total = RECENT_MAX + 150;
    for (let i = 0; i < total; i += 200) {
      await post(base, Array.from({ length: Math.min(200, total - i) }, (_, j) => ({ type: 'status', agent: 'bot', status: 'working', activity: `step ${i + j}` })));
    }
    const { recent } = await snapshot(base);
    assert.equal(recent.length, RECENT_MAX);
    assert.equal(recent.at(-1).event.activity, `step ${total - 1}`, 'the newest events are the ones kept');
  }));

test('the recent buffer forgets events older than its window', () => {
  let clock = 0;
  const recent = createRecent({ keepMs: 1000, max: 10, now: () => clock });
  recent.add({ type: 'join', agent: 'a' });
  clock = 500;
  recent.add({ type: 'join', agent: 'b' });
  clock = 1200;
  assert.deepEqual(recent.entries().map((e) => e.event.agent), ['b'], 'trimmed on read, even with no new events');
  clock = 5000;
  assert.deepEqual(recent.entries(), []);
});

const SECRET = 'my secret prompt 7f3a';

/** One turn from each adapter in which the user's prompt, the reply or a thought appears. */
function conversationEvents(sharePrompts) {
  const claude = { session_id: 'sess1', cwd: '/x/app' };
  return [
    ...fromClaude({ ...claude, hook_event_name: 'UserPromptSubmit', prompt: SECRET }, { sharePrompts }),
    ...fromClaude({ ...claude, hook_event_name: 'PreToolUse', tool_name: 'Task', tool_use_id: 'tu1', tool_input: { subagent_type: 'Explore', prompt: SECRET } }, { sharePrompts }),
    ...fromCodex({ type: 'agent-turn-complete', 'thread-id': 't1', 'input-messages': [SECRET], 'last-assistant-message': SECRET }, { sharePrompts }),
    ...fromCursor({ hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c1', prompt: SECRET }, { sharePrompts }),
    ...fromCursor({ hook_event_name: 'afterAgentThought', conversation_id: 'c1', text: SECRET }, { sharePrompts }),
    ...fromCursor({ hook_event_name: 'afterAgentResponse', conversation_id: 'c1', text: SECRET }, { sharePrompts }),
  ];
}

for (const sharePrompts of [false, true]) {
  test(`the recent buffer and office log ${sharePrompts ? 'carry' : 'never hold'} prompt text when sharing is ${sharePrompts ? 'on' : 'off'}`, () =>
    withFloor(async (base) => {
      await post(base, conversationEvents(sharePrompts));
      const { state, recent } = await snapshot(base);
      assert.ok(recent.length >= 6);
      const log = linesToText(buildLines(recent, [], state, Infinity));
      assert.equal(JSON.stringify(recent).includes(SECRET), sharePrompts);
      assert.equal(log.includes(SECRET), sharePrompts);
    }));
}
