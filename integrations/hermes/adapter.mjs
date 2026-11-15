// Hermes Agent (Nous Research) shell hooks -> Agent Floor events.
//
// Hermes runs each command in the `hooks:` block of its config.yaml and writes
// { hook_event_name, tool_name, tool_input, session_id, cwd, profile, extra } to
// stdin, with event-specific fields (user_message, ...) under `extra`. The shape
// is close to Claude Code's, so the payload is renamed and handed to fromClaude.
// https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks#shell-hooks
import { fromClaude } from '../claude/adapter.mjs';

/** The Hermes events `agent-floor setup hermes` subscribes to, and the Claude Code hook each one acts as. */
export const HERMES_EVENTS = {
  on_session_start: 'SessionStart',
  pre_llm_call: 'UserPromptSubmit',
  pre_tool_call: 'PreToolUse',
  post_tool_call: 'PostToolUse',
  // Fires at the end of every turn, interrupted or not, so it is the idle signal.
  on_session_end: 'Stop',
  // Fires when the CLI or gateway tears the session down (/new, quit).
  on_session_finalize: 'SessionEnd',
};

/** user_message is a string, or a list of content parts on a multimodal turn. */
function promptText(message) {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return undefined;
  return message
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join(' ');
}

/**
 * Hermes mints session ids as `YYYYMMDD_HHMMSS_<hex>`, and fromClaude keeps the
 * first 8 characters, which would put every session of a day on one desk.
 * The tail holds the seconds and the random part.
 */
function sessionKey(id) {
  const alnum = String(id || '').replace(/[^a-zA-Z0-9]/g, '');
  return alnum.slice(-8);
}

/**
 * @param {Record<string, any>} input hook payload from stdin
 * @param {{ sharePrompts?: boolean }} [opts]
 * @returns {import('../../shared/protocol.js').InboundEvent[]}
 */
export function fromHermes(input, opts = {}) {
  if (!input || typeof input !== 'object') return [];
  const event = HERMES_EVENTS[input.hook_event_name];
  if (!event) return [];
  // on_session_finalize sends no session id when no session was active.
  if (event === 'SessionEnd' && !input.session_id) return [];
  return fromClaude(
    {
      hook_event_name: event,
      session_id: sessionKey(input.session_id),
      cwd: input.cwd,
      tool_name: input.tool_name,
      tool_input: input.tool_input,
      prompt: promptText(input.extra?.user_message),
    },
    { source: 'hermes', name: 'Hermes', sharePrompts: opts.sharePrompts },
  );
}
