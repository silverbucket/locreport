import { describe, expect, it } from "vitest";
import { BusyError, RateLimiter, Semaphore, clientIp } from "../src/server/limits.js";

const tick = () => new Promise<void>((r) => setImmediate(r));

describe("Semaphore", () => {
  it("caps concurrent holders and queues the rest", async () => {
    const sem = new Semaphore(2, 10);
    const a = await sem.acquire();
    const b = await sem.acquire();
    expect(sem.inFlight).toBe(2);

    let cAcquired = false;
    const cP = sem.acquire().then((rel) => {
      cAcquired = true;
      return rel;
    });
    await tick();
    expect(cAcquired).toBe(false); // queued, not yet granted
    expect(sem.waiting).toBe(1);

    a(); // release one → c proceeds
    const c = await cP;
    expect(cAcquired).toBe(true);
    expect(sem.inFlight).toBe(2); // never exceeds the cap

    b();
    c();
    expect(sem.inFlight).toBe(0);
  });

  it("throws BusyError when the queue is full", async () => {
    const sem = new Semaphore(1, 1);
    await sem.acquire(); // active
    void sem.acquire(); // fills the single queue slot
    await tick();
    await expect(sem.acquire()).rejects.toBeInstanceOf(BusyError);
  });

  it("never exceeds the cap under interleaved release/acquire", async () => {
    const sem = new Semaphore(2, 100);
    const held: Array<() => void> = [];
    held.push(await sem.acquire(), await sem.acquire());
    const waiters = [sem.acquire(), sem.acquire(), sem.acquire()];
    await tick();
    held[0]!();
    held[1]!();
    const r1 = await waiters[0]!;
    const r2 = await waiters[1]!;
    expect(sem.inFlight).toBe(2);
    r1();
    const r3 = await waiters[2]!;
    expect(sem.inFlight).toBe(2);
    r2();
    r3();
    expect(sem.inFlight).toBe(0);
  });
});

describe("RateLimiter", () => {
  it("allows up to max per window then blocks", () => {
    const rl = new RateLimiter(3, 1000);
    const now = 10_000;
    expect(rl.allow("ip", now)).toBe(true);
    expect(rl.allow("ip", now)).toBe(true);
    expect(rl.allow("ip", now)).toBe(true);
    expect(rl.allow("ip", now)).toBe(false); // 4th in window
  });

  it("resets after the window elapses", () => {
    const rl = new RateLimiter(1, 1000);
    expect(rl.allow("ip", 0)).toBe(true);
    expect(rl.allow("ip", 500)).toBe(false);
    expect(rl.allow("ip", 1000)).toBe(true); // new window
  });

  it("tracks keys independently", () => {
    const rl = new RateLimiter(1, 1000);
    expect(rl.allow("a", 0)).toBe(true);
    expect(rl.allow("b", 0)).toBe(true);
    expect(rl.allow("a", 0)).toBe(false);
  });
});

describe("clientIp", () => {
  it("prefers the first X-Forwarded-For hop and strips ipv6 mapping", () => {
    const req = { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" }, socket: {} } as never;
    expect(clientIp(req)).toBe("203.0.113.7");
  });
  it("falls back to the socket address", () => {
    const req = { headers: {}, socket: { remoteAddress: "::ffff:192.168.1.5" } } as never;
    expect(clientIp(req)).toBe("192.168.1.5");
  });
});
