import type { Match } from '../game/match';
import { ANIMALS, ROLE_GLYPH, animalAt, type AnimalDef, type Role } from '../content/animals';
import { ARMY_SLOTS, RARITY_CSS } from '../content/eggs';

/**
 * The army panel and the replace modal.
 *
 * The replace decision is the signature mechanic of the whole game: you can
 * discover thirty animals in a match and keep ten, so every good egg after the
 * tenth costs you something. Two deliberate choices here:
 *
 *  1. It does NOT pause the game. A modal that freezes one player in a
 *     real-time P2P match either stalls the opponent or hands the chooser free
 *     safety. Instead the animal is held for OFFER_SECONDS while the world
 *     keeps running, so deciding under pressure IS the mechanic.
 *
 *  2. It shows role coverage, not just stats. "You would drop your only Siege"
 *     is the information that makes this a strategy decision rather than a
 *     number comparison.
 */

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class ArmyUI {
  private readonly panel = el<HTMLDivElement>('armyPanel');
  private readonly slotsEl = el<HTMLDivElement>('armySlots');
  private readonly modal = el<HTMLDivElement>('replaceModal');
  private readonly incomingEl = el<HTMLDivElement>('incoming');
  private readonly choicesEl = el<HTMLDivElement>('replaceChoices');
  private readonly timerEl = el<HTMLSpanElement>('offerTimer');
  private readonly warnEl = el<HTMLDivElement>('replaceWarning');
  private readonly declineBtn = el<HTMLButtonElement>('declineBtn');

  private modalOpen = false;
  private renderedArmy = '';

  constructor(private readonly match: Match) {
    this.declineBtn.addEventListener('click', () => this.match.requestDecline());

    // Number keys 1-9,0 pick a slot while the offer is up — much faster than
    // hunting for the mouse when you have twelve seconds.
    addEventListener('keydown', (e) => {
      if (!this.modalOpen) return;
      if (e.code === 'Escape') { this.match.requestDecline(); return; }
      const n = e.code.startsWith('Digit') ? Number(e.code.slice(5)) : NaN;
      if (Number.isNaN(n)) return;
      const slot = n === 0 ? 9 : n - 1;
      if (slot < this.match.myArmy().length) this.match.requestReplace(slot);
    });
  }

  update() {
    this.renderPanel();
    this.renderModal();
  }

  private renderPanel() {
    const army = this.match.myArmy();
    const key = army.join(',');
    if (key === this.renderedArmy) return; // DOM churn is not free at 60fps
    this.renderedArmy = key;

    this.panel.hidden = false;
    this.slotsEl.innerHTML = '';

    for (let i = 0; i < ARMY_SLOTS; i++) {
      const idx = army[i];
      const a = idx === undefined ? undefined : animalAt(idx);
      const slot = document.createElement('div');
      slot.className = a ? 'slot' : 'slot empty';
      if (a) {
        slot.style.borderColor = RARITY_CSS[a.rarity];
        slot.innerHTML = `<span class="g">${a.glyph}</span><span class="r">${ROLE_GLYPH[a.role]}</span>`;
        slot.title = `${a.name} — ${a.rarity} ${a.role}\n${a.hp} hp · ${a.damage} dmg · ${a.attackSpeed}/s`;
      } else {
        slot.textContent = String(i + 1);
      }
      this.slotsEl.appendChild(slot);
    }

    const count = this.slotsEl.querySelectorAll('.slot:not(.empty)').length;
    this.panel.classList.toggle('full', count >= ARMY_SLOTS);
  }

  private renderModal() {
    const offer = this.match.myOffer();

    if (!offer) {
      if (this.modalOpen) {
        this.modalOpen = false;
        this.modal.hidden = true;
      }
      return;
    }

    const incoming = animalAt(offer.animal);
    if (!incoming) return;

    this.timerEl.textContent = this.match.offerSecondsLeft().toFixed(1);

    if (this.modalOpen) return; // only rebuild the grid once per offer
    this.modalOpen = true;
    this.modal.hidden = false;

    this.incomingEl.innerHTML = card(incoming, true);
    this.incomingEl.style.borderColor = RARITY_CSS[incoming.rarity];

    const army = this.match.myArmy();
    this.choicesEl.innerHTML = '';

    army.forEach((idx, slot) => {
      const a = animalAt(idx);
      if (!a) return;
      const btn = document.createElement('button');
      btn.className = 'choice';
      btn.style.borderColor = RARITY_CSS[a.rarity];
      btn.innerHTML = `<span class="key">${slot === 9 ? 0 : slot + 1}</span>${card(a, false)}`;

      // Warn when this swap would wipe out a role you have only one of.
      const lost = this.soleHolderOf(army, slot);
      if (lost && lost !== incoming.role) {
        btn.classList.add('risky');
        btn.innerHTML += `<span class="lose">last ${ROLE_GLYPH[lost]} ${lost}</span>`;
      }

      btn.addEventListener('click', () => this.match.requestReplace(slot));
      this.choicesEl.appendChild(btn);
    });

    this.warnEl.textContent = this.compositionNote(army, incoming);
  }

  /** The role this slot is the only source of, if any. */
  private soleHolderOf(army: number[], slot: number): Role | null {
    const a = animalAt(army[slot] ?? -1);
    if (!a) return null;
    const others = army.filter((idx, i) => i !== slot && animalAt(idx)?.role === a.role);
    return others.length === 0 ? a.role : null;
  }

  private compositionNote(army: number[], incoming: AnimalDef): string {
    const roles = new Set(army.map((i) => animalAt(i)?.role).filter(Boolean) as Role[]);
    if (!roles.has('siege')) return 'Your army has no Siege — Dragon Eggs will take three times as long.';
    if (!roles.has('tank')) return 'Your army has no Tank — nothing is soaking damage for the rest.';
    if (roles.size <= 2) return 'Your army is very narrow. Consider breadth over raw stats.';
    return `Incoming ${incoming.rarity} ${incoming.role}. Choose what it replaces.`;
  }
}

function card(a: AnimalDef, big: boolean): string {
  const dps = (a.damage * a.attackSpeed).toFixed(0);
  return `
    <span class="glyph${big ? ' big' : ''}">${a.glyph}</span>
    <span class="meta">
      <b style="color:${RARITY_CSS[a.rarity]}">${a.name}</b>
      <i>${ROLE_GLYPH[a.role]} ${a.role}${a.flying ? ' · 🪽' : ''}</i>
      <i>${a.hp} hp · ${dps} dps · ${a.range}m</i>
      ${big && a.ability ? `<i class="ability">${a.ability}</i>` : ''}
    </span>`;
}

/** Total roster size, shown in the HUD as a collection teaser. */
export const ROSTER_SIZE = ANIMALS.length;
