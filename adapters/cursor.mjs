// Cursor agent hooks -> Agent Floor events.
// Cursor writes a JSON payload to the hook's stdin. We only subscribe to hooks
// that observe (after*, stop, subagentStop, sessionEnd, beforeSubmitPrompt) so
// Agent Floor can never change a permission decision. See docs/integrations.md
// for the hooks.json snippet.
import { createHash } from 'node:crypto';
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

const SUBAGENT_ENDINGS = {
  completed: { status: 'done', report: 'Report ready', activity: 'Handed back results' },
  aborted: { status: 'done', report: 'Stopped early', activity: 'Stopped early' },
  error: { status: 'error', report: 'Hit an error', activity: 'Stopped with an error' },
};

// subagentStart is a permission hook: Cursor requires it to answer allow or deny.
// So the helper's whole visit is drawn when subagentStop reports it: it joins with
// its brief, reports back to the lead and finishes.
function subagentVisit(input, base, sharePrompts) {
  const type = input.subagent_type || 'generalPurpose';
  const ending = SUBAGENT_ENDINGS[input.status] ?? SUBAGENT_ENDINGS.completed;
  // subagentStop carries no subagent id; the transcript path is the one per-subagent value.
  const key = input.agent_transcript_path ? createHash('sha256').update(String(input.agent_transcript_path)).digest('hex') : slugKey(type);
  const helper = { agent: `${base.agent}:${shortId(key, 12)}`, parent: base.agent, team: base.team, source: base.source, machine: base.machine };
  return [
    {
      type: 'join',
      ...helper,
      name: pretty(type),
      role: type,
      status: 'working',
      activity: `${pretty(type)} task`,
      text: sharePrompts ? input.task || input.description : undefined,
    },
    { type: 'message', ...helper, to: base.agent, text: (sharePrompts && input.summary) || ending.report, status: ending.status },
    { type: 'status', agent: helper.agent, status: ending.status, activity: ending.activity },
    { type: 'status', ...base, status: 'thinking', activity: `Reviewing ${pretty(type)} report` },
  ];
}

/** What each Cursor hook must print on stdout. Observing hooks print nothing. */
export function cursorResponse(hookName) {
  if (hookName === 'beforeSubmitPrompt') return JSON.stringify({ continue: true });
  return '';
}
