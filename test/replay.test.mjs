import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, createState, normalizeEvent, removeAgents } from '../shared/protocol.js';
import { Recording } from '../shared/replay.js';

const ev = (raw) => normalizeEvent(raw);

function recorded(start = 1000) {
  const live = createState();
  applyEvent(live, ev({ type: 'join', agent: 'lead', team: 'Core', account: 'work', ts: start }));
  const rec = new Recording(live, start);
  const entries = [
    { at: start + 100, event: ev({ type: 'tool', agent: 'lead', tool: 'Bash', activity: 'Running tests', ts: start + 100 }) },
    { at: start + 200, event: ev({ type: 'join', agent: 'helper', parent: 'lead', role: 'Explore', name: 'Lia', ts: start + 200 }) },
    { at: start + 300, event: ev({ type: 'message', agent: 'helper', text: 'Found it', status: 'done', ts: start + 300 }) },
    { at: start + 400, removed: ['helper'] },
  ];
  for (const e of entries) {
    if (e.event) applyEvent(live, e.event);
    else removeAgents(live, e.removed);
    rec.record(e);
  }
  return { live, rec, start };
}

test('removeAgents drops agents and empty teams, and reports what it removed', () => {
  const s = createState();
  applyEvent(s, ev({ type: 'join', agent: 'a', team: 'One' }));
  applyEvent(s, ev({ type: 'join', agent: 'b', team: 'Two' }));
  assert.deepEqual(removeAgents(s, ['b', 'ghost']), ['b']);
  assert.ok(s.agents.a && !s.agents.b);
  assert.deepEqual(Object.keys(s.teams), ['one']);
});

test('seeking rebuilds the floor as it was at that moment', () => {
  const { live, rec, start } = recorded();
  rec.seek(start + 150);
  assert.equal(rec.view.agents.lead.tool, 'Bash');
  assert.equal(rec.view.agents.helper, undefined, 'the helper has not arrived yet');

  rec.seek(start + 250);
  assert.equal(rec.view.agents.helper.name, 'Lia', 'names come back as the floor gave them');
  assert.equal(rec.view.agents.lead.account, 'work', 'the account survives replay');

  rec.seek(start + 1000);
  assert.deepEqual(Object.keys(rec.view.agents), Object.keys(live.agents));
  assert.deepEqual(rec.view.agents.lead, live.agents.lead);
  assert.notEqual(rec.view, live, 'replay never touches the live state');
});

test('playing forward applies entries in order and returns their effects', () => {
  const { rec, start } = recorded();
  assert.equal(rec.seek(start - 5000), start, 'seeking before the start lands on the start');
  const step = rec.advance(start + 250);
  assert.equal(step.applied, 2);
  assert.ok(step.effects.some((e) => e.kind === 'message' && e.from === 'lead' && e.to === 'helper'), 'the briefing flies again');
  assert.equal(rec.advance(start + 250).applied, 0, 'nothing new at the same moment');
  rec.advance(start + 400);
  assert.equal(rec.view.agents.helper, undefined, 'removals replay too');
});

test('the recording keeps at most its entry limit and folds the rest into the start', () => {
  const live = createState();
  const rec = new Recording(live, 0, { keepEntries: 3 });
  for (let i = 1; i <= 10; i++) rec.record({ at: i, event: ev({ type: 'join', agent: `a${i}`, team: 'T', ts: i }) });
  assert.equal(rec.entries.length, 3);
  assert.equal(rec.start, 7);
  rec.seek(0);
  assert.equal(Object.keys(rec.view.agents).length, 7, 'folded entries are part of the starting state');
});

test('the recording drops entries older than its time limit', () => {
  const rec = new Recording(createState(), 0, { keepMs: 1000 });
  rec.record({ at: 100, event: ev({ type: 'join', agent: 'old', ts: 100 }) });
  rec.record({ at: 5000, event: ev({ type: 'join', agent: 'new', ts: 5000 }) });
  assert.deepEqual(rec.entries.map((e) => e.event.agent), ['new']);
  assert.equal(rec.start, 100);
});

test('a paused view moves forward when its moment falls off the start', () => {
  const rec = new Recording(createState(), 0, { keepEntries: 2 });
  rec.record({ at: 1, event: ev({ type: 'join', agent: 'a', ts: 1 }) });
  rec.seek(0);
  for (let i = 2; i <= 5; i++) rec.record({ at: i, event: ev({ type: 'join', agent: `a${i}`, ts: i }) });
  assert.equal(rec.entries.length, 2, 'still bounded while someone is replaying');
  assert.deepEqual(Object.keys(rec.view.agents).sort(), ['a', 'a2', 'a3']);
  rec.advance(5);
  assert.deepEqual(Object.keys(rec.view.agents).sort(), ['a', 'a2', 'a3', 'a4', 'a5']);
});
