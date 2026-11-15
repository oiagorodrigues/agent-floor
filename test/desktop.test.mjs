// Runs desktop/main.cjs under plain node with a stand-in for the electron module,
// so startup can be checked without opening a window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = resolve(fileURLToPath(import.meta.url), '../../desktop/main.cjs');

// Each call the app makes prints one JSON line. Quitting, or loading the floor, ends the run.
const FAKE_ELECTRON = `
const Module = require('node:module');
const log = (type, data = {}) => process.stdout.write(JSON.stringify({ type, ...data }) + '\\n');
const electron = {
  app: {
    setName() {},
    requestSingleInstanceLock: () => true,
    on() {},
    whenReady: () => Promise.resolve(),
    quit() { log('quit'); process.exit(0); },
    dock: { setIcon() {} },
  },
  BrowserWindow: class {
    constructor() { this.webContents = { setWindowOpenHandler() {}, on() {} }; }
    once() {}
    on() {}
    loadURL(url) { log('window', { url }); process.exit(0); }
  },
  Menu: { buildFromTemplate: (template) => template, setApplicationMenu() {} },
  Tray: class { setToolTip() {} setContextMenu() {} on() {} },
  dialog: {
    async showMessageBox({ message, detail, buttons }) {
      log('dialog', { message, detail, buttons });
      return { response: Number(process.env.FAKE_DIALOG_RESPONSE) };
    },
  },
  nativeImage: { createFromBuffer: () => ({ setTemplateImage() {} }) },
  shell: { async openPath(path) { log('openPath', { path }); return ''; }, openExternal() {} },
  nativeTheme: { shouldUseDarkColors: false },
};
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? electron : load.call(this, request, ...rest);
};
`;

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

async function runApp(config, { dialogResponse = 1 } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'af-desktop-')));
  const floorHome = join(home, '.agent-floor');
  await mkdir(floorHome);
  await writeFile(join(floorHome, 'config.json'), JSON.stringify(config));
  const preload = join(home, 'fake-electron.cjs');
  await writeFile(preload, FAKE_ELECTRON);
  const port = await freePort();
  const env = { PATH: process.env.PATH, HOME: home, AGENT_FLOOR_HOME: floorHome, AGENT_FLOOR_PORT: String(port), FAKE_DIALOG_RESPONSE: String(dialogResponse) };
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--require', preload, MAIN], { env, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', fail);
    child.on('close', (code) => {
      const calls = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      done({ code, stderr, calls, configPath: join(floorHome, 'config.json'), port });
    });
  });
}

const OLD_CONFIG = { app: 'desktop', claude: { defaultConfigDir: '~/.claude' } };
const MOVED_CONFIG = { app: 'desktop', agents: { claude: OLD_CONFIG.claude } };

test('the desktop app opens the floor when config.json has the current shape', async () => {
  const { code, stderr, calls, port } = await runApp(MOVED_CONFIG);
  assert.equal(stderr, '');
  assert.equal(code, 0);
  assert.deepEqual(calls, [{ type: 'window', url: `http://127.0.0.1:${port}/?app=1` }]);
});

test('the desktop app refuses the old config shape with the same fix the CLI prints, and opens no floor', async () => {
  const { code, stderr, calls, configPath } = await runApp(OLD_CONFIG);
  assert.equal(stderr, '');
  assert.equal(code, 0);
  const detail = `${configPath}: agent settings now live under "agents". Move "claude" there, so the file reads:\n\n${JSON.stringify(MOVED_CONFIG, null, 2)}`;
  assert.deepEqual(calls, [
    { type: 'dialog', message: 'Agent Floor did not start', detail, buttons: ['Open config.json', 'Quit'] },
    { type: 'quit' },
  ]);
});

test('"Open config.json" in that dialog opens the file before the app quits', async () => {
  const { calls, configPath } = await runApp(OLD_CONFIG, { dialogResponse: 0 });
  assert.deepEqual(
    calls.map(({ type, path }) => (path ? { type, path } : { type })),
    [{ type: 'dialog' }, { type: 'openPath', path: configPath }, { type: 'quit' }],
  );
});
