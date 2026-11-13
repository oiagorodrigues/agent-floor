// opencode plugin hooks and events -> Agent Floor events.
//
// The plugin in adapters/opencode-plugin.mjs runs inside opencode and hands
// every payload to these pure functions. OpenCode 1 passes (input, output) per
// hook; OpenCode 2 passes one event object per hook.
// OpenCode 1: https://github.com/anomalyco/opencode/blob/85a043926abf98ca967a24b7c12c0aa6b7d81cd3/services/site/src/docs/v1/content/plugins.mdx
// OpenCode 2: https://opencode.ai/docs/build/plugins/server/
import { describeTool, machineName, sharesConversation, shortId, teamFromCwd } from './common.mjs';

// opencode's built-in tool ids, named the way describeTool knows them.
const CLAUDE_NAMES = {
  bash: 'Bash',
  shell: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  grep: 'Grep',
  glob: 'Glob',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  todowrite: 'TodoWrite',
  task: 'Task',
};

function describe(tool, args) {
  const input = args && typeof args === 'object' ? args : {};
  const name = CLAUDE_NAMES[tool];
  return name ? describeTool(name, { ...input, file_path: input.filePath }) : describeTool(tool, input);
}

/**
 * Session ids are "ses_" plus a time-ordered prefix and a random tail, so two
 * sessions started close together share their first characters. The tail keeps
 * their desks apart.
 */
export function opencodeAgentId(sessionID) {
  return `opencode:${shortId(String(sessionID ?? '').slice(-8))}`;
}

function eventsFor(change, { directory, sharePrompts = sharesConversation(), machine = machineName() } = {}) {
  if (!change.sessionID) return [];
  const base = {
    agent: opencodeAgentId(change.sessionID),
    team: teamFromCwd(directory),
    source: 'opencode',
    machine,
    name: process.env.AGENT_FLOOR_NAME || 'OpenCode',
    role: 'Lead',
  };

  switch (change.kind) {
    case 'prompt':
      return [{ type: 'status', ...base, status: 'thinking', activity: sharePrompts ? `Asked: ${change.text ?? ''}` : 'Working on your request' }];
    case 'tool.start':
      return [{ type: 'tool', ...base, tool: change.tool, activity: describe(change.tool, change.args) }];
    case 'tool.end':
      return [{ type: 'status', ...base, status: 'thinking', activity: `Done: ${describe(change.tool, change.args)}` }];
    case 'idle':
      return [{ type: 'status', ...base, status: 'idle', activity: 'Waiting for you' }];
    case 'error':
      return [{ type: 'status', ...base, status: 'error', activity: 'Stopped with an error' }];
    case 'permission':
      return [{ type: 'status', ...base, status: 'waiting', activity: 'Needs your approval' }];
    case 'deleted':
      return [{ type: 'leave', ...base, activity: 'Session ended' }];
    default:
      return [];
  }
}

/** Event types the plugin subscribes to on OpenCode 2. OpenCode 1 sends every event to the `event` hook. */
export const OPENCODE2_EVENTS = ['session.status', 'session.idle', 'session.execution.failed', 'permission.asked', 'session.deleted'];

/**
 * OpenCode 1 puts an event's fields under `properties`, OpenCode 2 under `data`.
 * `session.idle` is deprecated in OpenCode 2 in favour of `session.status`; both still arrive.
 * A failed turn is `session.error` on OpenCode 1 and `session.execution.failed` on OpenCode 2.
 */
function busChange(event) {
  const props = event?.properties ?? event?.data ?? {};
  switch (event?.type) {
    case 'session.status':
      return props.status?.type === 'idle' ? { kind: 'idle', sessionID: props.sessionID } : {};
    case 'session.idle':
      return { kind: 'idle', sessionID: props.sessionID };
    case 'session.error':
    case 'session.execution.failed':
      return { kind: 'error', sessionID: props.sessionID };
    case 'permission.asked':
      return { kind: 'permission', sessionID: props.sessionID };
    case 'session.deleted':
      return { kind: 'deleted', sessionID: props.sessionID ?? props.info?.id };
    default:
      return {};
  }
}

function firstText(parts) {
  const part = Array.isArray(parts) ? parts.find((p) => p?.type === 'text' && typeof p.text === 'string') : undefined;
  return part?.text;
}

/**
 * OpenCode 1 hooks, as returned from the plugin's `server()`.
 * @param {'chat.message'|'tool.execute.before'|'tool.execute.after'|'event'} hook
 * @param {Record<string, any>} input the hook's first argument
 * @param {Record<string, any>} [output] the hook's second argument
 * @param {{ directory?: string, sharePrompts?: boolean, machine?: string }} [opts]
 * @returns {import('../shared/protocol.js').InboundEvent[]}
 */
export function fromOpencodeV1(hook, input, output, opts) {
  if (!input || typeof input !== 'object') return [];
  switch (hook) {
    case 'chat.message':
      return eventsFor({ kind: 'prompt', sessionID: input.sessionID, text: firstText(output?.parts) }, opts);
    case 'tool.execute.before':
      return eventsFor({ kind: 'tool.start', sessionID: input.sessionID, tool: input.tool, args: output?.args }, opts);
    case 'tool.execute.after':
      return eventsFor({ kind: 'tool.end', sessionID: input.sessionID, tool: input.tool, args: input.args }, opts);
    case 'event':
      return eventsFor(busChange(input.event), opts);
    default:
      return [];
  }
}

/**
 * OpenCode 2 hooks registered in the plugin's `setup(ctx)`, plus events from `ctx.event.subscribe()`.
 * @param {'tool.execute.before'|'tool.execute.after'|'session.prompt'|'event'} hook
 * @param {Record<string, any>} event the hook's event, or the bus event
 * @param {{ directory?: string, sharePrompts?: boolean, machine?: string }} [opts]
 * @returns {import('../shared/protocol.js').InboundEvent[]}
 */
export function fromOpencodeV2(hook, event, opts) {
  if (!event || typeof event !== 'object') return [];
  switch (hook) {
    case 'session.prompt':
      return eventsFor({ kind: 'prompt', sessionID: event.sessionID, text: event.prompt?.text }, opts);
    case 'tool.execute.before':
      return eventsFor({ kind: 'tool.start', sessionID: event.sessionID, tool: event.tool, args: event.input }, opts);
    case 'tool.execute.after':
      return eventsFor({ kind: 'tool.end', sessionID: event.sessionID, tool: event.tool, args: event.input }, opts);
    case 'event':
      // The stream carries every location the server runs. Each location's copy
      // of the plugin reports its own, so no session is posted twice or lands in
      // another project's room.
      if (event.location?.directory && opts?.directory && event.location.directory !== opts.directory) return [];
      return eventsFor(busChange(event), opts);
    default:
      return [];
  }
}
