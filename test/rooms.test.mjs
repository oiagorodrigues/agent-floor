import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromClaude } from '../integrations/claude/adapter.mjs';
import { loadRooms, mailTarget, parseRooms, roomForPath, seedEvents } from '../lib/rooms.mjs';
import { applyEvent, createState, normalizeEvent, settlePinned, sweep } from '../shared/protocol.js';
import { startServer } from '../server/index.mjs';

delete process.env.AGENT_FLOOR_ROOMS;
delete process.env.AGENT_FLOOR_TEAM;
delete process.env.AGENT_FLOOR_NAME;

const home = '/Users/me';
const ROOMS = {
  rooms: [
    {
      slug: 'ceo',
      name: 'CEO Office',
      leadName: 'CEO',
      task: 'Judge reports',
      paths: ['~/offices/ceo'],
      roster: [
        { type: 'report-intake', name: 'Intake', job: 'Collect reports', model: 'haiku' },
        { type: 'judge', job: 'Adopt or drop' },
      ],
    },
    {
      slug: 'game',
      name: 'Game',
      paths: ['/srv/game'],
      roster: [
        { type: 'live-ops', name: 'Live Ops', job: 'Health checks', model: 'haiku' },
        { type: 'reporter', name: 'Reporter' },
      ],
    },
    { slug: 'inner', name: 'Inner', paths: ['/srv/game/inner'] },
  ],
  mail: { inbox: '~/offices/ceo/inbox', inboxTo: 'ceo:report-intake', decisions: '~/offices/ceo/decisions', decisionsTo: '{slug}:reporter' },
};
const config = parseRooms(ROOMS, home);
const run = (state, raw) => applyEvent(state, normalizeEvent(raw));
const seeded = (ts = Date.now()) => {
  const s = createState();
  for (const ev of seedEvents(config)) run(s, { ...ev, ts });
  return s;
};
const claude = (s, input) => {
  let effects = [];
  for (const ev of fromClaude(input, { rooms: config })) effects = effects.concat(run(s, ev).effects);
  return effects;
};

