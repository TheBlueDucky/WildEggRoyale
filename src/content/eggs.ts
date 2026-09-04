import type { Rarity } from './animals';

/**
 * Egg tiers.
 *
 * Hatching is a channel, not a pickup. That is the whole point: a Legendary
 * takes 7 seconds of standing still in the open, which is what turns "I found
 * an egg" into a fight worth having. Higher tiers glow brighter and taller so
 * the good eggs advertise themselves to both players — the drama is designed in,
 * not hoped for.
 */

export interface EggTierDef {
  rarity: Rarity;
  glyph: string;
  hatchSeconds: number;
  /** Shell colour. */
  color: number;
  /** Light-pillar height in metres; 0 means no pillar. */
  pillarHeight: number;
  /** Announced to BOTH players when it spawns. */
  announce: boolean;
}

export const EGG_TIERS: Record<Rarity, EggTierDef> = {
  common: { rarity: 'common', glyph: '🥚', hatchSeconds: 2.0, color: 0xe8e2d5, pillarHeight: 0, announce: false },
  uncommon: { rarity: 'uncommon', glyph: '🟢', hatchSeconds: 3.0, color: 0x6fbf7f, pillarHeight: 0, announce: false },
  rare: { rarity: 'rare', glyph: '🔵', hatchSeconds: 4.0, color: 0x5b9bd5, pillarHeight: 9, announce: false },
  epic: { rarity: 'epic', glyph: '🟣', hatchSeconds: 5.5, color: 0xa96fd5, pillarHeight: 14, announce: false },
  legendary: { rarity: 'legendary', glyph: '🟡', hatchSeconds: 7.0, color: 0xf0c94c, pillarHeight: 22, announce: true },
  mythic: { rarity: 'mythic', glyph: '🔴', hatchSeconds: 8.5, color: 0xe05555, pillarHeight: 30, announce: true },
  ancient: { rarity: 'ancient', glyph: '🌈', hatchSeconds: 10.0, color: 0xff8ae2, pillarHeight: 40, announce: true },
};

/** Wire order. Eggs are sent by tier index, so never reorder this. */
export const TIER_ORDER: Rarity[] = [
  'common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'ancient',
];

export const TIER_INDEX: Record<Rarity, number> = Object.fromEntries(
  TIER_ORDER.map((r, i) => [r, i]),
) as Record<Rarity, number>;

/** Weighted tier table used by a spawn group. */
export type TierWeights = Partial<Record<Rarity, number>>;

/** How close you must be to channel an egg, in metres. */
export const HATCH_RADIUS = 2.6;

/** How long a full army holds an unclaimed animal before it is lost. */
export const OFFER_SECONDS = 15;

export const ARMY_SLOTS = 10;

/** CSS colours for rarity, used by the army panel and the replace modal. */
export const RARITY_CSS: Record<Rarity, string> = {
  common: '#b9b3a4',
  uncommon: '#6fbf7f',
  rare: '#5b9bd5',
  epic: '#a96fd5',
  legendary: '#f0c94c',
  mythic: '#e05555',
  ancient: '#ff8ae2',
};
