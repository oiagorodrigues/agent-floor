import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.mjs';

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
