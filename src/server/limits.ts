import type { IncomingMessage } from "node:http";

/**
 * Server-side safety limits for the (potentially public) web endpoint. All
 * values are env-overridable; the defaults suit a small self-hosted instance.
 */
export interface Limits {
  maxConcurrent: number;
  maxQueue: number;
  rateMax: number;
  rateWindowMs: number;
  analysisTimeoutMs: number;
  maxRepoMb: number;
  gitTimeoutMs: number;
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function loadLimits(): Limits {
  return {
    maxConcurrent: num("LOCREPORT_MAX_CONCURRENT", 2),
    maxQueue: num("LOCREPORT_MAX_QUEUE", 10),
    rateMax: num("LOCREPORT_RATE_MAX", 30),
    rateWindowMs: num("LOCREPORT_RATE_WINDOW_MS", 60_000),
    analysisTimeoutMs: num("LOCREPORT_ANALYSIS_TIMEOUT_MS", 600_000),
    maxRepoMb: num("LOCREPORT_MAX_REPO_MB", 2048),
    gitTimeoutMs: num("LOCREPORT_GIT_TIMEOUT_MS", 300_000),
  };
}

/** Thrown by Semaphore.acquire when the queue is full. */
export class BusyError extends Error {
  constructor() {
    super("Server busy: too many analyses in progress. Try again shortly.");
    this.name = "BusyError";
  }
}

/**
 * Bounded concurrency gate. At most `max` holders at once; up to `maxQueue`
 * callers may wait, beyond which acquire() throws BusyError.
 *
 * A released slot is handed directly to the next waiter (the active count is
 * never transiently dropped), so the cap can't be exceeded by interleaving.
 */
export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(
    private readonly max: number,
    private readonly maxQueue: number,
  ) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return () => this.release();
    }
    if (this.queue.length >= this.maxQueue) throw new BusyError();
    await new Promise<void>((resolve) => this.queue.push(resolve)); // slot handed to us
    return () => this.release();
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next(); // transfer the slot; active unchanged
    else this.active--;
  }

  get inFlight(): number {
    return this.active;
  }
  get waiting(): number {
    return this.queue.length;
  }
}

/** Fixed-window per-key rate limiter. */
export class RateLimiter {
  private hits = new Map<string, { count: number; reset: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now: number): boolean {
    const e = this.hits.get(key);
    if (!e || now >= e.reset) {
      if (this.hits.size > 10_000) this.prune(now); // bound memory
      this.hits.set(key, { count: 1, reset: now + this.windowMs });
      return true;
    }
    if (e.count >= this.max) return false;
    e.count++;
    return true;
  }

  private prune(now: number): void {
    for (const [k, e] of this.hits) if (now >= e.reset) this.hits.delete(k);
  }
}

/** Best-effort client IP (first X-Forwarded-For hop when behind a proxy). */
export function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const first = Array.isArray(xff) ? xff[0] : xff?.split(",")[0];
  return (first?.trim() || req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
}
