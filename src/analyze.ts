import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import path from "node:path";
import { aggregateByPackage, aggregateByRole, classifyFiles } from "./aggregate.js";
import { openCache, type AnalysisCache } from "./cache.js";
import { detectPackages } from "./packages.js";
import { getCounter, type Counter } from "./counter.js";
import { parseGitHubRepo } from "./github.js";
import { cloneBare, commitAtOrBefore, commitDateRange, defaultBranch, extractCommit } from "./git.js";
import { intervalDates } from "./intervals.js";
import type { CommitCounts, Interval, Report, Snapshot } from "./types.js";

const DEFAULT_CONCURRENCY = Math.max(2, Math.min(8, cpus().length));

export interface AnalyzeOptions {
  interval: Interval;
  /** Override the analyzed branch (defaults to the repo's default branch). */
  branch?: string;
  /** Override the counter (mainly for tests); defaults to cloc-or-builtin. */
  counter?: Counter;
  /** Also compute a per-package breakdown (monorepo support). */
  byPackage?: boolean;
  /** Use the on-disk cache (persistent clone + per-commit counts). Default true. */
  cache?: boolean;
  /** Max commits counted concurrently. Defaults to ~CPU count. */
  concurrency?: number;
  /** Progress callback for UIs/CLIs. */
  onProgress?: (event: ProgressEvent) => void;
  /** Internal: concrete cache passed down to analyzeBareRepo. */
  store?: AnalysisCache;
}

export type ProgressEvent =
  | { type: "cloning"; repo: string }
  | { type: "updating"; repo: string }
  | { type: "resolved"; branch: string; counter: string; snapshots: number; cached: number }
  | { type: "snapshot"; index: number; total: number; date: string; sha: string; cached: boolean };

/**
 * Analyze a GitHub repo's LOC over time, split by role.
 *
 * By default uses an on-disk cache: a persistent bare clone (refreshed with
 * `git fetch`) and per-commit counted results, so re-runs are near-instant.
 * Scratch files for tree extraction are always cleaned up before returning.
 */
export async function analyzeRepo(repoUrl: string, options: AnalyzeOptions): Promise<Report> {
  const repo = parseGitHubRepo(repoUrl);
  if (!repo) throw new Error(`Not a valid GitHub repository: ${JSON.stringify(repoUrl)}`);

  const useCache = options.cache !== false;
  const scratch = await mkdtemp(path.join(tmpdir(), "locreport-"));
  const meta: RepoMeta = { repoUrl: repo.htmlUrl, cloneUrl: repo.cloneUrl };

  try {
    if (useCache) {
      const store = openCache();
      const gitDir = await store.ensureRepo(
        repo,
        () => options.onProgress?.({ type: "cloning", repo: repo.slug }),
        () => options.onProgress?.({ type: "updating", repo: repo.slug }),
      );
      return await analyzeBareRepo(gitDir, scratch, meta, { ...options, store });
    }

    const gitDir = path.join(scratch, "repo.git");
    options.onProgress?.({ type: "cloning", repo: repo.slug });
    await cloneBare(repo.cloneUrl, gitDir);
    return await analyzeBareRepo(gitDir, scratch, meta, options);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export interface RepoMeta {
  repoUrl: string;
  cloneUrl: string;
}

/**
 * Run the analysis pipeline against an already-cloned bare repo at `gitDir`,
 * using `workRoot` for scratch space. Split out from analyzeRepo so the full
 * pipeline can be tested without network access. Does NOT delete `workRoot`.
 */
export async function analyzeBareRepo(
  gitDir: string,
  workRoot: string,
  meta: RepoMeta,
  options: AnalyzeOptions,
): Promise<Report> {
  const branch = options.branch ?? (await defaultBranch(gitDir));
  const { first, last } = await commitDateRange(gitDir, branch);
  const dates = intervalDates(first, last, options.interval);

  // Resolve each boundary date to a commit; skip dates before the first commit.
  const points: Array<{ date: string; sha: string }> = [];
  for (const date of dates) {
    const sha = await commitAtOrBefore(gitDir, branch, date);
    if (sha) points.push({ date, sha });
  }

  const counter = options.counter ?? (await getCounter());
  const byPackage = options.byPackage ?? false;
  const store = options.store;

  // Unique shas (multiple boundaries can resolve to the same commit), with the
  // first boundary date for each — used only for progress display.
  const firstDate = new Map<string, string>();
  for (const p of points) if (!firstDate.has(p.sha)) firstDate.set(p.sha, p.date);
  const uniqueShas = [...firstDate.keys()];

  // Split into cache hits and misses up front.
  const counts = new Map<string, CommitCounts>();
  const misses: string[] = [];
  for (const sha of uniqueShas) {
    const cached = store ? await store.getSnapshot(counter.name, sha) : null;
    // A cached entry without byPackage can't satisfy a byPackage request.
    if (cached && (!byPackage || cached.byPackage)) counts.set(sha, cached);
    else misses.push(sha);
  }

  const total = uniqueShas.length;
  options.onProgress?.({ type: "resolved", branch, counter: counter.name, snapshots: total, cached: total - misses.length });

  let completed = 0;
  const emit = (sha: string, cached: boolean) =>
    options.onProgress?.({ type: "snapshot", index: ++completed, total, date: firstDate.get(sha)!, sha, cached });

  for (const sha of uniqueShas) if (counts.has(sha)) emit(sha, true);

  // Count the misses in parallel (commit trees are extracted to per-sha dirs,
  // so concurrent counting is conflict-free).
  await mapPool(misses, options.concurrency ?? DEFAULT_CONCURRENCY, async (sha) => {
    const c = await countCommit(gitDir, sha, workRoot, counter, byPackage);
    counts.set(sha, c);
    if (store) await store.setSnapshot(counter.name, sha, c);
    emit(sha, false);
  });

  const snapshots: Snapshot[] = points.map((p) => {
    const c = counts.get(p.sha)!;
    return { date: p.date, sha: p.sha, byRole: c.byRole, byPackage: c.byPackage };
  });

  return {
    repoUrl: meta.repoUrl,
    cloneUrl: meta.cloneUrl,
    branch,
    interval: options.interval,
    generatedAt: new Date().toISOString(),
    snapshots,
  };
}

/** Run `fn` over `items` with at most `limit` concurrent executions. */
async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]!);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
}

async function countCommit(
  gitDir: string,
  sha: string,
  workRoot: string,
  counter: Counter,
  byPackage: boolean,
): Promise<CommitCounts> {
  const dest = path.join(workRoot, `tree-${sha}`);
  const tar = path.join(workRoot, `tree-${sha}.tar`);
  await mkdir(dest, { recursive: true });
  try {
    await extractCommit(gitDir, sha, tar, dest);
    const files = await counter.count(dest);
    const classified = classifyFiles(files);
    const result: CommitCounts = { byRole: aggregateByRole(classified) };
    if (byPackage) {
      const detection = detectPackages(
        files.map((f) => f.path),
        (rel) => {
          try {
            return readFileSync(path.join(dest, rel), "utf8");
          } catch {
            return null;
          }
        },
      );
      result.byPackage = aggregateByPackage(classified, detection);
    }
    return result;
  } finally {
    await rm(dest, { recursive: true, force: true });
    await rm(tar, { force: true });
  }
}
