import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseJson } from '../cli.mjs';

/** @type {import('../index.mjs').Integration} */
export default {
  async hook({ args, readStdin, send }) {
    const { fromCodex } = await import('./adapter.mjs');
    // notify passes JSON as the last argv entry; hooks pass it on stdin.
    const arg = args.find((x) => x.trim().startsWith('{'));
    const input = parseJson(arg) || parseJson(await readStdin());
    await send(fromCodex(input));
  },

  async setup({ self }) {
    const path = join(homedir(), '.codex', 'config.toml');
    console.log(`Add this line near the top of ${path}:\n`);
    console.log(`notify = ["node", ${JSON.stringify(self)}, "hook", "codex"]\n`);
    console.log('Codex allows one notify program. If you already have one, chain them in a small script.');
  },
};
