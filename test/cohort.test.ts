import { describe, expect, it } from "vitest";
import { createLimiter } from "../src/cohort.js";

describe("createLimiter", () => {
  it("never runs more than `concurrency` tasks at once", async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return 1;
      });
    const results = await Promise.all(Array.from({ length: 6 }, task));
    expect(peak).toBe(2);
    expect(results).toHaveLength(6);
  });

  it("releases the slot even when a task rejects", async () => {
    const limit = createLimiter(1);
    await expect(
      limit(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // If the slot weren't released, this would hang (capacity 1).
    await expect(limit(async () => 42)).resolves.toBe(42);
  });
});
