import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isAgentFloorHook, listAt, parseJson, writeHooks } from '../cli.mjs';

/** Cursor hooks.json: like mergeClaudeHooks, but its entries are hooks themselves rather than matcher groups. */
export function mergeCursorHooks(current, ours) {
  const existing = current.hooks ?? {};
  const hooks = {};
  for (const event of Object.keys(existing)) {
    const kept = listAt(existing, event).filter((h) => !isAgentFloorHook(h));
    if (kept.length) hooks[event] = kept;
  }
  for (const [event, entries] of Object.entries(ours.hooks)) hooks[event] = [...(hooks[event] ?? []), ...entries];
  return { ...current, version: current.version ?? ours.version, hooks };
}

function cursorHooks(command) {
  const names = [
    'beforeSubmitPrompt',
    'afterAgentThought',
    'afterAgentResponse',
    'afterFileEdit',
    'afterShellExecution',
    'afterMCPExecution',
    'subagentStop',
    'stop',
    'sessionEnd',
  ];
  return { version: 1, hooks: Object.fromEntries(names.map((n) => [n, [{ command }]])) };
}

/** @type {import('../index.mjs').Integration} */
export default {
  async hook({ readStdin, send, respond }) {
    const { fromCursor, cursorResponse } = await import('./adapter.mjs');
    const input = parseJson(await readStdin());
    respond(cursorResponse(input?.hook_event_name));
    await send(fromCursor(input));
  },

  async setup({ flags: f, hookCommand }) {
    const config = cursorHooks(hookCommand('cursor'));
    const path = f.project ? resolve('.cursor/hooks.json') : join(homedir(), '.cursor', 'hooks.json');
    if (!f.write) {
      console.log(`Add this to ${path} (or rerun with --write to merge it for you):\n`);
      console.log(JSON.stringify(config, null, 2));
      return;
    }
    await writeHooks(path, (current) => mergeCursorHooks(current, config), 'Agent Floor will open by itself the next time a Cursor agent runs.');
  },
};
