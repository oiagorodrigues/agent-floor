import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountLabel, claudeConfigDirFor, claudeConfigDirs, claudeSetupTargets } from '../integrations/claude/accounts.mjs';

const home = '/Users/me';
const settings = {
  byPath: [
    { path: '~/Workspaces/work', configDir: '~/.claude-work' },
    { path: '~/Workspaces/work/oss', configDir: '~/.claude' },
  ],
};
const dirFor = (args) => claudeConfigDirFor({ settings, home, ...args });

test('setup targets the default dir plus every mapped dir, once each', () => {
  assert.deepEqual(claudeConfigDirs(settings, home), ['/Users/me/.claude', '/Users/me/.claude-work']);
  assert.deepEqual(claudeConfigDirs({}, home), ['/Users/me/.claude']);
});

test('setup writes to a --settings file only, with the config dir when one is given', () => {
  const targets = (args) => claudeSetupTargets({ cwd: '/repo', settings, home, ...args });
  assert.deepEqual(targets({ settingsFile: 'factory/settings.json' }), [{ path: '/repo/factory/settings.json', configDir: undefined }]);
  assert.deepEqual(targets({ settingsFile: '/etc/run.json', configDir: '~/.claude-work' }), [
    { path: '/etc/run.json', configDir: '/Users/me/.claude-work' },
  ]);
  assert.deepEqual(targets({ project: true }), [{ path: '/repo/.claude/settings.json', configDir: undefined }]);
  assert.deepEqual(targets({}), [
    { path: '/Users/me/.claude/settings.json', configDir: '/Users/me/.claude' },
    { path: '/Users/me/.claude-work/settings.json', configDir: '/Users/me/.claude-work' },
  ]);
});

test('folder rules map cwd to an account, nested rules first, default otherwise', () => {
  assert.equal(dirFor({ cwd: '/Users/me/Workspaces/work/api' }), '/Users/me/.claude-work');
  assert.equal(dirFor({ cwd: '/Users/me/Workspaces/work' }), '/Users/me/.claude-work');
  assert.equal(dirFor({ cwd: '/Users/me/Workspaces/work/oss/lib' }), '/Users/me/.claude');
  assert.equal(dirFor({ cwd: '/Users/me/Workspaces/workshop' }), '/Users/me/.claude', 'prefix of a folder name is not a match');
  assert.equal(dirFor({ cwd: '/tmp' }), '/Users/me/.claude');
  assert.equal(dirFor({}), '/Users/me/.claude');
});

test('the installed dir beats CLAUDE_CONFIG_DIR, which beats folder rules', () => {
  const cwd = '/Users/me/Workspaces/work/api';
  assert.equal(dirFor({ cwd, envDir: '/Users/me/.claude' }), '/Users/me/.claude');
  assert.equal(dirFor({ cwd: '/tmp', envDir: '/Users/me/.claude-work', installedFor: '/Users/me/.claude' }), '/Users/me/.claude');
});

test('labels name the non-default accounts only', () => {
  assert.equal(accountLabel('/Users/me/.claude', settings, home), null);
  assert.equal(accountLabel('~/.claude-work', settings, home), 'work');
  assert.equal(accountLabel('/opt/agents/acme', settings, home), 'acme');
});

test('a malformed config is reported, not ignored', () => {
  assert.throws(() => claudeConfigDirs({ byPath: { path: 'x' } }, home), /claude\.byPath must be a list/);
});
