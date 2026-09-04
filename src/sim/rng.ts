/**
 * Seeded xorshift32.
 *
 * Two separate jobs, and it matters which is which:
 *
 *  - Egg LAYOUT is generated from the shared seed on both peers, so positions
 *    and tiers never go over the wire at all. That is worth real bandwidth.
 *  - Egg CONTENTS are rolled on the host at hatch time from its own stream.
 *    If contents were seeded too, a modified client could read every egg's
 *    animal before touching it.
 */
export class Rng {
  private s: number;

  constructor(seed: number) {
    // xorshift dies at zero; any non-zero fallback is fine.
    this.s = (seed | 0) || 0x9e3779b9;
  }

  /** Next uint32. */
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x | 0;
    return x >>> 0;
  }

  /** [0, 1) */
  float(): number {
    return this.next() / 4294967296;
  }

  /** [0, n) */
  int(n: number): number {
    return Math.floor(this.float() * n);
  }

  /** [lo, hi) */
  range(lo: number, hi: number): number {
    return lo + this.float() * (hi - lo);
  }

  pick<T>(items: readonly T[]): T | undefined {
    if (items.length === 0) return undefined;
    return items[this.int(items.length)];
  }

  /** Pick a key by weight. Entries with weight <= 0 are ignored. */
  weighted<T extends string>(weights: Partial<Record<T, number>>): T | undefined {
    const entries = Object.entries(weights) as Array<[T, number]>;
    let total = 0;
    for (const [, w] of entries) if (w > 0) total += w;
    if (total <= 0) return undefined;

    let roll = this.float() * total;
    for (const [key, w] of entries) {
      if (w <= 0) continue;
      roll -= w;
      if (roll <= 0) return key;
    }
    return entries[entries.length - 1]?.[0];
  }
}
