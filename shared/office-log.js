// The office log: floor events turned into plain sentences about who did what
// and who handed what to whom. It only reads events the floor already received,
// so it can never show more than the adapters chose to send.

export function clock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}

function tidy(id) {
  return (id.split(/[:/]/).pop() || id).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * One event as a sentence, or null when it is noise (the "Done: ..." status
 * that follows every tool call, for example).
 */
export function describe(ev, nameOf, teamOf) {
  const who = nameOf(ev.agent);
  const base = { at: ev.ts, team: ev.team || teamOf(ev.agent) };
  switch (ev.type) {
    case 'join':
      if (ev.parent) {
        return { ...base, team: base.team || teamOf(ev.parent), kind: 'handoff', who: `${nameOf(ev.parent)} → ${who}`, text: ev.text || ev.activity || 'New task' };
      }
      return { ...base, kind: 'move', who, text: 'Arrived' };
    case 'message': {
      const to = ev.to?.length ? ev.to.map(nameOf).join(', ') : 'their lead';
      return { ...base, kind: 'handoff', who: `${who} → ${to}`, text: ev.text || 'Sent a message' };
    }
    case 'tool':
      // Spawning a helper already reads as a handoff line.
      if (ev.tool === 'Task' || ev.tool === 'Agent') return null;
      return { ...base, kind: 'tool', who, text: ev.activity || (ev.tool ? `Using ${ev.tool}` : 'Working') };
    case 'task':
      return ev.task ? { ...base, kind: 'board', who: 'Whiteboard', text: ev.task } : null;
    case 'leave':
      return { ...base, kind: 'move', who, text: 'Left' };
    case 'status':
      if (ev.status === 'waiting') return { ...base, kind: 'attention', who, text: `Needs you: ${ev.activity || 'waiting for your reply'}` };
      if (ev.status === 'error') return { ...base, kind: 'attention', who, text: `Hit a problem: ${ev.activity || 'error'}` };
      if (ev.status === 'done') return { ...base, kind: 'done', who, text: ev.activity || 'Finished' };
      // Adapters send "Asked: <prompt>" only when the user opted in to sharing prompts.
      if (ev.activity?.startsWith('Asked: ')) return { ...base, kind: 'you', who: `You → ${who}`, text: ev.activity.slice(7) || '(empty prompt)' };
      return null;
    default:
      return null;
  }
}

/**
 * Every change up to `until` as sentences, with names as the floor knew them at
 * the time. `backlog` is what the server saw before this window connected, so
 * it all comes before any moment replay can reach.
 */
export function buildLines(backlog, entries, state, until) {
  const names = new Map();
  const teams = new Map();
  const nameOf = (id) => names.get(id) || state.agents[id]?.name || tidy(id);
  const teamOf = (id) => teams.get(id) || state.agents[id]?.team;
  const out = [];
  for (const e of [...backlog, ...entries]) {
    if (e.at > until) break;
    const ev = e.event;
    if (!ev || ev.type === 'reset') continue;
    const id = e.actor || ev.agent;
    // Learn names and rooms as they appear, so lines about agents that have since left still read well.
    if (ev.name && (ev.type === 'join' || !names.has(id))) names.set(id, ev.name);
    if (ev.team) teams.set(id, ev.team);
    else if (ev.parent && !teams.has(id)) {
      const t = teamOf(ev.parent);
      if (t) teams.set(id, t);
    }
    const line = describe(e.actor ? { ...ev, agent: e.actor } : ev, nameOf, teamOf);
    if (!line) continue;
    // "Report ready" followed by "Handed back results" is one moment: keep the handoff.
    const prev = out.at(-1);
    if (line.kind === 'done' && prev?.kind === 'handoff' && prev.who.startsWith(`${line.who} →`) && e.at - prev.at < 3000) continue;
    line.at = e.at;
    out.push(line);
  }
  return out;
}

/** The log as plain text, one line per row, for the clipboard. */
export function linesToText(lines, formatTime = clock) {
  return lines.map((l) => `${formatTime(l.at)}  ${l.who}: ${l.text}`).join('\n');
}
