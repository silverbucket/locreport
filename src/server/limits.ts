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
  trustProxy: boolean;
  maxPerIp: number;
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function bool(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[name] ?? "").trim().toLowerCase());
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
    trustProxy: bool("LOCREPORT_TRUST_PROXY"),
    maxPerIp: num("LOCREPORT_MAX_PER_IP", 2),
  };
}

/**
 * Tracks how many analyses each client (IP) currently has in the system —
 * running or queued — so one client can't occupy every slot and flood the
 * queue, starving others. Keyed identically to the rate limiter.
 */
export class InFlightTracker {
  private counts = new Map<string, number>();

  /** Reserve a slot for `key` if under `max`; returns false (rejected) if not. */
  tryEnter(key: string, max: number): boolean {
    const n = this.counts.get(key) ?? 0;
    if (n >= max) return false;
    this.counts.set(key, n + 1);
    return true;
  }

  /** Release a previously-entered slot. */
  exit(key: string): void {
    const n = this.counts.get(key);
    if (n === undefined) return;
    if (n <= 1) this.counts.delete(key);
    else this.counts.set(key, n - 1);
  }

  inFlight(key: string): number {
    return this.counts.get(key) ?? 0;
  }
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

/**
 * Best-effort client IP, used as the rate-limit key.
 *
 * `X-Forwarded-For` is honored ONLY when `trustProxy` is set — otherwise any
 * client could spoof the header and mint unlimited rate-limit buckets, defeating
 * the limiter. Enable it only when running behind a trusted reverse proxy that
 * overwrites the header. Default off → use the socket peer address.
 */
export function clientIp(req: IncomingMessage, trustProxy = false): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const first = Array.isArray(xff) ? xff[0] : xff?.split(",")[0];
    if (first?.trim()) return first.trim().replace(/^::ffff:/, "");
  }
  return (req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
}
