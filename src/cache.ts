import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { CohortResult } from "./cohort.js";
import { cloneBare, fetchBare } from "./git.js";
import type { GitHubRepo } from "./github.js";
import type { CommitCounts } from "./types.js";

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

function defaultRoot(): string {
  return process.env.LOCREPORT_CACHE_DIR ?? path.join(homedir(), ".cache", "locreport");
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

export interface AnalysisCache {
  readonly root: string;
  /** Ensure a fresh-enough bare clone exists for `repo`; returns its git dir. */
  ensureRepo(repo: GitHubRepo, onClone?: () => void, onFetch?: () => void): Promise<string>;
  getSnapshot(counter: string, sha: string): Promise<CommitCounts | null>;
  setSnapshot(counter: string, sha: string, counts: CommitCounts): Promise<void>;
  getCohort(sha: string): Promise<CohortResult | null>;
  setCohort(sha: string, cohort: CohortResult): Promise<void>;
}

class DiskCache implements AnalysisCache {
  constructor(readonly root: string) {}

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
    return gitDir;
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
      if (parsed.v !== CACHE_VERSION || !parsed.cohort) return null;
      return parsed.cohort;
    } catch {
      return null;
    }
  }

  async setCohort(sha: string, cohort: CohortResult): Promise<void> {
    await this.writeAtomic(this.cohortPath(sha), { v: CACHE_VERSION, cohort } satisfies CohortFile);
  }
}

/** Open (and lazily create) the on-disk cache rooted at `root`. */
export function openCache(root: string = defaultRoot()): AnalysisCache {
  return new DiskCache(root);
}
