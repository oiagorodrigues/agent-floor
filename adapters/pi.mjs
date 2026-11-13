// pi extension events -> Agent Floor events.
// Receives the event object pi passes to an extension's `pi.on(name, handler)`.
// The extension that subscribes and posts lives in extensions/agent-floor-pi.js.
// https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#events
import { describeTool, machineName, sharesConversation, teamFromCwd } from './common.mjs';

/** The events extensions/agent-floor-pi.js subscribes to. */
export const PI_EVENTS = [
  'session_start',
  'before_agent_start',
  'tool_execution_start',
  'tool_execution_end',
  'ui_prompt_start',
  'ui_prompt_end',
  'agent_settled',
  'session_shutdown',
];

// pi's built-in tools take the same arguments as the Claude Code tool on the right.
const LIKE_CLAUDE = { bash: 'Bash', powershell: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', grep: 'Grep', find: 'Glob' };

// pi session ids are UUIDv7, whose leading characters are a timestamp, so the
// random tail keeps two sessions started in the same minute apart.
function sessionKey(id) {
  return String(id || 'local').replace(/[^a-zA-Z0-9]/g, '').slice(-12) || 'local';
}

/**
 * @param {Record<string, any>} event pi extension event
 * @param {{ cwd?: string, sessionId?: string, idle?: boolean, sharePrompts?: boolean, machine?: string }} [opts]
 *   cwd, sessionId and idle come from the handler's ctx (ctx.cwd, ctx.sessionManager.getSessionId(), ctx.isIdle())
 * @returns {import('../shared/protocol.js').InboundEvent[]}
 */
export function fromPi(event, opts = {}) {
  if (!event || typeof event !== 'object') return [];
  const share = opts.sharePrompts ?? sharesConversation();
  const base = {
    agent: `pi:${sessionKey(opts.sessionId)}`,
    team: teamFromCwd(opts.cwd),
    source: 'pi',
    machine: opts.machine ?? machineName(),
    name: process.env.AGENT_FLOOR_NAME || 'Pi',
    role: 'Lead',
  };

  switch (event.type) {
    case 'session_start':
      return [{ type: 'join', ...base, status: 'idle', activity: 'Ready' }];

    case 'before_agent_start': {
      const asked = event.messageType === 'user' && share && event.prompt;
      return [{ type: 'status', ...base, status: 'thinking', activity: asked ? `Asked: ${event.prompt}` : 'Working on your request' }];
    }

    case 'tool_execution_start':
      return [{ type: 'tool', ...base, tool: event.toolName, activity: describeTool(LIKE_CLAUDE[event.toolName] ?? event.toolName, event.args) }];

    case 'tool_execution_end':
      return [{ type: 'status', ...base, status: 'thinking', activity: `${event.isError ? 'Failed' : 'Done'}: ${event.toolName}` }];

    case 'ui_prompt_start':
      return [{ type: 'status', ...base, status: 'waiting', activity: 'Needs your input' }];

    case 'ui_prompt_end':
      return [
        opts.idle
          ? { type: 'status', ...base, status: 'idle', activity: 'Waiting for you' }
          : { type: 'status', ...base, status: 'thinking', activity: 'Working on your request' },
      ];

    case 'agent_settled':
      return [{ type: 'status', ...base, status: 'idle', activity: event.aborted ? 'Stopped' : 'Waiting for you' }];

    case 'session_shutdown':
      // A reload keeps the session: pi fires session_start right after it.
      if (event.reason === 'reload') return [];
      return [{ type: 'leave', ...base, activity: 'Session ended' }];

    default:
      return [];
  }
}
