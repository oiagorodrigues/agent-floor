// The last 30 minutes of the floor, kept in memory only: the state at the start
// of that window (`base`) and every change since (`recent`). A window that opens
// mid-run gets both, so it can replay and log the whole window. They hold only
// reduced state and the normalised events the stream already broadcasts.
import { createState } from '../shared/protocol.js';
import { Recording } from '../shared/replay.js';

export const RECENT_MS = 30 * 60_000;
export const RECENT_MAX = 2000;

export function createRecent({ keepMs = RECENT_MS, max = RECENT_MAX, now = Date.now } = {}) {
  const opts = { keepMs, keepEntries: max };
  let rec = new Recording(createState(), now(), opts);

  return {
    /** Start over from `state`, the floor right after a reset. */
    reset(state) {
      rec = new Recording(state, now(), opts);
    },
    add(event, actor) {
      rec.record(actor && actor !== event.agent ? { at: now(), event, actor } : { at: now(), event });
    },
    /** Agents the sweeper dropped. Recorded so `base` plus `recent` keeps matching the live floor. */
    removed(ids) {
      rec.record({ at: now(), removed: ids });
    },
    /** `{ base, baseAt, recent }`, trimmed to the window as of now. */
    history() {
      rec.trim(now());
      return { base: rec.base, baseAt: rec.start, recent: rec.entries };
    },
  };
}
