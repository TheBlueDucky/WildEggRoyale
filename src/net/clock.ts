import { createTicker, type Ticker } from './ticker';

/**
 * Fixed-step loop with drift correction.
 *
 * The wake source drifts and coalesces, so we run it faster than the target
 * rate and catch up against a wall-clock deadline. Catch-up is capped so a long
 * stall (alt-tab, GC pause) cannot trigger a death spiral of hundreds of ticks.
 *
 * The wake source is a Worker rather than a bare setInterval — see ticker.ts
 * for why that matters to a host-authoritative sim.
 */
export class TickLoop {
  tick = 0;
  /** performance.now() at the start of the most recent tick. */
  lastTickAt = 0;

  private ticker: Ticker = createTicker();
  private next = 0;
  private readonly period: number;

  constructor(
    hz: number,
    private readonly onTick: (tick: number) => void,
    private readonly maxCatchUp = 5,
  ) {
    this.period = 1000 / hz;
  }

  start(startTick = 0) {
    this.tick = startTick;
    this.next = performance.now();
    this.lastTickAt = this.next;
    this.ticker.start(Math.max(4, this.period / 3), () => this.pump());
  }

  stop() {
    this.ticker.stop();
  }

  /** Which wake source we ended up with, for the debug overlay. */
  get tickerKind() {
    return this.ticker.kind;
  }

  /** 0..1 progress through the current tick, for render interpolation. */
  alpha(now = performance.now()): number {
    return Math.max(0, Math.min(1, (now - this.lastTickAt) / this.period));
  }

  private pump() {
    const now = performance.now();
    let budget = this.maxCatchUp;

    while (this.next <= now && budget-- > 0) {
      this.lastTickAt = this.next;
      this.onTick(this.tick++);
      this.next += this.period;
    }

    // Fell too far behind to ever catch up — resync rather than spiral.
    if (this.next < now - this.period * this.maxCatchUp) this.next = now;
  }
}

/** Rolling bandwidth meter, reported in bytes/sec. */
export class RateMeter {
  private samples: Array<{ at: number; bytes: number }> = [];

  add(bytes: number) {
    this.samples.push({ at: performance.now(), bytes });
  }

  perSecond(): number {
    const cutoff = performance.now() - 1000;
    while (this.samples.length && (this.samples[0]?.at ?? 0) < cutoff) this.samples.shift();
    return this.samples.reduce((sum, s) => sum + s.bytes, 0);
  }
}
