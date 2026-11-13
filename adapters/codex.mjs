// OpenAI Codex CLI -> Agent Floor events.
//
// Codex calls the program configured as `notify` in ~/.codex/config.toml with one
// JSON argument when a turn completes. Newer Codex builds can also run hooks that
// pass a Claude-style payload ({ hook_event_name, ... }) on stdin; those are routed
// through the Claude mapper with source "codex".
import { fromClaude } from './claude.mjs';
import { machineName, sharesConversation, shortId, teamFromCwd } from './common.mjs';

export function fromCodex(input, { sharePrompts = sharesConversation(), machine = machineName() } = {}) {
  if (!input || typeof input !== 'object') return [];
  if (input.hook_event_name) return fromClaude(input, { source: 'codex', name: 'Codex', sharePrompts, machine });

  const thread = input['thread-id'] || input.thread_id || input.session_id;
  const base = {
    agent: `codex:${shortId(thread)}`,
    team: teamFromCwd(input.cwd),
    source: 'codex',
    machine,
    name: process.env.AGENT_FLOOR_NAME || 'Codex',
    role: 'Lead',
  };

  switch (input.type) {
    case 'agent-turn-complete': {
      const asked = Array.isArray(input['input-messages']) ? input['input-messages'].at(-1) : undefined;
      const answer = input['last-assistant-message'];
      const events = [];
      if (asked && sharePrompts) events.push({ type: 'status', ...base, status: 'thinking', activity: `Asked: ${asked}` });
      events.push({ type: 'status', ...base, status: 'idle', activity: answer && sharePrompts ? `Replied: ${answer}` : 'Turn complete' });
      return events;
    }
    case 'approval-requested':
      return [{ type: 'status', ...base, status: 'waiting', activity: 'Needs your approval' }];
    default:
      return [{ type: 'status', ...base, status: 'idle', activity: input.type ? String(input.type) : 'Update' }];
  }
}
