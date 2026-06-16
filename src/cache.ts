import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { access, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { CohortResult } from "./cohort.js";
import { cloneBare, fetchBare } from "./git.js";
import type { GitHubRepo } from "./github.js";
import type { CommitCounts, Report } from "./types.js";

/**
 * On-disk cache for analysis.
 *
 * Two independent caches under one root:
 *   - repos/      persistent bare clones, refreshed with `git fetch` instead of
 *                 a fresh clone on every run.
 *   - snapshots/  per-commit counted results, keyed by (counter, sha). A commit
 *                 is immutable, so its counts never change — only the classifier
 *                 rules / counting semantics can, which CACHE_VERSION guards.
 *
 * Bump CACHE_VERSION whenever the classifier ruleset or counting semantics
 * change, so stale snapshot entries are ignored.
 */
// v2: string-literal-aware counting changed code/comment results.
const CACHE_VERSION = 2;
// Cohort versioned separately so cohort-only changes don't invalidate counts.
// NOTE: cohort files were first written with v=2 (they reused CACHE_VERSION),
// holding the old all-lines data — so this must be > 2 to invalidate them.
// v3: cohort counts code lines only (was all physical lines across roles).
// v4: cohort shape gained per-role year buckets (byRoleYear).
const COHORT_VERSION = 4;
// Assembled-report cache. Its version embeds CACHE_VERSION + COHORT_VERSION so a
// bump in either (the report embeds both kinds of data) invalidates stored
// reports without a separate bump. Increment the leading number for Report
// shape changes.
const REPORT_VERSION = `1.${CACHE_VERSION}.${COHORT_VERSION}`;

function defaultRoot(): string {
  return process.env.LOCREPORT_CACHE_DIR ?? path.join(homedir(), ".cache", "locreport");
}

// Total size budget for cached bare clones (the dominant, attacker-controllable
// disk user on a public instance). 0 disables eviction. Default 5 GiB.
function defaultMaxBytes(): number {
  const mb = Number(process.env.LOCREPORT_MAX_CACHE_MB);
  return (Number.isFinite(mb) && mb >= 0 ? mb : 5120) * 1024 * 1024;
}

// Never evict a clone touched within this window — it is likely in use by an
// in-flight analysis. The floor is 15 min, but it always covers the configured
// analysis timeout so a long-running analysis can't have its clone evicted
// mid-run (a concurrent prune only protects its own keep dir + this window).
function evictGraceMs(): number {
  const timeout = Number(process.env.LOCREPORT_ANALYSIS_TIMEOUT_MS);
  return Math.max(15 * 60_000, Number.isFinite(timeout) && timeout > 0 ? timeout : 0);
}

/** Recursively sum the byte size of regular files under `dir` (0 if missing). */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(full);
    else if (e.isFile()) {
      try {
        total += (await stat(full)).size;
      } catch {
        // raced removal — ignore
      }
    }
  }
  return total;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

interface SnapshotFile {
  v: number;
  counts: CommitCounts;
}

interface CohortFile {
  v: number;
  cohort: CohortResult;
}

interface ReportFile {
  v: string;
  /** Branch head SHA the report was assembled from; a mismatch means it's stale. */
  head: string;
  report: Report;
}

export interface AnalysisCache {
  readonly root: string;
  /** Ensure a fresh-enough bare clone exists for `repo`; returns its git dir. */
  ensureRepo(repo: GitHubRepo, onClone?: () => void, onFetch?: () => void): Promise<string>;
  getSnapshot(counter: string, sha: string): Promise<CommitCounts | null>;
  setSnapshot(counter: string, sha: string, counts: CommitCounts): Promise<void>;
  getCohort(sha: string): Promise<CohortResult | null>;
  setCohort(sha: string, cohort: CohortResult): Promise<void>;
  /** Assembled report for `key`, if cached for the current branch `head`. */
  getReport(key: string, head: string): Promise<Report | null>;
  setReport(key: string, head: string, report: Report): Promise<void>;
  /** Evict least-recently-used bare clones until under the size budget. */
  prune(keepGitDir?: string): Promise<void>;
}

class DiskCache implements AnalysisCache {
  constructor(
    readonly root: string,
    private readonly maxBytes: number,
  ) {}

  private reposDir(): string {
    return path.join(this.root, "repos");
  }

  private repoDir(repo: GitHubRepo): string {
    // owner/name is unique on GitHub; flatten to a safe single dir name.
    const safe = `${repo.owner}__${repo.name}`.replace(/[^A-Za-z0-9_.-]/g, "_");
    return path.join(this.reposDir(), `${safe}.git`);
  }

  private snapshotPath(counter: string, sha: string): string {
    const safeCounter = counter.replace(/[^A-Za-z0-9_.-]/g, "_");
    return path.join(this.root, "snapshots", safeCounter, `${sha}.json`);
  }

