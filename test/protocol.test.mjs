import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, createState, normalizeEvent, sweep } from '../shared/protocol.js';
import { fromClaude } from '../adapters/claude.mjs';
import { fromCodex } from '../adapters/codex.mjs';
import { fromCursor, cursorResponse } from '../adapters/cursor.mjs';

const run = (state, raw) => applyEvent(state, normalizeEvent(raw));

test('any event creates its agent and team', () => {
  const s = createState();
  run(s, { type: 'status', agent: 'a1', team: 'Checkout', status: 'working', activity: 'Editing' });
  assert.equal(s.agents.a1.team, 'checkout');
  assert.equal(s.teams.checkout.name, 'Checkout');
  assert.equal(s.agents.a1.status, 'working');
});

test('rejects junk', () => {
  assert.equal(normalizeEvent({ type: 'nope', agent: 'x' }), null);
  assert.equal(normalizeEvent({ type: 'status' }), null);
  assert.equal(normalizeEvent('hi'), null);
});

test('message emits an effect and creates unknown recipients in the same team', () => {
  const s = createState();
  run(s, { type: 'join', agent: 'lead', team: 't' });
  const { effects } = run(s, { type: 'message', agent: 'lead', to: 'helper', text: 'hi' });
  assert.ok(effects.some((e) => e.kind === 'message' && e.from === 'lead' && e.to === 'helper'));
  assert.equal(s.agents.helper.team, 't');
});

test('helpers inherit their parent team', () => {
  const s = createState();
  run(s, { type: 'join', agent: 'lead', team: 'auth' });
  run(s, { type: 'join', agent: 'kid', parent: 'lead' });
  assert.equal(s.agents.kid.team, 'auth');
});

test('subagent hints bind to the spawned desk', () => {
  const s = createState();
  for (const ev of fromClaude({ hook_event_name: 'PreToolUse', session_id: 'sess1234', cwd: '/x/shop', tool_name: 'Task', tool_use_id: 'tu_1', tool_input: { subagent_type: 'code-reviewer', description: 'Review diff' } }))
    run(s, ev);
  const ids = Object.keys(s.agents);
  assert.equal(ids.length, 2);
  for (const ev of fromClaude({ hook_event_name: 'PreToolUse', session_id: 'sess1234', cwd: '/x/shop', agent_id: 'ag_9', agent_type: 'code-reviewer', tool_name: 'Read', tool_input: { file_path: '/x/shop/a.ts' } }))
    run(s, ev);
  assert.equal(Object.keys(s.agents).length, 2, 'no extra desk');
  const child = Object.values(s.agents).find((a) => a.parent);
  assert.equal(child.activity, 'Reading a.ts');
  assert.equal(child.boundKey, 'ag_9');
});

test('claude adapter maps the main lifecycle', () => {
  const base = { session_id: 'abcdef123', cwd: '/home/me/storefront' };
  assert.equal(fromClaude({ ...base, hook_event_name: 'SessionStart' })[0].type, 'join');
  const tool = fromClaude({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } })[0];
  assert.equal(tool.activity, 'Running npm test');
  assert.equal(tool.team, 'storefront');
  const todo = fromClaude({ ...base, hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'Fix cart', activeForm: 'Fixing cart', status: 'in_progress' }] } });
  assert.equal(todo[1].task, 'Fixing cart');
  assert.equal(fromClaude({ ...base, hook_event_name: 'Stop' })[0].status, 'idle');
  assert.deepEqual(fromClaude(null), []);
});

test('codex notify payload', () => {
  const evs = fromCodex({ type: 'agent-turn-complete', 'thread-id': 't-1', cwd: '/a/api', 'input-messages': ['fix it'], 'last-assistant-message': 'Fixed' });
  assert.equal(evs.at(-1).status, 'idle');
  assert.equal(evs[0].team, 'api');
});

