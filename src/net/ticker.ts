/**
 * An unthrottled wake source for the fixed-step loop.
 *
 * Browsers clamp setTimeout/setInterval to ~1Hz on the main thread of a hidden
 * tab. Measured in M0: the host's authoritative sim dropped from 20Hz to 6.4Hz
 * the moment its tab lost visibility, which slows the match down for BOTH
 * players — a host-authoritative model makes one peer's tab focus everyone's
 * problem.
 *
 * Timers inside a dedicated Worker are not subject to that clamp, so we run the
 * heartbeat there and do the actual work on the main thread. Falls back to
 * setInterval if Workers or blob URLs are unavailable.
 */

const WORKER_SRC = `
let id = null;
self.onmessage = (e) => {
  const d = e.data;
  if (d && d.cmd === 'start') {
    if (id !== null) clearInterval(id);
    id = setInterval(() => self.postMessage(0), d.period);
  } else if (d && d.cmd === 'stop') {
    if (id !== null) clearInterval(id);
    id = null;
  }
};
`;

export interface Ticker {
  start(periodMs: number, onWake: () => void): void;
  stop(): void;
  readonly kind: 'worker' | 'interval';
}

class WorkerTicker implements Ticker {
  readonly kind = 'worker' as const;
  private worker?: Worker;
  private url?: string;

  start(periodMs: number, onWake: () => void) {
    this.stop();
    this.url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
    this.worker = new Worker(this.url);
    this.worker.onmessage = () => onWake();
    this.worker.postMessage({ cmd: 'start', period: periodMs });
  }

  stop() {
    this.worker?.postMessage({ cmd: 'stop' });
    this.worker?.terminate();
    this.worker = undefined;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = undefined;
  }
}

class IntervalTicker implements Ticker {
  readonly kind = 'interval' as const;
  private id?: number;

  start(periodMs: number, onWake: () => void) {
    this.stop();
    this.id = window.setInterval(onWake, periodMs);
  }

  stop() {
    if (this.id !== undefined) clearInterval(this.id);
    this.id = undefined;
  }
}

export function createTicker(): Ticker {
  try {
    if (typeof Worker !== 'undefined' && typeof URL.createObjectURL === 'function') {
      return new WorkerTicker();
    }
  } catch {
    /* fall through */
  }
  return new IntervalTicker();
}
