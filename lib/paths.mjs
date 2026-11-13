import { resolve } from 'node:path';

/** Resolves a path from a config file, where `~` means the user's home. */
export function expandHome(p, home) {
  if (p === '~') return home;
  if (p.startsWith('~/')) return resolve(home, p.slice(2));
  return resolve(p);
}
