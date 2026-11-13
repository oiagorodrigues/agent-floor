// Fixed rooms and standing roster desks from ~/.agent-floor/rooms.json (or AGENT_FLOOR_ROOMS).
// Ported from github.com/adhamelsharkawy996-arch/agent-floor (shared/rooms.js, f0c4483 and 87488e7).
//
//   { "rooms": [{ "slug": "ceo", "name": "CEO Office", "leadName": "CEO", "task": "Judge reports",
//                 "paths": ["~/offices/ceo"],
//                 "roster": [{ "type": "report-intake", "name": "Intake", "job": "Collect reports", "model": "haiku" }] }],
//     "mail": { "inbox": "~/offices/ceo/inbox", "inboxTo": "ceo:report-intake",
//               "decisions": "~/offices/ceo/decisions", "decisionsTo": "{slug}:reporter" } }
//
// No file means no rooms, and the floor behaves as if this module did not exist.
import { readFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { slug } from '../shared/protocol.js';
import { expandHome } from './accounts.mjs';

const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
// Matches what the reducer keeps of a role, so a desk's role and a subagent's type compare equal.
const TYPE = /^[^\s]{1,40}$/;
const TARGET = /^(\{slug\}|[a-z0-9][a-z0-9-]*):([^\s]+)$/;

export function roomsPath(floorDir, env = process.env) {
  return env.AGENT_FLOOR_ROOMS ? resolve(env.AGENT_FLOOR_ROOMS) : join(floorDir, 'rooms.json');
}

export function rosterId(roomSlug, type) {
  return `roster:${roomSlug}:${type}`;
}

/** What an idle roster desk shows on its monitor: "job · model". */
export function idleLine(entry) {
  return [entry.job, entry.model].filter(Boolean).join(' · ') || 'Ready';
}

function fail(message) {
  throw new Error(`rooms.json: ${message}`);
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const ROOT_KEYS = ['rooms', 'mail'];
const ROOM_KEYS = ['slug', 'name', 'leadName', 'task', 'paths', 'roster'];
const ROSTER_KEYS = ['type', 'name', 'job', 'model'];
const MAIL_KEYS = ['inbox', 'inboxTo', 'decisions', 'decisionsTo'];

function onlyKeys(object, known, where) {
  const unknown = Object.keys(object).find((k) => !known.includes(k));
  if (unknown) fail(`${where} has an unknown field "${unknown}". Known fields: ${known.join(', ')}`);
}

function optionalString(value, where) {
  if (value !== undefined && typeof value !== 'string') fail(`${where} must be a string`);
  return value || undefined;
}

function parseRoster(list, where) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) fail(`${where} must be a list of { "type": string, "name"?, "job"?, "model"? }`);
  const seen = new Set();
  return list.map((entry, i) => {
    const at = `${where}[${i}]`;
    if (!isObject(entry) || typeof entry.type !== 'string' || !TYPE.test(entry.type)) {
      fail(`${at}.type must be a subagent type: up to 40 characters, no spaces`);
    }
    onlyKeys(entry, ROSTER_KEYS, at);
    if (seen.has(entry.type)) fail(`${at}.type "${entry.type}" is listed twice in this room`);
    seen.add(entry.type);
    return {
      type: entry.type,
      name: optionalString(entry.name, `${at}.name`),
      job: optionalString(entry.job, `${at}.job`),
      model: optionalString(entry.model, `${at}.model`),
    };
  });
}

function parseRoom(room, i, home) {
  const at = `rooms[${i}]`;
  if (!isObject(room)) fail(`${at} must be an object`);
  onlyKeys(room, ROOM_KEYS, at);
  if (typeof room.slug !== 'string' || !SLUG.test(room.slug)) {
    fail(`${at}.slug must be lower-case letters, digits and dashes, like "ceo" or "checkout-api"`);
  }
  if (typeof room.name !== 'string' || !room.name.trim()) fail(`${at}.name must be a non-empty string`);
  if (room.paths !== undefined && (!Array.isArray(room.paths) || room.paths.some((p) => typeof p !== 'string' || !p))) {
    fail(`${at}.paths must be a list of folder paths`);
  }
  return {
    slug: room.slug,
    name: room.name.trim(),
    leadName: optionalString(room.leadName, `${at}.leadName`),
    task: optionalString(room.task, `${at}.task`),
    paths: (room.paths ?? []).map((p) => expandHome(p, home)),
    roster: parseRoster(room.roster, `${at}.roster`),
  };
}

