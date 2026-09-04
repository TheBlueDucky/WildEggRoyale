import { QUANT_HALF, type MsgSnap } from './protocol';
import { EntKind, type EntState } from '../sim/world';
import type { World } from '../sim/world';
import type { EggState } from '../sim/eggs';

/**
 * Snapshot quantisation.
 *
 * Positions go to u16 across the arena (~3.9mm precision), yaw to u8 (1.4°).
 * This is the payoff of the 2.5D decision: ground units never carry a `y`,
 * because the client derives it from the terrain. Only flying units will need
 * one, and there are few of them.
 *
 * MEASURED IN M0: ~23 bytes per entity as JSON tuples, which extrapolates to
 * ~56 KB/s at the 120-entity M3 target — more than double the design budget.
 * The quantisation below is already the hard part; swapping the transport for
 * an ArrayBuffer is a contained change to this file, scheduled for M3.
 */

const POS_SCALE = 65535 / (QUANT_HALF * 2);
const YAW_SCALE = 255 / (Math.PI * 2);

export const qPos = (v: number): number =>
  Math.max(0, Math.min(65535, Math.round((v + QUANT_HALF) * POS_SCALE)));

export const dqPos = (q: number): number => q / POS_SCALE - QUANT_HALF;

export const qYaw = (rad: number): number => {
  const wrapped = ((rad % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return Math.round(wrapped * YAW_SCALE) & 255;
};

export const dqYaw = (q: number): number => q / YAW_SCALE;

/** Worst-case position error introduced by quantisation, in metres. */
export const QUANT_ERROR_M = 1 / POS_SCALE / 2;

export function encodeSnapshot(world: World): MsgSnap {
  const ents: number[][] = [];
  for (const e of world.ents.values()) {
    const row = [e.id, qPos(e.x), qPos(e.z), qYaw(e.yaw), Math.max(0, Math.round(e.hp)), e.state];
    // Only fliers carry a height, and only the dragon carries a phase. Ground
    // units derive y from the terrain, which is the 2.5D decision paying off.
    if (e.flying) {
      row.push(Math.max(0, Math.min(255, Math.round(e.altitude))));
      if (e.kind === EntKind.Dragon) row.push(e.phase);
    }
    ents.push(row);
  }

  const msg: MsgSnap = { t: 'sn', tick: world.tick, ents };

  // Egg deltas only. Typically 0-2 entries, because the only eggs that change
  // on a given tick are ones somebody is standing on.
  if (world.changedEggs.size > 0) {
    const eggs: number[][] = [];
    for (const id of world.changedEggs) {
      const egg = world.eggAt(id);
      if (!egg) continue;
      eggs.push([
        egg.id,
        egg.state,
        Math.max(0, Math.min(255, Math.round(egg.progress * 255))),
        egg.channeler + 1,
      ]);
    }
    world.changedEggs.clear();
    if (eggs.length) msg.eggs = eggs;
  }

  return msg;
}

export interface DecodedEgg {
  id: number;
  state: EggState;
  progress: number;
  channeler: -1 | 0 | 1;
}

export function decodeEggs(msg: MsgSnap): DecodedEgg[] {
  const out: DecodedEgg[] = [];
  for (const row of msg.eggs ?? []) {
    const [id, state, progress, channeler] = row;
    if (id === undefined) continue;
    out.push({
      id,
      state: (state ?? 0) as EggState,
      progress: (progress ?? 0) / 255,
      channeler: ((channeler ?? 0) - 1) as -1 | 0 | 1,
    });
  }
  return out;
}

export interface DecodedEnt {
  id: number;
  x: number;
  z: number;
  yaw: number;
  hp: number;
  state: EntState;
  altitude?: number;
  phase?: number;
}

export function decodeSnapshot(msg: MsgSnap): DecodedEnt[] {
  const out: DecodedEnt[] = [];
  for (const row of msg.ents) {
    const [id, x, z, yaw, hp, state] = row;
    if (id === undefined || x === undefined || z === undefined || yaw === undefined) continue;
    const dec: DecodedEnt = {
      id,
      x: dqPos(x),
      z: dqPos(z),
      yaw: dqYaw(yaw),
      hp: hp ?? 0,
      state: (state ?? 0) as EntState,
    };
    if (row.length > 6) dec.altitude = row[6];
    if (row.length > 7) dec.phase = row[7];
    out.push(dec);
  }
  return out;
}
