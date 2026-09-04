/**
 * The animal roster.
 *
 * Part of the content bundle, so any edit changes the content hash and
 * mismatched builds refuse to play each other.
 *
 * WIRE FORMAT WARNING: animals are referenced over the network by their INDEX
 * in ANIMALS. Append new animals at the end; never reorder or delete. The
 * content hash catches a mismatch, but only by refusing the match — which is
 * correct, and also why insertions in the middle would be maddening.
 *
 * Rarity is not power. Turtle (uncommon) out-tanks Stag (rare); Beaver
 * (uncommon) out-sieges everything below Golem; Peregrine (epic) has 150 HP and
 * dies to a stiff breeze. That is the design intent from the pitch — rarer
 * animals should be *different*, not simply stronger.
 */

export type Rarity =
  | 'common'
  | 'uncommon'
  | 'rare'
  | 'epic'
  | 'legendary'
  | 'mythic'
  | 'ancient';

export type Role =
  | 'dps'
  | 'tank'
  | 'ranged'
  | 'assassin'
  | 'support'
  | 'controller'
  | 'siege';

export interface AnimalDef {
  id: string;
  name: string;
  glyph: string;
  rarity: Rarity;
  role: Role;
  flying: boolean;
  hp: number;
  damage: number;
  /** Attacks per second. DPS = damage x attackSpeed. */
  attackSpeed: number;
  /** Metres. */
  range: number;
  /** Metres per second. */
  moveSpeed: number;
  /** Short description of the special behaviour; implemented in M3. */
  ability?: string;
}

const A = (
  id: string, name: string, glyph: string,
  rarity: Rarity, role: Role, flying: boolean,
  hp: number, damage: number, attackSpeed: number, range: number, moveSpeed: number,
  ability?: string,
): AnimalDef => ({ id, name, glyph, rarity, role, flying, hp, damage, attackSpeed, range, moveSpeed, ability });

