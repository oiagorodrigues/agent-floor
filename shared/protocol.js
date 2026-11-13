// Agent Floor event protocol + reducer.
// Shared verbatim by the Node server and the browser, so both always agree on world state.
// Plain ESM JavaScript with zero dependencies. Types live in protocol.d.ts.

export const PROTOCOL_VERSION = 1;

export const STATUSES = ['idle', 'thinking', 'working', 'waiting', 'done', 'error', 'offline'];

export const EVENT_TYPES = ['join', 'status', 'tool', 'message', 'task', 'leave', 'reset'];

const MAX_HISTORY = 24;
const MAX_TEXT = 280;

export function createState() {
  return { teams: {}, agents: {}, aliases: {}, seq: 0, updatedAt: 0 };
}

export function slug(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'default';
}

function clip(text, max = MAX_TEXT) {
  if (text == null) return undefined;
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function titleCase(value) {
  return String(value)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Validate and normalise anything a client posts. Unknown fields are dropped.
 * Returns null when the event is unusable.
 */
export function normalizeEvent(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const type = EVENT_TYPES.includes(raw.type) ? raw.type : null;
  if (!type) return null;
  if (type === 'reset') return { type, ts: now };

  const agentRaw = typeof raw.agent === 'object' && raw.agent ? raw.agent : { id: raw.agent };
  const agentId = agentRaw.id != null ? String(agentRaw.id).slice(0, 128) : null;
  if (!agentId) return null;

  const teamRaw = typeof raw.team === 'object' && raw.team ? raw.team : { name: raw.team };
  const teamName = clip(teamRaw.name ?? teamRaw.id, 48);

  const ev = {
    type,
    ts: Number.isFinite(raw.ts) ? raw.ts : now,
    agent: agentId,
    name: clip(raw.name ?? agentRaw.name, 40),
    role: clip(raw.role ?? agentRaw.role, 40),
    source: clip(raw.source ?? agentRaw.source, 32),
    account: clip(raw.account, 32),
    machine: clip(raw.machine, 32),
    // `parent: null` tells a standing roster desk that one of its spawns has ended.
    parent: raw.parent === null ? null : raw.parent != null ? String(raw.parent).slice(0, 128) : undefined,
    pinned: typeof raw.pinned === 'boolean' ? raw.pinned : undefined,
    team: teamName ? slug(teamRaw.id ?? teamName) : undefined,
    teamName,
    status: STATUSES.includes(raw.status) ? raw.status : undefined,
    activity: clip(raw.activity),
    tool: clip(raw.tool, 40),
    text: clip(raw.text),
    task: clip(raw.task, 120),
    stage: clip(raw.stage, 24),
    stay: raw.stay === true || undefined,
    to: undefined,
    subagent: undefined,
  };

  if (raw.to != null) {
    const list = Array.isArray(raw.to) ? raw.to : [raw.to];
    ev.to = list.filter((x) => x != null).map((x) => String(x).slice(0, 128)).slice(0, 16);
  }
  // Adapters that only know "a subagent of type X under session Y" pass a hint.
  // The reducer binds the hint to a concrete desk (see resolveSubagent).
  if (raw.subagent && typeof raw.subagent === 'object') {
    ev.subagent = {
      key: raw.subagent.key != null ? String(raw.subagent.key).slice(0, 128) : undefined,
      type: clip(raw.subagent.type, 40),
    };
  }
  for (const k of Object.keys(ev)) if (ev[k] === undefined) delete ev[k];
  return ev;
}

const TEAM_HUES = [212, 152, 28, 340, 262, 188, 96, 8];

function ensureTeam(state, id, name, now) {
  let team = state.teams[id];
  if (!team) {
    const order = Object.keys(state.teams).length;
    team = state.teams[id] = {
      id,
      name: name || titleCase(id),
      hue: TEAM_HUES[order % TEAM_HUES.length],
      order,
      task: undefined,
      createdAt: now,
    };
  } else if (name && team.name !== name) {
    team.name = name;
  }
  return team;
}

function ensureAgent(state, ev, now) {
  let agent = state.agents[ev.agent];
  const teamId = ev.team || agent?.team || (ev.parent && state.agents[ev.parent]?.team) || 'default';
  ensureTeam(state, teamId, ev.teamName, now);
  if (!agent) {
    agent = state.agents[ev.agent] = {
      id: ev.agent,
      name: ev.name || titleCase(ev.agent.split(/[:/]/).pop() || ev.agent),
      role: ev.role || 'Agent',
      team: teamId,
      source: ev.source || 'custom',
      account: ev.account,
      machine: ev.machine,
      parent: ev.parent || undefined,
      status: 'idle',
      activity: undefined,
      tool: undefined,
      joinedAt: now,
      lastSeen: now,
      history: [],
      boundKey: undefined,
      stage: undefined,
      stay: undefined,
    };
  } else {
    // A roster desk's name, role and room come from the rooms file only.
    if (!agent.pinned || ev.pinned) {
      if (ev.name) agent.name = ev.name;
      if (ev.role) agent.role = ev.role;
      if (ev.source) agent.source = ev.source;
      if (ev.account) agent.account = ev.account;
      if (ev.machine) agent.machine = ev.machine;
      if (ev.team && ev.team !== agent.team) agent.team = ev.team;
    }
    if (ev.parent) agent.parent = ev.parent;
    agent.lastSeen = now;
  }
  if (ev.stage !== undefined) agent.stage = ev.stage || undefined;
  if (ev.stay) agent.stay = true;
  if (ev.pinned === true) {
    agent.pinned = true;
    if (ev.type === 'join') agent.idleActivity = ev.activity;
  } else if (ev.pinned === false) {
    delete agent.pinned;
    delete agent.idleActivity;
    delete agent.spawns;
  }
  return agent;
}

/** A roster desk with no spawn left goes back to its idle line, free for the next one. */
function standDown(agent) {
  agent.status = 'idle';
  agent.activity = agent.idleActivity;
  agent.tool = undefined;
  agent.parent = undefined;
  agent.boundKey = undefined;
  delete agent.spawns;
}

/**
 * When an adapter reports work done inside a subagent it can only say
 * "subagent of type T (opaque key K) under parent P". Bind that to the oldest
 * unbound, still-active desk of the same type, or open a new desk.
 */
function resolveSubagent(state, ev) {
  if (!ev.subagent) return ev;
  const parentId = ev.agent;
  const { key, type } = ev.subagent;
  const children = Object.values(state.agents).filter((a) => a.parent === parentId);
  // A busy roster desk takes every subagent of its type from its room, so parallel
  // spawns of one type, even from two leads, share the desk. It never binds a key.
  const team = state.agents[parentId]?.team;
  const desk = type && Object.values(state.agents).find((a) => a.pinned && a.spawns && a.role === type && a.team === team);
  let match = desk || (key && children.find((a) => a.boundKey === key));
  if (!match && type) {
    match = children
      .filter((a) => !a.boundKey && a.role === type && a.status !== 'done' && a.status !== 'offline')
      .sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (match && key) match.boundKey = key;
  }
  const id = match ? match.id : `${parentId}:${key || slug(type || 'sub')}`;
  const next = { ...ev, agent: id, parent: parentId, role: ev.role || type };
  delete next.subagent;
  if (!match && key) {
    next.__bindKey = key;
  }
  return next;
}

/**
 * A helper kept at its desk (`stay`) is reused when the same parent spawns the
 * same role again after it finished: the new spawn id becomes an alias for that
 * desk, and every later event for either id lands there.
 */
function applyAliases(state, ev) {
  const aliases = (state.aliases ||= {});
  if (ev.type === 'join' && ev.parent && ev.role && !state.agents[ev.agent] && !aliases[ev.agent]) {
    const parent = aliases[ev.parent] || ev.parent;
    const reuse = Object.values(state.agents).find(
      (a) => a.parent === parent && a.stay && a.role === ev.role && a.status === 'done',
    );
    if (reuse) {
      aliases[ev.agent] = reuse.id;
      reuse.boundKey = undefined;
      reuse.stage = undefined;
      // The desk keeps the name it already has.
      const { name, ...rest } = ev;
      ev = rest;
    }
  }
  const map = (id) => aliases[id] || id;
  const out = { ...ev, agent: map(ev.agent) };
  if (ev.parent) out.parent = map(ev.parent);
  if (ev.to) out.to = ev.to.map(map);
  return out;
}

/** The desk an agent id lands on, after aliases from reused helpers. */
export function deskOf(state, id) {
  return state.aliases?.[id] || id;
}

function pushHistory(agent, entry) {
  agent.history.push(entry);
  if (agent.history.length > MAX_HISTORY) agent.history.splice(0, agent.history.length - MAX_HISTORY);
}

/**
 * Apply one normalised event. Mutates and returns state.
 * Also returns `effects`: transient things the renderer animates (messages, arrivals).
 */
export function applyEvent(state, rawEv) {
  const effects = [];
  if (!rawEv) return { state, effects };
  const now = rawEv.ts || Date.now();
  state.seq += 1;
  state.updatedAt = now;

  if (rawEv.type === 'reset') {
    state.teams = {};
    state.agents = {};
    state.aliases = {};
    effects.push({ kind: 'reset' });
    return { state, effects };
  }

  const ev = resolveSubagent(state, applyAliases(state, rawEv));
  const existed = Boolean(state.agents[ev.agent]);
  const agent = ensureAgent(state, ev, now);
  if (ev.__bindKey) agent.boundKey = ev.__bindKey;
  if (!existed || agent.status === 'offline') effects.push({ kind: 'arrive', agent: agent.id });

  switch (ev.type) {
    case 'join': {
      if (existed && ev.pinned) {
        // The rooms file was read again. A desk in the middle of a spawn keeps working.
        if (!agent.spawns) standDown(agent);
        break;
      }
      // Spawns of one roster type can overlap; the desk stays busy until the last one ends.
      if (agent.pinned && ev.parent) agent.spawns = (agent.spawns || 0) + 1;
      agent.status = ev.status || 'idle';
      if (ev.activity) agent.activity = ev.activity;
      if (ev.parent) {
        // A spawned agent: the parent briefs it.
        effects.push({ kind: 'message', from: ev.parent, to: agent.id, text: ev.text || ev.activity || 'New task' });
      }
      pushHistory(agent, { ts: now, kind: 'join', text: ev.activity || 'Joined' });
      break;
    }
    case 'status': {
      // `pinned` only comes from the server (settlePinned), which resets the desk outright.
      if (agent.pinned && (ev.pinned || ev.parent === null)) {
        agent.spawns = ev.pinned ? 0 : Math.max(0, (agent.spawns || 0) - 1);
        if (agent.spawns) break;
        standDown(agent);
        pushHistory(agent, { ts: now, kind: 'status', status: agent.status, text: agent.activity || agent.status });
        break;
      }
      if (ev.status) agent.status = ev.status;
      if (ev.activity !== undefined) agent.activity = ev.activity;
      if (ev.status && ev.status !== 'working') agent.tool = undefined;
      pushHistory(agent, { ts: now, kind: 'status', status: agent.status, text: ev.activity || agent.status });
      break;
    }
    case 'tool': {
      agent.status = ev.status || 'working';
      agent.tool = ev.tool;
      agent.activity = ev.activity || (ev.tool ? `Using ${ev.tool}` : agent.activity);
      pushHistory(agent, { ts: now, kind: 'tool', tool: ev.tool, text: agent.activity });
      break;
    }
    case 'message': {
      const targets = ev.to?.length ? ev.to : agent.parent ? [agent.parent] : [];
      for (const to of targets) {
        if (!state.agents[to]) {
          ensureAgent(state, { agent: to, team: agent.team }, now);
          effects.push({ kind: 'arrive', agent: to });
        }
        effects.push({ kind: 'message', from: agent.id, to, text: ev.text || '' });
      }
      if (ev.status) agent.status = ev.status;
      pushHistory(agent, { ts: now, kind: 'message', to: targets, text: ev.text || '' });
      break;
    }
    case 'task': {
      const team = state.teams[agent.team];
      if (team && ev.task) team.task = ev.task;
      if (ev.status) agent.status = ev.status;
      pushHistory(agent, { ts: now, kind: 'task', text: ev.task || '' });
      break;
    }
    case 'leave': {
      agent.status = 'offline';
      agent.tool = undefined;
      agent.activity = ev.activity || 'Left';
      effects.push({ kind: 'leave', agent: agent.id });
      pushHistory(agent, { ts: now, kind: 'leave', text: agent.activity });
      // Helpers kept at their desks go home with whoever brought them.
      for (const kid of Object.values(state.agents)) {
        if (kid.parent !== agent.id || !kid.stay || kid.status === 'offline') continue;
        kid.status = 'offline';
        kid.tool = undefined;
        kid.activity = 'Left';
        kid.lastSeen = now;
        effects.push({ kind: 'leave', agent: kid.id });
        pushHistory(kid, { ts: now, kind: 'leave', text: 'Left' });
      }
      break;
    }
  }
  // `actor` is the desk the event landed on, which differs from `ev.agent` for subagent hints.
  return { state, effects, actor: agent.id };
}

/**
 * Roster desks to send back to idle: finished (or walked out) more than `doneMs`
 * ago, or silent for `stuckMs` because their subagent was interrupted.
 * Returns events, so the server can broadcast them like any other.
 */
export function settlePinned(state, now = Date.now(), { doneMs = 45_000, stuckMs = 30 * 60_000 } = {}) {
  const settled = ['done', 'error', 'offline'];
  return Object.values(state.agents)
    .filter((a) => {
      if (!a.pinned || a.status === 'idle') return false;
      const age = now - a.lastSeen;
      return (settled.includes(a.status) && age > doneMs) || age > stuckMs;
    })
    .map((a) => ({ type: 'status', agent: a.id, pinned: true }));
}

/**
 * Drop offline agents after a short grace period, finished helpers (agents with a
 * parent) after they have had time to celebrate unless they `stay`, and anything
 * silent for hours. Roster desks (`pinned`) are never dropped, so their rooms stay too.
 */
export function sweep(
  state,
  now = Date.now(),
  { offlineMs = 6_000, doneHelperMs = 45_000, staleMs = 2 * 60 * 60_000 } = {},
) {
  const expired = [];
  for (const a of Object.values(state.agents)) {
    if (a.pinned) continue;
    const age = now - a.lastSeen;
    if (
      (a.status === 'offline' && age > offlineMs) ||
      (a.status === 'done' && a.parent && !a.stay && age > doneHelperMs) ||
      age > staleMs
    ) {
      expired.push(a.id);
    }
  }
  return removeAgents(state, expired);
}

/** Remove agents along with the rooms and aliases they leave empty. Returns the ids that were there. */
export function removeAgents(state, ids) {
  const removed = [];
  for (const id of ids) {
    if (!state.agents[id]) continue;
    delete state.agents[id];
    removed.push(id);
  }
  const used = new Set(Object.values(state.agents).map((a) => a.team));
  for (const id of Object.keys(state.teams)) if (!used.has(id)) delete state.teams[id];
  if (state.aliases) for (const [k, v] of Object.entries(state.aliases)) if (!state.agents[v]) delete state.aliases[k];
  return removed;
}