test('prompts, replies and thoughts stay off the floor unless shared', () => {
  const claudePrompt = { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/x/shop', prompt: 'my secret plan' };
  const spawn = { hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/x/shop', tool_name: 'Task', tool_use_id: 'tu_1', tool_input: { subagent_type: 'explorer', prompt: 'secret brief' } };
  const codexTurn = { type: 'agent-turn-complete', 'thread-id': 't-1', cwd: '/a/api', 'input-messages': ['secret ask'], 'last-assistant-message': 'secret answer' };
  const cursorEvents = ['beforeSubmitPrompt', 'afterAgentThought', 'afterAgentResponse'].map((hook_event_name) => ({
    hook_event_name,
    conversation_id: 'c1',
    prompt: 'secret ask',
    text: 'secret thought',
  }));
  const cursorSubagent = { hook_event_name: 'subagentStop', conversation_id: 'c1', subagent_id: 'sub1', subagent_type: 'explore', task: 'secret brief', summary: 'secret findings', status: 'completed' };
  const hidden = [
    ...fromClaude(claudePrompt, { sharePrompts: false }),
    ...fromClaude(spawn, { sharePrompts: false }),
    ...fromCodex(codexTurn, { sharePrompts: false }),
    ...cursorEvents.flatMap((e) => fromCursor(e, { sharePrompts: false })),
    ...fromCursor(cursorSubagent, { sharePrompts: false }),
  ];
  assert.doesNotMatch(JSON.stringify(hidden), /secret/);
  assert.equal(fromClaude(claudePrompt, { sharePrompts: false })[0].status, 'thinking');
  assert.equal(fromCodex(codexTurn, { sharePrompts: false }).at(-1).activity, 'Turn complete');

  assert.equal(fromClaude(claudePrompt, { sharePrompts: true })[0].activity, 'Asked: my secret plan');
  assert.equal(fromClaude(spawn, { sharePrompts: true })[1].text, 'secret brief');
  assert.equal(fromCodex(codexTurn, { sharePrompts: true }).at(-1).activity, 'Replied: secret answer');
  assert.equal(fromCursor(cursorEvents[1], { sharePrompts: true })[0].activity, 'secret thought');
  const sharedSubagent = fromCursor(cursorSubagent, { sharePrompts: true });
  assert.equal(sharedSubagent.find((e) => e.type === 'join').text, 'secret brief');
  assert.equal(sharedSubagent.find((e) => e.type === 'message').text, 'secret findings');
});

test('claude account reaches the lead and its helpers', () => {
  const s = createState();
  const start = { hook_event_name: 'SessionStart', session_id: 's1', cwd: '/x/shop' };
  const spawn = { hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/x/shop', tool_name: 'Task', tool_use_id: 'tu_1', tool_input: { subagent_type: 'explorer' } };
  for (const ev of [...fromClaude(start, { account: 'work' }), ...fromClaude(spawn, { account: 'work' })]) run(s, ev);
  const agents = Object.values(s.agents);
  assert.equal(agents.length, 2);
  assert.ok(agents.every((a) => a.account === 'work'));
  assert.equal(fromClaude(start, { account: null })[0].account, undefined);
});

test('cursor adapter only answers beforeSubmitPrompt', () => {
  const evs = fromCursor({ hook_event_name: 'afterFileEdit', conversation_id: 'c1', workspace_roots: ['/w/site'], file_path: '/w/site/a.md' });
  assert.equal(evs[0].activity, 'Edited a.md');
  assert.equal(cursorResponse('afterFileEdit'), '');
  assert.deepEqual(JSON.parse(cursorResponse('beforeSubmitPrompt')), { continue: true });
});

// Payload shapes follow https://cursor.com/docs/hooks (common fields plus each hook's own).
const cursorCommon = {
  conversation_id: 'conv-1234abcd',
  generation_id: 'gen-1',
  model: 'claude-sonnet',
  cursor_version: '2.4.0',
  workspace_roots: ['/home/me/storefront'],
  user_email: 'me@example.com',
};
const cursorSubagentStop = (over = {}) => ({
  ...cursorCommon,
  hook_event_name: 'subagentStop',
  parent_conversation_id: 'conv-1234abcd',
  subagent_id: 'sub-9f8e7d6c',
  subagent_type: 'explore',
  task: 'Find where checkout totals are computed',
  status: 'completed',
  summary: 'Totals are computed in cart/total.ts',
  modified_files: [],
  ...over,
});

test('cursor subagentStop brings a helper in, reports back and finishes', () => {
  const s = createState();
  for (const ev of fromCursor({ ...cursorCommon, hook_event_name: 'beforeSubmitPrompt', prompt: 'x' }, { sharePrompts: false })) run(s, ev);
  const effects = fromCursor(cursorSubagentStop(), { sharePrompts: false }).flatMap((ev) => run(s, ev).effects);
  const helper = s.agents['cursor:conv1234:sub9f8e7d6c'];
  assert.equal(helper.parent, 'cursor:conv1234');
  assert.equal(helper.team, 'storefront');
  assert.equal(helper.role, 'explore');
  assert.equal(helper.status, 'done');
  assert.equal(s.agents['cursor:conv1234'].status, 'thinking');
  assert.ok(effects.some((e) => e.kind === 'message' && e.from === 'cursor:conv1234' && e.to === helper.id), 'lead briefs the helper');
  assert.ok(effects.some((e) => e.kind === 'message' && e.from === helper.id && e.to === 'cursor:conv1234' && e.text === 'Report ready'));
  assert.equal(Object.keys(s.agents).length, 2);
});

test('cursor subagentStop with an error leaves the helper red', () => {
  const s = createState();
  for (const ev of fromCursor(cursorSubagentStop({ status: 'error', summary: undefined }), { sharePrompts: false })) run(s, ev);
  const helper = s.agents['cursor:conv1234:sub9f8e7d6c'];
  assert.equal(helper.status, 'error');
  assert.equal(helper.activity, 'Stopped with an error');
});

test('cursor subagentStop hangs the helper under parent_conversation_id', () => {
  const evs = fromCursor(cursorSubagentStop({ conversation_id: 'child-7777' }), { sharePrompts: false });
  assert.equal(evs.find((e) => e.type === 'join').parent, 'cursor:conv1234');
  assert.equal(evs.at(-1).agent, 'cursor:conv1234');
});

test('cursor sessionEnd makes the lead leave', () => {
  const evs = fromCursor({
    ...cursorCommon,
    hook_event_name: 'sessionEnd',
    session_id: 'conv-1234abcd',
    reason: 'user_close',
    duration_ms: 45000,
    is_background_agent: false,
    final_status: 'completed',
  });
  assert.deepEqual(
    evs.map((e) => [e.type, e.agent]),
    [['leave', 'cursor:conv1234']],
  );
});

test('cursor hooks never answer a permission decision', () => {
  const permissionHooks = ['beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile', 'beforeTabFileRead', 'subagentStart', 'preToolUse'];
  const installed = ['beforeSubmitPrompt', 'afterAgentThought', 'afterAgentResponse', 'afterFileEdit', 'afterShellExecution', 'afterMCPExecution', 'subagentStop', 'stop', 'sessionEnd'];
  for (const hook of [...permissionHooks, ...installed]) {
    const out = cursorResponse(hook);
    if (!out) continue;
    assert.ok(!('permission' in JSON.parse(out)), `${hook} must not answer a permission`);
  }
  assert.equal(cursorResponse('subagentStart'), '');
});

test('sweep removes departed agents and empty teams', () => {
  const s = createState();
  run(s, { type: 'join', agent: 'a', team: 'x', ts: 1000 });
  run(s, { type: 'leave', agent: 'a', ts: 1000 });
  assert.deepEqual(sweep(s, 1000 + 60_000), ['a']);
  assert.equal(Object.keys(s.teams).length, 0);
});
