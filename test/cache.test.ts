import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
