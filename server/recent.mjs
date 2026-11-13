// The last 30 minutes of events, kept in memory only, so a window that opens
// mid-run can still show the office log from the start. It holds the same
// normalised events the stream already broadcasts, nothing more.
export const RECENT_MS = 30 * 60_000;
export const RECENT_MAX = 2000;

export function createRecent({ keepMs = RECENT_MS, max = RECENT_MAX, now = Date.now } = {}) {
  let list = [];

  function trim(at) {
    const cutoff = at - keepMs;
    let drop = 0;
    while (drop < list.length && (list.length - drop > max || list[drop].at < cutoff)) drop++;
    if (drop) list = list.slice(drop);
  }

  return {
    add(event, actor) {
      const at = now();
      list.push(actor && actor !== event.agent ? { at, event, actor } : { at, event });
      trim(at);
    },
    clear() {
      list = [];
    },
    /** Entries oldest first, as `{ at, event, actor? }`. */
    entries() {
      trim(now());
      return list;
    },
  };
}
