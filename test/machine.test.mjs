import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, createState, normalizeEvent } from '../shared/protocol.js';
import { fromClaude } from '../integrations/claude/adapter.mjs';
import { fromCodex } from '../integrations/codex/adapter.mjs';
import { fromCursor } from '../integrations/cursor/adapter.mjs';
import { fromOpencodeV2 } from '../integrations/opencode/adapter.mjs';
import { fromPi } from '../integrations/pi/adapter.mjs';

const run = (state, raw) => applyEvent(state, normalizeEvent(raw));

function withMachineEnv(value, fn) {
  const before = process.env.AGENT_FLOOR_MACHINE;
  if (value === undefined) delete process.env.AGENT_FLOOR_MACHINE;
  else process.env.AGENT_FLOOR_MACHINE = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.AGENT_FLOOR_MACHINE;
    else process.env.AGENT_FLOOR_MACHINE = before;
  }
}

const claudeStart = { hook_event_name: 'SessionStart', session_id: 's1', cwd: '/x/shop' };
const claudeSpawn = { hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/x/shop', tool_name: 'Task', tool_use_id: 'tu_1', tool_input: { subagent_type: 'explorer' } };
const codexTurn = { type: 'agent-turn-complete', 'thread-id': 't-1', cwd: '/a/api' };
const codexHook = { hook_event_name: 'SessionStart', session_id: 'c1', cwd: '/a/api' };
const cursorEdit = { hook_event_name: 'afterFileEdit', conversation_id: 'c1', workspace_roots: ['/w/site'], file_path: '/w/site/a.md' };
const opencodeTool = { sessionID: 'ses_1', tool: 'read', input: { filePath: '/w/site/a.md' } };
const piStart = { type: 'session_start' };
const piOpts = { cwd: '/w/site', sessionId: 'pi-session-1' };
const cursorSubagent = { hook_event_name: 'subagentStop', conversation_id: 'c1', workspace_roots: ['/w/site'], subagent_type: 'explore', status: 'completed' };

test('normalizeEvent trims and caps the machine name', () => {
  assert.equal(normalizeEvent({ type: 'join', agent: 'a', machine: '  work   laptop ' }).machine, 'work laptop');
  const long = normalizeEvent({ type: 'join', agent: 'a', machine: 'x'.repeat(80) }).machine;
  assert.equal(long.length, 32);
  assert.ok(long.endsWith('…'));
  assert.equal('machine' in normalizeEvent({ type: 'join', agent: 'a' }), false);
});

test('the reducer keeps the machine when later events leave it out', () => {
  const s = createState();
  run(s, { type: 'join', agent: 'a', machine: 'work-laptop' });
  run(s, { type: 'status', agent: 'a', status: 'working' });
  assert.equal(s.agents.a.machine, 'work-laptop');
  run(s, { type: 'join', agent: 'b' });
  assert.equal(s.agents.b.machine, undefined);
});

test('claude tags the lead and its helpers with AGENT_FLOOR_MACHINE', () => {
  const events = withMachineEnv('work-laptop', () => [...fromClaude(claudeStart), ...fromClaude(claudeSpawn)]);
  const s = createState();
  for (const ev of events) run(s, ev);
  const agents = Object.values(s.agents);
  assert.equal(agents.length, 2);
  assert.ok(agents.every((a) => a.machine === 'work-laptop'));
});

test('codex tags notify and hook events with AGENT_FLOOR_MACHINE', () => {
  withMachineEnv('work-laptop', () => {
    assert.ok(fromCodex(codexTurn).every((e) => e.machine === 'work-laptop'));
    assert.equal(fromCodex(codexHook)[0].machine, 'work-laptop');
  });
});

test('cursor tags its events with AGENT_FLOOR_MACHINE', () => {
  withMachineEnv('work-laptop', () => {
    assert.equal(fromCursor(cursorEdit)[0].machine, 'work-laptop');
  });
});

test('cursor subagents carry the lead machine', () => {
  const events = withMachineEnv('work-laptop', () => fromCursor(cursorSubagent));
  const s = createState();
  for (const ev of events) run(s, ev);
  const agents = Object.values(s.agents);
  assert.equal(agents.length, 2);
  assert.ok(agents.every((a) => a.machine === 'work-laptop'));
});

test('opencode tags its events with AGENT_FLOOR_MACHINE', () => {
  withMachineEnv('work-laptop', () => {
    assert.equal(fromOpencodeV2('tool.execute.before', opencodeTool)[0].machine, 'work-laptop');
  });
});

test('pi tags its events with AGENT_FLOOR_MACHINE', () => {
  withMachineEnv('work-laptop', () => {
    assert.equal(fromPi(piStart, piOpts)[0].machine, 'work-laptop');
  });
});

test('no machine is sent when AGENT_FLOOR_MACHINE is unset or blank', () => {
  for (const value of [undefined, '   ']) {
    const events = withMachineEnv(value, () => [
      ...fromClaude(claudeStart),
      ...fromClaude(claudeSpawn),
      ...fromCodex(codexTurn),
      ...fromCodex(codexHook),
      ...fromCursor(cursorEdit),
      ...fromCursor(cursorSubagent),
      ...fromOpencodeV2('tool.execute.before', opencodeTool),
      ...fromPi(piStart, piOpts),
    ]);
    assert.ok(events.every((e) => e.machine === undefined));
  }
});
