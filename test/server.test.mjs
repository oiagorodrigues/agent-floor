import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.mjs';
import { NAMES } from '../server/names.mjs';

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
