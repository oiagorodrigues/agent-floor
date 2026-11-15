// ~/.agent-floor/config.json: global settings at the top, one section per agent under "agents".
//   { "app": "browser",
//     "agents": { "claude": { "defaultConfigDir": "~/.claude", "byPath": [...] } } }
import { createRequire } from 'node:module';

const localState = createRequire(import.meta.url)('../desktop/state.cjs');

/** config.json has a shape Agent Floor refuses to guess around. The message says how to fix it. */
export class ConfigError extends Error {}

/**
 * Returns `config` when its shape is current. An agent section at the top level
 * (where they lived before "agents") is refused with the file it should become,
 * instead of being read from its old place.
 */
export function checkConfig(config, agentNames, path = localState.CONFIG) {
  const agents = config?.agents;
  if (agents !== undefined && (!agents || typeof agents !== 'object' || Array.isArray(agents))) {
    throw new ConfigError(`${path}: "agents" must be an object with one section per agent, like { "agents": { "claude": { ... } } }.`);
  }
  const misplaced = agentNames.filter((name) => config && Object.hasOwn(config, name));
  if (!misplaced.length) return config;
  const moved = { ...config, agents: { ...agents } };
  for (const name of misplaced) {
    // A half-moved file keeps what is already under "agents".
    moved.agents[name] = { ...config[name], ...agents?.[name] };
    delete moved[name];
  }
  const names = misplaced.map((n) => `"${n}"`).join(' and ');
  throw new ConfigError(
    `${path}: agent settings now live under "agents". Move ${names} there, so the file reads:\n\n${JSON.stringify(moved, null, 2)}`,
  );
}

/** ~/.agent-floor/config.json, checked. A missing file means defaults. */
export function loadConfig(agentNames) {
  let config;
  try {
    config = localState.readConfig();
  } catch (err) {
    if (err instanceof SyntaxError) throw new ConfigError(`${localState.CONFIG}: not valid JSON (${err.message}).`);
    throw err;
  }
  return checkConfig(config, agentNames);
}

/** The `name` section under "agents", or {} when there is none. */
export function agentSection(config, name) {
  return config?.agents?.[name] ?? {};
}