test('without a rooms file the adapter sends what it always sent', () => {
  const inputs = [
    { hook_event_name: 'SessionStart', session_id: 's1', cwd: '/srv/game' },
    { hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/srv/game', tool_name: 'Agent', tool_use_id: 'tu_1', tool_input: { subagent_type: 'live-ops' } },
    { hook_event_name: 'PostToolUse', session_id: 's1', cwd: '/srv/game', tool_name: 'Write', tool_input: { file_path: '/Users/me/offices/ceo/inbox/game/r.md' } },
  ];
  for (const input of inputs) {
    const events = fromClaude(input, { rooms: null });
    assert.deepEqual(events, fromClaude(input));
    assert.doesNotMatch(JSON.stringify(events), /roster:/);
  }
  assert.equal(fromClaude(inputs[0], { rooms: null })[0].team, 'game');
  assert.equal(fromClaude(inputs[0], { rooms: null })[0].name, 'Claude');
});

test('a session lands in the room whose folder holds it, deepest folder first', () => {
  assert.equal(roomForPath(config, '/Users/me/offices/ceo')?.slug, 'ceo');
  assert.equal(roomForPath(config, '/srv/game/server/src')?.slug, 'game');
  assert.equal(roomForPath(config, '/srv/game/inner/x')?.slug, 'inner');
  assert.equal(roomForPath(config, '/srv/gamer'), null, 'a longer sibling folder is not inside the room');
  assert.equal(roomForPath(config, '/tmp'), null);

  const [join] = fromClaude({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/Users/me/offices/ceo/notes' }, { rooms: config });
  assert.equal(join.team, 'CEO Office');
  assert.equal(join.name, 'CEO');
  assert.equal(fromClaude({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/tmp/shop' }, { rooms: config })[0].team, 'shop');
});

test('roster desks are never swept, so their room stays', () => {
  const s = seeded(1000);
  assert.equal(s.agents['roster:ceo:report-intake'].activity, 'Collect reports · haiku');
  assert.equal(s.agents['roster:ceo:judge'].name, 'Judge');
  assert.equal(s.teams['ceo-office'].task, 'Judge reports');
  run(s, { type: 'join', agent: 'passer-by', team: 'CEO Office', ts: 1000 });
  assert.deepEqual(sweep(s, 1000 + 3 * 60 * 60_000), ['passer-by']);
  assert.ok(s.agents['roster:game:live-ops'] && s.teams['ceo-office'] && s.teams.game);
});

test('a roster subagent lights up its own desk and goes back to idle', () => {
  const s = seeded();
  const base = { session_id: 'sess5678', cwd: '/srv/game' };
  claude(s, { ...base, hook_event_name: 'SessionStart' });
  const lead = Object.values(s.agents).find((a) => a.role === 'Lead');
  const count = Object.keys(s.agents).length;
  const spawn = { ...base, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'tu_1', tool_input: { subagent_type: 'live-ops', description: 'Check containers' } };
  const desk = s.agents['roster:game:live-ops'];

  for (const round of [1, 2]) {
    const effects = claude(s, spawn);
    assert.equal(desk.status, 'thinking');
    assert.equal(desk.parent, lead.id);
    assert.ok(effects.some((e) => e.kind === 'message' && e.from === lead.id && e.to === desk.id), 'the lead briefs the desk');
    claude(s, { ...base, hook_event_name: 'PreToolUse', agent_id: `ag_${round}`, agent_type: 'live-ops', tool_name: 'Bash', tool_input: { command: 'docker ps' } });
    assert.equal(desk.status, 'working');
    assert.equal(desk.activity, 'Running docker ps');
    assert.equal(Object.keys(s.agents).length, count, `round ${round}: no new character`);
    claude(s, { ...spawn, hook_event_name: 'PostToolUse' });
    assert.equal(desk.status, 'idle');
    assert.equal(desk.activity, 'Health checks · haiku');
    assert.equal(desk.parent, undefined);
    assert.equal(desk.boundKey, undefined);
  }
  assert.equal(desk.name, 'Live Ops', 'events from the session do not rename the desk');

  const other = { session_id: 'sessOther', cwd: '/srv/game/tools' };
  claude(s, { ...other, hook_event_name: 'SessionStart' });
  claude(s, spawn);
  claude(s, { ...spawn, tool_use_id: 'tu_2' });
  claude(s, { ...spawn, ...other, tool_use_id: 'tu_3' });
  const subagentTool = (session, agent_id, command) =>
    claude(s, { ...session, hook_event_name: 'PreToolUse', agent_id, agent_type: 'live-ops', tool_name: 'Bash', tool_input: { command } });
  subagentTool(base, 'ag_a', 'docker ps');
  subagentTool(base, 'ag_b', 'df -h');
  subagentTool(other, 'ag_c', 'uptime');
  assert.equal(Object.keys(s.agents).length, count + 1, 'parallel spawns of one type, from two leads, share the desk');
  assert.equal(desk.activity, 'Running uptime');
  claude(s, { ...spawn, hook_event_name: 'PostToolUse' });
  claude(s, { ...spawn, tool_use_id: 'tu_2', hook_event_name: 'PostToolUse' });
  assert.equal(desk.status, 'working', 'busy until the last overlapping spawn ends');
  claude(s, { ...spawn, ...other, tool_use_id: 'tu_3', hook_event_name: 'PostToolUse' });
  assert.equal(desk.status, 'idle');

  const offRoster = fromClaude({ ...spawn, tool_input: { subagent_type: 'Explore' } }, { rooms: config });
  assert.doesNotMatch(offRoster[1].agent, /^roster:/, 'types off the roster still get a temporary desk');
});

test('a roster desk drops the stage of a finished spawn', () => {
  const s = seeded();
  const base = { session_id: 'sess5678', cwd: '/srv/game' };
  claude(s, { ...base, hook_event_name: 'SessionStart' });
  const spawn = { ...base, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'tu_1', tool_input: { subagent_type: 'live-ops', description: 'Stage 2: check containers' } };
  const desk = s.agents['roster:game:live-ops'];
  claude(s, spawn);
  assert.equal(desk.stage, 'Stage 2');
  claude(s, { ...spawn, hook_event_name: 'PostToolUse' });
  assert.equal(desk.status, 'idle');
  assert.equal(desk.stage, undefined);
});

test('a desk left busy by an interrupted subagent settles back to idle', () => {
  const s = seeded(1000);
  run(s, { type: 'join', agent: 'roster:ceo:judge', parent: 'lead', status: 'thinking', ts: 1000 });
  run(s, { type: 'status', agent: 'roster:ceo:judge', status: 'done', ts: 2000 });
  assert.deepEqual(settlePinned(s, 2000 + 10_000), []);
  for (const ev of settlePinned(s, 2000 + 60_000)) run(s, ev);
  assert.equal(s.agents['roster:ceo:judge'].status, 'idle');
  assert.equal(s.agents['roster:ceo:judge'].spawns, undefined);
  run(s, { type: 'join', agent: 'roster:ceo:judge', parent: 'lead', status: 'working', ts: 3000 });
  assert.deepEqual(settlePinned(s, 3000 + 60_000), [], 'a working desk is left alone');
  assert.equal(settlePinned(s, 3000 + 31 * 60_000).length, 1);
});

test('a report written to a mail folder flies to the desk that handles it', () => {
  assert.deepEqual(mailTarget(config, '/Users/me/offices/ceo/inbox/game/2026-11-12.md'), { to: 'roster:ceo:report-intake', text: '2026-11-12.md' });
  assert.equal(mailTarget(config, '/Users/me/offices/ceo/decisions/game/d.md')?.to, 'roster:game:reporter');
  assert.equal(mailTarget(config, '/Users/me/offices/ceo/decisions/inner/d.md'), null, 'no reporter desk in that room');
  assert.equal(mailTarget(config, '/Users/me/offices/ceo/inbox/unknown/r.md'), null);
  assert.equal(mailTarget(config, '/Users/me/offices/ceo/inbox/r.md'), null, 'files need a room folder');

  const s = seeded();
  const write = { session_id: 's2', cwd: '/srv/game', tool_name: 'Write', tool_input: { file_path: '/Users/me/offices/ceo/inbox/game/r.md' } };
  assert.equal(claude(s, { ...write, hook_event_name: 'PreToolUse' }).filter((e) => e.kind === 'message').length, 0, 'no plane before the file is written');
  const effects = claude(s, { ...write, hook_event_name: 'PostToolUse' });
  assert.ok(effects.some((e) => e.kind === 'message' && e.to === 'roster:ceo:report-intake' && e.text === 'r.md'));
  const edit = claude(s, { ...write, hook_event_name: 'PostToolUse', tool_name: 'Edit' });
  assert.ok(edit.some((e) => e.kind === 'message' && e.to === 'roster:ceo:report-intake'));
  const read = claude(s, { ...write, hook_event_name: 'PostToolUse', tool_name: 'Read' });
  assert.ok(!read.some((e) => e.kind === 'message'));
});

test('an invalid rooms file is reported with the field that is wrong', () => {
  const bad = (json, pattern) => assert.throws(() => parseRooms(json, home), pattern);
  bad([], /must hold a JSON object/);
  bad({}, /"rooms" must be a list/);
  bad({ rooms: [{ name: 'X' }] }, /rooms\[0\]\.slug must be/);
  bad({ rooms: [{ slug: 'Big Room', name: 'X' }] }, /rooms\[0\]\.slug must be/);
  bad({ rooms: [{ slug: 'x' }] }, /rooms\[0\]\.name must be/);
  bad({ rooms: [{ slug: 'x', name: 'X', paths: '/srv' }] }, /rooms\[0\]\.paths must be a list/);
  bad({ rooms: [{ slug: 'x', name: 'X', roster: [{ name: 'No type' }] }] }, /rooms\[0\]\.roster\[0\]\.type/);
  bad({ rooms: [{ slug: 'x', name: 'X', roster: [{ type: 'a' }, { type: 'a' }] }] }, /listed twice/);
  bad({ rooms: [{ slug: 'x', name: 'X', roster: [{ type: 'a', job: 3 }] }] }, /roster\[0\]\.job must be a string/);
  bad({ rooms: [{ slug: 'x', name: 'X', path: ['/srv'] }] }, /rooms\[0\] has an unknown field "path"/);
  bad({ rooms: [{ slug: 'x', name: 'X', roster: [{ type: 'a', Name: 'A' }] }] }, /roster\[0\] has an unknown field "Name"/);
  bad({ room: [] }, /the file has an unknown field "room"/);
  bad({ rooms: [], mail: { inbx: '/in' } }, /mail has an unknown field "inbx"/);
  bad({ rooms: [{ slug: 'x', name: 'X' }, { slug: 'x', name: 'Y' }] }, /two rooms use the slug "x"/);
  bad({ rooms: [{ slug: 'x', name: 'Ops' }, { slug: 'y', name: 'ops' }] }, /share the name/);
  bad({ rooms: [], mail: { inbox: '/in' } }, /mail\.inboxTo must be/);
  bad({ rooms: [], mail: { inboxTo: 'x:a' } }, /mail\.inboxTo needs mail\.inbox/);
  bad({ rooms: [{ slug: 'x', name: 'X' }], mail: { inbox: '/in', inboxTo: 'x:intake' } }, /room "x" has no "intake" desk/);

  const dir = mkdtempSync(join(tmpdir(), 'agent-floor-rooms-'));
  assert.equal(loadRooms(join(dir, 'missing.json'), home), null);
  writeFileSync(join(dir, 'broken.json'), '{nope');
  assert.throws(() => loadRooms(join(dir, 'broken.json'), home), /rooms\.json: not valid JSON/);
});

// ---------------------------------------------------------------- server

const TOKEN = 'test-token';
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };

async function withFloor(floorDir, fn, opts = {}) {
  const logs = [];
  const floor = await startServer({ port: 0, log: (line) => logs.push(line), token: TOKEN, floorDir, home, ...opts });
  try {
    await fn({ base: `http://127.0.0.1:${floor.server.address().port}`, floor, logs });
  } finally {
    await floor.close();
  }
}
const floorWith = (rooms) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-floor-home-'));
  if (rooms !== undefined) writeFileSync(join(dir, 'rooms.json'), typeof rooms === 'string' ? rooms : JSON.stringify(rooms));
  return dir;
};
const getState = async (base) => (await fetch(`${base}/state`)).json();
const post = (base, path, body, h = headers) => fetch(`${base}${path}`, { method: 'POST', headers: h, body: JSON.stringify(body) });

test('without a rooms file the server writes nothing and sweeps as before', async () => {
  const dir = floorWith();
  await withFloor(dir, async ({ base, floor }) => {
    await post(base, '/events', [{ type: 'join', agent: 'a', team: 'T', ts: 1000 }, { type: 'leave', agent: 'a', ts: 1000 }]);
    assert.deepEqual(sweep(floor.state, 1000 + 60_000), ['a']);
    assert.deepEqual(await (await post(base, '/reload', {})).json(), { ok: true, desks: 0 });
  });
  assert.deepEqual(readdirSync(dir), []);
});

test('roster desks are saved owner-only, without activity, and come back after a restart', async () => {
  const dir = floorWith(ROOMS);
  await withFloor(dir, async ({ base }) => {
    const state = await getState(base);
    assert.ok(state.agents['roster:ceo:report-intake'].pinned);
    await post(base, '/events', [
      { type: 'join', agent: 'roster:ceo:judge', parent: 'lead', activity: 'Asked: secret plan', text: 'secret brief' },
      { type: 'task', agent: 'roster:ceo:judge', task: 'secret task' },
    ]);
    assert.equal((await post(base, '/reload', {})).status, 200);
  });
  const file = join(dir, 'state-0.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const text = readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /secret|history/);
  assert.deepEqual(readdirSync(dir).sort(), ['rooms.json', 'state-0.json'], 'no temp file left behind');

  const hue = JSON.parse(text).teams.game.hue;
  writeFileSync(join(dir, 'rooms.json'), '{ half saved');
  await withFloor(dir, async ({ base, logs }) => {
    const state = await getState(base);
    assert.equal(state.agents['roster:game:live-ops'].status, 'idle');
    assert.equal(state.agents['roster:game:live-ops'].activity, 'Health checks · haiku');
    assert.equal(state.teams.game.hue, hue);
    assert.ok(logs.some((l) => /rooms\.json: not valid JSON/.test(l)));
  });
});

test('a desk a hook opened before the rooms file loaded takes its name from the file', async () => {
  const dir = floorWith();
  await withFloor(dir, async ({ base, floor }) => {
    await post(base, '/events', { type: 'join', agent: 'roster:game:live-ops', parent: 'lead', source: 'claude-code', name: 'Live Ops' });
    assert.notEqual(floor.state.agents['roster:game:live-ops'].name, 'Live Ops', 'a hook agent gets a random name');
    writeFileSync(join(dir, 'rooms.json'), JSON.stringify(ROOMS));
    assert.equal((await post(base, '/reload', {})).status, 200);
    const desk = floor.state.agents['roster:game:live-ops'];
    assert.equal(desk.name, 'Live Ops');
    assert.ok(desk.pinned);
  });
});

test('/reload needs the token, JSON and a loopback host, and reports a bad file', async () => {
  const dir = floorWith(ROOMS);
  await withFloor(dir, async ({ base }) => {
    assert.equal((await post(base, '/reload', {}, { 'Content-Type': 'application/json' })).status, 401);
    assert.equal((await post(base, '/reload', {}, { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post(base, '/reload', {}, { 'Content-Type': 'text/plain', Authorization: `Bearer ${TOKEN}` })).status, 415);
    const port = new URL(base).port;
    const forbidden = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/reload', method: 'POST', headers: { ...headers, Host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(forbidden, 403);

    writeFileSync(join(dir, 'rooms.json'), JSON.stringify({ rooms: [ROOMS.rooms[1]] }));
    assert.deepEqual(await (await post(base, '/reload', {})).json(), { ok: true, desks: 2 });
    let state = await getState(base);
    assert.equal(state.agents['roster:ceo:report-intake'].status, 'offline', 'desks no longer listed walk out');
    assert.equal(state.agents['roster:ceo:report-intake'].pinned, undefined);

    writeFileSync(join(dir, 'rooms.json'), JSON.stringify({ rooms: [{ slug: 'x' }] }));
    const bad = await post(base, '/reload', {});
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /rooms\[0\]\.name must be/);
    state = await getState(base);
    assert.ok(state.agents['roster:game:live-ops'].pinned, 'a bad file keeps the current rooms');
  });
});

test('posted events cannot pin an agent, reset a desk or rename it', async () => {
  const dir = floorWith(ROOMS);
  await withFloor(dir, async ({ base, floor }) => {
    await post(base, '/events', [
      { type: 'join', agent: 'squatter', team: 'X', pinned: true, ts: 1000 },
      { type: 'join', agent: 'roster:game:live-ops', parent: 'lead', status: 'working' },
      { type: 'status', agent: 'roster:game:live-ops', pinned: true },
      { type: 'status', agent: 'roster:game:live-ops', name: 'Mallory', role: 'Lead', team: 'Elsewhere', source: 'claude-code' },
    ]);
    const desk = floor.state.agents['roster:game:live-ops'];
    assert.equal(desk.status, 'working', 'only the server can force a desk back to idle');
    assert.equal(desk.spawns, 1);
    assert.deepEqual([desk.name, desk.role, desk.team, desk.source], ['Live Ops', 'live-ops', 'game', 'roster']);
    assert.equal(floor.state.agents.squatter.pinned, undefined);
    assert.ok(sweep(floor.state, 1000 + 3 * 60 * 60_000).includes('squatter'));

    await post(base, '/events', { type: 'reset' });
    assert.ok(floor.state.agents['roster:ceo:report-intake'].pinned, 'a reset puts the roster back');
  });
});
