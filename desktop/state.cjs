// Small bits of state shared by the desktop app and the hooks, kept in ~/.agent-floor.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = process.env.AGENT_FLOOR_HOME || path.join(os.homedir(), '.agent-floor');
const SNOOZE = path.join(DIR, 'snoozed-until');
const LOCK = path.join(DIR, 'launch.lock');
const TOKEN = path.join(DIR, 'token');
const CONFIG = path.join(DIR, 'config.json');

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
}

/**
 * Shared secret that hooks send with every POST. Created on first use with
 * owner-only permissions, so other users on the machine cannot post events.
 */
function readToken() {
  ensureDir();
  try {
    fs.writeFileSync(TOKEN, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  if ((fs.statSync(TOKEN).mode & 0o077) !== 0) fs.chmodSync(TOKEN, 0o600);
  return fs.readFileSync(TOKEN, 'utf8').trim();
}

/** User settings from ~/.agent-floor/config.json. A missing file means defaults. */
function readConfig() {
  let text;
  try {
    text = fs.readFileSync(CONFIG, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  return JSON.parse(text);
}

/** Stop hooks from opening the app for `hours`. */
function snooze(hours) {
  ensureDir();
  fs.writeFileSync(SNOOZE, String(Date.now() + hours * 3600_000));
}

function isSnoozed() {
  try {
    return Date.now() < Number(fs.readFileSync(SNOOZE, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Only one hook may launch the app at a time: parallel subagents fire many
 * hooks at once. Returns true if this process won the right to launch.
 */
function takeLaunchLock(staleMs = 20_000) {
  ensureDir();
  try {
    const age = Date.now() - fs.statSync(LOCK).mtimeMs;
    if (age < staleMs) return false;
    fs.unlinkSync(LOCK);
  } catch {
    /* no lock yet */
  }
  try {
    fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

module.exports = { DIR, CONFIG, snooze, isSnoozed, takeLaunchLock, readToken, readConfig };
