// Merging Agent Floor hooks into an agent's settings without touching anything else.
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const OURS = /agent-floor(\.mjs)?['"]? hook (claude|codex|cursor)\b/;

export function isAgentFloorHook(hook) {
  return typeof hook?.command === 'string' && OURS.test(hook.command);
}

function listAt(hooks, event) {
  const list = hooks[event];
  if (!Array.isArray(list)) throw new Error(`hooks.${event} is not a list. Fix it or merge the snippet by hand.`);
  return list;
}

/**
 * Claude Code settings: drops every earlier Agent Floor hook (in any event and
 * matcher group), keeps all other hooks and settings as they are, then appends ours.
 */
export function mergeClaudeHooks(settings, ours) {
  const current = settings.hooks ?? {};
  const hooks = {};
  for (const event of Object.keys(current)) {
    const kept = listAt(current, event).flatMap((group) => {
      const inner = Array.isArray(group?.hooks) ? group.hooks : [];
      const left = inner.filter((h) => !isAgentFloorHook(h));
      if (left.length === inner.length) return [group];
      return left.length ? [{ ...group, hooks: left }] : [];
    });
    if (kept.length) hooks[event] = kept;
  }
  for (const [event, groups] of Object.entries(ours)) hooks[event] = [...(hooks[event] ?? []), ...groups];
  return { ...settings, hooks };
}

/** Cursor hooks.json: same rule, but its entries are hooks themselves rather than matcher groups. */
export function mergeCursorHooks(current, ours) {
  const existing = current.hooks ?? {};
  const hooks = {};
  for (const event of Object.keys(existing)) {
    const kept = listAt(existing, event).filter((h) => !isAgentFloorHook(h));
    if (kept.length) hooks[event] = kept;
  }
  for (const [event, entries] of Object.entries(ours.hooks)) hooks[event] = [...(hooks[event] ?? []), ...entries];
  return { ...current, version: current.version ?? ours.version, hooks };
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Rewrites a text file through `update(before)`, where `before` is the current
 * content or null when the file is missing. Safely:
 * - leaves the file alone when nothing changes;
 * - keeps a timestamped, owner-only backup of the previous content;
 * - writes a temp file with the original permissions and renames it over the target,
 *   so a crash never leaves a half-written file;
 * - aborts if something else changed the file meanwhile (agents write their config too).
 * Symlinks are followed, so a config file kept in a dotfiles repo stays a symlink.
 */
export async function updateTextFile(path, update, { now = new Date() } = {}) {
  const target = await realpath(path).catch((err) => {
    if (err.code === 'ENOENT') return path;
    throw err;
  });
  await mkdir(dirname(target), { recursive: true });
  const before = await readOptional(target);
  const text = update(before);
  if (text === before) return { changed: false, backup: null };

  const mode = before === null ? 0o600 : (await stat(target)).mode & 0o777;
  let backup = null;
  if (before !== null) {
    backup = `${target}.agent-floor-${now.toISOString().replace(/[:.]/g, '-')}.bak`;
    await writeFile(backup, before, { flag: 'wx', mode: 0o600 });
  }
  const tmp = `${target}.agent-floor-${process.pid}.tmp`;
  await writeFile(tmp, text, { flag: 'wx', mode });
  try {
    if ((await readOptional(target)) !== before) {
      throw new Error(`${path} changed while Agent Floor was updating it. Nothing was written; run setup again.`);
    }
    await rename(tmp, target);
  } finally {
    await rm(tmp, { force: true });
  }
  return { changed: true, backup };
}

/** updateTextFile for a JSON object file. Refuses invalid JSON instead of overwriting it. */
export async function updateJsonFile(path, update, opts) {
  return updateTextFile(
    path,
    (before) => {
      let current = {};
      if (before !== null) {
        try {
          current = JSON.parse(before);
        } catch {
          throw new Error(`${path} is not valid JSON. Fix it or merge the snippet by hand.`);
        }
        if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error(`${path} does not hold a JSON object.`);
      }
      return JSON.stringify(update(structuredClone(current)), null, 2) + '\n';
    },
    opts,
  );
}
