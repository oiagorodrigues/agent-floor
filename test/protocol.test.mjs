import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, createState, normalizeEvent, removeAgents, sweep } from '../shared/protocol.js';
import { fromClaude, stageOf } from '../adapters/claude.mjs';
import { crewMode } from '../adapters/common.mjs';
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
  const cursorSubagent = { hook_event_name: 'subagentStop', conversation_id: 'c1', subagent_type: 'explore', task: 'secret brief', description: 'secret label', summary: 'secret findings', status: 'completed' };
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
  assert.equal(fromCursor({ ...cursorSubagent, task: undefined }, { sharePrompts: true }).find((e) => e.type === 'join').text, 'secret label');
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
  transcript_path: '/home/me/.cursor/transcripts/conv-1234abcd.jsonl',
};
const cursorSubagentStop = (over = {}) => ({
  ...cursorCommon,
  hook_event_name: 'subagentStop',
  subagent_type: 'explore',
  status: 'completed',
  task: 'Find where checkout totals are computed',
  description: 'Find checkout totals',
  summary: 'Totals are computed in cart/total.ts',
  duration_ms: 42000,
  message_count: 6,
  tool_call_count: 9,
  loop_count: 0,
  modified_files: [],
  agent_transcript_path: '/home/me/.cursor/transcripts/sub-1.jsonl',
  ...over,
});
const lead = 'cursor:conv1234';
const visit = (payload) => {
  const s = createState();
  const effects = fromCursor(payload, { sharePrompts: false }).flatMap((ev) => run(s, ev).effects);
  return { s, effects, helpers: Object.values(s.agents).filter((a) => a.parent === lead) };
};

test('cursor subagentStop brings a helper in, reports back and finishes', () => {
  const { s, effects, helpers } = visit(cursorSubagentStop());
  assert.equal(helpers.length, 1);
  const [helper] = helpers;
  assert.equal(helper.team, 'storefront');
  assert.equal(helper.role, 'explore');
  assert.equal(helper.status, 'done');
  assert.equal(s.agents[lead].status, 'thinking');
  assert.ok(effects.some((e) => e.kind === 'message' && e.from === lead && e.to === helper.id), 'lead briefs the helper');
  assert.ok(effects.some((e) => e.kind === 'message' && e.from === helper.id && e.to === lead && e.text === 'Report ready'));
});

test('cursor subagentStop with an error leaves the helper red, aborted ends it done', () => {
  const failed = visit(cursorSubagentStop({ status: 'error' })).helpers[0];
  assert.equal(failed.status, 'error');
  assert.equal(failed.activity, 'Stopped with an error');
  const aborted = visit(cursorSubagentStop({ status: 'aborted' })).helpers[0];
  assert.equal(aborted.status, 'done');
  assert.equal(aborted.activity, 'Stopped early');
});

test('cursor subagents get one desk per transcript', () => {
  const s = createState();
  for (const path of ['/t/sub-1.jsonl', '/t/sub-2.jsonl', '/t/sub-1.jsonl'])
    for (const ev of fromCursor(cursorSubagentStop({ agent_transcript_path: path }), { sharePrompts: false })) run(s, ev);
  assert.equal(Object.values(s.agents).filter((a) => a.parent === lead).length, 2);
  assert.doesNotMatch(JSON.stringify(s), /sub-1|transcripts/, 'the transcript path stays off the floor');
});

test('cursor hooks never forward the user email', () => {
  const evs = ['beforeSubmitPrompt', 'afterFileEdit', 'stop', 'sessionEnd'].flatMap((hook_event_name) => fromCursor({ ...cursorCommon, hook_event_name }));
  assert.doesNotMatch(JSON.stringify([...evs, ...fromCursor(cursorSubagentStop(), { sharePrompts: true })]), /me@example\.com/);
});

