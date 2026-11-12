// Claude Code hooks -> Agent Floor events.
// Receives the JSON object Claude Code writes to a hook's stdin.
// https://docs.claude.com/en/docs/claude-code/hooks
import { describeTool, pretty, sharesConversation, shortId, shortToolName, slugKey, teamFromCwd } from './common.mjs';

const SPAWN_TOOLS = new Set(['Task', 'Agent']);

/**
 * @param {Record<string, any>} input hook payload
 * @param {{ source?: string, name?: string, account?: string | null, sharePrompts?: boolean }} [opts]
 *   account: label of the Claude config dir the session runs under, shown on the agent card
 * @returns {import('../shared/protocol.js').InboundEvent[]}
 */
export function fromClaude(input, opts = {}) {
  if (!input || typeof input !== 'object') return [];
  const source = opts.source || 'claude-code';
  const share = opts.sharePrompts ?? sharesConversation();
  const account = opts.account || undefined;
  const lead = `${source}:${shortId(input.session_id)}`;
  const team = teamFromCwd(input.cwd);
  const base = {
    agent: lead,
    team,
    source,
    account,
    name: process.env.AGENT_FLOOR_NAME || opts.name || (source === 'codex' ? 'Codex' : 'Claude'),
    role: 'Lead',
  };
  // Inside a subagent, newer Claude Code versions add agent_id / agent_type.
  const sub = input.agent_id || input.agent_type ? { key: input.agent_id, type: input.agent_type } : undefined;
  const actor = sub ? { agent: lead, team, source, subagent: sub } : base;

  const tool = input.tool_name;
  const toolInput = input.tool_input || {};

  switch (input.hook_event_name) {
    case 'SessionStart':
      return [{ type: 'join', ...base, status: 'idle', activity: 'Ready' }];

    case 'UserPromptSubmit':
      return [{ type: 'status', ...base, status: 'thinking', activity: share ? `Asked: ${input.prompt ?? ''}` : 'Working on your request' }];

    case 'PreToolUse': {
      if (SPAWN_TOOLS.has(tool)) {
        const type = toolInput.subagent_type || 'general-purpose';
        const key = input.tool_use_id || slugKey(toolInput.description || type);
        return [
          { type: 'tool', ...actor, tool, activity: describeTool(tool, toolInput) },
          {
            type: 'join',
            agent: `${lead}:${shortId(key, 12)}`,
            parent: lead,
            team,
            source,
            account,
            name: pretty(type),
            role: type,
            status: 'thinking',
            activity: toolInput.description || 'Starting',
            text: toolInput.description || (share ? toolInput.prompt : undefined),
          },
        ];
      }
      const events = [{ type: 'tool', ...actor, tool: shortToolName(tool), activity: describeTool(tool, toolInput) }];
      if (tool === 'TodoWrite' && Array.isArray(toolInput.todos)) {
        const current =
          toolInput.todos.find((t) => t.status === 'in_progress') || toolInput.todos.find((t) => t.status === 'pending');
        if (current) events.push({ type: 'task', ...actor, task: current.activeForm || current.content });
      }
      return events;
    }

    case 'PostToolUse': {
      if (SPAWN_TOOLS.has(tool)) {
        const key = input.tool_use_id || slugKey(toolInput.description || toolInput.subagent_type || 'general-purpose');
        const child = `${lead}:${shortId(key, 12)}`;
        return [
          { type: 'message', agent: child, parent: lead, team, source, to: lead, text: 'Report ready', status: 'done' },
          { type: 'status', agent: child, status: 'done', activity: 'Handed back results' },
          { type: 'status', ...base, status: 'thinking', activity: `Reviewing ${pretty(toolInput.subagent_type || 'helper')} report` },
        ];
      }
      return [{ type: 'status', ...actor, status: 'thinking', activity: `Done: ${describeTool(tool, toolInput)}` }];
    }

    case 'Notification':
      return [{ type: 'status', ...base, status: 'waiting', activity: input.message || 'Needs your input' }];

    case 'Stop':
      return [{ type: 'status', ...base, status: 'idle', activity: 'Waiting for you' }];

    case 'SubagentStop':
      if (!sub) return [];
      return [{ type: 'status', ...actor, status: 'done', activity: 'Finished' }];

    case 'PreCompact':
      return [{ type: 'status', ...base, status: 'thinking', activity: 'Tidying up memory' }];

    case 'SessionEnd':
      return [{ type: 'leave', ...base, activity: 'Session ended' }];

    default:
      return [];
  }
}
