// Replay: a short recording of every change a floor has seen, and a view of
// the floor at any moment inside it. The reducer is deterministic, so the state
// at the start of the recording plus the entries up to a moment rebuild exactly
// what the floor looked like then.
import { applyEvent, removeAgents } from './protocol.js';

export const KEEP_MS = 30 * 60_000;
export const KEEP_ENTRIES = 5000;

/** Apply one recorded change to a state. Returns the effects to animate. */
export function applyEntry(state, entry) {
  if (entry.event) return applyEvent(state, entry.event).effects;
  if (entry.removed) removeAgents(state, entry.removed);
  return [];
}

export class Recording {
  #base;
  #start;
  #log = [];
  #view = null;
  /** Index of the first entry not yet applied to the view. */
  #cursor = 0;
  #keepMs;
  #keepEntries;

  constructor(state, at, { keepMs = KEEP_MS, keepEntries = KEEP_ENTRIES } = {}) {
    this.#base = structuredClone(state);
    this.#start = at;
    this.#keepMs = keepMs;
    this.#keepEntries = keepEntries;
  }

  /** A recording that starts from `base` (the floor at `start`) with `entries` played on top. */
  static from(base, start, entries, opts) {
    const rec = new Recording(base, start, opts);
    for (const entry of entries) rec.record(entry);
    return rec;
  }

  /** The floor at `start`. Plus `entries`, it rebuilds the latest state. Read only. */
  get base() {
    return this.#base;
  }

  get start() {
    return this.#start;
  }

  get entries() {
    return this.#log;
  }

  get view() {
    return this.#view;
  }

  /** Add a change, then trim. */
  record(entry) {
    this.#log.push(entry);
    this.trim(entry.at);
  }

  /** Fold entries past the count limit, or older than the time limit at `now`, into the starting state. */
  trim(now) {
    const log = this.#log;
    const cutoff = now - this.#keepMs;
    let drop = 0;
    while (drop < log.length && (log.length - drop > this.#keepEntries || log[drop].at < cutoff)) {
      applyEntry(this.#base, log[drop]);
      // A view parked on an entry that falls off the start moves forward with it.
      if (this.#view && drop >= this.#cursor) {
        applyEntry(this.#view, log[drop]);
        this.#cursor = drop + 1;
      }
      this.#start = log[drop].at;
      drop++;
    }
    if (drop) {
      log.splice(0, drop);
      this.#cursor = Math.max(0, this.#cursor - drop);
    }
  }

  /** Rebuild the floor as it was at `t`. Returns the moment it landed on, clamped to the start. */
  seek(t) {
    t = Math.max(this.#start, t);
    const view = structuredClone(this.#base);
    let i = 0;
    while (i < this.#log.length && this.#log[i].at <= t) applyEntry(view, this.#log[i++]);
    this.#view = view;
    this.#cursor = i;
    return t;
  }

  /** Play the view forward to `t`. Returns how many entries were applied and their effects. */
  advance(t) {
    const effects = [];
    let applied = 0;
    if (!this.#view) return { applied, effects };
    while (this.#cursor < this.#log.length && this.#log[this.#cursor].at <= t) {
      effects.push(...applyEntry(this.#view, this.#log[this.#cursor++]));
      applied++;
    }
    return { applied, effects };
  }

  /** Drop the view and go back to following the live floor. */
  close() {
    this.#view = null;
    this.#cursor = 0;
  }
}
