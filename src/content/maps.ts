/**
 * Map definitions.
 *
 * Terrain is generated procedurally from `terrainSeed` rather than loaded from
 * a heightmap PNG. Two reasons: it keeps both peers bit-identical without an
 * asset pipeline (the sim needs walkability, so the two clients MUST agree on
 * terrain), and it makes maps editable as pure data. `Terrain` hides this
 * behind heightAt()/walkable(), so a PNG sampler can replace the noise later
 * without touching anything above it.
 *
 * These defs are part of the content bundle, so any edit changes the content
 * hash and mismatched builds refuse to play each other.
 */

import type { TierWeights } from './eggs';

export type Side = 0 | 1;

export type ZoneKind = 'safe' | 'wild' | 'contested';

export interface EggSpawnGroup {
  zone: ZoneKind;
  /** Total eggs across BOTH halves; always even so the map stays symmetric. */
  count: number;
  weights: TierWeights;
  /** Seconds into the match before this group can be hatched. */
  unlockAtSeconds?: number;
}

export interface CastleDef {
  side: Side;
  x: number;
  z: number;
}

/** Offsets are in a local frame where +dx points AT THE ENEMY. */
export interface CastleLayout {
  hp: number;
  towerHp: number;
  towerDps: number;
  towerRange: number;
  dragonEggHp: number;
  towers: Array<{ dx: number; dz: number }>;
  dragonEggs: Array<{ dx: number; dz: number }>;
}

export interface MapDef {
  id: string;
  name: string;
  /** [width along x, depth along z] in metres, centred on the origin. */
  size: [number, number];
  maxHeight: number;
  terrainSeed: number;
  /** Terrain feature size in metres. Larger = broader, smoother hills. */
  featureScale: number;
  octaves: number;
  /**
   * Above this gradient magnitude, ground is too steep to walk. Tuned against
   * the measured slope histogram for the map: ~10% impassable makes ridges
   * into real chokepoints without fragmenting the map.
   */
  maxWalkSlope: number;
  castles: CastleDef[];
  castle: CastleLayout;
  /** Terrain is flattened within this radius of each castle. */
  flattenRadius: number;
  eggSpawns: EggSpawnGroup[];
  zones: {
    /** Distance inward from each end that counts as that player's safe zone. */
    safeMargin: number;
    /** Half-width of the central contested strip. */
    contestedHalfWidth: number;
  };
}

export const EMERALD_FOREST: MapDef = {
  id: 'emerald_forest',
  name: 'Emerald Forest',
  size: [220, 160],
  maxHeight: 17,
  terrainSeed: 1337,
  featureScale: 46,
  octaves: 4,
  maxWalkSlope: 0.6,
  castles: [
    { side: 0, x: -95, z: 0 },
    { side: 1, x: 95, z: 0 },
  ],
  flattenRadius: 26,
  castle: {
    hp: 8000,
    towerHp: 1200,
    towerDps: 45,
    towerRange: 18,
    dragonEggHp: 2000,
    // Two towers forward covering the Dragon Eggs, two back covering the keep.
    towers: [
      { dx: 14, dz: -13 }, { dx: 14, dz: 13 },
      { dx: -8, dz: -15 }, { dx: -8, dz: 15 },
    ],
    // Eggs sit in front of the keep, inside tower cover but reachable — the
    // attacker has to stand in the fire to break them.
    dragonEggs: [
      { dx: 7, dz: -8 }, { dx: 7, dz: 0 }, { dx: 7, dz: 8 },
    ],
  },
  eggSpawns: [
    { zone: 'safe', count: 6, weights: { common: 5, uncommon: 2 } },
    { zone: 'wild', count: 18, weights: { common: 5, uncommon: 4, rare: 2 } },
    // The good stuff sits in the middle and stays locked until the siege
    // window opens, so the early game is exploration rather than a race.
    { zone: 'contested', count: 8, weights: { rare: 4, epic: 3, legendary: 1 }, unlockAtSeconds: 240 },
    { zone: 'contested', count: 2, weights: { mythic: 3, ancient: 1 }, unlockAtSeconds: 240 },
  ],
  zones: {
    safeMargin: 34,
    contestedHalfWidth: 28,
  },
};

export const MAPS: Record<string, MapDef> = {
  [EMERALD_FOREST.id]: EMERALD_FOREST,
};

/** Which band a world position falls in. Symmetric about the origin. */
export function zoneAt(map: MapDef, x: number): ZoneKind {
  const halfW = map.size[0] / 2;
  if (Math.abs(x) >= halfW - map.zones.safeMargin) return 'safe';
  if (Math.abs(x) <= map.zones.contestedHalfWidth) return 'contested';
  return 'wild';
}
