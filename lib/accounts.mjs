// Which Claude Code config dir (account) a session belongs to.
//
// ~/.agent-floor/config.json:
//   { "claude": { "defaultConfigDir": "~/.claude",
//                 "byPath": [{ "path": "~/Workspaces/acme", "configDir": "~/.claude-acme" }] } }
import { basename, resolve, sep } from 'node:path';

export function expandHome(p, home) {
  if (p === '~') return home;
  if (p.startsWith('~/')) return resolve(home, p.slice(2));
  return resolve(p);
}

function claudeSettings(config, home) {
  const claude = config?.claude ?? {};
  const byPath = claude.byPath ?? [];
  if (!Array.isArray(byPath) || byPath.some((r) => typeof r?.path !== 'string' || typeof r?.configDir !== 'string')) {
    throw new Error('config.json: claude.byPath must be a list of { "path": string, "configDir": string }');
  }
  return {
    defaultDir: expandHome(claude.defaultConfigDir ?? '~/.claude', home),
    // Longest path first, so a nested folder rule wins over its parent's.
    byPath: byPath
      .map((r) => ({ path: expandHome(r.path, home), configDir: expandHome(r.configDir, home) }))
      .sort((a, b) => b.path.length - a.path.length),
  };
}

/** Every config dir `setup claude` installs hooks into: the default one plus each byPath target. */
export function claudeConfigDirs(config, home) {
  const { defaultDir, byPath } = claudeSettings(config, home);
  return [...new Set([defaultDir, ...byPath.map((r) => r.configDir)])];
}

/**
 * Settings files `setup claude` writes to, each with the config dir its hooks report.
 * A file passed to `claude --settings` or the project file get no config dir unless one
 * is given, so the hook resolves the account when it runs.
 */
export function claudeSetupTargets({ settingsFile, project, configDir, cwd, config, home }) {
  if (settingsFile) {
    return [{ path: resolve(cwd, settingsFile), configDir: configDir ? expandHome(configDir, home) : undefined }];
  }
  if (project) return [{ path: resolve(cwd, '.claude/settings.json'), configDir: undefined }];
  return claudeConfigDirs(config, home).map((dir) => ({ path: resolve(dir, 'settings.json'), configDir: dir }));
}

/**
 * Resolution order: the dir the hook was installed for (exact), CLAUDE_CONFIG_DIR,
 * the byPath rule whose folder contains cwd, then the default dir.
 */
export function claudeConfigDirFor({ installedFor, envDir, cwd, config, home }) {
  const { defaultDir, byPath } = claudeSettings(config, home);
  if (installedFor) return expandHome(installedFor, home);
  if (envDir) return expandHome(envDir, home);
  if (cwd) {
    const dir = resolve(cwd);
    const rule = byPath.find((r) => dir === r.path || dir.startsWith(r.path + sep));
    if (rule) return rule.configDir;
  }
  return defaultDir;
}

/** Label shown next to the agent's name: null for the default dir, "acme" for ~/.claude-acme. */
export function accountLabel(configDir, config, home) {
  const { defaultDir } = claudeSettings(config, home);
  const dir = expandHome(configDir, home);
  if (dir === defaultDir) return null;
  return basename(dir).replace(/^\.?claude-?/, '') || basename(dir);
}
