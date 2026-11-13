export type Status = 'idle' | 'thinking' | 'working' | 'waiting' | 'done' | 'error' | 'offline';
export type EventType = 'join' | 'status' | 'tool' | 'message' | 'task' | 'leave' | 'reset';

/** What clients POST to /events. Only `type` and `agent` are required. */
export interface InboundEvent {
  type: EventType;
  agent: string | { id: string; name?: string; role?: string; source?: string };
  name?: string;
  role?: string;
  source?: string;
  /** Which account or config the agent runs under, e.g. a Claude config dir label. */
  account?: string;
  /** Which computer the agent runs on (AGENT_FLOOR_MACHINE). */
  machine?: string;
  team?: string | { id?: string; name: string };
  /** On a roster desk, `null` ends one spawn; the desk goes back to idle after the last one. */
  parent?: string | null;
  /** Server only (roster desks from the rooms file). Dropped from events posted to /events. */
  pinned?: boolean;
  status?: Status;
  activity?: string;
  tool?: string;
  text?: string;
  task?: string;
  to?: string | string[];
  subagent?: { key?: string; type?: string };
  /** Short pipeline label shown on the name tag and card, e.g. "Stage 2". An empty string clears it. */
  stage?: string;
  /** On join with a parent: keep this helper at its desk after it finishes, until its parent leaves. */
  stay?: boolean;
  ts?: number;
}

export interface FloorEvent {
  type: EventType;
  ts: number;
  agent: string;
  name?: string;
  role?: string;
  source?: string;
  account?: string;
  machine?: string;
  parent?: string | null;
  pinned?: boolean;
  team?: string;
  teamName?: string;
  status?: Status;
  activity?: string;
  tool?: string;
  text?: string;
  task?: string;
  stage?: string;
  stay?: boolean;
  to?: string[];
}

export interface HistoryEntry {
  ts: number;
  kind: 'join' | 'status' | 'tool' | 'message' | 'task' | 'leave';
  text: string;
  tool?: string;
  status?: Status;
  to?: string[];
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  team: string;
  source: string;
  account?: string;
  machine?: string;
  parent?: string;
  status: Status;
  activity?: string;
  tool?: string;
  joinedAt: number;
  lastSeen: number;
  history: HistoryEntry[];
  boundKey?: string;
  stage?: string;
  stay?: boolean;
  /** A standing roster desk from the rooms file: never swept, so its room stays too. */
  pinned?: boolean;
  /** What a roster desk shows when no spawn is running. */
  idleActivity?: string;
  /** Spawns of this roster desk still running. */
  spawns?: number;
}

export interface Team {
  id: string;
  name: string;
  hue: number;
  order: number;
  task?: string;
  createdAt: number;
}

export interface WorldState {
  teams: Record<string, Team>;
  agents: Record<string, Agent>;
  /** Spawn ids folded into an existing desk, see `stay`. */
  aliases?: Record<string, string>;
  seq: number;
  updatedAt: number;
}

export type Effect =
  | { kind: 'reset' }
  | { kind: 'arrive'; agent: string }
  | { kind: 'leave'; agent: string }
  | { kind: 'message'; from: string; to: string; text: string };

export const PROTOCOL_VERSION: number;
export const STATUSES: Status[];
export const EVENT_TYPES: EventType[];
export function createState(): WorldState;
export function slug(value: unknown): string;
export function normalizeEvent(raw: unknown, now?: number): FloorEvent | null;
export function deskOf(state: WorldState, id: string): string;
export function applyEvent(state: WorldState, ev: FloorEvent | null): { state: WorldState; effects: Effect[]; actor?: string };
export function removeAgents(state: WorldState, ids: string[]): string[];
export function settlePinned(state: WorldState, now?: number, opts?: { doneMs?: number; stuckMs?: number }): InboundEvent[];
export function sweep(state: WorldState, now?: number, opts?: { offlineMs?: number; doneHelperMs?: number; staleMs?: number }): string[];
