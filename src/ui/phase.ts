import type { Match } from '../game/match';
import { TICK_HZ } from '../net/protocol';
import { SIEGE_OPENS_TICK, TOWERS_CRUMBLE_TICK, WILDFIRE_TICK } from '../sim/structures';

/**
 * Match clock, Dragon Egg pips, and the announcement banner.
 *
 * The phase gates only do their job if players can see them coming. A siege
 * window that opens silently reads as "my attacks randomly started working",
 * so the bar always shows what the next gate is and when it lands.
 */

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const GATES: Array<{ tick: number; name: string }> = [
  { tick: SIEGE_OPENS_TICK, name: 'siege opens' },
  { tick: TOWERS_CRUMBLE_TICK, name: 'towers crumble' },
  { tick: WILDFIRE_TICK, name: 'wildfire' },
];

function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class PhaseUI {
  private readonly bar = el<HTMLDivElement>('phaseBar');
  private readonly clock = el<HTMLElement>('clock');
  private readonly phaseName = el<HTMLElement>('phaseName');
  private readonly myEggs = el<HTMLElement>('myEggs');
  private readonly foeEggs = el<HTMLElement>('foeEggs');
  private readonly banner = el<HTMLDivElement>('banner');

  private lastPips = '';

  constructor(private readonly match: Match) {
    this.bar.hidden = false;
  }

  update() {
    // The sim freezes when a castle falls but the tick keeps counting, so the
    // clock has to be stopped explicitly or the summary sits behind a match
    // timer that is still running.
    if (this.match.outcome()) {
      this.bar.hidden = true;
      return;
    }

    const tick = this.match.stats().tick;
    this.clock.textContent = mmss(tick / TICK_HZ);

    const next = GATES.find((g) => tick < g.tick);
    this.phaseName.textContent = next
      ? `${next.name} in ${mmss((next.tick - tick) / TICK_HZ)}`
      : 'wildfire';

    const foe = this.match.side === 0 ? 1 : 0;
    const mine = this.match.dragonEggsLeft(this.match.side);
    const theirs = this.match.dragonEggsLeft(foe);
    const pips = `${mine}/${theirs}`;
    if (pips !== this.lastPips) {
      this.lastPips = pips;
      this.myEggs.textContent = pipString(mine);
      this.foeEggs.textContent = pipString(theirs);
    }

    for (const a of this.match.takeAnnouncements()) {
      this.show(a.text, a.kind);
    }
  }

  private show(text: string, kind: string) {
    const div = document.createElement('div');
    div.className = 'ann';
    if (kind === 'wildfire' || kind === 'awakening') div.classList.add('alarm');
    else if (kind === 'egg') div.classList.add('good');
    div.textContent = `${prefixFor(kind)} ${text}`;
    this.banner.hidden = false;
    this.banner.appendChild(div);
    setTimeout(() => {
      div.remove();
      if (!this.banner.children.length) this.banner.hidden = true;
    }, 3900);
  }
}

function pipString(n: number): string {
  return '🥚'.repeat(n) + '·'.repeat(Math.max(0, 3 - n));
}

function prefixFor(kind: string): string {
  switch (kind) {
    case 'siege': return '⚔️';
    case 'towers': return '🏹';
    case 'wildfire': return '🔥';
    case 'egg': return '💥';
    case 'awakening': return '🚨';
    default: return '•';
  }
}
