import type { Terrain } from './terrain';

/**
 * Flow-field pathing.
 *
 * One BFS from the DESTINATION gives every walkable cell a distance, and a unit
 * simply steps toward its lowest-distance neighbour. That is O(cells) once per
 * group instead of O(A*) per unit per repath — with twenty units heading to the
 * same place, the difference is the whole budget.
 *
 * It also fixes the limitation that M2's straight-line seeking exposed: units
 * now route AROUND ridges instead of grinding along them.
 *
 * Recomputation is the thing to watch. A field whose destination is a moving
 * player would rebuild every tick, so callers rebuild only when the target has
 * drifted past a threshold (see World.refreshFields).
 */

const CELL = 1;
const UNREACHABLE = 0x7fffffff;

export class FlowField {
  readonly destX: number;
  readonly destZ: number;

  private readonly gw: number;
  private readonly gh: number;
  private readonly halfW: number;
  private readonly halfH: number;
  private readonly dist: Int32Array;

  constructor(private readonly terrain: Terrain, destX: number, destZ: number) {
    this.destX = destX;
    this.destZ = destZ;
    this.halfW = terrain.halfW;
    this.halfH = terrain.halfH;
    this.gw = Math.ceil(terrain.halfW * 2 / CELL) + 1;
    this.gh = Math.ceil(terrain.halfH * 2 / CELL) + 1;
    this.dist = new Int32Array(this.gw * this.gh).fill(UNREACHABLE);
    this.build(destX, destZ);
  }

  private index(x: number, z: number): number {
    const gx = Math.round((x + this.halfW) / CELL);
    const gz = Math.round((z + this.halfH) / CELL);
    if (gx < 0 || gz < 0 || gx >= this.gw || gz >= this.gh) return -1;
    return gz * this.gw + gx;
  }

  private build(destX: number, destZ: number) {
    let start = this.index(destX, destZ);
    if (start < 0) return;

    // A destination inside rock (an order clicked on a cliff) would leave the
    // field empty, so seed from the nearest walkable cell instead of failing.
    if (!this.terrain.walkable(destX, destZ)) {
      const near = this.nearestWalkable(destX, destZ);
      if (!near) return;
      start = this.index(near.x, near.z);
      if (start < 0) return;
    }

    this.dist[start] = 0;
    const queue = new Int32Array(this.gw * this.gh);
    queue[0] = start;
    let head = 0;
    let tail = 1;

    while (head < tail) {
      const i = queue[head++]!;
      const d = this.dist[i]! + 1;
      const cx = i % this.gw;
      const cz = (i / this.gw) | 0;

      for (let k = 0; k < 4; k++) {
        const nx = cx + NEIGHBOUR_DX[k]!;
        const nz = cz + NEIGHBOUR_DZ[k]!;
        if (nx < 0 || nz < 0 || nx >= this.gw || nz >= this.gh) continue;
        const ni = nz * this.gw + nx;
        if (this.dist[ni]! <= d) continue;

        const wx = nx * CELL - this.halfW;
        const wz = nz * CELL - this.halfH;
        if (!this.terrain.walkable(wx, wz)) continue;

        this.dist[ni] = d;
        queue[tail++] = ni;
      }
    }
  }

  private nearestWalkable(x: number, z: number): { x: number; z: number } | null {
    for (let r = 1; r <= 12; r++) {
      for (let a = 0; a < 16; a++) {
        const t = (a / 16) * Math.PI * 2;
        const wx = x + Math.cos(t) * r;
        const wz = z + Math.sin(t) * r;
        if (this.terrain.walkable(wx, wz)) return { x: wx, z: wz };
      }
    }
    return null;
  }

  /** True when this cell has no route to the destination. */
  isUnreachable(x: number, z: number): boolean {
    const i = this.index(x, z);
    return i < 0 || this.dist[i] === UNREACHABLE;
  }

  /**
   * Unit direction toward the destination, or null when already there or
   * cut off. Steepest descent over the 8-neighbourhood, which reads much
   * smoother than 4-way stepping.
   */
  dirAt(x: number, z: number): { x: number; z: number } | null {
    const i = this.index(x, z);
    if (i < 0) return null;

    const here = this.dist[i]!;
    if (here === 0) return null;

    let bestD = here;
    let bx = 0;
    let bz = 0;
    const cx = i % this.gw;
    const cz = (i / this.gw) | 0;

    for (let k = 0; k < 8; k++) {
      const nx = cx + DIAG_DX[k]!;
      const nz = cz + DIAG_DZ[k]!;
      if (nx < 0 || nz < 0 || nx >= this.gw || nz >= this.gh) continue;
      const d = this.dist[nz * this.gw + nx]!;
      if (d < bestD) {
        bestD = d;
        bx = DIAG_DX[k]!;
        bz = DIAG_DZ[k]!;
      }
    }

    if (bx === 0 && bz === 0) return null;
    const len = Math.hypot(bx, bz);
    return { x: bx / len, z: bz / len };
  }
}

const NEIGHBOUR_DX = [1, -1, 0, 0];
const NEIGHBOUR_DZ = [0, 0, 1, -1];
const DIAG_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DIAG_DZ = [0, 0, 1, -1, 1, -1, 1, -1];
