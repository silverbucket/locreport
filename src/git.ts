import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Thin wrapper around git, operating on a bare clone (no working tree needed —
 * we extract individual commits on demand via `git archive`).
 *
 * Safety: git is invoked with terminal prompts disabled so a private/missing
 * repo fails fast instead of hanging for credentials, and we never run the
 * repository's hooks (archive/log/rev-list don't execute hooks).
 */

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GCM_INTERACTIVE: "never",
};

/** Optional per-process git timeout (ms). Set by the server; unset for the CLI. */
function gitTimeout(): number | undefined {
  const v = Number(process.env.LOCREPORT_GIT_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

async function git(args: string[], opts: { cwd?: string; maxBuffer?: number } = {}): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    env: GIT_ENV,
    cwd: opts.cwd,
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
    timeout: gitTimeout(),
  });
  return stdout;
}

/**
 * Approximate on-disk size of a bare repo in KiB (loose objects + packs), via
 * `git count-objects`. Cheap; used to enforce a size cap before counting.
 */
export async function repoSizeKb(gitDir: string): Promise<number> {
  const out = await git(["--git-dir", gitDir, "count-objects", "-v"]);
  let kb = 0;
  for (const line of out.split("\n")) {
    const m = /^(size|size-pack):\s*(\d+)/.exec(line.trim());
    if (m) kb += Number(m[2]);
  }
  return kb;
}

/** Bare-clone a repo (full history) into `gitDir`. */
export async function cloneBare(cloneUrl: string, gitDir: string): Promise<void> {
  await git(["clone", "--bare", "--quiet", cloneUrl, gitDir]);
}

/**
 * Update an existing bare clone's branch refs from origin. A bare clone's
 * default fetch refspec maps refs/heads/* directly, so this brings in new
 * commits on all branches. Cheap when already up to date.
 */
export async function fetchBare(gitDir: string): Promise<void> {
  await git(["--git-dir", gitDir, "fetch", "--prune", "--quiet", "origin"]);
}

/** Resolve the default branch name of a bare clone (e.g. "main"). */
export async function defaultBranch(gitDir: string): Promise<string> {
  try {
    const ref = (await git(["--git-dir", gitDir, "symbolic-ref", "--short", "HEAD"])).trim();
    if (ref) return ref;
  } catch {
    // fall through
  }
  // Fallback: first branch we can find.
  const branches = (await git(["--git-dir", gitDir, "for-each-ref", "--format=%(refname:short)", "refs/heads"]))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (branches.length === 0) throw new Error("repository has no branches");
  return branches[0]!;
}

/** First (oldest) and last (newest) commit dates on `branch`, as Date objects. */
export async function commitDateRange(gitDir: string, branch: string): Promise<{ first: Date; last: Date }> {
  const last = (await git(["--git-dir", gitDir, "log", "-1", "--format=%cI", branch])).trim();
  const firstAll = await git(["--git-dir", gitDir, "log", "--reverse", "--format=%cI", branch], {
    maxBuffer: 256 * 1024 * 1024,
  });
  const first = firstAll.split("\n").find((l) => l.trim())?.trim();
  if (!first || !last) throw new Error(`no commits found on branch "${branch}"`);
  return { first: new Date(first), last: new Date(last) };
}

/**
 * The last commit on `branch` at or before `isoDate` (YYYY-MM-DD), or null if
 * the branch had no commits yet at that date.
 */
export async function commitAtOrBefore(gitDir: string, branch: string, isoDate: string): Promise<string | null> {
  // --before is inclusive of the whole day when we pass an end-of-day boundary.
  const out = (
    await git([
      "--git-dir",
      gitDir,
      "rev-list",
      "-1",
      "--first-parent",
      `--before=${isoDate}T23:59:59`,
      branch,
    ])
  ).trim();
  return out || null;
}

/** List all file paths tracked at `sha` (repo-relative, POSIX). */
export async function listTreeFiles(gitDir: string, sha: string): Promise<string[]> {
  const out = await git(["--git-dir", gitDir, "ls-tree", "-r", "--name-only", sha], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\n").filter((l) => l.length > 0);
}

/**
 * Blame `path` at `sha` and return a map of author-year -> line count. Returns
 * an empty map if the file can't be blamed (binary, submodule, gone, etc.).
 */
export async function blameFileYears(gitDir: string, sha: string, path: string): Promise<Map<number, number>> {
  const years = new Map<number, number>();
  try {
    const out = await git(["--git-dir", gitDir, "blame", "--line-porcelain", sha, "--", path], {
      maxBuffer: 256 * 1024 * 1024,
    });
    for (const line of out.split("\n")) {
      if (line.startsWith("author-time ")) {
        const epoch = Number(line.slice("author-time ".length).trim());
        if (Number.isFinite(epoch)) {
          const year = new Date(epoch * 1000).getUTCFullYear();
          years.set(year, (years.get(year) ?? 0) + 1);
        }
      }
    }
  } catch {
    // Unblameable file — skip it.
  }
  return years;
}

/** Extract the tree of `sha` into `destDir` (which should already exist). */
export async function extractCommit(gitDir: string, sha: string, tarPath: string, destDir: string): Promise<void> {
  await git(["--git-dir", gitDir, "archive", "--format=tar", "-o", tarPath, sha]);
  await execFileAsync("tar", ["-xf", tarPath, "-C", destDir], { maxBuffer: 16 * 1024 * 1024, timeout: gitTimeout() });
}