test('cursor sessionEnd makes the lead leave', () => {
  const evs = fromCursor({
    ...cursorCommon,
    hook_event_name: 'sessionEnd',
    session_id: 'conv-1234abcd',
    reason: 'user_close',
    duration_ms: 45000,
    final_status: 'completed',
  });
  assert.deepEqual(
    evs.map((e) => [e.type, e.agent]),
    [['leave', lead]],
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

const pipe = { session_id: 'sess1234', cwd: '/x/video' };
const spawn = (type, id, description, prompt = 'Do the work') => ({
  ...pipe,
  hook_event_name: 'PreToolUse',
  tool_name: 'Task',
  tool_use_id: id,
  tool_input: { subagent_type: type, description, prompt },
});
const finish = (type, id) => ({ ...spawn(type, id, ''), hook_event_name: 'PostToolUse' });
const feed = (s, input, opts) => fromClaude(input, opts).flatMap((ev) => run(s, ev).effects);
const helpers = (s) => Object.values(s.agents).filter((a) => a.parent);

test('stage numbers in a spawn description label the helper', () => {
  assert.equal(stageOf('Stage 2 - write the script'), 'Stage 2');
  assert.equal(stageOf('run stage #03 checks'), 'Stage 3');
  assert.equal(stageOf('Backstage review', 'staged rollout'), undefined);
  const s = createState();
  feed(s, spawn('trend-researcher', 'tu_1', 'Stage 1 - find trending topics'));
  feed(s, spawn('helper', 'tu_2', 'Look around'));
  assert.deepEqual(helpers(s).map((a) => a.stage), ['Stage 1', undefined]);
});

test('a stage in a hidden prompt stays off the floor', () => {
  const input = spawn('writer', 'tu_1', 'Write the script', 'Stage 4 of the secret plan');
  assert.equal(fromClaude(input, { sharePrompts: false })[1].stage, undefined);
  assert.equal(fromClaude(input, { sharePrompts: true })[1].stage, 'Stage 4');
});

test('an empty stage clears the label', () => {
  const s = createState();
  run(s, { type: 'status', agent: 'a', stage: 'Stage 3' });
  assert.equal(s.agents.a.stage, 'Stage 3');
  run(s, { type: 'status', agent: 'a', activity: 'Still going' });
  assert.equal(s.agents.a.stage, 'Stage 3', 'events without a stage keep it');
  run(s, { type: 'status', agent: 'a', stage: '' });
  assert.equal(s.agents.a.stage, undefined);
});

test('crew mode is off by default, so finished helpers are swept', () => {
  assert.equal(crewMode({}), false);
  assert.equal(crewMode({ AGENT_FLOOR_CREW: '1' }), true);
  const prev = process.env.AGENT_FLOOR_CREW;
  delete process.env.AGENT_FLOOR_CREW;
  try {
    const s = createState();
    feed(s, spawn('researcher', 'tu_1', 'Stage 1'));
    feed(s, finish('researcher', 'tu_1'));
    const [kid] = helpers(s);
    assert.equal(kid.stay, undefined);
    assert.deepEqual(sweep(s, kid.lastSeen + 60_000), [kid.id]);
  } finally {
    if (prev !== undefined) process.env.AGENT_FLOOR_CREW = prev;
  }
});

test('crew mode keeps finished helpers at their desks until the lead leaves', () => {
  const s = createState();
  const crew = { crew: true };
  feed(s, { ...pipe, hook_event_name: 'SessionStart' }, crew);
  feed(s, spawn('researcher', 'tu_1', 'Stage 1'), crew);
  feed(s, finish('researcher', 'tu_1'), crew);
  const [kid] = helpers(s);
  assert.equal(kid.status, 'done');
  assert.deepEqual(sweep(s, kid.lastSeen + 10 * 60_000), [], 'still at its desk');
  const effects = feed(s, { ...pipe, hook_event_name: 'SessionEnd' }, crew);
  assert.ok(effects.some((e) => e.kind === 'leave' && e.agent === kid.id), 'walks out with the lead');
  assert.equal(s.agents[kid.id].status, 'offline');
  assert.equal(sweep(s, kid.lastSeen + 10_000).length, 2);
  assert.deepEqual(s.aliases, {});
});

test('crew mode reuses a finished desk when the same role is spawned again', () => {
  const s = createState();
  const crew = { crew: true };
  feed(s, spawn('frontend-dev', 'tu_a', 'Stage 4 - build the video'), crew);
  feed(s, finish('frontend-dev', 'tu_a'), crew);
  const [first] = helpers(s);
  first.name = 'Mira';
  const effects = feed(s, spawn('frontend-dev', 'tu_b', 'Stage 5 - fix captions'), crew);
  assert.equal(helpers(s).length, 1, 'no second desk');
  assert.equal(first.status, 'thinking');
  assert.equal(first.stage, 'Stage 5');
  assert.equal(first.name, 'Mira', 'the desk keeps its name');
  assert.ok(effects.some((e) => e.kind === 'message' && e.to === first.id), 'briefed again');
  feed(s, { ...pipe, hook_event_name: 'PreToolUse', agent_id: 'ag_2', agent_type: 'frontend-dev', tool_name: 'Bash', tool_input: { command: 'npx remotion render' } }, crew);
  assert.equal(first.activity, 'Running npx remotion render');
  feed(s, finish('frontend-dev', 'tu_b'), crew);
  assert.equal(first.status, 'done');
  assert.equal(helpers(s).length, 1);
});

test('a reused desk drops its old stage when the new spawn names none', () => {
  const s = createState();
  const crew = { crew: true };
  feed(s, spawn('writer', 'tu_a', 'Stage 1 - draft'), crew);
  feed(s, finish('writer', 'tu_a'), crew);
  feed(s, spawn('writer', 'tu_b', 'Polish the draft'), crew);
  const [desk] = helpers(s);
  assert.equal(desk.stage, undefined);
});

test('crew mode opens a second desk while the first of that role is still busy', () => {
  const s = createState();
  const crew = { crew: true };
  feed(s, spawn('reviewer', 'tu_a', 'Review the API'), crew);
  feed(s, spawn('reviewer', 'tu_b', 'Review the UI'), crew);
  assert.equal(helpers(s).length, 2);
});

test('removing a reused desk forgets its aliases, so later events open a fresh desk', () => {
  const s = createState();
  const crew = { crew: true };
  feed(s, spawn('writer', 'tu_a', 'Draft'), crew);
  feed(s, finish('writer', 'tu_a'), crew);
  feed(s, spawn('writer', 'tu_b', 'Redraft'), crew);
  const [desk] = helpers(s);
  assert.equal(Object.keys(s.aliases).length, 1);
  assert.deepEqual(removeAgents(s, [desk.id, 'nobody']), [desk.id]);
  assert.deepEqual(s.aliases, {});
  feed(s, finish('writer', 'tu_b'), crew);
  assert.equal(s.agents[desk.id], undefined, 'the removed desk does not come back');
});
