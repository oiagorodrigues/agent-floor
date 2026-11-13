// Claude Code hooks -> Agent Floor events.
// Receives the JSON object Claude Code writes to a hook's stdin.
// https://docs.claude.com/en/docs/claude-code/hooks
import { crewMode, describeTool, machineName, pretty, sharesConversation, shortId, shortToolName, slugKey, teamFromCwd } from './common.mjs';

const SPAWN_TOOLS = new Set(['Task', 'Agent']);

/** "Stage 2" when one of the texts names a pipeline stage near its start. */
export function stageOf(...texts) {
  for (const t of texts) {
    const m = /\bstage\s*#?\s*(\d{1,2})\b/i.exec(String(t ?? '').slice(0, 400));
    if (m) return `Stage ${Number(m[1])}`;
  }
  return undefined;
}

/**
 * @param {Record<string, any>} input hook payload
 * @param {{ source?: string, name?: string, account?: string | null, machine?: string, sharePrompts?: boolean, crew?: boolean }} [opts]
 *   account: label of the Claude config dir the session runs under, shown on the agent card
 *   crew: keep finished helpers at their desks (defaults to AGENT_FLOOR_CREW)
 * @returns {import('../shared/protocol.js').InboundEvent[]}
 */
export function fromClaude(input, opts = {}) {
  if (!input || typeof input !== 'object') return [];
  const source = opts.source || 'claude-code';
  const share = opts.sharePrompts ?? sharesConversation();
  const crew = opts.crew ?? crewMode();
  const account = opts.account || undefined;
  const machine = opts.machine ?? machineName();
  const lead = `${source}:${shortId(input.session_id)}`;
  const team = teamFromCwd(input.cwd);
  const base = {
    agent: lead,
    team,
    source,
    account,
    machine,
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
        const stage = stageOf(toolInput.description, share ? toolInput.prompt : undefined);
        return [
          { type: 'tool', ...actor, tool, activity: describeTool(tool, toolInput) },
          {
            type: 'join',
            agent: `${lead}:${shortId(key, 12)}`,
            parent: lead,
            team,
            source,
            account,
            machine,
            name: pretty(type),
            role: type,
            status: 'thinking',
            activity: toolInput.description || 'Starting',
            text: toolInput.description || (share ? toolInput.prompt : undefined),
            stage,
            stay: crew || undefined,
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
