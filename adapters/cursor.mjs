// Cursor agent hooks -> Agent Floor events.
// Cursor writes a JSON payload to the hook's stdin. We only subscribe to hooks
// that observe (after*, stop, subagentStop, sessionEnd, beforeSubmitPrompt) so
// Agent Floor can never change a permission decision. See docs/integrations.md
// for the hooks.json snippet.
import { basename } from 'node:path';
import { machineName, pretty, sharesConversation, shortId, slugKey, teamFromCwd } from './common.mjs';

export function fromCursor(input, { sharePrompts = sharesConversation(), machine = machineName() } = {}) {
  if (!input || typeof input !== 'object') return [];
  const root = Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : undefined;
  const base = {
    agent: `cursor:${shortId(input.conversation_id)}`,
    team: teamFromCwd(root),
    source: 'cursor',
    machine,
    name: process.env.AGENT_FLOOR_NAME || 'Cursor',
    role: 'Lead',
  };
  const f = (p) => (p ? basename(String(p)) : 'a file');

  switch (input.hook_event_name) {
    case 'beforeSubmitPrompt':
      return [{ type: 'status', ...base, status: 'thinking', activity: sharePrompts ? `Asked: ${input.prompt ?? ''}` : 'Working on your request' }];
    case 'afterAgentThought':
      return [{ type: 'status', ...base, status: 'thinking', activity: (sharePrompts && input.text) || 'Thinking' }];
    case 'afterFileEdit':
      return [{ type: 'tool', ...base, tool: 'Edit', activity: `Edited ${f(input.file_path)}` }];
    case 'beforeReadFile':
      return [{ type: 'tool', ...base, tool: 'Read', activity: `Reading ${f(input.file_path)}` }];
    case 'beforeShellExecution':
    case 'afterShellExecution':
      return [{ type: 'tool', ...base, tool: 'Shell', activity: `Running ${String(input.command ?? '').slice(0, 60)}` }];
    case 'beforeMCPExecution':
    case 'afterMCPExecution':
      return [{ type: 'tool', ...base, tool: 'MCP', activity: `MCP: ${input.tool_name ?? 'tool'}` }];
    case 'afterAgentResponse':
      return [{ type: 'status', ...base, status: 'thinking', activity: sharePrompts ? `Replied: ${input.text ?? ''}` : 'Replied' }];
    case 'subagentStop':
      return subagentVisit(input, base, sharePrompts);
    case 'stop':
      return [
        {
          type: 'status',
          ...base,
          status: input.status === 'error' ? 'error' : 'idle',
          activity: input.status === 'error' ? 'Stopped with an error' : 'Waiting for you',
        },
      ];
    case 'sessionEnd':
      return [{ type: 'leave', ...base, activity: 'Session ended' }];
    default:
      return [];
  }
}

// subagentStart is a permission hook: Cursor requires it to answer allow or deny.
// So the helper's whole visit is drawn when subagentStop reports it: it joins with
// its brief, reports back to the lead and finishes.
function subagentVisit(input, base, sharePrompts) {
  const lead = input.parent_conversation_id ? { ...base, agent: `cursor:${shortId(input.parent_conversation_id)}` } : base;
  const type = input.subagent_type || 'generalPurpose';
  const failed = input.status === 'error';
  const helper = {
    agent: `${lead.agent}:${shortId(input.subagent_id || slugKey(type), 12)}`,
    parent: lead.agent,
    team: lead.team,
    source: lead.source,
  };
  return [
    {
      type: 'join',
      ...helper,
      name: pretty(type),
      role: type,
      status: 'working',
      activity: `${pretty(type)} task`,
      text: sharePrompts ? input.task : undefined,
    },
    {
      type: 'message',
      ...helper,
      to: lead.agent,
      text: (sharePrompts && input.summary) || (failed ? 'Hit an error' : 'Report ready'),
      status: failed ? 'error' : 'done',
    },
    { type: 'status', agent: helper.agent, status: failed ? 'error' : 'done', activity: failed ? 'Stopped with an error' : 'Handed back results' },
    { type: 'status', ...lead, status: 'thinking', activity: `Reviewing ${pretty(type)} report` },
  ];
}

/** What each Cursor hook must print on stdout. Observing hooks print nothing. */
export function cursorResponse(hookName) {
  if (hookName === 'beforeSubmitPrompt') return JSON.stringify({ continue: true });
  return '';
}
