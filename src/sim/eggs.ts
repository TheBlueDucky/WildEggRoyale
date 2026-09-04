import type { MapDef, ZoneKind } from '../content/maps';
import { zoneAt } from '../content/maps';
import { EGG_TIERS, TIER_INDEX, TIER_ORDER } from '../content/eggs';
import type { Rarity } from '../content/animals';
import { TICK_HZ } from '../net/protocol';
import type { Terrain } from './terrain';
import { Rng } from './rng';

export const enum EggState {
  Available = 0,
  Consumed = 1,
}

export interface Egg {
  id: number;
  x: number;
  z: number;
  tier: Rarity;
  tierIdx: number;
  state: EggState;
  /** 0..1 hatch channel progress. */
  progress: number;
  /** Side currently channelling, or -1. */
  channeler: -1 | 0 | 1;
  /** Tick before which this egg cannot be hatched. */
  unlockAtTick: number;
}

const MIN_EGG_SPACING = 9;
const MIN_CASTLE_CLEARANCE = 14;
const PLACEMENT_ATTEMPTS = 400;

/** x-range of a zone within the LEFT half of the map. */
function leftHalfRange(map: MapDef, zone: ZoneKind): [number, number] {
  const halfW = map.size[0] / 2;
  switch (zone) {
    case 'safe':
      return [-halfW + 4, -(halfW - map.zones.safeMargin)];
    case 'wild':
      return [-(halfW - map.zones.safeMargin), -map.zones.contestedHalfWidth];
    case 'contested':
      return [-map.zones.contestedHalfWidth, 0];
  }
}

/**
 * Deterministic egg layout, generated identically on both peers from the shared
 * seed — so no egg position or tier is ever sent over the network.
 *
 * Eggs are placed in the left half and mirrored through the origin, which is
 * also how the castles are arranged. Perfect 180-degree symmetry means neither
 * player can get a luckier map, while the layout still differs every match.
 */
export function generateEggs(map: MapDef, terrain: Terrain, seed: number): Egg[] {
  const rng = new Rng(seed);
  const eggs: Egg[] = [];
  const halfH = map.size[1] / 2;
  let nextId = 1;

  for (const group of map.eggSpawns) {
    const [x0, x1] = leftHalfRange(map, group.zone);
    const unlockAtTick = Math.round((group.unlockAtSeconds ?? 0) * TICK_HZ);
    const pairs = Math.floor(group.count / 2);

    for (let i = 0; i < pairs; i++) {
      const tier = (rng.weighted(group.weights) ?? 'common') as Rarity;
      const spot = findSpot(map, terrain, rng, x0, x1, halfH, eggs);
      if (!spot) continue; // zone is saturated; skip rather than overlap

      const a: Egg = {
        id: nextId++,
        x: spot.x,
        z: spot.z,
        tier,
        tierIdx: TIER_INDEX[tier],
        state: EggState.Available,
        progress: 0,
        channeler: -1,
        unlockAtTick,
      };
      // Mirrored through the origin, matching the castle layout.
      const b: Egg = { ...a, id: nextId++, x: -spot.x, z: -spot.z };

      eggs.push(a, b);
    }
  }

  return eggs;
}

function findSpot(
  map: MapDef,
  terrain: Terrain,
  rng: Rng,
  x0: number,
  x1: number,
  halfH: number,
  placed: Egg[],
): { x: number; z: number } | null {
  for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
    const x = rng.range(Math.min(x0, x1), Math.max(x0, x1));
    const z = rng.range(-halfH + 4, halfH - 4);

    if (!terrain.walkable(x, z)) continue;

    let tooClose = false;
    for (const c of map.castles) {
      if (Math.hypot(x - c.x, z - c.z) < MIN_CASTLE_CLEARANCE) { tooClose = true; break; }
    }
    if (tooClose) continue;

    // Check against placed eggs AND their mirrors, so the two halves cannot
    // crowd each other across the centre line.
    for (const e of placed) {
      if (Math.hypot(x - e.x, z - e.z) < MIN_EGG_SPACING) { tooClose = true; break; }
    }
    if (tooClose) continue;

    return { x, z };
  }
  return null;
}

/** Seconds of channelling this egg requires. */
export function hatchSeconds(egg: Egg): number {
  return EGG_TIERS[egg.tier].hatchSeconds;
}

export function tierFromIndex(idx: number): Rarity {
  return TIER_ORDER[idx] ?? 'common';
}

/** Zone a given egg sits in — used for HUD copy and spawn debugging. */
export function eggZone(map: MapDef, egg: Egg): ZoneKind {
  return zoneAt(map, egg.x);
}
