// Helpers the integrations' `setup` and `hook` commands share.
import { updateJsonFile } from '../lib/settings.mjs';

/** Thrown by a setup for flags it cannot use. The CLI prints the setup usage and exits 1. */
export class UsageError extends Error {}

/** Thrown by a setup that stopped on purpose. The CLI prints the message and exits 1. */
export class SetupError extends Error {}

export function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

const OURS = /agent-floor(\.mjs)?['"]? hook (claude|codex|cursor)\b/;

export function isAgentFloorHook(hook) {
  return typeof hook?.command === 'string' && OURS.test(hook.command);
}

export function listAt(hooks, event) {
  const list = hooks[event];
  if (!Array.isArray(list)) throw new Error(`hooks.${event} is not a list. Fix it or merge the snippet by hand.`);
  return list;
}

export async function writeHooks(path, merge, opens) {
  const { changed, backup } = await updateJsonFile(path, merge);
  if (!changed) console.log(`${path} already has the current Agent Floor hooks.`);
  else console.log(`Merged Agent Floor hooks into ${path}${backup ? ` (backup at ${backup})` : ''}. ${opens}`);
}