  private cohortPath(sha: string): string {
    return path.join(this.root, "cohorts", `${sha}.json`);
  }

  // One file per param-key (hashed), overwritten when the head moves — so report
  // files stay bounded by distinct params, not by history.
  private reportPath(key: string): string {
    const safe = createHash("sha1").update(key).digest("hex");
    return path.join(this.root, "reports", `${safe}.json`);
  }

  private async writeAtomic(file: string, payload: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(payload));
    await rename(tmp, file);
  }

  async ensureRepo(repo: GitHubRepo, onClone?: () => void, onFetch?: () => void): Promise<string> {
    const gitDir = this.repoDir(repo);
    if (await exists(path.join(gitDir, "HEAD"))) {
      onFetch?.();
      await fetchBare(gitDir);
    } else {
      onClone?.();
      await mkdir(this.reposDir(), { recursive: true });
      await cloneBare(repo.cloneUrl, gitDir);
    }
    // Mark as most-recently-used for LRU eviction, then trim the cache.
    const now = new Date();
    await utimes(gitDir, now, now).catch(() => {});
    await this.prune(gitDir).catch((err) => {
      // Housekeeping must never fail an analysis.
      process.stderr.write(`cache prune failed: ${(err as Error).message}\n`);
    });
    return gitDir;
  }

  async prune(keepGitDir?: string): Promise<void> {
    if (this.maxBytes <= 0) return;
    let entries: Dirent[];
    try {
      entries = await readdir(this.reposDir(), { withFileTypes: true });
    } catch {
      return; // no repos dir yet
    }

    const now = Date.now();
    const grace = evictGraceMs();
    const keep = keepGitDir ? path.resolve(keepGitDir) : null;
    const repos: Array<{ full: string; size: number; mtimeMs: number }> = [];
    let total = 0;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(this.reposDir(), e.name);
      const size = await dirSize(full);
      let mtimeMs = now;
      try {
        mtimeMs = (await stat(full)).mtimeMs;
      } catch {
        // raced removal — treat as fresh so we don't fight another pruner
      }
      total += size;
      repos.push({ full, size, mtimeMs });
    }
    if (total <= this.maxBytes) return;

    // Evict least-recently-used first; never the just-used clone, nor one
    // touched within the grace window (likely mid-analysis).
    const evictable = repos
      .filter((r) => path.resolve(r.full) !== keep && now - r.mtimeMs > grace)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const r of evictable) {
      if (total <= this.maxBytes) break;
      await rm(r.full, { recursive: true, force: true });
      total -= r.size;
    }
  }

  async getSnapshot(counter: string, sha: string): Promise<CommitCounts | null> {
    try {
      const raw = await readFile(this.snapshotPath(counter, sha), "utf8");
      const parsed = JSON.parse(raw) as SnapshotFile;
      if (parsed.v !== CACHE_VERSION || !parsed.counts) return null;
      return parsed.counts;
    } catch {
      return null;
    }
  }

  async setSnapshot(counter: string, sha: string, counts: CommitCounts): Promise<void> {
    const payload: SnapshotFile = { v: CACHE_VERSION, counts };
    await this.writeAtomic(this.snapshotPath(counter, sha), payload);
  }

  async getCohort(sha: string): Promise<CohortResult | null> {
    try {
      const parsed = JSON.parse(await readFile(this.cohortPath(sha), "utf8")) as CohortFile;
      if (parsed.v !== COHORT_VERSION || !parsed.cohort) return null;
      return parsed.cohort;
    } catch {
      return null;
    }
  }

  async setCohort(sha: string, cohort: CohortResult): Promise<void> {
    await this.writeAtomic(this.cohortPath(sha), { v: COHORT_VERSION, cohort } satisfies CohortFile);
  }

  async getReport(key: string, head: string): Promise<Report | null> {
    try {
      const parsed = JSON.parse(await readFile(this.reportPath(key), "utf8")) as ReportFile;
      if (parsed.v !== REPORT_VERSION || parsed.head !== head || !parsed.report) return null;
      return parsed.report;
    } catch {
      return null;
    }
  }

  async setReport(key: string, head: string, report: Report): Promise<void> {
    await this.writeAtomic(this.reportPath(key), { v: REPORT_VERSION, head, report } satisfies ReportFile);
  }
}

/**
 * Open (and lazily create) the on-disk cache rooted at `root`. `maxBytes` caps
 * the total size of cached bare clones (LRU-evicted); 0 disables eviction.
 */
export function openCache(root: string = defaultRoot(), maxBytes: number = defaultMaxBytes()): AnalysisCache {
  return new DiskCache(root, maxBytes);
}
