import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.mjs';
import { NAMES } from '../server/names.mjs';
import { createRecent, RECENT_MAX } from '../server/recent.mjs';
import { fromClaude } from '../adapters/claude.mjs';
import { fromCodex } from '../adapters/codex.mjs';
import { fromCursor } from '../adapters/cursor.mjs';
import { Recording } from '../shared/replay.js';
import { buildLines, linesToText } from '../shared/office-log.js';

const TOKEN = 'test-token';
const auth = { Authorization: `Bearer ${TOKEN}` };

async function withFloor(fn, opts = {}) {
  const floor = await startServer({ port: 0, log: () => {}, token: TOKEN, ...opts });
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

test('hermes, opencode and pi agents get random first names too', () =>
  withFloor(async (base) => {
    const leads = [
      { agent: 'hermes:s1', source: 'hermes', name: 'Hermes' },
      { agent: 'opencode:s1', source: 'opencode', name: 'OpenCode' },
      { agent: 'pi:s1', source: 'pi', name: 'Pi' },
    ];
    await post(base, leads.map((a) => ({ type: 'join', ...a })));
    const given = await names(base);
    for (const a of leads) assert.ok(NAMES.includes(given[a.agent]), `${a.source} gets a first name`);
    assert.equal(new Set(leads.map((a) => given[a.agent])).size, leads.length);
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

/** The first SSE frame of /stream: `{ version, state, base, baseAt, recent }`. */
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

/** What a window that opens now rebuilds (src/core/store.ts replace), played to the end, as it would cross the wire. */
function rebuilt(snap) {
  const rec = Recording.from(snap.base, snap.baseAt, snap.recent);
  rec.seek(Infinity);
  return JSON.parse(JSON.stringify(rec.view));
}

async function until(check) {
  for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(await check(), 'condition never became true');
}

test('the stream snapshot carries recent events, with the names and accounts the floor gave them', () =>
  withFloor(async (base) => {
    await post(base, [
      { type: 'join', agent: 'claude-code:s1', source: 'claude-code', name: 'Claude', account: 'work', team: 'T' },
      { type: 'tool', agent: 'claude-code:s1', source: 'claude-code', name: 'Claude', tool: 'Bash', activity: 'Running tests' },
    ]);
    const snap = await snapshot(base);
    const given = snap.state.agents['claude-code:s1'].name;
    assert.ok(NAMES.includes(given));
    assert.deepEqual(snap.recent.map((e) => e.event.type), ['join', 'tool']);
    assert.ok(snap.recent.every((e) => e.event.name === given), 'buffered events carry the random name, not "Claude"');
    assert.equal(snap.recent[0].event.account, 'work');
    assert.equal(rebuilt(snap).agents['claude-code:s1'].name, given);
    assert.equal(rebuilt(snap).agents['claude-code:s1'].account, 'work');
  }));

test('base plus recent rebuilds the live floor after trims by count and age, sweeps and a reset', () => {
  let clock = 1000;
  return withFloor(
    async (base) => {
      const same = async (why) => {
        const snap = await snapshot(base);
        assert.deepEqual(rebuilt(snap), snap.state, why);
        return snap;
      };
      await post(base, [
        { type: 'join', agent: 'lead', team: 'Core', account: 'work' },
        { type: 'join', agent: 'kid', parent: 'lead', role: 'Explore' },
        { type: 'tool', agent: 'lead', subagent: { key: 'k1', type: 'Explore' }, tool: 'Read', activity: 'Reading cart.ts' },
        { type: 'message', agent: 'kid', to: 'lead', text: 'Report ready', status: 'done' },
        { type: 'task', agent: 'lead', task: 'Ship replay' },
        { type: 'join', agent: 'other', team: 'Docs' },
        { type: 'status', agent: 'other', status: 'working', activity: 'Writing' },
      ]);
      const counted = await same('after a trim by count');
      assert.equal(counted.recent.length, 4);
      assert.ok(counted.base.agents.lead, 'trimmed events live on in the base');

      clock += 5000;
      const aged = await same('after a trim by age');
      assert.deepEqual(aged.recent, []);
      assert.equal(aged.baseAt, 1000);

      await post(base, [{ type: 'leave', agent: 'other', ts: Date.now() - 60_000 }]);
      await until(async () => !(await (await fetch(`${base}/state`)).json()).agents.other);
      const swept = await same('after the sweeper removes an agent');
      assert.deepEqual(swept.recent.at(-1).removed, ['other']);

      await fetch(`${base}/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: '{}' });
      const reset = await same('after a reset');
      assert.deepEqual(reset.recent, []);
      assert.deepEqual(Object.keys(reset.base.agents), []);
      await post(base, [{ type: 'join', agent: 'fresh', team: 'Core' }]);
      await same('after a reset and new events');
    },
    { recent: createRecent({ max: 4, keepMs: 1000, now: () => clock }) },
  );
});

test('a window that connects late can rewind to the oldest buffered moment', () => {
  let clock = 0;
  return withFloor(
    async (base) => {
      for (const agent of ['a', 'b', 'c', 'd', 'e']) {
        clock += 100;
        await post(base, [{ type: 'join', agent, team: 'Core' }]);
      }
      const snap = await snapshot(base);
      const rec = Recording.from(snap.base, snap.baseAt, snap.recent);
      assert.equal(rec.seek(0), 200, 'the oldest moment is the last event folded into the base');
      assert.deepEqual(Object.keys(rec.view.agents), ['a', 'b']);
      rec.seek(350);
      assert.deepEqual(Object.keys(rec.view.agents), ['a', 'b', 'c']);
      assert.deepEqual(
        buildLines(rec.entries, snap.state, Infinity).map((l) => `${l.who}: ${l.text}`),
        ['C: Arrived', 'D: Arrived', 'E: Arrived'],
      );
    },
    { recent: createRecent({ max: 3, now: () => clock }) },
  );
});

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
  recent.add({ type: 'join', agent: 'a', ts: 0 });
  clock = 500;
  recent.add({ type: 'join', agent: 'b', ts: 500 });
  clock = 1200;
  assert.deepEqual(recent.history().recent.map((e) => e.event.agent), ['b'], 'trimmed on read, even with no new events');
  clock = 5000;
  const { base, recent: left } = recent.history();
  assert.deepEqual(left, []);
  assert.deepEqual(Object.keys(base.agents), ['a', 'b']);
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
  const shown = sharePrompts ? 'carry' : 'never hold';
  const mode = sharePrompts ? 'on' : 'off';
  test(`the recent buffer and office log ${shown} prompt text when sharing is ${mode}`, () =>
    withFloor(async (base) => {
      await post(base, conversationEvents(sharePrompts));
      const { state, recent } = await snapshot(base);
      assert.ok(recent.length >= 6);
      const log = linesToText(buildLines(recent, state, Infinity));
      assert.equal(JSON.stringify(recent).includes(SECRET), sharePrompts);
      assert.equal(log.includes(SECRET), sharePrompts);
    }));

  test(`the base state and the whole snapshot ${shown} prompt text when sharing is ${mode}`, () =>
    withFloor(
      async (base) => {
        await post(base, conversationEvents(sharePrompts));
        const snap = await snapshot(base);
        assert.ok(Object.keys(snap.base.agents).length > 0, 'most events were folded into the base');
        assert.equal(JSON.stringify(snap.base).includes(SECRET), sharePrompts);
        if (!sharePrompts) assert.equal(JSON.stringify(snap).includes(SECRET), false);
      },
      { recent: createRecent({ max: 2 }) },
    ));
}
