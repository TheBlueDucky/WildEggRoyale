/**
 * Ability data + the vocabulary its executor understands.
 *
 * Everything is data so that adding an animal never means touching sim code.
 * The executor is ONE switch in one file (sim/effects.ts) — a small interpreter,
 * not a scripting language. That boundary is the whole point: the moment
 * abilities can express arbitrary logic, the "content is data" property dies and
 * every new animal becomes a netcode risk.
 */

export type EffectType =
  | 'status'
  | 'lifesteal'
  | 'knockback'
  | 'multi'
  | 'chain'
  | 'aura'
  | 'revive'
  | 'stealth'
  | 'armor';

export type StatusKind = 'poison' | 'slow' | 'stun' | 'buff';

export interface Effect {
  type: EffectType;
  /** status */
  status?: StatusKind;
  durationSec?: number;
  /** poison damage per second */
  dps?: number;
  /** slow / buff / armor magnitude, 0..1 */
  amount?: number;
  /** knockback distance in metres */
  distance?: number;
  /** multi/chain target count */
  targets?: number;
  /** aura radius in metres */
  radius?: number;
  /** fires on every Nth hit; 1 = every hit */
  everyNthHit?: number;
  /** stealth cadence */
  cooldownSec?: number;
  /** revive at this fraction of max HP */
  atFraction?: number;
  /** armor applies only to this damage source */
  vs?: 'ranged' | 'all';
}

export interface AbilityDef {
  id: string;
  trigger: 'onHit' | 'onSpawn' | 'aura' | 'passive' | 'onDeath';
  effects: Effect[];
}

export const ABILITIES: Record<string, AbilityDef> = {
  pack_bond: {
    id: 'pack_bond', trigger: 'aura',
    effects: [{ type: 'aura', status: 'buff', amount: 0.15, radius: 8 }],
  },
  turtle_shell: {
    id: 'turtle_shell', trigger: 'passive',
    effects: [{ type: 'armor', amount: 0.4, vs: 'all' }],
  },
  bee_sting: {
    id: 'bee_sting', trigger: 'onHit',
    effects: [{ type: 'status', status: 'poison', durationSec: 3, dps: 4, everyNthHit: 1 }],
  },
  fox_focus: {
    id: 'fox_focus', trigger: 'passive',
    effects: [{ type: 'multi', targets: 1 }], // targeting rule, handled by AI
  },
  rhino_charge: {
    id: 'rhino_charge', trigger: 'onHit',
    effects: [{ type: 'knockback', distance: 6, everyNthHit: 3 }],
  },
  venom: {
    id: 'venom', trigger: 'onHit',
    effects: [{ type: 'status', status: 'poison', durationSec: 5, dps: 8, everyNthHit: 1 }],
  },
  owl_aura: {
    id: 'owl_aura', trigger: 'aura',
    effects: [{ type: 'aura', status: 'buff', amount: 0.2, radius: 8 }],
  },
  crab_plate: {
    id: 'crab_plate', trigger: 'passive',
    effects: [{ type: 'armor', amount: 0.3, vs: 'ranged' }],
  },
  bat_drain: {
    id: 'bat_drain', trigger: 'onHit',
    effects: [{ type: 'lifesteal', amount: 0.3, everyNthHit: 1 }],
  },
  ghost_step: {
    id: 'ghost_step', trigger: 'passive',
    effects: [{ type: 'stealth', durationSec: 4, cooldownSec: 15 }],
  },
  trunk_sweep: {
    id: 'trunk_sweep', trigger: 'onHit',
    effects: [{ type: 'knockback', distance: 3, everyNthHit: 4 }],
  },
  scorpion_sting: {
    id: 'scorpion_sting', trigger: 'onHit',
    effects: [{ type: 'status', status: 'stun', durationSec: 0.8, everyNthHit: 5 }],
  },
  burrow: {
    id: 'burrow', trigger: 'passive',
    effects: [{ type: 'stealth', durationSec: 2, cooldownSec: 12 }],
  },
  ink_slow: {
    id: 'ink_slow', trigger: 'onHit',
    effects: [{ type: 'status', status: 'slow', durationSec: 2.5, amount: 0.35, everyNthHit: 1 }],
  },
  lion_roar: {
    id: 'lion_roar', trigger: 'onHit',
    effects: [{ type: 'status', status: 'stun', durationSec: 1.5, everyNthHit: 6 }],
  },
  golem_stance: {
    id: 'golem_stance', trigger: 'passive',
    effects: [{ type: 'armor', amount: 0.25, vs: 'all' }],
  },
  rebirth: {
    id: 'rebirth', trigger: 'onDeath',
    effects: [{ type: 'revive', atFraction: 0.4 }],
  },
  tentacle_pull: {
    id: 'tentacle_pull', trigger: 'onHit',
    effects: [{ type: 'knockback', distance: -4, everyNthHit: 3 }], // negative = pull
  },
  three_heads: {
    id: 'three_heads', trigger: 'passive',
    effects: [{ type: 'multi', targets: 3 }],
  },
  chain_lightning: {
    id: 'chain_lightning', trigger: 'onHit',
    effects: [{ type: 'chain', targets: 3, amount: 0.5, everyNthHit: 1 }],
  },
  petrify: {
    id: 'petrify', trigger: 'onHit',
    effects: [{ type: 'status', status: 'stun', durationSec: 1.5, everyNthHit: 6 }],
  },
  dragon_breath: {
    id: 'dragon_breath', trigger: 'onHit',
    effects: [{ type: 'multi', targets: 3 }],
  },
  world_shell: {
    id: 'world_shell', trigger: 'aura',
    effects: [{ type: 'aura', status: 'buff', amount: -0.25, radius: 10 }], // negative buff = damage reduction
  },
};

export function abilityDef(id: string | undefined): AbilityDef | undefined {
  return id ? ABILITIES[id] : undefined;
}

/**
 * Animal id -> ability id.
 *
 * Kept here rather than as a field on AnimalDef so that ANIMALS stays exactly
 * as it is — that array's ORDER is the wire format for animal references, and
 * the fewer reasons to edit it, the better.
 */
export const ANIMAL_ABILITY: Record<string, string> = {
  wolf: 'pack_bond',
  turtle: 'turtle_shell',
  bee: 'bee_sting',
  fox: 'fox_focus',
  rhino: 'rhino_charge',
  venom_snake: 'venom',
  owl_mage: 'owl_aura',
  crab: 'crab_plate',
  bat: 'bat_drain',
  ghost_fox: 'ghost_step',
  elephant: 'trunk_sweep',
  scorpion: 'scorpion_sting',
  badger: 'burrow',
  octopus: 'ink_slow',
  lion: 'lion_roar',
  golem: 'golem_stance',
  phoenix: 'rebirth',
  kraken_spawn: 'tentacle_pull',
  cerberus: 'three_heads',
  thunderbird: 'chain_lightning',
  basilisk: 'petrify',
  ancient_dragon: 'dragon_breath',
  world_turtle: 'world_shell',
};
