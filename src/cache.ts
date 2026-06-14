import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
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

export interface AnalysisCache {
  readonly root: string;
  /** Ensure a fresh-enough bare clone exists for `repo`; returns its git dir. */
  ensureRepo(repo: GitHubRepo, onClone?: () => void, onFetch?: () => void): Promise<string>;
  getSnapshot(counter: string, sha: string): Promise<CommitCounts | null>;
  setSnapshot(counter: string, sha: string, counts: CommitCounts): Promise<void>;
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
    const file = this.snapshotPath(counter, sha);
    await mkdir(path.dirname(file), { recursive: true });
    const payload: SnapshotFile = { v: CACHE_VERSION, counts };
    // Write-then-rename so a crash can't leave a half-written cache file.
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(payload));
    await rename(tmp, file);
  }
}

/** Open (and lazily create) the on-disk cache rooted at `root`. */
export function openCache(root: string = defaultRoot()): AnalysisCache {
  return new DiskCache(root);
}
