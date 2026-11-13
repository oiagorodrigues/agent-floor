import type { Effect, FloorEvent, WorldState } from './protocol';

/** One recorded change. `at` is when it was seen, on the recorder's clock. */
export interface LogEntry {
  at: number;
  event?: FloorEvent;
  /** The desk the event landed on, when that differs from `event.agent` (subagent hints). */
  actor?: string;
  removed?: string[];
}

export const KEEP_MS: number;
export const KEEP_ENTRIES: number;

export function applyEntry(state: WorldState, entry: LogEntry): Effect[];

export class Recording {
  constructor(state: WorldState, at: number, opts?: { keepMs?: number; keepEntries?: number });
  readonly start: number;
  readonly entries: readonly LogEntry[];
  readonly view: WorldState | null;
  record(entry: LogEntry): void;
  seek(t: number): number;
  advance(t: number): { applied: number; effects: Effect[] };
  close(): void;
}
