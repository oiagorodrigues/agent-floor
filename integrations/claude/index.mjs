import { homedir } from 'node:os';
import { accountLabel, claudeConfigDirFor, claudeSetupTargets } from './accounts.mjs';
import { UsageError, isAgentFloorHook, listAt, parseJson, writeHooks } from '../cli.mjs';

/**
 * Claude Code settings: drops every earlier Agent Floor hook (in any event and
 * matcher group), keeps all other hooks and settings as they are, then appends ours.
 */
export function mergeClaudeHooks(settings, ours) {
  const current = settings.hooks ?? {};
  const hooks = {};
  for (const event of Object.keys(current)) {
    const kept = listAt(current, event).flatMap((group) => {
      const inner = Array.isArray(group?.hooks) ? group.hooks : [];
      const left = inner.filter((h) => !isAgentFloorHook(h));
      if (left.length === inner.length) return [group];
      return left.length ? [{ ...group, hooks: left }] : [];
    });
    if (kept.length) hooks[event] = kept;
  }
  for (const [event, groups] of Object.entries(ours)) hooks[event] = [...(hooks[event] ?? []), ...groups];
  return { ...settings, hooks };
}

function claudeHooks(command) {
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop', 'PreCompact', 'SessionEnd'];
  const hooks = {};
  for (const e of events) {
    const entry = { hooks: [{ type: 'command', command, timeout: 5 }] };
    if (e === 'PreToolUse' || e === 'PostToolUse') entry.matcher = '*';
    hooks[e] = [entry];
  }
  return hooks;
}

function claudeAccount(cwd, installedFor, settings) {
  const home = homedir();
  const dir = claudeConfigDirFor({ installedFor, envDir: process.env.CLAUDE_CONFIG_DIR, cwd, settings, home });
  return accountLabel(dir, settings, home);
}

/** @type {import('../index.mjs').Integration} */
export default {
  usage: [{ args: '--settings <file> [--config-dir <dir>] [--write]', note: 'for claude --settings' }],

  async hook({ flags, readStdin, send, config, rooms }) {
    const { fromClaude } = await import('./adapter.mjs');
    const input = parseJson(await readStdin());
    const account = claudeAccount(input?.cwd, flags['config-dir'], config());
    await send(fromClaude(input, { account, rooms: rooms() }));
  },

  async setup({ flags: f, hookCommand, config }) {
    if (f.settings === true || f['config-dir'] === true) throw new UsageError();
    const targets = claudeSetupTargets({
      settingsFile: f.settings,
      project: f.project,
      configDir: f['config-dir'],
      cwd: process.cwd(),
      settings: config(),
      home: homedir(),
    }).map(({ path, configDir }) => ({ path, hooks: claudeHooks(hookCommand('claude', configDir)) }));
    for (const { path, hooks } of targets) {
      if (!f.write) {
        console.log(`Add this to ${path} (or rerun with --write to merge it for you):\n`);
        console.log(JSON.stringify({ hooks }, null, 2) + '\n');
        continue;
      }
      await writeHooks(path, (settings) => mergeClaudeHooks(settings, hooks), 'Agent Floor will open by itself the next time a Claude Code session starts.');
    }
  },
};
