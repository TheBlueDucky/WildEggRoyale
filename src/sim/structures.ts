import { TICK_HZ } from '../net/protocol';
import type { MapDef, Side } from '../content/maps';
import { EntKind, EntState, type Ent } from './units';

/**
 * Castles, towers and Dragon Eggs.
 *
 * Generated deterministically from the map on BOTH peers, exactly like the egg
 * layout — so no structure position, type or side ever crosses the network.
 * Only HP and life state travel, through the snapshot path that already exists.
 *
 * Entity ids start high enough that unit ids can never collide with them, no
 * matter how many replacements a long match churns through.
 */

export const enum StructKind {
  None = -1,
  Castle = 0,
  Tower = 1,
  DragonEgg = 2,
}

const STRUCT_ID_BASE = 100000;
const PER_SIDE = 1000;

/** Ticks before Dragon Eggs can be damaged at all. */
export const SIEGE_OPENS_TICK = 4 * 60 * TICK_HZ;
/** Towers weaken here, opening the late game. */
export const TOWERS_CRUMBLE_TICK = 10 * 60 * TICK_HZ;
/** Dragon Eggs start burning down on their own, forcing a resolution. */
export const WILDFIRE_TICK = 15 * 60 * TICK_HZ;
export const WILDFIRE_DPS_FRACTION = 0.05;

export const TOWER_COOLDOWN_TICKS = TICK_HZ; // one shot per second

function makeStructure(
  id: number, side: Side, struct: StructKind, x: number, z: number, hp: number, radius: number,
): Ent {
  return {
    id, kind: EntKind.Structure, side, animal: -1, slot: -1, struct,
    phase: 0, altitude: 0, spawnTick: 0,
    x, z, yaw: side === 0 ? Math.PI / 2 : -Math.PI / 2,
    hp, maxHp: hp,
    state: EntState.Alive, flying: false, radius,
    respawnAt: 0, attackReadyAt: 0, retargetAt: 0, targetId: 0, hitCount: 0,
    detached: false, orderX: x, orderZ: z,
    slowUntil: 0, slowAmount: 0, stunUntil: 0,
    poisonUntil: 0, poisonDps: 0, poisonBy: side,
    stealthUntil: 0, stealthReadyAt: 0, revived: false,
  };
}

/**
 * Build both sides' fortifications.
 *
 * Layout offsets are authored in a frame where +dx points at the enemy, so one
 * description mirrors cleanly onto both castles and neither side gets a
 * geometrically better base.
 */
export function generateStructures(map: MapDef): Ent[] {
  const out: Ent[] = [];
  const L = map.castle;

  for (const castle of map.castles) {
    const side = castle.side;
    const base = STRUCT_ID_BASE + side * PER_SIDE;
    // Side 0 sits at -x and faces +x; side 1 is the mirror image.
    const face = side === 0 ? 1 : -1;
    const at = (dx: number, dz: number) => ({
      x: castle.x + dx * face,
      z: castle.z + dz * face,
    });

    const keep = at(0, 0);
    out.push(makeStructure(base, side, StructKind.Castle, keep.x, keep.z, L.hp, 6.5));

    L.towers.forEach((t, i) => {
      const p = at(t.dx, t.dz);
      out.push(makeStructure(base + 1 + i, side, StructKind.Tower, p.x, p.z, L.towerHp, 1.8));
    });

    L.dragonEggs.forEach((e, i) => {
      const p = at(e.dx, e.dz);
      out.push(makeStructure(base + 20 + i, side, StructKind.DragonEgg, p.x, p.z, L.dragonEggHp, 1.6));
    });
  }

  return out;
}

export function isStructure(e: Ent): boolean {
  return e.kind === EntKind.Structure;
}

export function structName(kind: StructKind): string {
  switch (kind) {
    case StructKind.Castle: return 'Castle';
    case StructKind.Tower: return 'Tower';
    case StructKind.DragonEgg: return 'Dragon Egg';
    default: return 'Structure';
  }
}
