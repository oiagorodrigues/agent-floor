// Every agent Agent Floor connects to. `agent-floor setup`, `agent-floor hook`,
// the usage text and the help come from this list, so a new integration is its
// folder plus one line here.
import claude from './claude/index.mjs';
import codex from './codex/index.mjs';
import cursor from './cursor/index.mjs';
import hermes from './hermes/index.mjs';
import opencode from './opencode/index.mjs';
import pi from './pi/index.mjs';

/**
 * @typedef {object} HookContext
 * @property {string[]} args argv after `hook <agent>`
 * @property {Record<string, string | boolean | string[]>} flags `args` parsed as --flags
 * @property {() => Promise<string>} readStdin
 * @property {(events: object[]) => Promise<void>} send posts the events, opening the floor when it isn't running
 * @property {(text: string) => void} respond what the CLI prints for the agent once the hook is done
 * @property {() => object} config this agent's section of ~/.agent-floor/config.json
 * @property {() => object | null} rooms the checked rooms file, or null when there is none or it is invalid
 *
 * @typedef {object} SetupContext
 * @property {Record<string, string | boolean | string[]>} flags
 * @property {string} self absolute path of bin/agent-floor.mjs
 * @property {(agent: string, configDir?: string) => string} hookCommand the shell command an agent's hook runs
 * @property {() => object} config this agent's section of ~/.agent-floor/config.json
 *
 * @typedef {object} Integration
 * @property {(ctx: SetupContext) => Promise<void>} setup
 * @property {(ctx: HookContext) => Promise<void>} [hook] for agents that run `agent-floor hook <agent>`;
 *   a hook must never slow down or break the agent, and the CLI swallows its errors
 * @property {{ args: string, note: string }[]} [usage] extra `setup <agent>` forms for the usage text
 */

/** @type {Record<string, Integration>} */
export const INTEGRATIONS = { claude, codex, cursor, hermes, opencode, pi };

export const AGENTS = Object.keys(INTEGRATIONS);
export const HOOK_AGENTS = AGENTS.filter((name) => INTEGRATIONS[name].hook);

/** `setup` forms: the common one first, then each agent's own. */
export function setupForms() {
  const forms = [{ args: `<${AGENTS.join('|')}> [--write] [--project]`, note: '' }];
  for (const name of AGENTS) for (const { args, note } of INTEGRATIONS[name].usage ?? []) forms.push({ args: `${name} ${args}`, note });
  return forms;
}
