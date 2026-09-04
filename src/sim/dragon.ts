import { TICK_HZ } from '../net/protocol';
import type { MapDef, Side } from '../content/maps';
import { EntKind, EntState, type Ent } from './units';

/**
 * The dragon boss.
 *
 * Deliberately NOT a win button. Destroying three Dragon Eggs earns you a
 * dragon; the dragon then has to survive a fight against the defender's whole
 * army, their player and their towers. If it dies the defender's eggs come back
 * at 40% and the attacker has to do it all again — which is the comeback beat
 * the whole design is built around.
 */

export const enum DragonPhase {
  Arriving = 0,
  Assault = 1,
  Enraged = 2,
  Slain = 3,
  Triumphant = 4,
}

export const DRAGON_HP = 6000;
export const DRAGON_ENRAGE_AT = 0.6;
export const DRAGON_SPEED = 9;
export const DRAGON_ENRAGED_SPEED_MULT = 1.3;
/** Damage per second dealt to the castle once in range. */
export const DRAGON_CASTLE_DPS = 200;
export const DRAGON_ENRAGED_MULT = 1.5;
/** Splash damage per second to defenders under the dragon. */
export const DRAGON_SPLASH_DPS = 55;
export const DRAGON_SPLASH_RADIUS = 8;
/** How close the dragon must get to start burning the keep. */
export const DRAGON_CASTLE_RANGE = 12;

export const ARRIVE_TICKS = 6 * TICK_HZ;
export const ARRIVE_ALTITUDE = 60;
export const FLY_ALTITUDE = 9;

/** After a dragon is slain the defender's eggs return, weakened. */
export const EGG_RESPAWN_DELAY_TICKS = 45 * TICK_HZ;
export const EGG_RESPAWN_FRACTION = 0.4;

const DRAGON_ID_BASE = 200000;

export function dragonIdFor(side: Side): number {
  return DRAGON_ID_BASE + side;
}

/**
 * Spawn a dragon high above its owner's side of the map.
 *
 * It enters from behind the attacker so the defender sees it coming across the
 * whole board — the arrival is meant to be an event, not an ambush.
 */
export function makeDragon(map: MapDef, side: Side): Ent {
  const home = map.castles.find((c) => c.side === side) ?? { x: 0, z: 0 };
  return {
    id: dragonIdFor(side),
    kind: EntKind.Dragon,
    side,
    animal: -1,
    slot: -1,
    struct: -1,
    phase: DragonPhase.Arriving,
    altitude: ARRIVE_ALTITUDE,
    x: home.x,
    z: home.z,
    yaw: side === 0 ? Math.PI / 2 : -Math.PI / 2,
    hp: DRAGON_HP,
    maxHp: DRAGON_HP,
    state: EntState.Alive,
    flying: true,
    radius: 3.2,
    respawnAt: 0,
    attackReadyAt: 0,
    retargetAt: 0,
    targetId: 0,
    hitCount: 0,
    detached: false,
    orderX: 0,
    orderZ: 0,
    slowUntil: 0,
    slowAmount: 0,
    stunUntil: 0,
    poisonUntil: 0,
    poisonDps: 0,
    poisonBy: side,
    stealthUntil: 0,
    stealthReadyAt: 0,
    revived: false,
    spawnTick: 0,
  };
}

export function isEnraged(d: Ent): boolean {
  return d.phase === DragonPhase.Enraged;
}

export function dragonDamageMult(d: Ent): number {
  return isEnraged(d) ? DRAGON_ENRAGED_MULT : 1;
}

export function dragonSpeed(d: Ent): number {
  return DRAGON_SPEED * (isEnraged(d) ? DRAGON_ENRAGED_SPEED_MULT : 1);
}

export function phaseName(phase: DragonPhase): string {
  switch (phase) {
    case DragonPhase.Arriving: return 'arriving';
    case DragonPhase.Assault: return 'assault';
    case DragonPhase.Enraged: return 'ENRAGED';
    case DragonPhase.Slain: return 'slain';
    case DragonPhase.Triumphant: return 'triumphant';
    default: return '?';
  }
}
