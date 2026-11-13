import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateJsonFile } from '../../lib/settings.mjs';

const PI_EXTENSION = /(^|[\\/])agent-floor-pi\.js$/;

/**
 * pi settings.json: drops earlier Agent Floor entries from "extensions" (from any
 * install path), keeps every other entry and setting, then appends `extensionPath`.
 * Pattern entries (`!glob`, `+path`, `-path`) are the user's own and stay as they are.
 */
export function mergePiExtensions(settings, extensionPath) {
  const current = settings.extensions ?? [];
  if (!Array.isArray(current)) throw new Error('"extensions" is not a list. Fix it or add the entry by hand.');
  const kept = current.filter((entry) => typeof entry !== 'string' || /^[!+-]/.test(entry) || !PI_EXTENSION.test(entry));
  return { ...settings, extensions: [...kept, extensionPath] };
}

/** @type {import('../index.mjs').Integration} */
export default {
  // pi runs this extension in its own process, so it needs no hook command.
  async setup({ flags: f }) {
    const extension = fileURLToPath(new URL('./agent-floor-pi.js', import.meta.url));
    const agentDir = process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=$|[\\/])/, homedir()) || join(homedir(), '.pi', 'agent');
    const path = f.project ? resolve('.pi/settings.json') : join(agentDir, 'settings.json');
    if (!f.write) {
      console.log(`Add this to ${path} (or rerun with --write to merge it for you):\n`);
      console.log(JSON.stringify({ extensions: [extension] }, null, 2));
      return;
    }
    const { changed, backup } = await updateJsonFile(path, (settings) => mergePiExtensions(settings, extension));
    if (!changed) console.log(`${path} already loads the Agent Floor extension.`);
    else console.log(`Added the Agent Floor extension to ${path}${backup ? ` (backup at ${backup})` : ''}. New pi sessions will show up on the floor.`);
  },
};
