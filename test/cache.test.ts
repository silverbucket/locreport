import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCache } from "../src/cache.js";
import type { Bucket, CommitCounts, Role } from "../src/types.js";

function bucket(code: number): Bucket {
  return { code, comment: 0, blank: 0, files: 1 };
}
function counts(appCode: number): CommitCounts {
  const roles: Role[] = ["app", "test", "config", "docs", "data", "build", "vendored"];
  const byRole = Object.fromEntries(roles.map((r) => [r, bucket(0)])) as Record<Role, Bucket>;
  byRole.app = bucket(appCode);
  return { byRole };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "locreport-cache-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("snapshot cache", () => {
  it("round-trips a stored result", async () => {
    const cache = openCache(dir);
    expect(await cache.getSnapshot("builtin", "abc")).toBeNull();
    await cache.setSnapshot("builtin", "abc", counts(42));
    expect((await cache.getSnapshot("builtin", "abc"))?.byRole.app.code).toBe(42);
  });

  it("separates entries by counter backend", async () => {
    const cache = openCache(dir);
    await cache.setSnapshot("builtin", "abc", counts(10));
    expect(await cache.getSnapshot("cloc", "abc")).toBeNull();
    expect((await cache.getSnapshot("builtin", "abc"))?.byRole.app.code).toBe(10);
  });

  it("ignores entries written with a different cache version", async () => {
    const cache = openCache(dir);
    await cache.setSnapshot("builtin", "abc", counts(7));
    // Corrupt the version on disk.
    const file = path.join(dir, "snapshots", "builtin", "abc.json");
    await writeFile(file, JSON.stringify({ v: 999, counts: counts(7) }));
    expect(await cache.getSnapshot("builtin", "abc")).toBeNull();
  });

  it("returns null for corrupt JSON", async () => {
    const cache = openCache(dir);
    await cache.setSnapshot("builtin", "abc", counts(1));
    await writeFile(path.join(dir, "snapshots", "builtin", "abc.json"), "{not json");
    expect(await cache.getSnapshot("builtin", "abc")).toBeNull();
  });
});

describe("cohort cache", () => {
  it("round-trips a cohort result", async () => {
    const cache = openCache(dir);
    expect(await cache.getCohort("abc")).toBeNull();
    await cache.setCohort("abc", { total: 30, byYear: { "2021": 10, "2022": 20 } });
    expect(await cache.getCohort("abc")).toEqual({ total: 30, byYear: { "2021": 10, "2022": 20 } });
  });

  it("rejects legacy v=2 cohort files (the old all-lines data)", async () => {
    const cache = openCache(dir);
    await mkdir(path.join(dir, "cohorts"), { recursive: true });
    // Old format: cohort files were written with v=2 holding inflated totals.
    await writeFile(
      path.join(dir, "cohorts", "abc.json"),
      JSON.stringify({ v: 2, cohort: { total: 25000, byYear: { "2026": 25000 } } }),
    );
    expect(await cache.getCohort("abc")).toBeNull();
  });
});

describe("cache eviction (prune)", () => {
  // Fake bare-clone dir holding a single file of `bytes`, last-used `ageMin` ago.
  async function makeRepo(name: string, bytes: number, ageMin: number): Promise<string> {
    const gitDir = path.join(dir, "repos", `${name}.git`);
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(gitDir, "pack"), Buffer.alloc(bytes));
    const t = new Date(Date.now() - ageMin * 60_000);
    await utimes(gitDir, t, t);
    return gitDir;
  }
  const remaining = async () => (await readdir(path.join(dir, "repos"))).sort();

  it("evicts least-recently-used clones until under the size cap", async () => {
    await makeRepo("old", 1024, 60);
    await makeRepo("mid", 1024, 40);
    await makeRepo("recent", 1024, 20); // all older than the 15-min grace window
    await openCache(dir, 2048).prune(); // 3 KiB total, 2 KiB cap → drop the LRU one
    expect(await remaining()).toEqual(["mid.git", "recent.git"]);
  });

  it("never evicts the keep dir or clones within the grace window", async () => {
    await makeRepo("old", 1024, 60);
    await makeRepo("fresh", 1024, 1); // within grace → protected even under pressure
    await openCache(dir, 1).prune(); // cap forces eviction of everything evictable
    expect(await remaining()).toEqual(["fresh.git"]);
  });

  it("does nothing when eviction is disabled (maxBytes = 0)", async () => {
    await makeRepo("old", 4096, 60);
    await openCache(dir, 0).prune();
    expect(await remaining()).toEqual(["old.git"]);
  });
});
