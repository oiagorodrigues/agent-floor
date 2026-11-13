import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAgentFloorHook, mergeClaudeHooks, mergeCursorHooks, updateJsonFile } from '../lib/settings.mjs';

const ours = (cmd = "node '/app/bin/agent-floor.mjs' hook claude --config-dir '/h/.claude'") => ({
  PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: 5 }] }],
  Stop: [{ hooks: [{ type: 'command', command: cmd, timeout: 5 }] }],
});
const userHook = { type: 'command', command: '~/.claude/hooks/guard.sh' };

test('recognises every Agent Floor hook command shape', () => {
  for (const command of [
    'agent-floor hook claude',
    'npx -y agent-floor hook claude',
    'node "/old/bin/agent-floor.mjs" hook claude',
    "node '/app/bin/agent-floor.mjs' hook cursor --config-dir '/x'",
  ])
    assert.ok(isAgentFloorHook({ command }), command);
  assert.ok(!isAgentFloorHook({ command: 'echo agent-floor is great' }));
  assert.ok(!isAgentFloorHook(userHook));
});

test('claude merge keeps user hooks and settings, replaces old Agent Floor hooks, and is idempotent', () => {
  const settings = {
    model: 'opus',
    permissions: { allow: ['Bash(ls)'] },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [userHook] },
        { matcher: '*', hooks: [userHook, { type: 'command', command: 'node "/old/bin/agent-floor.mjs" hook claude' }] },
      ],
      SessionEnd: [{ hooks: [{ type: 'command', command: 'npx -y agent-floor hook claude' }] }],
      Notification: [{ hooks: [userHook] }],
    },
    statusLine: { type: 'command', command: 'x' },
  };
  const merged = mergeClaudeHooks(settings, ours());
  assert.deepEqual(Object.keys(merged), Object.keys(settings), 'top-level key order is kept');
  assert.deepEqual(merged.permissions, settings.permissions);
  assert.deepEqual(merged.hooks.PreToolUse, [
    { matcher: 'Bash', hooks: [userHook] },
    { matcher: '*', hooks: [userHook] },
    ...ours().PreToolUse,
  ]);
  assert.equal(merged.hooks.SessionEnd, undefined, 'stale Agent Floor-only events are dropped');
  assert.deepEqual(merged.hooks.Notification, [{ hooks: [userHook] }]);
  assert.deepEqual(merged.hooks.Stop, ours().Stop);
  assert.deepEqual(mergeClaudeHooks(merged, ours()), merged);
  assert.equal(settings.hooks.SessionEnd.length, 1, 'input is not mutated');
});

test('claude merge refuses a malformed hooks section', () => {
  assert.throws(() => mergeClaudeHooks({ hooks: { Stop: 'nope' } }, ours()), /hooks\.Stop is not a list/);
});

test('cursor merge keeps other entries', () => {
  const current = { version: 1, hooks: { stop: [{ command: './mine.sh' }, { command: 'agent-floor hook cursor' }] } };
  const next = mergeCursorHooks(current, { version: 1, hooks: { stop: [{ command: "node '/app/bin/agent-floor.mjs' hook cursor" }] } });
  assert.deepEqual(next.hooks.stop, [{ command: './mine.sh' }, { command: "node '/app/bin/agent-floor.mjs' hook cursor" }]);
});

test('setup cursor --write upgrades old hooks, installs only observing ones and is idempotent', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'agent-floor-cursor-setup-')));
  const cli = fileURLToPath(new URL('../bin/agent-floor.mjs', import.meta.url));
  const env = { ...process.env, HOME: home, AGENT_FLOOR_HOME: join(home, '.agent-floor') };
  const path = join(home, '.cursor', 'hooks.json');
  const guard = { command: './guard.sh' };
  await mkdir(join(home, '.cursor'));
  await writeFile(path, JSON.stringify({ version: 1, hooks: { stop: [{ command: 'agent-floor hook cursor' }], beforeShellExecution: [guard] } }));

  execFileSync(process.execPath, [cli, 'setup', 'cursor', '--write'], { env });
  const first = await readFile(path, 'utf8');
  const { hooks } = JSON.parse(first);
  const ourEvents = Object.keys(hooks).filter((e) => hooks[e].some(isAgentFloorHook));
  for (const e of ['subagentStop', 'sessionEnd', 'stop', 'beforeSubmitPrompt']) assert.ok(ourEvents.includes(e), e);
  for (const e of ['subagentStart', 'preToolUse', 'beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile', 'beforeTabFileRead'])
    assert.ok(!ourEvents.includes(e), `${e} gates a permission`);
  assert.ok(ourEvents.every((e) => hooks[e].filter(isAgentFloorHook).length === 1), 'one Agent Floor entry per hook');
  assert.deepEqual(hooks.beforeShellExecution, [guard]);

  const again = execFileSync(process.execPath, [cli, 'setup', 'cursor', '--write'], { env, encoding: 'utf8' });
  assert.match(again, /already has the current Agent Floor hooks/);
  assert.equal(await readFile(path, 'utf8'), first);
});

async function fixture(content) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'agent-floor-settings-')));
  const path = join(dir, 'settings.json');
  if (content !== undefined) await writeFile(path, content, { mode: 0o600 });
  return { dir, path };
}

const addKey = (s) => ({ ...s, added: true });

test('updateJsonFile writes atomically, keeps permissions and a private backup', async () => {
  const original = JSON.stringify({ keep: 1 });
  const { dir, path } = await fixture(original);
  const { changed, backup } = await updateJsonFile(path, addKey, { now: new Date('2026-01-02T03:04:05.678Z') });
  assert.equal(changed, true);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { keep: 1, added: true });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(backup, join(dir, 'settings.json.agent-floor-2026-01-02T03-04-05-678Z.bak'));
  assert.equal(await readFile(backup, 'utf8'), original);
  assert.equal((await stat(backup)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.tmp')), []);
});

test('updateJsonFile leaves an unchanged file alone', async () => {
  const { dir, path } = await fixture(JSON.stringify({ added: true }, null, 2) + '\n');
  assert.deepEqual(await updateJsonFile(path, addKey), { changed: false, backup: null });
  assert.deepEqual(await readdir(dir), ['settings.json']);
});

test('updateJsonFile creates a missing file as owner-only', async () => {
  const { path } = await fixture();
  await updateJsonFile(path, addKey);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { added: true });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('updateJsonFile never overwrites invalid JSON', async () => {
  const { path } = await fixture('{ "half": ');
  await assert.rejects(updateJsonFile(path, addKey), /is not valid JSON/);
  assert.equal(await readFile(path, 'utf8'), '{ "half": ');
});

test('updateJsonFile aborts when the file changes during the update', async () => {
  const { dir, path } = await fixture('{}');
  const racing = (s) => {
    // Simulates Claude Code saving its settings between our read and our rename.
    writeFileSync(path, '{"fromClaude":true}');
    return addKey(s);
  };
  await assert.rejects(updateJsonFile(path, racing), /changed while Agent Floor was updating it/);
  assert.equal(await readFile(path, 'utf8'), '{"fromClaude":true}');
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.tmp')), []);
});

test('updateJsonFile writes through a symlink and keeps it', async () => {
  const { dir, path: real } = await fixture('{}');
  const link = join(dir, 'linked.json');
  await symlink(real, link);
  await updateJsonFile(link, addKey);
  assert.ok((await lstat(link)).isSymbolicLink());
  assert.deepEqual(JSON.parse(await readFile(real, 'utf8')), { added: true });
});
