import { homedir } from 'node:os';
import { join } from 'node:path';
import { updateTextFile } from '../../lib/settings.mjs';
import { SetupError, parseJson } from '../cli.mjs';

/** Thrown when a YAML config already has a top-level `hooks:` key that Agent Floor would have to edit. */
export class HooksSectionExists extends Error {}

const YAML_HOOKS_KEY = /^["']?hooks["']?[ \t]*:/m;

/**
 * Appends a top-level `hooks:` block to a YAML config without a YAML parser.
 * A second `hooks:` key would be a duplicate key, and editing the user's entries
 * by text is how configs get lost, so an existing section is refused instead.
 * Returns the text unchanged when it already contains the same block.
 */
export function appendYamlHooks(current, block) {
  const text = current ?? '';
  if (text.includes(block)) return current;
  if (YAML_HOOKS_KEY.test(text)) throw new HooksSectionExists('The file already has a "hooks:" section.');
  if (!text.trim()) return block;
  return `${text}${text.endsWith('\n') ? '' : '\n'}\n${block}`;
}

/** A `hooks:` block for Hermes' config.yaml. JSON strings are valid YAML double-quoted scalars. */
async function hermesHooks(hookCommand) {
  const { HERMES_EVENTS } = await import('./adapter.mjs');
  const command = JSON.stringify(hookCommand('hermes'));
  const lines = ['hooks:'];
  for (const event of Object.keys(HERMES_EVENTS)) lines.push(`  ${event}:`, `    - command: ${command}`, '      timeout: 5');
  return lines.join('\n') + '\n';
}

/** @type {import('../index.mjs').Integration} */
export default {
  // Prints nothing: Hermes reads stdout as a block, modify or context directive.
  async hook({ readStdin, send }) {
    const { fromHermes } = await import('./adapter.mjs');
    await send(fromHermes(parseJson(await readStdin())));
  },

  async setup({ flags: f, hookCommand }) {
    const path = join(process.env.HERMES_HOME || join(homedir(), '.hermes'), 'config.yaml');
    const block = await hermesHooks(hookCommand);
    if (!f.write) {
      console.log(`Add this to ${path} (or rerun with --write to append it for you):\n`);
      console.log(block);
      return;
    }
    let result;
    try {
      result = await updateTextFile(path, (current) => appendYamlHooks(current, block));
    } catch (err) {
      if (!(err instanceof HooksSectionExists)) throw err;
      throw new SetupError(`${path} already has a "hooks:" section, so Agent Floor left it alone. Merge these entries into it by hand:\n\n${block}`);
    }
    if (!result.changed) console.log(`${path} already has the current Agent Floor hooks.`);
    else console.log(`Added Agent Floor hooks to ${path}${result.backup ? ` (backup at ${result.backup})` : ''}.`);
    console.log('Hermes asks you to approve each new hook the next time `hermes chat` starts (or start it once with --accept-hooks). `hermes hooks list` shows which ones are approved.');
  },
};
