import { applyEvent, createState, normalizeEvent, removeAgents, sweep } from '../../shared/protocol.js';
import type { Effect, FloorEvent, InboundEvent, WorldState } from '../../shared/protocol';

export type ConnectionMode = 'connecting' | 'live' | 'demo' | 'offline';

type Listener = () => void;
type EffectListener = (effect: Effect) => void;

/**
 * Single source of truth for the browser. The same reducer runs on the server,
 * so a snapshot plus the event stream reproduces the server state exactly.
 */
class Store {
  state: WorldState = createState();
  mode: ConnectionMode = 'connecting';
  selected: string | null = null;
  private listeners = new Set<Listener>();
  private effectListeners = new Set<EffectListener>();

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

  private emitEffects(effects: Effect[]) {
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

  replace(state: WorldState) {
    this.state = state;
    this.emitEffects([{ kind: 'reset' }]);
    this.emit();
  }

  /** Apply an event that the server already normalised, with the effects it computed. */
  applyRemote(event: FloorEvent, effects: Effect[]) {
    applyEvent(this.state, event);
    // State first so the scene has every character before effects animate them.
    this.emit();
    this.emitEffects(effects);
  }

  /** Apply a raw event locally (demo mode). */
  applyLocal(raw: InboundEvent) {
    const ev = normalizeEvent(raw);
    if (!ev) return;
    const { effects } = applyEvent(this.state, ev);
    this.emit();
    this.emitEffects(effects);
  }

  remove(ids: string[]) {
    const removed = removeAgents(this.state, ids);
    if (this.selected && !this.state.agents[this.selected]) this.selected = null;
    if (removed.length) this.emit();
  }

  sweepLocal() {
    const removed = sweep(this.state);
    if (removed.length) {
      if (this.selected && removed.includes(this.selected)) this.selected = null;
      this.emit();
    }
  }
}

export const store = new Store();
