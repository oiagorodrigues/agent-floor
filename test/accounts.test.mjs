import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountLabel, claudeConfigDirFor, claudeConfigDirs } from '../lib/accounts.mjs';

const home = '/Users/me';
const config = {
  claude: {
    byPath: [
      { path: '~/Workspaces/work', configDir: '~/.claude-work' },
      { path: '~/Workspaces/work/oss', configDir: '~/.claude' },
    ],
  },
};
const dirFor = (args) => claudeConfigDirFor({ config, home, ...args });

test('setup targets the default dir plus every mapped dir, once each', () => {
  assert.deepEqual(claudeConfigDirs(config, home), ['/Users/me/.claude', '/Users/me/.claude-work']);
  assert.deepEqual(claudeConfigDirs({}, home), ['/Users/me/.claude']);
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
  assert.equal(accountLabel('/Users/me/.claude', config, home), null);
  assert.equal(accountLabel('~/.claude-work', config, home), 'work');
  assert.equal(accountLabel('/opt/agents/acme', config, home), 'acme');
});

test('a malformed config is reported, not ignored', () => {
  assert.throws(() => claudeConfigDirs({ claude: { byPath: { path: 'x' } } }, home), /claude\.byPath must be a list/);
});