function parseRoute(mail, folderKey, targetKey, rooms, home) {
  const folder = optionalString(mail[folderKey], `mail.${folderKey}`);
  const target = optionalString(mail[targetKey], `mail.${targetKey}`);
  if (!folder && !target) return null;
  if (!folder) fail(`mail.${targetKey} needs mail.${folderKey}`);
  const match = TARGET.exec(target ?? '');
  if (!match) fail(`mail.${targetKey} must be "<room slug>:<roster type>" or "{slug}:<roster type>"`);
  const [, roomSlug, type] = match;
  if (roomSlug !== '{slug}') {
    const room = rooms.find((r) => r.slug === roomSlug);
    if (!room?.roster.some((e) => e.type === type)) fail(`mail.${targetKey}: room "${roomSlug}" has no "${type}" desk`);
  }
  return { folder: expandHome(folder, home), roomSlug, type };
}

/**
 * Checks a parsed rooms file and returns it ready to use: `~` expanded, paths absolute.
 * Throws an Error naming the bad field, so a typo never silently turns a room off.
 */
export function parseRooms(json, home) {
  if (!isObject(json)) fail('the file must hold a JSON object with a "rooms" list');
  onlyKeys(json, ROOT_KEYS, 'the file');
  if (!Array.isArray(json.rooms)) fail('"rooms" must be a list');
  const rooms = json.rooms.map((room, i) => parseRoom(room, i, home));
  const slugs = new Set();
  const teams = new Set();
  for (const room of rooms) {
    if (slugs.has(room.slug)) fail(`two rooms use the slug "${room.slug}"`);
    if (teams.has(slug(room.name))) fail(`two rooms would share the name "${room.name}"`);
    slugs.add(room.slug);
    teams.add(slug(room.name));
  }
  if (json.mail !== undefined && !isObject(json.mail)) fail('"mail" must be an object');
  const mail = json.mail ?? {};
  onlyKeys(mail, MAIL_KEYS, 'mail');
  const routes = [parseRoute(mail, 'inbox', 'inboxTo', rooms, home), parseRoute(mail, 'decisions', 'decisionsTo', rooms, home)];
  return { rooms, mail: routes.filter(Boolean) };
}

/** The rooms file at `file`, checked. Null when there is no file. Throws when it is unreadable or invalid. */
export function loadRooms(file, home) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    fail(`not valid JSON (${err.message})`);
  }
  return parseRooms(json, home);
}

const inside = (path, folder) => path === folder || path.startsWith(folder + sep);

/** The room whose folder holds `cwd`. The deepest folder wins, like the account rules in config.json. */
export function roomForPath(config, cwd) {
  if (!config || !cwd) return null;
  const dir = resolve(cwd);
  let best = null;
  let bestLength = -1;
  for (const room of config.rooms) {
    for (const path of room.paths) {
      if (inside(dir, path) && path.length > bestLength) {
        best = room;
        bestLength = path.length;
      }
    }
  }
  return best;
}

export function rosterEntry(room, type) {
  return room?.roster.find((e) => e.type === type) ?? null;
}

/**
 * A file written to `<mail folder>/<room slug>/...` is a report for a roster desk.
 * Returns the desk id and the file name for the paper plane, or null.
 */
export function mailTarget(config, filePath) {
  if (!config || typeof filePath !== 'string' || !filePath) return null;
  const path = resolve(filePath);
  for (const route of config.mail) {
    if (!path.startsWith(route.folder + sep)) continue;
    const parts = path.slice(route.folder.length + 1).split(sep);
    if (parts.length < 2) continue;
    const from = config.rooms.find((r) => r.slug === parts[0]);
    if (!from) continue;
    const roomSlug = route.roomSlug === '{slug}' ? from.slug : route.roomSlug;
    if (!rosterEntry(config.rooms.find((r) => r.slug === roomSlug), route.type)) continue;
    return { to: rosterId(roomSlug, route.type), text: basename(path) };
  }
  return null;
}

/** Events that put every roster desk on the floor. Safe to apply again after a reload. */
export function seedEvents(config) {
  const events = [];
  for (const room of config?.rooms ?? []) {
    for (const entry of room.roster) {
      events.push({
        type: 'join',
        agent: rosterId(room.slug, entry.type),
        team: room.name,
        name: entry.name,
        role: entry.type,
        source: 'roster',
        status: 'idle',
        activity: idleLine(entry),
        pinned: true,
      });
    }
    if (room.task && room.roster.length) {
      events.push({ type: 'task', agent: rosterId(room.slug, room.roster[0].type), task: room.task });
    }
  }
  return events;
}
