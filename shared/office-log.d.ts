import type { FloorEvent, WorldState } from './protocol';
import type { LogEntry } from './replay';

export type LogKind = 'handoff' | 'tool' | 'attention' | 'done' | 'you' | 'board' | 'move';

export interface LogLine {
  at: number;
  team?: string;
  kind: LogKind;
  who: string;
  text: string;
}

export function clock(ts: number): string;
export function describe(ev: FloorEvent, nameOf: (id: string) => string, teamOf: (id: string) => string | undefined): LogLine | null;
export function buildLines(backlog: readonly LogEntry[], entries: readonly LogEntry[], state: WorldState, until: number): LogLine[];
export function linesToText(lines: readonly LogLine[], formatTime?: (ts: number) => string): string;
