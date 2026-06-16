import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeRepo } from "../src/analyze.js";

/**
 * The pre-clone size guard runs before any clone, so stubbing `fetch` is enough
 * to exercise it — no network or git is reached when it rejects.
 */
describe("analyzeRepo pre-clone guard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects an over-limit repo before cloning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ size: 5_000_000 }) })),
    );
    await expect(analyzeRepo("erikbern/git-of-theseus", { interval: "1y", maxRepoMb: 1, cache: false })).rejects.toThrow(
      /too large/i,
    );
  });

  it("rejects a missing repo before cloning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );
    await expect(
      analyzeRepo("erikbern/git-of-theseus", { interval: "1y", maxRepoMb: 2048, cache: false }),
    ).rejects.toThrow(/not found/i);
  });
});
