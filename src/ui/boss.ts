import type { Match } from '../game/match';
import { DragonPhase, phaseName } from '../sim/dragon';
import { EntState } from '../sim/units';

/**
 * Boss bar and end-of-match summary.
 *
 * The boss bar exists because the dragon fight is the only moment in the match
 * where both players are working the same health pool, and neither can make a
 * decision about it without seeing the number.
 */

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class BossUI {
  private readonly bar = el<HTMLDivElement>('bossBar');
  private readonly fill = el<HTMLDivElement>('bossFill');
  private readonly label = el<HTMLDivElement>('bossLabel');
  private readonly summary = el<HTMLDivElement>('summary');
  private readonly summaryTitle = el<HTMLElement>('summaryTitle');
  private readonly summaryBody = el<HTMLElement>('summaryBody');

  private summaryShown = false;

  constructor(private readonly match: Match) {}

  update() {
    this.updateBoss();
    this.updateSummary();
  }

  private updateBoss() {
    const d = this.match.anyDragon();
    if (!d || d.state === EntState.Dead) {
      this.bar.hidden = true;
      return;
    }

    this.bar.hidden = false;
    const frac = Math.max(0, Math.min(1, d.hp / d.maxHp));
    this.fill.style.width = `${frac * 100}%`;

    const mine = d.side === this.match.side;
    const phase = d.phase as DragonPhase;
    this.fill.classList.toggle('enraged', phase === DragonPhase.Enraged);
    this.fill.classList.toggle('friendly', mine);

    const who = mine ? 'YOUR DRAGON' : 'ENEMY DRAGON';
    const suffix = phase === DragonPhase.Arriving
      ? ' — descending (invulnerable)'
      : phase === DragonPhase.Enraged
        ? ' — ENRAGED'
        : '';
    this.label.textContent = `🐉 ${who}${suffix}  ${Math.round(d.hp)} / ${d.maxHp}  [${phaseName(phase)}]`;
  }

  private updateSummary() {
    const outcome = this.match.outcome();
    if (!outcome || this.summaryShown) return;
    this.summaryShown = true;

    const won = outcome.winner === this.match.side;
    this.summary.hidden = false;
    this.summary.classList.toggle('won', won);
    this.summaryTitle.textContent = won ? '🏆 VICTORY' : '💀 DEFEAT';

    const foe = this.match.side === 0 ? 1 : 0;
    const mins = Math.floor(outcome.atTick / 20 / 60);
    const secs = Math.floor((outcome.atTick / 20) % 60);
    const army = this.match.myArmy().length;

    this.summaryBody.innerHTML = `
      <div>${won ? 'Your dragon burned their castle down.' : 'Their dragon burned your castle down.'}</div>
      <div class="stats">
        <span>match time <b>${mins}:${String(secs).padStart(2, '0')}</b></span>
        <span>army <b>${army}/10</b></span>
        <span>your eggs <b>${this.match.dragonEggsLeft(this.match.side)}/3</b></span>
        <span>their eggs <b>${this.match.dragonEggsLeft(foe)}/3</b></span>
      </div>
      <div class="hint">Reload to find another match.</div>`;
  }
}
