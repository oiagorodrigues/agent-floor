import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, createState, normalizeEvent } from '../shared/protocol.js';
import { buildLines, linesToText } from '../shared/office-log.js';

function floor(raws) {
  const state = createState();
  const entries = raws.map((raw, i) => {
    const event = normalizeEvent({ ts: 1000 + i * 1000, ...raw });
    const { actor } = applyEvent(state, event);
    return actor !== event.agent ? { at: event.ts, event, actor } : { at: event.ts, event };
  });
  return { state, entries };
}

const time = (ts) => String(ts);

test('the log reads as handoffs, tool calls and calls for attention', () => {
  const { state, entries } = floor([
    { type: 'join', agent: 'lead', team: 'Core', name: 'Ada' },
    { type: 'tool', agent: 'lead', tool: 'Task', activity: 'Briefing Explore' },
    { type: 'join', agent: 'kid', parent: 'lead', name: 'Gus', text: 'Find the bug' },
    { type: 'tool', agent: 'lead', subagent: { key: 'k1', type: 'Agent' }, tool: 'Read', activity: 'Reading cart.ts' },
    { type: 'message', agent: 'kid', to: 'lead', text: 'Report ready', status: 'done' },
    { type: 'status', agent: 'kid', status: 'done', activity: 'Handed back results' },
    { type: 'status', agent: 'lead', status: 'waiting', activity: 'Approve the edit?' },
  ]);
  const lines = buildLines([], entries, state, Infinity);
  assert.deepEqual(
    lines.map((l) => `${l.who}: ${l.text}`),
    ['Ada: Arrived', 'Ada → Gus: Find the bug', 'Gus: Reading cart.ts', 'Gus → Ada: Report ready', 'Ada: Needs you: Approve the edit?'],
  );
  assert.equal(linesToText(lines.slice(0, 1), time), '1000  Ada: Arrived');
});

test('replay shows the server backlog and what happened up to the playhead', () => {
  const { state, entries } = floor([
    { type: 'join', agent: 'lead', team: 'Core', name: 'Ada' },
    { type: 'tool', agent: 'lead', tool: 'Bash', activity: 'Running tests' },
  ]);
  const backlog = [{ at: 1, event: normalizeEvent({ type: 'join', agent: 'early', name: 'Bea', ts: 1 }) }];
  assert.equal(buildLines(backlog, entries, state, Infinity).length, 3);
  assert.deepEqual(
    buildLines(backlog, entries, state, 1000).map((l) => `${l.who}: ${l.text}`),
    ['Bea: Arrived', 'Ada: Arrived'],
  );
});
