import { buildLines, clock, linesToText, type LogLine } from '../../shared/office-log.js';
import { store } from '../core/store';
import { icon } from './icons';

const OPEN_KEY = 'agent-floor:log-open';
const MAX_ROWS = 400;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * A running log of the floor in plain sentences. It follows the selected
 * agent's room (or shows every room), and follows replay.
 */
export class OfficeLog {
  private root = el('aside', 'office-log glass');
  private title = el('div', 'log-title');
  private list = el('ol', 'log-list');
  private emptyNote = el('p', 'log-empty', 'Nothing has happened yet.');
  private copyBtn = el('button', 'icon-btn', icon('copy')) as HTMLButtonElement;
  private renderedKey = '';
  private lines: LogLine[] = [];
  open = false;
  onToggle: (open: boolean) => void = () => {};

  constructor(container: HTMLElement) {
    this.root.setAttribute('aria-label', 'Office log');
    const head = el('div', 'log-head');
    const close = el('button', 'icon-btn close', icon('x')) as HTMLButtonElement;
    close.type = 'button';
    close.setAttribute('aria-label', 'Close the office log');
    close.addEventListener('click', () => this.setOpen(false));
    this.copyBtn.type = 'button';
    this.copyBtn.title = 'Copy the log as text';
    this.copyBtn.setAttribute('aria-label', 'Copy the log as text');
    this.copyBtn.addEventListener('click', () => this.copy());
    head.append(this.title, this.copyBtn, close);
    this.list.setAttribute('aria-live', 'polite');
    this.root.append(head, this.list, this.emptyNote);
    container.append(this.root);
    store.subscribe(() => this.render());
    try {
      if (localStorage.getItem(OPEN_KEY) === '1') this.setOpen(true);
    } catch {
      /* storage unavailable: starts closed */
    }
  }

  toggle() {
    this.setOpen(!this.open);
  }

  setOpen(open: boolean) {
    if (this.open === open) return;
    this.open = open;
    this.root.classList.toggle('show', open);
    try {
      localStorage.setItem(OPEN_KEY, open ? '1' : '0');
    } catch {
      /* storage unavailable: only the next visit forgets the panel */
    }
    this.renderedKey = '';
    this.render();
    this.onToggle(open);
  }

  private render() {
    if (!this.open) return;
    const state = store.state;
    const until = store.replay?.t ?? Infinity;
    const team = store.selected ? state.agents[store.selected]?.team : undefined;
    const entries = store.entries;
    const key = `${store.backlog.length}:${entries.length}:${entries.at(-1)?.at}:${team}:${Math.floor(until / 1000)}`;
    if (key === this.renderedKey) return;
    this.renderedKey = key;

    this.lines = buildLines(store.backlog, entries, state, until).filter((l) => !team || l.team === team);
    if (this.lines.length > MAX_ROWS) this.lines = this.lines.slice(-MAX_ROWS);
    const teamName = team ? state.teams[team]?.name || team : 'All rooms';
    this.title.innerHTML = `<b>Office log</b><span>${esc(teamName)}</span>`;

    const stick = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;
    this.list.innerHTML = this.lines
      .map(
        (l) =>
          `<li class="lk-${l.kind}"><time>${clock(l.at)}</time><span class="log-who">${esc(l.who)}</span><span class="log-text">${esc(l.text)}</span></li>`,
      )
      .join('');
    this.emptyNote.hidden = this.lines.length > 0;
    if (stick) this.list.scrollTop = this.list.scrollHeight;
  }

  private async copy() {
    try {
      await navigator.clipboard.writeText(linesToText(this.lines));
      this.copyBtn.innerHTML = icon('check');
      setTimeout(() => (this.copyBtn.innerHTML = icon('copy')), 1400);
    } catch {
      /* clipboard blocked: the log is still selectable */
    }
  }
}
