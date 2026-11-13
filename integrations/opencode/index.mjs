import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { updateTextFile } from '../../lib/settings.mjs';

// opencode loads plain .js files from its plugins folders. This one only points
// at the plugin inside this install, so updating Agent Floor updates the plugin.
function opencodePlugin() {
  const plugin = new URL('./plugin.mjs', import.meta.url).href;
  return [
    '// Agent Floor for opencode, written by `agent-floor setup opencode`.',
    '// Run that command again if you move the agent-floor folder.',
    `import { createPlugin } from ${JSON.stringify(plugin)};`,
    '',
    'export default createPlugin();',
    '',
  ].join('\n');
}

function opencodePluginPath(project) {
  if (project) return resolve('.opencode/plugins/agent-floor.js');
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(config, 'opencode', 'plugins', 'agent-floor.js');
}

/** @type {import('../index.mjs').Integration} */
export default {
  async setup({ flags: f }) {
    const path = opencodePluginPath(f.project);
    const plugin = opencodePlugin();
    if (!f.write) {
      console.log(`Write this file to ${path} (or rerun with --write to write it for you):\n`);
      console.log(plugin);
      return;
    }
    const { changed, backup } = await updateTextFile(path, () => plugin);
    if (!changed) console.log(`${path} already has the current Agent Floor plugin.`);
    else console.log(`Wrote ${path}${backup ? ` (backup at ${backup})` : ''}. Restart opencode to load it.`);
  },
};
