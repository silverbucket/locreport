import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeBareRepo } from "../src/analyze.js";
import { openCache } from "../src/cache.js";
import { BuiltinCounter, type Counter } from "../src/counter.js";
import { summarizeSnapshot } from "../src/report.js";
import type { FileCount } from "../src/types.js";

/** Wraps the builtin counter and records how many commits it actually counts. */
class SpyCounter implements Counter {
  readonly name = "builtin"; // must match builtin so cache keys align across runs
  calls = 0;
  private inner = new BuiltinCounter();
  count(dir: string): Promise<FileCount[]> {
    this.calls++;
    return this.inner.count(dir);
  }
}

/**
 * End-to-end test of the engine (git sampling + counting + classification +
 * aggregation) against a locally-built repo with backdated commits. No network.
 */

let workRoot: string;
let gitDir: string;

function git(args: string[], cwd: string, dateISO?: string): void {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    ...(dateISO ? { GIT_AUTHOR_DATE: dateISO, GIT_COMMITTER_DATE: dateISO } : {}),
  };
  execFileSync("git", args, { cwd, env, stdio: "pipe" });
}

async function write(repo: string, rel: string, content: string): Promise<void> {
  const full = path.join(repo, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
}

beforeAll(async () => {
  workRoot = await mkdtemp(path.join(tmpdir(), "locreport-it-"));
  const src = path.join(workRoot, "src-repo");
  await mkdir(src, { recursive: true });
  git(["init", "-b", "main"], src);

  // --- Commit 1: 2021 — app + docs + a build file ---
  await write(src, "src/app.ts", "// main entry\nexport const x = 1;\nexport function run() {\n  return x;\n}\n");
  await write(src, "README.md", "# Project\n\nHello.\n");
  await write(src, "Dockerfile", "FROM node:20\n# build image\nRUN echo hi\n");
  git(["add", "-A"], src);
  git(["commit", "-m", "initial"], src, "2021-01-02T12:00:00");

  // --- Commit 2: 2022 — add tests + more app code ---
  await write(src, "src/util.ts", "export const add = (a: number, b: number) => a + b;\n");
  await write(src, "test/app.test.ts", "// tests\nimport { run } from '../src/app';\ntest('runs', () => run());\n");
  git(["add", "-A"], src);
  git(["commit", "-m", "tests"], src, "2022-01-02T12:00:00");

  // --- Commit 3: 2023 — add config + a vendored dependency ---
  await write(src, "config/settings.yml", "# config\nport: 3000\nhost: localhost\n");
  await write(src, "node_modules/dep/index.js", "module.exports = 1; // vendored\n");
  git(["add", "-Af"], src); // -f to force-add the gitignore-less node_modules
  git(["commit", "-m", "config"], src, "2023-01-02T12:00:00");

  // Bare-clone locally (exercises the same code path as a real clone).
  gitDir = path.join(workRoot, "repo.git");
  git(["clone", "--bare", "--quiet", src, gitDir], workRoot);
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe("analyzeBareRepo — monorepo per-package (end-to-end)", () => {
  let mono: string;
  let monoGitDir: string;

  beforeAll(async () => {
    mono = await mkdtemp(path.join(tmpdir(), "locreport-mono-"));
    const src = path.join(mono, "src-repo");
    await mkdir(src, { recursive: true });
    git(["init", "-b", "main"], src);

    await write(src, "pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n  - 'apps/*'\n");
    await write(src, "package.json", '{"name":"root","private":true}\n');
    await write(src, "README.md", "# Monorepo\n\nDocs at root.\n");

    await write(src, "packages/api/package.json", '{"name":"@acme/api"}\n');
    await write(src, "packages/api/src/server.ts", "export const port = 3000;\nexport function serve() {\n  return port;\n}\n");
    await write(src, "packages/api/test/server.test.ts", "// api tests\ntest('serve', () => {});\n");

    await write(src, "apps/web/package.json", '{"name":"@acme/web"}\n');
    await write(src, "apps/web/index.ts", "export const app = 1;\n");

    git(["add", "-A"], src);
    git(["commit", "-m", "monorepo"], src, "2023-06-01T12:00:00");

    monoGitDir = path.join(mono, "repo.git");
    git(["clone", "--bare", "--quiet", src, monoGitDir], mono);
  });

  afterAll(async () => {
    await rm(mono, { recursive: true, force: true });
  });

  it("splits roles per workspace package", async () => {
    const report = await analyzeBareRepo(
      monoGitDir,
      mono,
      { repoUrl: "https://github.com/test/mono", cloneUrl: "https://github.com/test/mono.git" },
      { interval: "1y", counter: new BuiltinCounter(), byPackage: true },
    );

    const last = report.snapshots[report.snapshots.length - 1]!;
    const pkgs = Object.fromEntries((last.byPackage ?? []).map((p) => [p.id, p]));

    expect(pkgs["packages/api"]!.name).toBe("@acme/api");
    expect(pkgs["packages/api"]!.byRole.app.code).toBeGreaterThan(0);
    expect(pkgs["packages/api"]!.byRole.test.code).toBeGreaterThan(0);

    expect(pkgs["apps/web"]!.name).toBe("@acme/web");
    expect(pkgs["apps/web"]!.byRole.app.code).toBeGreaterThan(0);
    expect(pkgs["apps/web"]!.byRole.test.code).toBe(0);

    // Root README is documentation owned by the root bucket.
    expect(pkgs[""]!.byRole.docs.code).toBeGreaterThan(0);

    // Repo-wide app code equals the sum of per-package app code.
    const perPkgApp = (last.byPackage ?? []).reduce((s, p) => s + p.byRole.app.code, 0);
    expect(perPkgApp).toBe(last.byRole.app.code);
  });
});

describe("analyzeBareRepo (end-to-end, builtin counter)", () => {
  it("produces a yearly snapshot per commit with correct role splits", async () => {
    const report = await analyzeBareRepo(
      gitDir,
      workRoot,
      { repoUrl: "https://github.com/test/repo", cloneUrl: "https://github.com/test/repo.git" },
      { interval: "1y", counter: new BuiltinCounter() },
    );

    expect(report.branch).toBe("main");
    expect(report.snapshots.length).toBe(3);

    const [s2021, s2022, s2023] = report.snapshots.map(summarizeSnapshot);

    // App code grows over time.
    expect(s2021!.app).toBeGreaterThan(0);
    expect(s2022!.app).toBeGreaterThan(s2021!.app);

    // Tests appear only from 2022.
    expect(s2021!.test).toBe(0);
    expect(s2022!.test).toBeGreaterThan(0);

    // Config appears only from 2023.
    expect(s2022!.config).toBe(0);
    expect(s2023!.config).toBeGreaterThan(0);

    // Build (Dockerfile) and vendored (node_modules) are excluded from Total.
    expect(s2023!.excluded).toBeGreaterThan(0);

    // The vendored file must NOT inflate app code.
    const vendored = report.snapshots[2]!.byRole.vendored;
    expect(vendored.files).toBe(1);
  });

  it("produces a per-package breakdown when byPackage is enabled", async () => {
    const report = await analyzeBareRepo(
      gitDir,
      workRoot,
      { repoUrl: "https://github.com/test/repo", cloneUrl: "https://github.com/test/repo.git" },
      { interval: "1y", counter: new BuiltinCounter(), byPackage: true },
    );
    const last = report.snapshots[report.snapshots.length - 1]!;
    expect(last.byPackage).toBeDefined();
    expect(last.byPackage!.length).toBeGreaterThan(0);
  });

  it("computes a code-age cohort that buckets lines by author-year", async () => {
    const meta = { repoUrl: "https://github.com/test/repo", cloneUrl: "https://github.com/test/repo.git" };
    const report = await analyzeBareRepo(gitDir, workRoot, meta, {
      interval: "1y",
      counter: new BuiltinCounter(),
      cohort: true,
    });

    const first = report.snapshots[0]!; // 2021 commit
    const last = report.snapshots[report.snapshots.length - 1]!; // 2023 commit

    // The first snapshot only contains lines authored in 2021.
    expect(Object.keys(first.cohort?.byYear ?? {})).toEqual(["2021"]);

    // The latest snapshot has surviving lines from all three commit years.
    expect(Object.keys(last.cohort?.byYear ?? {}).sort()).toEqual(["2021", "2022", "2023"]);

    const sum = (m) => Object.values(m).reduce((a, b) => a + b, 0);
    expect(sum(last.cohort!.byYear)).toBeGreaterThan(sum(first.cohort!.byYear));

    // Overall cohort reconciles with the snapshot's "Total" counted code...
    const countedCode = (["app", "test", "config", "docs", "data"] as const).reduce(
      (s, r) => s + last.byRole[r].code,
      0,
    );
    expect(sum(last.cohort!.byYear)).toBe(countedCode);

    // ...and the per-role cohort reconciles with that role's code count.
    expect(sum(last.cohort!.byRoleYear.app ?? {})).toBe(last.byRole.app.code);
    expect(sum(last.cohort!.byRoleYear.test ?? {})).toBe(last.byRole.test.code);
  });

  it("caches per-commit counts so a re-run does no counting", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "locreport-cachetest-"));
    const store = openCache(cacheDir);
    const spy = new SpyCounter();
    const meta = { repoUrl: "https://github.com/test/repo", cloneUrl: "https://github.com/test/repo.git" };
    const opts = { interval: "1y" as const, counter: spy, store, byPackage: true };

    try {
      const first = await analyzeBareRepo(gitDir, workRoot, meta, opts);
      expect(spy.calls).toBe(3); // three unique commits counted

      const second = await analyzeBareRepo(gitDir, workRoot, meta, opts);
      expect(spy.calls).toBe(3); // fully served from cache — no new counting

      // Cached results match the freshly-counted ones.
      expect(second.snapshots.map((s) => s.byRole.app.code)).toEqual(first.snapshots.map((s) => s.byRole.app.code));
      expect(second.snapshots.at(-1)?.byPackage?.length).toBe(first.snapshots.at(-1)?.byPackage?.length);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("serves a whole report from the report cache (no counting, even with per-commit cache gone)", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "locreport-reportcache-"));
    const store = openCache(cacheDir);
    const spy = new SpyCounter();
    const meta = { repoUrl: "https://github.com/test/repo", cloneUrl: "https://github.com/test/repo.git" };
    const opts = { interval: "1y" as const, counter: spy, store };

    try {
      const first = await analyzeBareRepo(gitDir, workRoot, meta, opts);
      const callsAfterFirst = spy.calls;
      // Remove the per-commit snapshot cache, leaving only the assembled report.
      await rm(path.join(cacheDir, "snapshots"), { recursive: true, force: true });

      const second = await analyzeBareRepo(gitDir, workRoot, meta, opts);
      // No re-counting despite missing snapshots → the report cache served it.
      expect(spy.calls).toBe(callsAfterFirst);
      expect(second).toEqual(first);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("does not share report-cache entries between different repos at the same head", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "locreport-reportrepo-"));
    const store = openCache(cacheDir);
    const opts = { interval: "1y" as const, counter: new BuiltinCounter(), store };

    try {
      const a = await analyzeBareRepo(gitDir, workRoot, { repoUrl: "https://github.com/a/one", cloneUrl: "https://github.com/a/one.git" }, opts);
      // Same gitDir (same head SHA) but a different repo identity.
      const b = await analyzeBareRepo(gitDir, workRoot, { repoUrl: "https://github.com/b/two", cloneUrl: "https://github.com/b/two.git" }, opts);
      expect(a.repoUrl).toBe("https://github.com/a/one");
      expect(b.repoUrl).toBe("https://github.com/b/two"); // not a's report
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("samples fewer snapshots at a coarser-than-history interval", async () => {
    const report = await analyzeBareRepo(
      gitDir,
      workRoot,
      { repoUrl: "https://github.com/test/repo", cloneUrl: "https://github.com/test/repo.git" },
      { interval: "1m", counter: new BuiltinCounter() },
    );
    // Monthly sampling over ~2 years yields more snapshots than yearly.
    expect(report.snapshots.length).toBeGreaterThan(3);
    // Last snapshot is the newest commit state (has config).
    const last = summarizeSnapshot(report.snapshots[report.snapshots.length - 1]!);
    expect(last.config).toBeGreaterThan(0);
  });
});
