import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../bin/agent-floor.mjs', import.meta.url).pathname;
const HOUR = 3600_000;

async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

/** A throwaway home and port, so the CLI never touches the real ~/.agent-floor or a running floor. */
async function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'agent-floor-cli-'));
  const env = { ...process.env, HOME: home, AGENT_FLOOR_HOME: join(home, '.agent-floor'), AGENT_FLOOR_PORT: String(await freePort()), AGENT_FLOOR_AUTOLAUNCH: '0' };
  delete env.AGENT_FLOOR_URL;
  delete env.AGENT_FLOOR_APP;
  return { env, snoozeFile: join(env.AGENT_FLOOR_HOME, 'snoozed-until') };
}

function run(env, ...args) {
  const child = spawn(process.execPath, [CLI, ...args], { env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const done = new Promise((r) => child.on('exit', (code) => r({ code, stdout, stderr })));
  return { child, done, output: () => stdout };
}

const snoozedFor = (file) => (Number(readFileSync(file, 'utf8')) - Date.now()) / HOUR;

test('quiet pauses auto-open for 6 hours by default, or the hours given', async () => {
  const { env, snoozeFile } = await sandbox();
  const byDefault = await run(env, 'quiet').done;
  assert.equal(byDefault.code, 0);
  assert.ok(Math.abs(snoozedFor(snoozeFile) - 6) < 0.01);
  assert.match(byDefault.stdout, /6 hours/);

  const custom = await run(env, 'quiet', '1').done;
  assert.equal(custom.code, 0);
  assert.ok(Math.abs(snoozedFor(snoozeFile) - 1) < 0.01);
  assert.match(custom.stdout, /1 hour\b/);
});

test('quiet refuses hours that are not a number above 0', async () => {
  const { env, snoozeFile } = await sandbox();
  for (const bad of ['abc', '0', '-2']) {
    const { code, stderr } = await run(env, 'quiet', bad).done;
    assert.equal(code, 1, bad);
    assert.match(stderr, /Usage: agent-floor quiet/);
  }
  assert.equal(existsSync(snoozeFile), false);
});

test('stop says so when no floor is running, and still pauses auto-open', async () => {
  const { env, snoozeFile } = await sandbox();
  const { code, stdout } = await run(env, 'stop').done;
  assert.equal(code, 0);
  assert.match(stdout, new RegExp(`No floor is running at http://127\\.0\\.0\\.1:${env.AGENT_FLOOR_PORT}`));
  assert.ok(Math.abs(snoozedFor(snoozeFile) - 6) < 0.01);
});

test('stop shuts down a floor started with agent-floor start', { timeout: 10_000 }, async () => {
  const { env, snoozeFile } = await sandbox();
  const floor = run(env, 'start');
  try {
    while (!floor.output().includes('Agent Floor is live')) await new Promise((r) => setTimeout(r, 20));
    const stopped = await run(env, 'stop').done;
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.match(stopped.stdout, /Stopped the floor/);
    const { code, stdout } = await floor.done;
    assert.equal(code, 0);
    assert.match(stdout, /Agent Floor stopped\./);
    assert.ok(Math.abs(snoozedFor(snoozeFile) - 6) < 0.01);
  } finally {
    floor.child.kill();
  }
});
