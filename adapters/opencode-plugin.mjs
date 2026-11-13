// The opencode plugin. `agent-floor setup opencode` writes a small file into
// opencode's plugins folder that default-exports createPlugin().
//
// One object serves both runtimes, as opencode documents for packages that
// support both: OpenCode 2 reads `id` and `setup()`, OpenCode 1 calls `server()`
// (https://opencode.ai/docs/build/plugins/migrate-v1/).
//
// The plugin runs inside opencode, so it posts to the floor itself instead of
// starting a process per event. Nothing is awaited on opencode's path, and every
// failure is dropped: a floor that is not running must never slow down or break
// the agent.
import { createRequire } from 'node:module';
import { OPENCODE2_EVENTS, fromOpencodeV1, fromOpencodeV2 } from './opencode.mjs';

const require = createRequire(import.meta.url);
const localState = require('../desktop/state.cjs');

const POST_TIMEOUT_MS = 1200;
// The most events POST /events accepts in one request.
const MAX_BATCH = 200;

function floorUrl(env = process.env) {
  const port = Number(env.AGENT_FLOOR_PORT) || 4317;
  return (env.AGENT_FLOOR_URL || `http://127.0.0.1:${port}`).replace(/\/$/, '');
}

/** Posts events with the floor's token. Resolves either way and never throws. */
export async function postEvents(events, { url = floorUrl(), timeoutMs = POST_TIMEOUT_MS } = {}) {
  try {
    await fetch(`${url}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localState.readToken()}` },
      body: JSON.stringify(events),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // The floor is optional.
  }
}

/**
 * @param {{ id?: string, post?: (events: object[]) => Promise<void> }} [opts]
 *   id: OpenCode 2 refuses a second plugin with the same id, so a copy installed
 *   both globally and in a project loads once instead of posting every event twice.
 */
export function createPlugin({ id = 'agent-floor', post = postEvents } = {}) {
  // One request at a time, so the floor applies events in the order they
  // happened: a late "Done: ..." must not land after the session went idle.
  const pending = [];
  let flushing = false;
  const flush = async () => {
    flushing = true;
    try {
      while (pending.length) await post(pending.splice(0, MAX_BATCH));
    } finally {
      flushing = false;
    }
  };

  const send = (map) => {
    try {
      const events = map();
      if (!events.length) return;
      pending.push(...events);
      if (!flushing) void flush();
    } catch {
      // A payload this version of the plugin does not understand. Skip it.
    }
  };

  return {
    id,

    async setup(ctx) {
      const opts = { directory: ctx?.location?.directory };
      await ctx.tool.hook('execute.before', (event) => send(() => fromOpencodeV2('tool.execute.before', event, opts)));
      await ctx.tool.hook('execute.after', (event) => send(() => fromOpencodeV2('tool.execute.after', event, opts)));
      await ctx.session.hook('prompt', (event) => send(() => fromOpencodeV2('session.prompt', event, opts)));

      const controller = new AbortController();
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ types: OPENCODE2_EVENTS, signal: controller.signal })) {
            send(() => fromOpencodeV2('event', event, opts));
          }
        } catch {
          // Aborted on unload, or the server closed the stream.
        }
      })();
      return () => controller.abort();
    },

    async server(input) {
      const opts = { directory: input?.directory };
      return {
        'chat.message': async (hookInput, output) => send(() => fromOpencodeV1('chat.message', hookInput, output, opts)),
        'tool.execute.before': async (hookInput, output) => send(() => fromOpencodeV1('tool.execute.before', hookInput, output, opts)),
        'tool.execute.after': async (hookInput, output) => send(() => fromOpencodeV1('tool.execute.after', hookInput, output, opts)),
        event: async (hookInput) => send(() => fromOpencodeV1('event', hookInput, undefined, opts)),
      };
    },
  };
}