export const ANIMALS: AnimalDef[] = [
  // --- common ---
  A('chicken', 'Chicken', '🐔', 'common', 'dps', false, 70, 10, 1.6, 1.5, 5.0),
  A('rat', 'Rat', '🐀', 'common', 'assassin', false, 60, 8, 2.0, 1.5, 6.5),
  A('boar', 'Boar', '🐗', 'common', 'tank', false, 160, 14, 1.0, 1.8, 4.5),
  A('frog', 'Frog', '🐸', 'common', 'ranged', false, 90, 12, 1.2, 5.0, 4.0),
  A('sheep', 'Sheep', '🐑', 'common', 'tank', false, 200, 6, 0.8, 1.5, 3.5),

  // --- uncommon ---
  A('wolf', 'Wolf', '🐺', 'uncommon', 'dps', false, 140, 18, 1.4, 1.8, 7.0, '+15% damage per nearby Wolf (max 4)'),
  A('hawk', 'Hawk', '🦅', 'uncommon', 'ranged', true, 110, 16, 1.3, 9.0, 8.0),
  A('turtle', 'Turtle', '🐢', 'uncommon', 'tank', false, 700, 9, 0.6, 1.5, 2.2, '-40% damage taken while stationary'),
  A('bee', 'Bee', '🐝', 'uncommon', 'dps', true, 55, 7, 2.4, 1.5, 9.0, 'poison stacks'),
  A('beaver', 'Beaver', '🦫', 'uncommon', 'siege', false, 220, 20, 0.9, 1.8, 4.0),
  A('fox', 'Fox', '🦊', 'uncommon', 'assassin', false, 120, 22, 1.2, 1.8, 7.5, 'always targets the lowest-HP enemy'),

  // --- rare ---
  A('rhino', 'Rhino', '🦏', 'rare', 'tank', false, 520, 40, 0.7, 2.0, 5.0, 'charge, knockback 6m'),
  A('venom_snake', 'Venom Snake', '🐍', 'rare', 'controller', false, 130, 9, 1.5, 2.5, 4.5, 'poison 8 dps for 5s'),
  A('owl_mage', 'Owl Mage', '🦉', 'rare', 'support', false, 100, 12, 1.0, 10.0, 5.0, 'aura: +20% ally damage, 8m'),
  A('bear', 'Bear', '🐻', 'rare', 'tank', false, 600, 45, 0.8, 2.0, 4.2),
  A('stag', 'Stag', '🦌', 'rare', 'dps', false, 300, 26, 1.1, 1.8, 8.0),
  A('crab', 'Crab', '🦀', 'rare', 'tank', false, 450, 18, 1.0, 1.5, 2.5, '-30% ranged damage taken'),
  A('bat', 'Bat', '🦇', 'rare', 'dps', true, 90, 11, 1.8, 1.5, 8.5, '30% lifesteal'),

  // --- epic ---
  A('ghost_fox', 'Ghost Fox', '👻', 'epic', 'assassin', false, 200, 34, 1.3, 1.8, 8.0, 'invisible 4s every 15s'),
  A('elephant', 'Elephant', '🐘', 'epic', 'tank', false, 1100, 55, 0.6, 2.5, 3.2, 'knockback aura'),
  A('scorpion', 'Scorpion', '🦂', 'epic', 'controller', false, 260, 20, 1.4, 2.0, 5.5, 'stun 0.8s every 5th hit'),
  A('peregrine', 'Peregrine', '🪶', 'epic', 'ranged', true, 150, 60, 0.5, 16.0, 7.0),
  A('badger', 'Badger', '🦡', 'epic', 'dps', false, 380, 30, 1.2, 1.8, 5.0, 'burrow: immune 2s'),
  A('octopus', 'Octopus', '🐙', 'epic', 'controller', false, 340, 16, 1.6, 7.0, 3.0, 'slows target 35%'),

  // --- legendary ---
  A('lion', 'Lion', '🦁', 'legendary', 'dps', false, 900, 70, 1.0, 2.2, 6.5, 'roar: fear nearby 1.5s'),
  A('griffin', 'Griffin', '🦅', 'legendary', 'dps', true, 700, 55, 1.1, 3.0, 8.5),
  A('golem', 'Golem', '🗿', 'legendary', 'siege', false, 1800, 50, 0.5, 2.5, 2.5, 'knockback-immune'),
  A('phoenix', 'Phoenix', '🔥', 'legendary', 'support', true, 500, 45, 1.2, 6.0, 8.0, 'revives once at 40% HP'),
  A('kraken_spawn', 'Kraken Spawn', '🦑', 'legendary', 'controller', false, 800, 38, 1.0, 9.0, 3.0, 'tentacle pull'),

  // --- mythic ---
  A('cerberus', 'Cerberus', '🐕', 'mythic', 'dps', false, 1500, 85, 1.1, 2.5, 6.0, 'strikes 3 targets'),
  A('thunderbird', 'Thunderbird', '⚡', 'mythic', 'ranged', true, 1000, 70, 0.9, 12.0, 8.0, 'chain lightning, 3 jumps'),
  A('basilisk', 'Basilisk', '🐍', 'mythic', 'controller', false, 1200, 60, 1.0, 5.0, 5.0, 'petrify 1.5s every 6th hit'),

  // --- ancient ---
  A('ancient_dragon', 'Ancient Dragon', '🐉', 'ancient', 'dps', true, 2500, 120, 1.0, 8.0, 7.0, 'AoE breath'),
  A('world_turtle', 'World Turtle', '🌍', 'ancient', 'support', false, 4000, 40, 0.6, 2.0, 1.8, 'allies within 10m take -25% damage'),
];

export const ANIMAL_INDEX: Record<string, number> = Object.fromEntries(
  ANIMALS.map((a, i) => [a.id, i]),
);

export const ANIMALS_BY_RARITY: Record<Rarity, number[]> = ANIMALS.reduce(
  (acc, a, i) => {
    acc[a.rarity].push(i);
    return acc;
  },
  {
    common: [], uncommon: [], rare: [], epic: [],
    legendary: [], mythic: [], ancient: [],
  } as Record<Rarity, number[]>,
);

export function animalAt(index: number): AnimalDef | undefined {
  return ANIMALS[index];
}

/**
 * Damage multiplier against structures, by role.
 *
 * This is what makes composition matter: ten Wolves are 252 DPS but only 76
 * against a Dragon Egg, while a siege comp does it in a third of the time.
 * Used from M4 onward; defined here so the roster and its rules live together.
 */
export const STRUCTURE_MULTIPLIER: Record<Role, number> = {
  siege: 2.0,
  tank: 0.5,
  dps: 0.3,
  ranged: 0.3,
  assassin: 0.2,
  controller: 0.2,
  support: 0.1,
};

export const ROLE_GLYPH: Record<Role, string> = {
  dps: '🗡️',
  tank: '🛡️',
  ranged: '🏹',
  assassin: '⚡',
  support: '❤️',
  controller: '🧙',
  siege: '🏰',
};
