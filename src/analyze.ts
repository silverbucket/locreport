import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { aggregateByPackage, aggregateByRole, classifyFiles } from "./aggregate.js";
import { detectPackages } from "./packages.js";
import { getCounter, type Counter } from "./counter.js";
import { parseGitHubRepo } from "./github.js";
import {
  cloneBare,
  commitAtOrBefore,
  commitDateRange,
  defaultBranch,
  extractCommit,
} from "./git.js";
import { intervalDates } from "./intervals.js";
import type { Interval, Report, Snapshot } from "./types.js";

export interface AnalyzeOptions {
  interval: Interval;
  /** Override the analyzed branch (defaults to the repo's default branch). */
  branch?: string;
  /** Override the counter (mainly for tests); defaults to cloc-or-builtin. */
  counter?: Counter;
  /** Also compute a per-package breakdown (monorepo support). */
  byPackage?: boolean;
  /** Progress callback for UIs/CLIs. */
  onProgress?: (event: ProgressEvent) => void;
}

export type ProgressEvent =
  | { type: "cloning"; repo: string }
  | { type: "resolved"; branch: string; counter: string; snapshots: number }
  | { type: "snapshot"; index: number; total: number; date: string; sha: string };

/**
 * Analyze a GitHub repo's LOC over time, split by role.
 *
 * Clones the repo (bare), samples one commit per interval boundary, counts and
 * classifies each sampled commit, and returns a Report. All temporary files are
 * cleaned up before returning.
 */
export async function analyzeRepo(repoUrl: string, options: AnalyzeOptions): Promise<Report> {
  const repo = parseGitHubRepo(repoUrl);
  if (!repo) throw new Error(`Not a valid GitHub repository: ${JSON.stringify(repoUrl)}`);

  const workRoot = await mkdtemp(path.join(tmpdir(), "locreport-"));
  const gitDir = path.join(workRoot, "repo.git");

  try {
    options.onProgress?.({ type: "cloning", repo: repo.slug });
    await cloneBare(repo.cloneUrl, gitDir);
    return await analyzeBareRepo(
      gitDir,
      workRoot,
      { repoUrl: repo.htmlUrl, cloneUrl: repo.cloneUrl },
      options,
    );
  } finally {
    await rm(workRoot, { recursive: true, force: true });
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
    if (!sha) continue;
    points.push({ date, sha });
  }

  const counter = options.counter ?? (await getCounter());
  options.onProgress?.({ type: "resolved", branch, counter: counter.name, snapshots: points.length });

  // Count each unique sha once; reuse for any later boundary on the same sha.
  const cache = new Map<string, CommitCounts>();
  const snapshots: Snapshot[] = [];

  for (let i = 0; i < points.length; i++) {
    const { date, sha } = points[i]!;
    options.onProgress?.({ type: "snapshot", index: i + 1, total: points.length, date, sha });

    let counts = cache.get(sha);
    if (!counts) {
      counts = await countCommit(gitDir, sha, workRoot, counter, options.byPackage ?? false);
      cache.set(sha, counts);
    }
    snapshots.push({ date, sha, byRole: counts.byRole, byPackage: counts.byPackage });
  }

  return {
    repoUrl: meta.repoUrl,
    cloneUrl: meta.cloneUrl,
    branch,
    interval: options.interval,
    generatedAt: new Date().toISOString(),
    snapshots,
  };
}

interface CommitCounts {
  byRole: Snapshot["byRole"];
  byPackage?: Snapshot["byPackage"];
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
