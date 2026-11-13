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

/** What the /stream snapshot carries besides `state`: the floor at `baseAt` and every change since. */
export interface History {
  base: WorldState;
  baseAt: number;
  recent: LogEntry[];
}

export interface RecordingOptions {
  keepMs?: number;
  keepEntries?: number;
}

export class Recording {
  constructor(state: WorldState, at: number, opts?: RecordingOptions);
  static from(base: WorldState, start: number, entries: readonly LogEntry[], opts?: RecordingOptions): Recording;
  readonly base: WorldState;
  readonly start: number;
  readonly entries: readonly LogEntry[];
  readonly view: WorldState | null;
  record(entry: LogEntry): void;
  trim(now: number): void;
  seek(t: number): number;
  advance(t: number): { applied: number; effects: Effect[] };
  close(): void;
}
