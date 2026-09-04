import { TICK_HZ } from '../net/protocol';
import type { Side } from '../content/maps';
import { ANIMALS, type AnimalDef } from '../content/animals';
import { ANIMAL_ABILITY, abilityDef, type Effect } from '../content/abilities';

/**
 * Unit definitions and status state.
 *
 * Split out of world.ts so the World file stays about orchestration rather than
 * per-entity bookkeeping. Everything here is pure data + pure functions —
 * headless, like the rest of sim/.
 */

export const enum EntKind {
  Player = 0,
  Animal = 1,
  Structure = 2,
  Dragon = 3,
}

export const enum EntState {
  Alive = 0,
  Dead = 1,
}

/** How far an animal will wander from its owner before being pulled back. */
export const LEASH_RADIUS = 9;
/** How far a unit looks for something to fight. */
export const AGGRO_RANGE = 14;
/** Animals rejoin you at your castle this long after dying. */
export const ANIMAL_RESPAWN_TICKS = 20 * TICK_HZ;
/** Retarget cadence. Every tick would be pure waste at 40 units. */
export const RETARGET_TICKS = Math.round(0.5 * TICK_HZ);

export interface Ent {
  id: number;
  kind: EntKind;
  side: Side;
  /** Index into ANIMALS, or -1 for the player. */
  animal: number;
  /** Army slot this unit occupies, or -1. */
  slot: number;
  /** StructKind for structures, -1 otherwise. */
  struct: number;
  /** DragonPhase for dragons, 0 otherwise. */
  phase: number;
  /** Height above the ground in metres. Only fliers use it. */
  altitude: number;
  /** Tick this entity entered the world, for phase timing. */
  spawnTick: number;

  x: number;
  z: number;
  yaw: number;
  hp: number;
  maxHp: number;
  state: EntState;
  flying: boolean;
  radius: number;

  respawnAt: number;
  attackReadyAt: number;
  retargetAt: number;
  targetId: number;
  hitCount: number;

  /** Detached units hold a position instead of following their owner. */
  detached: boolean;
  orderX: number;
  orderZ: number;

  // --- status, all expressed as "active until tick" ---
  slowUntil: number;
  slowAmount: number;
  stunUntil: number;
  poisonUntil: number;
  poisonDps: number;
  poisonBy: Side;
  stealthUntil: number;
  stealthReadyAt: number;
  revived: boolean;
}

export function animalDef(e: Ent): AnimalDef | undefined {
  return e.animal >= 0 ? ANIMALS[e.animal] : undefined;
}

export function effectsFor(e: Ent, trigger: string): Effect[] {
  const def = animalDef(e);
  if (!def) return [];
  const ability = abilityDef(ANIMAL_ABILITY[def.id]);
  if (!ability || ability.trigger !== trigger) return [];
  return ability.effects;
}

export function passiveEffect(e: Ent, type: string): Effect | undefined {
  const def = animalDef(e);
  if (!def) return undefined;
  const ability = abilityDef(ANIMAL_ABILITY[def.id]);
  return ability?.effects.find((x) => x.type === type);
}

/** Current move speed after slows. */
export function speedOf(e: Ent, tick: number): number {
  const def = animalDef(e);
  const base = def ? def.moveSpeed : 8;
  if (tick < e.slowUntil) return base * (1 - e.slowAmount);
  return base;
}

export function isStunned(e: Ent, tick: number): boolean {
  return tick < e.stunUntil;
}

export function isStealthed(e: Ent, tick: number): boolean {
  return tick < e.stealthUntil;
}

/** Damage this unit deals per swing, before target-side armor. */
export function damageOf(e: Ent, buffAmount: number): number {
  const def = animalDef(e);
  const base = def ? def.damage : 25;
  return base * (1 + buffAmount);
}

export function attackCooldownTicks(e: Ent): number {
  const def = animalDef(e);
  const aps = def ? def.attackSpeed : 1.6;
  return Math.max(1, Math.round(TICK_HZ / aps));
}

export function rangeOf(e: Ent): number {
  const def = animalDef(e);
  return def ? def.range : 2.8;
}

export function canTarget(attacker: Ent, target: Ent): boolean {
  const def = animalDef(attacker);
  if (!def) return true; // players and structures hit anything
  if (!target.flying) return true;
  // Only ranged or flying units can reach fliers.
  return def.flying || def.range >= 5;
}

/**
 * Units prefer live enemies over buildings.
 *
 * Without this an army walking past a tower would stop to chew on it while
 * being cut apart, and a siege force would ignore the defenders entirely.
 * Structures are the fallback, which is exactly when you want siege to happen.
 */
export function targetPriority(target: Ent): number {
  // A dragon outranks everything: ignoring it to chew a tower loses the match.
  if (target.kind === EntKind.Dragon) return -1;
  return target.kind === EntKind.Structure ? 1 : 0;
}

export function makeAnimal(id: number, side: Side, slot: number, animal: number, x: number, z: number): Ent {
  const def = ANIMALS[animal];
  const hp = def ? def.hp : 100;
  return {
    id, kind: EntKind.Animal, side, animal, slot, struct: -1,
    phase: 0, altitude: def?.flying ? 3.2 : 0, spawnTick: 0,
    x, z, yaw: 0,
    hp, maxHp: hp,
    state: EntState.Alive,
    flying: def ? def.flying : false,
    radius: 0.45,
    respawnAt: 0, attackReadyAt: 0, retargetAt: 0, targetId: 0, hitCount: 0,
    detached: false, orderX: x, orderZ: z,
    slowUntil: 0, slowAmount: 0, stunUntil: 0,
    poisonUntil: 0, poisonDps: 0, poisonBy: side,
    stealthUntil: 0, stealthReadyAt: 0, revived: false,
  };
}
