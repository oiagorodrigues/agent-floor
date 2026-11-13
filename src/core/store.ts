import { applyEvent, createState, normalizeEvent, removeAgents, sweep } from '../../shared/protocol.js';
import { Recording } from '../../shared/replay.js';
import type { Effect, FloorEvent, InboundEvent, WorldState } from '../../shared/protocol';
import type { LogEntry } from '../../shared/replay';

export type ConnectionMode = 'connecting' | 'live' | 'demo' | 'offline';

/** What the scene animates. `jump` means "the view moved in time: place everyone instantly". */
export type ViewEffect = Effect | { kind: 'jump' };

type Listener = () => void;
type EffectListener = (effect: ViewEffect) => void;

export interface ReplayState {
  /** The moment the view shows, on the same clock as LogEntry.at. */
  t: number;
  playing: boolean;
  speed: number;
}

/**
 * Single source of truth for the browser. The same reducer runs on the server,
 * so a snapshot plus the event stream reproduces the server state exactly.
 * Every change is also recorded, which is what replay plays back.
 */
class Store {
  mode: ConnectionMode = 'connecting';
  selected: string | null = null;
  replay: ReplayState | null = null;

  private live: WorldState = createState();
  private recording = new Recording(this.live, Date.now());
  /** Events the server saw before this window connected. Only the office log reads them. */
  private before: LogEntry[] = [];
  private listeners = new Set<Listener>();
  private effectListeners = new Set<EffectListener>();

  /** What the scene and HUD show: the live floor, or the replayed moment. */
  get state(): WorldState {
    return this.recording.view ?? this.live;
  }

  /** Earliest moment replay can show. */
  get start() {
    return this.recording.start;
  }

  /** The recorded changes, oldest first. */
  get entries(): readonly LogEntry[] {
    return this.recording.entries;
  }

  get backlog(): readonly LogEntry[] {
    return this.before;
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onEffect(fn: EffectListener) {
    this.effectListeners.add(fn);
    return () => this.effectListeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private emitEffects(effects: ViewEffect[]) {
    for (const e of effects) for (const fn of this.effectListeners) fn(e);
  }

  setMode(mode: ConnectionMode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.emit();
  }

  select(id: string | null) {
    if (this.selected === id) return;
    this.selected = id;
    this.emit();
  }

  replace(state: WorldState, before: LogEntry[] = []) {
    this.live = state;
    this.before = before;
    this.recording = new Recording(state, Date.now());
    this.replay = null;
    this.emitEffects([{ kind: 'reset' }]);
    this.emit();
  }

  /** Apply an event that the server already normalised, with the effects it computed. */
  applyRemote(event: FloorEvent, effects: Effect[]) {
    const { actor } = applyEvent(this.live, event);
    this.record({ at: Date.now(), event: structuredClone(event), actor });
    if (this.replay) return this.emit();
    // State first so the scene has every character before effects animate them.
    this.emit();
    this.emitEffects(effects);
  }

  /** Apply a raw event locally (demo mode). */
  applyLocal(raw: InboundEvent) {
    const ev = normalizeEvent(raw);
    if (!ev) return;
    const { effects, actor } = applyEvent(this.live, ev);
    this.record({ at: Date.now(), event: structuredClone(ev), actor });
    if (this.replay) return this.emit();
    this.emit();
    this.emitEffects(effects);
  }

  remove(ids: string[]) {
    const removed = removeAgents(this.live, ids);
    if (!removed.length) return;
    this.record({ at: Date.now(), removed });
    if (!this.replay && this.selected && !this.live.agents[this.selected]) this.selected = null;
    this.emit();
  }

  sweepLocal() {
    const removed = sweep(this.live);
    if (!removed.length) return;
    this.record({ at: Date.now(), removed });
    if (!this.replay && this.selected && removed.includes(this.selected)) this.selected = null;
    this.emit();
  }

  private record(entry: LogEntry) {
    const start = this.recording.start;
    this.recording.record(entry);
    // The backlog ends at a reset, and once the recording starts dropping its own
    // oldest entries, the backlog is older still.
    if (entry.event?.type === 'reset' || this.recording.start !== start) this.before = [];
    if (this.replay && this.replay.t < this.recording.start) this.replay.t = this.recording.start;
  }

  // ---------------------------------------------------------------- replay

  /** Go back to the start of the recording and play from there. */
  startReplay(speed = 4) {
    this.replay = { t: this.recording.start, playing: true, speed };
    this.seek(this.recording.start);
  }

  /** Back to the live floor. */
  stopReplay() {
    if (!this.replay) return;
    this.replay = null;
    this.recording.close();
    if (this.selected && !this.live.agents[this.selected]) this.selected = null;
    this.emitEffects([{ kind: 'jump' }]);
    this.emit();
  }

  setPlaying(playing: boolean) {
    if (!this.replay || this.replay.playing === playing) return;
    this.replay.playing = playing;
    this.emit();
  }

  setSpeed(speed: number) {
    if (!this.replay) return;
    this.replay.speed = speed;
    this.emit();
  }

  /** Jump to a moment: rebuild it from the start of the recording and place everyone instantly. */
  seek(t: number) {
    if (!this.replay) return;
    if (t >= Date.now()) return this.stopReplay();
    this.replay.t = this.recording.seek(t);
    this.dropMissingSelection();
    this.emitEffects([{ kind: 'jump' }]);
    this.emit();
  }

  /**
   * Play forward to `t`, animating what happened on the way (paper planes, arrivals).
   * Returns false when nothing on the floor changed, so the caller only has to move the playhead.
   */
  advance(t: number): boolean {
    if (!this.replay) return false;
    if (t >= Date.now()) {
      this.stopReplay();
      return true;
    }
    this.replay.t = t;
    const { applied, effects } = this.recording.advance(t);
    if (!applied) return false;
    this.dropMissingSelection();
    this.emit();
    this.emitEffects(effects);
    return true;
  }

  private dropMissingSelection() {
    const view = this.recording.view;
    if (view && this.selected && !view.agents[this.selected]) this.selected = null;
  }
}

export const store = new Store();
