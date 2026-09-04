import type { MapDef } from '../content/maps';

/**
 * Terrain: heightfield + walkability.
 *
 * Headless by construction — no three, no canvas. Both peers build this from
 * the same MapDef and must agree exactly, because walkability feeds the
 * simulation (and therefore client prediction). Integer hashing keeps it
 * deterministic across machines; there is no Math.random anywhere below.
 *
 * The 2.5D rule lives here: the sim only ever asks "can I stand at x,z?".
 * heightAt() exists purely so the renderer can place things on the ground.
 */

const CELL = 1; // walkability grid resolution, metres

function hash2(ix: number, iz: number, seed: number): number {
  let h = (seed ^ Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = smooth(x - ix);
  const fz = smooth(z - iz);

  const n00 = hash2(ix, iz, seed);
  const n10 = hash2(ix + 1, iz, seed);
  const n01 = hash2(ix, iz + 1, seed);
  const n11 = hash2(ix + 1, iz + 1, seed);

  return lerp(lerp(n00, n10, fx), lerp(n01, n11, fx), fz);
}

export class Terrain {
  readonly halfW: number;
  readonly halfH: number;

  private readonly gw: number;
  private readonly gh: number;
  private readonly walkGrid: Uint8Array;

  constructor(readonly map: MapDef) {
    this.halfW = map.size[0] / 2;
    this.halfH = map.size[1] / 2;

    this.gw = Math.ceil(map.size[0] / CELL) + 1;
    this.gh = Math.ceil(map.size[1] / CELL) + 1;
    this.walkGrid = new Uint8Array(this.gw * this.gh);

    this.bakeWalkability();
  }

  /** Ground height in metres. Render-only — never simulated, never sent. */
  heightAt(x: number, z: number): number {
    const m = this.map;
    let amp = 1;
    let freq = 1 / m.featureScale;
    let sum = 0;
    let norm = 0;

    for (let o = 0; o < m.octaves; o++) {
      sum += valueNoise(x * freq, z * freq, m.terrainSeed + o * 7919) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }

    return (sum / norm) * m.maxHeight * this.flatten(x, z);
  }

  /**
   * Flatten the ground near castles so bases are usable. Ramps back to full
   * relief over the same radius rather than leaving a visible plateau edge.
   */
  private flatten(x: number, z: number): number {
    const m = this.map;
    let nearest = Infinity;
    for (const c of m.castles) {
      nearest = Math.min(nearest, Math.hypot(x - c.x, z - c.z));
    }
    if (nearest >= m.flattenRadius * 2) return 1;
    const t = Math.max(0, (nearest - m.flattenRadius) / m.flattenRadius);
    return smooth(Math.max(0, Math.min(1, t)));
  }

  /** Gradient magnitude, via central differences. */
  slopeAt(x: number, z: number): number {
    const d = 0.6;
    const dx = (this.heightAt(x + d, z) - this.heightAt(x - d, z)) / (2 * d);
    const dz = (this.heightAt(x, z + d) - this.heightAt(x, z - d)) / (2 * d);
    return Math.hypot(dx, dz);
  }

  inBounds(x: number, z: number, margin = 0): boolean {
    return (
      x >= -this.halfW + margin &&
      x <= this.halfW - margin &&
      z >= -this.halfH + margin &&
      z <= this.halfH - margin
    );
  }

  walkable(x: number, z: number): boolean {
    if (!this.inBounds(x, z, 0.6)) return false;
    const gx = Math.round((x + this.halfW) / CELL);
    const gz = Math.round((z + this.halfH) / CELL);
    if (gx < 0 || gz < 0 || gx >= this.gw || gz >= this.gh) return false;
    return this.walkGrid[gz * this.gw + gx] === 1;
  }

  private bakeWalkability() {
    for (let gz = 0; gz < this.gh; gz++) {
      for (let gx = 0; gx < this.gw; gx++) {
        const x = gx * CELL - this.halfW;
        const z = gz * CELL - this.halfH;
        const ok = this.slopeAt(x, z) <= this.map.maxWalkSlope;
        this.walkGrid[gz * this.gw + gx] = ok ? 1 : 0;
      }
    }
  }

  /** Fraction of the map that is walkable — a sanity check on map tuning. */
  walkableFraction(): number {
    let n = 0;
    for (let i = 0; i < this.walkGrid.length; i++) if (this.walkGrid[i] === 1) n++;
    return n / this.walkGrid.length;
  }

  /**
   * Flood fill from a walkable cell, returning the set of reachable cells.
   *
   * Procedural terrain can accidentally wall the map in half, which would make
   * a match unwinnable in a way that is very hard to notice by eye. Cheap to
   * check, catastrophic to miss.
   */
  private floodFrom(x: number, z: number): Uint8Array {
    const seen = new Uint8Array(this.gw * this.gh);
    const start = this.cellIndex(x, z);
    if (start < 0 || this.walkGrid[start] !== 1) return seen;

    const queue = [start];
    seen[start] = 1;

    while (queue.length) {
      const i = queue.pop()!;
      const cx = i % this.gw;
      const cz = (i / this.gw) | 0;

      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= this.gw || nz >= this.gh) continue;
        const ni = nz * this.gw + nx;
        if (seen[ni] === 1 || this.walkGrid[ni] !== 1) continue;
        seen[ni] = 1;
        queue.push(ni);
      }
    }
    return seen;
  }

  private cellIndex(x: number, z: number): number {
    const gx = Math.round((x + this.halfW) / CELL);
    const gz = Math.round((z + this.halfH) / CELL);
    if (gx < 0 || gz < 0 || gx >= this.gw || gz >= this.gh) return -1;
    return gz * this.gw + gx;
  }

  /** True when every castle can walk to every other castle. */
  castlesConnected(): boolean {
    const first = this.map.castles[0];
    if (!first) return true;
    const reach = this.floodFrom(first.x, first.z);
    return this.map.castles.every((c) => {
      const i = this.cellIndex(c.x, c.z);
      return i >= 0 && reach[i] === 1;
    });
  }

  /**
   * Walking distance between the castles, in metres, via BFS on the walk grid.
   * Returns -1 if unreachable.
   */
  private walkDistance(ax: number, az: number, bx: number, bz: number): number {
    const start = this.cellIndex(ax, az);
    const goal = this.cellIndex(bx, bz);
    if (start < 0 || goal < 0 || this.walkGrid[start] !== 1) return -1;

    const dist = new Int32Array(this.gw * this.gh).fill(-1);
    dist[start] = 0;
    const queue = [start];

    for (let head = 0; head < queue.length; head++) {
      const i = queue[head]!;
      if (i === goal) return dist[i]! * CELL;
      const cx = i % this.gw;
      const cz = (i / this.gw) | 0;

      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= this.gw || nz >= this.gh) continue;
        const ni = nz * this.gw + nx;
        if (dist[ni] !== -1 || this.walkGrid[ni] !== 1) continue;
        dist[ni] = dist[i]! + 1;
        queue.push(ni);
      }
    }
    return -1;
  }

  /**
   * Walking distance between castles divided by straight-line distance.
   *
   * The number that actually says whether a map plays well. 1.0 means a clear
   * run; much above ~1.25 means terrain has grown a wall across the middle and
   * players are taking long detours to reach each other. Note the BFS is
   * 4-connected, so a genuinely diagonal route inflates this by up to 1.41 —
   * on maps whose castles share a z (all of them so far) that does not apply.
   */
  detourRatio(): number {
    const [a, b] = this.map.castles;
    if (!a || !b) return 1;
    const walk = this.walkDistance(a.x, a.z, b.x, b.z);
    if (walk < 0) return Infinity;
    return walk / Math.hypot(b.x - a.x, b.z - a.z);
  }

  /** Share of walkable ground reachable from the first castle. */
  connectedFraction(): number {
    const first = this.map.castles[0];
    if (!first) return 1;
    const reach = this.floodFrom(first.x, first.z);
    let reached = 0;
    let walkable = 0;
    for (let i = 0; i < this.walkGrid.length; i++) {
      if (this.walkGrid[i] === 1) walkable++;
      if (reach[i] === 1) reached++;
    }
    return walkable === 0 ? 0 : reached / walkable;
  }
}
